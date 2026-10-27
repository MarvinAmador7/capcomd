// harness.v1 Agent.provider / Agent.model: which AI provider and model each agent runs on, recorded at spawn
// (agent.spawned agent) and reported by GET /v1/runs/{runId}/agents and the snapshot.agents frame. A profile names its
// provider; an agent chosen by CAPCOMD_AGENT has only a runner kind; a fake agent runs no provider at all.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
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
  // Two more profiles next to the harness's: a claude one and a codex one, each pinning a model.
  const path = join(w.dir, "agents.json");
  const f = JSON.parse(readFileSync(path, "utf8"));
  f.agents.sonnet = { provider: "claude", auth: "subscription", model: "claude-sonnet-4-5", maxTurns: 10 };
  f.agents.coder = { provider: "codex", auth: "subscription", model: "gpt-5-codex", maxTurns: 10 };
  writeFileSync(path, JSON.stringify(f));
}, 120_000);
afterAll(async () => { await w?.stop(); });

async function spawn(run: string, key: string, args: string[], env: Record<string, string> = {}) {
  const done = w.script(`done-${key}`, `capcomd result --summary ok >/dev/null`);
  const r = await capcomd(["spawn", run, "--task", `task ${key}`, "--key", key, "--contract", JSON.stringify({ script: done }), ...args, "--json"], { ...w.env, PWD: w.dir, ...env });
  if (r.code !== 0) throw new Error(`spawn ${key} failed: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!).agentId as string;
}

test("provider and model on GET /v1/runs/{runId}/agents and snapshot.agents: claude and codex profiles, env-chosen and fake agents", async () => {
  const run = await newRun(w);
  const ids = {
    claude: await spawn(run, "claude", ["--profile", "sonnet"]),
    codex: await spawn(run, "codex", ["--profile", "coder"]),
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
    noModel: { provider: "claude", model: null },
    env: { provider: "codex", model: "gpt-5-mini" },
    fake: { provider: null, model: null },
  };
  const aw = await waitAll(w, run, Object.values(ids));
  expect(aw.agents.map((a: any) => a.status)).toEqual(Object.values(ids).map(() => "done"));

  // Recorded at spawn: agent.spawned carries the typed `agent` (kind, provider, model), and validates strictly.
  const spawned = new Map((await trajectory(w, run)).filter((e) => e.type === "AGENT_SPAWNED").map((e) => [e.agentId, e.data]));
  expect(spawned.get(ids.claude).agent).toMatchObject({ kind: "claude-code", provider: "claude", model: "claude-sonnet-4-5" });
  expect(spawned.get(ids.codex).agent).toMatchObject({ kind: "codex", provider: "codex", model: "gpt-5-codex" });
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
  expect(listed.length).toBe(5);
  for (const [k, id] of Object.entries(ids)) {
    const a = listed.find((x) => x.id === id);
    expect(Agent.safeParse(a).success).toBe(true);
    expect({ k, provider: a.provider, model: a.model }).toEqual({ k, ...want[k as keyof typeof ids] });
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
  expect(agents.length).toBe(5);
  for (const [k, id] of Object.entries(ids)) {
    const a = agents.find((x) => x.id === id);
    expect({ k, provider: a.provider, model: a.model }).toEqual({ k, ...want[k as keyof typeof ids] });
  }
}, 120_000);
