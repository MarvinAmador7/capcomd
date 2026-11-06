// The daemon's harness-state.json and the engine autostart's engine.log follow the state-dir rule (src/utils/home.ts):
// with CAPCOMD_HOME (or an installed CLI) the top of the capcomd home; in a dev checkout without it, <repo>/.relay.
import { expect, test } from "bun:test";
import { join } from "path";
import { homeFile, isDevCheckout, PACKAGE_ROOT, stateDir } from "../../src/utils/home";
import { defaultStatePath } from "../../src/api/state";
import { engineLog } from "../../src/core/engine-start";

test("with CAPCOMD_HOME: <home>/<name>, next to state/", () => {
  const src = { CAPCOMD_HOME: "/x/home" };
  expect(homeFile("harness-state.json", src)).toBe("/x/home/harness-state.json");
  expect(homeFile("engine.log", src)).toBe("/x/home/engine.log");
  expect(stateDir(src)).toBe("/x/home/state");
});

test("a dev checkout without CAPCOMD_HOME: <repo>/.relay/<name>, with the checkout's other state", () => {
  expect(isDevCheckout()).toBe(true);
  expect(homeFile("harness-state.json", {})).toBe(join(PACKAGE_ROOT, ".relay", "harness-state.json"));
  expect(homeFile("engine.log", {})).toBe(stateDir({}) + "/engine.log");
});

test("the daemon's state and the autostart's log use it (here: the preload's scratch home)", () => {
  expect(defaultStatePath()).toBe(join(process.env.CAPCOMD_HOME!, "harness-state.json"));
  expect(engineLog()).toBe(join(process.env.CAPCOMD_HOME!, "engine.log"));
});
