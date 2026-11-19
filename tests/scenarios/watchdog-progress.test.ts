// The watchdog's progress from real activity (docs/spec/plugin-api.md §16.4) in a daemon, with a stall limit of 10 s:
// a scripted worker starts a job that never ends (`sleep 3600`) and polls its output, each poll a foreground command its
// runner reports. The job and the polls hold its clock for 10 s at most, so it gets `stalled` at about 20 s, naming the
// job, long before the job's own limit would end it. (Files changing and a long foreground command holding the clock,
// a silent agent flagged: tests/subagents/watchdog-progress.test.ts, the whole way with fake claude workers.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { world, newRun, spawnRoot, trajectory, waitAll, type World } from "./harness";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A world whose watchdog has these limits, and the runs it made (their scripted agents are stopped after). */
function watched(name: string, stalledMs: number, everyMs: number) {
  const h: { w: World; runs: string[]; pids: string[] } = { w: undefined as never, runs: [], pids: [] };
  beforeAll(async () => {
    h.w = await world(name, {
      CAPCOMD_PLUGIN_WATCHDOG_ENABLED: "true", CAPCOMD_PLUGIN_WATCHDOG_STALLEDAFTERMS: String(stalledMs),
      CAPCOMD_PLUGIN_WATCHDOG_STOPAFTERMS: "0", CAPCOMD_PLUGIN_WATCHDOG_EVERYMS: String(everyMs),
    });
  }, 120_000);
  afterAll(async () => {
    // A scenario that failed may leave a scripted agent's "VM" running, or a job: stop this world's.
    const mine = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString().split("\n").filter((l) => h.w && (l.includes(h.w.dir) || h.runs.some((r) => l.includes(`/${r}/`)))).map((l) => Number(l.trim().split(/\s+/)[0]));
    for (const f of h.pids) if (existsSync(f)) mine.push(Number(readFileSync(f, "utf8").trim()));
    for (const pid of mine) if (pid > 1 && pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    await h.w?.stop();
  });
  return h;
}

/** What the agent's runner reports: its files changed, or it waits on a foreground command started at `commandSince`. */
async function worked(run: string, agentId: string, r: { files?: boolean; commandSince?: number }) {
  const { client } = await import("../../src/core/relay");
  await client().scope.getOrCreate([run]).worked({ agentId, files: r.files ?? false, commandSince: r.commandSince ?? null });
}

describe("a 10 s limit", () => {
  const STALLED_MS = 10_000, EVERY_MS = 1_000, REPORT_MS = 1_000;
  const h = watched("watchdog-job", STALLED_MS, EVERY_MS);

  test("a worker polling a job that never ends is flagged after the job's and its polls' 10 s, naming the job", async () => {
    const w = h.w;
    const run = await newRun(w);
    h.runs.push(run);
    const jobFile = join(w.dir, `job-${run}`), pidFile = join(w.dir, `pid-${run}`), enough = join(w.dir, `enough-${run}`);
    h.pids.push(pidFile);
    // It polls until the test has seen what it waits for (or 3 minutes), then kills its job and hands back.
    const agent = await spawnRoot(w, run, "worker", w.script("wdj-poller", `r=$(capcomd job start --label forever --foreground-ms 300 -- 'echo $$ > ${pidFile}; exec sleep 3600')
j=$(printf "%s" "$r" | $S/jget jobId)
echo "$j" > ${jobFile}
i=0
while [ ! -f ${enough} ] && [ $i -lt 360 ]; do capcomd job output $j >/dev/null; sleep 0.5; i=$((i+1)); done
capcomd job kill $j --reason "done polling" >/dev/null
capcomd result --summary "polled" >/dev/null`), { task: "polls a job" });
    // Its runner sees each poll: a foreground command, started just before.
    let polling = true;
    const reporter = (async () => {
      while (polling) {
        await sleep(REPORT_MS);
        await worked(run, agent, { commandSince: Date.now() - 300 }).catch(() => {});
      }
    })();
    let stalled: any;
    for (let i = 0; i < 600 && !stalled; i++) {
      stalled = (await trajectory(w, run)).find((e) => e.type === "AGENT_NOTICE" && e.agentId === agent && e.data.kind === "stalled");
      if (!stalled) await sleep(200);
    }
    writeFileSync(enough, "");
    polling = false;
    await reporter;
    const done = (await waitAll(w, run, [agent], 60_000)).agents[0];
    expect(done.status).toBe("done");
    expect(stalled).toBeDefined();

    const evs = await trajectory(w, run);
    const jobId = readFileSync(jobFile, "utf8").trim();
    expect(jobId).toMatch(/^job-/);
    // About 2 × the limit from its start: the job held its clock for 10 s, then 10 s counted.
    const start = evs.find((e) => e.type === "AGENT_STARTED" && e.agentId === agent) as any;
    const after = stalled.data.at - start.at;
    expect(after).toBeGreaterThanOrEqual(2 * STALLED_MS - 1000);
    expect(after).toBeLessThan(2 * STALLED_MS + EVERY_MS + 8000);
    expect(stalled.data.detail).toMatch(new RegExp(`^no progress for 1\\d s: .*; it has been waiting on job ${jobId} for [12]\\d s$`));
    // Raised once, on it alone.
    expect(evs.filter((e) => e.type === "AGENT_NOTICE" && e.data.kind === "stalled").map((e) => e.agentId)).toEqual([agent]);
  }, 240_000);
});
