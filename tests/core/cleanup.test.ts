import { describe, expect, test } from "bun:test";
import { cleanupVerdict, runVmKeys } from "../../src/core/cleanup";
import { vmNameFor } from "../../src/providers/boxd";

describe("vm cleanup verdict", () => {
  const names = ["relay-abc"];
  test("no VM ever created → OK", () => expect(cleanupVerdict([{ id: "m9", name: "relay-other", state: "running" }], names, null).leaked).toBe(false));
  test("live VM with the run's name → LEAKED", () => expect(cleanupVerdict([{ id: "m1", name: "relay-abc", state: "running" }], names).leaked).toBe(true));
  test("recorded vm id still alive → LEAKED", () => expect(cleanupVerdict([{ id: "m2", name: "x", state: "suspended" }], names, "m2").leaked).toBe(true));
  test("destroyed → OK", () => expect(cleanupVerdict([{ id: "m1", name: "relay-abc", state: "destroyed" }], names).leaked).toBe(false));
  test("any of several recorded vm ids alive → LEAKED", () => expect(cleanupVerdict([{ id: "m3", name: "x", state: "running" }], names, ["m2", "m3"]).leaked).toBe(true));
});

describe("run VM keys", () => {
  test("every agent's worker is covered, not just the legacy worker-1", () => {
    const run = "run-mvhb0abcdef";
    const { keys, vmIds } = runVmKeys(run, [
      { workerId: `${run}-worker-1`, context: null },
      { workerId: "agt-k6b7cb84c54d4b0b6", context: { vmId: "vm-1" } },
      { workerId: "agt-retry", context: { idemKey: "relay-run-mvhb-agt-retry-e2", vmId: "vm-2" } },
    ]);
    expect(keys).toEqual(expect.arrayContaining([`relay-run-mvhb-${run}-worker-1-e1`, "relay-run-mvhb-agt-k6b7cb84c54d4b0b6-e1", "relay-run-mvhb-agt-retry-e2"]));
    expect(vmIds).toEqual(["vm-1", "vm-2"]);
    // A real leaked row from a ledger: the derived key names the VM the driver created.
    expect(vmNameFor("relay-run-mvhb-agt-k6b7cb84c54d4b0b6-e1")).toBe("relay-41b98a55e8e3f18e");
  });
});
