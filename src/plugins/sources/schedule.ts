// source-schedule (docs/spec/plugin-api.md §16.3.6, §17.2 step 10): the `schedule` trigger source. Each schedule the
// operator names in the plugin's config (`plugins.source-schedule.schedules` in ~/.capcomd/config.json) is one of the
// plugin's timers (§16.2: kept across daemon restarts by its key, a missed fire fired once), and each fire is a trigger
// whose text is the schedule's: the intake decides about it like any other (the operator allows the schedule's actor,
// `schedule:<name>`, or opens its threads, `schedule:*`, in `triggers.sources.schedule`), so a fire starts a run with
// that text as its goal. Each fire is its own thread (`schedule:<name>@<when>`): one night's run never gets the next
// night's fire as a message. A schedule that changes gets a new timer; the old one is cancelled. Daemon only: in any
// other process `ctx.jobs` is unsupported and nothing is scheduled.
import { createHash } from "node:crypto";
import { definePlugin, type PluginContext } from "../../../packages/plugin/src/context";
import { PluginError } from "../../../packages/plugin/src/errors";
import type { PluginManifest } from "../../../packages/plugin/src/manifest";
import { VERSION } from "../../utils/self";
import { startSourceTimer } from "./timer";

export interface Schedule {
  /** What a fire asks for: the started run's goal. */
  text: string;
  /** Fire every this many milliseconds (at least 1000), from `at` if set, until `until`. */
  everyMs?: number;
  /** The first (or only) fire, an ISO time. */
  at?: string;
  until?: string;
}
export interface ScheduleConfig { schedules: Record<string, Schedule> }

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LABEL = "schedule ";

export const manifest = {
  schema: "capcomd.plugin/v1",
  name: "source-schedule",
  version: VERSION,
  description: "Schedules as a trigger source: each fire of a schedule you set asks capcomd for a run with its text as the goal.",
  apiVersion: 1,
  engines: { capcomd: VERSION },
  entry: { runtime: "in-process", module: "./schedule.ts" },
  provides: ["source:schedule"],
  scopes: ["read", "steer"],
  contributes: {
    sources: [{ name: "schedule", summary: "A fire of a schedule set in the plugin's config (actor schedule:<name>, thread schedule:<name>@<when>)" }],
    hooks: { "job.changed": {} },
  },
  config: {
    type: "object",
    additionalProperties: false,
    properties: {
      schedules: {
        type: "object",
        default: {},
        description: "Schedules by name ([a-z0-9-]): {text, everyMs?, at?, until?}. Its fires are triggers from source schedule, actor schedule:<name>",
        additionalProperties: {
          type: "object", additionalProperties: false, required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, description: "What a fire asks for: the run's goal" },
            everyMs: { type: "integer", minimum: 1000, description: "Fire every this many milliseconds" },
            at: { type: "string", format: "date-time", description: "The first (or only) fire" },
            until: { type: "string", format: "date-time", description: "No fire after this" },
          },
        },
      },
    },
  },
} satisfies PluginManifest;

/** A schedule as the plugin uses it, or why it is left out. */
export function checkSchedule(name: string, s: unknown): { ok: true; schedule: Schedule } | { ok: false; why: string } {
  if (!NAME.test(name)) return { ok: false, why: "its name is lowercase letters, digits and -" };
  const x = s as Partial<Schedule> | null;
  if (!x || typeof x !== "object") return { ok: false, why: "it is an object {text, everyMs?, at?, until?}" };
  if (typeof x.text !== "string" || !x.text.trim()) return { ok: false, why: "it has no text (what a fire asks for)" };
  if (x.everyMs !== undefined && !(Number.isInteger(x.everyMs) && x.everyMs >= 1000)) return { ok: false, why: "everyMs is a whole number of milliseconds, at least 1000" };
  for (const k of ["at", "until"] as const) if (x[k] !== undefined && !(typeof x[k] === "string" && Number.isFinite(Date.parse(x[k]!)))) return { ok: false, why: `${k} is an ISO time` };
  if (x.everyMs === undefined && x.at === undefined) return { ok: false, why: "it needs at (once) or everyMs (on an interval)" };
  return { ok: true, schedule: { text: x.text, ...(x.everyMs !== undefined ? { everyMs: x.everyMs } : {}), ...(x.at ? { at: x.at } : {}), ...(x.until ? { until: x.until } : {}) } };
}

/** The timer's key: a changed schedule is a new timer. */
const keyOf = (name: string, s: Schedule) => `schedule-${name}-${createHash("sha256").update(JSON.stringify([s.text, s.everyMs ?? null, s.at ?? null, s.until ?? null])).digest("hex").slice(0, 12)}`;

/** One fire as a trigger. */
export function fireTrigger(name: string, s: Schedule, fire: { jobId: string; n: number; at: string }) {
  return {
    source: "schedule", id: `${name}/${fire.jobId}/${fire.n}`, thread: `schedule:${name}@${fire.at}`, at: fire.at,
    actor: { id: `schedule:${name}`, display: `the ${name} schedule`, bot: true }, addressed: "direct" as const,
    text: { text: s.text, untrusted: true as const, by: "operator" }, replyTo: null, data: { schedule: name, fire: fire.n },
  };
}

async function arm(ctx: PluginContext<ScheduleConfig>, schedules: Map<string, Schedule>): Promise<void> {
  const mine = new Set<string>();
  for (const [name, s] of schedules) {
    try {
      const job = await startSourceTimer(ctx, keyOf(name, s), { kind: "timer", runId: null, owner: { plugin: true }, label: `${LABEL}${name}`, ...(s.at ? { at: s.at } : {}), ...(s.everyMs ? { everyMs: s.everyMs } : {}), ...(s.until ? { until: s.until } : {}) });
      mine.add(job.jobId);
    } catch (e) {
      if (e instanceof PluginError && e.code === "unsupported") return; // not the daemon: nothing is scheduled here
      ctx.log.warn(`schedule ${name} did not start`, { error: String((e as Error)?.message ?? e) });
    }
  }
  // A schedule that changed or went: its old timer stops.
  for (const j of await ctx.jobs.list({ state: "running" }).catch(() => [])) {
    if (j.spec.kind === "timer" && j.spec.label.startsWith(LABEL) && !mine.has(j.jobId)) await ctx.jobs.cancel(j.jobId, "its schedule changed or was removed").catch(() => {});
  }
}

export const plugin = definePlugin<ScheduleConfig>({
  activate(ctx) {
    const schedules = new Map<string, Schedule>();
    for (const [name, s] of Object.entries(ctx.config.get().schedules ?? {})) {
      const c = checkSchedule(name, s);
      if (c.ok) schedules.set(name, c.schedule);
      else ctx.log.warn(`schedule ${name} is left out: ${c.why}`);
    }
    // Listening with no schedules too, as the manifest declares it (a declaration the code never registers is a warning
    // at every start, §4.7): it returns at once for any job that isn't one of its schedules' timers. The built-in
    // sandboxes listen to job.changed already, so the daemon reads background jobs' output either way (§6.6.19).
    ctx.hooks.on("job.changed", (call) => {
      const { job, change } = call.payload;
      if (job.plugin !== ctx.plugin.name || change.kind !== "fired" || !job.spec.label.startsWith(LABEL)) return;
      const name = job.spec.label.slice(LABEL.length), s = schedules.get(name);
      if (!s) return;
      // A start takes longer than an observe call's 5 s: it goes on by itself.
      void ctx.triggers.emit(fireTrigger(name, s, { jobId: job.jobId, n: change.n, at: call.at }))
        .catch((e) => ctx.log.warn(`schedule ${name}: its fire was not taken`, { error: String((e as Error)?.message ?? e) }));
    });
    void arm(ctx, schedules).catch(() => {});
  },
});
