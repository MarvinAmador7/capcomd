// The watchdog (docs/spec/plugin-api.md §15.5, §16.4, §17.2 step 11): a built-in, daemon-only, off until `capcomd setup`
// turns it on (`plugins.watchdog.enabled`). It catches the failure liveness can't see: the agent's process runs and it
// keeps calling tools, but nothing lands. The kernel's own notices (`idle`, `spinning`, `failing`, src/agents/stuck.ts)
// watch the process; this watches the work, on its own definition of progress:
//  - its files changed (a `checkpointed`: the supervisor reports one only for a new tree), or those of an agent under it;
//  - an agent under it was spawned or ended (delegating, a hand-back), or it resumed;
//  - a job, verification or approval it waited on ended.
// Tool calls alone (`step`) are not progress. While it waits on something that reports back (a background job, a
// verification, an approval, a paused agent under it) its clock doesn't run, and an agent with agents of its own
// running is judged through them: they stall first, and their end is its progress. No progress for `stalledAfterMs`
// (15 min) raises the `stalled` notice (the app's amber hand; a parent sees it on its child); for `stopAfterMs` (45 min,
// both counted from the last progress) cancels the agent and its descendants, and says so once on the run's stream
// (`plugin.watchdog.stopped`, the one message §16.5 allows). Progress clears the notice.
// Its clock is one plugin timer (§16.2, re-armed by the daemon after a restart); what it knows of each agent is kept in
// its storage, and the time the daemon was down doesn't count.
import { definePlugin, type PluginContext } from "../../packages/plugin/src/context";
import { PluginError } from "../../packages/plugin/src/errors";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import type { Agent } from "../../packages/plugin/src/shapes";
import { VERSION } from "../utils/self";

export interface WatchdogConfig { stalledAfterMs: number; stopAfterMs: number; everyMs: number }

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "watchdog", version: VERSION,
  description: "Checks that running agents make progress, not just activity: an agent whose work hasn't changed for 15 minutes gets a stalled notice, and after 45 minutes it is stopped.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./watchdog.ts" },
  scopes: ["read", "steer"],
  contributes: {
    hooks: { "agent.changed": {}, "job.changed": {}, "verify.changed": {}, "approval.changed": {} },
    events: ["stopped"],
  },
  config: {
    type: "object", additionalProperties: false,
    properties: {
      stalledAfterMs: { type: "integer", minimum: 1000, default: 900_000, description: "No progress for this long: the agent gets a stalled notice" },
      stopAfterMs: { type: "integer", minimum: 0, default: 2_700_000, description: "No progress for this long (from the same point, so more than stalledAfterMs): the agent is stopped. 0: never" },
      everyMs: { type: "integer", minimum: 1000, default: 60_000, description: "How often the watchdog looks" },
    },
  },
};

/** What the watchdog knows of one agent (kept in its storage as `agents/<runId>/<agentId>`). */
export interface Watched {
  runId: string;
  agentId: string;
  /** Its parent, as last seen (null: a root, or not known yet). */
  parent: string | null;
  /** When it, or an agent under it, last made progress (ms). */
  since: number;
  /** What it waits on that reports back: `job:<id>`, `verify:<id>`, `approval:<id>`, `paused`. */
  waits: string[];
  /** When the watchdog raised `stalled` on it; null when it hasn't or the notice went. */
  stalledAt: number | null;
  /** The watchdog asked to stop it (it ends soon). */
  stopping?: boolean;
  /** When the kernel last confirmed it exists and how it is (ms). */
  checkedAt?: number;
}

const ACTIVE = new Set(["pending", "running", "paused"]);
const PREFIX = "agents/";

/** "15 min", "40 s": how long, as the notice and the event say it. */
export function spoken(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

/** The notice's text: what didn't happen, and what comes next. */
export function stalledDetail(quietMs: number, cfg: WatchdogConfig): string {
  const next = cfg.stopAfterMs > 0 ? `; the watchdog stops it after ${spoken(cfg.stopAfterMs)} without progress` : "";
  return `no progress for ${spoken(quietMs)} (no file changed; no agent, job, check or approval of its own finished)${next}`;
}

export function watchdog(ctx: PluginContext<WatchdogConfig>) {
  const cfg = ctx.config.get();
  if (cfg.stopAfterMs !== 0 && cfg.stopAfterMs <= cfg.stalledAfterMs)
    throw new PluginError("invalid", `plugins.watchdog.stopAfterMs is ${cfg.stopAfterMs}: it must be 0 (never stop) or more than stalledAfterMs (${cfg.stalledAfterMs}), since both count from the last progress`);
  const watched = new Map<string, Watched>();
  const keyOf = (runId: string, agentId: string) => `${runId}/${agentId}`;

  // ---- what it remembers -------------------------------------------------------------------------------------------
  const dirty = new Set<string>();
  let saving: Promise<void> = Promise.resolve();
  const save = (w: Watched | string) => {
    dirty.add(typeof w === "string" ? w : keyOf(w.runId, w.agentId));
    saving = saving.then(async () => {
      const keys = [...dirty];
      dirty.clear();
      for (const k of keys) {
        const w = watched.get(k);
        if (w) await ctx.storage.put("daemon", `${PREFIX}${k}`, w);
        else await ctx.storage.delete("daemon", `${PREFIX}${k}`);
      }
    }).catch((e) => ctx.log.warn("couldn't keep what the watchdog knows", { error: String((e as Error)?.message ?? e) }));
  };

  /** The agent as the watchdog knows it, learned now when it doesn't yet (its clock starts now). */
  const learn = (runId: string, agentId: string, parent?: string | null): Watched => {
    const k = keyOf(runId, agentId);
    let w = watched.get(k);
    if (!w) { watched.set(k, w = { runId, agentId, parent: parent ?? null, since: Date.now(), waits: [], stalledAt: null }); save(w); }
    if (parent !== undefined && parent !== w.parent) { w.parent = parent; save(w); }
    // Its parent too: an agent under it moves its clock.
    if (w.parent && !watched.has(keyOf(runId, w.parent))) learn(runId, w.parent);
    return w;
  };
  const learnAgent = (a: Agent) => learn(a.runId, a.id, a.parent);

  /** Progress on `agentId`: its clock and every ancestor's start again; a stalled notice goes. */
  const progress = (runId: string, agentId: string | null) => {
    const now = Date.now();
    const seen = new Set<string>();
    for (let id = agentId; id && !seen.has(id); ) {
      seen.add(id);
      const w = watched.get(keyOf(runId, id));
      if (!w) break;
      if (w.since < now) { w.since = now; save(w); }
      if (w.stalledAt !== null) {
        w.stalledAt = null;
        save(w);
        void ctx.agents.notice(runId, id, null).catch((e) => ctx.log.debug("clearing a stalled notice failed", { agentId: id, error: String((e as Error)?.message ?? e) }));
      }
      id = w.parent;
    }
  };
  const wait = (w: Watched, on: string) => { if (!w.waits.includes(on)) { w.waits.push(on); save(w); } };
  const unwait = (runId: string, agentId: string, on: string) => {
    const w = watched.get(keyOf(runId, agentId));
    if (w?.waits.includes(on)) { w.waits = w.waits.filter((x) => x !== on); save(w); }
    progress(runId, agentId);
  };
  const forget = (runId: string, agentId: string) => { if (watched.delete(keyOf(runId, agentId))) save(keyOf(runId, agentId)); };

  // ---- the signals ---------------------------------------------------------------------------------------------------
  ctx.hooks.on("agent.changed", ({ payload: { agent, change } }) => {
    switch (change.kind) {
      case "ended":
        forget(agent.runId, agent.id);
        progress(agent.runId, agent.parent); // a hand-back
        return;
      case "spawned":
        learnAgent(agent);
        progress(agent.runId, agent.parent); // delegating
        return;
      case "started": case "resumed": {
        const w = learnAgent(agent);
        if (w.waits.includes("paused")) { w.waits = w.waits.filter((x) => x !== "paused"); save(w); }
        progress(agent.runId, agent.id);
        return;
      }
      case "checkpointed":
        learnAgent(agent);
        progress(agent.runId, agent.id);
        return;
      case "paused":
        wait(learnAgent(agent), "paused");
        return;
      case "notice": {
        // Its stalled notice went (cleared, or the kernel raised its own over it): raise it again if still quiet.
        const w = learnAgent(agent);
        if (w.stalledAt !== null && change.notice?.kind !== "stalled") { w.stalledAt = null; save(w); }
        return;
      }
      default:
        learnAgent(agent);
    }
  });

  ctx.hooks.on("job.changed", ({ payload: { job, change } }) => {
    // Its own clock: the look runs on its own, outside this call's deadline (it may cancel agents).
    if (job.plugin === ctx.plugin.name) { if (change.kind === "fired") void tick().catch((e) => ctx.log.warn("the watchdog's look failed", { error: String((e as Error)?.message ?? e) })); return; }
    // An agent's background command: waiting on it isn't stalling, and its end is progress.
    if (job.spec.kind !== "exec" || !job.spec.runId || !("agentId" in job.spec.owner)) return;
    const { runId } = job.spec, agentId = job.spec.owner.agentId;
    if (change.kind === "started") wait(learn(runId, agentId), `job:${job.jobId}`);
    else if (change.kind === "ended") unwait(runId, agentId, `job:${job.jobId}`);
  });

  ctx.hooks.on("verify.changed", ({ principal, payload: { verification: v, change } }) => {
    if (principal.kind !== "agent") return;
    if (change.kind === "started") wait(learn(v.runId, principal.agentId), `verify:${v.vfyId}`);
    else if (change.kind === "finished") unwait(v.runId, principal.agentId, `verify:${v.vfyId}`);
  });

  ctx.hooks.on("approval.changed", ({ payload: { approval: a, change } }) => {
    if (!a.agentId) return;
    if (change.kind === "requested") wait(learn(a.runId, a.agentId), `approval:${a.approvalId}`);
    else unwait(a.runId, a.agentId, `approval:${a.approvalId}`);
  });

  // ---- the clock -----------------------------------------------------------------------------------------------------
  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      await ctx.storage.put("daemon", "clock", { at: now }).catch(() => {});
      const all = [...watched.values()];
      const children = new Map<string, Watched[]>();
      for (const w of all) if (w.parent) { const k = keyOf(w.runId, w.parent); children.set(k, [...(children.get(k) ?? []), w]); }
      /** It, or an agent under it, waits on something that reports back. */
      const held = (w: Watched, seen = new Set<string>()): boolean => {
        const k = keyOf(w.runId, w.agentId);
        if (seen.has(k)) return false;
        seen.add(k);
        return w.waits.length > 0 || (children.get(k) ?? []).some((c) => held(c, seen));
      };
      for (const w of all) {
        if (!watched.has(keyOf(w.runId, w.agentId)) || w.stopping) continue;
        const quiet = now - w.since;
        // Look it up when it may need acting on, and now and then anyway (one that ended while the daemon was down, or
        // whose ending nobody told, is forgotten).
        const stale = now - (w.checkedAt ?? 0) >= cfg.stalledAfterMs;
        const judged = !held(w) && !(children.get(keyOf(w.runId, w.agentId)) ?? []).length && quiet >= cfg.stalledAfterMs;
        if (!judged && !stale) continue;
        const a = await ctx.agents.get(w.runId, w.agentId).catch((e: unknown) => (e instanceof PluginError && (e.code === "not_found" || e.code === "invalid") ? null : undefined));
        if (a === undefined) continue; // the engine didn't answer: next time
        w.checkedAt = now;
        if (!a || !ACTIVE.has(a.status)) { forget(w.runId, w.agentId); continue; }
        if (a.parent !== w.parent) { w.parent = a.parent; save(w); }
        if (!judged || a.status !== "running") continue;
        if (cfg.stopAfterMs > 0 && quiet >= cfg.stopAfterMs) await stop(w, quiet);
        else if (w.stalledAt === null) await stalled(w, quiet);
      }
    } finally { ticking = false; }
  }

  async function stalled(w: Watched, quiet: number) {
    try {
      await ctx.agents.notice(w.runId, w.agentId, { kind: "stalled", detail: stalledDetail(quiet, cfg) });
      w.stalledAt = Date.now();
      save(w);
      ctx.log.info("an agent looks stalled", { runId: w.runId, agentId: w.agentId, quietMs: quiet });
    } catch (e) { ctx.log.warn("raising a stalled notice failed", { agentId: w.agentId, error: String((e as Error)?.message ?? e) }); }
  }

  async function stop(w: Watched, quiet: number) {
    w.stopping = true;
    save(w);
    try {
      await ctx.agents.cancel(w.runId, w.agentId, `no progress for ${spoken(quiet)} (no file changed; no agent, job, check or approval of its own finished)`);
    } catch (e) {
      w.stopping = false;
      save(w);
      ctx.log.warn("stopping a stalled agent failed", { agentId: w.agentId, error: String((e as Error)?.message ?? e) });
      return;
    }
    ctx.log.info("stopped a stalled agent", { runId: w.runId, agentId: w.agentId, quietMs: quiet });
    await ctx.events.emit({
      type: "stopped", stream: w.runId, entity: w.agentId,
      text: `The watchdog stopped ${w.agentId}: no progress for ${spoken(quiet)}.`,
      data: { agentId: w.agentId, quietMs: quiet, stalledAt: w.stalledAt === null ? null : new Date(w.stalledAt).toISOString() },
    }).catch((e) => ctx.log.warn("recording the stop failed", { agentId: w.agentId, error: String((e as Error)?.message ?? e) }));
  }

  return {
    watched,
    tick,
    /** What it knew before the daemon stopped, with the time it was down taken off every clock; then its timer. */
    async start() {
      try {
        const keys = await ctx.storage.list("daemon", PREFIX);
        const last = (await ctx.storage.get("daemon", "clock")) as { at?: number } | undefined;
        const down = typeof last?.at === "number" ? Math.max(0, Date.now() - last.at) : 0;
        for (const k of keys) {
          const w = (await ctx.storage.get("daemon", k)) as Watched | undefined;
          if (!w || typeof w.runId !== "string" || typeof w.agentId !== "string" || typeof w.since !== "number") continue;
          watched.set(keyOf(w.runId, w.agentId), { ...w, since: w.since + down, waits: Array.isArray(w.waits) ? w.waits : [], stalledAt: w.stalledAt ?? null, stopping: false });
        }
      } catch (e) {
        if (e instanceof PluginError && e.code === "unsupported") return; // not the daemon: no clock here
        ctx.log.warn("couldn't read what the watchdog knew", { error: String((e as Error)?.message ?? e) });
      }
      // One timer, kept across restarts by its key; one with another interval (an earlier config) is stopped.
      const clock = await ctx.jobs.start({ kind: "timer", runId: null, owner: { plugin: true }, label: "watchdog clock", everyMs: cfg.everyMs }, { key: `clock-${cfg.everyMs}` })
        .catch((e: unknown) => { if (!(e instanceof PluginError && e.code === "unsupported")) ctx.log.warn("the watchdog's clock did not start", { error: String((e as Error)?.message ?? e) }); return null; });
      if (!clock) return;
      for (const j of await ctx.jobs.list({ state: "running" }).catch(() => [])) if (j.jobId !== clock.jobId) await ctx.jobs.cancel(j.jobId, "the watchdog's interval changed").catch(() => {});
      await ctx.storage.put("daemon", "clock", { at: Date.now() }).catch(() => {});
    },
    flushed: () => saving,
  };
}

export const plugin = definePlugin<WatchdogConfig>({
  async activate(ctx) {
    const w = watchdog(ctx);
    await w.start();
    ctx.onDispose(() => w.flushed());
  },
});
