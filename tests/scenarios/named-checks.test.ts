// ADR-017: operator-named checks. The repo's own test command is red (like a repo with several
// broken files, each fixed by a different child), so the operator names one check per file at
// `run new --checks-set`. The planner picks a check by name (`verify --check a`); the merge re-runs
// that exact command. A VM-supplied --checks is refused, never run; an unknown name is refused.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "fs";
import { world, spawnRoot, waitAll, types, WORKER, type World } from "./harness";

let w: World;
let worker: string;
beforeAll(async () => { w = await world("named-checks", { CAPCOMD_TEST_COMMAND: "exit 7" }); worker = w.script("worker", WORKER); }, 120_000);
afterAll(async () => { await w?.stop(); });

test("named checks: each child verified on the check it names, merge re-runs it; raw --checks and unknown names refused", async () => {
  const r = await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `named-${Date.now()}`,
    "--checks-set", "a=test -f src/a.txt", "--checks-set", "b=test -f src/b.txt"]);
  expect(r.code).toBe(0);
  const run = r.j.runId as string;
  expect((await w.cj(["kv", "get", run, "_checks"])).j.value).toEqual({ a: "test -f src/a.txt", b: "test -f src/b.txt" });

  const p = w.script("named", `W=${JSON.stringify(worker)}
ids=""
for f in a b; do
  id=$(capcomd spawn --profile worker --task "write $f" --key $f --budget turns=10 --children.maxChildren=0 --contract "$($S/json script="FILE=src/$f.txt CONTENT=$f SPENT=2 $W")" | $S/jget agentId)
  ids="$ids $f:$id"
done
capcomd await $(echo "$ids" | sed 's/[ab]://g') >/dev/null || exit 1
first=$(echo "$ids" | sed 's/^ a://; s/ .*//')
capcomd verify --ref $first --checks "touch /tmp/pwned-${run}" --key sneaky; echo "sneaky rc=$?"
capcomd verify --ref $first --check nope --key unknown; echo "unknown rc=$?"
merged=0
for pair in $ids; do
  f=\${pair%%:*}; id=\${pair#*:}
  v=$(capcomd verify --ref $id --check $f --key v-$id)
  [ "$(echo "$v" | $S/jget result.pass)" = true ] || { echo "verify failed: $v"; continue; }
  echo "recorded $f: $(echo "$v" | $S/jget check) / $(echo "$v" | $S/jget checks)"
  capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m-$id >/dev/null && merged=$((merged+1))
done
capcomd result --summary "merged $merged of 2" >/dev/null
[ $merged = 2 ]`);
  const root = await spawnRoot(w, run, "planner", p);
  const a = (await waitAll(w, run, [root])).agents[0];
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  if (a.status !== "done") console.log(logs);
  expect(a.status).toBe("done");
  expect(a.result.summary).toBe("merged 2 of 2");
  expect(logs).toMatch(/verify → error forbidden: in-VM verify cannot set --checks/);
  expect(logs).toMatch(/no check named "nope".*Known checks: a, b/s);
  expect(logs).toContain("recorded a: a / test -f src/a.txt");
  expect(existsSync(`/tmp/pwned-${run}`)).toBe(false);
  const ty = await types(w, run);
  expect(ty.filter((t) => t === "VERIFY_PASSED").length).toBe(2);
  expect(ty.filter((t) => t === "MERGED").length).toBe(2);
  await w.repo.seed.ok(["fetch", "-q", "origin"]);
  const files = (await w.repo.seed.ok(["ls-tree", "-r", "--name-only", "origin/trunk"])).split("\n");
  expect(files).toEqual(expect.arrayContaining(["src/a.txt", "src/b.txt"]));
}, 120_000);
