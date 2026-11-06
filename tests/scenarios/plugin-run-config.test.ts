// Plugin API §10.2 layer 5, through a real engine: `capcomd run new --plugin-config <plugin>.<key>=<value>` checks the
// setting against the plugin's schema (x-per-run only) before the run exists, and keeps it in the plugin's run storage
// under `config`, where the plugin reads it (ctx.storage / GET /v1/plugins/{name}/storage) and can't write it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { world, type World } from "./harness";
import { pluginStore } from "../../src/plugins/storage";

const home = process.env.CAPCOMD_HOME!;
const dir = join(home, "plugins", "notify");
let w: World;

beforeAll(async () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({
    schema: "capcomd.plugin/v1", name: "notify", version: "1.0.0", description: "a notifier with per-run settings", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
    entry: { runtime: "process", command: ["true"] }, contributes: { hooks: { "run.changed": {} } },
    config: { type: "object", additionalProperties: false, properties: { channel: { type: "string", default: "#general", "x-per-run": true }, digestEvery: { type: "integer", default: 10 } } },
  }));
  w = await world("plugin-run-config");
}, 180_000);
afterAll(async () => {
  try { await w?.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a run's per-run plugin setting is kept in the plugin's run storage; any other is refused before the run exists", async () => {
  const made = await w.cj(["run", "new", "--budget", "usd=1", "--key", `cfg-${Date.now()}`, "--plugin-config", "notify.channel=#release"]);
  expect(made.code).toBe(0);
  const runId = made.j.runId as string;
  expect((await w.cj(["kv", "get", runId, "plugin/notify/config"])).j).toMatchObject({ value: { channel: "#release" }, writer: "operator" });
  const store = pluginStore("notify", join(home, "state", "plugins", "notify"));
  expect((await store.get({ runId }, "config"))?.value).toEqual({ channel: "#release" });
  await expect(store.put({ runId }, "config", { channel: "#mine" })).rejects.toThrow(/written by capcomd/);
  // Not per-run, not valid, not a plugin: refused (usage), and no run was made.
  for (const [flag, text] of [["notify.digestEvery=5", "can't be set per run"], ["notify.channel=5", "plugins.notify.channel"], ["ghost.x=1", "no plugin ghost"]] as const) {
    const key = `cfg-bad-${Math.random().toString(36).slice(2)}`;
    const r = await w.cj(["run", "new", "--budget", "usd=1", "--key", key, "--plugin-config", flag]);
    expect(r.code).toBe(2);
    expect(r.j).toMatchObject({ ok: false, error: { code: "usage", reason: "plugins" } });
    expect(r.j.error.message).toContain(text);
  }
}, 120_000);
