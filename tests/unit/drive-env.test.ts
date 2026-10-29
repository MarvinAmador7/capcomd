// ADR-022: the settings a driver process took from its CLI travel with the agent (captureDriveEnv at spawn) and apply
// while the engine host drives it (withDriveEnv), over the host's own env, for that agent only. Never secrets.
import { expect, test } from "bun:test";
import { captureDriveEnv, env, withDriveEnv } from "../../src/utils/env";

test("capture keeps only the drive settings: how it runs, scripted agents' scripts, driver timings; never a secret or state path", () => {
  const got = captureDriveEnv({
    CAPCOMD_SPAWN_EXEC: "script", CAPCOMD_SCRIPT_PLANNER: "sh plan.sh", CAPCOMD_SCRIPT_VM_DIR: "/tmp/vms", CAPCOMD_DRIVER_LEASE_MS: "4000",
    CAPCOMD_AGENTS_FILE: "/p/.capcomd/agents.json", RELAY_AWAIT_POLL_MS: "200", CAPCOMD_RPC_KEY: "secret", CAPCOMD_SCRIPT_API_KEY: "x", CAPCOMD_SCRIPT_GH_TOKEN: "y", CAPCOMD_SCRIPT_KEYPER: "sh keyper.sh", ANTHROPIC_API_KEY: "sk-ant", CAPCOMD_HOME: "/h",
    CAPCOMD_QUOTA_LEDGER: "/q", CAPCOMD_REPO: "/r", CAPCOMD_ENDPOINT: "http://x",
  });
  expect(got).toEqual({
    CAPCOMD_SPAWN_EXEC: "script", CAPCOMD_SCRIPT_PLANNER: "sh plan.sh", CAPCOMD_SCRIPT_VM_DIR: "/tmp/vms", CAPCOMD_DRIVER_LEASE_MS: "4000",
    CAPCOMD_AWAIT_POLL_MS: "200", CAPCOMD_AGENTS_FILE: "/p/.capcomd/agents.json", CAPCOMD_SCRIPT_KEYPER: "sh keyper.sh",
  });
});

test("withDriveEnv applies an agent's settings over process.env for everything it starts, and only there", async () => {
  const saved = process.env.CAPCOMD_SPAWN_EXEC;
  process.env.CAPCOMD_SPAWN_EXEC = "host";
  try {
    const seen: Array<string | undefined> = [];
    await Promise.all([
      withDriveEnv({ CAPCOMD_SPAWN_EXEC: "fake" }, async () => {
        await Bun.sleep(5);
        seen.push(env("SPAWN_EXEC"));
        await new Promise<void>((r) => setTimeout(() => { seen.push(env("SPAWN_EXEC")); r(); }, 5)); // timers keep it
      }),
      withDriveEnv({ CAPCOMD_SPAWN_EXEC: "script", CAPCOMD_RPC_KEY: "smuggled" }, async () => {
        seen.push(env("SPAWN_EXEC"));
        seen.push(env("RPC_KEY")); // not a drive setting: ignored, the host's (unset) applies
      }),
    ]);
    expect(seen.sort()).toEqual(["fake", "fake", "script", undefined].sort());
    expect(env("SPAWN_EXEC")).toBe("host"); // outside: the host's own
    // An explicit source is read as given (the run's sandbox env, a config): no override.
    expect(withDriveEnv({ CAPCOMD_SPAWN_EXEC: "fake" }, () => env("SPAWN_EXEC", { CAPCOMD_SPAWN_EXEC: "given" }))).toBe("given");
    // What an agent spawns from inside its run inherits its settings (a VM's child spawned through the engine host).
    expect(withDriveEnv({ CAPCOMD_SPAWN_EXEC: "fake" }, () => captureDriveEnv())).toMatchObject({ CAPCOMD_SPAWN_EXEC: "fake" });
  } finally { if (saved === undefined) delete process.env.CAPCOMD_SPAWN_EXEC; else process.env.CAPCOMD_SPAWN_EXEC = saved; }
});
