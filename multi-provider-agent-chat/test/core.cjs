const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { loadProjectContext, safePath } = require("../out/contextLoader");
const {
  newSession,
  saveSession,
  loadSession,
} = require("../out/sessionManager");
const { complete, gatewayUrl } = require("../out/gateway");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codenotch-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test("context uses workspace root, directories and ignores credentials", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, ".context"));
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(
    path.join(root, ".context/config.yaml"),
    "context_files: [README.md, docs, .env]\n",
  );
  await fs.writeFile(path.join(root, "README.md"), "project memory");
  await fs.writeFile(path.join(root, "docs/decision.md"), "decision");
  await fs.writeFile(path.join(root, ".env"), "secret");
  const c = await loadProjectContext(root);
  assert.match(c.text, /project memory/);
  assert.match(c.text, /decision/);
  assert.doesNotMatch(c.text, /secret/);
  assert.equal(c.hash.length, 64);
  await assert.rejects(safePath(root, "../outside"));
});
test("sessions restore exact context and all messages without traversal", async (t) => {
  const root = await fixture(t);
  const s = newSession("nim");
  s.context = "frozen context";
  s.contextHash = "hash";
  s.history.push(
    { role: "user", content: "hello", timestamp: "now" },
    { role: "assistant", content: "hi", timestamp: "now", model: "fallback" },
  );
  await saveSession(root, s);
  assert.deepEqual(await loadSession(root), s);
  await assert.rejects(loadSession(root, "../../bad"));
  await fs.writeFile(
    path.join(root, `.context/sessions/${s.sessionId}.json`),
    "{}",
  );
  await assert.rejects(loadSession(root, s.sessionId));
});
test("symlink outside workspace is rejected for both reads and future writes", async (t) => {
  const root = await fixture(t),
    outside = await fixture(t);
  await fs.symlink(outside, path.join(root, "escape"), "junction");
  await assert.rejects(safePath(root, "escape/new-file"));
  await assert.rejects(safePath(root, "escape"));
});
test("gateway sends full conversation and uses actual response model", async (t) => {
  let received;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    received = JSON.parse(raw);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        model: "fallback-model",
        choices: [{ message: { content: "answer" } }],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const messages = [
    { role: "system", content: "context" },
    { role: "user", content: "previous" },
    { role: "assistant", content: "previous answer" },
    { role: "user", content: "continue" },
  ];
  const result = await complete(
    `http://127.0.0.1:${server.address().port}/v1`,
    "test",
    "nim",
    messages,
    AbortSignal.timeout(3000),
  );
  assert.equal(result.model, "fallback-model");
  assert.deepEqual(received.messages, messages);
  assert.throws(() => gatewayUrl("http://remote.example", "models"));
  assert.equal(
    gatewayUrl("http://localhost:4000/v1/", "models"),
    "http://localhost:4000/v1/models",
  );
});
test("gateway errors omit provider response bodies that may contain secrets", async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(429);
    res.end("sensitive-key");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  await assert.rejects(
    complete(
      `http://127.0.0.1:${server.address().port}`,
      "",
      "nim",
      [],
      AbortSignal.timeout(3000),
    ),
    { message: "Gateway HTTP 429" },
  );
});
