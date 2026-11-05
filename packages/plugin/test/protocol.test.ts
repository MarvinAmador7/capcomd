// Spec §9.9: the draft OpenAPI fragment is well-formed, only adds plugin routes, and none of them is in the committed
// openapi/capcomd.json yet (the brief: specify, don't apply).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_NAMES } from "../src/hooks";

const repo = join(import.meta.dir, "..", "..", "..");
const fragment = JSON.parse(readFileSync(join(repo, "openapi", "drafts", "plugin-api.fragment.json"), "utf8"));
const committed = JSON.parse(readFileSync(join(repo, "openapi", "capcomd.json"), "utf8"));

describe("openapi/drafts/plugin-api.fragment.json", () => {
  test("every path is a plugin route with at least one operation", () => {
    const paths = Object.keys(fragment.paths);
    expect(paths.length).toBeGreaterThan(5);
    for (const p of paths) {
      expect(p).toMatch(/^\/v1\/plugins(\/|$)/);
      expect(Object.keys(fragment.paths[p]).length).toBeGreaterThan(0);
      for (const op of Object.values(fragment.paths[p]) as Array<Record<string, unknown>>) {
        expect(op).toHaveProperty("operationId");
        expect(op).toHaveProperty("responses");
        expect(String(op["description"])).toMatch(/scope|token/);
      }
    }
  });
  test("none of its paths is applied to the committed contract", () => {
    for (const p of Object.keys(fragment.paths)) expect(Object.keys(committed.paths)).not.toContain(p);
  });
  test("the hooks stream frames and the hook names match the registry", () => {
    const frame = fragment.components.schemas.HookFrame;
    expect(frame.oneOf.map((o: { properties: { frame: { const: string } } }) => o.properties.frame.const).sort()).toEqual(["hook.call", "hook.dropped", "session.closing"]);
    expect([...fragment.components.schemas.HookName.enum].sort()).toEqual([...HOOK_NAMES].sort());
  });
  test("plugin.* event types are listed", () => {
    for (const t of ["plugin.loaded", "plugin.failed", "plugin.hook_failed", "plugin.suspended", "plugin.gate_denied", "plugin.gate_bypassed"]) expect(Object.keys(fragment["x-events"])).toContain(t);
  });
});
