// Runs capcomd's fx bridge against the real fx (and the stub model) the way the supervisor does: argv[2] is a scenario
// {name, prompt, messages?: [{on, text}], bridge: {...extra bridge config}, rules?}. The bridge's stdout is recorded at
// /out/<name>.bridge.jsonl, its exit code at the end of /out/<name>.bridge.err.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const sc = JSON.parse(readFileSync(process.argv[2], "utf8"));
const home = `/tmp/bh-${sc.name}`;
rmSync(home, { recursive: true, force: true });
mkdirSync(`${home}/.fx`, { recursive: true, mode: 0o700 });
writeFileSync(`${home}/.fx/settings.json`, JSON.stringify({
  providers: { stub: { protocol: "openai-chat-completions", base_url: "http://127.0.0.1:8787/v1", auth: sc.bearer ? { type: "bearer", env: "STUB_API_KEY" } : { type: "none" },
    model_metadata: { "stub-model": { context_window: 200000, max_output_tokens: 8192, supports_tool_use: true } } } },
  models: { stub: "stub-model" }, permission: { "*": "deny" },
}), { mode: 0o600 });
writeFileSync(`/tmp/prompt-${sc.name}.txt`, sc.prompt);
const cfg = { bin: "/rec/fxtap.mjs", cwd: "/work", prompt: `/tmp/prompt-${sc.name}.txt`, stdin: !!sc.stdin, provider: "stub", permission: sc.rules ? { mode: "ask", rules: JSON.parse(readFileSync(sc.rules, "utf8")) } : { mode: "full-access" }, logFile: `/out/${sc.name}.fx.log`, ...(sc.bridge ?? {}) };
writeFileSync(`/tmp/bridge-${sc.name}.json`, JSON.stringify(cfg));
const outFile = `/out/${sc.name}.bridge.jsonl`, errFile = `/out/${sc.name}.bridge.err`;
writeFileSync(outFile, ""); writeFileSync(errFile, "");
const b = spawn("node", ["/rec/fx-bridge.mjs", `/tmp/bridge-${sc.name}.json`], { cwd: "/work", env: { ...process.env, HOME: home, FXTAP_OUT: `/out/${sc.name}.tap.jsonl`, ...(sc.env ?? {}) }, stdio: [sc.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
b.stderr.on("data", (d) => appendFileSync(errFile, d));
const say = (t) => b.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: t } }) + "\n");
if (sc.stdin) say(sc.prompt);
let buf = "", sentAt = Date.now(), resultAt = 0, closed = false;
const pending = [...(sc.messages ?? [])];
b.stdout.on("data", (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n); buf = buf.slice(n + 1);
    appendFileSync(outFile, line + "\n");
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === "result") resultAt = Date.now();
    const hit = pending.findIndex((p) => (p.on === "tool_call" && m.type === "update" && m.update?.sessionUpdate === "tool_call") || p.on === m.type);
    if (hit >= 0 && sc.stdin && !closed) { const [p] = pending.splice(hit, 1); setTimeout(() => { say(p.text); sentAt = Date.now(); }, p.delayMs ?? 0); }
  }
});
// The supervisor's rule: a result with nothing sent since, a second ago, closes the agent's input.
const t = setInterval(() => { if (sc.stdin && !closed && resultAt && sentAt <= resultAt && Date.now() - resultAt >= 1000 && !pending.length) { closed = true; b.stdin.end(); } }, 200);
if (sc.killAfterMs) setTimeout(() => b.kill("SIGTERM"), sc.killAfterMs);
b.on("exit", (code, sig) => { clearInterval(t); appendFileSync(errFile, `\n[drive] exit ${JSON.stringify({ code, sig })}\n`); });
