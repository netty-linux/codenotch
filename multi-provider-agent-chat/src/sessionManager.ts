import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safePath } from "./contextLoader";
export interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  model?: string;
}
export interface Session {
  version: 1;
  sessionId: string;
  model: string;
  history: Message[];
  context: string;
  contextHash: string;
}
export function newSession(model: string): Session {
  return {
    version: 1,
    sessionId: randomUUID(),
    model,
    history: [],
    context: "",
    contextHash: "",
  };
}
const validId = (id: string) => /^[0-9a-f-]{36}$/.test(id);
export async function saveSession(root: string, session: Session) {
  if (!validId(session.sessionId)) throw new Error("Invalid session ID");
  const dir = await safePath(root, ".context/sessions");
  await fs.mkdir(dir, { recursive: true });
  const file = await safePath(
    root,
    `.context/sessions/${session.sessionId}.json`,
  );
  const temp = path.join(dir, `${randomUUID()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(session, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
  const pointer = await safePath(root, ".context/sessions/current.json");
  const pointerTemp = path.join(dir, `${randomUUID()}.tmp`);
  await fs.writeFile(
    pointerTemp,
    JSON.stringify({ sessionId: session.sessionId }),
    { mode: 0o600 },
  );
  await fs.rename(pointerTemp, pointer);
}
export async function loadSession(root: string, id?: string): Promise<Session> {
  if (!id)
    id = JSON.parse(
      await fs.readFile(
        await safePath(root, ".context/sessions/current.json"),
        "utf8",
      ),
    ).sessionId;
  if (!id || !validId(id)) throw new Error("Invalid session ID");
  const file = await safePath(root, `.context/sessions/${id}.json`);
  if ((await fs.stat(file)).size > 5000000)
    throw new Error("Session too large");
  const s = JSON.parse(await fs.readFile(file, "utf8"));
  if (
    s.version !== 1 ||
    s.sessionId !== id ||
    typeof s.model !== "string" ||
    typeof s.context !== "string" ||
    typeof s.contextHash !== "string" ||
    !Array.isArray(s.history) ||
    s.history.some(
      (m: any) =>
        !["user", "assistant"].includes(m.role) ||
        typeof m.content !== "string",
    )
  )
    throw new Error("Invalid snapshot");
  return s;
}
export async function listSessions(root: string) {
  try {
    return (await fs.readdir(await safePath(root, ".context/sessions")))
      .filter((n) => n.endsWith(".json") && validId(n.slice(0, -5)))
      .map((n) => n.slice(0, -5));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
