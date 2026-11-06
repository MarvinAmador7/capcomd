// Proposals to a company's brain, end to end (ADR-025 step 5). The run is started with the project's brain mapping
// (kv `_context`, as `run new` records it), a worker proposes a lesson, and the run's consolidator (scripted: what a
// model would answer) gives a change for the project's memory and a new fact for the brain its profile names. The
// kernel stages the memory change on its branch and keeps the fact for groundray (the fake CLI,
// tests/plugins/fixtures/fake-groundray.ts; never the real one):
//  - under `review: human` (the default) it waits for a person, who sends it with `capcomd context brain propose --run
//    <runId> --yes` and is its actor; the brain's repository gets a draft on the run's proposal branch (this repository's
//    forge is plain git, so no pull request: tests/plugins/context-groundray-write.test.ts has the forge's side);
//  - under `review: lint` the kernel sends it as the consolidator's staging ends, as capcomd.
// The brain's own branch, what agents read, never changes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PROFILES, world, newRun, spawnRoot, waitAll, trajectory, type World } from "./harness";
import { CONSOLIDATOR_PROFILE } from "../../src/context/consolidate";
import { proposalBranch } from "../../src/context/groundray-write";
import { VERSION } from "../../src/utils/self";
import { bareRepo } from "../merge/gitfixture";

const ACME_ID = "urn:uuid:6e7cc12e-b3f7-49da-875d-32b714fdc1e8";
const BRAIN: Record<string, string> = {
  "brain.yaml": `schema_version: 1\nid: ${ACME_ID}\nslug: acme\nname: Acme fictional\nbundle: knowledge\n`,
  "knowledge/.core-kb.yaml": "profile: core-kb/0.1\ndefault_sensitivity: internal\n",
  "knowledge/index.md": "# Acme\n",
  "knowledge/log.md": "# Log\n",
  "knowledge/policies/refunds.md": `---\ntype: policy\nid: "urn:uuid:11111111-1111-4111-8111-111111111111"\ntitle: Refund window\ndescription: Refunds within 30 days\nstatus: stable\n---\n\nRefunds are accepted within 30 days of delivery.\n`,
};
const consolidatorProfile = (review: "human" | "lint") => ({ provider: "claude", auth: "subscription", maxTurns: 20, allowedTools: ["Read", "Glob", "Grep"], context: { providers: [{ name: "memory" }, { name: "groundray", brain: "acme" }], review } });

let w: World;
let dir = "";
let agentsFile = "";
let brain: Awaited<ReturnType<typeof bareRepo>>;
let brainTip = "";
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "capcomd-ctxbrain-"));
  brain = await bareRepo();
  for (const [p, text] of Object.entries(BRAIN)) { mkdirSync(join(brain.root, "seed", p, ".."), { recursive: true }); writeFileSync(join(brain.root, "seed", p), text); }
  await brain.seed.ok(["add", "."]);
  await brain.seed.ok(["commit", "-q", "-m", "brain"]);
  await brain.seed.ok(["push", "-q", "origin", "main"]);
  brainTip = (await brain.sha("main"))!;
  // groundray, for the daemon and the CLI alike: the fake, logging every call.
  const cli = join(dir, "groundray");
  writeFileSync(cli, `#!/bin/sh\nFAKE_GROUNDRAY_LOG=${JSON.stringify(join(dir, "groundray.log"))}\nexport FAKE_GROUNDRAY_LOG\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(new URL("../plugins/fixtures/fake-groundray.ts", import.meta.url).pathname)} "$@"\n`);
  chmodSync(cli, 0o755);
  agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ ...PROFILES, agents: { ...PROFILES.agents, [CONSOLIDATOR_PROFILE]: consolidatorProfile("human") } }));
  w = await world("ctxbrain", { CAPCOMD_AGENTS_FILE: agentsFile, CAPCOMD_GROUNDRAY: cli });
}, 120_000);
afterAll(async () => {
  try { await w?.stop(); } finally { for (const d of [dir, brain?.root]) if (d) rmSync(d, { recursive: true, force: true }); }
});

const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
/** A run that started with the project mapping brain acme (what `run new` records from .capcomd/config.json). */
async function runWithBrain() {
  const run = await newRun(w);
  const { kvWrite } = await import("../../src/primitives/state");
  await kvWrite(run, { k: "_context", writer: "operator", value: { brains: { acme: { repo: brain.bare, branch: "main", commit: brainTip, slug: "acme", id: ACME_ID, addedAt: new Date().toISOString() } } } });
  return run;
}
async function proposer(run: string, lessons: unknown[]) {
  const id = await spawnRoot(w, run, "worker", w.script(`propose-${run}`, `capcomd result --summary "done" --data ${sq(JSON.stringify({ context: lessons }))} >/dev/null`));
  expect((await waitAll(w, run, [id])).agents[0].status).toBe("done");
  for (let i = 0; i < 100; i++) {
    if ((await w.cj(["kv", "get", run, `_context/${id}`])).j?.value?.candidates) return id;
    await Bun.sleep(100);
  }
  throw new Error(`no candidates for ${id}`);
}
async function consolidator(run: string, deltas: unknown[]) {
  const id = await spawnRoot(w, run, CONSOLIDATOR_PROFILE, w.script(`consolidate-${run}`, `capcomd result --summary "consolidated" --data ${sq(JSON.stringify({ context: deltas }))} >/dev/null`), { task: "Consolidate this run's lessons" });
  const a = (await waitAll(w, run, [id], 120_000)).agents[0];
  expect(a.status).toBe("done");
  return a;
}
const FACT = "Damaged goods are refunded in full, shipping included: the support lead confirmed it on ticket 4411.";
/** The run's events of a type, once there are `n` (the context plugin records them as it hears the agent end). */
async function events(run: string, type: string, n = 1) {
  for (let i = 0; i < 100; i++) {
    const evs = await trajectory(w, run, (e) => e.type === type);
    if (evs.length >= n) return evs.map((e) => e.data);
    await Bun.sleep(100);
  }
  return (await trajectory(w, run, (e) => e.type === type)).map((e) => e.data);
}
const groundrayCalls = () => readFileSync(join(dir, "groundray.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[] });

test("review: human: the fact waits for a person, who sends it as themselves; the brain's branch is untouched", async () => {
  const run = await runWithBrain();
  const worker = await proposer(run, [{ title: "Damaged goods", text: FACT }]);
  const c = await consolidator(run, [
    { brain: "acme", type: "policy", title: "Refunds for damaged goods", text: FACT, from: [`${worker}.1`] },
    { title: "Refund tests", text: "tests/refunds.test.ts covers damaged goods; run it after touching src/refunds.ts.", from: [`${worker}.1`] },
    { brain: "globex", type: "policy", title: "Elsewhere", text: "Not this run's brain." },
  ]);
  // The memory change is staged on its branch as before; the fact waits for a person; the other brain is refused.
  expect(c.result.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(c.result.context.applied.map((x: { op: string }) => x.op)).toEqual(["add"]);
  expect(c.result.context.refused).toEqual([{ n: 3, reason: "no_brain" }]);
  expect(c.result.context.brain).toEqual({ name: "acme", proposals: [{ n: 1, title: "Refunds for damaged goods", type: "policy" }], awaits: "person", sent: [] });
  expect(c.result.summary).toBe("consolidated");
  expect(await events(run, "plugin.context.brain_staged")).toEqual([expect.objectContaining({ agentId: c.agentId, brain: "acme", proposals: [{ n: 1, title: "Refunds for damaged goods", type: "policy" }] })]);
  // Nothing went to the brain yet.
  const branch = proposalBranch({ runId: run, agentId: c.agentId });
  expect(await brain.sha(branch)).toBeNull();

  // A person looks, then sends it.
  const listed = await w.cj(["context", "brain", "propose", "--run", run]);
  expect(listed.j).toMatchObject({ ok: true, proposals: [{ id: `${c.agentId}.1`, brain: "acme", type: "policy", title: "Refunds for damaged goods", from: [`${worker}.1`], sent: null }] });
  expect(listed.j.text).toContain("--yes");
  // A send with no time left (the kernel's, under lint, bounds its time) leaves it as it was, for the next send.
  const { sendBrainProposals } = await import("../../src/context/brain-proposals");
  expect(await sendBrainProposals(run, { by: { kind: "operator", clientId: null }, budgetMs: 0 })).toEqual([{ id: `${c.agentId}.1`, brain: "acme", title: "Refunds for damaged goods", ok: false, already: false, error: expect.stringContaining("ran out") }]);
  expect((await w.cj(["context", "brain", "propose", "--run", run])).j.proposals).toEqual([expect.not.objectContaining({ error: expect.anything() })]);
  expect(await brain.sha(branch)).toBeNull();
  const sent =await w.cj(["context", "brain", "propose", "--run", run, "--yes"]);
  expect(sent.code).toBe(0);
  expect(sent.j.sent).toEqual([expect.objectContaining({ id: `${c.agentId}.1`, ok: true, already: false, item: expect.stringMatching(/^urn:uuid:/), where: `${brain.bare}, branch ${branch}` })]);
  // The brain's repository: a draft on the run's proposal branch, as the person; its main is where it was.
  const tip = (await brain.sha(branch))!;
  await brain.seed.ok(["fetch", "-q", "origin"]);
  const files = (await brain.seed.ok(["diff", "--name-only", brainTip, tip])).split("\n").filter(Boolean);
  expect(files).toEqual([expect.stringMatching(/^knowledge\/inbox\/refunds-for-damaged-goods-[0-9a-f]{6}\.md$/), "knowledge/log.md"]);
  const item = await brain.show(tip, files[0]!);
  expect(item).toContain('"by":"human:operator"');
  expect(item).toContain('status: "draft"');
  expect(item).toContain(FACT);
  expect(await brain.sha("main")).toBe(brainTip);
  expect(await events(run, "plugin.context.brain_proposed")).toEqual([expect.objectContaining({ proposal: `${c.agentId}.1`, brain: "acme", by: "human:operator" })]);
  // Sent once: again, it says so and changes nothing.
  const again = await w.cj(["context", "brain", "propose", "--run", run, "--yes"]);
  expect(again.j.sent).toEqual([expect.objectContaining({ ok: true, already: true })]);
  expect(await brain.sha(branch)).toBe(tip);
  // A run that proposed nothing, and a run that isn't there.
  expect((await w.cj(["context", "brain", "propose", "--run", await newRun(w)])).j.text).toContain("proposed nothing to a brain");
  expect((await w.cj(["context", "brain", "propose", "--run", "run-nosuchrun"])).code).not.toBe(0);
}, 240_000);

test("review: lint: the kernel sends the fact as the staging ends, as capcomd", async () => {
  writeFileSync(agentsFile, JSON.stringify({ ...PROFILES, agents: { ...PROFILES.agents, [CONSOLIDATOR_PROFILE]: consolidatorProfile("lint") } }));
  const run = await runWithBrain();
  const worker = await proposer(run, [{ title: "Invoices", text: "Invoices are due 30 days after issue." }]);
  const c = await consolidator(run, [{ brain: "acme", type: "decision", title: "Invoice terms", text: "Invoices are due 30 days after issue, per the finance lead.", from: [`${worker}.1`] }]);
  const branch = proposalBranch({ runId: run, agentId: c.agentId });
  // Only a fact: no memory branch; sent at once.
  expect(c.result.commit).toBeNull();
  expect(c.result.context.brain).toEqual({ name: "acme", proposals: [{ n: 1, title: "Invoice terms", type: "decision" }], awaits: null, sent: [{ id: `${c.agentId}.1`, item: expect.stringMatching(/^urn:uuid:/), where: `${brain.bare}, branch ${branch}` }] });
  const tip = (await brain.sha(branch))!;
  await brain.seed.ok(["fetch", "-q", "origin"]);
  const files = (await brain.seed.ok(["diff", "--name-only", brainTip, tip])).split("\n").filter(Boolean);
  expect(await brain.show(tip, files.find((f) => f.includes("/inbox/"))!)).toContain(`"by":"capcomd/${VERSION}"`);
  expect(await brain.sha("main")).toBe(brainTip);
  expect(groundrayCalls().filter((x) => x.argv.includes("--apply")).length).toBe(2);
  expect(await events(run, "plugin.context.brain_proposed")).toEqual([expect.objectContaining({ proposal: `${c.agentId}.1`, by: "capcomd" })]);
}, 240_000);
