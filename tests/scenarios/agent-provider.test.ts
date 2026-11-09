// harness.v1 Agent.provider / Agent.model: which AI provider and model each agent runs on, recorded at spawn
// (agent.spawned agent) and reported by GET /v1/runs/{runId}/agents and the snapshot.agents frame. A profile names its
// provider; an agent chosen by CAPCOMD_AGENT has only a runner kind; a fake agent runs no provider at all.
// Agent.profileVersion / profileSource (ADR-024 §2.4): the version and layer of the profile it was spawned with.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { Agent } from "../../src/api/contract";
import { strictEventData } from "../../src/api/legacy-events";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { capcomd } from "../helpers/engine";
import { newRun, trajectory, waitAll, world, type World } from "./harness";

let w: World;
beforeAll(async () => {
  w = await world("provider");
  // Three more profiles next to the harness's: a claude one, a codex one and an fx one, each pinning a model.
  const path = join(w.dir, "agents.json");
  const f = JSON.parse(readFileSync(path, "utf8"));
  f.agents.sonnet = { provider: "claude", auth: "subscription", model: "claude-sonnet-4-5", maxTurns: 10 };
  f.agents.coder = { provider: "codex", auth: "subscription", model: "gpt-5-codex", effort: "high", maxTurns: 10 };
  f.agents.gateway = { provider: "fx", auth: "apikey", model: "anthropic/claude-sonnet-5", effort: "medium", maxTurns: 10 };
  writeFileSync(path, JSON.stringify(f));
}, 120_000);
afterAll(async () => { await w?.stop(); });

async function spawn(run: string, key: string, args: string[], env: Record<string, string> = {}) {
  const done = w.script(`done-${key}`, `capcomd result --summary ok >/dev/null`);
  const r = await capcomd(["spawn", run, "--task", `task ${key}`, "--key", key, "--contract", JSON.stringify({ script: done }), ...args, "--json"], { ...w.env, PWD: w.dir, ...env });
  if (r.code !== 0) throw new Error(`spawn ${key} failed: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!).agentId as string;
}

test("provider and model on GET /v1/runs/{runId}/agents and snapshot.agents: claude, codex and fx profiles, env-chosen and fake agents", async () => {
  const run = await newRun(w);
  const ids = {
    claude: await spawn(run, "claude", ["--profile", "sonnet"]),
    codex: await spawn(run, "codex", ["--profile", "coder"]),
    fx: await spawn(run, "fx", ["--profile", "gateway"], { AI_GATEWAY_API_KEY: "vck_test" }),
    // The harness's worker profile pins no model: the provider CLI picks its default.
    noModel: await spawn(run, "nomodel", ["--profile", "worker"]),
    // CAPCOMD_AGENT picks a runner without a profile; CAPCOMD_AGENT_MODEL is the model it runs with.
    env: await spawn(run, "env", [], { CAPCOMD_AGENT: "codex", CAPCOMD_AGENT_MODEL: "gpt-5-mini" }),
    // A fake agent runs no provider and no model, whatever CAPCOMD_AGENT_MODEL says.
    fake: await spawn(run, "fake", [], { CAPCOMD_AGENT: "fake", CAPCOMD_AGENT_MODEL: "gpt-5-mini" }),
  };
  const want: Record<keyof typeof ids, { provider: string | null; model: string | null }> = {
    claude: { provider: "claude", model: "claude-sonnet-4-5" },
    codex: { provider: "codex", model: "gpt-5-codex" },
    fx: { provider: "fx", model: "anthropic/claude-sonnet-5" },
    noModel: { provider: "claude", model: null },
    env: { provider: "codex", model: "gpt-5-mini" },
    fake: { provider: null, model: null },
  };
  const aw = await waitAll(w, run, Object.values(ids));
  expect(aw.agents.map((a: any) => a.status)).toEqual(Object.values(ids).map(() => "done"));

  // Recorded at spawn: agent.spawned carries the typed `agent` (kind, provider, model), and validates strictly.
  const spawned = new Map((await trajectory(w, run)).filter((e) => e.type === "AGENT_SPAWNED").map((e) => [e.agentId, e.data]));
  expect(spawned.get(ids.claude).agent).toMatchObject({ kind: "claude-code", provider: "claude", model: "claude-sonnet-4-5" });
  expect(spawned.get(ids.codex).agent).toMatchObject({ kind: "codex", provider: "codex", model: "gpt-5-codex", effort: "high" });
  expect(spawned.get(ids.fx).agent).toMatchObject({ kind: "fx", provider: "fx", model: "anthropic/claude-sonnet-5", effort: "medium" });
  expect(spawned.get(ids.env).agent).toEqual({ kind: "codex", model: "gpt-5-mini" });
  expect(spawned.get(ids.fake).agent).toEqual({ kind: "fake" });
  for (const d of spawned.values()) expect(strictEventData("agent.spawned", d)).toEqual({ ok: true });

  const clients = join(w.dir, "harness-clients.json");
  const { token } = addClient("provider", ["read"], clients);
  const app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), pollMs: 100, state: harnessState(null) });
  const req = (p: string) => app.request(p, { headers: { authorization: `Bearer ${token}` } });

  const res = await req(`/v1/runs/${run}/agents`);
  expect(res.status).toBe(200);
  const listed = (await res.json()) as any[];
  expect(listed.length).toBe(6);
  for (const [k, id] of Object.entries(ids)) {
    const a = listed.find((x) => x.id === id);
    expect(Agent.safeParse(a).success).toBe(true);
    expect({ k, provider: a.provider, model: a.model }).toEqual({ k, ...want[k as keyof typeof ids] });
    expect({ k, effort: a.effort }).toEqual({ k, effort: k === "codex" ? "high" : k === "fx" ? "medium" : null });
    // The profile it runs (the harness's agents.json is the project's layer, and its profiles are version 1); an agent
    // CAPCOMD_AGENT picked without a profile has none.
    const profiled = k !== "env" && k !== "fake";
    expect({ k, version: a.profileVersion, source: a.profileSource }).toEqual({ k, version: profiled ? 1 : null, source: profiled ? "project" : null });
    // When it was spawned: a client's elapsed clock for the agent (a snapshot carries no agent.spawned to read it from).
    expect(Date.parse(a.createdAt)).toBeGreaterThan(Date.now() - 120_000);
  }

  // The lifecycle feed's snapshot.agents frame carries the same fields.
  const stream = await req(`/v1/streams/${run}/events?feed=lifecycle`);
  expect(stream.status).toBe(200);
  const r = stream.body!.getReader(); const dec = new TextDecoder(); let t = ""; const end = Date.now() + 10_000;
  while (Date.now() < end && !t.includes("event: snapshot.end")) {
    const x = await Promise.race([r.read(), Bun.sleep(5_000).then(() => null)]);
    if (!x || x.done) break;
    if (x.value) t += dec.decode(x.value);
  }
  r.cancel().catch(() => {});
  const frame = t.split("\n\n").find((f) => f.includes("event: snapshot.agents\n"));
  expect(frame).toBeDefined();
  const snap = JSON.parse(frame!.slice(frame!.indexOf("data: ") + 6));
  const agents = (snap.data?.agents ?? snap.agents) as any[];
  expect(agents.length).toBe(6);
  for (const [k, id] of Object.entries(ids)) {
    const a = agents.find((x) => x.id === id);
    expect({ k, provider: a.provider, model: a.model }).toEqual({ k, ...want[k as keyof typeof ids] });
    expect(a.createdAt).toBe(listed.find((x) => x.id === id).createdAt);
    expect(a.profileVersion).toBe(listed.find((x) => x.id === id).profileVersion);
  }
}, 120_000);

test("profileVersion and profileSource: the version and layer of the profile each agent was spawned with, kept when the profile changes", async () => {
  const run = await newRun(w);
  // A project profile.yaml next to the agents file (.capcomd/profiles/ in a project) at version 3, and one of the
  // user's (~/.capcomd/profiles/) at version 2; the harness's agents.json worker is version 1.
  const project = join(w.dir, "profiles"), user = join(process.env.CAPCOMD_HOME!, "profiles");
  const tester = (version: number) => `schema: capcomd.profile/v2\nname: tester\nversion: ${version}\nharness: { provider: claude, auth: subscription }\nlimits: { maxTurns: 10 }\n`;
  mkdirSync(join(project, "tester"), { recursive: true });
  mkdirSync(user, { recursive: true });
  writeFileSync(join(project, "tester", "profile.yaml"), tester(3));
  writeFileSync(join(user, "scout.yaml"), "schema: capcomd.profile/v2\nname: scout\nversion: 2\nharness: { provider: codex, auth: subscription }\n");
  try {
    const spawnJ = async (key: string, profile: string) => {
      const done = w.script(`pin-${key}`, `capcomd result --summary ok >/dev/null`);
      const r = await capcomd(["spawn", run, "--task", `task ${key}`, "--key", key, "--profile", profile, "--contract", JSON.stringify({ script: done }), "--json"], { ...w.env, PWD: w.dir });
      if (r.code !== 0) throw new Error(`spawn ${key} failed: ${r.stdout} ${r.stderr}`);
      return JSON.parse(r.stdout.trim().split("\n").pop()!);
    };
    const t3 = await spawnJ("t3", "tester"), scout = await spawnJ("scout", "scout"), worker = await spawnJ("worker", "worker");
    // The spawn's own answer says it too (capcomd.v1, additive).
    expect({ version: t3.profileVersion, source: t3.profileSource }).toEqual({ version: 3, source: "project" });
    // An edit after the spawn: the next agent gets the new version, the one already spawned keeps its own.
    writeFileSync(join(project, "tester", "profile.yaml"), tester(4));
    const t4 = await spawnJ("t4", "tester");
    // A keyed retry of the first spawn after the edit is the same spawn (the version is outside its params hash): the
    // same agent, still at the version it was first recorded with.
    const retried = await spawnJ("t3", "tester");
    expect({ id: retried.agentId, created: retried.created, version: retried.profileVersion }).toEqual({ id: t3.agentId, created: false, version: 3 });
    const want = new Map<string, [number, string]>([[t3.agentId, [3, "project"]], [t4.agentId, [4, "project"]], [scout.agentId, [2, "user"]], [worker.agentId, [1, "project"]]]);
    const ids = [...want.keys()];
    expect((await waitAll(w, run, ids)).agents.map((a: any) => a.status)).toEqual(ids.map(() => "done"));

    const spawned = new Map((await trajectory(w, run)).filter((e) => e.type === "AGENT_SPAWNED").map((e) => [e.agentId, e.data]));
    for (const [id, [version, source]] of want) {
      expect({ id, version: spawned.get(id).profileVersion, source: spawned.get(id).profileSource }).toEqual({ id, version, source });
      expect(strictEventData("agent.spawned", spawned.get(id))).toEqual({ ok: true });
    }

    const clients = join(w.dir, "harness-clients-pin.json");
    const { token } = addClient("pin", ["read"], clients);
    const app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), pollMs: 100, state: harnessState(null) });
    const res = await app.request(`/v1/runs/${run}/agents`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const listed = (await res.json()) as any[];
    for (const [id, [version, source]] of want) {
      const a = listed.find((x) => x.id === id);
      expect(Agent.safeParse(a).success).toBe(true);
      expect({ id, version: a.profileVersion, source: a.profileSource }).toEqual({ id, version, source });
    }
    // The agent's own record after the profile changed: still the version it was spawned with.
    const shown = (await w.cj(["inspect", run, t3.agentId])).j;
    expect({ version: shown.profileVersion, source: shown.profileSource }).toEqual({ version: 3, source: "project" });
    // And its text line names it next to the profile.
    const line = await capcomd(["inspect", run, t3.agentId], { ...w.env, PWD: w.dir });
    expect(line.stdout.split("\n")[0]).toContain(`${t3.agentId} [tester v3, project] done`);
  } finally {
    rmSync(join(project, "tester"), { recursive: true, force: true });
    rmSync(join(user, "scout.yaml"), { force: true });
  }
}, 120_000);
