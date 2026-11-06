// The context layer, step 5 (ADR-025 §11.2, §13): groundray's write path. A proposal to a brain becomes a draft made by
// the groundray CLI (a fake here, tests/plugins/fixtures/fake-groundray.ts: never the real one) in a throwaway authoring
// clone, pushed to the run's proposal branch of the brain's repository and opened as a pull request there through the
// forge that serves it (the test forge, tests/merge/forge-fake): the forge fake receives a PR on the brain repository;
// what agents read (the brain's branch, the host's files mirror, the tree placed in a sandbox) is unchanged. The person
// who sent it is the actor, else capcomd; a replay finds what it made; groundray's commit is pushed only when it stays
// inside the bundle. The consolidator's side (its deltas for a brain, kept and sent) is tested here as pure functions,
// and end to end in tests/scenarios/context-brain.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";
import { PluginHost } from "../../packages/plugin/src/host/host";
import { conformanceCall } from "../../packages/plugin/src/conformance";
import type { ContextScope } from "../../packages/plugin/src/context-layer";
import { PluginError } from "../../packages/plugin/src/errors";
import { BUILTINS, candidateOf } from "../../src/plugins/builtins";
import { useForges } from "../../src/plugins/forges";
import { forgePullRequest, groundrayProvider, hostWriter } from "../../src/context/groundray";
import { actorOf, descriptionOf, proposalBranch, writeToBrain } from "../../src/context/groundray-write";
import { brainDeltas, brainOf, stage } from "../../src/context/consolidate";
import { mirrorReader } from "../../src/context/memory";
import { secretScan } from "../../src/context/scan";
import { REDACTED } from "../../src/agents/redact";
import { BUNDLE_MARKER, placeBundle } from "../../src/agents/runner";
import { Redactor } from "../../src/agents/redact";
import { VERSION } from "../../src/utils/self";
import { fake } from "../merge/forge-fake/index";
import { bareRepo } from "../merge/gitfixture";

const FAKE_FORGE = join(import.meta.dir, "..", "merge", "forge-fake");
const FAKE_CLI = join(import.meta.dir, "fixtures", "fake-groundray.ts");
const ACME_ID = "urn:uuid:6e7cc12e-b3f7-49da-875d-32b714fdc1e8";
const RUN = "run-brainwrite", AGENT = "agt-cons1";
const fm = (meta: Record<string, unknown>, body: string) => `---\n${Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n${body}\n`;
const BRAIN = {
  "brain.yaml": `schema_version: 1\nid: ${ACME_ID}\nslug: acme\nname: Acme fictional\nbundle: knowledge\n`,
  "knowledge/.core-kb.yaml": "profile: core-kb/0.1\ndefault_sensitivity: internal\n",
  "knowledge/index.md": "# Acme\n",
  "knowledge/log.md": "# Log\n",
  "knowledge/policies/refunds.md": fm({ type: "policy", id: "urn:uuid:11111111-1111-4111-8111-111111111111", title: "Refund window", description: "Refunds within 30 days", status: "stable" }, "Refunds are accepted within 30 days of delivery."),
};

let host: PluginHost;
let root = "";
let log = "";
const saved = { GROUNDRAY: process.env.CAPCOMD_GROUNDRAY, WORKDIR: process.env.CAPCOMD_WORKDIR, ENDPOINT: process.env.CAPCOMD_ENDPOINT };
const dirs: string[] = [];

/** A wrapper the write path runs as groundray: the fake CLI, with a test's knobs. */
function cli(knobs: Record<string, string> = {}): string {
  const p = join(root, `groundray-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(p, `#!/bin/sh\nFAKE_GROUNDRAY_LOG=${JSON.stringify(log)}\nexport FAKE_GROUNDRAY_LOG\n${Object.entries(knobs).map(([k, v]) => `${k}=${JSON.stringify(v)}; export ${k}\n`).join("")}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLI)} "$@"\n`);
  chmodSync(p, 0o755);
  return p;
}
const calls = (): Array<{ argv: string[]; home: string; xdg: string }> => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

/** The brain in a bare repository, mapped (as `capcomd context brain add` would) at its tip. */
async function brainRepo() {
  const r = await bareRepo();
  dirs.push(r.root);
  for (const [p, text] of Object.entries(BRAIN)) { mkdirSync(join(r.root, "seed", p, ".."), { recursive: true }); writeFileSync(join(r.root, "seed", p), text); }
  await r.seed.ok(["add", "."]);
  await r.seed.ok(["commit", "-q", "-m", "brain"]);
  await r.seed.ok(["push", "-q", "origin", "main"]);
  const commit = (await r.sha("main"))!;
  const settings = { brains: { acme: { repo: r.bare, branch: "main", commit, slug: "acme", id: ACME_ID, addedAt: "2026-11-06T00:00:00.000Z" } } };
  return { r, commit, settings };
}
const scope = (o: Partial<ContextScope> = {}): ContextScope => ({ projectId: null, repo: null, ref: null, profile: { name: "context-consolidator", version: 1 }, runId: RUN, agentId: AGENT, layers: ["project"], settings: { brain: "acme" }, bundleRoot: null, ...o });
const operator = { kind: "operator" as const, clientId: null };
/** The provider as the host has it, but reading and writing without asking an engine for the run's settings (there is
 *  none here: each ask would wait out its 3 s): the files mirror and the write path with the forges, groundray the fake
 *  this test names. The first test runs the host's own writer once. */
const provider = (settings: object) => groundrayProvider({
  settings: async () => settings, read: (o) => mirrorReader({ ...o, runId: null }),
  write: (b, d, a, c) => writeToBrain(b, d, a, { bin: process.env.CAPCOMD_GROUNDRAY!, workdir: join(root, "work", "brain-proposals"), pullRequest: forgePullRequest }, c),
});
const proposal = (title: string, text: string, type = "policy") => ({ text: { text, untrusted: true as const, by: AGENT }, title, type, op: "add" as const });
/** Every file under `dir` with its bytes, to compare a tree before and after. */
const treeOf = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p)] = readFileSync(p, "utf8"); } };
  walk(dir);
  return out;
};

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "capcomd-brain-write-")));
  log = join(root, "groundray.log");
  // The checks look up a run's settings in the engine: a closed port, so this file never asks a running daemon.
  process.env.CAPCOMD_ENDPOINT = "http://127.0.0.1:9";
  process.env.CAPCOMD_WORKDIR = join(root, "work");
  host = new PluginHost({ capcomd: VERSION, kernel: [], emit: () => {}, dataDir: () => "/nonexistent" });
  await host.start([{ source: "builtin", dir: FAKE_FORGE }, ...BUILTINS.map(candidateOf)]);
  useForges(host);
});
afterAll(async () => {
  useForges(null);
  await host.stop();
  for (const [k, v] of [["CAPCOMD_GROUNDRAY", saved.GROUNDRAY], ["CAPCOMD_WORKDIR", saved.WORKDIR], ["CAPCOMD_ENDPOINT", saved.ENDPOINT]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  for (const d of [root, ...dirs]) rmSync(d, { recursive: true, force: true });
});
afterEach(() => { fake.reset(); rmSync(log, { force: true }); });

describe("a proposal to a brain (ADR-025 step 5)", () => {
  test("the forge fake receives a PR on the brain repository; the mounted export is unchanged", async () => {
    const { r, commit, settings } = await brainRepo();
    fake.claims = [r.bare];
    process.env.CAPCOMD_GROUNDRAY = cli();
    const p = groundrayProvider({ settings: async () => settings });
    expect(p.describe().caps.writable).toBe(true);
    // What agents read: the brain's tree at the pinned commit, as the host's mirror serves it and as placed in a sandbox.
    const mirrored = await mirrorReader({ remote: r.bare, at: { sha: commit }, runId: null, prefix: "knowledge/" });
    const sandbox = join(r.root, "sandbox");
    const box = {
      exec: async (cmd: string[]) => { const x = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }); const [stdout, stderr, code] = await Promise.all([new Response(x.stdout).text(), new Response(x.stderr).text(), x.exited]); return { code, stdout, stderr }; },
      upload: async (path: string, data: Uint8Array) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, data); },
    };
    const placed = { provider: "groundray", name: "acme", remote: r.bare, branch: "main", commit, dir: join(sandbox, "context", "groundray", "acme") };
    expect(await placeBundle(placed, { remote: r.bare, workdir: join(root, "work") }, box, { events: [] } as never, new Redactor([]), () => {})).toBe(true);
    const before = treeOf(placed.dir);

    const { handle } = await p.resolve(scope(), conformanceCall());
    const receipt = await p.propose(handle, proposal("Refunds for damaged goods", "Damaged goods are refunded in full, shipping included. The support lead confirmed it on the run's ticket."), operator, conformanceCall(120_000));
    const branch = proposalBranch({ runId: RUN, agentId: AGENT });
    expect(branch).toBe(`groundray/capcomd-${RUN}-${AGENT}`);
    expect(receipt).toEqual({ id: expect.stringMatching(/^urn:uuid:/), staged: true, where: "fake://pull/1" });
    expect(fake.pulls).toEqual([expect.objectContaining({ remote: r.bare, head: branch, base: "main", state: "open" })]);

    // The proposal branch: one commit on the brain's tip, inside the bundle only: the draft and groundray's log.
    const tip = (await r.sha(branch))!;
    expect(await r.seed.ok(["fetch", "-q", "origin"]).then(() => r.seed.ok(["rev-parse", `${tip}^`]))).toBe(commit);
    const changed = (await r.seed.ok(["diff", "--name-only", commit, tip])).split("\n").filter(Boolean);
    expect(changed).toEqual(["knowledge/inbox/refunds-for-damaged-goods-" + changed[0]!.slice(-9, -3) + ".md", "knowledge/log.md"].sort());
    const item = await r.show(tip, changed.find((x) => x.includes("/inbox/"))!);
    expect(item).toContain(`id: "${receipt.id}"`);
    expect(item).toContain('"by":"human:operator"');
    expect(item).toContain('"method":"agent-generated"');
    expect(item).toContain('status: "draft"');
    expect(item).toContain(`capcomd://runs/${RUN}/agents/${AGENT}/proposals/`);
    expect(item).toContain("Damaged goods are refunded in full");

    // The mounted export is unchanged: the brain's branch, the mirror's tree at the pinned commit, the placed bundle.
    expect(await r.sha("main")).toBe(commit);
    expect(await mirrorReader({ remote: r.bare, at: { sha: commit }, runId: null, prefix: "knowledge/" })).toEqual(mirrored);
    expect(treeOf(placed.dir)).toEqual(before);
    expect(readFileSync(join(placed.dir, BUNDLE_MARKER), "utf8")).toBe(commit);

    // groundray was asked plan first, then --apply, in a throwaway home of its own (never the user's), as the person;
    // and the throwaway is gone.
    const cs = calls();
    expect(cs.map((c) => c.argv.slice(0, 2).join(" "))).toEqual(["setup --non-interactive", `brain add`, "knowledge create", "knowledge create"]);
    const create = cs[2]!.argv;
    expect(create).not.toContain("--apply");
    expect(cs[3]!.argv).toContain("--apply");
    const flag = (a: string[], f: string) => a.find((x) => x.startsWith(`${f}=`))?.slice(f.length + 1) ?? a[a.indexOf(f) + 1];
    expect([flag(create, "--actor"), flag(create, "--method"), flag(create, "--type"), flag(create, "--brain"), flag(create, "--confidence")]).toEqual(["human:operator", "agent-generated", "policy", "acme", "low"]);
    expect(flag(create, "--description")).toBe("Damaged goods are refunded in full, shipping included.");
    for (const c of cs) {
      expect(flag(c.argv, "--config")).toStartWith(join(root, "work"));
      expect(c.home).toStartWith(join(root, "work"));
      expect(c.home).not.toBe(process.env.HOME);
    }
    expect(readdirSync(join(root, "work", "brain-proposals"))).toEqual([]);
  }, 120_000);

  test("idempotent: the same proposal again finds its draft and its pull request; another one joins the branch and the pull request", async () => {
    const { r, settings } = await brainRepo();
    fake.claims = [r.bare];
    process.env.CAPCOMD_GROUNDRAY = cli();
    const p = provider(settings);
    const { handle } = await p.resolve(scope(), conformanceCall());
    const a = proposal("Invoice terms", "Invoices are due 30 days after issue.");
    const first = await p.propose(handle, a, operator, conformanceCall(120_000));
    const branch = proposalBranch({ runId: RUN, agentId: AGENT });
    const tip = await r.sha(branch);
    const again = await p.propose(handle, a, { kind: "agent", agentId: AGENT, runId: RUN }, conformanceCall(120_000));
    expect(again).toEqual(first);
    expect(await r.sha(branch)).toBe(tip);
    expect(calls().filter((c) => c.argv[0] === "knowledge")).toHaveLength(2);
    // Another proposal of the same agent: a second commit on its branch, the same pull request, as capcomd this time. Its
    // title, the agent's text, looks like an option: it stays the title (the plan is never applied by it).
    const second = await p.propose(handle, proposal("--apply late fees", "A late invoice accrues 1% a month.", "decision"), { kind: "agent", agentId: AGENT, runId: RUN }, conformanceCall(120_000));
    expect(second.where).toBe(first.where);
    expect(second.id).not.toBe(first.id);
    expect((await r.seed.ok(["fetch", "-q", "origin"]), await r.seed.ok(["rev-list", "--count", `${tip}..origin/${branch}`]))).toBe("1");
    expect(fake.pulls).toHaveLength(1);
    const [plan, create] = calls().filter((c) => c.argv[0] === "knowledge").slice(-2).map((c) => c.argv);
    expect(plan).not.toContain("--apply");
    expect(plan).toContain("--title=--apply late fees");
    expect(create).toContain(`--actor=capcomd/${VERSION}`);
  }, 120_000);

  test("refused: a commit outside the bundle is never pushed; no groundray; a forge without pull requests leaves the branch", async () => {
    const { r, commit, settings } = await brainRepo();
    fake.claims = [r.bare];
    const p = provider(settings);
    const { handle } = await p.resolve(scope(), conformanceCall());
    const branch = proposalBranch({ runId: RUN, agentId: AGENT });
    // groundray's commit touches a file outside knowledge/: refused, nothing pushed.
    process.env.CAPCOMD_GROUNDRAY = cli({ FAKE_GROUNDRAY_OUTSIDE: "1" });
    const outside = await p.propose(handle, proposal("A note", "Something about the business."), operator, conformanceCall(120_000)).then(() => null, (e: unknown) => e);
    expect(outside).toBeInstanceOf(PluginError);
    expect(outside).toMatchObject({ code: "invalid", message: expect.stringContaining("outside the brain's bundle (NOTES.md)") });
    expect(await r.sha(branch)).toBeNull();
    // groundray failing says so.
    process.env.CAPCOMD_GROUNDRAY = cli({ FAKE_GROUNDRAY_FAIL: "knowledge" });
    await expect(p.propose(handle, proposal("A note", "Something."), operator, conformanceCall(120_000))).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("groundray knowledge create (plan) failed") });
    // No groundray on this machine.
    process.env.CAPCOMD_GROUNDRAY = join(root, "no-such-groundray");
    await expect(groundrayProvider({ settings: async () => settings, read: (o) => mirrorReader({ ...o, runId: null }), write: hostWriter }).propose(handle, proposal("A note", "Something."), operator, conformanceCall())).rejects.toMatchObject({ code: "unavailable", hint: expect.stringContaining("CAPCOMD_GROUNDRAY") });
    // A forge there that opens no pull requests (forge-git's kind): the draft is pushed, the receipt says where.
    process.env.CAPCOMD_GROUNDRAY = cli();
    fake.pullRequests = false;
    const pushed = await p.propose(handle, proposal("A note", "Something about the business."), operator, conformanceCall(120_000));
    expect(pushed.where).toBe(`${r.bare}, branch ${branch}`);
    expect(await r.sha(branch)).not.toBeNull();
    expect(fake.pulls).toEqual([]);
    expect(await r.sha("main")).toBe(commit);
    expect(readdirSync(join(root, "work", "brain-proposals"))).toEqual([]);
  }, 120_000);

  test("what a brain doesn't take: an op other than add, a type groundray doesn't know, no title, frontmatter; an OKF bundle without brain.yaml", async () => {
    const { settings } = await brainRepo();
    let writes = 0;
    const p = groundrayProvider({ settings: async () => settings, read: (o) => mirrorReader({ ...o, runId: null }), write: async () => { writes++; throw new Error("unused"); } });
    const { handle } = await p.resolve(scope(), conformanceCall());
    const refused = (x: object) => p.propose(handle, { ...proposal("T", "A fact."), ...x }, operator, conformanceCall()).then(() => null, (e: PluginError) => [e.code, e.message]);
    expect(await refused({ op: "supersede", target: { provider: "groundray", id: "x", version: "" } })).toEqual(["unsupported", expect.stringContaining("new drafts only")]);
    expect(await refused({ type: "lesson" })).toEqual(["invalid", expect.stringContaining("has no type groundray knows")]);
    expect(await refused({ title: undefined })).toEqual(["invalid", "brain acme can't take this proposal: it has no one-line title"]);
    expect(await refused({ text: { text: "---\nstatus: stable\n---\nx", untrusted: true, by: AGENT } })).toEqual(["invalid", expect.stringContaining("frontmatter")]);
    // A handle for no agent of a run (`capcomd context brief`'s) can't propose.
    const bare = await p.resolve(scope({ runId: null, agentId: null }), conformanceCall());
    expect(await p.propose(bare.handle, proposal("T", "A fact."), operator, conformanceCall()).then(() => null, (e: PluginError) => e.code)).toBe("invalid");
    // An OKF bundle (no brain.yaml): groundray authors only its own brains.
    const okf = groundrayProvider({ settings: async () => ({ brains: { kb: { repo: "/srv/kb.git", branch: "main", commit: "a".repeat(40), slug: "kb", id: "", bundle: "kb" } } }), read: async ({ at }) => ({ sha: "a".repeat(40), date: "2026-11-01T00:00:00.000Z", truncated: false, files: "branch" in at || at ? [{ path: "kb/a.md", text: fm({ type: "concept", id: "a", description: "A" }, "a") }] : [] }) });
    const h = await okf.resolve(scope({ settings: { brain: "kb" } }), conformanceCall());
    expect(await okf.propose(h.handle, proposal("T", "A fact."), operator, conformanceCall()).then(() => null, (e: PluginError) => [e.code, e.message])).toEqual(["unsupported", "brain kb has no brain.yaml: groundray authors only its own brains"]);
    expect(writes).toBe(0);
  }, 60_000);

  test("the actor: a person's principal is human:<id>, anything else is capcomd; the description is the body's first sentence", () => {
    expect(actorOf({ kind: "operator", clientId: null })).toBe("human:operator");
    expect(actorOf({ kind: "operator", clientId: "c-42" })).toBe("human:c-42");
    expect(actorOf({ kind: "driver", clientId: null })).toBe("human:driver");
    expect(actorOf({ kind: "operator", clientId: "has spaces; and more" })).toBe("human:operator");
    expect(actorOf({ kind: "agent", agentId: "agt-1", runId: "run-1" })).toBe(`capcomd/${VERSION}`);
    expect(actorOf({ kind: "plugin", name: "x", scopes: ["steer"] })).toBe(`capcomd/${VERSION}`);
    expect(descriptionOf("# Heading\n\nRefunds take 5 days. Then more.", "Refunds")).toBe("Refunds take 5 days.");
    expect(descriptionOf("no stop at all", "T")).toBe("no stop at all");
  });
});

describe("a consolidator's deltas for a brain (src/context/consolidate.ts)", () => {
  const scan = secretScan(["s3cr3t-run-value-123456"]);
  const cands = [{ id: "agt-w1.1", proposal: proposal("x", "y"), provenance: { method: "agent-generated" as const, by: "process:agt-w1", at: "", sources: [] }, bytes: 1 }];
  const base = { brain: "acme", candidates: cands, agentId: AGENT, scan, itemBytes: 4096, room: 20 };
  const fact = (o: object = {}) => ({ brain: "acme", type: "policy", title: "Damaged goods", text: "Damaged goods are refunded in full.", from: ["agt-w1.1"], ...o });

  test("the brain its profile names; groundray's types; a new draft only; the scan, the size, the candidates and the room", () => {
    expect(brainOf({ providers: [{ name: "memory" }, { name: "groundray", brain: "acme" }] })).toBe("acme");
    expect(brainOf({ providers: [{ name: "memory" }] })).toBeNull();
    const raw = [
      { title: "A lesson", text: "for the memory" },
      fact(),
      fact({ brain: "globex" }),
      fact({ type: "lesson" }),
      fact({ op: "supersede", target: { id: "x" } }),
      fact({ text: "the token is s3cr3t-run-value-123456" }),
      fact({ text: `a credential ${REDACTED} here` }),
      fact({ text: "x".repeat(5000) }),
      fact({ from: ["agt-other.1"] }),
      fact({ title: undefined }),
      fact({ title: "Second", text: "Another fact entirely." }),
    ];
    const r = brainDeltas({ ...base, raw });
    expect(r.accepted).toEqual([
      { n: 2, brain: "acme", type: "policy", title: "Damaged goods", text: "Damaged goods are refunded in full.", from: ["agt-w1.1"] },
      { n: 11, brain: "acme", type: "policy", title: "Second", text: "Another fact entirely.", from: ["agt-w1.1"] },
    ]);
    expect(r.refused.map((x) => [x.n, x.reason])).toEqual([[3, "no_brain"], [4, "invalid"], [5, "invalid"], [6, expect.any(String)], [7, "token"], [8, "too_large"], [9, "unknown_source"], [10, "invalid"]]);
    expect(r.refused.find((x) => x.n === 6)!.reason).not.toBe("invalid");
    // A profile that names no brain: every delta for one is refused, none kept.
    expect(brainDeltas({ ...base, brain: null, raw: [fact()] }).refused).toEqual([{ n: 1, reason: "no_brain", what: expect.stringContaining("its profile names none") }]);
    // The room is the run's: shared with the memory's changes (which get what is left).
    expect(brainDeltas({ ...base, room: 1, raw: [fact(), fact({ title: "B", text: "Other." })] }).refused).toEqual([{ n: 2, reason: "over_cap", what: expect.any(String) }]);
    // The memory's staging leaves a brain's deltas out (and doesn't call `brain` an ignored field).
    const st = stage({ files: [], raw, candidates: cands, origin: { runId: RUN, agentId: AGENT, profile: "context-consolidator", model: null, image: null }, at: "2026-11-06T00:00:00.000Z", scan, outcome: () => false, itemBytes: 4096, descriptionChars: 150, room: 20 });
    expect(st.applied.map((x) => [x.n, x.op])).toEqual([[1, "add"]]);
    expect(st.refused).toEqual([]);
    expect(st.ignored).toEqual([]);
  });
});
