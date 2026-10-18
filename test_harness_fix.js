const { spawn, exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

async function testMergeKillpoint() {
  console.log("=== Testing merge.before_cas with proper cleanup ===\n");
  
  // Clean start
  await execAsync("pkill -9 rivet-eng; pkill -9 rivet-ser; pkill -9 bun || true");
  await new Promise(r => setTimeout(r, 2000));
  await execAsync("rm -rf /workspace/.rivet");
  
  return new Promise((resolve) => {
    // Start serve with killpoint
    let serve = spawn("bun", ["src/cli/index.ts", "serve"], {
      cwd: "/workspace",
      env: {
        ...process.env,
        RELAY_KILLPOINT: "merge.before_cas:1",
      },
      stdio: "pipe",
    });
    
    console.log(`Serve PID: ${serve.pid}`);
    
    serve.on("exit", async (code) => {
      if (code === 137) {
        console.log("Serve killed by killpoint, cleaning up...");
        
        // Kill rivet children
        await execAsync("pkill -9 rivet-eng; pkill -9 rivet-ser").catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        
        // Verify port free
        try {
          await execAsync("lsof -i :6420");
          console.log("ERROR: Port still in use!");
          resolve({ success: false, error: "Port still in use" });
          return;
        } catch {
          console.log("✓ Port 6420 free");
        }
        
        // Restart
        console.log("Restarting serve...");
        serve = spawn("bun", ["src/cli/index.ts", "serve"], {
          cwd: "/workspace",
          stdio: "pipe",
        });
        
        let output = "";
        serve.stdout.on("data", d => output += d.toString());
        serve.stderr.on("data", d => output += d.toString());
        
        setTimeout(async () => {
          if (output.includes("transaction.*closed") || output.includes("coordinator is closed")) {
            console.log("ERROR: Coordinator errors detected");
            resolve({ success: false, error: "Coordinator errors" });
          } else {
            console.log("✓ No coordinator errors");
            resolve({ success: true });
          }
          
          await execAsync("pkill -9 rivet-eng; pkill -9 rivet-ser; pkill -9 bun").catch(() => {});
        }, 8000);
      }
    });
    
    // Start run after 2s
    setTimeout(() => {
      const run = spawn("bun", ["src/cli/index.ts", "run", "Test"], {
        cwd: "/workspace",
        stdio: "pipe",
      });
      
      run.stdout.on("data", d => process.stdout.write(d));
    }, 2000);
  });
}

testMergeKillpoint().then(result => {
  console.log("\n=== Result ===");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
});
