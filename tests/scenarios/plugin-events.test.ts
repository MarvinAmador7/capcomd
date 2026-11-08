// A plugin's own events on a run's stream (docs/spec/plugin-api.md §4.7.4, §13.1), against a real engine: a plugin
// with a hyphenated name (event-writer) emits `plugin.event-writer.noted` through its context, the kernel's writer
// (src/plugins/host.ts) records it as a scope event of the run, and harness.v1 serves it back, replayed and on the SSE
// stream, as a valid envelope with the plugin's entity and sentence; a subscription to the run's
// stream (src/plugins/events.ts, reading through the engine) hears the same envelopes. The pattern itself: tests/plugins/event-types.test.ts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { HarnessEventEnvelope, PluginContext, PluginModule } from "../../packages/plugin/src/context";
import { PluginHost } from "../../packages/plugin/src/host/host";
import { addClient, loadClients } from "../../src/api/clients";
import { HarnessEvent } from "../../src/api/envelope";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { eventSinks, scopeEvents } from "../../src/plugins/events";
import { pluginEventWriter } from "../../src/plugins/host";
import { VERSION } from "../../src/utils/self";
import { sleep } from "../helpers/engine";
import { world, newRun, trajectory, type World } from "./harness";

let w: World;
let host: PluginHost;
let ctx!: PluginContext;
let app: ReturnType<typeof harnessApp>;
let token = "";
const tmp = mkdtempSync(join(tmpdir(), "capcomd-plugin-events-"));

beforeAll(async () => {
  w = await world("plugin-events");
  const clients = join(tmp, "harness-clients.json");
  token = addClient("reader", ["read"], clients).token;
  app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), state: harnessState(null), pollMs: 100 });
  host = new PluginHost({
    capcomd: VERSION, kernel: [], emit: () => {}, dataDir: (n) => join(tmp, "plugins", n),
    sinks: { emit: pluginEventWriter(), redact: (t) => t.replace(/sk-ant-\w+/g, "[REDACTED]"), ...eventSinks({ daemon: () => [], run: scopeEvents }, { pollMs: 50 }) },
  });
  await host.start([{
    source: "builtin",
    manifest: { schema: "capcomd.plugin/v1", name: "event-writer", version: "1.0.0", description: "Writes its own events on run streams.", apiVersion: 1,
      engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, scopes: ["read", "steer"], contributes: { events: ["noted"] } },
    module: { activate(c) { ctx = c; } } as PluginModule<never>,
  }]);
}, 120_000);
afterAll(async () => { await host?.stop(); await w?.stop(); });

const auth = () => ({ authorization: `Bearer ${token}` });
async function readUntil(res: Response, until: (t: string) => boolean, ms = 20_000) {
  const r = res.body!.getReader(); const dec = new TextDecoder(); let t = "";
  const end = Date.now() + ms;
  let pending: Promise<any> | null = null;
  while (!until(t) && Date.now() < end) {
    pending ??= r.read();
    const x = await Promise.race([pending, sleep(100).then(() => null)]);
    if (!x) continue;
    pending = null;
    if (x.value) t += dec.decode(x.value);
    if (x.done) break;
  }
  r.cancel().catch(() => {});
  return t;
}

test("a hyphenated plugin's event is written on the run's stream and read back as a valid envelope", async () => {
  const run = await newRun(w);
  const { seq } = await ctx.events.emit({ type: "noted", stream: run, entity: "vfy-1", text: "Noted the run (key sk-ant-abc123).", data: { n: 1, key: "sk-ant-abc123" } });
  expect(seq).toBeGreaterThan(0);
  // A second one names no entity: it is the plugin's own.
  await ctx.events.emit({ type: "noted", stream: run, entity: "", text: "Noted again.", data: { n: 2 } });

  // Replayed (GET /v1/events), with the plugin's entity and sentence, redacted, and never an agent's event.
  const all = (await (await app.request(`/v1/events?scope=${run}`, { headers: auth() })).json()) as any[];
  const mine = all.filter((e) => e.type === "plugin.event-writer.noted");
  expect(mine.length).toBe(2);
  for (const e of mine) expect(HarnessEvent.safeParse(e).success).toBe(true);
  expect(mine[0]).toMatchObject({ seq, scope: run, entity: "vfy-1", entitySeq: 1, agentId: null, runId: run, durability: "durable", text: "Noted the run (key [REDACTED]).", data: { n: 1, key: "[REDACTED]" } });
  expect(mine[1]).toMatchObject({ entity: "plugin:event-writer", entitySeq: 1, text: "Noted again.", data: { n: 2 } });
  // The run's own events are as before: every envelope still parses, run.created first.
  expect(all[0].type).toBe("run.created");
  for (const e of all) expect(HarnessEvent.safeParse(e).success).toBe(true);

  // On the SSE stream, framed by its type, resumed from just before the first.
  const stream = await app.request(`/v1/streams/${run}/events`, { headers: { ...auth(), "last-event-id": String(seq - 1) } });
  expect(stream.status).toBe(200);
  const t = await readUntil(stream, (x) => x.includes("Noted again."));
  const frames = t.split("\n\n").filter((f) => f.includes("data: ")).map((f) => ({ event: /event: (.*)/.exec(f)?.[1], data: JSON.parse(/data: (.*)/.exec(f)![1]!) }));
  const live = frames.filter((f) => f.event === "plugin.event-writer.noted").map((f) => f.data);
  expect(live.map((e) => e.text)).toEqual(["Noted the run (key [REDACTED]).", "Noted again."]);
  // The same envelopes as replayed: entitySeq counts by the plugin's entity on both.
  expect(live.map((e) => [e.seq, e.entity, e.entitySeq])).toEqual(mine.map((e) => [e.seq, e.entity, e.entitySeq]));

  // In the run's own log (capcomd.v1 reads the same rows) under the dotted type, with no agent.
  const raw = (await trajectory(w, run)).filter((e) => e.type === "plugin.event-writer.noted");
  expect(raw.map((e: any) => [e.agentId, e.entity, e.text])).toEqual([[null, "vfy-1", "Noted the run (key [REDACTED])."], [null, "plugin:event-writer", "Noted again."]]);
}, 120_000);

test("an undeclared event, a run that doesn't exist and an ephemeral event are refused, and nothing is written", async () => {
  const run = await newRun(w);
  await expect(ctx.events.emit({ type: "other", stream: run, entity: "", text: "x", data: {} })).rejects.toMatchObject({ code: "forbidden" });
  await expect(ctx.events.emit({ type: "noted", stream: "run-doesnotexist", entity: "", text: "x", data: {} })).rejects.toMatchObject({ code: "not_found" });
  await expect(ctx.events.emit({ type: "noted", stream: run, entity: "", text: "x", data: {}, durability: "ephemeral" })).rejects.toMatchObject({ code: "unsupported" });
  expect((await trajectory(w, run)).filter((e) => e.type.startsWith("plugin."))).toEqual([]);
}, 60_000);

test("a subscription to the run's stream hears its events through the engine, in order, as replayed; disposed, nothing more", async () => {
  const run = await newRun(w);
  const types = ["run.created", "plugin.event-writer.noted"];
  const got: HarnessEventEnvelope[] = [];
  const sub = ctx.events.subscribe(run, { after: 0, types }, (e) => { got.push(e); });
  const { seq: a } = await ctx.events.emit({ type: "noted", stream: run, entity: "", text: "Heard one.", data: {} });
  const { seq: b } = await ctx.events.emit({ type: "noted", stream: run, entity: "", text: "Heard two.", data: {} });
  const end = Date.now() + 20_000;
  while (!got.some((e) => e.seq === b) && Date.now() < end) await sleep(50);
  expect(got.map((e) => e.type)).toEqual(types.concat(types[1]!));
  expect(got.slice(1).map((e) => [e.seq, e.text])).toEqual([[a, "Heard one."], [b, "Heard two."]]);
  // The envelopes replay and GET /v1/events serve, entitySeq included.
  const replayed = await ctx.events.replay(run, 0);
  expect(got).toEqual(replayed.filter((e) => types.includes(e.type)));
  const served = (await (await app.request(`/v1/events?scope=${run}`, { headers: auth() })).json()) as HarnessEventEnvelope[];
  expect(replayed).toEqual(served);
  expect((await ctx.events.replay(run, a)).map((e) => e.seq)).toEqual(served.filter((e) => e.seq > a).map((e) => e.seq));

  sub.dispose();
  await ctx.events.emit({ type: "noted", stream: run, entity: "", text: "Not heard.", data: {} });
  await sleep(300);
  expect(got.length).toBe(3);
  await expect(ctx.events.replay("run-doesnotexist", 0)).rejects.toMatchObject({ code: "not_found" });
}, 60_000);
