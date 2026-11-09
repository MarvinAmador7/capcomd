// The watchdog's progress from real activity (docs/spec/plugin-api.md §16.4) in a daemon.
// With a stall limit of 90 s: shorter than the 10 minutes between checkpoints, which used to be the only file changes it
// saw. A scripted planner starts three workers that run for over two minutes. The test reports for them what their
// runners would (the scope's `worked`, what src/actors/worker.ts records for a runner's report): one's files change
// every 30 s, another waits on a foreground command the whole time, the third does nothing. Only the silent one gets
// `stalled`, at 90 s, and its notice says what was seen; no checkpoint comes for any of them.
// With a stall limit of 10 s: a scripted worker starts a job that never ends (`sleep 3600`) and polls its output, each
// poll a foreground command its runner reports. The job and the polls hold its clock for 10 s at most, so it gets
// `stalled` at about 20 s, naming the job, long before the job's own limit would end it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { world, newRun, spawnRoot, trajectory, waitAll, agentsOf, type World } from "./harness";

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

describe("a 90 s limit", () => {
  const STALLED_MS = 90_000, EVERY_MS = 5_000, REPORT_MS = 30_000, WORK_S = 140;
  const h = watched("watchdog-progress", STALLED_MS, EVERY_MS);

  test("with a 90 s limit, an agent editing files and one waiting on a long command aren't flagged; a silent one is", async () => {
    const w = h.w;
    const run = await newRun(w);
    h.runs.push(run);
    const leaf = (name: string, summary: string) => w.script(name, `sleep ${WORK_S}\ncapcomd result --summary "${summary}" >/dev/null`);
    const editor = leaf("wdp-editor", "edited"), commander = leaf("wdp-commander", "ran the tests"), silent = leaf("wdp-silent", "said nothing");
    const planner = await spawnRoot(w, run, "planner", w.script("wdp-planner", `a=$(capcomd spawn --profile worker --task "edits files" --key editor --contract "$($S/json script='${editor}')" | $S/jget agentId)
b=$(capcomd spawn --profile worker --task "runs a long command" --key commander --contract "$($S/json script='${commander}')" | $S/jget agentId)
c=$(capcomd spawn --profile worker --task "does nothing" --key silent --contract "$($S/json script='${silent}')" | $S/jget agentId)
while :; do
  out=$(capcomd await $a $b $c --timeout-ms 300000)
  case "$out" in *'"notices"'*) echo "noticed: $(printf "%s" "$out" | $S/jget notices.0.kind) $(printf "%s" "$out" | $S/jget notices.0.agentId)"; continue;; esac
  break
done
capcomd result --summary "watched" >/dev/null`), { task: "watch three workers" });
    let kids: Array<{ agentId: string; task: string; status: string }> = [];
    for (let i = 0; i < 300 && (kids.length < 3 || kids.some((k) => k.status !== "running")); i++) { kids = (await agentsOf(run)).filter((a: any) => a.parent === planner); await sleep(100); }
    const id = (task: string) => kids.find((k) => k.task === task)!.agentId;
    const editorId = id("edits files"), commanderId = id("runs a long command"), silentId = id("does nothing");
    // From now on, as their runners would: the editor's files change every 30 s (a supervisor heartbeat that saw a new
    // tree), the commander's runner sees the same command running, started just now.
    const started = Date.now(), commandSince = Date.now();
    const reporter = (async () => {
      while (Date.now() - started < (WORK_S - 10) * 1000) {
        await sleep(REPORT_MS);
        await worked(run, editorId, { files: true });
        await worked(run, commanderId, { commandSince });
      }
    })();
    const done = (await waitAll(w, run, [planner], (WORK_S + 120) * 1000)).agents[0];
    await reporter;
    expect(done.status).toBe("done");

    const evs = await trajectory(w, run);
    const notices = evs.filter((e) => e.type === "AGENT_NOTICE" && e.data.kind === "stalled");
    expect(notices.map((e) => e.agentId)).toEqual([silentId]);
    // At 90 s from its start (its clock's), within one look of it.
    const start = evs.find((e) => e.type === "AGENT_STARTED" && e.agentId === silentId) as any;
    const after = notices[0]!.data.at - start.at;
    expect(after).toBeGreaterThanOrEqual(STALLED_MS - 1000);
    expect(after).toBeLessThan(STALLED_MS + EVERY_MS + 5000);
    expect(notices[0]!.data.detail).toMatch(/^no progress for 9\d s: no file change seen, no agent of its own started or ended, no check or approval it waited on finished; (no tool step|\d+ tool steps?) seen meanwhile$/);
    // No checkpoint came for any of them: what the watchdog saw was the runners' reports.
    expect(evs.filter((e) => e.type === "AGENT_CHECKPOINT")).toEqual([]);
    const final = new Map((await agentsOf(run)).map((a: any) => [a.agentId, a.status]));
    expect([final.get(editorId), final.get(commanderId), final.get(silentId)]).toEqual(["done", "done", "done"]);
  }, (WORK_S + 180) * 1000);
});

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
