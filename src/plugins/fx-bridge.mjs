#!/usr/bin/env node
// The fx bridge (docs/spec/plugin-api.md §7.3, agent-fx): runs `fx acp` (fx's Agent Client Protocol server,
// newline-delimited JSON-RPC 2.0 on stdio) for one capcomd agent and prints what happens as JSON lines on stdout, which
// the agent-fx provider's `parse` reads. Dependency-free, like supervisor.mjs; the provider's `command` writes it next
// to the run. Config (JSON file, argv[2]):
//   { bin, cwd, prompt, stdin?, mcpConfig?, mcpServers?, model?, effort?, provider?, permission, logFile?, addDirs?,
//     maxSteps?, quotaAfterMs? }
// `permission` is {mode: "full-access"} (the sandbox is the boundary) or {mode: "ask", rules} (an orchestrate agent:
// fx's own rules allow and deny, and every action they leave to a person is refused here).
// With `stdin`, the prompt and the messages capcomd sends while the agent works arrive on stdin as the supervisor writes
// them ({"type":"user","message":{"content":<text>}}): the first is the prompt, each later one goes to fx as a steering
// prompt (applied at its next model call) or, when fx can't take it that way, as the next turn. Each turn ends with a
// {"type":"result"} line; the supervisor closes stdin once one comes with nothing sent since, and the bridge exits.
// Lines it prints: init, session, update (an ACP session/update, verbatim but for coalesced text), message (an agent
// message or thought, whole), permission, steer, notice, quota, error, result.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = (o) => { try { process.stdout.write(JSON.stringify(o) + "\n"); } catch {} };
/** fx's limit for a steering prompt (fx acp: text blocks, at most 64 KiB); a longer message is the next turn. */
const STEER_MAX = 64 * 1024;
/** A rate limit fx keeps retrying, or a quota it names, this long is the provider's usage limit (ADR-019 §6). */
const QUOTA_AFTER_MS = Number(cfg.quotaAfterMs) > 0 ? Number(cfg.quotaAfterMs) : 10 * 60_000;
/** Out of credits or over a plan's quota: fx retries it as a rate limit, but it won't pass by itself. */
const QUOTA_TEXT = /insufficient_quota|credit_card_required|usage_limit_reached|out of credits|exceeded your current quota/i;
const FLUSH_MS = 5_000;

// ---- fx's settings: capcomd's keys merged into $HOME/.fx/settings.json (fx reads only that file, and only when it and
// its folder are private), whatever a login wrote kept. An orchestrate agent's file keeps only the model endpoints
// (`providers`, `models`) besides capcomd's keys: anything else already there could loosen its rules (a `workspaces`
// entry for the checkout outranks the top-level `permission`) or approve the repository's own MCP servers.
const ORCHESTRATE_KEEP = new Set(["providers", "models"]);
function settings() {
  const dir = join(process.env.HOME || "/root", ".fx"), file = join(dir, "settings.json");
  let s = {};
  try { s = JSON.parse(readFileSync(file, "utf8")); } catch {}
  if (!s || typeof s !== "object" || Array.isArray(s)) s = {};
  if (cfg.permission?.mode === "ask") s = Object.fromEntries(Object.entries(s).filter(([k]) => ORCHESTRATE_KEEP.has(k)));
  // No upgrades, and no model calls beyond the agent's own (a title, keeping a cache warm).
  Object.assign(s, { auto_upgrade: false, session_titles: false, cache_warming: false, prompt_history: { enabled: false } });
  if (cfg.permission?.mode === "ask") s.permission = cfg.permission.rules ?? { "*": "ask" };
  else delete s.permission;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

// fx runs the agent's commands in a snapshot of a login shell, whose /etc/profile (Debian's, in the env image) sets PATH
// anew: the agent's own tools (node, bun, the in-VM capcomd) were "command not found" (recorded against fx 0.0.16). A
// login shell then reads the user's profile, which puts the agent's PATH back (CAPCOMD_PATH, set for fx below).
const PROFILE_MARK = "# capcomd: the agent's PATH (fx runs commands in a login shell)";
function loginPath() {
  const home = process.env.HOME || "/root";
  const line = `${PROFILE_MARK}\n[ -n "$CAPCOMD_PATH" ] && export PATH="$CAPCOMD_PATH"\n`;
  for (const [f, also] of [[".bash_profile", ".profile"], [".zprofile", null]]) {
    const file = join(home, f);
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch {}
    if (text.includes(PROFILE_MARK)) continue;
    // A new ~/.bash_profile hides ~/.profile from bash: it reads it first, as bash would have.
    const head = !text && also ? `[ -f "$HOME/${also}" ] && . "$HOME/${also}"\n` : "";
    try { writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${head}${line}`); } catch {}
  }
}

/** A program's absolute path: as given when absolute, else the first executable of that name on PATH. */
function which(cmd) {
  if (isAbsolute(cmd)) return cmd;
  for (const d of (process.env.PATH || "").split(delimiter)) {
    if (!d) continue;
    try { accessSync(join(d, cmd), constants.X_OK); return join(d, cmd); } catch {}
  }
  return null;
}

/** The MCP servers as ACP's session/new takes them: an absolute command, args, and env as name/value pairs. */
function mcpServers() {
  let file = {};
  if (cfg.mcpConfig) try { file = JSON.parse(readFileSync(cfg.mcpConfig, "utf8")).mcpServers ?? {}; } catch (e) { out({ type: "notice", text: `capcomd: couldn't read the MCP servers file: ${e?.message ?? e}` }); }
  const only = Array.isArray(cfg.mcpServers) ? new Set(cfg.mcpServers) : null;
  if (Array.isArray(cfg.untrustedMcp) && cfg.untrustedMcp.length)
    out({ type: "notice", text: `capcomd: MCP servers not started on fx: ${cfg.untrustedMcp.join(", ")} (untrusted: fx runs with full access, so their tools would run unasked)` });
  const list = [];
  for (const [name, s] of Object.entries(file)) {
    if (only && !only.has(name)) continue;
    const command = typeof s?.command === "string" ? which(s.command) : null;
    if (!command) { out({ type: "notice", text: `capcomd: MCP server ${name} not started: ${s?.command ?? "no command"} isn't in this sandbox` }); continue; }
    list.push({ name, command, args: Array.isArray(s.args) ? s.args.map(String) : [], env: Object.entries(s.env ?? {}).map(([k, v]) => ({ name: k, value: String(v) })) });
  }
  return list;
}

settings();
loginPath();
const env = { ...process.env, CAPCOMD_PATH: process.env.PATH ?? "", FX_AUTO_UPGRADE: "0", FX_NO_OPEN_BROWSER: "1", NO_COLOR: "1", FX_PERMISSION_MODE: cfg.permission?.mode === "ask" ? "ask" : "full-access", FX_PROVIDER: cfg.provider || "gateway" };
// An API key is the credential: a Vercel OIDC token would outrank it.
if (env.AI_GATEWAY_API_KEY) delete env.VERCEL_OIDC_TOKEN;
if (cfg.effort) env.FX_EFFORT = String(cfg.effort);
if (Number(cfg.maxSteps) > 0) env.FX_MAX_AGENT_STEPS = String(cfg.maxSteps);
// Directories outside the checkout it reads (the context bundles), when they are there.
const args = [...(cfg.addDirs ?? []).filter((d) => existsSync(String(d))).flatMap((d) => ["--add-dir", String(d)]), "acp", ...(cfg.model ? ["--model", String(cfg.model)] : []), ...(cfg.logFile ? ["--log-file", String(cfg.logFile)] : [])];
// In the bridge's own process group: the runner stopping the agent's group stops fx too, even if it kills the bridge
// before the bridge could stop fx.
const fx = spawn(cfg.bin, args, { cwd: cfg.cwd, env, stdio: ["pipe", "pipe", "inherit"] });
let fxExited = null;
const fxExit = new Promise((ok) => fx.on("exit", (code, signal) => { fxExited = { code, signal }; ok(fxExited); }));
fx.on("error", (e) => { out({ type: "error", where: "spawn", message: String(e?.message ?? e) }); finish(2); });
fx.stdin.on("error", () => {});

// ---- JSON-RPC with fx.
let nextId = 0;
const pending = new Map();
const send = (m) => { try { fx.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n"); } catch {} };
const call = (method, params) => new Promise((ok) => { const id = ++nextId; pending.set(id, ok); send({ id, method, params }); });

// Text arrives in chunks: an agent message per message id, a thought per unbroken run; printed whole.
let text = null; // { role, messageId, text, at }
let lastMessage = "";
function flush() {
  if (!text) return;
  out({ type: "message", role: text.role, ...(text.messageId ? { messageId: text.messageId } : {}), text: text.text });
  if (text.role === "agent" && text.text.trim()) lastMessage = text.text;
  text = null;
}
const flusher = setInterval(() => { if (text && Date.now() - text.at >= FLUSH_MS) flush(); }, 1000);
// A running command's output streams as in_progress updates: one a call every few seconds is enough to show it is alive.
const progressAt = new Map();

let sessionId = null, steering = false, turn = null, quota = null, failed = false, lastStop = null;
const recovery = { since: 0, message: "" };

function onUpdate(u) {
  const kind = u?.sessionUpdate;
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const role = kind === "agent_message_chunk" ? "agent" : "thought";
    const messageId = typeof u.messageId === "string" ? u.messageId : null;
    if (text && (text.role !== role || text.messageId !== messageId)) flush();
    text ??= { role, messageId, text: "", at: Date.now() };
    text.text += typeof u.content?.text === "string" ? u.content.text : "";
    return;
  }
  flush();
  // Not shown: the commands it offers a person, and a title (the first prompt's words: capcomd has its own).
  if (kind === "available_commands_update" || (kind === "session_info_update" && u._meta?.fx?.modelResponseRecovery === undefined)) return;
  if (kind === "tool_call_update" && u.status === "in_progress") {
    const at = progressAt.get(u.toolCallId) ?? 0;
    if (Date.now() - at < FLUSH_MS) return;
    progressAt.set(u.toolCallId, Date.now());
    out({ type: "update", update: { sessionUpdate: kind, toolCallId: u.toolCallId, status: u.status } });
    return;
  }
  if (kind === "tool_call_update") progressAt.delete(u.toolCallId);
  out({ type: "update", update: u });
  const r = u?._meta?.fx?.modelResponseRecovery;
  if (kind === "session_info_update" && r !== undefined) onRecovery(r);
}

// fx retries a rate limit and an exhausted quota alike; a quota it names, or a rate limit that doesn't pass, is the
// provider's usage limit: the turn is cancelled and the agent stops for it.
function onRecovery(r) {
  const limited = r && r.cause === "rate_limited" && r.state !== "recovered";
  if (!limited) { recovery.since = 0; return; }
  recovery.message = String(r.message ?? "").replace(/^\W+\s*/, "");
  recovery.since ||= Date.now();
  if (QUOTA_TEXT.test(recovery.message)) hitQuota();
}
setInterval(() => { if (recovery.since && Date.now() - recovery.since >= QUOTA_AFTER_MS) hitQuota(); }, 1000).unref();
function hitQuota() {
  if (quota || !turn) return;
  quota = { message: recovery.message || "rate limited" };
  out({ type: "quota", message: quota.message });
  send({ method: "session/cancel", params: { sessionId } });
}

// Requests from fx: a permission it leaves to a person is refused (an orchestrate agent's rules allowed what it may do;
// an execute agent runs with full access and gets none); anything else it may ask (an MCP server wanting input) isn't
// supported. Every one is answered: fx would wait for an answer.
function onRequest(m) {
  if (m.method === "session/request_permission") {
    const tc = m.params?.toolCall ?? {};
    const reject = (m.params?.options ?? []).find((o) => o?.kind === "reject_once")?.optionId ?? "reject_once";
    send({ id: m.id, result: { outcome: { outcome: "selected", optionId: reject } } });
    out({ type: "permission", toolCallId: tc.toolCallId ?? null, name: tc.name ?? null, kind: tc.kind ?? null, title: tc.title ?? null, rawInput: tc.rawInput ?? null, decision: "rejected",
      reason: cfg.permission?.mode === "ask" ? "capcomd orchestrate mode: this agent sees everything and runs nothing that changes or runs code" : "capcomd answers no permission request" });
    return;
  }
  send({ id: m.id, error: { code: -32601, message: `capcomd doesn't support ${m.method}` } });
}

let buf = "";
fx.stdout.on("data", (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n); buf = buf.slice(n + 1);
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && m.method === undefined) { const ok = pending.get(m.id); pending.delete(m.id); ok?.(m); }
    else if (m.method === "session/update") onUpdate(m.params?.update);
    else if (m.method !== undefined && m.id !== undefined) onRequest(m);
  }
});

// ---- capcomd's messages.
const queue = [];
// `started`: the prompt is queued as the first turn. Until then a message waits behind it, even once fx's session is up.
let inputDone = !cfg.stdin, firstPrompt = null, started = false;
const steers = new Set();
function steer(text) {
  const p = call("session/prompt", { sessionId, prompt: [{ type: "text", text }], _meta: { fx: { steer: true } } }).then((r) => {
    const delivery = r.error ? "refused" : r.result?._meta?.fx?.steering ?? "absorbed";
    out({ type: "steer", delivery, ...(r.error ? { message: String(r.error.message ?? "") } : {}) });
    // Not taken (the turn ended first, or fx dropped it): it is the next turn.
    if (delivery !== "absorbed") queue.push(text);
  });
  steers.add(p);
  p.finally(() => steers.delete(p));
}
function message(text) {
  if (!started) { if (firstPrompt === null) firstPrompt = text; else queue.push(text); return; }
  if (turn && steering && Buffer.byteLength(text) <= STEER_MAX) steer(text);
  else queue.push(text);
  pump();
}
if (cfg.stdin) {
  let ib = "";
  process.stdin.on("data", (d) => {
    ib += d;
    let n;
    while ((n = ib.indexOf("\n")) >= 0) {
      const line = ib.slice(0, n); ib = ib.slice(n + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const c = m?.message?.content;
      const t = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x?.text === "string" ? x.text : "")).join("\n") : "";
      if (t) message(t);
    }
  });
  process.stdin.on("end", () => { inputDone = true; pump(); });
  process.stdin.on("error", () => { inputDone = true; pump(); });
}

async function runTurn(text) {
  turn = { started: Date.now() };
  recovery.since = 0;
  const r = await call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  // A steering prompt is answered when the turn that took it ends: after this one.
  while (steers.size) await Promise.all([...steers]);
  flush();
  const stopReason = r.error ? "error" : String(r.result?.stopReason ?? "unknown");
  if (r.error) out({ type: "error", where: "prompt", code: r.error.code ?? null, message: String(r.error.message ?? "") });
  lastStop = stopReason;
  failed = !!r.error || (stopReason !== "end_turn" && stopReason !== "cancelled") || (stopReason === "cancelled" && !quota);
  out({ type: "result", stopReason, usage: r.result?.usage ?? {}, lastText: lastMessage, ...(quota ? { quota: quota.message } : {}) });
  lastMessage = "";
  turn = null;
}

let pumping = false;
async function pump() {
  if (pumping || turn || !sessionId) return;
  pumping = true;
  try {
    while (!quota && !stopping && queue.length) await runTurn(queue.splice(0, queue.length).join("\n\n"));
  } finally { pumping = false; }
  if (!turn && (inputDone || quota) && !queue.length) finish(quota || failed ? 1 : 0);
}

// ---- Start, stop.
let stopping = false, finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  flush();
  clearInterval(flusher);
  try { fx.stdin.end(); } catch {}
  if (!fx.pid) process.exit(code);
  const killed = await Promise.race([fxExit, new Promise((ok) => setTimeout(() => ok(null), 10_000))]);
  if (!killed) killFx();
  process.exit(code);
}
function killFx() {
  try { fx.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { fx.kill("SIGKILL"); } catch {} }, 2000).unref();
}
for (const [sig, no] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]]) process.on(sig, async () => {
  if (stopping) return;
  stopping = true;
  if (turn && sessionId) send({ method: "session/cancel", params: { sessionId } });
  // The turn ends cancelled (its result printed), or fx is gone (the whole group was signalled), or 5 s pass.
  await Promise.race([new Promise((ok) => { const t = setInterval(() => { if (!turn) { clearInterval(t); ok(); } }, 100); }), fxExit, new Promise((ok) => setTimeout(ok, 5000))]);
  flush();
  if (!fxExited) { killFx(); await Promise.race([fxExit, new Promise((ok) => setTimeout(ok, 2500))]); }
  process.exit(128 + no);
});
fxExit.then((x) => {
  // fx went away on its own (a crash, a kill): whatever it was doing is over.
  if (finishing || stopping) return;
  flush();
  out({ type: "error", where: "fx", message: `fx exited${x.signal ? ` on ${x.signal}` : ` with ${x.code}`}${turn ? " during a turn" : ""}` });
  process.exit(turn || !sessionId ? 2 : failed ? 1 : 0);
});

const init = await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { notices: {} } } });
if (init.error) { out({ type: "error", where: "initialize", code: init.error.code ?? null, message: String(init.error.message ?? "") }); await finish(2); }
steering = init.result?.agentCapabilities?._meta?.fx?.steering === true;
out({ type: "init", agent: init.result?.agentInfo ?? null, protocolVersion: init.result?.protocolVersion ?? null, steering });
const s = await call("session/new", { cwd: cfg.cwd, mcpServers: mcpServers() });
if (s.error) { out({ type: "error", where: "session/new", code: s.error.code ?? null, message: String(s.error.message ?? "") }); await finish(2); }
sessionId = s.result.sessionId;
out({ type: "session", sessionId, model: s.result.configOptions?.find((o) => o?.id === "model")?.currentValue ?? null, provider: s.result.configOptions?.find((o) => o?.id === "provider")?.currentValue ?? null });
if (!cfg.stdin) firstPrompt = readFileSync(cfg.prompt, "utf8");
const waitFirst = () => new Promise((ok) => { const t = setInterval(() => { if (firstPrompt !== null || inputDone) { clearInterval(t); ok(); } }, 50); });
await waitFirst();
if (firstPrompt === null) await finish(0);
queue.unshift(firstPrompt);
started = true;
pump();
