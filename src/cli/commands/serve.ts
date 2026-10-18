import { registry } from "../../registry";

export async function serve(opts: { port: number }) {
  console.log(`Starting Rivet engine on port ${opts.port}...`);

  await registry.start();

  console.log(`✓ Rivet engine running at http://localhost:${opts.port}`);
  console.log("  Press Ctrl+C to stop");

  process.on("SIGINT", async () => {
    console.log("\nStopping engine...");
    process.exit(0);
  });

  await new Promise(() => {});
}
