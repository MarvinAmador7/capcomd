// Background jobs (plugin API §16.2, §17.2 step 7): a scripted agent starts a 10 s command with `capcomd job start
// --foreground-ms 1000`, gets `running` at once, keeps working, and the command's result arrives in its inbox as a
// message; a quick command answers with its result in the foreground. The run's stream has job.started / job.ended, the
// run's kv the record, and a plugin listening to job.changed hears started and ended. A daemon that crashes while a
// job runs settles it when it comes back (the agent's machine kept running it). An agent's own kill stops its job; its
// jobs end when it does; an orchestrate agent starts none.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PROFILES, trajectory, world, newRun, spawnRoot, waitAll, type World } from "./harness";
import type { Recorded } from "../plugins/fixtures/hook-recorder/index";

const RECORDER = join(import.meta.dir, "..", "plugins", "fixtures", "hook-recorder");
let w: World;
let dir: string;
let log: string;
/** This file's runs: their scripted agents' and jobs' processes are named by them. */
const runs: string[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "capcomd-scn-jobs-"));
  log = join(dir, "hooks.ndjson");
  const agents = join(dir, "agents.json");
  writeFileSync(agents, JSON.stringify({ ...PROFILES, agents: { ...PROFILES.agents, router: { ...PROFILES.agents.planner, toolMode: "orchestrate" } } }));
  w = await world("jobs", { CAPCOMD_AGENTS_FILE: agents, CAPCOMD_JOBS_POLL_MS: "200", CAPCOMD_TEST_PLUGINS: RECORDER, CAPCOMD_TEST_HOOK_LOG: log, NODE_ENV: "test" });
}, 120_000);
afterAll(async () => {
  // A scenario that failed may leave a scripted agent (its "VM" outlives a crashed daemon) or a job behind: stop them.
  const mine = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString().split("\n").filter((l) => w && (l.includes(w.dir) || runs.some((r) => l.includes(`/${r}/`)))).map((l) => Number(l.trim().split(/\s+/)[0]));
  for (const pid of mine) if (pid > 1 && pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  try { await w?.stop(); } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
});

const calls = (): Recorded[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Recorded) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logsOf = async (run: string, agent: string) => (await w.cj(["logs", run, agent, "--tail", "2000"])).j.lines.map((l: any) => l.line).join("\n");

/** Wait in the script until a message whose text contains $1 is in the inbox; print its text. */
const WAIT_MSG = `wait_msg() { end=$(( $(date +%s) + 150 )); while :; do m=$(capcomd inbox); case "$m" in *"$1"*) printf "%s" "$m" | $S/jget messages | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s))if(m.body.text.includes(process.argv[1]))console.log("msg-from: "+m.from+"\\nmsg: "+JSON.stringify(m.body.text))})' "$1"; return 0;; esac; [ $(date +%s) -gt $end ] && return 1; sleep 0.2; done; }`;

test("a 10 s job answers running and its result arrives as a message; a quick one answers in the foreground", async () => {
  const run = await newRun(w);
  runs.push(run);
  const t0 = Date.now();
  const agent = await spawnRoot(w, run, "worker", w.script("long-job", `${WAIT_MSG}
r=$(capcomd job start --label build --foreground-ms 1000 -- 'sleep 10; echo built-ok; echo a-warning >&2')
echo "start-state: $(printf "%s" "$r" | $S/jget state) at $(date +%s)"
j=$(printf "%s" "$r" | $S/jget jobId)
echo "job: $j"
q=$(capcomd job start --label quick -- echo quick-ok)
echo "quick: $(printf "%s" "$q" | $S/jget state) $(printf "%s" "$q" | $S/jget stdout)"
echo "listed: $(capcomd job list | $S/jget jobs.1.state)"
echo "output-so-far: $(capcomd job output $j | $S/jget state)"
wait_msg built-ok || exit 9
echo "done-at: $(date +%s)"
capcomd result --summary "built" >/dev/null`));
  const done = (await waitAll(w, run, [agent], 120_000)).agents[0];
  const logs = await logsOf(run, agent);
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  // `running` came back after the foreground wait, long before the job ended.
  expect(logs).toMatch(/start-state: running/);
  const started = Number(/start-state: running at (\d+)/.exec(logs)![1]) * 1000;
  expect(started - t0).toBeLessThan(30_000);
  const job = /job: (job-\S+)/.exec(logs)![1]!;
  expect(logs).toContain("quick: done quick-ok");
  expect(logs).toContain("listed: running");
  expect(logs).toContain("output-so-far: running");
  // The message: from the job, with its output and how it ended.
  expect(logs).toContain(`msg-from: ${job}`);
  expect(logs).toMatch(/msg: ".*finished \(exit 0\) after.*built-ok.*a-warning.*capcomd job output job-/);
  expect(Number(/done-at: (\d+)/.exec(logs)![1]) * 1000 - started).toBeGreaterThanOrEqual(8_000);
  // The record on the run's kv, written by the kernel.
  const kv = await w.cj(["kv", "get", run, `_jobs/${job}`]);
  expect(kv.j.value).toMatchObject({ jobId: job, state: "done", plugin: null, by: agent, spec: { kind: "exec", owner: { agentId: agent }, cmd: ["sleep 10; echo built-ok; echo a-warning >&2"], label: "build" }, result: { code: 0, truncated: false } });
  expect(kv.j.value.result.stdout).toBe("built-ok\n");
  expect(kv.j.value.result.stderr).toBe("a-warning\n");
  expect(kv.j.writer).toBe("capcomd");
  // The run's stream: started and ended for both, on the agent; the result went to its inbox.
  const evs = await trajectory(w, run, (e) => e.type.startsWith("JOB_") || (e.type === "MESSAGE_SENT" && e.data.to === agent));
  const mine = evs.filter((e) => e.data.jobId === job || e.agentId === job);
  expect(mine.map((e) => e.type)).toEqual(["JOB_STARTED", "JOB_ENDED", "MESSAGE_SENT"]);
  expect(mine[0]).toMatchObject({ agentId: agent, data: { jobId: job, kind: "exec", owner: agent, label: "build", plugin: null } });
  expect(mine[1]).toMatchObject({ agentId: agent, data: { jobId: job, state: "done", code: 0, reason: null } });
  expect(mine[1]!.data.ms).toBeGreaterThanOrEqual(9_000);
  expect(evs.filter((e) => e.type === "JOB_ENDED").length).toBe(2);
  // A plugin listening to job.changed heard each job start and end (the quick one too: it went to its caller).
  for (let i = 0; i < 50 && calls().filter((c) => c.hook === "job.changed" && c.change === "ended").length < 2; i++) await sleep(100);
  const jc = calls().filter((c) => c.hook === "job.changed" && c.subject === job);
  expect(jc.map((c) => c.change)).toEqual(["started", ...jc.slice(1, -1).map(() => "output"), "ended"]);
  expect(jc[0]).toMatchObject({ runId: run, agentId: agent, principal: "agent" });
}, 180_000);

test("a daemon that crashes while a job runs settles it when it comes back: the result still arrives", async () => {
  const run = await newRun(w);
  runs.push(run);
  const mark = join(dir, `started-${Date.now()}`);
  const agent = await spawnRoot(w, run, "worker", w.script("restart-job", `${WAIT_MSG}
r=$(capcomd job start --label slow --foreground-ms 500 -- 'sleep 8; echo survived-restart')
j=$(printf "%s" "$r" | $S/jget jobId)
echo "job: $j $(printf "%s" "$r" | $S/jget state)"
echo "$j $(printf "%s" "$r" | $S/jget state)" > ${JSON.stringify(mark)}
wait_msg survived-restart || exit 9
capcomd result --summary "survived" >/dev/null`));
  for (let i = 0; i < 300 && !existsSync(mark); i++) await sleep(100);
  expect(existsSync(mark)).toBe(true);
  const [job, state] = readFileSync(mark, "utf8").trim().split(" ");
  expect(state).toBe("running");
  await w.restart(1500);
  const done = (await waitAll(w, run, [agent], 120_000)).agents[0];
  const logs = await logsOf(run, agent);
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  expect(logs).toContain(`msg-from: ${job}`);
  const kv = await w.cj(["kv", "get", run, `_jobs/${job}`]);
  expect(kv.j.value).toMatchObject({ state: "done", result: { code: 0, stdout: "survived-restart\n" } });
  const ended = await trajectory(w, run, (e) => e.type === "JOB_ENDED");
  expect(ended.map((e) => e.data.jobId)).toEqual([job]);
  // It may have ended while the daemon was away: its record says when it exited, not when capcomd looked again.
  expect(ended[0]!.data.ms).toBeGreaterThanOrEqual(7_500);
  expect(ended[0]!.data.ms).toBeLessThan(15_000);
}, 240_000);

test("an agent kills its own job; its jobs end with it; an orchestrate agent starts none", async () => {
  const run = await newRun(w);
  runs.push(run);
  const pidFile = join(dir, `orphan-${Date.now()}`);
  const agent = await spawnRoot(w, run, "worker", w.script("kill-job", `
r=$(capcomd job start --label forever --foreground-ms 300 -- 'trap "echo got-term; exit 7" TERM; while :; do sleep 0.1; done')
j=$(printf "%s" "$r" | $S/jget jobId)
k=$(capcomd job kill $j --reason "not needed")
echo "kill: $(printf "%s" "$k" | $S/jget state)"
i=0; while [ "$(capcomd job output $j | $S/jget state)" != killed ] && [ $i -lt 100 ]; do i=$((i+1)); sleep 0.1; done
echo "after: $(capcomd job output $j | $S/jget state) $(capcomd job list | $S/jget jobs.0.reason)"
l=$(capcomd job start --label left-running --foreground-ms 300 -- 'echo $$ > ${pidFile}; exec sleep 600')
echo "left: $(printf "%s" "$l" | $S/jget jobId)"
capcomd result --summary "killed" >/dev/null`));
  const done = (await waitAll(w, run, [agent], 120_000)).agents[0];
  const logs = await logsOf(run, agent);
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  expect(logs).toMatch(/kill: (stopping|killed)/);
  expect(logs).toContain(`after: killed by ${agent}: not needed`);
  // The job it left running ended with it: killed, its process gone.
  const left = /left: (job-\S+)/.exec(logs)![1]!;
  let rec: any = null;
  for (let i = 0; i < 100; i++) { rec = (await w.cj(["kv", "get", run, `_jobs/${left}`])).j.value; if (rec?.state !== "running" && rec?.state !== "stopping") break; await sleep(100); }
  expect(rec).toMatchObject({ state: "killed", reason: "its agent ended" });
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) { try { process.kill(pid, 0); await sleep(100); } catch { alive = false; } }
  expect(alive).toBe(false);
  // Its result went nowhere: it ended with its agent.
  expect((await trajectory(w, run, (e) => e.type === "MESSAGE_SENT")).length).toBe(0);

  const router = await spawnRoot(w, run, "router", w.script("router-job", `echo "refused: $(capcomd job start -- npm test | $S/jget error.message)"
capcomd result --summary routed >/dev/null`), { task: "route" });
  const r = (await waitAll(w, run, [router], 60_000)).agents[0];
  const rlogs = await logsOf(run, router);
  expect(rlogs).toContain("refused: an orchestrate agent runs nothing, in the background either");
  void r;
}, 180_000);
