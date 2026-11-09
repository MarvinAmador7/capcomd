// recipe-hierarchical (plugin API §17.1; ADR-023 §4 judgment call and decision 5): `capcomd run` without a planner
// agent, the placeholder-model planner → worker → judge flow, as the recipe over the primitives (src/recipes/
// hierarchical.ts, `--recipe`, CAPCOMD_RUN_PATH=recipe) or the hard-wired loop it replaced (src/core/relay.ts
// executeRun, `--legacy`, CAPCOMD_RUN_PATH=legacy). A built-in kept for the parity eval and the tests, off until a person
// turns it on (`capcomd plugins enable recipe-hierarchical`, or CAPCOMD_PLUGIN_RECIPE_HIERARCHICAL_ENABLED=true): a run
// that needs it while it's off is refused before anything starts, naming it (front-run's `run`, src/cli/groups/run.ts).
// It is loaded wherever `capcomd run` runs (the CLI, a detached run's process).
import { definePlugin } from "../../packages/plugin/src/context";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import type { RunOptions, RunResult } from "../core/relay";
import { VERSION } from "../utils/self";

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "recipe-hierarchical", version: VERSION,
  description: "capcomd run without a planner agent: a placeholder planner that makes the same generic tasks for any goal, workers, and a judge that judges nothing. Kept for comparisons and tests; off unless turned on.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./recipe-hierarchical.ts" },
  // A card for the settings screen (§4.7.5): while it's on, runs without a planner agent judge nothing.
  contributes: { ui: [{ kind: "card", id: "recipe" }] },
};

/** The card's lines (plain text, §4.7.5). */
export const CARD = {
  title: "Runs without a planner agent",
  lines: ["On: capcomd run without a planner agent plans with a placeholder model (the same generic tasks for any goal) and judges nothing.", "Turn it off: capcomd plugins disable recipe-hierarchical"],
} as const;

/** The two ways it runs a goal. */
export interface HierarchicalRecipe {
  /** The recipe over the primitives (ADR-016 step 4). */
  recipe(o: RunOptions & { budgetUsd?: number }): Promise<RunResult>;
  /** The legacy hard-wired loop. */
  legacy(o: RunOptions): Promise<RunResult>;
}

/** What this process's active recipe-hierarchical registered; null while it isn't active here. */
let active: HierarchicalRecipe | null = null;

export const plugin = definePlugin({
  activate(ctx) {
    const mine: HierarchicalRecipe = {
      recipe: async (o) => (await import("../recipes/hierarchical")).runHierarchicalRecipe(o),
      legacy: async (o) => (await import("../core/relay")).executeRun(o),
    };
    active = mine;
    ctx.onDispose(() => { if (active === mine) active = null; });
    ctx.ui.descriptor({ kind: "card", id: "recipe", title: CARD.title, read: async () => ({ lines: [...CARD.lines], state: "warn" }) });
  },
});

/** The recipe, from this process's plugin host (src/plugins/host.ts `localHost`); while recipe-hierarchical isn't
 *  active, the refusal that says so and how to turn it on (`config`, reason `plugin:recipe-hierarchical`). */
export async function hierarchicalRecipe(): Promise<HierarchicalRecipe> {
  await (await import("./host")).localHost();
  if (active) return active;
  throw await (await import("../cli/front-doors")).notRunning(manifest.name, "capcomd run without a planner agent (--recipe, --legacy, CAPCOMD_RUN_PATH) is the recipe-hierarchical plugin's");
}
