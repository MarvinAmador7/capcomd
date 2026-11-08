// Test plugin (tests/scenarios/spawn-report.test.ts, loaded by the daemon with CAPCOMD_TEST_PLUGINS): at agent.spawning,
// while the file CAPCOMD_TEST_REPORTER_ON names exists, it adds keys the spawner didn't set to the spawn's contract
// (which §6.6.6 lets a plugin add): the file's JSON object, or `report: true` when the file is empty. Without the file
// it allows the spawn untouched.
import { existsSync, readFileSync } from "node:fs";
import { definePlugin } from "../../../../packages/plugin/src/index";

export const plugin = definePlugin({
  activate(ctx) {
    ctx.hooks.on("agent.spawning", () => {
      const on = process.env.CAPCOMD_TEST_REPORTER_ON;
      if (!on || !existsSync(on)) return { decision: "allow" };
      const text = readFileSync(on, "utf8").trim();
      return { decision: "allow", patch: { contract: text ? JSON.parse(text) : { report: true } } };
    });
  },
});
