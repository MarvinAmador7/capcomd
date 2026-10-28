// Agents and protected targets: an in-VM merge into a protected branch is parked (awaiting_approval),
// not refused; the operator approves (it lands, same gate) or denies it. A per-run staging target
// (`run new --target T --target-from BASE`) is created on demand; children branch from it and land on it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { world, spawnRoot, waitAll, types, inOrder, trajectory, agentsOf, WORKER, type World } from "./harness";
import { rivetSource } from "../../src/api/rivet-source";
import { approvalIdFor } from "../../src/api/source";

let w: World;
let worker: string;
beforeAll(async () => { w = await world("approvals", { CAPCOMD_PROTECTED_BRANCHES: "trunk" }); worker = w.script("worker", WORKER); }, 120_000);
afterAll(async () => { await w?.stop(); });

const filesOn = async (branch: string) => {
  await w.repo.seed.ok(["fetch", "-q", "origin"]);
  return (await w.repo.seed.ok(["ls-tree", "-r", "--name-only", `origin/${branch}`])).split("\n");
};
const plannerFor = (files: string[]) => w.script(`ap-${files.join("-")}`, `W=${JSON.stringify(worker)}
for f in ${files.join(" ")}; do
  id=$(capcomd spawn --profile worker --task "write $f" --key $f --budget turns=10 --children.maxChildren=0 --contract "$($S/json script="FILE=src/$f.txt CONTENT=$f SPENT=2 $W")" | $S/jget agentId)
  capcomd await $id >/dev/null || exit 1
  v=$(capcomd verify --ref $id --key v-$f)
  m=$(capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m-$f)
  echo "merge $f: $(echo "$m" | $S/jget state) $(echo "$m" | $S/jget id)"
  again=$(capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m-$f)
  echo "again $f: $(echo "$again" | $S/jget state)"
  capcomd kv put "mrg-$f" "$($S/json id=$(echo "$m" | $S/jget id))" >/dev/null
done
capcomd result --summary done >/dev/null`);
const logsOf = async (run: string, id: string) => (await w.cj(["logs", run, id])).j.lines.map((l: any) => l.line).join("\n");

test("per-run staging target: created from trunk, children branch from it and land on it, trunk untouched", async () => {
  const r = await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `st-${Date.now()}`, "--target", "staging", "--target-from", "trunk"]);
  expect(r.code).toBe(0);
  const run = r.j.runId as string;
  const root = await spawnRoot(w, run, "planner", plannerFor(["s"]));
  expect((await waitAll(w, run, [root])).agents[0].status).toBe("done");
  const logs = await logsOf(run, root);
  expect(logs).toMatch(/merge s: merged /);
  expect(await filesOn("staging")).toContain("src/s.txt");
  expect(await filesOn("trunk")).not.toContain("src/s.txt");
}, 120_000);

test("protected target: the agent's merge is parked; approve lands it, deny fails it; both idempotent", async () => {
  const run = (await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `ap-${Date.now()}`])).j.runId as string;
  // An operator merge without --operator is still refused (unchanged); only agents' merges are parked.
  const root = await spawnRoot(w, run, "planner", plannerFor(["a", "b"]));
  expect((await waitAll(w, run, [root])).agents[0].status).toBe("done");
  const logs = await logsOf(run, root);
  expect(logs).toMatch(/merge a: awaiting_approval mrg-/);
  expect(logs).toContain("again a: awaiting_approval"); // the same key just reports the state
  const ma = (await w.cj(["kv", "get", run, "mrg-a"])).j.value.id as string;
  const mb = (await w.cj(["kv", "get", run, "mrg-b"])).j.value.id as string;
  const st = (await w.cj(["status", run])).j.run;
  expect(st.pendingApprovals.map((p: any) => p.taskId).sort()).toEqual([ma, mb].sort());
  expect(st.pendingApprovals[0]).toMatchObject({ kind: "merge", targetBranch: "trunk" });
  expect(await filesOn("trunk")).not.toContain("src/a.txt");
  // Each parked merge carries the files its branch changes (the approval card's subject.files), read when it was parked.
  const parked = (await trajectory(w, run)).filter((e: any) => e.type === "MERGE_AWAITING_APPROVAL");
  const parkA = parked.find((e: any) => e.data.id === ma)!;
  expect(parkA.data.diff).toMatchObject({ filesTotal: 1, removed: 0, files: [{ path: "src/a.txt", status: "added", removed: 0 }] });
  expect(parkA.data.diff.added).toBeGreaterThan(0);
  const pending = await rivetSource().approvals(run);
  const apA = pending.find((p) => p.approvalId === approvalIdFor(run, ma))!;
  expect(apA.subject).toMatchObject({ target: "trunk", filesTotal: 1, files: [{ path: "src/a.txt" }] });
  expect(Date.parse(apA.requestedAt!)).toBeGreaterThan(0);

  const ok = await w.cj(["approve", run, ma, "--by", "reviewer@ops"]);
  expect(ok.code).toBe(0);
  expect(ok.j).toMatchObject({ id: ma, state: "merged", result: { merged: true } });
  expect(await filesOn("trunk")).toContain("src/a.txt");
  expect((await w.cj(["approve", run, ma])).j).toMatchObject({ state: "merged" }); // idempotent

  const no = await w.cj(["approve", run, mb, "--deny", "--reason", "not this release"]);
  expect(no.code).toBe(0);
  expect(no.j).toMatchObject({ id: mb, state: "failed", result: { merged: false, status: "denied", reason: "not this release" } });
  expect((await w.cj(["approve", run, mb])).j).toMatchObject({ state: "failed" }); // decided stays decided
  expect(await filesOn("trunk")).not.toContain("src/b.txt");
  expect((await w.cj(["status", run])).j.run.pendingApprovals).toEqual([]);
  expect(inOrder(await types(w, run), ["MERGE_AWAITING_APPROVAL", "MERGE_AWAITING_APPROVAL", "MERGE_APPROVED", "MERGED", "MERGE_DENIED"])).toBe(true);
  // The workers' results say how their merges ended (the app's finished card reads "Merged into trunk").
  const byMerge = Object.fromEntries((await agentsOf(run)).filter((a: any) => a.result?.merge).map((a: any) => [a.result.merge.id, a.result.merge]));
  expect(byMerge[ma]).toMatchObject({ target: "trunk", state: "merged", sha: expect.any(String) });
  expect(byMerge[mb]).toMatchObject({ target: "trunk", state: "denied" });
}, 120_000);
