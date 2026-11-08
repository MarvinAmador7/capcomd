// recipe-hierarchical (plugin API §17.1, ADR-023 decision 5): `capcomd run` without a planner agent goes through this
// built-in, which is off until a person turns it on. Its runs end to end: tests/cli/json.test.ts (on, and refused while
// off), tests/scenarios/local-slots.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { BUILTINS, candidateOf, OPT_IN } from "../../src/plugins/builtins";
import { kernelHost } from "../../src/plugins/host";
import { CARD, hierarchicalRecipe, manifest } from "../../src/plugins/recipe-hierarchical";

const builtin = BUILTINS.find((b) => (b.manifest as { name: string }).name === "recipe-hierarchical")!;
let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

describe("recipe-hierarchical", () => {
  test("a built-in loaded wherever capcomd run runs, off by default, and one a person may turn off again", () => {
    expect(builtin).toMatchObject({ everyProcess: true, off: true });
    expect(OPT_IN.has("recipe-hierarchical")).toBe(true);
    expect(candidateOf(builtin).enabled).toBe(false);
  });

  test("while active it registers the recipe and its card; turned off, the recipe is gone", async () => {
    const host = kernelHost({ log: false });
    stop = () => host.stop();
    await host.start([{ ...candidateOf(builtin), enabled: true }]);
    expect(host.list().find((p) => p.name === manifest.name)).toMatchObject({ state: "active" });
    const card = host.contributions.list("ui").find((e) => e.plugin === manifest.name)!.value.descriptor;
    expect(card).toMatchObject({ kind: "card", id: "recipe", title: CARD.title });
    expect(await (card as { read(): Promise<unknown> }).read()).toEqual({ lines: [...CARD.lines], state: "warn" });
    const r = await hierarchicalRecipe();
    expect(typeof r.recipe).toBe("function");
    expect(typeof r.legacy).toBe("function");
    await host.disable(manifest.name);
    expect(host.contributions.list("ui").filter((e) => e.plugin === manifest.name)).toEqual([]);
    // This process's own host (the CLI's) has it off, as every process does by default: refused, naming it.
    const refused = await hierarchicalRecipe().then(() => null, (e) => e);
    expect(refused).toMatchObject({ code: "config", reason: "plugin:recipe-hierarchical" });
    expect(refused.message).toContain("recipe-hierarchical isn't running: validated (disabled)");
  });
});
