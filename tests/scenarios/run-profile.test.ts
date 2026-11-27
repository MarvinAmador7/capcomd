// `capcomd run "<goal>" --profile P` (POST /v1/runs `profile`, the desktop's Team launcher): a run of one agent of that
// profile. No planner: the agent works on the goal (scripted here), and the run's driver verifies its work, merges it
// onto the run's goal branch and says the goal is done; a failing agent ends the run failed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { capcomd } from "../helpers/engine";
import { world, WORKER, type World } from "./harness";

let w: World;
let worker: string;
beforeAll(async () => { w = await world("runprofile"); worker = w.script("worker", WORKER); }, 120_000);
afterAll(async () => { await w?.stop(); });

const lines = (out: string) => out.trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

test("capcomd run --profile: one agent does the goal; its work is verified, lands on the goal branch, and the goal is ready", async () => {
  const env = { ...w.env, CAPCOMD_SCRIPT_WORKER: `SLEEP=6 FILE=src/solo.txt CONTENT=solo SUMMARY="wrote solo" ${worker}`, PWD: w.dir };
  const r = await capcomd(["run", "write solo", "--profile", "worker", "--json"], env);
  if (r.code !== 0) console.log(r.stdout.slice(-3000), r.stderr.slice(-2000));
  expect(r.code).toBe(0);
  const ls = lines(r.stdout);
  const types = ls.map((l) => l.type);
  expect(types).toEqual(expect.arrayContaining(["run.started", "agent.spawned", "agent.status", "verify.passed", "run.completed", "run.result"]));
  expect(types).not.toContain("planner.spawned");
  // Its statuses as they changed: a wait that ran out (it works for more than one 5 s wait) is never shown as one.
  const statuses = ls.filter((l) => l.type === "agent.status").map((l) => l.status);
  expect(statuses).not.toContain("timeout");
  expect(statuses.at(-1)).toBe("done");
  const runId = ls[0].runId;
  expect(ls[0]).toMatchObject({ type: "run.started", agent: "worker", recipe: "agent" });
  const done = ls.find((l) => l.type === "run.completed");
  expect(done).toMatchObject({ summary: "wrote solo", landed: true, goalBranch: "feat/solo", base: "trunk" });
  // The run's one agent is its root: the worker profile, done, no planner and no children.
  const t = (await w.cj(["tree", runId])).j;
  expect(t.tree.length).toBe(1);
  expect(t.tree[0]).toMatchObject({ agentId: done.agentId, profile: "worker", status: "done" });
  // Its work is on the goal branch, not on the base; the goal is ready for a pull request (a driver's run).
  const filesOn = async (b: string) => { await w.repo.seed.ok(["fetch", "-q", "origin"]); return (await w.repo.seed.ok(["ls-tree", "-r", "--name-only", `origin/${b}`])).split("\n"); };
  expect(await filesOn("feat/solo")).toContain("src/solo.txt");
  expect(await filesOn("trunk")).not.toContain("src/solo.txt");
  const g = (await w.cj(["goal", runId])).j.goal;
  expect(g).toMatchObject({ branch: "feat/solo", base: "trunk", state: "ready" });
  expect(g.landed.map((l: any) => l.agentId)).toEqual([done.agentId]);
}, 180_000);

test("capcomd run --profile, detached as POST /v1/runs starts it; an agent that fails ends the run failed", async () => {
  const env = { ...w.env, CAPCOMD_SCRIPT_WORKER: `EXIT=3 ${worker}`, PWD: w.dir };
  const runId = `run-solo-fail-${Date.now().toString(36)}`;
  const d = await capcomd(["run", "--detach", "--json", "--run-id", runId, "--profile", "worker", "--no-goal-branch", "--", "break it"], env);
  expect(d.code).toBe(0);
  expect(lines(d.stdout).at(-1)).toMatchObject({ runId, detached: true });
  const { client } = await import("../../src/core/relay");
  let ended: any = null;
  for (let i = 0; i < 120 && !ended; i++) {
    await Bun.sleep(500);
    ended = (await client().scope.getOrCreate([runId]).getScope({}).catch(() => null))?.ended ?? null;
  }
  expect(ended).toMatchObject({ state: "failed" });
  expect(String(ended.reason)).toContain("worker failed");
  const t = (await w.cj(["tree", runId])).j;
  expect(t.tree.map((a: any) => [a.profile, a.status])).toEqual([["worker", "failed"]]);
}, 120_000);
