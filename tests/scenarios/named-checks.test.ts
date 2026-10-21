// ADR-017: operator-named checks, pinned per child. The repo's own test command is red (like a repo
// with several broken files, each fixed by a different child), so the operator names one check per
// file at `run new --checks-set` and the planner pins one to each child at spawn (`--check a`).
// verify runs the pinned check and the merge re-runs that exact command. Refused: unknown names
// (at spawn), switching a pinned child to another check, --check on an unpinned child, raw --checks.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "fs";
import { world, spawnRoot, waitAll, types, WORKER, type World } from "./harness";

let w: World;
let worker: string;
beforeAll(async () => { w = await world("named-checks", { CAPCOMD_TEST_COMMAND: "exit 7" }); worker = w.script("worker", WORKER); }, 120_000);
afterAll(async () => { await w?.stop(); });

test("named checks pinned at spawn: verify runs the pin, merge re-runs it; swaps, unpinned --check, raw --checks refused", async () => {
  const r = await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `named-${Date.now()}`,
    "--checks-set", "a=test -f src/a.txt", "--checks-set", "b=test -f src/b.txt"]);
  expect(r.code).toBe(0);
  const run = r.j.runId as string;
  expect((await w.cj(["kv", "get", run, "_checks"])).j.value).toEqual({ a: "test -f src/a.txt", b: "test -f src/b.txt" });

  const p = w.script("named", `W=${JSON.stringify(worker)}
spawn() { capcomd spawn --profile worker --task "write $1" --key $1 --budget turns=10 --children.maxChildren=0 $2 --contract "$($S/json script="FILE=src/$1.txt CONTENT=$1 SPENT=2 $W")"; }
capcomd spawn --profile worker --task bogus --key bogus --check nope; echo "bogus-spawn rc=$?"
a=$(spawn a "--check a" | $S/jget agentId)
b=$(spawn b "--check b" | $S/jget agentId)
c=$(spawn c "" | $S/jget agentId)
capcomd await $a $b $c >/dev/null || exit 1
capcomd verify --ref $a --check b --key swap; echo "swap rc=$?"
capcomd verify --ref $c --check a --key unpinned; echo "unpinned rc=$?"
capcomd verify --ref $a --checks "touch /tmp/pwned-${run}" --key sneaky; echo "sneaky rc=$?"
merged=0
for id in $a $b; do
  v=$(capcomd verify --ref $id --key v-$id)
  [ "$(echo "$v" | $S/jget result.pass)" = true ] || { echo "verify failed: $v"; continue; }
  echo "recorded $id: $(echo "$v" | $S/jget check) / $(echo "$v" | $S/jget checks)"
  capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m-$id >/dev/null && merged=$((merged+1))
done
capcomd kv put pinned "$($S/json a=$a)" >/dev/null
capcomd result --summary "merged $merged of 2" >/dev/null
[ $merged = 2 ]`);
  const root = await spawnRoot(w, run, "planner", p);
  const done = (await waitAll(w, run, [root])).agents[0];
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  expect(done.result.summary).toBe("merged 2 of 2");
  expect(logs).toMatch(/no check named "nope".*Known checks: a, b/s);
  expect(logs).toMatch(/verify → error forbidden: agt-\S+ was pinned to check "a" at spawn; it can't be verified with "b"/);
  expect(logs).toMatch(/verify → error forbidden: agt-\S+ has no pinned check; named checks are pinned at spawn/);
  expect(logs).toMatch(/verify → error forbidden: in-VM verify cannot set --checks/);
  expect(logs).toMatch(/recorded agt-\S+: a \/ test -f src\/a\.txt/);
  expect(existsSync(`/tmp/pwned-${run}`)).toBe(false);
  const ty = await types(w, run);
  expect(ty.filter((t) => t === "VERIFY_PASSED").length).toBe(2);
  expect(ty.filter((t) => t === "MERGED").length).toBe(2);
  await w.repo.seed.ok(["fetch", "-q", "origin"]);
  const files = (await w.repo.seed.ok(["ls-tree", "-r", "--name-only", "origin/trunk"])).split("\n");
  expect(files).toEqual(expect.arrayContaining(["src/a.txt", "src/b.txt"]));
  expect(files).not.toContain("src/c.txt");

  // The operator's verify defaults to the pin too, and may override it (the operator is trusted).
  // (The branch has landed by now, so these report "merged"; what matters is the check recorded.)
  const a = (await w.cj(["kv", "get", run, "pinned"])).j.value.a as string;
  expect((await w.cj(["verify", run, "--ref", a, "--key", "op-default"])).j).toMatchObject({ check: "a", checks: "test -f src/a.txt" });
  expect((await w.cj(["verify", run, "--ref", a, "--check", "b", "--key", "op-override"])).j).toMatchObject({ check: "b", checks: "test -f src/b.txt" });
}, 120_000);
