import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { parse } from "yaml";
const exec = promisify(execFile);
export async function safePath(
  root: string,
  relative: string,
): Promise<string> {
  const base = await fs.realpath(root);
  const target = path.resolve(base, relative);
  const inside = (p: string) => {
    const r = path.relative(base, p);
    return r !== ".." && !r.startsWith(".." + path.sep) && !path.isAbsolute(r);
  };
  if (!inside(target)) throw new Error("Path outside workspace");
  // Resolve the nearest existing parent too, preventing symlink escapes on writes.
  let parent = target;
  for (;;) {
    try {
      if (!inside(await fs.realpath(parent)))
        throw new Error("Symlink outside workspace");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      parent = path.dirname(parent);
    }
  }
  return target;
}
export async function loadProjectContext(
  root: string,
  configPath = ".context/config.yaml",
) {
  let config: any = {};
  try {
    const file = await safePath(root, configPath);
    if ((await fs.stat(file)).size > 64000)
      throw new Error("Context configuration too large");
    config = parse(await fs.readFile(file, "utf8")) || {};
    if (
      typeof config !== "object" ||
      Array.isArray(config) ||
      (config.context_files !== undefined &&
        (!Array.isArray(config.context_files) ||
          config.context_files.some((v: unknown) => typeof v !== "string")))
    )
      throw new Error("Invalid context configuration");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const files: Record<string, string> = {};
  const warnings: string[] = [];
  let remaining = 40000;
  const read = async (relative: string, depth = 0): Promise<void> => {
    if (depth > 5 || remaining <= 0 || Object.keys(files).length >= 40) return;
    if (
      /(^|[\\/])(\.env[^\\/]*|\.git|\.ssh|\.aws|\.azure|\.codex|\.claude[^\\/]*|\.npmrc|\.netrc|node_modules|sessions|auth\.json|credentials[^\\/]*)([\\/]|$)|\.(pem|key)$/i.test(
        relative,
      )
    )
      return;
    try {
      const p = await safePath(root, relative);
      const stat = await fs.stat(p);
      if (stat.isDirectory()) {
        for (const name of (await fs.readdir(p)).sort())
          await read(path.join(relative, name), depth + 1);
      } else if (stat.isFile() && stat.size <= 1000000) {
        const text = (await fs.readFile(p, "utf8")).slice(
          0,
          Math.min(8000, remaining),
        );
        files[relative] = text;
        remaining -= text.length;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        warnings.push(`Cannot load ${relative}`);
    }
  };
  for (const file of config.context_files || [
    "CLAUDE.md",
    "README.md",
    "TODO.md",
    ".context/decisions.md",
  ]) {
    if (typeof file === "string") await read(file);
  }
  const git: Record<string, string> = {};
  await Promise.all(
    [
      ["branch", ["branch", "--show-current"]],
      ["commit", ["rev-parse", "HEAD"]],
      ["status", ["status", "--short"]],
      ["commits", ["log", "-5", "--oneline"]],
    ].map(async ([key, args]) => {
      try {
        git[key as string] = (
          await exec("git", args as string[], {
            cwd: root,
            timeout: 1500,
            maxBuffer: 32000,
            windowsHide: true,
          })
        ).stdout.trim();
      } catch {
        /* non-git project */
      }
    }),
  );
  const github: Record<string, unknown> = {};
  if (
    process.env.GITHUB_TOKEN &&
    /^[\w.-]+\/[\w.-]+$/.test(config.github_repo || "")
  ) {
    await Promise.all(
      ["issues", "pulls"].map(async (kind) => {
        if (!(kind === "issues" ? config.track_issues : config.track_prs))
          return;
        try {
          const response = await fetch(
            `https://api.github.com/repos/${config.github_repo}/${kind}?state=open&per_page=20`,
            {
              headers: {
                Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                Accept: "application/vnd.github+json",
              },
              signal: AbortSignal.timeout(3000),
            },
          );
          if (!response.ok) throw new Error();
          github[kind] = ((await response.json()) as any[])
            .filter((x) => kind !== "issues" || !x.pull_request)
            .map((x) => ({
              number: x.number,
              title: String(x.title).slice(0, 300),
            }));
        } catch {
          warnings.push(`GitHub ${kind} unavailable`);
        }
      }),
    );
  }
  const text = JSON.stringify(
    {
      project: config.project_name || path.basename(root),
      files,
      git,
      github,
      warnings,
    },
    null,
    2,
  );
  return { text, hash: createHash("sha256").update(text).digest("hex") };
}
