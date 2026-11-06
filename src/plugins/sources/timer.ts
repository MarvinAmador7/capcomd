// A trigger source's timer (§16.2, §16.3.1), started by a key made of its settings, so a daemon restart finds the same
// timer again (a missed fire fired once) and changed settings make a new one. A key names one job for good: a timer the
// source cancelled when its settings changed (or went) stays `killed` under it, and starting it by the same key again
// would hand that back. Settings changed back to earlier ones (or a source turned off and on) would never fire. So a
// timer found killed under its key is started again under the key's next generation, which the plugin keeps in
// `ctx.storage`. A timer that ran out (`done`: a one-time `at` that fired, an `until` that passed) stays done.
import type { PluginContext } from "../../../packages/plugin/src/context";
import type { Job, JobSpec } from "../../../packages/plugin/src/shapes";

export async function startSourceTimer(ctx: PluginContext<unknown>, key: string, spec: JobSpec): Promise<Job> {
  const slot = `timers/${key}`;
  const gen = ((await ctx.storage.get("daemon", slot).catch(() => undefined)) as { gen?: number } | undefined)?.gen ?? 0;
  const job = await ctx.jobs.start(spec, { key: gen ? `${key}-${gen}` : key });
  if (job.state !== "killed") return job;
  await ctx.storage.put("daemon", slot, { gen: gen + 1 });
  return ctx.jobs.start(spec, { key: `${key}-${gen + 1}` });
}
