// Test plugin (tests/scenarios/spawn-report.test.ts, loaded by the daemon with CAPCOMD_TEST_PLUGINS): at agent.spawning,
// while the file CAPCOMD_TEST_REPORTER_ON names exists, it adds `report: true` to the spawn's contract (a key the
// spawner didn't set, which §6.6.6 lets a plugin add). Without the file it allows the spawn untouched.
import { existsSync } from "node:fs";
import { definePlugin } from "../../../../packages/plugin/src/index";

export const plugin = definePlugin({
  activate(ctx) {
    ctx.hooks.on("agent.spawning", () => {
      const on = process.env.CAPCOMD_TEST_REPORTER_ON;
      return on && existsSync(on) ? { decision: "allow", patch: { contract: { report: true } } } : { decision: "allow" };
    });
  },
});
