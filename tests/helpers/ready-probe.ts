import { createClient } from "rivetkit/client";
import type { Registry } from "../../src/registry";

// Readiness probe for an engine on <port>. Exits 0 when an actor call succeeds, 1 at the deadline.
// Each attempt is bounded (a client call against a half-up engine can hang forever: live Mac
// 2026-10-20 sat 14+ min), and a hard timer exits at the deadline whatever is pending.
// Always the caller's private engine: no default port (never a developer's :6420).
if (!process.argv[2]) { console.error("usage: ready-probe.ts <port>"); process.exit(2); }
const port = Number(process.argv[2]);
const DEADLINE_MS = Number(process.env.CAPCOMD_READY_DEADLINE_MS ?? 45_000);
const ATTEMPT_MS = Number(process.env.CAPCOMD_READY_ATTEMPT_MS ?? 5_000);
const deadline = Date.now() + DEADLINE_MS;
let last = "actor endpoint not ready";
setTimeout(() => { console.error(`not ready after ${DEADLINE_MS}ms: ${last}`); process.exit(1); }, DEADLINE_MS).unref?.();

const client = createClient<Registry>({ endpoint: `http://127.0.0.1:${port}` });
const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`attempt timed out after ${ms}ms`)), ms))]);

while (Date.now() < deadline) {
  try {
    await withTimeout(client.run.getOrCreate(["__ready__"]).getRun({ runId: "__ready__" }), Math.min(ATTEMPT_MS, Math.max(1, deadline - Date.now())));
    console.log("ready");
    process.exit(0);
  } catch (error) {
    last = error instanceof Error ? error.message : String(error);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
console.error(last);
process.exit(1);
