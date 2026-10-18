import { describe, test, expect } from "bun:test";
import { spawn, exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("Chaos - Fixed Harness", () => {
  test("merge.before_cas with proper cleanup", async () => {
    // Clean start
    await execAsync("pkill -9 rivet-eng; pkill -9 rivet-ser; pkill -9 bun || true").catch(() => {});
    await sleep(2000);
    await execAsync("rm -rf /workspace/.rivet");
    
    let coordinatorErrors = 0;
    let success = false;
    
    // Start serve with killpoint
    const serve1 = spawn("bun", ["src/cli/index.ts", "serve"], {
      cwd: "/workspace",
      env: { ...process.env, CAPCOMD_KILLPOINT: "merge.before_cas:1" },
      stdio: "pipe",
    });
    
    await sleep(3000);
    
    // Start run
    const run = spawn("bun", ["src/cli/index.ts", "run", "Test"], {
      cwd: "/workspace",
      stdio: "pipe",
    });
    
    // Wait for kill
    await new Promise<void>((resolve) => {
      serve1.on("exit", async (code) => {
        if (code === 137) {
          console.log("  Serve killed, cleaning children...");
          await execAsync("pkill -9 rivet-eng; pkill -9 rivet-ser").catch(() => {});
          await sleep(2000);
          resolve();
        }
      });
    });
    
    // Verify port free
    try {
      await execAsync("lsof -i :6420");
      console.log("  ERROR: Port still in use");
      expect(false).toBe(true);
      return;
    } catch {
      console.log("  ✓ Port free");
    }
    
    // Restart
    console.log("  Restarting serve...");
    const serve2 = spawn("bun", ["src/cli/index.ts", "serve"], {
      cwd: "/workspace",
      stdio: "pipe",
    });
    
    let output = "";
    serve2.stdout.on("data", d => output += d.toString());
    serve2.stderr.on("data", d => output += d.toString());
    
    await sleep(8000);
    
    // Check for errors
    const matches = output.match(/transaction.*closed/g);
    coordinatorErrors = matches ? matches.length : 0;
    
    console.log(`  Coordinator errors: ${coordinatorErrors}`);
    
    // Cleanup
    serve2.kill("SIGKILL");
    run.kill("SIGKILL");
    await execAsync("pkill -9 rivet-eng; pkill -9 rivet-ser; pkill -9 bun").catch(() => {});
    
    expect(coordinatorErrors).toBe(0);
  }, 30000);
});
