// ADR-024 `identity.persona` and `harness.cliVersion` against a real engine and runner, with a scripted agent (the fake
// claude in a host-exec sandbox, which leaves the instructions the runner gave it in its work directory). A persona is
// read when the profile resolves, pinned on the agent at spawn by its sha256 (its text kept with the run, never in an
// event) and given to every attempt by agent.preparing as the first text of the agent's instructions, once: before its
// profile's prompt, its skills and the plugins' text. A project's persona waits for the operator's trust, as a project
// skill does (ADR-024 decision 4, `capcomd profiles trust`): a spawn before it, or after the file changed, is refused
// (`untrusted`); an agent already spawned keeps the text it was pinned with; the user's own persona needs no trust. A
// `harness.cliVersion` the CLI its environment recorded doesn't satisfy, or can't be checked against, refuses the spawn
// (`environment`), and `capcomd profiles validate` warns about it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { writeLedger, type EnvRecord } from "../../src/env/resolve";

let engine: Engine;
let env: Record<string, string>;
let dir = "";
const saved = { ...process.env };
const SOUL = "# You are Vera\nA careful security critic. You speak plainly and name the file and line of every finding.";
const SOUL_V2 = "# You are Vera, v2\nA careful security critic. You write every finding as a failing test first.";
const MINE = "# You are Ada\nYou work alone, in small commits.";
const TDD = "---\nname: tdd\ndescription: Test first\n---\n# Test first (profile skill)\nWrite the failing test before the fix.";
const put = (rel: string, text: string) => { const p = join(dir, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };
const build = (name: string, claude: string): EnvRecord => ({ name, manifest: { schema: 1, pins: { claude, codex: "1", node: "1" }, lockHash: "none", lockFile: "none", repo: "" }, versions: { claude: { version: claude, source: "installed" } }, builtAt: "2026-11-08T00:00:00Z", buildMs: 1, depsInstalled: false });

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  dir = mkdtempSync(join(tmpdir(), "capcomd-profile-persona-"));
  const harness = "harness: { provider: claude, auth: apikey }";
  // The project's profiles (the profiles/ next to its agents file): a critic with a persona and a skill, a junior
  // that extends it (its persona is the critic's file, from the critic's directory).
  put("profiles/critic/profile.yaml", ["name: critic", harness, "limits: { maxTurns: 20 }", "identity: { persona: SOUL.md }", "prompt: { append: Review the diff. }", "skills: [{ name: tdd }]"].join("\n"));
  put("profiles/critic/SOUL.md", SOUL);
  put("profiles/critic/skills/tdd/SKILL.md", TDD);
  put("profiles/junior/profile.yaml", ["name: junior", "extends: critic", "prompt: { append: Ask before a big change. }", "skills: []"].join("\n"));
  // The user's own (CAPCOMD_HOME/profiles): its persona needs no trust.
  put("home/profiles/mine/profile.yaml", ["name: mine", harness, "limits: { maxTurns: 20 }", "identity: { persona: SOUL.md }"].join("\n"));
  put("home/profiles/mine/SOUL.md", MINE);
  // harness.cliVersion against the environments the sandbox recorded: an old CLI, a new one, and none (the plain image).
  writeLedger({ history: [build("capcomd-env-oldcli000000000", "2.0.9"), build("capcomd-env-newcli000000000", "2.1.4")] }, join(dir, "envs.json"));
  put("profiles/old-cli/profile.yaml", ["name: old-cli", "harness: { provider: claude, auth: apikey, cliVersion: \">=2.1\" }", "sandbox: { environment: capcomd-env-oldcli000000000 }"].join("\n"));
  put("profiles/new-cli/profile.yaml", ["name: new-cli", "harness: { provider: claude, auth: apikey, cliVersion: \">=2.1 <3\" }", "limits: { maxTurns: 20 }", "sandbox: { environment: capcomd-env-newcli000000000 }"].join("\n"));
  put("profiles/no-cli/profile.yaml", ["name: no-cli", "harness: { provider: claude, auth: apikey, cliVersion: \">=2.1\" }"].join("\n"));
  env = {
    ...r.env,
    CAPCOMD_HOME: join(dir, "home"),
    CAPCOMD_HARNESS_SOCKET: join(dir, "home", "harness.sock"),
    CAPCOMD_AGENTS_FILE: join(dir, "agents.json"),
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_VM_RPC_POLL_MS: "200",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    CAPCOMD_RPC_KEY: `profile-persona-${Math.random()}`,
    ANTHROPIC_API_KEY: "sk-ant-api03-PERSONA-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("profile-persona", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
}, 120_000);

afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};
const newRun = async (key: string) => (await cj(["run", "new", "--key", `${key}-${Date.now()}`])).j.runId as string;
const workDir = (id: string) => join(dir, "vm", readdirSync(join(dir, "vm")).find((d) => d.includes(id))!);
const trySpawn = (run: string, profile: string, key: string, more: string[] = []) => cj(["spawn", run, "--profile", profile, "--task", "Review the login handler", "--key", key, ...more]);
const spawn = async (run: string, profile: string, key: string, more: string[] = []) => {
  const r = await trySpawn(run, profile, key, more);
  if (!r.j?.agentId) console.log(r.stdout, r.stderr);
  expect(r.j?.agentId).toMatch(/^agt-/);
  return r.j.agentId as string;
};
/** The instructions the runner gave the finished agent: Claude Code's appended system prompt. */
async function instructions(run: string, id: string) {
  const done = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  if (done?.status !== "done") console.log(JSON.stringify(done), (await cj(["logs", run, id])).stdout);
  expect(done?.status).toBe("done");
  return readFileSync(join(workDir(id), "append-system.txt"), "utf8");
}
const times = (text: string, part: string) => text.split(part).length - 1;

test("a project's persona waits for the operator's trust: a spawn before it is refused (untrusted)", async () => {
  const run = await newRun("persona-trust");
  const refused = await trySpawn(run, "critic", "early");
  expect(refused.j?.error).toMatchObject({ code: "config", reason: "untrusted", message: "profile critic can't be spawned: its project skill tdd and its project persona SOUL.md aren't trusted" });
  expect(refused.j?.error?.hint).toContain("capcomd profiles trust critic");
  // validate says so too, and `trust` with no name lists it.
  expect((await cj(["profiles", "validate"])).j?.warnings).toContain("profiles.critic: its project persona SOUL.md isn't trusted: capcomd profiles trust critic (a spawn of it is refused until then)");
  expect((await cj(["profiles", "trust"])).j?.profiles?.find((p: { name: string }) => p.name === "critic")?.persona).toMatchObject({ file: "SOUL.md", trust: "untrusted", path: join(dir, "profiles", "critic", "SOUL.md") });
  const trusted = (await cj(["profiles", "trust", "critic", "--yes"])).j?.trusted;
  expect(trusted?.persona).toMatchObject({ file: "SOUL.md", trust: "trusted", hash: `sha256:${new Bun.CryptoHasher("sha256").update(SOUL).digest("hex")}` });
  expect(trusted?.skills?.map((s: { trust: string }) => s.trust)).toEqual(["trusted"]);
}, 60_000);

test("the persona is the first text of the agent's instructions, once, pinned by hash and never in an event", async () => {
  const run = await newRun("persona-first");
  const id = await spawn(run, "critic", "critic");
  const text = await instructions(run, id);
  expect(text.indexOf(SOUL)).toBe(0);
  expect(times(text, "# You are Vera")).toBe(1);
  // Then the profile's own prompt, then its skill.
  expect(text.indexOf("Review the diff.")).toBeGreaterThan(SOUL.length);
  expect(text.indexOf('<skill name="tdd">')).toBeGreaterThan(text.indexOf("Review the diff."));
  // Pinned on its spec by hash, its layer beside it; the text is the run's (an attachment), not the event's.
  const { client } = await import("../../src/core/relay");
  const a = await client().scope.getOrCreate([run]).getAgent({ agentId: id });
  expect((a!.spec as any).persona).toEqual({ source: "project", hash: new Bun.CryptoHasher("sha256").update(SOUL).digest("hex") });
  const ev = (await cj(["events", run, "--from-start", "--until", "agent.spawned", "--timeout-ms", "5000"])).stdout;
  expect(ev).not.toContain("A careful security critic");

  // A profile that extends it has its persona, read from the critic's directory: the same file, trusted already.
  const junior = await instructions(run, await spawn(run, "junior", "junior"));
  expect(junior.indexOf(SOUL)).toBe(0);
  expect(times(junior, "# You are Vera")).toBe(1);
  expect(junior).toContain("Ask before a big change.");
}, 180_000);

test("a changed persona needs trust again; an agent spawned before the change keeps the text it was pinned with", async () => {
  const run = await newRun("persona-pin");
  // Spawned, not started: it is prepared after the edit, and still gets the text it was spawned with.
  const pinned = await spawn(run, "critic", "pinned", ["--no-start"]);
  put("profiles/critic/SOUL.md", SOUL_V2);
  expect((await trySpawn(run, "critic", "unseen")).j?.error).toMatchObject({ reason: "untrusted", message: "profile critic can't be spawned: its project persona SOUL.md (changed since you trusted it) isn't trusted" });
  expect((await cj(["profiles", "trust", "critic", "--yes"])).j?.trusted?.persona?.trust).toBe("trusted");
  const later = await spawn(run, "critic", "later");
  const a = await instructions(run, pinned), b = await instructions(run, later);
  expect(a.indexOf(SOUL)).toBe(0);
  expect(a).not.toContain("v2");
  expect(b.indexOf(SOUL_V2)).toBe(0);
  expect(b).not.toContain("You speak plainly");
}, 180_000);

test("the user's own persona needs no trust", async () => {
  const run = await newRun("persona-user");
  const text = await instructions(run, await spawn(run, "mine", "mine"));
  expect(text.indexOf(MINE)).toBe(0);
  expect(times(text, "# You are Ada")).toBe(1);
}, 180_000);

test("harness.cliVersion: a CLI its environment recorded outside the range, or none recorded, refuses the spawn (environment)", async () => {
  const run = await newRun("persona-cli");
  expect((await trySpawn(run, "old-cli", "old")).j?.error).toMatchObject({ code: "config", reason: "environment", message: "profile old-cli: harness.cliVersion is >=2.1, and the claude CLI in the environment capcomd-env-oldcli000000000 is 2.0.9" });
  const none = (await trySpawn(run, "no-cli", "none")).j?.error;
  expect(none).toMatchObject({ code: "config", reason: "environment" });
  expect(none?.message).toBe("profile no-cli: harness.cliVersion >=2.1 can't be checked: the agent's environment (the sandbox's plain image: no capcomd env build is used) has no recorded claude version");
  expect(none?.hint).toContain("capcomd env build");
  // In range: it is spawned and runs.
  expect(await instructions(run, await spawn(run, "new-cli", "new"))).toBeDefined();
  // validate warns about each before any spawn.
  const warnings: string[] = (await cj(["profiles", "validate"])).j?.warnings ?? [];
  expect(warnings).toContain("profiles.old-cli: harness.cliVersion is >=2.1, and the claude CLI in the environment capcomd-env-oldcli000000000 is 2.0.9 (a spawn of it is refused until then)");
  expect(warnings.some((w) => w.startsWith("profiles.no-cli: harness.cliVersion >=2.1 can't be checked"))).toBe(true);
  expect(warnings.some((w) => w.startsWith("profiles.new-cli:"))).toBe(false);
}, 180_000);
