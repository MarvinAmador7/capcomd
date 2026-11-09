#!/usr/bin/env node
// Fake `fx` for the agent-fx tests: an ACP peer on stdio (newline-delimited JSON-RPC), as `fx acp` is. Two modes:
//
// - FAKE_FX_REPLAY=<file>: replays a session recorded from fx 0.0.16 (tests/agents/fixtures/fx/*.acp.jsonl, each line
//   {dir: "c2a"|"a2c", msg}). Each message the client sent must come in the order it was recorded (a request by its
//   method, its id mapped to the one it has now; an answer to one of fx's requests by that id); what fx sent is sent as
//   it was. Anything else is a failure: it is written to stderr and the fake exits 3.
// - Otherwise scripted, for a run of a whole worker: it writes src/sum.ts with a write_file tool call, runs `ls` as a
//   shell call, says what it did, and ends the turn. Markers in a prompt: [fail] ends the turn refused with fx's auth
//   failure text; [scribble] writes notes.txt; [loop] runs shell calls until it is stopped.
//
// Either way it writes its argv, the FX_* variables and whether AI_GATEWAY_API_KEY was set to $FAKE_FX_SEEN (default
// ../fx-seen.json, beside the checkout as the runner lays it out).
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const seen = process.env.FAKE_FX_SEEN || "../fx-seen.json";
if (process.argv[2] === "--version") { process.stdout.write("0.0.16\n"); process.exit(0); }
try {
  writeFileSync(seen, JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FX_"))), key: process.env.AI_GATEWAY_API_KEY ? "set" : null, oidc: process.env.VERCEL_OIDC_TOKEN ? "set" : null, home: process.env.HOME ?? null, capcomdPath: process.env.CAPCOMD_PATH ?? null }));
} catch {}
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const fail = (why) => { process.stderr.write(`fake-fx: ${why}\n`); process.exit(3); };

let buf = "";
const inbox = [];
let wake = null;
process.stdin.on("data", (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, n); buf = buf.slice(n + 1);
    if (!l.trim()) continue;
    try { inbox.push(JSON.parse(l)); } catch { fail(`not JSON: ${l}`); }
    wake?.();
  }
});
let ended = false;
process.stdin.on("end", () => { ended = true; wake?.(); });
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => process.exit(128 + (s === "SIGTERM" ? 15 : 2)));
/** The next message from the client; null once its input ended. */
async function next() {
  while (!inbox.length) { if (ended) return null; await new Promise((ok) => { wake = ok; }); wake = null; }
  return inbox.shift();
}

if (process.env.FAKE_FX_REPLAY) {
  const script = readFileSync(process.env.FAKE_FX_REPLAY, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((e) => e.dir === "c2a" || e.dir === "a2c");
  const ids = new Map(); // recorded request id → the client's id now
  for (const e of script) {
    if (e.dir === "a2c") {
      const m = { ...e.msg };
      if (m.id !== undefined && m.method === undefined) {
        if (!ids.has(m.id)) fail(`no request for recorded answer ${m.id}`);
        m.id = ids.get(m.id);
      }
      send(m);
      continue;
    }
    const want = e.msg;
    const got = await next();
    if (!got) fail(`input ended; expected ${want.method ?? `an answer to ${want.id}`}`);
    if (want.method !== undefined) {
      if (got.method !== want.method) fail(`expected ${want.method}, got ${JSON.stringify(got).slice(0, 300)}`);
      if (want.id !== undefined) ids.set(want.id, got.id);
      if (got.method === "session/new") try { writeFileSync(`${seen}.mcp`, JSON.stringify(got.params.mcpServers ?? [])); } catch {}
      if (process.env.FAKE_FX_STRICT && JSON.stringify(got.params) !== JSON.stringify(want.params)) fail(`${want.method} params differ: ${JSON.stringify(got.params).slice(0, 300)}`);
    } else if (got.id !== want.id || got.method !== undefined) fail(`expected the answer to ${want.id}, got ${JSON.stringify(got).slice(0, 300)}`);
    else if (JSON.stringify(got.result ?? got.error) !== JSON.stringify(want.result ?? want.error)) fail(`answer to ${want.id} differs: ${JSON.stringify(got).slice(0, 300)}`);
  }
  // The recording's end: wait for the client to close its input.
  while (await next()) {}
  process.exit(0);
}

// ---- Scripted.
const session = "fake-session-1";
const update = (u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update: u } });
let call = 0;
async function tool(name, kind, rawInput, run) {
  const id = `call_${++call}`;
  update({ sessionUpdate: "tool_call", toolCallId: id, name, title: name, kind, status: "pending", rawInput, _meta: { fx: { toolCall: { internal: false } } } });
  update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
  const r = run();
  update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "text", text: r.text } }], ...(r.exit !== undefined ? { command_result: { kind: "command", command: rawInput.command, exit_code: r.exit } } : {}) });
}
for (;;) {
  const m = await next();
  if (!m) process.exit(0);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, _meta: { fx: { steering: true } } }, agentInfo: { name: "fx", title: "fx", version: "0.0.16" }, authMethods: [] } });
  else if (m.method === "session/new") {
    try { writeFileSync(`${seen}.mcp`, JSON.stringify(m.params.mcpServers ?? [])); } catch {}
    send({ jsonrpc: "2.0", id: m.id, result: { sessionId: session, configOptions: [{ id: "model", currentValue: process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "fake/model" }] } });
  } else if (m.method === "session/prompt") {
    const text = (m.params.prompt ?? []).map((b) => b.text ?? "").join("");
    try { appendFileSync(`${seen}.prompts`, JSON.stringify({ steer: !!m.params._meta?.fx?.steer, bytes: Buffer.byteLength(text), head: text.slice(0, 40) }) + "\n"); } catch {}
    // Messages are read between turns here, so a steering prompt always finds the turn over, as fx answers then.
    if (m.params._meta?.fx?.steer) { send({ jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "No turn to steer; send it as a new prompt" } }); continue; }
    if (text.includes("[fail]")) {
      update({ sessionUpdate: "agent_message_chunk", messageId: "m-fail", content: { type: "text", text: "AI_GATEWAY_API_KEY authentication failed · HTTP 401" } });
      send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "refused", usage: {} } });
      continue;
    }
    if (text.includes("[loop]")) {
      for (let i = 0; i < 400; i++) { await tool("shell", "execute", { action: "run", command: "ls" }, () => ({ text: "README\n", exit: 0 })); await new Promise((ok) => setTimeout(ok, 50)); }
    }
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The test wants a + b." } });
    await tool("shell", "execute", { action: "run", command: "ls" }, () => ({ text: "README\n", exit: 0 }));
    // [wait]: the turn takes a second more, so messages arrive while it runs.
    if (text.includes("[wait]")) await new Promise((ok) => setTimeout(ok, 1000));
    await tool("write_file", "edit", { path: "src/sum.ts", content: "export const sum = (a: number, b: number) => a + b;\n" }, () => {
      mkdirSync("src", { recursive: true });
      writeFileSync("src/sum.ts", "export const sum = (a: number, b: number) => a + b;\n");
      return { text: "wrote src/sum.ts" };
    });
    if (text.includes("[scribble]")) writeFileSync("notes.txt", "notes\n");
    update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "fixed sum " } });
    update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "with fx" } });
    update({ sessionUpdate: "usage_update", used: 1200, size: 200000 });
    send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn", usage: { inputTokens: 10000, outputTokens: 1000, cacheReadTokens: 2000 } } });
  } else if (m.method === "session/cancel") {
    // Nothing runs between messages here.
  } else if (m.id !== undefined && m.method !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `fake fx: ${m.method}` } });
}
