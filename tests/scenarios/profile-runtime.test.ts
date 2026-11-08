// ADR-024 §7 step 8, one scenario per block, with scripted agents (CAPCOMD_SPAWN_EXEC=script) and the recording plugin
// (tests/plugins/fixtures/hook-recorder) in the daemon: `tools.mcp` is pinned on the agent at spawn and reaches whoever
// prepares it (agent.preparing's spec; the runner's wiring is tests/agents/profile-runtime.test.ts); `sandbox.provider`,
// `environment` and `size` decide where the agent's machine is made, from what and how big (sandbox.ensuring, the
// destroy), whatever the run's sandbox; `lifecycle.onStart|onEnd` reach the named plugin on agent.changed, and a profile
// naming a plugin that isn't there is refused, from the host and from an agent's VM. Plus what `profiles validate` says.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { world, newRun, spawnRoot, waitAll, WORKER, type World } from "./harness";
import { writeLedger } from "../../src/env/resolve";
import type { Recorded } from "../plugins/fixtures/hook-recorder/index";

const RECORDER = join(import.meta.dir, "..", "plugins", "fixtures", "hook-recorder");
const ENV = "capcomd-env-scnprofile0000";
let w: World;
let logDir: string | undefined;
let log: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const calls = (): Recorded[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Recorded) : []);
const yaml = (lines: string[]) => lines.join("\n") + "\n";

beforeAll(async () => {
  logDir = mkdtempSync(join(tmpdir(), "capcomd-profile-runtime-"));
  log = join(logDir, "hooks.ndjson");
  // The run's sandbox (the fake) has one environment build besides none current.
  const ledger = join(logDir, "envs.json");
  writeLedger({ history: [{ name: ENV, manifest: { schema: 1, pins: { claude: "1", codex: "1", node: "1" }, lockHash: "none", lockFile: "none", repo: "" }, versions: {}, builtAt: "2026-11-06T00:00:00Z", buildMs: 1, depsInstalled: false }] }, ledger);
  w = await world("profile-runtime", { CAPCOMD_TEST_PLUGINS: RECORDER, CAPCOMD_TEST_HOOK_LOG: log, NODE_ENV: "test", CAPCOMD_ENV_LEDGER: ledger });
  // The project's profiles (the `profiles/` next to the run's agents file), over the harness's agents.json ones.
  const dir = join(w.dir, "profiles");
  mkdirSync(dir, { recursive: true });
  const put = (name: string, lines: string[]) => writeFileSync(join(dir, `${name}.yaml`), yaml([`name: ${name}`, ...lines]));
  put("tooled", ["extends: worker", "tools:", "  mcp:", "    - { name: semgrep, command: [semgrep-mcp, --quiet] }", "    - { name: docs, command: [docs-mcp], trust: trusted }"]);
  put("placed", ["extends: worker", `sandbox: { provider: fake-host, environment: ${ENV}, size: { vcpu: 2 } }`]);
  put("stray", ["extends: worker", "sandbox: { environment: capcomd-env-gone }"]);
  put("watched", ["extends: worker", "lifecycle: { onEnd: [hook-recorder] }"]);
  put("unwatched", ["extends: worker", "lifecycle: { onStart: [not-loaded] }"]);
  put("boss", ["extends: planner", "children: { allowedChildProfiles: [watched, unwatched] }"]);
  // The project's file that sends placed's agents to another sandbox is honoured once the operator trusts it (ADR-024
  // §9, 2026-11-08; tests/scenarios/profile-sandbox-trust.test.ts).
  const trusted = await w.cj(["profiles", "trust", "placed", "--yes"]);
  if (trusted.code !== 0) throw new Error(`profiles trust placed: ${trusted.stdout} ${trusted.stderr}`);
  for (let i = 0; i < 300 && !calls().some((c) => c.hook === "daemon.started"); i++) await sleep(100);
}, 120_000);
afterAll(async () => {
  try { await w?.stop(); } finally { if (logDir) rmSync(logDir, { recursive: true, force: true }); }
});

const of = (hook: string, agentId: string) => (c: Recorded) => c.hook === hook && (c.agentId === agentId || c.subject === agentId);
const settle = async (pred: () => boolean) => { for (let i = 0; i < 50 && !pred(); i++) await sleep(100); };

test("tools.mcp: the servers are pinned on the agent at spawn and reach whoever prepares it", async () => {
  const run = await newRun(w);
  const id = await spawnRoot(w, run, "tooled", w.script("tooled", WORKER));
  expect((await waitAll(w, run, [id])).agents[0].status).toBe("done");
  const prep = calls().find(of("agent.preparing", id));
  expect(prep?.prepared?.mcp).toEqual([{ name: "semgrep", command: ["semgrep-mcp", "--quiet"], trust: "untrusted" }, { name: "docs", command: ["docs-mcp"], trust: "trusted" }]);
  // The agent's record has them with its spec, as it was resolved (the agent.spawned event's `agent`).
  const { client } = await import("../../src/core/relay");
  const a = await client().scope.getOrCreate([run]).getAgent({ agentId: id });
  expect((a!.spec as any).mcp).toEqual(prep!.prepared!.mcp);
}, 120_000);

test("sandbox: the machine is made on the profile's sandbox, from its environment, at its size; the run's elsewhere", async () => {
  const run = await newRun(w);
  const placed = await spawnRoot(w, run, "placed", w.script("placed", WORKER));
  const plain = await spawnRoot(w, run, "worker", w.script("plain", WORKER), { args: ["--key", "plain"] });
  const done = (await waitAll(w, run, [placed, plain])).agents;
  expect(done.map((a: any) => a.status)).toEqual(["done", "done"]);
  await settle(() => calls().some((c) => c.hook === "sandbox.changed" && c.agentId === placed && c.change === "destroyed"));
  const all = calls();
  expect(all.find(of("sandbox.ensuring", placed))?.machine).toEqual({ provider: "fake-host", purpose: "agent", size: { vcpu: 2 }, fromSnapshot: ENV });
  expect(all.find(of("sandbox.ensuring", plain))?.machine).toEqual({ provider: "fake", purpose: "agent", size: null, fromSnapshot: null });
  expect(all.find(of("agent.preparing", placed))?.prepared?.sandbox).toEqual({ provider: "fake-host", environment: ENV });
  expect(all.find(of("agent.preparing", plain))?.prepared?.sandbox).toEqual({ provider: "fake", environment: null });
  // Its machine went where it was made: its work landed on its branch and its machine was destroyed there.
  expect(done[0].result.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(all.some((c) => c.hook === "sandbox.changed" && c.agentId === placed && c.change === "destroyed")).toBe(true);

  // An environment the agent's sandbox doesn't have refuses the spawn, before anything is recorded.
  const r = await w.cj(["spawn", run, "--profile", "stray", "--task", "t", "--contract", JSON.stringify({ script: w.script("stray", WORKER) })]);
  expect(r.code).not.toBe(0);
  expect(r.j?.error).toMatchObject({ code: "config", reason: "environment", message: expect.stringContaining("sandbox.environment capcomd-env-gone isn't an environment of the fake sandbox") });
}, 120_000);

test("sandbox: a profile can't take its agents out of isolation onto this host when the run's sandbox isolates them", async () => {
  // The run is recorded on Docker from its settings (CAPCOMD_SANDBOX, not --sandbox, which would beat the profile's;
  // nothing is made there: the spawn is refused first); the profile names fake-host, which runs the agent, and its MCP
  // servers, on this host.
  const { capcomd } = await import("../helpers/engine");
  const made = await capcomd(["run", "new", "--label", "isolated", "--key", `scn-iso-${Date.now()}`, "--json"], { ...w.env, CAPCOMD_SANDBOX: "docker" });
  const { runId, sandbox } = JSON.parse(made.stdout.trim().split("\n").pop()!);
  expect(sandbox).toEqual({ name: "docker", source: "environment" });
  const r = await w.cj(["spawn", runId, "--profile", "placed", "--task", "t", "--no-start", "--contract", JSON.stringify({ script: w.script("escape", WORKER) })]);
  expect(r.code).not.toBe(0);
  expect(r.j?.error).toMatchObject({ code: "config", reason: "sandbox_isolation", message: expect.stringContaining("sandbox.provider fake-host runs its agents on this host") });
  const { client } = await import("../../src/core/relay");
  expect(await client().scope.getOrCreate([runId]).listAgents({})).toEqual([]);
}, 60_000);

test("lifecycle: the named plugin hears the agent's changes with its names; a plugin that isn't there refuses the spawn", async () => {
  const run = await newRun(w);
  const worker = w.script("leaf", WORKER);
  // From an agent's VM (the daemon resolves and checks the spawn): one profile named a plugin it has, one it doesn't.
  const boss = w.script("boss", `W=${JSON.stringify(worker)}
id=$(capcomd spawn --profile watched --task "watched" --key w --contract "$($S/json script="$W")" | $S/jget agentId)
echo "child=$id"
capcomd await $id >/dev/null || exit 1
out=$(capcomd spawn --profile unwatched --task "unwatched" --key u --contract "$($S/json script="$W")" 2>/dev/null)
echo "refused=$(echo "$out" | $S/jget error.reason)"
capcomd result --summary done >/dev/null`);
  const root = await spawnRoot(w, run, "boss", boss);
  const done = (await waitAll(w, run, [root], 120_000)).agents[0];
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  const child = /child=(agt-\S+)/.exec(logs)![1]!;
  expect(logs).toContain("refused=lifecycle_inactive");
  await settle(() => calls().some((c) => c.hook === "agent.changed" && c.subject === child && c.change === "ended"));
  const changes = calls().filter((c) => c.hook === "agent.changed" && c.subject === child);
  expect(changes.map((c) => c.change)).toEqual(expect.arrayContaining(["spawned", "started", "ended"]));
  for (const c of changes) expect(c.lifecycle).toEqual({ onStart: [], onEnd: ["hook-recorder"] });
  // An agent whose profile names none: no lifecycle on its changes.
  for (const c of calls().filter((x) => x.hook === "agent.changed" && x.subject === root)) expect(c.lifecycle).toBeUndefined();

  // From the host (the CLI asks the running daemon's plugin listing): the same refusal.
  const r = await w.cj(["spawn", run, "--profile", "unwatched", "--task", "t", "--contract", JSON.stringify({ script: worker })]);
  expect(r.code).not.toBe(0);
  expect(r.j?.error).toMatchObject({ code: "config", reason: "lifecycle_inactive", message: expect.stringContaining("lifecycle names not-loaded, which isn't an active plugin listening to agent.changed") });
}, 180_000);

test("lifecycle: an agent whose named plugin is gone by its start fails as config, before its machine is made", async () => {
  const run = await newRun(w);
  const ok = await spawnRoot(w, run, "watched", w.script("pre", WORKER), { args: ["--no-start"] });
  const { client } = await import("../../src/core/relay");
  const scope = client().scope.getOrCreate([run]);
  const a: any = await scope.getAgent({ agentId: ok });
  // As if the plugin was turned off since the spawn (which checked it): the same record, naming one the daemon hasn't.
  const id = `agt-gone${Date.now()}`;
  await scope.spawn({ runId: run, agentId: id, key: "gone", paramsHash: "gone", parent: null, profile: a.profile, ref: a.ref, spec: { ...a.spec, lifecycle: { onStart: ["not-loaded"], onEnd: [] } },
    task: "t", contract: a.contract, operator: false, ...(a.driveEnv ? { driveEnv: a.driveEnv } : {}) });
  const { startDriver } = await import("../../src/primitives/drivers");
  await startDriver(run, id);
  const done = (await waitAll(w, run, [id])).agents[0];
  expect(done.status).toBe("failed");
  expect(JSON.stringify(done.result)).toContain("lifecycle names not-loaded");
  expect(calls().some(of("sandbox.ensuring", id))).toBe(false);
}, 120_000);

test("profiles validate:a lifecycle plugin the daemon hasn't is an error; an environment its sandbox hasn't, a warning", async () => {
  const r = await w.cj(["profiles", "validate"]);
  expect(r.code).toBe(2);
  expect(r.j).toMatchObject({ ok: false });
  expect(r.j.errors).toEqual([expect.stringContaining("profiles.unwatched: lifecycle names not-loaded")]);
  expect(r.j.warnings).toEqual([expect.stringContaining("profiles.stray: sandbox.environment capcomd-env-gone isn't an environment of the fake sandbox")]);
}, 60_000);
