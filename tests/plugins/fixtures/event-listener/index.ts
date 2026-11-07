// Test plugin (tests/plugins/events-subscribe.test.ts): at activate it subscribes to the daemon stream for its own
// `plugin.event-listener.noted` and the kernel's `profile.changed`, and records each event it hears, with how many of
// its handlers were running at once, so the test sees order and that delivery is never concurrent. Its context is
// handed to the test, which subscribes it to run streams as it makes them.
import { definePlugin } from "../../../../packages/plugin/src/index";
import type { HarnessEventEnvelope, PluginContext } from "../../../../packages/plugin/src/context";

export const heard: Array<{ stream: string; type: string; seq: number; entitySeq: number; text: string; overlap: number }> = [];
export const listener: { ctx: PluginContext | null } = { ctx: null };

let running = 0;
/** A handler that records an event after a short wait (so a second delivery would overlap it if one came early). */
export const recorder = (stream: string) => async (e: HarnessEventEnvelope) => {
  running++;
  try {
    await new Promise((r) => setTimeout(r, 5));
    heard.push({ stream, type: e.type, seq: e.seq, entitySeq: e.entitySeq, text: e.text, overlap: running });
  } finally { running--; }
};

export const plugin = definePlugin({
  activate(ctx) {
    listener.ctx = ctx;
    ctx.events.subscribe("daemon", { types: ["plugin.event-listener.noted", "profile.changed"] }, recorder("daemon"));
  },
});
