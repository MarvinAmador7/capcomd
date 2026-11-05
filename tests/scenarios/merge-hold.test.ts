// Plugin API §6.6.15, the step 2 follow-ups: a plugin's `hold` at merge.landing parks the merge for a person (parkOp),
// nothing lands and the verifier's record waits (a held outcome isn't final); approving that hold lands it, and the
// re-fired merge.landing is a new attempt with its own idempotency key. A person's deny settles the verifier's record.
// An approval of something else (a protected target's) never satisfies a plugin's hold: the person is asked again,
// shown the plugin's reason. The approval shows the files the merge changes, as a protected target's does. A hold the
// plugin names (holdId) is satisfied across calls whose reason differs; an unnamed one only by the same reason. The
// daemon carries test-holder (holds every merge; into hold-varies… its reason counts its calls, and into
// hold-varies-named it names the hold) and hook-recorder (allows everything, writes each call's idempotency key to a file).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { world, waitAll, trajectory, spawnRoot, WORKER, type World } from "./harness";
import type { Recorded } from "../plugins/fixtures/hook-recorder/index";

const FIXTURES = join(import.meta.dir, "..", "plugins", "fixtures");
const HOLD = "the test holder wants a person to look";
let w: World;
let worker: string;
let logDir: string | undefined;
let log: string;
beforeAll(async () => {
  logDir = mkdtempSync(join(tmpdir(), "capcomd-merge-hold-"));
  log = join(logDir, "hooks.ndjson");
  w = await world("merge-hold", { CAPCOMD_TEST_PLUGINS: `${join(FIXTURES, "hook-recorder")}:${join(FIXTURES, "test-holder")}`, CAPCOMD_TEST_HOOK_LOG: log, NODE_ENV: "test" });
  worker = w.script("worker", WORKER);
  // The engine answers a little before the daemon has loaded its plugins (daemon.started).
  for (let i = 0; i < 300 && !calls().some((c) => c.hook === "daemon.started"); i++) await sleep(100);
}, 120_000);
afterAll(async () => {
  try { await w?.stop(); } finally { if (logDir) rmSync(logDir, { recursive: true, force: true }); }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const calls = (): Recorded[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Recorded) : []);
const landingKeys = (mrg: string) => calls().filter((c) => c.hook === "merge.landing" && c.subject === mrg).map((c) => c.key);
const filesOn = async (branch: string) => {
  await w.repo.seed.ok(["fetch", "-q", "origin"]);
  return (await w.repo.seed.ok(["ls-tree", "-r", "--name-only", `origin/${branch}`])).split("\n");
};
const verifierState = async (run: string, mrg: string) => {
  const { client } = await import("../../src/core/relay");
  return ((await client().verifier.getOrCreate([run, mrg]).getVerifier({ verifierId: mrg })) as { state: string } | null)?.state ?? null;
};
const approvals = async (run: string) => (await import("../../src/api/rivet-source")).rivetSource().approvals(run);
const newRun = async (key: string, ...args: string[]) => (await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `${key}-${Date.now()}`, ...args])).j.runId as string;

async function spawnDone(run: string, key: string) {
  const sp = await w.cj(["spawn", run, "--profile", "worker", "--task", `write ${key}`, "--key", key, "--contract", JSON.stringify({ script: `FILE=src/${key}.txt CONTENT=${key} ${worker}` })]);
  const id = sp.j.agentId as string;
  expect((await waitAll(w, run, [id])).agents[0].status).toBe("done");
  return id;
}
async function heldMerge(run: string, key: string) {
  const id = await spawnDone(run, key);
  const v = (await w.cj(["verify", run, "--ref", id, "--checks", `test -f src/${key}.txt`, "--key", `v-${key}`])).j;
  expect(v.state).toBe("passed");
  return (await w.cj(["merge", run, "--ref", id, "--require", v.id, "--key", `m-${key}`])).j;
}

test("a plugin's hold parks the merge, shown to the approver; approving that hold lands it, as a new attempt", async () => {
  const run = await newRun("hold");
  const m = await heldMerge(run, "a");
  // Parked for a person, with the plugin and its reason on the record; nothing landed; the verifier's record waits.
  expect(m).toMatchObject({ state: "awaiting_approval", heldBy: { plugin: "test-holder", reason: HOLD } });
  expect(await filesOn("trunk")).not.toContain("src/a.txt");
  expect(await verifierState(run, m.id)).toBe("verifying");
  // The approval the person decides on says which plugin held it and why.
  const [ap] = await approvals(run);
  expect(ap!.question).toBe(`Merge this agent's work into trunk? The test-holder plugin held it: ${HOLD}`);
  expect(ap!.subject).toMatchObject({ target: "trunk", heldBy: { plugin: "test-holder", reason: HOLD } });
  // …and what lands: the files the merge changes, on the approval, the park event and the merge's record.
  const files = { files: [expect.objectContaining({ path: "src/a.txt", status: "added", added: 1 })], filesTotal: 1, added: 1, removed: 0 };
  expect(ap!.subject).toMatchObject(files);
  expect(m.diff).toMatchObject(files);
  const parked = (await trajectory(w, run)).filter((e) => e.type === "MERGE_AWAITING_APPROVAL");
  expect(parked.map((e) => e.data.heldBy)).toEqual([{ plugin: "test-holder", reason: HOLD }]);
  expect(parked[0]!.data.diff).toMatchObject(files);
  expect(landingKeys(m.id)).toEqual([`merge.landing:${m.id}:1`]);

  // Approved: merge.landing is asked again, a new attempt with its own key; the same hold now lets it land.
  const ok = (await w.cj(["approve", run, m.id])).j;
  expect(ok).toMatchObject({ state: "merged", result: { merged: true } });
  expect(await filesOn("trunk")).toContain("src/a.txt");
  expect(await verifierState(run, m.id)).toBe("passed");
  expect(landingKeys(m.id)).toEqual([`merge.landing:${m.id}:1`, `merge.landing:${m.id}:2`]);
  expect(await approvals(run)).toEqual([]);
}, 180_000);

test("a person denying a merge a plugin held ends the verifier's record as failed, not in flight", async () => {
  const run = await newRun("deny");
  const m = await heldMerge(run, "b");
  expect(m).toMatchObject({ state: "awaiting_approval", heldBy: { plugin: "test-holder" } });
  expect(await verifierState(run, m.id)).toBe("verifying");
  const no = (await w.cj(["approve", run, m.id, "--deny", "--reason", "not this one"])).j;
  expect(no).toMatchObject({ state: "failed", result: { status: "denied" } });
  expect(await verifierState(run, m.id)).toBe("failed");
  expect(await filesOn("trunk")).not.toContain("src/b.txt");
  expect(landingKeys(m.id)).toEqual([`merge.landing:${m.id}:1`]);
}, 180_000);

test("approving a protected target doesn't satisfy a plugin's hold: the person is asked again, shown its reason", async () => {
  // main is protected (the default patterns): an agent's merge into it is parked for a person first.
  const run = await newRun("protected", "--target", "main");
  const planner = w.script("planner", `W=${JSON.stringify(worker)}
id=$(capcomd spawn --profile worker --task "write c" --key c --budget turns=10 --children.maxChildren=0 --contract "$($S/json script="FILE=src/c.txt CONTENT=c $W")" | $S/jget agentId)
capcomd await $id >/dev/null || exit 1
v=$(capcomd verify --ref $id --key v-c)
m=$(capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m-c)
echo "merge c: $(echo "$m" | $S/jget state) $(echo "$m" | $S/jget id)"
capcomd result --summary done >/dev/null`);
  const root = await spawnRoot(w, run, "planner", planner);
  expect((await waitAll(w, run, [root])).agents[0].status).toBe("done");
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  const mrg = /merge c: awaiting_approval (mrg-\S+)/.exec(logs)?.[1];
  if (!mrg) console.log(logs);
  expect(mrg).toBeDefined();
  // The protected target's approval: no plugin asked yet.
  const [first] = await approvals(run);
  expect(first!.question).toBe("Merge this agent's work into main?");
  expect(first!.subject.heldBy).toBeUndefined();
  expect(landingKeys(mrg!)).toEqual([]);

  // The person approves the protected target; the plugin then holds it: it waits again, now for that hold.
  const again = (await w.cj(["approve", run, mrg!])).j;
  expect(again).toMatchObject({ state: "awaiting_approval", heldBy: { plugin: "test-holder", reason: HOLD } });
  expect(await filesOn("main")).not.toContain("src/c.txt");
  const [second] = await approvals(run);
  expect(second!.question).toBe(`Merge this agent's work into main? The test-holder plugin held it: ${HOLD}`);
  expect(second!.subject.heldBy).toEqual({ plugin: "test-holder", reason: HOLD });
  // The files the protected target's park read are still on the approval of the plugin's hold.
  expect(first!.subject.files).toEqual([expect.objectContaining({ path: "src/c.txt" })]);
  expect(second!.subject).toMatchObject({ files: first!.subject.files, filesTotal: 1 });
  // Each park and each approval is its own event, so a client folding the stream sees it pending again.
  let evs = await trajectory(w, run);
  expect(evs.filter((e) => e.type === "MERGE_AWAITING_APPROVAL").map((e) => e.data.heldBy ?? null)).toEqual([null, { plugin: "test-holder", reason: HOLD }]);
  expect(evs.filter((e) => e.type === "MERGE_APPROVED").length).toBe(1);

  // Approving the plugin's hold lands it: the second landing is a new attempt.
  const ok = (await w.cj(["approve", run, mrg!])).j;
  expect(ok).toMatchObject({ state: "merged", result: { merged: true } });
  expect(await filesOn("main")).toContain("src/c.txt");
  expect(landingKeys(mrg!)).toEqual([`merge.landing:${mrg}:1`, `merge.landing:${mrg}:2`]);
  evs = await trajectory(w, run);
  expect(evs.filter((e) => e.type === "MERGE_APPROVED").length).toBe(2);
}, 180_000);

test("a hold the plugin names is satisfied by one approval, though its reason changes on every call", async () => {
  await w.repo.seed.ok(["push", "-q", "origin", "main:hold-varies-named"]);
  const run = await newRun("named", "--target", "hold-varies-named");
  const m = await heldMerge(run, "d");
  expect(m).toMatchObject({ state: "awaiting_approval", heldBy: { plugin: "test-holder", holdId: "look-once", reason: expect.stringMatching(/^the test holder wants a person to look \(call \d+\)$/) } });
  const [ap] = await approvals(run);
  expect(ap!.subject.heldBy).toEqual(m.heldBy);
  expect(ap!.subject.files).toEqual([expect.objectContaining({ path: "src/d.txt" })]);
  // Asked again, the plugin gives another reason but the same holdId: the person's approval lands it.
  const ok = (await w.cj(["approve", run, m.id])).j;
  expect(ok).toMatchObject({ state: "merged", result: { merged: true } });
  expect(await filesOn("hold-varies-named")).toContain("src/d.txt");
  expect(landingKeys(m.id)).toEqual([`merge.landing:${m.id}:1`, `merge.landing:${m.id}:2`]);
  expect(await approvals(run)).toEqual([]);
}, 180_000);

test("an unnamed hold whose reason changes asks the person again: without a holdId the reason identifies it", async () => {
  await w.repo.seed.ok(["push", "-q", "origin", "main:hold-varies"]);
  const run = await newRun("unnamed", "--target", "hold-varies");
  const m = await heldMerge(run, "e");
  expect(m).toMatchObject({ state: "awaiting_approval", heldBy: { plugin: "test-holder" } });
  expect(m.heldBy.holdId).toBeUndefined();
  const again = (await w.cj(["approve", run, m.id])).j;
  expect(again).toMatchObject({ state: "awaiting_approval", heldBy: { plugin: "test-holder" } });
  expect(again.heldBy.reason).not.toBe(m.heldBy.reason);
  // Still waiting, with the files read at the first park, and nothing landed.
  const [ap] = await approvals(run);
  expect(ap!.subject).toMatchObject({ heldBy: again.heldBy, files: [expect.objectContaining({ path: "src/e.txt" })] });
  expect(await filesOn("hold-varies")).not.toContain("src/e.txt");
  const no = (await w.cj(["approve", run, m.id, "--deny", "--reason", "enough"])).j;
  expect(no).toMatchObject({ state: "failed", result: { status: "denied" } });
}, 180_000);
