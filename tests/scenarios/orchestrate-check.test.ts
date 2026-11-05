// `capcomd check <ref>` (plugin API §16.1): the run's checks on a ref's commit as it is, merging nothing. A scripted
// router (toolMode: orchestrate) lands two workers' changes, then checks the combined code (the run's target) from its
// VM, a child's branch, and is refused a command of its own or a check of itself. The operator's check of the same
// commit is the same check (one id, one run); the run's events and the router's log say what happened. A check's
// output and its failure come back whole; identical checks running at once run once; a check waits for a machine slot
// where the place has a cap, as an agent does.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { capcomd } from "../helpers/engine";
import { PROFILES, trajectory, world, newRun, spawnRoot, waitAll, WORKER, type World } from "./harness";

let w: World;
beforeAll(async () => {
  const agents = join(mkdtempSync(join(tmpdir(), "capcomd-scn-orch-check-")), "agents.json");
  writeFileSync(agents, JSON.stringify({ ...PROFILES, agents: { ...PROFILES.agents, router: { ...PROFILES.agents.planner, toolMode: "orchestrate" } } }));
  // Checks that run (on this host, with the fakes). Two slots of the fakes' memory cap: the router holds one.
  w = await world("orch-check", { CAPCOMD_AGENTS_FILE: agents, CAPCOMD_TEST_COMMAND: "test -f README.md && echo checked-$CAPCOMD_TARGET", CAPCOMD_FAKE_MEMORY_MB: "2048", CAPCOMD_ADMIT_RETRY_MS: "300", CAPCOMD_CHECK_SLOT_POLL_MS: "200" });
}, 120_000);
afterAll(async () => { await w?.stop(); });

test("a router checks the combined code after two merges, from its VM; the operator's check of that commit is the same one", async () => {
  const run = await newRun(w);
  const worker = w.script("worker", WORKER);
  const router = w.script("router", `W=${JSON.stringify(worker)}
a=$(capcomd spawn --profile worker --task "write a" --key a --children.maxChildren=0 --contract "$($S/json script="FILE=src/a.txt CONTENT=a $W")" | $S/jget agentId)
b=$(capcomd spawn --profile worker --task "write b" --key b --children.maxChildren=0 --contract "$($S/json script="FILE=src/b.txt CONTENT=b $W")" | $S/jget agentId)
capcomd await $a $b >/dev/null || exit 1
va=$(capcomd verify --ref $a --key v-a | $S/jget id)
vb=$(capcomd verify --ref $b --key v-b | $S/jget id)
capcomd merge --ref $a --require $va --key m-a >/dev/null
capcomd merge --ref $b --require $vb --key m-b >/dev/null
c=$(capcomd check)
echo "check-pass: $(printf "%s" "$c" | $S/jget result.pass)"
echo "check-text: $(printf "%s" "$c" | $S/jget result.text)"
echo "check-id: $(printf "%s" "$c" | $S/jget id)"
echo "check-again: $(capcomd check trunk | $S/jget id)"
echo "check-child: $(capcomd check $a | $S/jget result.pass)"
echo "check-cmd: $(capcomd check trunk --checks 'rm -rf /' | $S/jget error.message)"
echo "check-self: $(capcomd check $CAPCOMD_AGENT_ID | $S/jget error.message)"
capcomd result --summary routed >/dev/null`);
  const root = await spawnRoot(w, run, "router", router);
  const done = (await waitAll(w, run, [root])).agents[0];
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  const head = (await w.repo.seed.ok(["ls-remote", w.repo.bare, "refs/heads/trunk"])).split(/\s+/)[0]!;
  expect(logs).toContain("check-pass: true");
  // b's merge ran the checks on exactly this tree (trunk with both changes), so it isn't run again.
  expect(logs).toContain(`check-text: trunk at ${head.slice(0, 12)} (with 2 merges from this run) is a tree that already passed these checks in this run: pass`);
  const id = /check-id: (chk-\S+)/.exec(logs)![1]!;
  expect(logs).toContain(`check-again: ${id}`); // the same commit and command: the same check
  expect(logs).toContain("check-child: true");
  expect(logs).toContain("check-cmd: in-VM check cannot set --checks: check commands come only from the operator");
  expect(logs).toContain(`check-self: agent ${root} is an orchestrate agent: it has no branch of its own`);
  expect(logs).toMatch(/\[capcomd\] check → ok/);

  // The operator's check of trunk now: the same record.
  const op = await w.cj(["check", run, "trunk"]);
  expect(op.code).toBe(0);
  expect(op.j).toMatchObject({ id, kind: "check", state: "passed", branch: "trunk", sha: head, askedBy: root, result: { pass: true, commit: head, mergesOn: 2, checks: { passed: true, status: "passed", where: "reused" } } });
  // The run's events: started (on the router's column: it asked) and passed, without the output.
  const evs = await trajectory(w, run, (e) => e.type.startsWith("CHECK_") && e.data.id === id);
  expect(evs.map((e) => e.type)).toEqual(["CHECK_STARTED", "CHECK_PASSED"]);
  expect(evs[0]).toMatchObject({ agentId: root, data: { id, ref: "trunk", branch: "trunk", sha: head, agentId: null, askedBy: root } });
  expect(evs[1]!.data.checks.output).toBeUndefined();
  // Merges nothing: trunk is where the router's merges left it.
  expect((await w.repo.seed.ok(["ls-remote", w.repo.bare, "refs/heads/trunk"])).split(/\s+/)[0]).toBe(head);
}, 180_000);

test("the output and a failure come back whole; identical checks at once run once; the CLI exits non-zero on a failure", async () => {
  const run = await newRun(w);
  const marks = join(w.dir, `runs-${Date.now()}`);
  const cmd = `echo ran >> ${marks}; sleep 2; echo out-$CAPCOMD_TARGET; seq 1 3000; echo boom >&2; exit 3`;
  const [x, y] = await Promise.all([w.cj(["check", run, "trunk", "--checks", cmd]), w.cj(["check", run, "trunk", "--checks", cmd])]);
  expect(x.code).not.toBe(0);
  expect(x.j.id).toBe(y.j.id);
  expect(readFileSync(marks, "utf8").trim().split("\n")).toEqual(["ran"]);
  expect(x.j).toMatchObject({ state: "failed", result: { pass: false, checks: { passed: false, status: "failed", where: "host", reason: "the checks failed" } } });
  const out = String(x.j.result.checks.output);
  for (const s of ["out-trunk", "\n1\n", "\n3000\n", "boom"]) expect(out).toContain(s); // ~14 KB: all of it
  expect(x.j.result.text).toMatch(/^checks ran on trunk at [0-9a-f]{12}: fail \(the checks failed\)$/);
  // Its text output: the check's output, then the line.
  const plain = await capcomd(["check", run, "--id", x.j.id], w.env);
  expect(plain.stdout).toContain("boom");
  expect(plain.stdout).toContain(`${x.j.id}: failed\n  checks ran on trunk at`);
  // A key checks that commit again.
  const again = await w.cj(["check", run, "trunk", "--checks", cmd, "--key", "flaky"]);
  expect(again.j.id).not.toBe(x.j.id);
  expect(readFileSync(marks, "utf8").trim().split("\n")).toEqual(["ran", "ran"]);
  // A run whose only checks are named ones (a project's `run.checks`, no test command): its one check is the default
  // (not "nothing ran: pass"); with several, the caller names one.
  const noCmd = { ...w.env, CAPCOMD_TEST_COMMAND: "" };
  const last = (s: string) => JSON.parse(s.trim().split("\n").pop()!);
  const one = last((await capcomd(["run", "new", "--key", `one-${Date.now()}`, "--checks-set", "unit=echo unit-ran", "--json"], noCmd)).stdout).runId;
  const c1 = last((await capcomd(["check", one, "trunk", "--json"], noCmd)).stdout);
  expect(c1).toMatchObject({ state: "passed", check: "unit", checks: "echo unit-ran", result: { checks: { where: "host", command: "echo unit-ran" } } });
  expect(c1.result.checks.output).toContain("unit-ran");
  const two = last((await capcomd(["run", "new", "--key", `two-${Date.now()}`, "--checks-set", "a=true", "--checks-set", "b=true", "--json"], noCmd)).stdout).runId;
  const c2 = last((await capcomd(["check", two, "trunk", "--json"], noCmd)).stdout);
  expect(c2.error.message).toContain("this run has 2 named checks and no default one");
  expect(c2.error.hint).toContain("a, b");
  // A branch the repository doesn't have; a ref that isn't a branch name.
  expect((await w.cj(["check", run, "no-such-branch"])).j.error.message).toContain("branch no-such-branch isn't on");
  expect((await w.cj(["check", run, "../x"])).j.error.code).toBe("usage");
}, 120_000);

test("a check waits for a machine slot where the place has a cap, as an agent does", async () => {
  const run = await newRun(w);
  const worker = w.script("slow-worker", WORKER);
  const flag = join(w.dir, `worker-done-${Date.now()}`);
  // Two slots: the router has one, its slow worker the other; the router's check waits for the worker to finish.
  const router = w.script("slot-router", `W=${JSON.stringify(worker)}
a=$(capcomd spawn --profile worker --task "slow" --key s --children.maxChildren=0 --contract "$($S/json script="SLEEP=4 FILE=src/s.txt $W; touch ${flag}")" | $S/jget agentId)
sleep 1
c=$(capcomd check trunk --key slot)
echo "slot-wait: $(printf "%s" "$c" | $S/jget result.timings.slotWaitMs)"
echo "worker-done-first: $([ -e ${flag} ] && echo yes || echo no)"
capcomd await $a >/dev/null
capcomd result --summary checked >/dev/null`);
  const root = await spawnRoot(w, run, "router", router);
  const done = (await waitAll(w, run, [root])).agents[0];
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  expect(logs).toContain("worker-done-first: yes");
  expect(Number(/slot-wait: (\d+)/.exec(logs)![1])).toBeGreaterThan(1000);
  expect(existsSync(flag)).toBe(true);
}, 180_000);
