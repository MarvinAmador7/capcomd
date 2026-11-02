// Goal branches: a run cut from `dev` (not main) lands each verified child on its goal branch with no approval and no
// pull request per child, even in pr mode; when the planner finishes the run is ready (what landed, what didn't, the
// planner's summary), and the user opens one pull request from the goal branch into `dev` (idempotent), which is
// refused clearly without GitHub. A base nobody named and the remote doesn't report is refused, never taken as main.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "path";
import { world, spawnRoot, waitAll, types, trajectory, WORKER, type World } from "./harness";
import { capcomd } from "../helpers/engine";
import { fakeGitHub } from "../merge/fake-github";
import { rivetSource } from "../../src/api/rivet-source";
import { goalView } from "../../src/primitives/goal";

let w: World;
let gh: ReturnType<typeof fakeGitHub>;
let worker: string;
const GOAL = "capcomd/scn-add-a-and-b";
beforeAll(async () => {
  w = await world("goal", { CAPCOMD_PROTECTED_BRANCHES: "main,trunk", CAPCOMD_MERGE_MODE: "pr", GITHUB_TOKEN: "fake-token" }, {
    envFor: async (repo) => {
      await repo.seed.ok(["push", "-q", "origin", "main:dev"]);
      gh = fakeGitHub(repo.bare);
      return { CAPCOMD_GITHUB_API: gh.url, CAPCOMD_RUNS_INDEX: join(repo.root, "runs.jsonl") };
    },
  });
  worker = w.script("worker", WORKER);
}, 120_000);
afterAll(async () => { await w?.stop(); gh?.stop(); });

const filesOn = async (branch: string) => {
  await w.repo.seed.ok(["fetch", "-q", "origin"]);
  return (await w.repo.seed.ok(["ls-tree", "-r", "--name-only", `origin/${branch}`])).split("\n");
};
const job = (f: string, extra = "") => `$($S/json script="FILE=src/${f}.txt CONTENT=${f} SPENT=2 ${extra} $W")`;
// a and b land; c fails; d's work fails the run's check (it may not add src/d.txt).
const planner = () => w.script("goal-planner", `W=${JSON.stringify(worker)}
for f in a b d; do
  pin=""; [ "$f" = d ] && pin="--check unit"
  id=$(capcomd spawn --profile worker --task "write src/$f.txt" --key $f $pin --budget turns=10 --children.maxChildren=0 --contract "${job("$f")}" | $S/jget agentId)
  capcomd await $id >/dev/null
  v=$(capcomd verify --ref $id --key v-$f)
  if [ "$(echo "$v" | $S/jget state)" = passed ]; then
    m=$(capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m-$f)
    echo "merge $f: $(echo "$m" | $S/jget state)"
  else echo "verify $f: failed"; fi
done
c=$(capcomd spawn --profile worker --task "write src/c.txt" --key c --budget turns=10 --children.maxChildren=0 --contract "${job("c", "EXIT=3")}" | $S/jget agentId)
capcomd await $c >/dev/null
capcomd result --summary "Added a and b. c failed; d broke the check." >/dev/null`);

let run = "";
test("base dev, pr mode: verified children land on the goal branch directly, with no approval and no PR per child", async () => {
  const r = await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `goal-${Date.now()}`, "--goal", "Add a and b", "--goal-branch", GOAL, "--base", "dev", "--checks-set", "unit=test ! -f src/d.txt"]);
  expect(r.code).toBe(0);
  expect(r.j).toMatchObject({ goalBranch: GOAL, base: "dev" });
  run = r.j.runId;
  // The goal branch was cut from dev.
  expect(await w.repo.sha(GOAL)).toBe((await w.repo.sha("dev"))!);
  const root = await spawnRoot(w, run, "planner", planner(), { task: "plan add a and b" });
  expect((await waitAll(w, run, [root])).agents[0].status).toBe("done");
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  expect(logs).toMatch(/merge a: merged/);
  expect(logs).toMatch(/merge b: merged/);
  expect(logs).toMatch(/verify d: failed/);
  const onGoal = await filesOn(GOAL);
  expect(onGoal).toEqual(expect.arrayContaining(["src/a.txt", "src/b.txt"]));
  expect(onGoal).not.toContain("src/d.txt");
  for (const b of ["dev", "main", "trunk"]) expect(await filesOn(b)).not.toContain("src/a.txt");
  // No approval was asked, and GitHub wasn't called for any child (no PR per merge).
  const t = await types(w, run);
  expect(t).not.toContain("MERGE_AWAITING_APPROVAL");
  expect(gh.calls.filter((c) => c.includes("/pulls"))).toEqual([]);
  const merged = (await trajectory(w, run)).filter((e) => e.type === "MERGED");
  expect(merged.map((e) => e.data.mode)).toEqual(["direct", "direct"]);
}, 180_000);

test("the planner's finish makes the run ready: the goal branch against dev, what landed, what didn't, the summary", async () => {
  const evs = await trajectory(w, run);
  const ready = evs.filter((e) => e.type === "RUN_GOAL_COMPLETED");
  expect(ready.length).toBe(1);
  expect(ready[0]!.data).toMatchObject({ branch: GOAL, base: "dev" });
  const v = await goalView(run);
  expect(v).toMatchObject({ branch: GOAL, base: "dev", state: "ready", goal: "Add a and b", summary: "Added a and b. c failed; d broke the check.", pullRequest: null, decision: null });
  expect(v.landed.map((l) => l.task).sort()).toEqual(["write src/a.txt", "write src/b.txt"]);
  expect(v.landed[0]).toMatchObject({ checks: { passed: true }, review: null, mergeId: expect.stringMatching(/^mrg-/), verifyId: expect.stringMatching(/^vfy-/) });
  const why = Object.fromEntries(v.notLanded.map((n) => [n.task, n.reason]));
  expect(why).toEqual({ "write src/c.txt": "failed", "write src/d.txt": "checks_failed" });
  expect(v.compare).toMatchObject({ ahead: 2, behind: 0, error: null, filesTotal: 2 });
  expect(v.compare.files.map((f) => f.path).sort()).toEqual(["src/a.txt", "src/b.txt"]);
  expect(v.openPullRequest).toEqual({ available: true, reason: null, repo: "acme/widgets", confirm: null });
  // The run list carries it, and the lifecycle feed has the ready event.
  const listed = (await rivetSource().runs()).find((r) => r.id === run)!;
  expect(listed.goalBranch).toMatchObject({ branch: GOAL, base: "dev", state: "ready", pullRequest: null });
  expect(Date.parse(listed.goalBranch!.readyAt!)).toBeGreaterThan(0);
  const { lifecycleEvents } = await import("../../src/api/lifecycle");
  const lc = lifecycleEvents(run, await rivetSource().events(run, 0));
  expect(lc.find((e) => e.type === "run.goal_completed")).toMatchObject({ data: { cause: "planner_done", branch: GOAL, base: "dev" } });
}, 60_000);

test("open PR: one pull request from the goal branch into dev, titled with the goal; a second call returns it", async () => {
  const a = await w.cj(["pr", "open", run]);
  expect(a.code).toBe(0);
  expect(a.j).toMatchObject({ created: true, branch: GOAL, base: "dev", pullRequest: { number: 1, state: "open" } });
  expect(gh.pulls.length).toBe(1);
  expect(gh.pulls[0]).toMatchObject({ head: { ref: GOAL }, base: { ref: "dev" }, title: "Add a and b", merged: false });
  expect(gh.pulls[0]!.body).toContain("Added a and b. c failed; d broke the check.");
  expect(gh.pulls[0]!.body).toContain("write src/a.txt");
  expect(gh.pulls[0]!.body).toMatch(/## Not landed[\s\S]*write src\/c\.txt[\s\S]*failed/);
  const b = await w.cj(["pr", "open", run]);
  expect(b.j).toMatchObject({ created: false, pullRequest: { number: 1 } });
  expect(gh.pulls.length).toBe(1);
  // capcomd never merges it, and records it once.
  expect(gh.calls.filter((c) => c.endsWith("/merge"))).toEqual([]);
  expect((await types(w, run)).filter((t) => t === "RUN_PR_OPENED").length).toBe(1);
  const listed = (await rivetSource().runs()).find((r) => r.id === run)!;
  expect(listed.goalBranch).toMatchObject({ state: "pr_opened", pullRequest: { number: 1 } });
  // Keeping the branch once a pull request is open is refused.
  const keep = await w.cj(["goal", "keep", run]);
  expect(keep.code).not.toBe(0);
  expect(keep.j.error).toMatchObject({ code: "conflict" });
}, 60_000);

const goalRun = async (env: Record<string, string>, key: string, o: { end?: string; status?: string } = {}) => {
  const x = await capcomd(["run", "new", "--budget", "usd=5,turns=100,wallSeconds=600", "--key", key, "--goal", "Add e", "--goal-branch", `capcomd/scn-${key}`, "--base", "dev", "--json"], { ...w.env, ...env, PWD: w.dir });
  const j = JSON.parse(x.stdout.trim().split("\n").pop()!);
  expect(j.ok).toBe(true);
  const id = j.runId as string;
  const root = await spawnRoot(w, id, "planner", w.script(`p-${key}`, `W=${JSON.stringify(worker)}
id=$(capcomd spawn --profile worker --task "write src/e.txt" --key e --budget turns=10 --children.maxChildren=0 --contract "${job("e")}" | $S/jget agentId)
capcomd await $id >/dev/null; v=$(capcomd verify --ref $id --key v); capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m >/dev/null
${o.end ?? 'capcomd result --summary "Added e." >/dev/null'}`));
  expect((await waitAll(w, id, [root])).agents[0].status).toBe(o.status ?? "done");
  return id;
};
const prOpen = async (id: string, env: Record<string, string>) => {
  const x = await capcomd(["pr", "open", id, "--json"], { ...w.env, ...env, PWD: w.dir });
  return { code: x.code, j: JSON.parse(x.stdout.trim().split("\n").pop()!) };
};

test("open PR is refused clearly for a repository that isn't on GitHub, and without a GitHub login", async () => {
  const before = gh.pulls.length;
  // Not on GitHub: the run records no GitHub repository.
  const notGh = await goalRun({ CAPCOMD_GITHUB_REPO: "" }, `nogh-${Date.now()}`);
  expect((await goalView(notGh)).openPullRequest).toMatchObject({ available: false, repo: null, reason: expect.stringContaining("isn't on GitHub") });
  const a = await prOpen(notGh, {});
  expect(a.code).not.toBe(0);
  expect(a.j.error).toMatchObject({ code: "conflict", reason: "github" });
  expect(a.j.error.message).toContain(`capcomd/scn-nogh-`); // the branch name, to push or merge by hand
  // On GitHub, but no login on this machine (no token, no gh).
  const noLogin = await goalRun({}, `nologin-${Date.now()}`);
  const b = await prOpen(noLogin, { GITHUB_TOKEN: "", GH_TOKEN: "", CAPCOMD_GH_CLI: "/nonexistent/gh" });
  expect(b.code).not.toBe(0);
  expect(b.j.error.message).toContain("gh auth login");
  expect(gh.pulls.length).toBe(before);
  // With the login it opens, into dev.
  const c = await prOpen(noLogin, {});
  expect(c.j).toMatchObject({ created: true, base: "dev" });
  expect(gh.pulls.at(-1)!.base.ref).toBe("dev");
}, 240_000);

test("a planner that failed after landing work: the person is asked first; with their yes the PR says the run stopped", async () => {
  const before = gh.pulls.length;
  const id = await goalRun({}, `stop-${Date.now()}`, { end: "exit 3", status: "failed" });
  const v = await goalView(id);
  expect(v.state).toBe("stopped");
  expect(v.openPullRequest).toMatchObject({ available: true, confirm: expect.stringMatching(/^The planner stopped before it finished \(it failed\): 1 of 1 task landed on capcomd\/scn-stop-.*\. Open a pull request with what landed\?$/) });
  // Without a terminal and without --yes: refused with that question, nothing opened.
  const a = await prOpen(id, {});
  expect(a.code).not.toBe(0);
  expect(a.j.error).toMatchObject({ code: "conflict", reason: "stopped", message: v.openPullRequest.confirm });
  expect(gh.pulls.length).toBe(before);
  // --yes: opened, and its description says first that the run stopped.
  const x = await capcomd(["pr", "open", id, "--yes", "--json"], { ...w.env, PWD: w.dir });
  expect(JSON.parse(x.stdout.trim().split("\n").pop()!)).toMatchObject({ created: true, base: "dev" });
  expect(gh.pulls.at(-1)!.body.split("\n")[0]).toBe("> **The run stopped before the planner finished:** the planner failed. 1 of 1 task landed.");
}, 120_000);

test("no base given, no project target, no default branch on the remote: refused, never main", async () => {
  // The remote's HEAD points nowhere, so it reports no default branch.
  const bare = w.repo.bare;
  const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: bare });
  g(["symbolic-ref", "HEAD", "refs/heads/nothing-here"]);
  try {
    const env = { ...w.env, CAPCOMD_MERGE_TARGET: "", PWD: w.dir };
    const x = await capcomd(["run", "Do something", "--planner", "planner", "--json"], env);
    const j = JSON.parse(x.stdout.trim().split("\n").pop()!);
    expect(j.ok).toBe(false);
    expect(j.error).toMatchObject({ code: "usage", reason: "base" });
    expect(j.error.message).toContain("can't tell which branch");
    // run new names both or neither.
    const y = await capcomd(["run", "new", "--goal-branch", "capcomd/x", "--json"], env);
    expect(JSON.parse(y.stdout.trim().split("\n").pop()!).error).toMatchObject({ code: "usage", reason: "base" });
    // No goal branch was cut from main (or anything) by those calls.
    expect((await w.repo.seed.ok(["ls-remote", "--heads", "origin"])).split("\n").filter((l) => l.includes("refs/heads/capcomd/do-something"))).toEqual([]);
  } finally { g(["symbolic-ref", "HEAD", "refs/heads/main"]); }
}, 60_000);
