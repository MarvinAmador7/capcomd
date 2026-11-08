// Test plugin (tests/plugins/events-subscribe.test.ts, tests/scenarios/plugin-subscribe.test.ts): at activate it
// subscribes to the daemon stream for its own `plugin.event-listener.noted` and the kernel's `profile.changed`; when the
// daemon starts it notes so on that stream, and when a run is created it subscribes to the run's stream for
// `run.created` and `agent.spawned`, from the start. It records each event it hears, with how many of its handlers were
// running at once (so a test sees order, and that delivery is never concurrent), in memory and, when
// CAPCOMD_TEST_EVENT_LOG names a file, one JSON line each there. In a process that isn't the daemon there is no stream
// to subscribe to (`unsupported`): it listens to nothing there. Its context is handed to the in-process test.
import { appendFileSync } from "node:fs";
import { definePlugin } from "../../../../packages/plugin/src/index";
import type { HarnessEventEnvelope, PluginContext } from "../../../../packages/plugin/src/context";
import { PluginError } from "../../../../packages/plugin/src/errors";

export type Heard = { stream: string; type: string; seq: number; entitySeq: number; text: string; overlap: number };
export const heard: Heard[] = [];
export const listener: { ctx: PluginContext | null } = { ctx: null };

let running = 0;
/** A handler that records an event after a short wait (so a second delivery would overlap it if one came early). */
export const recorder = (stream: string) => async (e: HarnessEventEnvelope) => {
  running++;
  try {
    await new Promise((r) => setTimeout(r, 5));
    const h: Heard = { stream, type: e.type, seq: e.seq, entitySeq: e.entitySeq, text: e.text, overlap: running };
    heard.push(h);
    if (process.env.CAPCOMD_TEST_EVENT_LOG) appendFileSync(process.env.CAPCOMD_TEST_EVENT_LOG, `${JSON.stringify(h)}\n`);
  } finally { running--; }
};

export const plugin = definePlugin({
  activate(ctx) {
    listener.ctx = ctx;
    try {
      ctx.events.subscribe("daemon", { types: ["plugin.event-listener.noted", "profile.changed"] }, recorder("daemon"));
    } catch (e) {
      if (e instanceof PluginError && e.code === "unsupported") return;   // not the daemon: nothing to listen to
      throw e;
    }
    ctx.hooks.on("daemon.started", async () => { await ctx.events.emit({ type: "noted", stream: "daemon", entity: "", text: "The daemon started.", data: {} }); });
    ctx.hooks.on("run.changed", (call) => {
      if (call.payload.change.kind === "created") ctx.events.subscribe(call.payload.run.id, { after: 0, types: ["run.created", "agent.spawned"] }, recorder(call.payload.run.id));
    });
  },
});
