// The watchdog (docs/spec/plugin-api.md §16.4, §17.2 step 11) in a daemon, turned on the way `capcomd setup` leaves it
// (here through the environment layer, CAPCOMD_PLUGIN_WATCHDOG_*, with seconds for its minutes): a scripted planner
// starts two workers. Both keep calling capcomd (activity); the test reports checkpoints for them as their supervisors
// would (the scope's `checkpoint`, what src/actors/worker.ts records for a supervisor's report): one worker's files keep
// changing until it finishes, the other's stop changing after a moment. That one gets `stalled` at the configured
// time after its last checkpoint and is stopped at the configured time after; its parent sees the notice on its child
// and is never judged itself while its children run; the busy one is never noticed. A third, a report-only agent
// (whose files are never checkpointed, by design), outlives both windows without a checkpoint and is never judged. The
// stop is said once on the run's stream (`plugin.watchdog.stopped`).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { world, newRun, spawnRoot, trajectory, waitAll, agentsOf, type World } from "./harness";

const STALLED_MS = 3000, STOP_MS = 6000, EVERY_MS = 1000;
let w: World;
const runs: string[] = [];
beforeAll(async () => {
  w = await world("watchdog", {
    CAPCOMD_PLUGIN_WATCHDOG_ENABLED: "true", CAPCOMD_PLUGIN_WATCHDOG_STALLEDAFTERMS: String(STALLED_MS),
    CAPCOMD_PLUGIN_WATCHDOG_STOPAFTERMS: String(STOP_MS), CAPCOMD_PLUGIN_WATCHDOG_EVERYMS: String(EVERY_MS),
  });
}, 120_000);
afterAll(async () => {
  // A scenario that failed may leave a scripted agent's "VM" running: stop this file's.
  const mine = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString().split("\n").filter((l) => w && (l.includes(w.dir) || runs.some((r) => l.includes(`/${r}/`)))).map((l) => Number(l.trim().split(/\s+/)[0]));
  for (const pid of mine) if (pid > 1 && pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  await w?.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logsOf = async (run: string, agent: string) => (await w.cj(["logs", run, agent, "--tail", "2000"])).j.lines.map((l: any) => l.line).join("\n");

/** What the agent's supervisor reports when its workspace changed (a new tree, so a new commit). */
async function checkpoint(run: string, agentId: string) {
  const { client } = await import("../../src/core/relay");
  await client().scope.getOrCreate([run]).checkpoint({ agentId, ref: `refs/capcomd/checkpoints/${agentId}`, sha: randomBytes(20).toString("hex"), reason: "interval", files: 1 });
}

test("the watchdog is on, as setup leaves it", async () => {
  const r = await w.cj(["plugins", "list"]);
  const wd = (r.j?.plugins ?? r.j ?? []).find?.((p: any) => p.name === "watchdog");
  expect(wd).toMatchObject({ name: "watchdog", state: "active", enabled: true, source: "builtin" });
});

test("a worker whose files stop changing is stalled at the configured time and stopped after; the busy one isn't", async () => {
  const run = await newRun(w);
  runs.push(run);
  // Activity, never progress by itself: a capcomd call every 0.3 s.
  const busy = w.script("wd-busy", `i=0; while [ $i -lt 40 ]; do capcomd heartbeat "step $i" >/dev/null; sleep 0.3; i=$((i+1)); done
capcomd result --summary "kept working" >/dev/null`);
  // Reads for longer than both windows, with no checkpoint (a report's never come), then answers.
  const reader = w.script("wd-reader", `i=0; while [ $i -lt 30 ]; do capcomd heartbeat "reading $i" >/dev/null; sleep 0.3; i=$((i+1)); done
capcomd result --summary "read it all" >/dev/null`);
  const stuck = w.script("wd-stuck", `i=0; while [ $i -lt 300 ]; do capcomd heartbeat "still busy" >/dev/null; sleep 0.3; i=$((i+1)); done
echo "never stopped"; exit 3`);
  const planner = await spawnRoot(w, run, "planner", w.script("wd-planner", `a=$(capcomd spawn --profile worker --task "keeps changing files" --key busy --contract "$($S/json script='${busy}')" | $S/jget agentId)
b=$(capcomd spawn --profile worker --task "stops changing files" --key stuck --contract "$($S/json script='${stuck}')" | $S/jget agentId)
c=$(capcomd spawn --profile worker --task "reads and reports" --key reader --report --children.maxChildren=0 --contract "$($S/json script='${reader}')" | $S/jget agentId)
echo "children: $a $b $c"
while :; do
  out=$(capcomd await $a $b $c --timeout-ms 120000)
  case "$out" in *'"notices"'*) echo "noticed: $(printf "%s" "$out" | $S/jget notices.0.kind) $(printf "%s" "$out" | $S/jget notices.0.agentId)"; continue;; esac
  break
done
capcomd result --summary "watched" >/dev/null`), { task: "watch two workers" });
  // The two workers, as the planner spawned them.
  let kids: Array<{ agentId: string; task: string }> = [];
  for (let i = 0; i < 200 && kids.length < 3; i++) { kids = (await agentsOf(run)).filter((a: any) => a.parent === planner); if (kids.length < 3) await sleep(100); }
  const busyId = kids.find((k) => k.task === "keeps changing files")!.agentId, stuckId = kids.find((k) => k.task === "stops changing files")!.agentId;
  const readerId = kids.find((k) => k.task === "reads and reports")!.agentId;
  // Their files change every half second; the stuck one's stop after 1.5 s.
  const started = Date.now();
  let lastStuck = 0;
  const reporter = (async () => {
    for (;;) {
      const st = new Map((await agentsOf(run)).map((a: any) => [a.agentId, a.status]));
      if (st.get(busyId) !== "running" && st.get(busyId) !== "pending" && Date.now() - started > 2000) return;
      if (st.get(busyId) === "running") await checkpoint(run, busyId);
      if (Date.now() - started < 1500 && st.get(stuckId) === "running") { await checkpoint(run, stuckId); lastStuck = Date.now(); }
      await sleep(500);
    }
  })();
  const done = (await waitAll(w, run, [planner], 150_000)).agents[0];
  await reporter;
  const logs = await logsOf(run, planner);
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  expect(lastStuck).toBeGreaterThan(0);

  const evs = await trajectory(w, run);
  const notices = evs.filter((e) => e.type === "AGENT_NOTICE" && e.data.kind === "stalled");
  // Only the stuck worker: the busy one kept changing files, the reader's work never shows as files changing, and the
  // planner had children running.
  expect(notices.map((e) => e.agentId)).toEqual([stuckId]);
  const raisedAfter = notices[0]!.data.at - lastStuck;
  expect(raisedAfter).toBeGreaterThanOrEqual(STALLED_MS - 600);
  expect(raisedAfter).toBeLessThan(STALLED_MS + EVERY_MS + 2500);
  expect(notices[0]!.data.detail).toMatch(/^no progress for \d s: no file change seen, no agent of its own started or ended, no check or approval it waited on finished; (no tool step|\d+ tool steps?) seen meanwhile; the watchdog stops it after 6 s without progress$/);
  // Then stopped, by the watchdog, with why; after its notice and at the configured time.
  const cancelled = evs.filter((e) => e.type === "AGENT_CANCELLED");
  expect(cancelled.map((e) => e.agentId)).toEqual([stuckId]);
  expect(cancelled[0]!.data.reason).toMatch(/^by the watchdog plugin: no progress for \d s/);
  const stoppedAfter = (cancelled[0] as any).at - lastStuck;
  expect(stoppedAfter).toBeGreaterThanOrEqual(STOP_MS - 600);
  expect(stoppedAfter).toBeLessThan(STOP_MS + EVERY_MS + 2500);
  expect(evs.indexOf(cancelled[0]!)).toBeGreaterThan(evs.indexOf(notices[0]!));
  // Said once, on the run's stream.
  const said = evs.filter((e) => e.type === "plugin.watchdog.stopped");
  expect(said).toHaveLength(1);
  expect(said[0]!.data).toMatchObject({ agentId: stuckId });
  expect((said[0] as any).text).toMatch(new RegExp(`^The watchdog stopped ${stuckId}: no progress for \\d s\\.$`));
  // The planner heard the notice on its child, and its work went on: the busy worker finished.
  expect(logs).toContain(`noticed: stalled ${stuckId}`);
  const final = new Map((await agentsOf(run)).map((a: any) => [a.agentId, a.status]));
  expect(final.get(busyId)).toBe("done");
  expect(final.get(readerId)).toBe("done");
  expect(final.get(stuckId)).toBe("cancelled");
  expect((await logsOf(run, stuckId))).not.toContain("never stopped");
}, 200_000);
