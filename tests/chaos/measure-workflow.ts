// ADR-022 measurements: workflow history size and engine memory for agents driven by the workflow (fake agents on the
// in-memory sandbox, a slowed push standing in for a long run). Private port and data dir only.
//   bun tests/chaos/measure-workflow.ts long  <port> <runSeconds> <watchMs>   one agent, many watch iterations
//   bun tests/chaos/measure-workflow.ts many  <port> <runSeconds> <watchMs> <n> [idleSeconds]  n agents at once
import { mkdtempSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { Engine } from "./engine";

const [mode = "long", portArg, secsArg = "180", watchArg = "50", nArg = "12", idleArg = "0"] = process.argv.slice(2);
const idleMs = Number(idleArg) * 1000; // keep sampling this long after the agents end (does the engine's data shrink?)
const port = Number(portArg);
const runMs = Number(secsArg) * 1000, watchMs = Number(watchArg), n = mode === "many" ? Number(nArg) : 1;
const dataDir = mkdtempSync(join(tmpdir(), "capcomd-measure-wf-"));
// MEASURE_WORKFLOW=0 measures the driver-process path instead (the baseline).
const env = { CAPCOMD_AGENT_WORKFLOW: process.env.MEASURE_WORKFLOW ?? "1", CAPCOMD_SANDBOX: "fake", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_FAKE_PUSH_DELAY_MS: String(runMs) };
Object.assign(process.env, env, { CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_NO_CONFIG: "1" }, watchMs > 0 ? { CAPCOMD_AGENT_WORKFLOW_POLL_MS: String(watchMs) } : {});
const engine = new Engine(`measure-wf-${mode}-${port}`, { port, dataDir, env });
const endpoint = `http://127.0.0.1:${port}`;
process.env.CAPCOMD_ENDPOINT = endpoint;

const du = (d: string): number => { let t = 0; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); t += e.isDirectory() ? du(p) : statSync(p).size; } return t; };
const rssKb = (pid: number) => Number((spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim()) || 0;
const kids = (pid: number) => (spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout ?? "").split(/\s+/).map(Number).filter(Boolean);
function processes(): { host: number; engine: number } {
  const root = (engine as any).child?.pid as number;
  const host = kids(root)[0] ?? root; // serve re-execs itself: the engine host is its child
  const eng = Number(require("fs").readFileSync(join(dataDir, "engine.pid"), "utf8").trim());
  return { host, engine: eng };
}
await engine.start(null);
try {
  const ops = await import("../../src/primitives/ops");
  const { client } = await import("../../src/core/relay");
  const { runId } = await ops.runNew({ budget: { usd: 100 }, label: `measure ${mode}`, key: `measure-${mode}-${Date.now()}` });
  const t0 = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await ops.spawnAgent({ runId, profile: undefined as any, task: `measure ${i}`, key: `m${i}`, budget: { usd: 1 } } as any)).agentId);
  const workers = ids.map((id) => (client() as any).worker.getOrCreate([runId, id]));
  const procs = processes();
  const sample = async () => {
    const hs: any[] = env.CAPCOMD_AGENT_WORKFLOW === "0" ? [] : await Promise.all(workers.map((w: any) => w.getWorkflowStats().catch(() => null)));
    const known = hs.filter(Boolean) as { rows: number; bytes: number; dbBytes: number }[];
    // The driver path's agent-drive processes (one per running agent), which the workflow path doesn't have.
    const drivers = (spawnSync("ps", ["-A", "-o", "rss=,command="], { encoding: "utf8" }).stdout ?? "").split("\n").filter((l) => l.includes(` agent-drive ${runId} `));
    const driversRssMb = Math.round(drivers.reduce((a, l) => a + (Number(l.trim().split(/\s+/)[0]) || 0), 0) / 1024);
    return { s: Math.round((Date.now() - t0) / 1000), drivers: drivers.length, driversRssMb, hostRssMb: Math.round(rssKb(procs.host) / 1024), engineRssMb: Math.round(rssKb(procs.engine) / 1024),
      dataMb: +(du(join(dataDir, "db")) / 1048576).toFixed(1), historyRowsMax: Math.max(0, ...known.map((h) => h.rows)), historyKbMax: +(Math.max(0, ...known.map((h) => h.bytes)) / 1024).toFixed(1),
      historyKbTotal: +(known.reduce((a, h) => a + h.bytes, 0) / 1024).toFixed(1), actorDbKbMax: +(Math.max(0, ...known.map((h) => h.dbBytes)) / 1024).toFixed(1), looksMax: Math.max(0, ...known.map((h: any) => h.looks ?? 0)) };
  };
  const rows: any[] = [];
  const s = () => client().scope.getOrCreate([runId]);
  for (;;) {
    rows.push(await sample());
    console.log(JSON.stringify(rows.at(-1)));
    const agents: any[] = await (s() as any).listAgents({});
    if (agents.every((a) => ["done", "failed", "cancelled"].includes(a.status))) { console.log(`statuses ${agents.map((a) => a.status).join(",")}`); break; }
    if (Date.now() - t0 > runMs + 300_000) { console.log("timeout"); break; }
    await Bun.sleep(Math.max(5000, Math.min(30_000, runMs / 20)));
  }
  for (const end = Date.now() + idleMs; Date.now() < end;) { await Bun.sleep(15_000); rows.push(await sample()); console.log(`idle ${JSON.stringify(rows.at(-1))}`); }
  rows.push(await sample());
  console.log(`FINAL ${JSON.stringify({ mode, n, runSeconds: runMs / 1000, watchMs, wall: Math.round((Date.now() - t0) / 1000), last: rows.at(-1), peakHostRssMb: Math.max(...rows.map((r) => r.hostRssMb)), peakEngineRssMb: Math.max(...rows.map((r) => r.engineRssMb)), peakHistoryKb: Math.max(...rows.map((r) => r.historyKbMax)), peakHistoryRows: Math.max(...rows.map((r) => r.historyRowsMax)), peakActorDbKb: Math.max(...rows.map((r) => r.actorDbKbMax)), looksMax: Math.max(...rows.map((r) => r.looksMax ?? 0)), peakDriversRssMb: Math.max(...rows.map((r) => r.driversRssMb ?? 0)), peakDrivers: Math.max(...rows.map((r) => r.drivers ?? 0)) })}`);
} finally {
  await engine.stop();
}
process.exit(0);
