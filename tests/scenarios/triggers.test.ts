// Triggers against a real daemon (plugin API §16.3, §17.2 step 10): a fixture source plugin (tests/plugins/fixtures/
// trigger-source) polls an inbox file on its own timer and hands each line's trigger to the daemon's intake. With the
// operator's settings allowing alice on the fixture source in observe mode: alice's addressed request starts a run (on
// the daemon's repository, with her text as its goal) that then follows her thread; the same trigger again is deduped;
// mallory's is denied by the allowlist; alice's unaddressed one is only recorded (nothing runs); one the fixture's own
// policy refuses at trigger.admitting is denied by the plugin; a person on a thread a scripted planner's run follows
// reaches that planner as a message; a subscription with a short `until` expires, and the thread is gated again after.
// The daemon stream has trigger.received / subscribed / unsubscribed, and `capcomd triggers log` lists every decision.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { world, newRun, spawnRoot, waitAll, type World } from "./harness";

const FIXTURE = join(import.meta.dir, "..", "plugins", "fixtures", "trigger-source");
let w: World;
let dir: string, inbox: string, tlog: string;
const started: string[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "capcomd-scn-triggers-"));
  inbox = join(dir, "inbox.ndjson");
  tlog = join(dir, "source.ndjson");
  const settings = join(dir, "triggers.json");
  writeFileSync(settings, JSON.stringify({ sources: { fixture: { allowed: ["alice"], mode: "observe" } } }));
  // The run a trigger starts has no planner agent on the fake sandbox: the recipe-hierarchical plugin's, off unless on.
  w = await world("triggers", { CAPCOMD_PLUGIN_RECIPE_HIERARCHICAL_ENABLED: "true", CAPCOMD_TEST_PLUGINS: FIXTURE, CAPCOMD_TEST_TRIGGER_INBOX: inbox, CAPCOMD_TEST_TRIGGER_LOG: tlog, CAPCOMD_TRIGGERS_FILE: settings, CAPCOMD_TRIGGERS_SWEEP_MS: "300", NODE_ENV: "test" });
}, 120_000);
afterAll(async () => {
  // The run the trigger started: let it finish (fake agents: seconds), else cancel it, before the engine goes.
  for (const id of started) {
    let state = "";
    for (let i = 0; i < 60 && !["completed", "failed", "cancelled"].includes(state); i++) {
      state = (await w.cj(["status", id])).j?.run?.state ?? "";
      if (!["completed", "failed", "cancelled"].includes(state)) await sleep(1000);
    }
    if (!["completed", "failed", "cancelled"].includes(state)) await w.cj(["cancel", id]);
  }
  try { await w?.stop(); } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Line = { what: string; tag?: string | null; id?: string; decision?: any; sub?: any; gate?: any; code?: string; message?: string };
const heard = (): Line[] => (existsSync(tlog) ? readFileSync(tlog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const send = (line: Record<string, unknown>) => appendFileSync(inbox, `${JSON.stringify(line)}\n`);
async function answer(tag: string, ms = 60_000): Promise<Line> {
  const end = Date.now() + ms;
  for (;;) {
    const got = heard().find((l) => l.tag === tag);
    if (got) return got;
    if (Date.now() > end) throw new Error(`no answer for ${tag}: ${JSON.stringify(heard())}`);
    await sleep(100);
  }
}
let n = 0;
const trigger = (id: string, o: Record<string, unknown> = {}) => ({
  source: "fixture", id, thread: "issue/1", at: new Date().toISOString(), actor: { id: "alice", display: "Alice", bot: false }, addressed: "mention",
  text: { text: "write the release notes", untrusted: true, by: "fixture" }, replyTo: null, data: {}, ...o,
});
const emit = async (id: string, o: Record<string, unknown> = {}) => { const tag = `e${++n}`; send({ op: "emit", tag, trigger: trigger(id, o) }); return answer(tag); };
/** The daemon's own events (harness-state.json in its home, the same as this file's). */
const daemonEvents = (): Array<{ type: string; entity: string; text: string; data: any }> => {
  const p = join(process.env.CAPCOMD_HOME!, "harness-state.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).daemonEvents ?? []) : [];
};

/** Wait in the script until a message whose text contains $1 is in the inbox; print who it is from and its text. */
const WAIT_MSG = `wait_msg() { end=$(( $(date +%s) + 150 )); while :; do m=$(capcomd inbox); case "$m" in *"$1"*) printf "%s" "$m" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s).messages)if(m.body.text.includes(process.argv[1]))console.log("msg-from: "+m.from+"\\nmsg: "+JSON.stringify(m.body.text))})' "$1"; return 0;; esac; [ $(date +%s) -gt $end ] && return 1; sleep 0.2; done; }`;

test("a fixture source's triggers: started, deduped, denied, recorded, continued; a subscription expires; observe runs nothing", async () => {
  const { recentRuns } = await import("../../src/primitives/ops");
  // A run whose planner (spawned as the run's planner, key "planner") waits for a message from the thread it follows.
  const run = await newRun(w);
  const planner = await spawnRoot(w, run, "planner", w.script("follows", `${WAIT_MSG}
wait_msg MARK-CONT || exit 9
capcomd result --summary "read it" >/dev/null`), { args: ["--key", "planner"] });
  send({ op: "subscribe", tag: "sub", sub: { runId: run, source: "fixture", thread: "issue/7" } });
  expect((await answer("sub")).sub).toEqual({ runId: run, source: "fixture", thread: "issue/7", until: null });
  const until = new Date(Date.now() + 3000).toISOString();
  send({ op: "subscribe", tag: "short", sub: { runId: run, source: "fixture", thread: "issue/9", until } });
  expect((await answer("short")).sub).toEqual({ runId: run, source: "fixture", thread: "issue/9", until });
  const before = new Set(recentRuns(500).map((r) => r.runId));

  // Allowed and addressed: explicit, a run starts in observe mode too.
  const s = await emit("c1");
  expect(s.decision).toMatchObject({ kind: "started" });
  const startedRun = s.decision.runId as string;
  started.push(startedRun);
  expect(startedRun).toMatch(/^run-/);
  // The same (source, id) again.
  expect((await emit("c1")).decision).toMatchObject({ kind: "deduped" });
  // Not allowed.
  expect((await emit("c2", { actor: { id: "mallory", display: "Mallory", bot: false }, thread: "issue/2" })).decision).toMatchObject({ kind: "denied", by: "allowlist" });
  // Allowed, not addressed: inferred, observe records what would have happened.
  expect((await emit("c3", { addressed: null, thread: "issue/3" })).decision).toEqual({ kind: "recorded", wouldHave: "start", runId: null });
  // The fixture's own policy denies at trigger.admitting what the gate allowed.
  expect((await emit("c4", { thread: "issue/4", data: { policy: "deny" } })).decision).toEqual({ kind: "denied", by: "plugin", reason: "the trigger-source plugin: this team takes no triggers marked deny" });
  // A person on a thread the scripted run follows: its planner gets it, no gate (carol isn't allowed).
  const c = await emit("c5", { actor: { id: "carol", display: "Carol", bot: false }, addressed: null, thread: "issue/7", text: { text: "MARK-CONT please also update the changelog", untrusted: true, by: "fixture" } });
  expect(c.decision).toMatchObject({ kind: "continued", runId: run });
  const done = (await waitAll(w, run, [planner], 120_000)).agents[0];
  const logs = (await w.cj(["logs", run, planner, "--tail", "500"])).j.lines.map((l: any) => l.line).join("\n");
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  expect(logs).toContain("msg-from: trigger:fixture");
  expect(logs).toContain("Carol (carol) wrote on issue/7:");
  expect(logs).toContain("MARK-CONT please also update the changelog");

  // The short subscription expires (the daemon sweeps every 300 ms here); after it, the thread is gated like any.
  for (let i = 0; i < 100 && !daemonEvents().some((e) => e.type === "trigger.unsubscribed"); i++) await sleep(100);
  expect(daemonEvents().filter((e) => e.type === "trigger.unsubscribed").map((e) => e.data)).toEqual([{ source: "fixture", thread: "issue/9", runId: run, cause: "expired" }]);
  expect((await emit("c6", { actor: { id: "carol", display: "Carol", bot: false }, thread: "issue/9" })).decision).toMatchObject({ kind: "denied", by: "allowlist" });

  // Observe ran nothing: the only new run is the one the explicit trigger started, and it carries its trigger.
  const after = recentRuns(500).map((r) => r.runId).filter((id) => !before.has(id));
  expect(after).toEqual([startedRun]);
  const { triggerOfRun } = await import("../../src/triggers/intake");
  expect(triggerOfRun(startedRun)).toMatchObject({ source: "fixture", id: "c1", thread: "issue/1", actor: { id: "alice", display: "Alice", bot: false } });
  const status = await w.cj(["status", startedRun]);
  expect(status.code).toBe(0);

  // The daemon stream: one trigger.received per trigger, in order; the started run follows its thread.
  const received = daemonEvents().filter((e) => e.type === "trigger.received");
  expect(received.map((e) => [e.data.id, e.data.decision])).toEqual([["c1", "started"], ["c1", "deduped"], ["c2", "denied"], ["c3", "recorded"], ["c4", "denied"], ["c5", "continued"], ["c6", "denied"]]);
  expect(received[0]).toMatchObject({ text: `A trigger from fixture started ${startedRun}.`, data: { source: "fixture", thread: "issue/1", actor: "alice", addressed: "mention", runId: startedRun } });
  expect(daemonEvents().filter((e) => e.type === "trigger.subscribed").map((e) => [e.data.runId, e.data.thread])).toEqual([[run, "issue/7"], [run, "issue/9"], [startedRun, "issue/1"]]);
  // The plugin heard every decision (trigger.changed) and was asked only about what the gate allowed.
  for (let i = 0; i < 50 && heard().filter((l) => l.what === "changed").length < 7; i++) await sleep(100);
  expect(heard().filter((l) => l.what === "changed").map((l) => [l.id, l.decision.kind])).toEqual(received.map((e) => [e.data.id, e.data.decision]));
  expect(heard().filter((l) => l.what === "admitting").map((l) => l.id)).toEqual(["c1", "c3", "c4"]);

  // capcomd triggers log: every decision, oldest first.
  const tl = await w.cj(["triggers", "log"]);
  expect(tl.code).toBe(0);
  expect(tl.j.triggers.map((e: any) => `${e.id} ${e.decision.kind}`)).toEqual(["c1 started", "c1 deduped", "c2 denied", "c3 recorded", "c4 denied", "c5 continued", "c6 denied"]);
  expect(tl.j.triggers[3]).toMatchObject({ gate: { allowed: true, strength: "inferred", mode: "observe" }, decision: { wouldHave: "start" } });
}, 240_000);
