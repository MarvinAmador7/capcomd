// Usage: bun scripts/vm-cleanup-check.ts <runId>
// Is any boxd VM of this run still alive? Checks boxd itself (machine list by the run's deterministic
// VM names: the legacy worker and every agent's worker), not only capcomd's ledger. No VM ever
// created (e.g. auth failed at ensure) is OK. Exit 0 = clean, 1 = leaked, 2 = could not check.
import "../src/cli/apply-config"; // the boxd key as the CLI gets it (environment, then the keychain)
import { createClient } from "rivetkit/client";
import { BoxdProvider, vmNameFor } from "../src/providers/boxd";
import { cleanupVerdict, runVmKeys } from "../src/core/cleanup";

const runId = process.argv[2];
if (!runId) { console.error("usage: vm-cleanup-check.ts <runId>"); process.exit(2); }
const endpoint = process.env.CAPCOMD_ENDPOINT ?? "http://127.0.0.1:6420";
const client: any = createClient({ endpoint });
const agents: Array<{ agentId: string; epoch?: number }> = await client.scope.getOrCreate([runId]).listAgents({}).catch(() => []);
// Each attempt of an agent has its own worker (ADR-026: a message continues an idle agent as its next epoch, whose
// worker is keyed `[run, agent, e<N>]`); only the first is created here when missing, as before.
const slots: Array<{ workerId: string; key: string[]; create: boolean }> = [{ workerId: `${runId}-worker-1`, key: [runId, `${runId}-worker-1`], create: true }];
for (const a of agents) for (let e = 1; e <= Number(a.epoch ?? 1); e++) slots.push({ workerId: a.agentId, key: e > 1 ? [runId, a.agentId, `e${e}`] : [runId, a.agentId], create: e === 1 });
const workers = await Promise.all(slots.map(async ({ workerId, key, create }) => {
  const w = await (create ? client.worker.getOrCreate(key) : client.worker.get(key)).getWorker({ workerId }).catch(() => null);
  return { workerId, label: key.slice(1).join("/"), state: w?.state ?? "missing", context: w?.context ?? null };
}));
for (const w of workers) if (w.state !== "missing" || w.workerId.endsWith("-worker-1")) console.log(`worker ${w.label}: state=${w.state} vm=${w.context?.vmId ?? "none"}`);
const { keys, vmIds } = runVmKeys(runId, workers);
const names = keys.map((k) => vmNameFor(k));
console.log(`checking ${names.length} VM name(s) for ${agents.length} agent(s)`);

if (!process.env.BOXD_API_KEY) { console.log("VM CLEANUP: UNKNOWN (BOXD_API_KEY not set; cannot list boxd machines)"); process.exit(2); }
const p = new BoxdProvider({ keepaliveMs: 0, dbPath: ":memory:" });
let machines: Array<{ id: string; name: string; state: string }> = [];
try {
  machines = await p.list("relay-");
} catch (err) {
  console.log(`VM CLEANUP: UNKNOWN (boxd list failed: ${(err as Error).message.slice(0, 200)})`);
  await p.close(); process.exit(2);
}
await p.close();
const v = cleanupVerdict(machines, names, vmIds);
for (const m of v.matches) console.log(`boxd ${m.id} ${m.name}: status=${m.state}`);
console.log(v.leaked ? "VM CLEANUP: LEAKED" : `VM CLEANUP: OK (${v.matches.length ? "all destroyed" : "no VM exists for this run"})`);
process.exit(v.leaked ? 1 : 0);
