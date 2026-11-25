// The CLI's exit codes and JSON errors without an engine; the --json contract against a live one is in
// tests/scenarios/cli-json-live.test.ts.
import { describe, expect, test } from "bun:test";
import { capcomd } from "../helpers/engine";

/** `capcomd run` without a planner agent is the recipe-hierarchical plugin's, which is off unless turned on. */
const RECIPE = { CAPCOMD_PLUGIN_RECIPE_HIERARCHICAL_ENABLED: "true" };

describe("capcomd CLI exit codes without an engine", () => {
  test("usage errors exit 2 with a JSON error", async () => {
    const r = await capcomd(["run", "--json"]);
    expect(r.code).toBe(2);
    const body = JSON.parse(r.stdout);
    expect(body).toMatchObject({ schema: "relay.v1", ok: false, error: { code: "usage" } });
    expect(body.error.hint).toContain("capcomd --help");
  });

  test("unknown flags exit 2", async () => {
    const r = await capcomd(["status", "x", "--bogus", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe("usage");
  });

  test("unknown command exits 2", async () => {
    expect((await capcomd(["frobnicate"])).code).toBe(2);
  });

  test("engine unreachable exits 4", async () => {
    const r = await capcomd(["status", "run-x", "--json"], { CAPCOMD_ENDPOINT: "http://127.0.0.1:6499" });
    expect(r.code).toBe(4);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "engine_unreachable" });
    const run = await capcomd(["run", "goal", "--json"], { CAPCOMD_ENDPOINT: "http://127.0.0.1:6499", ...RECIPE });
    expect(run.code).toBe(4);
  });

  test("with recipe-hierarchical off, a run without a planner agent is refused naming it, before the engine is asked", async () => {
    const off = { CAPCOMD_ENDPOINT: "http://127.0.0.1:6499", CAPCOMD_PLUGIN_RECIPE_HIERARCHICAL_ENABLED: "" };
    for (const [args, env] of [[["run", "goal", "--json"], { ...off, CAPCOMD_RUN_PATH: "legacy" }], [["run", "goal", "--legacy", "--json"], off], [["run", "goal", "--recipe", "--json"], off], [["run", "goal", "--json"], off]] as const) {
      const r = await capcomd([...args], env);
      expect(r.code).toBe(2);
      const body = JSON.parse(r.stdout.trim().split("\n").pop()!);
      expect(body).toMatchObject({ schema: "relay.v1", ok: false, error: { code: "config", reason: "plugin:recipe-hierarchical", hint: "Turn it on: capcomd plugins enable recipe-hierarchical" } });
      expect(body.error.message).toContain("recipe-hierarchical isn't running: validated (disabled)");
    }
    // Turned off in the environment: that variable is named, since it wins over the config.
    const env = await capcomd(["run", "goal", "--json"], { ...off, CAPCOMD_PLUGIN_RECIPE_HIERARCHICAL_ENABLED: "false" });
    expect(JSON.parse(env.stdout).error.hint).toContain("CAPCOMD_PLUGIN_RECIPE_HIERARCHICAL_ENABLED=false in the environment turns it off");
  });

  test("trace for an unknown run exits 3", async () => {
    const r = await capcomd(["trace", "run-does-not-exist", "--json"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).error.code).toBe("not_found");
  });
});
