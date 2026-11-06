// A company's brain against a real engine and runner (ADR-025 step 4): a brain in its own repository (groundray's
// layout: brain.yaml, knowledge/), mapped by the project with `capcomd context brain add`, a profile whose context block
// names it, and the fake claude in a host-exec sandbox (it writes the appended system prompt it was given). The run
// records the mapping when it starts, so its agents are briefed from that commit and find the brain's files where the
// brief's lines point, read-only, even after the brain moves on and is mapped again; `capcomd context brief` (no run)
// shows the new commit. A restricted brain is refused when it is mapped.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, CLI, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

let engine: Engine;
let env: Record<string, string>;
let dir = "";
let project = "";
let brainRepo: Awaited<ReturnType<typeof bareRepo>>;
const saved = { ...process.env };
const KEY = "sk-ant-api03-CONTEXTGROUNDRAY-abcdefghijklmnopqrstuvwxyz0123456789";
const fm = (meta: string[], body: string) => `---\n${meta.join("\n")}\n---\n\n${body}\n`;
const manifest = (slug: string, id: string) => `schema_version: 1\nid: ${id}\nslug: ${slug}\nname: ${slug} fictional\nbundle: knowledge\n`;
const coreKb = (sensitivity: string) => `profile: core-kb/0.1\nactive_types: [concept, policy]\ndefault_sensitivity: ${sensitivity}\n`;

/** A brain's files pushed to a fresh bare repository. */
async function brainIn(files: Record<string, string>) {
  const r = await bareRepo();
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(r.root, "seed", p, ".."), { recursive: true }); writeFileSync(join(r.root, "seed", p), text); }
  await r.seed.ok(["add", "."]);
  await r.seed.ok(["commit", "-q", "-m", "brain"]);
  await r.seed.ok(["push", "-q", "origin", "main"]);
  return r;
}

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  brainRepo = await brainIn({
    "brain.yaml": manifest("acme", "urn:uuid:6e7cc12e-b3f7-49da-875d-32b714fdc1e8"),
    "knowledge/.core-kb.yaml": coreKb("internal"),
    "knowledge/index.md": "# Acme\n",
    "knowledge/policies/refunds.md": fm(["type: policy", "id: refunds", "title: Refund window", "description: Refunds are accepted within 30 days of delivery", "status: stable", 'updated_at: "2026-10-01T00:00:00Z"'], "THE-BODY-OF-THE-POLICY: refunds need the order number."),
  });
  dir = mkdtempSync(join(tmpdir(), "capcomd-context-groundray-"));
  // The project's checkout settings: the brains it maps go here (`capcomd context brain add`).
  project = join(dir, "project");
  mkdirSync(join(project, ".capcomd"), { recursive: true });
  writeFileSync(join(project, ".capcomd", "config.json"), "{}\n");
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    worker: { provider: "claude", auth: "apikey", maxTurns: 20, context: { providers: [{ name: "groundray", brain: "acme" }] } },
  } }));
  env = {
    ...r.env,
    CAPCOMD_HOME: join(dir, "home"),
    CAPCOMD_HARNESS_SOCKET: join(dir, "home", "harness.sock"),
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_VM_RPC_POLL_MS: "200",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    CAPCOMD_RPC_KEY: `context-groundray-${Math.random()}`,
    ANTHROPIC_API_KEY: KEY,
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("context-groundray", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
}, 120_000);

afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const lastJson = (s: string) => { try { return JSON.parse(s.trim().split("\n").pop()!); } catch { return null; } };
const cj = async (args: string[]) => { const x = await capcomd([...args, "--json"], env); return { ...x, j: lastJson(x.stdout) }; };
/** The CLI in the project's checkout, its settings on (the tests' preload turns them off everywhere else). */
async function inProject(args: string[]) {
  const e: Record<string, string | undefined> = { ...process.env, ...env };
  delete e.CAPCOMD_NO_CONFIG;
  const p = Bun.spawn(["bun", CLI, ...args, "--json"], { cwd: project, env: e as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr, j: lastJson(stdout) };
}
const workDir = (id: string) => join(dir, "vm", readdirSync(join(dir, "vm")).find((d) => d.includes(id))!);
async function finished(run: string, key: string) {
  const id = (await cj(["spawn", run, "--profile", "worker", "--task", "Check the refund rule", "--key", key])).j?.agentId as string;
  expect(id).toMatch(/^agt-/);
  const done = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  if (done?.status !== "done") console.log(JSON.stringify(done), (await cj(["logs", run, id])).stdout);
  expect(done?.status).toBe("done");
  return { id, system: readFileSync(join(workDir(id), "append-system.txt"), "utf8") };
}

test("an agent is briefed from the brain the run started with and finds its files where the lines point; a restricted brain isn't mapped", async () => {
  const added = await inProject(["context", "brain", "add", "acme", brainRepo.bare, "--branch", "main"]);
  if (added.code !== 0) console.log(added.stdout, added.stderr);
  expect(added.code).toBe(0);
  const pinned = (await brainRepo.sha("main"))!;
  expect(added.j).toMatchObject({ ok: true, name: "acme", items: 1, brain: { commit: pinned, slug: "acme" } });

  const run = (await inProject(["run", "new", "--key", `cg-${Date.now()}`])).j?.runId as string;
  expect(run).toMatch(/^run-/);
  const a = await finished(run, "a");
  const placed = join(dir, "vm", "context", "groundray", "acme");
  const brief = a.system.slice(a.system.indexOf("Context: loaded")).split("\n\n")[0]!.split("\n");
  expect(brief[0]).toStartWith(`Context: loaded 1 of 1 lines (budget 25,600 B and 200 lines from capcomd's defaults); groundray at ${pinned.slice(0, 12)}, modified 2026-10-01.`);
  expect(brief[1]).toBe(`- [policy] Refunds are accepted within 30 days of delivery → ${placed}/knowledge/policies/refunds.md (stable; 2026-10-01)`);
  expect(a.system).not.toContain("THE-BODY-OF-THE-POLICY");
  // The brain is in the sandbox at that commit, read-only, without history.
  expect(readFileSync(join(placed, "knowledge", "policies", "refunds.md"), "utf8")).toContain("THE-BODY-OF-THE-POLICY");
  expect(statSync(join(placed, "knowledge", "policies", "refunds.md")).mode & 0o222).toBe(0);
  expect(readFileSync(join(placed, ".capcomd-bundle"), "utf8")).toBe(pinned);
  expect(existsSync(join(placed, ".git"))).toBe(false);

  // The brain moves on and the project maps its new tip: the run keeps the commit it started with.
  await brainRepo.pushToMain("knowledge/policies/returns.md", fm(["type: policy", "id: returns", "description: Returns ship back free of charge", "status: stable"], "Returns."));
  expect((await inProject(["context", "brain", "add", "acme", brainRepo.bare])).j?.brain?.commit).toBe((await brainRepo.sha("main"))!);
  const b = await finished(run, "b");
  expect(b.system).toBe(a.system);
  // Outside a run, the brief is the project's mapping now.
  const now = await inProject(["context", "brief", "worker"]);
  expect(now.j?.brief).toContain(`groundray at ${(await brainRepo.sha("main"))!.slice(0, 12)}`);
  expect(now.j?.brief).toContain("Returns ship back free of charge");

  // The run says what each agent was briefed with, and which bundle it got.
  const evs = await capcomd(["events", run, "--json", "--limit", "500"], env);
  expect(evs.stdout).toContain("plugin.context.loaded");
  expect(evs.stdout).toContain(pinned);

  // A restricted brain is refused when it is mapped: nothing is kept.
  const vault = await brainIn({ "brain.yaml": manifest("vault", "urn:uuid:0f1e2d3c-4b5a-4968-8776-5544332211aa"), "knowledge/.core-kb.yaml": coreKb("restricted"), "knowledge/secret.md": fm(["type: concept", "id: s", "description: A restricted fact"], "S.") });
  const before = readFileSync(join(project, ".capcomd", "config.json"), "utf8");
  const refused = await inProject(["context", "brain", "add", "vault", vault.bare, "--branch", "main"]);
  expect(refused.code).not.toBe(0);
  expect(JSON.stringify(refused.j)).toContain("brain vault is restricted (its bundle's default sensitivity is restricted)");
  expect(readFileSync(join(project, ".capcomd", "config.json"), "utf8")).toBe(before);
  expect((await inProject(["context", "brain", "list"])).j?.brains?.map((x: { name: string }) => x.name)).toEqual(["acme"]);
}, 240_000);
