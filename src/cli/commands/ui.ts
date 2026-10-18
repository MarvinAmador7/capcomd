import { spawn } from "child_process";
import { join } from "path";

export async function ui() {
  const canvasDir = join(process.cwd(), "apps", "canvas");

  console.log("Starting Relay UI...");
  console.log("Canvas directory:", canvasDir);

  const vite = spawn("bun", ["run", "dev"], {
    cwd: canvasDir,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_WS_PORT: "3001",
    },
  });

  vite.on("exit", (code) => {
    if (code !== 0) {
      console.error(`Vite exited with code ${code}`);
      process.exit(code || 1);
    }
  });

  console.log("\n✓ UI server starting at http://localhost:3000");
  console.log("  Press Ctrl+C to stop\n");

  process.on("SIGINT", () => {
    vite.kill();
    process.exit(0);
  });

  await new Promise(() => {});
}
