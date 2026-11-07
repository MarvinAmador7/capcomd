// The watchdog (docs/spec/plugin-api.md §15.5, §16.4, §17.2 step 11): a built-in, daemon-only, off until `capcomd setup`
// turns it on (`plugins.watchdog.enabled`). It catches the failure liveness can't see: the agent's process runs and it
// keeps calling tools, but nothing lands. The kernel's own notices (`idle`, `spinning`, `failing`, src/agents/stuck.ts)
// watch the process; this watches the work, on its own definition of progress:
//  - its files changed (`worked {files}`: its supervisor's fingerprint of the checkout changed, seen within a
//    heartbeat, about 30 s; or a `checkpointed`), or those of an agent under it;
//  - an agent under it was spawned or ended (delegating, a hand-back), or it resumed;
//  - a verification or approval it waited on ended.
// Tool calls alone (`step`) are not progress, and neither is a job's end or its output. While it waits on something (a
// job, a verification, an approval, a foreground command of its CLI, a paused agent under it) its clock doesn't run:
// that time doesn't count (once, when waits overlap). Commands count so for at most `stalledAfterMs` in all between two
// signs of progress, however many there are, so one that hangs, or one run again and again, is still caught. An agent
// with agents of its own running is judged through them: they stall first, and their end is its progress. An agent
// whose work never shows as files changing (a reviewer, a report-only agent, an orchestrate agent: none is
// checkpointed) isn't judged at all; the kernel's own notices still watch its process. While the kernel's own notice
// shows on an agent, `stalled` isn't raised over it (the stop still comes). No progress for `stalledAfterMs` (15 min)
// raises the `stalled` notice (the app's amber hand; a parent sees it on its child); for `stopAfterMs` (45 min, both
// counted from the last progress) cancels the agent and its descendants, and says so once on the run's stream
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

/** How often a working agent's progress is seen at the longest: its supervisor's heartbeat (30 s) says its files changed
 *  or that it waits on a command, with room for a slow look. A stall limit below it flags agents that are working. */
export const PROGRESS_SIGNAL_MS = 60_000;

/** What the watchdog knows of one agent (kept in its storage as `agents/<runId>/<agentId>`). */
export interface Watched {
  runId: string;
  agentId: string;
  /** Its parent, as last seen (null: a root, or not known yet). */
  parent: string | null;
  /** When it, or an agent under it, last made progress (ms), moved on by the time that doesn't count. */
  since: number;
  /** Up to when (ms) its time is accounted for: its last progress, or the end of the last time taken off its clock. Time
   *  before it is never taken off again, so a job and the foreground command that waits on it count once. */
  creditedTo?: number;
  /** What it waits on that reports back: `job:<id>`, `verify:<id>`, `approval:<id>`, `paused`. */
  waits: string[];
  /** Since when its waits hold its clock; null while it waits on nothing. */
  heldAt?: number | null;
  /** The foreground command it was last seen waiting on: when it started, and when it was last seen running. */
  command?: { since: number; seenAt: number } | null;
  /** How much of its commands' time was taken off its clock since its last progress (at most stalledAfterMs). */
  commanded?: number;
  /** Steps of its tools that finished since its last progress (what the notice says it did meanwhile). */
  steps?: number;
  /** When the watchdog raised `stalled` on it; null when it hasn't or the notice went. */
  stalledAt: number | null;
  /** The watchdog asked to stop it (it ends soon). */
  stopping?: boolean;
  /** When the kernel last confirmed it exists and how it is (ms). */
  checkedAt?: number;
  /** Its work never shows as files changing (the kernel said so when it was first judged): it isn't judged. */
  blind?: boolean;
  /** The kind of a notice of the kernel's that shows on it (`idle`, `spinning`, …); `stalled` isn't raised over it. */
  other?: string | null;
}

const ACTIVE = new Set(["pending", "running", "paused"]);
const PREFIX = "agents/";

/** "15 min", "40 s": how long, as the notice and the event say it. */
export function spoken(ms: number): string {
  return ms >= 120_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

/** What the watchdog saw an agent do while it made no progress (the notice and the stop say it). */
export interface Seen { steps: number; commandMs: number | null }

/** Why it is judged stalled, as observed: what didn't happen, and what it did meanwhile. */
export function stalledWhy(quietMs: number, seen: Seen = { steps: 0, commandMs: null }): string {
  const did = seen.steps ? `it finished ${seen.steps} tool step${seen.steps === 1 ? "" : "s"} meanwhile` : "it finished no tool step meanwhile";
  const cmd = seen.commandMs !== null ? `; it has been waiting on one command for ${spoken(seen.commandMs)}` : "";
  return `no progress for ${spoken(quietMs)}: no file change seen, no agent of its own started or ended, no check or approval it waited on finished; ${did}${cmd}`;
}

/** The notice's text: why, and what comes next. */
export function stalledDetail(quietMs: number, cfg: WatchdogConfig, seen?: Seen): string {
  const next = cfg.stopAfterMs > 0 ? `; the watchdog stops it after ${spoken(cfg.stopAfterMs)} without progress` : "";
  return `${stalledWhy(quietMs, seen)}${next}`;
}

/** What's wrong with settings the schema accepts (null: nothing): the stop comes after the notice, or never. */
export function configProblem(cfg: WatchdogConfig): string | null {
  return cfg.stopAfterMs !== 0 && cfg.stopAfterMs <= cfg.stalledAfterMs
    ? `plugins.watchdog.stopAfterMs is ${cfg.stopAfterMs}: it must be 0 (never stop) or more than stalledAfterMs (${cfg.stalledAfterMs}), since both count from the last progress`
    : null;
}

/** What's risky in settings it accepts (null: nothing): a stall limit shorter than progress takes to show, said by
 *  `capcomd setup` and in the plugin's log when it starts. */
export function configWarning(cfg: Pick<WatchdogConfig, "stalledAfterMs">): string | null {
  return cfg.stalledAfterMs < PROGRESS_SIGNAL_MS
    ? `plugins.watchdog.stalledAfterMs is ${cfg.stalledAfterMs}: below ${PROGRESS_SIGNAL_MS}, how long an agent's progress (its files changing, a command it waits on) may take to show, so an agent that is working may be flagged`
    : null;
}

export interface WatchdogOptions {
  /** Whether the agent's work shows as its files changing (the kernel's answer, src/plugins/services.ts
   *  `showsFileChanges`); without it every agent is judged. A rejection: ask again at the next look. */
  showsWork?: (runId: string, agentId: string) => Promise<boolean>;
}

export function watchdog(ctx: PluginContext<WatchdogConfig>, o: WatchdogOptions = {}) {
  const cfg = ctx.config.get();
  const problem = configProblem(cfg);
  if (problem) throw new PluginError("invalid", problem);
  const warning = configWarning(cfg);
  if (warning) ctx.log.warn(warning);
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
      if (w.since < now || w.steps || w.commanded) { w.since = Math.max(w.since, now); w.creditedTo = w.since; w.steps = 0; w.commanded = 0; save(w); }
      if (w.stalledAt !== null) {
        w.stalledAt = null;
        save(w);
        void ctx.agents.notice(runId, id, null).catch((e) => ctx.log.debug("clearing a stalled notice failed", { agentId: id, error: String((e as Error)?.message ?? e) }));
      }
      id = w.parent;
    }
  };
  /** Where time taken off its clock may start: its last progress, or the end of what was taken off last. */
  const accounted = (w: Watched) => w.creditedTo ?? w.since;
  /** The time from `from` to `to` doesn't count against it: its clock moves on by that much (by what came after its
   *  last progress or the last time taken off, when that was later: overlapping waits count once). Returns what it took
   *  off. */
  const credit = (w: Watched, from: number, to: number) => {
    const add = to - Math.max(from, accounted(w));
    if (add <= 0) return 0;
    w.since += add;
    w.creditedTo = to;
    save(w);
    return add;
  };
  const wait = (w: Watched, on: string) => {
    if (w.waits.includes(on)) return;
    if (!w.waits.length) w.heldAt = Date.now();
    w.waits.push(on);
    save(w);
  };
  /** It no longer waits on `on`: the time it waited doesn't count. */
  const release = (w: Watched, on: string) => {
    if (!w.waits.includes(on)) return;
    w.waits = w.waits.filter((x) => x !== on);
    if (!w.waits.length) { credit(w, w.heldAt ?? Date.now(), Date.now()); w.heldAt = null; }
    save(w);
  };
  const unwait = (runId: string, agentId: string, on: string) => {
    const w = watched.get(keyOf(runId, agentId));
    if (w) release(w, on);
    progress(runId, agentId);
  };
  /** A foreground command it waits on, seen running now: the time since it was last seen (or started) doesn't count, up
   *  to stalledAfterMs for all its commands since its last progress (a command run again and again, polling, is no
   *  more progress than one that hangs). */
  const commanding = (w: Watched, since: number) => {
    const now = Date.now();
    let c = w.command;
    if (!c || c.since !== since) c = w.command = { since, seenAt: Math.max(since, c?.seenAt ?? 0) };
    const room = cfg.stalledAfterMs - (w.commanded ?? 0);
    if (room > 0) w.commanded = (w.commanded ?? 0) + credit(w, c.seenAt, Math.min(now, Math.max(c.seenAt, accounted(w)) + room));
    c.seenAt = Math.max(c.seenAt, now);
    save(w);
  };
  /** It waits on a command still: one seen running within PROGRESS_SIGNAL_MS, while its commands' time doesn't count. */
  const onCommand = (w: Watched, now: number) => !!w.command && now - w.command.seenAt <= PROGRESS_SIGNAL_MS && (w.commanded ?? 0) < cfg.stalledAfterMs;
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
        release(w, "paused");
        if (w.other) { w.other = null; save(w); } // a pause took the kernel's notice away
        progress(agent.runId, agent.id);
        return;
      }
      case "checkpointed":
        learnAgent(agent);
        progress(agent.runId, agent.id);
        return;
      case "worked": {
        // What its runner saw: its files changed (progress); a foreground command it waits on (its time doesn't count).
        const w = learnAgent(agent);
        const since = change.command ? Date.parse(change.command.since) : NaN;
        if (Number.isFinite(since)) commanding(w, since);
        if (change.files) progress(agent.runId, agent.id);
        return;
      }
      case "step": {
        // Activity, not progress: counted for what the notice says it did meanwhile.
        const w = learnAgent(agent);
        w.steps = (w.steps ?? 0) + 1;
        save(w);
        return;
      }
      case "paused": {
        const w = learnAgent(agent);
        if (w.other) { w.other = null; save(w); }
        wait(w, "paused");
        return;
      }
      case "notice": {
        // Its stalled notice went (cleared, or the kernel raised its own over it): raise it again once it is quiet and
        // shows none of the kernel's.
        const w = learnAgent(agent);
        if (w.stalledAt !== null && change.notice?.kind !== "stalled") { w.stalledAt = null; save(w); }
        const other = change.notice && change.notice.kind !== "stalled" ? change.notice.kind : null;
        if ((w.other ?? null) !== other) { w.other = other; save(w); }
        return;
      }
      default:
        learnAgent(agent);
    }
  });

  ctx.hooks.on("job.changed", ({ payload: { job, change } }) => {
    // Its own clock: the look runs on its own, outside this call's deadline (it may cancel agents).
    if (job.plugin === ctx.plugin.name) { if (change.kind === "fired") void tick().catch((e) => ctx.log.warn("the watchdog's look failed", { error: String((e as Error)?.message ?? e) })); return; }
    // An agent's command run as a job, in the foreground or the background: while it runs the agent waits, and that
    // time doesn't count; its end, like its output, isn't progress (what it leads to is: files changing, a hand-back).
    if (job.spec.kind !== "exec" || !job.spec.runId || !("agentId" in job.spec.owner)) return;
    const { runId } = job.spec, agentId = job.spec.owner.agentId;
    if (change.kind === "started") wait(learn(runId, agentId), `job:${job.jobId}`);
    else if (change.kind === "ended") { const w = watched.get(keyOf(runId, agentId)); if (w) release(w, `job:${job.jobId}`); }
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
        return w.waits.length > 0 || onCommand(w, now) || (children.get(k) ?? []).some((c) => held(c, seen));
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
        // One whose work can't show as files changing (a reviewer, a report, an orchestrate agent) isn't judged.
        if (w.blind === undefined && o.showsWork) {
          const shows = await o.showsWork(w.runId, w.agentId).catch(() => undefined);
          if (shows === undefined) continue; // the engine didn't answer: next time
          w.blind = !shows;
          save(w);
        }
        if (w.blind) continue;
        if (cfg.stopAfterMs > 0 && quiet >= cfg.stopAfterMs) await stop(w, quiet);
        else if (w.stalledAt === null && !w.other) await stalled(w, quiet);
      }
    } finally { ticking = false; }
  }

  /** What it did while it made no progress: its tools' steps, and a command it still waits on past the time that
   *  doesn't count. */
  const seenOf = (w: Watched, now: number): Seen => ({
    steps: w.steps ?? 0,
    commandMs: w.command && now - w.command.seenAt <= PROGRESS_SIGNAL_MS ? now - w.command.since : null,
  });

  async function stalled(w: Watched, quiet: number) {
    try {
      await ctx.agents.notice(w.runId, w.agentId, { kind: "stalled", detail: stalledDetail(quiet, cfg, seenOf(w, Date.now())) });
      w.stalledAt = Date.now();
      save(w);
      ctx.log.info("an agent looks stalled", { runId: w.runId, agentId: w.agentId, quietMs: quiet });
    } catch (e) { ctx.log.warn("raising a stalled notice failed", { agentId: w.agentId, error: String((e as Error)?.message ?? e) }); }
  }

  async function stop(w: Watched, quiet: number) {
    w.stopping = true;
    save(w);
    try {
      await ctx.agents.cancel(w.runId, w.agentId, stalledWhy(quiet, seenOf(w, Date.now())));
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
          const waits = Array.isArray(w.waits) ? w.waits : [];
          watched.set(keyOf(w.runId, w.agentId), {
            ...w, since: w.since + down, waits, stalledAt: w.stalledAt ?? null, stopping: false,
            // (Kept by an earlier version, without when its waits began: from its last progress, as their end was then.)
            heldAt: waits.length ? (typeof w.heldAt === "number" ? w.heldAt : w.since) + down : null,
            command: w.command ? { ...w.command, seenAt: w.command.seenAt + down } : null,
            ...(typeof w.creditedTo === "number" ? { creditedTo: w.creditedTo + down } : {}),
          });
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

/** The plugin, with what it asks the kernel (tests pass their own). */
export const watchdogPlugin = (o: WatchdogOptions = {}) => definePlugin<WatchdogConfig>({
  async activate(ctx) {
    const w = watchdog(ctx, o);
    await w.start();
    ctx.onDispose(() => w.flushed());
  },
});

export const plugin = watchdogPlugin({ showsWork: async (runId, agentId) => (await import("./services")).showsFileChanges(runId, agentId) });
