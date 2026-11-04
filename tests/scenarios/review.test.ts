// verify's reviewer: an agent profile set per run by the operator (`run new --reviewer P`) reads each
// commit that passed its checks and gives a verdict; both must pass. Fails closed: a reviewer with no
// verdict fails the verify. Reviewers are paid by the caller but exempt from its fan-out limits; an
// in-VM caller can't pick the reviewer. VERIFY_HOLD_MS is tiny, so in-VM verifies poll ("running").
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { world, spawnRoot, waitAll, types, agentsOf, WORKER, type World } from "./harness";
import { capcomd } from "../helpers/engine";

let w: World;
let worker: string;
let repoFile: string;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-reviewer-"));
  const reviewer = join(dir, "reviewer.sh");
  repoFile = join(dir, "repo-path");
  // Scripted reviewer: the brief (its task) carries the child's task; GOOD passes, BAD fails, else no verdict. TREE runs
  // "the tests" (dep.txt and the agent's file present) in the checkout a real reviewer gets: the reviewed commit,
  // merged onto the target commit verify gave it.
  writeFileSync(reviewer, `#!/bin/sh
echo "BRIEF<<$CAPCOMD_TASK>>"
case "$CAPCOMD_TASK" in
  *TREE*)
    git clone -q "$(cat ${JSON.stringify(repoFile)})" "$HOME/rv" && cd "$HOME/rv" && git checkout -q --detach "$CAPCOMD_REVIEW_SHA" || exit 1
    if [ -n "$CAPCOMD_REVIEW_TARGET_SHA" ]; then git -c user.name=t -c user.email=t@example.com merge -q --no-edit "$CAPCOMD_REVIEW_TARGET_SHA" || exit 1; fi
    echo "TREE target=$CAPCOMD_REVIEW_TARGET_SHA"
    if test -f dep.txt && test -f src/tree.txt; then capcomd result --summary "tests pass" --data '{"passed":true,"reasons":["the tests pass"]}' >/dev/null
    else capcomd result --summary "tests fail" --data '{"passed":false,"reasons":["dep.txt is missing: the tests fail"]}' >/dev/null; fi ;;
  *GOOD*) capcomd result --summary "looks right" --data '{"passed":true,"reasons":["does what the task asks"]}' >/dev/null ;;
  *BAD*) capcomd result --summary "wrong" --data '{"passed":false,"reasons":["returns the wrong value"]}' >/dev/null ;;
  *) capcomd result --summary "probably fine, I think" >/dev/null ;;
esac
`);
  chmodSync(reviewer, 0o755);
  w = await world("review", { CAPCOMD_SCRIPT_REVIEWER: `sh ${reviewer}`, CAPCOMD_VERIFY_HOLD_MS: "100" });
  writeFileSync(repoFile, w.repo.bare);
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

test("the reviewer judges the tree the checks test: the change merged onto the target, not the branch alone", async () => {
  // The live false failure (vfy-k1d824c1b7680cd2c): the agent's branch was cut before the target got code its tests
  // need; the checks, on the branch merged with the target, passed; the reviewer, on the branch alone, ran the tests and
  // failed it. Started alongside the checks or after them, it must read the same tree.
  for (const parallel of ["1", "0"]) {
    const r = await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `rv-tree-${parallel}-${Date.now()}`, "--reviewer", "reviewer"]);
    const run = r.j.runId as string;
    const sp = await w.cj(["spawn", run, "--profile", "worker", "--task", "write TREE src/tree.txt", "--key", "tree", "--contract", JSON.stringify({ script: `FILE=src/tree.txt CONTENT=t ${worker}` })]);
    const agt = sp.j.agentId as string;
    expect((await waitAll(w, run, [agt])).agents[0].status).toBe("done");
    // The target gets what the change's tests need after the branch was cut.
    await w.repo.seed.ok(["fetch", "-q", "origin"]);
    await w.repo.seed.ok(["checkout", "-q", "-B", "trunk", "origin/trunk"]);
    writeFileSync(join(w.repo.root, "seed", "dep.txt"), `needed ${parallel}\n`);
    await w.repo.seed.ok(["add", "dep.txt"]);
    await w.repo.seed.ok(["commit", "-q", "-m", "dep"]);
    await w.repo.seed.ok(["push", "-q", "origin", "HEAD:trunk"]);
    const trunk = (await w.repo.sha("refs/heads/trunk"))!;
    const x = await capcomd(["verify", run, "--ref", agt, "--checks", "test -f dep.txt && test -f src/tree.txt", "--key", "tree", "--json"], { ...w.env, PWD: w.dir, CAPCOMD_REVIEW_PARALLEL: parallel });
    const v = { j: JSON.parse(x.stdout.trim().split("\n").pop()!) };
    if (v.j?.result?.pass !== true) console.log(JSON.stringify(v.j, null, 1));
    expect(v.j).toMatchObject({ state: "passed", result: { pass: true, checks: { passed: true }, review: { passed: true }, tested: { targetSha: trunk } } });
    const rv = (await agentsOf(run)).find((x: any) => x.agentId === v.j.result.review.agentId);
    expect(rv.contract.review).toMatchObject({ sha: v.j.result.commit, targetSha: trunk });
    expect((await w.cj(["logs", run, rv.agentId])).j.lines.map((l: any) => l.line).join("\n")).toContain(`TREE target=${trunk}`);
  }
}, 120_000);

test("report mode: a read-only child returns its answer as its result; nothing is pushed", async () => {
  const r = await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `rp-${Date.now()}`]);
  const run = r.j.runId as string;
  const reporter = w.script("reporter", `capcomd result --summary "sum is defined in src/sum.ts:1" >/dev/null`);
  const p = w.script("rp-planner", `
id=$(capcomd spawn --profile worker --task "where is sum defined?" --key q --report --children.maxChildren=0 --contract "$($S/json script=${JSON.stringify(reporter)})" | $S/jget agentId)
capcomd await $id > $HOME/aw.json || exit 1
capcomd result --summary "got: $($S/jget agents.0.result.summary.text < $HOME/aw.json)" >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  const done = (await waitAll(w, run, [root])).agents[0];
  if (done.status !== "done") console.log((await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n"));
  expect(done.status).toBe("done");
  const child = (await agentsOf(run)).find((x: any) => x.parent === root);
  expect(child.contract.report).toBe(true);
  expect(child.result).toMatchObject({ summary: "sum is defined in src/sum.ts:1", branch: null, commit: null });
  expect(done.result.summary).toContain("sum is defined in src/sum.ts:1"); // the parent read it (fenced)
  const refs = Bun.spawnSync(["git", "-C", w.repo.bare, "for-each-ref", "--format=%(refname)", `refs/heads/capcomd/${run}`]).stdout.toString();
  expect(refs).not.toContain(child.agentId); // the reporter pushed nothing (the scripted root's stand-in commit is not this)
}, 120_000);

