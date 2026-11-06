// One pattern for event types (packages/plugin/src/event-type.ts; docs/spec/plugin-api.md §4.2): every kernel type in
// the contract matches it, every type the manifest allows a plugin to emit matches it, and every published copy of it
// (the envelope schema, openapi/capcomd.json and its menu bar copy, the manifest JSON Schema, the protocol's emit body)
// is that one pattern. A manifest naming an event that wouldn't make a valid type is refused at validate, and the
// kernel's plugin event writer only writes a plugin's own types. The run stream end to end:
// tests/scenarios/plugin-events.test.ts.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_NAME_PATTERN, EVENT_TYPE_PATTERN, eventTypeOwner, isEventType, PLUGIN_NAME_PATTERN, pluginEventType } from "../../packages/plugin/src/event-type";
import { PLUGIN_EVENT_TYPES } from "../../packages/plugin/src/events";
import { PluginManifest } from "../../packages/plugin/src/manifest";
import { readManifest } from "../../packages/plugin/src/load";
import { EventData } from "../../src/api/contract";
import { dottedType, HarnessEvent } from "../../src/api/envelope";
import { SCOPE_EVENT_TYPES } from "../../src/api/legacy-events";
import { LIFECYCLE_TYPES } from "../../src/api/lifecycle";
import { BUILTINS } from "../../src/plugins/builtins";
import { pluginEventWriter } from "../../src/plugins/host";

const ROOT = join(import.meta.dir, "..", "..");
const json = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const openapi = json("openapi/capcomd.json");
// The kernel's naming rule for its own types (decision 9), as tests/api/legacy-events.test.ts states it.
const PAST = /(ed|done|sent|put|kept)$/;
const NOUNS = new Set(["agent.step", "sandbox.resource_action"]);

describe("every kernel event type matches the one pattern", () => {
  const kernel: Array<[string, string]> = [
    ...Object.keys(EventData).map((t) => ["contract EventData", t] as [string, string]),
    ...SCOPE_EVENT_TYPES.map((t) => ["SCOPE_EVENT_TYPES (dotted)", dottedType(t)] as [string, string]),
    ...LIFECYCLE_TYPES.map((t) => ["LIFECYCLE_TYPES", t] as [string, string]),
    ...PLUGIN_EVENT_TYPES.map((t) => ["packages/plugin events.ts", t] as [string, string]),
  ];
  test.each(kernel)("%s: %s", (_where, t) => {
    expect(isEventType(t)).toBe(true);
    expect(eventTypeOwner(t)).toEqual({ kind: "kernel" });
    if (t.startsWith("plugin.")) expect(t.split(".").length).toBe(2); // the kernel's own plugin.* never collide with a plugin's
    if (!NOUNS.has(t)) expect(t.split(".").at(-1)!).toMatch(PAST);
  });

  test("the host's plugin events in the contract are the ones packages/plugin lists, and only those not written yet are missing", () => {
    const inContract = Object.keys(EventData).filter((t) => t.startsWith("plugin."));
    for (const t of inContract) expect(PLUGIN_EVENT_TYPES as readonly string[]).toContain(t);
    expect(PLUGIN_EVENT_TYPES.filter((t) => t.startsWith("plugin.") && !inContract.includes(t)).sort()).toEqual(["plugin.hook_deprecated", "plugin.trusted"]);
    for (const old of ["plugin.config_invalid", "plugin.deprecation", "plugin.process"]) expect(PLUGIN_EVENT_TYPES as readonly string[]).not.toContain(old);
  });
});

describe("a plugin's own types", () => {
  test("plugin.<name>.<event>, with kebab-case names, is a plugin's; the rest is refused", () => {
    for (const [t, plugin, event] of [["plugin.gate-reviewer.verdict", "gate-reviewer", "verdict"], ["plugin.watchdog.stalled", "watchdog", "stalled"], ["plugin.a1--b.thread_posted", "a1--b", "thread_posted"], ["plugin.0.x", "0", "x"], ["plugin.loaded.loaded", "loaded", "loaded"]] as const) {
      expect(isEventType(t)).toBe(true);
      expect(eventTypeOwner(t)).toEqual({ kind: "plugin", plugin, event });
    }
    const bad = ["plugin.gate_reviewer.verdict", "plugin.-x.y", "plugin.Gate.x", "plugin.x.Bad", "plugin.x.thread-posted", "plugin.x.y.z", "plugin.x.", "plugin.",
      `plugin.${"a".repeat(64)}.x`, "plugin.loaded-x", "AGENT_SPAWNED", "run", "run.Created", "run..created", ".run.created", "run.created.", "2run.created", "run.1created"];
    for (const t of bad) { expect(isEventType(t)).toBe(false); expect(eventTypeOwner(t)).toBeNull(); }
    // The kernel's own shapes are unchanged, the documented three-part example included.
    for (const t of ["run.created", "agent.turn.item", "merge.approval_requested", "plugin.gate_denied", "project.git_initialized"]) expect(eventTypeOwner(t)).toEqual({ kind: "kernel" });
  });

  test("any name and event the manifest allows make a valid type, and pluginEventType refuses what it doesn't", () => {
    const name = new RegExp(PLUGIN_NAME_PATTERN), event = new RegExp(EVENT_NAME_PATTERN);
    const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    for (let i = 0; i < 2000; i++) {
      const n = pick("abcdefghijklmnopqrstuvwxyz0123456789", 1) + pick("abcz09-", Math.floor(Math.random() * 63));
      const e = pick("abcz", 1) + pick("abz09_", Math.floor(Math.random() * 30));
      expect(name.test(n) && event.test(e)).toBe(true);
      const t = pluginEventType(n, e);
      expect(isEventType(t)).toBe(true);
      expect(eventTypeOwner(t)).toEqual({ kind: "plugin", plugin: n, event: e });
    }
    expect(() => pluginEventType("gate_reviewer", "verdict")).toThrow(/not a plugin name/);
    expect(() => pluginEventType("gate-reviewer", "thread-posted")).toThrow(/not an event name/);
    expect(() => pluginEventType("gate-reviewer", "a.b")).toThrow(/not an event name/);
  });

  test("every built-in's and example's name and contributes.events make valid types", () => {
    const manifests = [...BUILTINS.map((b) => PluginManifest.parse(b.manifest))];
    const examples = join(ROOT, "packages", "plugin", "examples");
    for (const d of readdirSync(examples)) { const r = readManifest(join(examples, d), { capcomd: "0.9.0" }); expect(r.ok).toBe(true); if (r.ok) manifests.push(r.manifest); }
    const types = manifests.flatMap((m) => (m.contributes?.events ?? []).map((e) => pluginEventType(m.name, e)));
    expect(types).toContain("plugin.gate-reviewer.verdict");
    for (const t of types) expect(eventTypeOwner(t)?.kind).toBe("plugin");
  });
});

describe("every published copy is the one pattern", () => {
  const patterns = (n: unknown, key: string, out: string[] = []): string[] => {
    if (!n || typeof n !== "object") return out;
    const o = n as Record<string, any>;
    if (o[key] && typeof o[key] === "object" && typeof o[key].pattern === "string") out.push(o[key].pattern);
    for (const v of Object.values(o)) patterns(v, key, out);
    return out;
  };
  test("the envelope schema, openapi/capcomd.json and the menu bar's copy", () => {
    const re = (HarnessEvent.shape.type as any)._zod.def.checks.map((c: any) => c._zod.def.pattern?.source).filter(Boolean);
    expect(re).toEqual([new RegExp(EVENT_TYPE_PATTERN).source]);
    for (const f of ["openapi/capcomd.json", "apps/menubar/client/Sources/CapcomdClient/openapi.json"]) {
      const envelopes = patterns(json(f), "type").filter((p) => p.includes("plugin"));
      expect(envelopes.length).toBeGreaterThan(0);
      for (const p of envelopes) expect(p).toBe(EVENT_TYPE_PATTERN);
    }
  });
  test("the manifest JSON Schema and the protocol's emit body in the contract", () => {
    const schema = json("packages/plugin/schema/plugin-manifest.schema.json");
    expect(schema.properties.name.pattern).toBe(PLUGIN_NAME_PATTERN);
    expect(schema.properties.contributes.properties.events.items.pattern).toBe(EVENT_NAME_PATTERN);
    expect(openapi.paths["/v1/plugins/{name}/events"].post.requestBody.content["application/json"].schema.properties.type.pattern).toBe(EVENT_NAME_PATTERN);
  });
});

describe("a manifest naming an event that wouldn't make a valid type is refused at validate", () => {
  const manifest = (events: string[]) => ({
    schema: "capcomd.plugin/v1", name: "event-writer", version: "1.0.0", description: "Writes events.", apiVersion: 1,
    engines: { capcomd: ">=0.0.0" }, entry: { runtime: "process", command: ["./run"] }, scopes: ["steer"], contributes: { events },
  });
  const dir = (events: string[]) => {
    const d = mkdtempSync(join(tmpdir(), "capcomd-event-types-"));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "plugin.json"), JSON.stringify(manifest(events)));
    writeFileSync(join(d, "run"), "#!/bin/sh\n", { mode: 0o755 });
    return d;
  };
  test.each([["Verdict"], ["thread-posted"], ["a.b"], ["_x"], ["9lives"], [""]])("contributes.events [%p]", (e) => {
    const r = readManifest(dir([e]), { capcomd: "0.9.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain("contributes.events.0");
  });
  test("capcomd plugins validate says which, and passes a good one", () => {
    const home = mkdtempSync(join(tmpdir(), "capcomd-event-types-home-"));
    const cli = (d: string) => {
      const p = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli", "index.ts"), "plugins", "validate", d, "--json"], { env: { ...process.env, CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1" }, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, body: JSON.parse(p.stdout.toString()) };
    };
    const bad = cli(dir(["verdict", "thread-posted"]));
    expect(bad.code).not.toBe(0);
    expect(bad.body.plugins[0]).toMatchObject({ ok: false, issues: [expect.objectContaining({ path: "contributes.events.1" })] });
    const good = cli(dir(["verdict", "thread_posted"]));
    expect(good.code).toBe(0);
    expect(good.body.plugins[0]).toMatchObject({ name: "event-writer", ok: true });
  });
});

describe("the kernel writes only a plugin's own types (src/plugins/host.ts)", () => {
  const sinks = () => {
    const daemon: unknown[] = [], run: Array<[string, any]> = [];
    const write = pluginEventWriter({ daemon: (e) => { daemon.push(e); return { seq: daemon.length }; }, run: async (id, e) => { run.push([id, e]); return { seq: 40 + run.length }; } });
    return { daemon, run, write };
  };
  test("the daemon stream or a run's, with the plugin's entity, else plugin:<name>", async () => {
    const { daemon, run, write } = sinks();
    expect(await write({ type: "plugin.gate-reviewer.verdict", stream: "daemon", entity: "", text: "Reviewed.", data: { n: 1 } })).toEqual({ seq: 1 });
    expect(daemon).toEqual([{ type: "plugin.gate-reviewer.verdict", entity: "plugin:gate-reviewer", text: "Reviewed.", data: { n: 1 } }]);
    expect(await write({ type: "plugin.gate-reviewer.verdict", stream: "run-abc", entity: "vfy-1", text: "Reviewed.", data: {} })).toEqual({ seq: 41 });
    expect(run[0]![0]).toBe("run-abc");
    expect(run[0]![1]).toMatchObject({ type: "plugin.gate-reviewer.verdict", entity: "vfy-1", text: "Reviewed.", data: {}, key: expect.stringMatching(/^plugin-gate-reviewer-/) });
  });
  test("a kernel type, a malformed type and an ephemeral event are refused", async () => {
    const { daemon, run, write } = sinks();
    for (const type of ["plugin.loaded", "run.created", "plugin.gate_reviewer.verdict", "plugin.x.y.z"])
      await expect(write({ type, stream: "run-abc", entity: "x", text: "x", data: {} })).rejects.toMatchObject({ code: "invalid" });
    await expect(write({ type: "plugin.x.y", stream: "daemon", entity: "x", text: "x", data: {}, durability: "ephemeral" })).rejects.toMatchObject({ code: "unsupported" });
    expect([daemon.length, run.length]).toEqual([0, 0]);
  });
});
