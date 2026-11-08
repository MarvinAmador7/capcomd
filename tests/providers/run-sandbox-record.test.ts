// The run's `_sandbox` record (src/providers/run-sandbox.ts): `explicit` says the run's place was asked for when it
// started (`capcomd run --sandbox`, POST /v1/runs `sandbox`, capcomd_run_new's), which beats every agent's profile
// `sandbox.provider` (ADR-024 §9, the owner's decision of 2026-11-08); a place from the settings isn't.
import { expect, test } from "bun:test";
import { parseRunSandbox, runSandboxValue } from "../../src/providers/run-sandbox";

test("explicit is written only for a place that was asked for, and read only as true on a named place", () => {
  expect(runSandboxValue("docker", { idleLifetime: 3600 }, true)).toEqual({ name: "docker", explicit: true, settings: { idleLifetime: 3600 } });
  expect(runSandboxValue("docker", { idleLifetime: 3600 })).toEqual({ name: "docker", settings: { idleLifetime: 3600 } });
  // No place of its own: nothing to beat a profile with.
  expect(runSandboxValue(null, { idleLifetime: 3600 }, true)).toEqual({ settings: { idleLifetime: 3600 } });
  expect(parseRunSandbox({ name: "docker", explicit: true, settings: { idleLifetime: 3600 } })).toEqual({ name: "docker", settings: { idleLifetime: 3600 }, explicit: true });
  // A record from before (no field), a place from the settings, and anything that isn't `true` are not explicit.
  expect(parseRunSandbox({ name: "docker", settings: {} })?.explicit).toBe(false);
  expect(parseRunSandbox({ name: "docker", explicit: "yes" })?.explicit).toBe(false);
  expect(parseRunSandbox({ name: "kubernetes", explicit: true })).toMatchObject({ name: null, explicit: false });
});
