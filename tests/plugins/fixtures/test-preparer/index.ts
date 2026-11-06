// Test plugin (tests/subagents/prepare-skills.test.ts and profile-skills.test.ts, loaded by the daemon with
// CAPCOMD_TEST_PLUGINS): at agent.preparing it adds a skill of its own (pinned by the sha256 of its text) and the variable
// PLUGIN_TEAM to every real agent (plugin API §6.6.7, §17.2 step 8), and PLUGIN_SAW_SKILLS, the names of the skills the
// payload already had (the profile's, then earlier plugins'). It runs after the built-in orchestration skill (by name, §6.3).
import { createHash } from "node:crypto";
import { definePlugin } from "../../../../packages/plugin/src/index";

export const SKILL_TEXT = "# Cite files (test-preparer)\nName every file you change in your summary.";

export const plugin = definePlugin({
  activate(ctx) {
    ctx.hooks.on("agent.preparing", (call) => {
      if (!call.payload.spec.provider) return { decision: "allow" };
      const hash = createHash("sha256").update(SKILL_TEXT).digest("hex");
      const saw = call.payload.prompt.skills.map((s) => s.name).join(",");
      return { decision: "allow", patch: { prompt: { skills: [{ name: "cite-files", hash, source: "plugin", text: SKILL_TEXT }] }, env: { PLUGIN_TEAM: "payments", ...(saw ? { PLUGIN_SAW_SKILLS: saw } : {}) } } };
    });
  },
});
