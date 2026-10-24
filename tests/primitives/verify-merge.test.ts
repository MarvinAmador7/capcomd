// ADR-016 step 2: verify (checks run by capcomd, optional judge) + merge --require vfy, with a
// real bare git repo, fake sandbox, fake agent. Only the verified commit can land.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { Git } from "../../src/merge/git";
import { primitivesAgentsFile } from "./helpers";

let PORT = 0;
let engine: Engine;
let env: Record<string, string>;
let r: Awaited<ReturnType<typeof bareRepo>>;
const saved = { ...process.env };

beforeAll(async () => {
  // The repo's own test command fails: merge --require must re-run the checks verify passed with.
  r = await bareRepo({ mode: "direct", test: "exit 7", extraEnv: { CAPCOMD_MERGE_TARGET: "trunk" } });
  await r.seed.ok(["push", "-q", "origin", "main:trunk"]);
  env = { ...r.env, CAPCOMD_AGENTS_FILE: primitivesAgentsFile(), CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_AWAIT_POLL_MS: "100", CAPCOMD_DRIVER_LEASE_MS: "3000", CAPCOMD_SKIP_PREFLIGHT: "1" };
  Object.assign(process.env, env);
  PORT = await testPort();
  engine = new Engine("primitives-vm", { port: PORT, dataDir: mkdtempSync(join(tmpdir(), "capcomd-prim-vm-")) });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${PORT}`;
}, 120_000);
afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};
const CHECK = 'test -f "tasks/$CAPCOMD_TASK_ID.md"';

test("verify + merge --require: gate, exact-commit check, idempotency, events", async () => {
  const runId = (await cj(["run", "new", "--budget", "usd=4,turns=100", "--key", `vm-${Date.now()}`])).j.runId;
  const a = (await cj(["spawn", runId, "--profile", "coder", "--task", "work a", "--key", "a", "--budget", "usd=1,turns=10"])).j.agentId;
  const b = (await cj(["spawn", runId, "--profile", "coder", "--task", "work b", "--key", "b", "--budget", "usd=1,turns=10"])).j.agentId;
  const aw = await cj(["await", runId, a, b, "--timeout-ms", "60000"]);
  expect(aw.code).toBe(0);
  const tipA = aw.j.agents[0].result.commit as string;
  expect(tipA).toMatch(/^[0-9a-f]{40}$/);

  // verify: passing checks record the exact branch commit; failing checks fail
  const va = await cj(["verify", runId, "--ref", a, "--checks", CHECK, "--key", "va"]);
  expect(va.code).toBe(0);
  expect(va.j).toMatchObject({ kind: "verify", state: "passed", branch: `capcomd/${runId}/${a}`, target: "trunk", result: { pass: true, commit: tipA } });
  expect((await cj(["verify", runId, "--ref", a, "--checks", CHECK, "--key", "va"])).j.id).toBe(va.j.id); // idempotent
  const bad = await cj(["verify", runId, "--ref", a, "--checks", "exit 3", "--key", "bad"]);
  expect(bad.code).toBe(1);
  expect(bad.j).toMatchObject({ state: "failed", result: { pass: false, checks: { passed: false } } });
  // The reviewer is a real agent profile: an unknown one is refused before anything runs; a fake-exec
  // reviewer gives no verdict, so the verify fails closed (the judge field mirrors the review).
  const unknown = await cj(["verify", runId, "--ref", a, "--checks", CHECK, "--review-profile", "critic", "--key", "rv-unknown"]);
  expect(unknown.j.error).toMatchObject({ code: "config" });
  expect(unknown.j.error.message).toContain('unknown agent profile "critic"');
  const judged = await cj(["verify", runId, "--ref", a, "--checks", CHECK, "--judge-profile", "coder", "--acceptance", '["tasks file exists"]', "--key", "judged"]);
  expect(judged.j).toMatchObject({ state: "failed", reviewProfile: "coder", result: { pass: false, checks: { passed: true }, review: { profile: "coder", passed: false } } });
  expect(judged.j.result.review.error).toContain("no verdict");
  expect(judged.j.result.judge).toMatchObject({ profile: "coder", passed: false });

  // merge gate
  expect((await cj(["merge", runId, "--ref", a])).code).toBe(2);
  expect((await cj(["merge", runId, "--ref", a, "--require", bad.j.id, "--key", "m-bad"])).j.error.message).toContain("is failed");
  const vb = await cj(["verify", runId, "--ref", b, "--checks", CHECK, "--key", "vb"]);
  expect(vb.j.state).toBe("passed");
  expect((await cj(["merge", runId, "--ref", b, "--require", va.j.id, "--key", "m-cross"])).j.error.message).toContain("covers");

  // branch moved after verify → the merge refuses (checked under the target lock)
  const work = mkdtempSync(join(tmpdir(), "capcomd-move-"));
  await new Git(work).ok(["clone", "-q", "--branch", `capcomd/${runId}/${b}`, r.bare, "."]);
  const g = new Git(work);
  await g.ok(["-c", "user.email=x@y", "-c", "user.name=x", "commit", "-q", "--allow-empty", "-m", "sneaky"]);
  await g.ok(["push", "-q", "origin", `HEAD:capcomd/${runId}/${b}`]);
  const moved = await cj(["merge", runId, "--ref", b, "--require", vb.j.id, "--key", "m-b"]);
  expect(moved.code).toBe(1);
  expect(moved.j.result.reason).toContain("moved since verification");

  // happy path, then idempotent repeat
  const m = await cj(["merge", runId, "--ref", a, "--require", va.j.id, "--key", "m-a"]);
  expect(m.code).toBe(0);
  expect(m.j).toMatchObject({ kind: "merge", state: "merged", target: "trunk", expectSha: tipA, result: { merged: true } });
  const again = await cj(["merge", runId, "--ref", a, "--require", va.j.id, "--key", "m-a"]);
  expect(again.j).toMatchObject({ id: m.j.id, state: "merged" });
  const ls = Bun.spawnSync(["git", "-C", r.bare, "ls-tree", "-r", "--name-only", "trunk"]).stdout.toString();
  expect(ls).toContain(`tasks/${a}.md`);
  expect(ls).not.toContain(`tasks/${b}.md`);
  // verifying it again once it's on the target: passes, as already merged (nothing new to check)
  const after = await cj(["verify", runId, "--ref", a, "--checks", CHECK, "--key", "va-after"]);
  expect(after.j).toMatchObject({ state: "passed", result: { pass: true, alreadyMerged: true, checks: { passed: true, status: "merged" } } });

  const types = (await cj(["events", runId, "--limit", "1000"])).j.events.map((e: any) => e.type);
  for (const t of ["VERIFY_STARTED", "VERIFY_PASSED", "VERIFY_FAILED", "MERGE_STARTED", "MERGED", "MERGE_FAILED"]) expect(types).toContain(t);
}, 180_000);
