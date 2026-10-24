// ADR-020: providers by name, and the capabilities code asks for instead of a provider's name.
import { expect, test } from "bun:test";
import { PROVIDERS, realSandbox, sandboxCaps, sandboxName } from "../../src/providers/registry";
import { checksMode } from "../../src/merge/verify";
import { preflightNeeded } from "../../src/core/preflight";

test("CAPCOMD_SANDBOX names a provider (the fake by default); an unknown one is refused", () => {
  expect(sandboxName({})).toBe("fake");
  expect(sandboxName({ CAPCOMD_SANDBOX: "boxd" })).toBe("boxd");
  expect(sandboxName({ RELAY_SANDBOX: "fake-host" })).toBe("fake-host");
  expect(() => sandboxName({ CAPCOMD_SANDBOX: "nope" })).toThrow("Unknown CAPCOMD_SANDBOX=nope");
});

test("what depends on the provider follows its capabilities", () => {
  expect(sandboxCaps({ CAPCOMD_SANDBOX: "boxd" })).toEqual(PROVIDERS.boxd);
  expect(realSandbox({ CAPCOMD_SANDBOX: "boxd" })).toBe(true);
  expect(realSandbox({ CAPCOMD_SANDBOX: "fake-host" })).toBe(false);
  expect(checksMode({ CAPCOMD_SANDBOX: "boxd" })).toBe("vm");
  expect(checksMode({ CAPCOMD_SANDBOX: "fake" })).toBe("host");
  expect(checksMode({ CAPCOMD_SANDBOX: "boxd", CAPCOMD_CHECKS: "host" })).toBe("host");
  expect(preflightNeeded({ CAPCOMD_SANDBOX: "boxd" })).toBe(true);
  expect(preflightNeeded({ CAPCOMD_SANDBOX: "boxd", CAPCOMD_SKIP_PREFLIGHT: "1" })).toBe(false);
  expect(preflightNeeded({})).toBe(false);
});

test("each provider other than boxd keeps its own env and login ledgers", async () => {
  const { providerStateFile } = await import("../../src/providers/registry");
  expect(providerStateFile("envs.json", { CAPCOMD_SANDBOX: "boxd" })).toBe("envs.json");
  expect(providerStateFile("auths.json", {})).toBe("auths.json");
  expect(providerStateFile("envs.json", { CAPCOMD_SANDBOX: "docker" })).toBe("envs-docker.json");
});
