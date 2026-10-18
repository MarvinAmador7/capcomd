import { createClient } from "rivetkit/client";

export async function cancel(opts: { runId: string }) {
  const c = createClient({ endpoint: "http://localhost:6420" });

  try {
    const runHandle = c.run.get([opts.runId]);
    await runHandle.cancel({ runId: opts.runId });
    console.log(`✓ Run ${opts.runId} cancelled`);
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
