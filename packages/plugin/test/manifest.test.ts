import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HOOK_NAMES, HOOKS, type JobChange } from "../src/hooks";
import { JOB_CHANGE_KINDS, MANIFEST_HOOK_NAMES, parseManifest, type PluginManifest } from "../src/manifest";
import { manifestJsonSchema, SCHEMA_PATH } from "../scripts/schema";

const base = (): Record<string, unknown> => ({
  schema: "capcomd.plugin/v1", name: "example", version: "1.0.0", description: "An example.", apiVersion: 1,
  engines: { capcomd: ">=0.9.0 <1.0.0" }, entry: { runtime: "in-process", module: "./index.ts" },
  contributes: { hooks: { "run.changed": {} } },
});
const issues = (raw: unknown) => { const r = parseManifest(raw); return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`); };

describe("plugin manifest (spec §4)", () => {
  test("the committed JSON Schema is generated from the zod schema", () => {
    expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(manifestJsonSchema());
  });
  test("the manifest's hook names are the hook registry's", () => {
    expect([...MANIFEST_HOOK_NAMES].sort()).toEqual([...HOOK_NAMES].sort());
    for (const n of HOOK_NAMES) expect(HOOKS[n].mode).toBeDefined();
  });
  test("a minimal valid manifest parses", () => {
    const r = parseManifest(base());
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.manifest as PluginManifest).name).toBe("example");
  });
  test("names are lowercase, 1-63, hyphens only", () => {
    expect(issues({ ...base(), name: "Bad_Name" })).toContainEqual(expect.stringContaining("name"));
    expect(issues({ ...base(), name: "a".repeat(64) })).toContainEqual(expect.stringContaining("name"));
  });
  test("engines.capcomd must be a real range", () => {
    expect(issues({ ...base(), engines: { capcomd: "*" } })).toContainEqual(expect.stringContaining("must not be `*`"));
  });
  test("approve is not grantable to a plugin", () => {
    expect(issues({ ...base(), scopes: ["read", "approve"] })).toContainEqual(expect.stringContaining("scopes"));
  });
  test("a gate hook cannot declare failure: open", () => {
    expect(issues({ ...base(), contributes: { hooks: { "merge.landing": { failure: "open" } } } })).toContainEqual(expect.stringContaining("failure is always closed"));
    expect(issues({ ...base(), contributes: { hooks: { "verify.judging": { failure: "closed", timeoutMs: 60_000 } } } })).toEqual([]);
  });
  test("job.changed may name the change kinds it wants; no other hook may, nor an unknown kind or none", () => {
    // The kinds are JobChange's, both ways (a kind added to one and not the other fails to compile).
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const same: Same<JobChange["kind"], (typeof JOB_CHANGE_KINDS)[number]> = true;
    expect(same).toBe(true);
    expect(issues({ ...base(), contributes: { hooks: { "job.changed": { changes: ["fired"] } } } })).toEqual([]);
    expect(issues({ ...base(), contributes: { hooks: { "job.changed": { changes: ["started", "output", "ended"], timeoutMs: 2000 } } } })).toEqual([]);
    expect(issues({ ...base(), contributes: { hooks: { "run.changed": { changes: ["fired"] } } } })).toContainEqual("contributes.hooks.run.changed.changes: changes is for job.changed only, not run.changed (§4.7)");
    expect(issues({ ...base(), contributes: { hooks: { "job.changed": { changes: ["tick"] } } } })).toContainEqual(expect.stringContaining("contributes.hooks.job.changed.changes.0"));
    expect(issues({ ...base(), contributes: { hooks: { "job.changed": { changes: [] } } } })).toContainEqual(expect.stringContaining("contributes.hooks.job.changed.changes"));
  });
  test("an unknown hook name is refused", () => {
    expect(issues({ ...base(), contributes: { hooks: { "run.started": {} } } }).length).toBeGreaterThan(0);
  });
  test("seams must be listed in provides, once per kind", () => {
    expect(issues({ ...base(), contributes: { seams: [{ kind: "sandbox", name: "x" }] } })).toContainEqual(expect.stringContaining("provides"));
    expect(issues({ ...base(), provides: ["seam:sandbox/x"], contributes: { seams: [{ kind: "sandbox", name: "x" }] } })).toEqual([]);
    expect(issues({ ...base(), provides: ["seam:sandbox/x", "seam:sandbox/y"], contributes: { seams: [{ kind: "sandbox", name: "x" }, { kind: "sandbox", name: "y" }] } })).toContainEqual(expect.stringContaining("at most one sandbox seam"));
    expect(issues({ ...base(), provides: ["seam:forge/x"] })).toContainEqual(expect.stringContaining("not contributed"));
  });
  test("a plugin cannot require itself or what it provides", () => {
    expect(issues({ ...base(), requires: ["plugin:example"] })).toContainEqual(expect.stringContaining("requires"));
  });
  test("unknown keys and a wrong schema id are refused", () => {
    expect(issues({ ...base(), extra: true }).length).toBeGreaterThan(0);
    expect(issues({ ...base(), schema: "capcomd.plugin/v2" }).length).toBeGreaterThan(0);
    expect(issues({ ...base(), apiVersion: 2 }).length).toBeGreaterThan(0);
  });
  test("a plugin must contribute something", () => {
    expect(issues({ ...base(), contributes: {} })).toContainEqual(expect.stringContaining("must contribute"));
  });
  test("a process entry carries a command and no secrets in env", () => {
    expect(issues({ ...base(), entry: { runtime: "process", command: ["bun", "${PLUGIN_ROOT}/index.ts"], env: { LOG_LEVEL: "info" } } })).toEqual([]);
    expect(issues({ ...base(), entry: { runtime: "process", command: [] } }).length).toBeGreaterThan(0);
  });
});
