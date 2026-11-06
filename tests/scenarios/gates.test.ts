// Plugin API step 5 (docs/spec/plugin-api.md §17.2, §6.6.13, §6.5): the run's reviewer is one judge, the built-in
// gate-reviewer plugin, ANDed with the checks (which stay capcomd's) and every other judge: here a test plugin
// (tests/plugins/fixtures/test-gate, loaded through CAPCOMD_TEST_PLUGINS by the daemon and by the CLI's own gates) that
// denies a change whose task says JUDGE-DENY. At merge.landing test-gate denies every merge and test-holder holds it:
// an ordinary merge fails naming the plugin; `merge --operator` lands past both and the run's stream records
// plugin.gate_bypassed naming each.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { world, waitAll, agentsOf, trajectory, WORKER, type World } from "./harness";

const FIXTURES = join(import.meta.dir, "..", "plugins", "fixtures");
let w: World;
let worker: string;
beforeAll(async () => {
  const reviewer = join(mkdtempSync(join(tmpdir(), "capcomd-gates-")), "reviewer.sh");
  // Scripted reviewer: the brief (its task) carries the child's task; GOOD passes, anything else fails.
  writeFileSync(reviewer, `#!/bin/sh
case "$CAPCOMD_TASK" in
  *GOOD*) capcomd result --summary "looks right" --data '{"passed":true,"reasons":["does what the task asks"]}' >/dev/null ;;
  *) capcomd result --summary "wrong" --data '{"passed":false,"reasons":["returns the wrong value"]}' >/dev/null ;;
esac
`);
  chmodSync(reviewer, 0o755);
  w = await world("gates", { CAPCOMD_TEST_PLUGINS: `${join(FIXTURES, "test-gate")}:${join(FIXTURES, "test-holder")}`, NODE_ENV: "test", CAPCOMD_SCRIPT_REVIEWER: `sh ${reviewer}` });
  worker = w.script("worker", WORKER);
}, 120_000);
afterAll(async () => { await w?.stop(); });

async function spawnDone(run: string, key: string, task: string) {
  const sp = await w.cj(["spawn", run, "--profile", "worker", "--task", task, "--key", key, "--contract", JSON.stringify({ script: `FILE=src/${key}.txt CONTENT=${key} ${worker}` })]);
  const id = sp.j.agentId as string;
  expect((await waitAll(w, run, [id])).agents[0].status).toBe("done");
  return id;
}
const verify = async (run: string, ref: string, key: string) => (await w.cj(["verify", run, "--ref", ref, "--checks", `test -f src/${key}.txt`, "--key", `v-${key}`])).j;

test("the reviewer is one judge: the checks, it and every other judge must pass, for the same tree", async () => {
  // The daemon loaded the reviewer gate and the test plugins.
  const listed = (await w.cj(["plugins", "list"])).j;
  expect(listed.daemon).not.toBeNull();
  const names = listed.plugins.filter((p: any) => p.state === "active").map((p: any) => p.name);
  for (const n of ["gate-reviewer", "test-gate", "test-holder"]) expect(names).toContain(n);

  const run = (await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `gates-${Date.now()}`, "--reviewer", "reviewer"])).j.runId as string;
  const good = await spawnDone(run, "a", "write GOOD a");
  const bad = await spawnDone(run, "b", "write BAD b");
  const vetoed = await spawnDone(run, "c", "write GOOD JUDGE-DENY c");

  // Everything passes: the checks, the test judge, the reviewer (the reviewer gate runs last: order post; context-memory, first by name, lets a branch that doesn't touch .capcomd/context/ through).
  const a = await verify(run, good, "a");
  expect(a).toMatchObject({ state: "passed", result: { pass: true, checks: { passed: true }, review: { profile: "reviewer", passed: true, reasons: ["does what the task asks"] }, judges: { passed: true, plugins: ["context-memory", "test-gate", "gate-reviewer"], deniedBy: null } } });
  const rv = (await agentsOf(run)).find((x: any) => x.agentId === a.result.review.agentId);
  expect(rv.contract.review).toMatchObject({ sha: a.result.commit, targetSha: a.result.tested.targetSha, vfyId: a.id });

  // The reviewer fails it: the checks and the test judge passed, the verify fails, with the reviewer's reasons.
  const b = await verify(run, bad, "b");
  expect(b).toMatchObject({ state: "failed", result: { pass: false, checks: { passed: true }, review: { passed: false, reasons: ["returns the wrong value"] }, judges: { passed: false, deniedBy: "gate-reviewer" } } });

  // The other judge fails it: the reviewer would pass it, but every judge must pass; the reviewer isn't asked.
  const c = await verify(run, vetoed, "c");
  expect(c).toMatchObject({ state: "failed", result: { pass: false, checks: { passed: true }, judges: { passed: false, deniedBy: "test-gate", reasons: ["its task says JUDGE-DENY"] } } });
  expect(c.result.review).toBeUndefined();

  // Each denial is on the run's stream, naming the plugin.
  const denied = (await trajectory(w, run)).filter((e) => e.type === "PLUGIN_GATE_DENIED").map((e) => e.data);
  expect(denied).toContainEqual(expect.objectContaining({ plugin: "gate-reviewer", hook: "verify.judging", entity: b.id, decision: "deny" }));
  expect(denied).toContainEqual(expect.objectContaining({ plugin: "test-gate", hook: "verify.judging", entity: c.id, decision: "deny", reason: "the test judge refuses this change" }));
}, 180_000);

test("merge --operator lands past plugin vetoes and records plugin.gate_bypassed naming each plugin", async () => {
  const run = (await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `bypass-${Date.now()}`])).j.runId as string;
  const id = await spawnDone(run, "d", "write d");
  const v = await verify(run, id, "d");
  expect(v).toMatchObject({ state: "passed", result: { pass: true, judges: { passed: true, plugins: ["context-memory", "test-gate", "gate-reviewer"] } } });

  // An ordinary merge: test-gate (first by name) denies it; it fails with plugin:test-gate and nothing lands.
  const m = await w.cj(["merge", run, "--ref", id, "--require", v.id, "--key", "m-d"]);
  expect(m.j).toMatchObject({ state: "failed" });
  expect(m.j.result.reason).toContain("plugin:test-gate");
  const trunk = () => Bun.spawnSync(["git", "-C", w.repo.bare, "ls-tree", "-r", "--name-only", "trunk"]).stdout.toString();
  expect(trunk()).not.toContain("src/d.txt");

  // The operator's merge: every landing gate is asked (both veto), and it lands anyway, saying whose vetoes it bypassed.
  const op = await w.cj(["merge", run, "--ref", id, "--operator", "--key", "m-op"]);
  expect(op.j).toMatchObject({ state: "merged", result: { merged: true } });
  expect(op.j.result.bypassedVetoes).toEqual([{ plugin: "test-gate", reason: "the test gate lands nothing" }, { plugin: "test-holder", reason: "the test holder wants a person to look" }]);
  expect(trunk()).toContain("src/d.txt");

  const evs = await trajectory(w, run);
  const bypassed = evs.filter((e) => e.type === "PLUGIN_GATE_BYPASSED");
  expect(bypassed.length).toBe(1);
  expect(bypassed[0]!.data).toEqual({ hook: "merge.landing", entity: op.j.id, by: "operator", plugins: [{ plugin: "test-gate", reason: "the test gate lands nothing" }, { plugin: "test-holder", reason: "the test holder wants a person to look" }] });
  // Recorded before it landed, and the ordinary merge's denial is there too.
  expect(evs.findIndex((e) => e.type === "PLUGIN_GATE_BYPASSED")).toBeLessThan(evs.findIndex((e) => e.type === "MERGED"));
  expect(evs.filter((e) => e.type === "PLUGIN_GATE_DENIED").map((e) => [e.data.plugin, e.data.hook, e.data.entity])).toContainEqual(["test-gate", "merge.landing", m.j.id]);
}, 180_000);
