// Test plugin, out of process (plugin API §9; the tests/agents/fake-claude.sh pattern: a real program the host starts,
// driven by a file). It records what it sees in its data directory (CAPCOMD_PLUGIN_DATA):
//   env.json       its environment's names (and the values of those not capcomd's own), at each start;
//   opened.json    what its handshake answered (the secrets as their names only);
//   frames.ndjson  one line per frame: frame, hook, callId, idempotencyKey, mode, subject (the merge, agent or run id).
// and does what control.json there says, read again for every call (absent: deny every merge, allow the rest):
//   { "<hook>": "allow" | "deny" | "hold" | "invalid" | "widen" | "slow" | "crash" | "none", "slowMs": n,
//     "atStart": "exit" | "hang" | "badHash" | "badHooks", "emit": true, "store": true }
// "none" never answers; "slow" answers after slowMs; "crash" exits with the call in flight. It exits 0 on
// session.closing, and when its stdin closes (the daemon is gone).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { connect } from "../../../../packages/plugin/src/client";
import type { HookFrame, ProcessEnvironment, WireHookCall } from "../../../../packages/plugin/src/protocol";

const env = process.env as unknown as ProcessEnvironment;
const data = env.CAPCOMD_PLUGIN_DATA;
type Control = Record<string, unknown> & { atStart?: string; slowMs?: number; emit?: boolean; store?: boolean };
const control = (): Control => { try { return JSON.parse(readFileSync(join(data, "control.json"), "utf8")) as Control; } catch { return {}; } };
const log = (o: Record<string, unknown>) => appendFileSync(join(data, "frames.ndjson"), `${JSON.stringify(o)}\n`);
const subject = (c: WireHookCall) => { const p = c.payload as Record<string, any>; return p.merge?.mrgId ?? p.agent?.id ?? p.run?.id ?? p.spawn?.profile ?? null; };

const own = new Set(["CAPCOMD_PLUGIN_TOKEN", "CAPCOMD_PLUGIN_SESSION"]);
writeFileSync(join(data, "env.json"), JSON.stringify(Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, own.has(k) ? "(set)" : v]))));

const c0 = control();
if (c0.atStart === "exit") process.exit(3);
if (c0.atStart === "hang") await new Promise(() => {});

const client = connect(env);
const root = env.CAPCOMD_PLUGIN_ROOT;
const hash = c0.atStart === "badHash" ? "0".repeat(64) : createHash("sha256").update(readFileSync(join(root, "plugin.json"))).digest("hex");
const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")) as { contributes?: { hooks?: Record<string, unknown> } };
const hooks = Object.keys(manifest.contributes?.hooks ?? {});
let opened;
try {
  opened = await client.open({ session: env.CAPCOMD_PLUGIN_SESSION, protocol: 1, manifestHash: hash, pid: process.pid, hooks: (c0.atStart === "badHooks" ? hooks.slice(1) : hooks) as never });
} catch (e) {
  writeFileSync(join(data, "refused.txt"), String((e as Error).message));
  process.exit(4);
}
// The secrets' names, and a digest of each value (the test knows the value; it must never be in env.json).
writeFileSync(join(data, "opened.json"), JSON.stringify({ ...opened, secrets: Object.fromEntries(Object.entries(opened.secrets).map(([k, v]) => [k, createHash("sha256").update(v).digest("hex")])) }));
if (c0.atStart === "noStream") {
  // Open the hooks stream, then let it go and never come back: the host calls the plugin disconnected.
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  for await (const _f of client.hooks(ac.signal)) { /* nothing */ }
  await new Promise(() => {});
}

async function handle(f: HookFrame) {
  if (f.frame !== "hook.call") { log({ frame: f.frame, ...(f.frame === "hook.dropped" ? { count: f.count } : { reason: f.reason }) }); return; }
  const call = f.call;
  log({ frame: f.frame, seq: f.seq, hook: call.hook, callId: call.callId, key: call.idempotencyKey, mode: call.mode, subject: subject(call), runId: call.runId });
  if (call.mode === "observe") return;
  const c = control();
  const want = (c[call.hook] as string | undefined) ?? (call.hook === "merge.landing" ? "deny" : "allow");
  if (want === "none") return;
  if (want === "crash") process.exit(5);
  if (want === "slow") await new Promise((r) => setTimeout(r, c.slowMs ?? 1000));
  const result = want === "deny" ? { decision: "deny", reason: "the process gate lands nothing" }
    : want === "hold" ? { decision: "hold", reason: "the process gate wants a person" }
    : want === "invalid" ? { decision: "maybe" }
    : want === "widen" ? { decision: "allow", patch: { task: "something else" } }
    : { decision: "allow" };
  try { await client.answer(call.callId, { session: client.session, result: result as never }); log({ answered: call.callId, result: want }); } catch (e) { log({ answerRefused: call.callId, error: String((e as Error).message) }); }
  if (c.emit) await client.emit({ type: "answered", stream: call.runId ?? "daemon", entity: subject(call) ?? "", text: `Answered ${call.hook}.`, data: { hook: call.hook, decision: want } }).then((r) => log({ emitted: r.seq }), (e) => log({ emitRefused: String(e.message) }));
  if (c.store) {
    const cur = await client.storage.get("calls");
    await client.storage.put("calls", { value: ((cur?.value as number | undefined) ?? 0) + 1 }).then(() => {}, (e) => log({ storeRefused: String(e.message) }));
  }
}

for await (const f of client.hooks(new AbortController().signal)) {
  // Gate calls are answered in order; observe frames don't wait for them (§9.4).
  void handle(f).catch((e) => log({ error: String(e) }));
  if (f.frame === "session.closing") break;
}
process.exit(0);
