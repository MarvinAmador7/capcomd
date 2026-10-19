// Usage: bun scripts/vm-cleanup-check.ts <runId>
// Confirms the run's sandbox VM is destroyed (worker state + boxd). Exit 0 = clean, 1 = leaked.
import { createClient } from "rivetkit/client";
import { BoxdProvider } from "../src/providers/boxd";

const runId = process.argv[2];
if (!runId) { console.error("usage: vm-cleanup-check.ts <runId>"); process.exit(2); }
const endpoint = process.env.CAPCOMD_ENDPOINT ?? "http://127.0.0.1:6420";
const client: any = createClient({ endpoint });
const workerId = `${runId}-worker-1`;
const worker = await client.worker.getOrCreate([runId, workerId]).getWorker({ workerId });
const vmId: string | undefined = worker?.context?.vmId;
console.log(`worker ${workerId}: state=${worker?.state ?? "missing"} vm=${vmId ?? "none"}`);
let leaked = false;
if (vmId && process.env.BOXD_API_KEY) {
  const p = new BoxdProvider({ keepaliveMs: 0 });
  try {
    const m = await p.client.machines.get(vmId);
    leaked = !["destroyed", "failed", "deleted"].includes(m.status);
    console.log(`boxd ${vmId}: status=${m.status}`);
  } catch {
    console.log(`boxd ${vmId}: not found (deleted)`);
  }
  await p.close();
}
if (worker && worker.state !== "destroyed") leaked = true;
console.log(leaked ? "VM CLEANUP: LEAKED" : "VM CLEANUP: OK");
process.exit(leaked ? 1 : 0);
