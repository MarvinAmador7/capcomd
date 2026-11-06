// Worked example, spec §16.4: a watchdog built only on observe hooks and the jobs primitive's timer (capcomd's own, with
// a fuller notion of progress, is src/plugins/watchdog.ts). Progress means a checkpoint that changed files or a new kind
// of tool use; activity alone (steps of the same kind, no checkpoint) is not progress. The kernel's own `spinning`
// notice (src/agents/stuck.ts) catches repeated identical calls; this plugin catches the slower drift the super-agent
// essay describes: "the process is still running" but nothing lands.
import { definePlugin } from "../../src/index";

interface Config { everyMs: number; stalledAfterMs: number; stopAfterMs: number }

interface Watched {
  runId: string;
  startedAt: number;
  /** When something that counts as progress last happened. */
  progressAt: number;
  kinds: Set<string>;
  stalledSince: number | null;
}

export function isProgress(w: Watched, change: { kind: "step"; step: { kind: string } } | { kind: "checkpointed"; files: number }): boolean {
  if (change.kind === "checkpointed") return change.files > 0;
  if (w.kinds.has(change.step.kind)) return false;
  w.kinds.add(change.step.kind);
  return true;
}

export const plugin = definePlugin<Config>({
  activate(ctx) {
    const cfg = ctx.config.get();
    const watched = new Map<string, Watched>();

    ctx.hooks.on("agent.changed", (call) => {
      const { agent, change } = call.payload;
      const now = Date.parse(call.at);
      if (change.kind === "started") { watched.set(agent.id, { runId: agent.runId, startedAt: now, progressAt: now, kinds: new Set(), stalledSince: null }); return; }
      if (change.kind === "ended") { watched.delete(agent.id); return; }
      const w = watched.get(agent.id);
      if (!w) return;
      if ((change.kind === "step" || change.kind === "checkpointed") && isProgress(w, change)) {
        w.progressAt = now;
        if (w.stalledSince !== null) { w.stalledSince = null; void ctx.agents.notice(w.runId, agent.id, null, { signal: call.signal }).catch(() => {}); }
      }
    });

    // One timer for the whole daemon; the kernel re-arms it from its durable record after a restart (§16.2.6).
    ctx.hooks.on("daemon.started", async (call) => {
      await ctx.jobs.start({ kind: "timer", runId: null, owner: { plugin: true }, label: "watchdog tick", everyMs: cfg.everyMs }, { key: "watchdog:tick", signal: call.signal });
    });

    ctx.hooks.on("job.changed", async (call) => {
      const { job, change } = call.payload;
      if (job.plugin !== ctx.plugin.name || change.kind !== "fired") return;
      const now = Date.parse(call.at);
      for (const [agentId, w] of watched) {
        const quiet = now - w.progressAt;
        if (quiet < cfg.stalledAfterMs) continue;
        if (w.stalledSince === null) {
          w.stalledSince = now;
          const detail = `no checkpoint with changes and no new kind of work for ${Math.round(quiet / 60_000)} min`;
          await ctx.agents.notice(w.runId, agentId, { kind: "stalled", detail }, { signal: call.signal });
          await ctx.events.emit({ type: "stalled", stream: w.runId, entity: agentId, text: `Agent ${agentId} looks stalled.`, data: { agentId, quietMs: quiet } }, { signal: call.signal });
        } else if (quiet >= cfg.stopAfterMs) {
          await ctx.agents.cancel(w.runId, agentId, `watchdog: no progress for ${Math.round(quiet / 60_000)} min`, { signal: call.signal });
          await ctx.events.emit({ type: "stopped", stream: w.runId, entity: agentId, text: `The watchdog stopped agent ${agentId}.`, data: { agentId, stalledMs: now - w.stalledSince } }, { signal: call.signal });
          watched.delete(agentId);
        }
      }
    });
  },
});
