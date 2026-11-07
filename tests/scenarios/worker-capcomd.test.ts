// Every agent that does work has the in-VM capcomd (ADR-017, plugin API §16.2, ADR-025 §5.1), not only one that may
// spawn: a scripted worker whose profile can't spawn runs a long command as a background job (`running` at once, its
// result as a message from the job), keeps notes, reads the tree it sees, proposes a lesson that the context plugin
// captures, ends with its summary, and is refused a spawn by its token. A worker whose profile runs no command of its
// own (an allow-list with no shell) has no job ops in its token, so `capcomd job start` is no way around its tool policy.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PROFILES, agentsOf, trajectory, world, newRun, spawnRoot, waitAll, type World } from "./harness";

let w: World;
let dir: string;
/** This file's runs: their scripted agents' and jobs' processes are named by them. */
const runs: string[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "capcomd-scn-worker-capcomd-"));
  const agents = join(dir, "agents.json");
  // tester: reads, and runs only the project's test command (as `capcomd setup` gives a reviewer).
  writeFileSync(agents, JSON.stringify({ ...PROFILES, agents: { ...PROFILES.agents, tester: { ...PROFILES.agents.worker, allowedTools: ["Read", "Grep", "Bash(bun test:*)"] } } }));
  w = await world("worker-capcomd", { CAPCOMD_AGENTS_FILE: agents, CAPCOMD_JOBS_POLL_MS: "200" });
}, 120_000);
afterAll(async () => {
  // A scenario that failed may leave a scripted agent or its job behind: stop them.
  const mine = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString().split("\n").filter((l) => w && (l.includes(w.dir) || runs.some((r) => l.includes(`/${r}/`)))).map((l) => Number(l.trim().split(/\s+/)[0]));
  for (const pid of mine) if (pid > 1 && pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  try { await w?.stop(); } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
});

const logsOf = async (run: string, agent: string) => (await w.cj(["logs", run, agent, "--tail", "2000"])).j.lines.map((l: any) => l.line).join("\n");
const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

/** Wait in the script until a message whose text contains $1 is in the inbox; print who it is from. */
const WAIT_MSG = `wait_msg() { end=$(( $(date +%s) + 150 )); while :; do m=$(capcomd inbox); case "$m" in *"$1"*) printf "%s" "$m" | $S/jget messages | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s))if(m.body.text.includes(process.argv[1]))console.log("msg-from: "+m.from)})' "$1"; return 0;; esac; [ $(date +%s) -gt $end ] && return 1; sleep 0.2; done; }`;

test("a worker that may not spawn runs a job, keeps notes, proposes a captured lesson and ends with its summary; a spawn is refused", async () => {
  const run = await newRun(w);
  runs.push(run);
  const lesson = { context: [{ title: "Suite time", text: "The whole suite under tests/ takes about three seconds and ends by printing suite-ok." }] };
  const agent = await spawnRoot(w, run, "worker", w.script("worker-capcomd", `${WAIT_MSG}
r=$(capcomd job start --label suite --foreground-ms 500 -- 'sleep 3; echo suite-ok')
echo "start-state: $(printf "%s" "$r" | $S/jget state)"
echo "job: $(printf "%s" "$r" | $S/jget jobId)"
capcomd kv put notes/$CAPCOMD_AGENT_ID '{"plan":"run the suite as a job"}' >/dev/null || exit 3
echo "tree-ok: $(capcomd tree | $S/jget ok)"
s=$(capcomd spawn --task "help me with the suite"); code=$?
echo "spawn: exit $code $(printf "%s" "$s" | $S/jget error.reason)"
wait_msg suite-ok || exit 9
capcomd result --summary "ran the suite: suite-ok" --data ${sq(JSON.stringify(lesson))} >/dev/null || exit 4`));
  const done = (await waitAll(w, run, [agent], 120_000)).agents[0];
  const logs = await logsOf(run, agent);
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  expect(done.result.summary).toBe("ran the suite: suite-ok");
  // The job answered `running` after its foreground wait; its result came as a message from it.
  expect(logs).toContain("start-state: running");
  const job = /job: (job-\S+)/.exec(logs)![1]!;
  expect(logs).toContain(`msg-from: ${job}`);
  expect((await w.cj(["kv", "get", run, `_jobs/${job}`])).j.value).toMatchObject({ state: "done", by: agent, result: { code: 0, stdout: "suite-ok\n" } });
  // A read its token allows; a spawn it doesn't (its profile may not spawn).
  expect(logs).toContain("tree-ok: true");
  expect(logs).toContain("spawn: exit 1 forbidden");
  expect(logs).toMatch(/\[capcomd\] spawn → error forbidden: op "spawn" is not in your token/);
  expect((await agentsOf(run)).map((a: { agentId: string }) => a.agentId)).toEqual([agent]);
  // Its notes, written by it.
  expect((await w.cj(["kv", "get", run, `notes/${agent}`])).j).toMatchObject({ writer: agent, value: { plan: "run the suite as a job" } });
  // Its lesson, captured at its end as a candidate attributed to it.
  let evs: Awaited<ReturnType<typeof trajectory>> = [];
  for (let i = 0; i < 100 && !evs.length; i++) { evs = await trajectory(w, run, (e) => e.type === "plugin.context.proposed"); if (!evs.length) await Bun.sleep(100); }
  expect(evs[0]?.data).toMatchObject({ agentId: agent, profile: "worker", candidate: { id: `${agent}.1`, proposal: { title: "Suite time", type: "lesson" } } });
  expect((await w.cj(["kv", "get", run, `_context/${agent}`])).j.value.candidates.map((c: any) => c.id)).toEqual([`${agent}.1`]);
}, 180_000);

test("a worker whose profile runs no command of its own has no job ops: its job start is refused, its result is kept", async () => {
  const run = await newRun(w);
  runs.push(run);
  const agent = await spawnRoot(w, run, "tester", w.script("tester-capcomd", `r=$(capcomd job start -- 'echo should-not-run'); code=$?
echo "job: exit $code $(printf "%s" "$r" | $S/jget error.reason)"
capcomd result --summary "read the code" >/dev/null || exit 4
e=$(capcomd result); echo "empty result: exit $? $(printf "%s" "$e" | $S/jget error.code)"`));
  const done = (await waitAll(w, run, [agent], 120_000)).agents[0];
  const logs = await logsOf(run, agent);
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  // An empty `capcomd result` (a tool called with no arguments) is refused, so it can't erase the one declared before.
  expect(done.result.summary).toBe("read the code");
  expect(logs).toContain("empty result: exit 2 usage");
  expect(logs).toContain("job: exit 1 forbidden");
  expect(logs).toMatch(/\[capcomd\] job\.start → error forbidden: op "job\.start" is not in your token/);
  expect((await w.cj(["kv", "list", run, "--prefix", "_jobs/"])).j.entries ?? []).toEqual([]);
}, 120_000);
