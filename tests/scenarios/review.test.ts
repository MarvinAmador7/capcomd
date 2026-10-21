// verify's reviewer: an agent profile set per run by the operator (`run new --reviewer P`) reads each
// commit that passed its checks and gives a verdict; both must pass. Fails closed: a reviewer with no
// verdict fails the verify. Reviewers are paid by the caller but exempt from its fan-out limits; an
// in-VM caller can't pick the reviewer. VERIFY_HOLD_MS is tiny, so in-VM verifies poll ("running").
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { world, spawnRoot, waitAll, types, agentsOf, WORKER, type World } from "./harness";

let w: World;
let worker: string;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-reviewer-"));
  const reviewer = join(dir, "reviewer.sh");
  // Scripted reviewer: the brief (its task) carries the child's task; GOOD passes, BAD fails, else no verdict.
  writeFileSync(reviewer, `#!/bin/sh
echo "BRIEF<<$CAPCOMD_TASK>>"
case "$CAPCOMD_TASK" in
  *GOOD*) capcomd result --summary "looks right" --data '{"passed":true,"reasons":["does what the task asks"]}' >/dev/null ;;
  *BAD*) capcomd result --summary "wrong" --data '{"passed":false,"reasons":["returns the wrong value"]}' >/dev/null ;;
  *) capcomd result --summary "probably fine, I think" >/dev/null ;;
esac
`);
  chmodSync(reviewer, 0o755);
  w = await world("review", { CAPCOMD_SCRIPT_REVIEWER: `sh ${reviewer}`, CAPCOMD_VERIFY_HOLD_MS: "100" });
  worker = w.script("worker", WORKER);
}, 120_000);
afterAll(async () => { await w?.stop(); });

test("reviewer: verdicts gate merges (pass, fail, no verdict = fail), exempt from fan-out, chosen by the operator only", async () => {
  expect((await w.cj(["run", "new", "--budget", "usd=10,turns=400", "--key", `rv-bad-${Date.now()}`, "--reviewer", "nope"])).code).not.toBe(0);
  const r = await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `rv-${Date.now()}`, "--checks-set", "ok=test -d src", "--reviewer", "reviewer"]);
  expect(r.code).toBe(0);
  const run = r.j.runId as string;

  const p = w.script("rv-planner", `W=${JSON.stringify(worker)}
spawn() { capcomd spawn --profile worker --task "write $2 $1" --key $1 --budget turns=10 --children.maxChildren=0 --check ok --contract "$($S/json script="FILE=src/$1.txt CONTENT=$1 SPENT=2 $W")" | $S/jget agentId; }
a=$(spawn a GOOD); b=$(spawn b BAD); c=$(spawn c GARBLE)
capcomd await $a $b $c >/dev/null || exit 1
capcomd verify --ref $a --review-profile lenient --key sneaky; echo "sneaky rc=$?"
for pair in a:$a b:$b c:$c; do
  n=\${pair%%:*}; id=\${pair#*:}
  v=$(capcomd verify --ref $id --acceptance '["the file src/'$n'.txt exists"]' --key v-$n)
  echo "verdict $n: pass=$(echo "$v" | $S/jget result.pass) review=$(echo "$v" | $S/jget result.review.passed) err=$(echo "$v" | $S/jget result.review.error)"
  if [ "$(echo "$v" | $S/jget result.pass)" = true ]; then capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" >/dev/null && echo "merged $n"; fi
done
capcomd kv put ids "$($S/json b=$b)" >/dev/null
capcomd result --summary done >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  const done = (await waitAll(w, run, [root], 120_000)).agents[0];
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  expect(logs).toContain("verdict a: pass=true review=true");
  expect(logs).toContain("verdict b: pass=false review=false");
  expect(logs).toMatch(/verdict c: pass=false review=false err=the reviewer gave no verdict/);
  expect(logs).toContain("merged a");
  expect(logs).not.toContain("merged b");
  expect(logs).not.toContain("merged c");
  expect(logs).toMatch(/verify → error forbidden: in-VM verify cannot choose a reviewer/);
  expect((logs.match(/verify → ok/g) ?? []).length).toBeGreaterThan(3); // polled while the review ran

  // Reviewers: one per verified child, under the caller (paid from its budget), although the planner's
  // allowedChildProfiles doesn't list "reviewer" (exempt from fan-out); the brief carries criteria + task.
  const all = await agentsOf(run);
  const reviewers = all.filter((x: any) => x.profile === "reviewer");
  expect(reviewers.length).toBe(3);
  for (const rv of reviewers) expect(rv.parent).toBe(root);
  expect((await types(w, run)).filter((t) => t === "AGENT_SPAWNED").length).toBe(7); // planner + 3 + 3
  const goodReviewer = reviewers.find((x: any) => /write GOOD a/.test(x.task))!;
  expect(goodReviewer.task).toContain("Acceptance criteria:");
  expect(goodReviewer.task).toContain("the file src/a.txt exists");
  expect(goodReviewer.result.verdict).toEqual({ passed: true, reasons: ["does what the task asks"] });

  await w.repo.seed.ok(["fetch", "-q", "origin"]);
  const files = (await w.repo.seed.ok(["ls-tree", "-r", "--name-only", "origin/trunk"])).split("\n");
  expect(files).toContain("src/a.txt");
  expect(files).not.toContain("src/b.txt");

  // The operator's verify reviews too (reviewer at the top level, paid by the run), and may override the profile.
  const b = (await w.cj(["kv", "get", run, "ids"])).j.value.b as string;
  const ov = await w.cj(["verify", run, "--ref", b, "--key", "op-review"]);
  expect(ov.j).toMatchObject({ state: "failed", reviewProfile: "reviewer", result: { pass: false, checks: { passed: true }, review: { passed: false, reasons: ["returns the wrong value"] } } });
  const opReviewer = (await agentsOf(run)).find((x: any) => x.agentId === ov.j.result.review.agentId);
  expect(opReviewer.parent).toBeNull();
  expect(ov.j.result.judge).toMatchObject({ profile: "reviewer", passed: false }); // old --judge-profile contract
}, 180_000);
