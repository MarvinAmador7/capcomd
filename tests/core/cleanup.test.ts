import { describe, expect, test } from "bun:test";
import { cleanupVerdict } from "../../src/core/cleanup";

describe("vm cleanup verdict", () => {
  const names = ["relay-abc"];
  test("no VM ever created → OK", () => expect(cleanupVerdict([{ id: "m9", name: "relay-other", state: "running" }], names, null).leaked).toBe(false));
  test("live VM with the run's name → LEAKED", () => expect(cleanupVerdict([{ id: "m1", name: "relay-abc", state: "running" }], names).leaked).toBe(true));
  test("recorded vm id still alive → LEAKED", () => expect(cleanupVerdict([{ id: "m2", name: "x", state: "suspended" }], names, "m2").leaked).toBe(true));
  test("destroyed → OK", () => expect(cleanupVerdict([{ id: "m1", name: "relay-abc", state: "destroyed" }], names).leaked).toBe(false));
});
