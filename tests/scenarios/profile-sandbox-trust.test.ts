// ADR-024 §9, the owner's decision of 2026-11-08: where an agent's machine goes when its profile names a
// `sandbox.provider`. (1) A run started with a sandbox of its own (`capcomd run --sandbox`, POST /v1/runs `sandbox`,
// capcomd_run_new's) keeps every agent there, whatever the profile names, and asks no trust for it. (2) Otherwise a
// project's profile file that sets the provider (or the environment or size of that machine) is honoured only once the
// operator has trusted it as it is (`capcomd profiles trust`, per file hash, refusal reason `untrusted`); a changed file
// needs trusting again, and the user's own profiles need none. A run whose sandbox comes from its settings
// (CAPCOMD_SANDBOX, the project's or the user's config) is not one it asked for. Scripted agents on the test sandboxes:
// the daemon's in-memory fake, and fake-host (the host-exec fake) as the "other" sandbox; Docker and boxd only as names
// on agents spawned without a start, so nothing is made there.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { capcomd } from "../helpers/engine";
import { RUN_SANDBOX_KV } from "../../src/providers/run-sandbox";
import { newRun, waitAll, world, type World } from "./harness";

let w: World;
let home = "";
const yaml = (lines: string[]) => lines.join("\n") + "\n";
const FAR = yaml(["name: far", "extends: worker", "sandbox: { provider: boxd }"]);
const HOSTED = yaml(["name: hosted", "extends: worker", "sandbox: { provider: fake-host }"]);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "capcomd-scn-sbtrust-home-"));
  w = await world("sandbox-trust", { CAPCOMD_HOME: home });
  // The project's profiles (the profiles/ next to the run's agents file): far names boxd, hosted the other test sandbox.
  mkdirSync(join(w.dir, "profiles"), { recursive: true });
  writeFileSync(join(w.dir, "profiles", "far.yaml"), FAR);
  writeFileSync(join(w.dir, "profiles", "hosted.yaml"), HOSTED);
  // The user's own (CAPCOMD_HOME/profiles): it names the other sandbox too, and needs no trust.
  mkdirSync(join(home, "profiles"), { recursive: true });
  writeFileSync(join(home, "profiles", "mine.yaml"), yaml(["name: mine", "harness: { provider: claude, auth: subscription }", "limits: { maxTurns: 20 }", "sandbox: { provider: fake-host }"]));
}, 120_000);
afterAll(async () => {
  try { await w?.stop(); } finally { if (home) rmSync(home, { recursive: true, force: true }); }
});

const done = () => w.script(`sb-done-${Math.random().toString(36).slice(2, 8)}`, `capcomd result --summary ok >/dev/null`);
const spawn = (run: string, profile: string, key: string, ...extra: string[]) =>
  w.cj(["spawn", run, "--profile", profile, "--task", "t", "--key", key, "--contract", JSON.stringify({ script: done() }), ...extra]);
const machineOf = async (run: string, id: string): Promise<string | undefined> => {
  const { client } = await import("../../src/core/relay");
  return ((await client().worker.getOrCreate([run, id]).getWorker({ workerId: id })) as any)?.context?.sandbox;
};
const pinned = async (run: string, id: string): Promise<Record<string, unknown>> => {
  const { client } = await import("../../src/core/relay");
  return ((await client().scope.getOrCreate([run]).getAgent({ agentId: id })) as any).spec;
};
const agentsOf = async (run: string) => {
  const { client } = await import("../../src/core/relay");
  return client().scope.getOrCreate([run]).listAgents({});
};
/** A run whose sandbox comes from its settings (CAPCOMD_SANDBOX in the shell), not from --sandbox. */
const runOnSettings = async (name: string) => {
  const r = await capcomd(["run", "new", "--label", `on ${name}`, "--key", `sbt-${name}-${Date.now()}-${Math.random()}`, "--json"], { ...w.env, CAPCOMD_SANDBOX: name });
  const j = JSON.parse(r.stdout.trim().split("\n").pop()!);
  expect(j.sandbox).toEqual({ name, source: "environment" });
  return j.runId as string;
};

test("a run started with --sandbox keeps the untrusted project profile's agents on its own sandbox: no trust asked", async () => {
  // Docker asked for, the project's profile names boxd: the agent is pinned without boxd, so its machine is the run's.
  const docker = await w.cj(["run", "new", "--sandbox", "docker", "--label", "docker asked", "--key", `sbt-docker-${Date.now()}`]);
  expect(docker.j.sandbox).toEqual({ name: "docker", source: "run" });
  expect((await w.cj(["kv", "get", docker.j.runId, RUN_SANDBOX_KV])).j.value).toMatchObject({ name: "docker", explicit: true });
  const far = await spawn(docker.j.runId, "far", "far", "--no-start");
  expect(far.code).toBe(0);
  expect(await pinned(docker.j.runId, far.j.agentId)).not.toHaveProperty("sandboxProvider");

  // The same with machines made: the run asked for the in-memory fake, the profile names fake-host.
  const asked = await w.cj(["run", "new", "--sandbox", "fake", "--label", "fake asked", "--key", `sbt-fake-${Date.now()}`]);
  const hosted = await spawn(asked.j.runId, "hosted", "hosted");
  expect(hosted.code).toBe(0);
  expect((await waitAll(w, asked.j.runId, [hosted.j.agentId])).agents[0].status).toBe("done");
  expect(await machineOf(asked.j.runId, hosted.j.agentId)).toBe("fake");
  expect(await pinned(asked.j.runId, hosted.j.agentId)).not.toHaveProperty("sandboxProvider");
}, 120_000);

test("without --sandbox an untrusted project profile is refused (untrusted); trusted, its agent goes to its sandbox; changed, it is refused again", async () => {
  // Docker from the settings, boxd from the project's profile: refused before anything is recorded.
  const docker = await runOnSettings("docker");
  const refused = await spawn(docker, "far", "far", "--no-start");
  expect(refused.code).not.toBe(0);
  expect(refused.j?.error).toMatchObject({ code: "config", reason: "untrusted", message: "profile far can't be spawned: it sends its agents to the boxd sandbox, and the project's profile file that sets that, far.yaml (sandbox.provider), isn't trusted" });
  expect(refused.j.error.hint).toContain("capcomd profiles trust far");
  expect(await agentsOf(docker)).toEqual([]);

  // `capcomd profiles show` and the listing say so.
  const shown = await w.cj(["profiles", "show", "far"]);
  expect(shown.j.machine).toEqual({ provider: "boxd", runSandboxWins: true, files: [{ path: join(w.dir, "profiles", "far.yaml"), layer: "project", keys: ["sandbox.provider"], hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), trust: "untrusted" }] });
  const listed = (await w.cj(["profiles", "list"])).j.profiles.find((p: any) => p.name === "far");
  expect(listed.untrustedSandbox).toEqual(["far.yaml"]);

  // Trusted: the agent is pinned with boxd (spawned without a start: nothing is made there).
  expect((await w.cj(["profiles", "trust", "far", "--yes"])).j.trusted).toMatchObject({ name: "far", already: false, sandbox: [{ file: "far.yaml", trust: "trusted" }] });
  const far = await spawn(docker, "far", "far", "--no-start");
  expect(far.code).toBe(0);
  expect(await pinned(docker, far.j.agentId)).toMatchObject({ sandboxProvider: "boxd" });
  expect((await w.cj(["profiles", "show", "far"])).j.machine.files[0].trust).toBe("trusted");

  // With machines made: on the daemon's sandbox, the project's hosted is refused, then trusted and made on fake-host.
  const plain = await newRun(w);
  expect((await spawn(plain, "hosted", "h1")).j?.error).toMatchObject({ code: "config", reason: "untrusted" });
  expect((await w.cj(["profiles", "trust", "hosted", "--yes"])).code).toBe(0);
  const hosted = await spawn(plain, "hosted", "h2");
  expect(hosted.code).toBe(0);
  expect((await waitAll(w, plain, [hosted.j.agentId])).agents[0].status).toBe("done");
  expect(await machineOf(plain, hosted.j.agentId)).toBe("fake-host");

  // The file changed since it was trusted: refused again, saying so, until it is trusted as it is now.
  writeFileSync(join(w.dir, "profiles", "hosted.yaml"), HOSTED + "# moved to the other sandbox on purpose\n");
  const again = await spawn(plain, "hosted", "h3");
  expect(again.j?.error).toMatchObject({ code: "config", reason: "untrusted", message: expect.stringContaining("hosted.yaml (sandbox.provider) changed since you trusted it") });
  expect((await w.cj(["profiles", "show", "hosted"])).j.machine.files[0].trust).toBe("changed");
  // A run started with its own sandbox doesn't wait on it.
  const asked = await w.cj(["run", "new", "--sandbox", "fake", "--label", "fake asked", "--key", `sbt-fake2-${Date.now()}`]);
  expect((await spawn(asked.j.runId, "hosted", "h4", "--no-start")).code).toBe(0);
}, 120_000);

test("the user's own profile moves its agents to its sandbox without trust", async () => {
  const plain = await newRun(w);
  const mine = await spawn(plain, "mine", "mine");
  expect(mine.code).toBe(0);
  expect((await waitAll(w, plain, [mine.j.agentId])).agents[0].status).toBe("done");
  expect(await machineOf(plain, mine.j.agentId)).toBe("fake-host");
  expect((await w.cj(["profiles", "show", "mine"])).j.machine).toEqual({ provider: "fake-host", runSandboxWins: true, files: [{ path: join(home, "profiles", "mine.yaml"), layer: "user", keys: ["sandbox.provider"], hash: expect.stringMatching(/^sha256:/) }] });
  // An explicit --sandbox beats the user's own profile too.
  const asked = await w.cj(["run", "new", "--sandbox", "fake", "--label", "fake asked", "--key", `sbt-fake3-${Date.now()}`]);
  const kept = await spawn(asked.j.runId, "mine", "mine");
  expect((await waitAll(w, asked.j.runId, [kept.j.agentId])).agents[0].status).toBe("done");
  expect(await machineOf(asked.j.runId, kept.j.agentId)).toBe("fake");
}, 120_000);

test("capcomd run refuses a planner whose untrusted project profile moves its agents, before the run starts", async () => {
  writeFileSync(join(w.dir, "profiles", "boss.yaml"), yaml(["name: boss", "extends: planner", "sandbox: { provider: fake-host }"]));
  const r = await w.cj(["run", "--planner", "boss", "--detach", "build the thing"]);
  expect(r.code).not.toBe(0);
  expect(r.j?.error).toMatchObject({ code: "config", reason: "untrusted", message: expect.stringContaining("profile boss can't be spawned: it sends its agents to the fake-host sandbox") });
  // With --sandbox the run's own place wins, at the pre-check and at the spawn: no trust asked, and the planner's
  // machine is made on the run's sandbox, not the one its untrusted profile names.
  const planner = w.script("sbt-boss", `capcomd result --summary ok >/dev/null`);
  const ran = await capcomd(["run", "plan nothing", "--planner", "boss", "--sandbox", "fake", "--no-goal-branch", "--json"], { ...w.env, CAPCOMD_SCRIPT_PLANNER: planner, PWD: w.dir });
  if (ran.code !== 0) console.log(ran.stdout.slice(-3000), ran.stderr.slice(-2000));
  expect(ran.code).toBe(0);
  const lines = ran.stdout.trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const root = lines.find((l) => l.type === "planner.spawned")?.agentId as string;
  expect(await machineOf(lines[0].runId, root)).toBe("fake");
  expect(await pinned(lines[0].runId, root)).not.toHaveProperty("sandboxProvider");
}, 120_000);
