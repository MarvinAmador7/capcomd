// ADR-017 agentic scenario harness: a private engine, a bare git repo (fake sandbox commits),
// CAPCOMD_SPAWN_EXEC=script so every agent is a shell script that drives the in-VM capcomd
// over a local spool. Assertions read the scope (outcome), its event log (trajectory) and
// tree rollups.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

export const PROFILES = {
  schema: "capcomd.agents/v1",
  agents: {
    planner: { provider: "claude", auth: "subscription", maxTurns: 60, children: { allowSpawn: true, maxDepth: 2, maxChildren: 4, maxTotalDescendants: 12, allowedChildProfiles: ["worker", "lead", "critic"], budgetShare: 0.5 } },
    lead: { provider: "claude", auth: "subscription", maxTurns: 40, children: { allowSpawn: true, maxDepth: 1, maxChildren: 3, maxTotalDescendants: 6, allowedChildProfiles: ["worker"], budgetShare: 0.5 } },
    worker: { provider: "claude", auth: "subscription", maxTurns: 20 },
    critic: { provider: "claude", auth: "subscription", maxTurns: 10 },
  },
};

/** Shell helpers available to scripts as $S/<name>. */
const HELPERS: Record<string, string> = {
  // jget PATH: read JSON on stdin, print a dotted path (objects as JSON)
  jget: `#!/bin/sh\nexec node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=JSON.parse(s)}catch{process.exit(3)};for(const k of process.argv[1].split(".").filter(Boolean))v=v==null?v:v[k];console.log(v!==null&&typeof v==="object"?JSON.stringify(v):String(v))})' "$1"\n`,
  // json k=v ...: build a JSON object from string pairs (values that parse as JSON stay JSON)
  json: `#!/bin/sh\nexec node -e 'const o={};for(const a of process.argv.slice(1)){const i=a.indexOf("=");const k=a.slice(0,i),v=a.slice(i+1);try{o[k]=JSON.parse(v)}catch{o[k]=v}}console.log(JSON.stringify(o))' "$@"\n`,
};

export interface World {
  env: Record<string, string>;
  dir: string;
  cj: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string; j: any }>;
  /** Write a named script; returns the contract `script` value that runs it. */
  script: (name: string, body: string) => string;
  stop: () => Promise<void>;
  repo: Awaited<ReturnType<typeof bareRepo>>;
}

export async function world(name: string, extraEnv: Record<string, string> = {}): Promise<World> {
  const repo = await bareRepo({ mode: "direct", extraEnv: { CAPCOMD_MERGE_TARGET: "trunk" } });
  await repo.seed.ok(["push", "-q", "origin", "main:trunk"]);
  const dir = mkdtempSync(join(tmpdir(), `capcomd-scn-${name}-`));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify(PROFILES));
  const S = join(dir, "s");
  mkdirSync(S, { recursive: true });
  for (const [n, body] of Object.entries(HELPERS)) { writeFileSync(join(S, n), body); chmodSync(join(S, n), 0o755); }
  const env: Record<string, string> = {
    ...repo.env, CAPCOMD_AGENTS_FILE: agentsFile, CAPCOMD_SPAWN_EXEC: "script", CAPCOMD_AWAIT_POLL_MS: "100",
    CAPCOMD_DRIVER_LEASE_MS: "3000", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_RPC_KEY: `scn-${name}-${Math.random()}`,
    CAPCOMD_SCRIPT_AWAIT_POLL_MS: "150", CAPCOMD_TRACE_DIR: join(dir, "traces"), ...extraEnv,
  };
  const port = await testPort();
  const engine = new Engine(`scn-${name}`, { port, dataDir: join(dir, "engine") });
  // The engine process reads the same env (kv caps, fake sandbox, repo).
  const saved = { ...process.env };
  Object.assign(process.env, env);
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
  const cj = async (args: string[]) => {
    const x = await capcomd([...args, "--json"], { ...env, PWD: dir });
    let j: any = null;
    try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
    return { ...x, j };
  };
  const script = (n: string, body: string) => {
    const p = join(S, `${n}.sh`);
    writeFileSync(p, `#!/bin/sh\nS=${JSON.stringify(S)}\nexport S\n${body}\n`);
    chmodSync(p, 0o755);
    return `sh ${p}`;
  };
  return {
    env, dir, cj, script, repo,
    stop: async () => { await engine.stop(); for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; },
  };
}

/** Event types of the run's scope log, optionally only for some agents. */
export async function trajectory(w: World, runId: string, filter?: (e: any) => boolean): Promise<Array<{ type: string; agentId: string | null; data: any }>> {
  const { client } = await import("../../src/core/relay");
  const evs = await client().scope.getOrCreate([runId]).getEvents({});
  return evs.filter((e: any) => (filter ? filter(e) : true));
}

/** Assert `want` appears in order (not necessarily contiguous) within `got`. */
export function inOrder(got: string[], want: string[]): boolean {
  let i = 0;
  for (const g of got) if (g === want[i]) i++;
  return i === want.length;
}

export async function newRun(w: World, budget = "usd=10,turns=400,wallSeconds=3600") {
  const r = await w.cj(["run", "new", "--budget", budget, "--key", `scn-${Date.now()}-${Math.random()}`]);
  if (r.code !== 0) throw new Error(`run new failed: ${r.stdout} ${r.stderr}`);
  return r.j.runId as string;
}

export async function spawnRoot(w: World, runId: string, profile: string, script: string, o: { contract?: Record<string, unknown>; args?: string[]; task?: string } = {}) {
  const r = await w.cj(["spawn", runId, "--profile", profile, "--task", o.task ?? `root ${profile}`, "--contract", JSON.stringify({ script, ...(o.contract ?? {}) }), ...(o.args ?? [])]);
  if (r.code !== 0) throw new Error(`spawn failed: ${r.stdout} ${r.stderr}`);
  return r.j.agentId as string;
}

export async function waitAll(w: World, runId: string, ids: string[], timeoutMs = 90_000) {
  return (await w.cj(["await", runId, ...ids, "--timeout-ms", String(timeoutMs)])).j;
}
/** Configurable leaf worker: env FILE CONTENT SPENT SLEEP EXIT SUMMARY. */
export const WORKER = `
[ -n "$SLEEP" ] && sleep "$SLEEP"
if [ -n "$EXIT" ]; then echo "failing on purpose (exit $EXIT)"; exit "$EXIT"; fi
capcomd heartbeat "writing \${FILE:-nothing}" >/dev/null
data=$($S/json file="$($S/json path="\${FILE:-src/$CAPCOMD_AGENT_ID.txt}" content="\${CONTENT:-content}")" spent="$($S/json turns="\${SPENT:-1}")")
capcomd result --summary "\${SUMMARY:-wrote \${FILE:-a file}}" --data "$data" >/dev/null
`;

/** All event types, in order. */
export async function types(w: World, runId: string) { return (await trajectory(w, runId)).map((e) => e.type); }
export async function agentsOf(runId: string) {
  const { client } = await import("../../src/core/relay");
  return client().scope.getOrCreate([runId]).listAgents({});
}

export async function tree(w: World, runId: string) { return (await w.cj(["tree", runId])).j; }
