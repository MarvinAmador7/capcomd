// context-memory (ADR-025 §11.1, step 1): the built-in context provider `memory`, the project layer. A profile with
// `context: {providers: [{name: memory}]}` (or ADR-024's `memory: {scope: project}`) is briefed from the items under
// `.capcomd/context/` in the run's repository, at the tip of the branch its agents start from (src/context/memory.ts).
// Read-only in this step: capture, lint and promotion through a reviewed merge come with ADR-025 steps 2-3.
import { definePlugin } from "../../packages/plugin/src/context";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { VERSION } from "../utils/self";
import { memoryProvider } from "../context/memory";

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "context-memory", version: VERSION,
  description: "Project memory: the lessons and facts a project keeps under .capcomd/context/ in its repository, as a context provider (memory) a profile names.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./context-memory.ts" },
  provides: ["context:memory"],
  contributes: { context: [{ name: "memory", kinds: ["memory", "fact"] }] },
};

export const plugin = definePlugin({
  activate(ctx) {
    ctx.context.register(memoryProvider());
  },
});
