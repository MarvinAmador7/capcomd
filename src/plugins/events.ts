// `ctx.events.subscribe` and `ctx.events.replay` in the daemon (docs/spec/plugin-api.md §8.4): a stream's durable events
// as GET /v1/events serves them, the same envelopes with the same seq and entitySeq. The `daemon` stream is the daemon's
// own events (`harnessState().daemonEvents`, not the run.created frames the SSE stream makes from the run list); a run's
// is its scope's event log, read through the engine. A subscription polls its stream, one read at a time, and hands each
// event to its handler in seq order, awaiting it before the next: never two at once. The context
// (packages/plugin/src/host/context.ts) checks the scope, logs and skips a handler that throws, and stops delivery on
// dispose. A process that isn't the daemon has no stream to read: its host refuses both, `unsupported`.
import { PluginError } from "../../packages/plugin/src/errors";
import type { Disposable, HarnessEventEnvelope } from "../../packages/plugin/src/context";
import { envelopes, toEnvelope, entityOf, type RawEvent } from "../api/source";
import { daemonEnvelope, type DaemonEvent } from "../api/state";

/** Where a stream's events are read from. */
export type EventReads = {
  /** The daemon's own durable events after `after` (seq), oldest first. */
  daemon(after: number): DaemonEvent[];
  /** A run's scope events after `after` (seq), oldest first; null when there is no such run. */
  run(runId: string, after: number): Promise<RawEvent[] | null>;
};

/** A run's events through the engine: the run's scope actor, when the run exists (reading never creates one). */
export const scopeEvents: EventReads["run"] = async (runId, after) => {
  const { existingActor } = await import("../core/relay");
  const scope = await existingActor("scope", [runId]);
  return scope ? ((await scope.getEvents({ since: after })) as RawEvent[]) : null;
};

const RUN = /^run-[A-Za-z0-9_-]+$/;
export const POLL_MS = 500;

function streamOf(stream: unknown): "daemon" | string {
  if (stream === "daemon" || (typeof stream === "string" && RUN.test(stream))) return stream;
  throw new PluginError("invalid", `a stream is daemon or a run id (run-…), not ${JSON.stringify(stream)}`);
}

type Handler = (e: HarnessEventEnvelope) => void | Promise<void>;
type Log = (level: "warn" | "error", message: string, fields: Record<string, unknown>) => void;

/**
 * The host's `subscribe` and `replay` sinks over `reads`. Without `filter.after` a subscription starts at the stream's
 * head: the daemon's at once, a run's when it first reads it. A read that fails is tried again at the next poll from the
 * same cursor (logged once per streak); a run that doesn't exist delivers nothing and stops polling.
 */
export function eventSinks(reads: EventReads, o: { pollMs?: number; log?: Log } = {}) {
  const pollMs = o.pollMs ?? POLL_MS;
  const log: Log = o.log ?? ((_level, message, fields) => console.error(`[plugins] ${message}${fields.error ? `: ${String(fields.error)}` : ""}`));

  async function replay(stream: string, after: number): Promise<HarnessEventEnvelope[]> {
    const s = streamOf(stream);
    if (s === "daemon") return reads.daemon(after).map(daemonEnvelope);
    const evs = await reads.run(s, 0);
    if (!evs) throw new PluginError("not_found", `no run ${s}`);
    return envelopes(s, evs).filter((e) => e.seq > after);
  }

  function subscribe(stream: string, filter: { types?: string[]; after?: number }, handler: Handler): Disposable {
    const s = streamOf(stream);
    const types = filter.types?.length ? new Set(filter.types) : null;
    let cursor = filter.after ?? null;
    let stopped = false, failing = false, timer: ReturnType<typeof setTimeout> | undefined;
    // A run's entitySeq counts by entity from its first event, as GET /v1/events numbers them.
    const counts = new Map<string, number>();
    let counted = false;
    if (s === "daemon" && cursor === null) cursor = reads.daemon(0).at(-1)?.seq ?? 0;

    const read = async (): Promise<HarnessEventEnvelope[] | null> => {
      if (s === "daemon") return reads.daemon(cursor!).map(daemonEnvelope);
      const evs = await reads.run(s, counted ? cursor! : 0);
      if (!evs) return null;
      // The first read is the whole log: counted, and without `after` what is there now is history, not delivered.
      if (!counted) { counted = true; cursor ??= evs.at(-1)?.seq ?? 0; }
      return evs.map((e) => {
        const k = entityOf(s, e), n = (counts.get(k) ?? 0) + 1;
        counts.set(k, n);
        return toEnvelope(s, e, n);
      }).filter((e) => e.seq > cursor!);
    };

    const tick = async () => {
      if (stopped) return;
      let evs: HarnessEventEnvelope[] | null;
      try { evs = await read(); failing = false; } catch (e) {
        if (!failing) log("warn", `reading the ${s} stream for a subscription failed; trying again`, { stream: s, error: (e as Error)?.message ?? String(e) });
        failing = true;
        return schedule();
      }
      if (evs === null) { log("warn", `no run ${s}: the subscription delivers nothing`, { stream: s }); return; }
      for (const e of evs) {
        if (stopped) return;
        cursor = e.seq;
        if (types && !types.has(e.type)) continue;
        try { await handler(e); } catch { /* the context logs a handler that throws and skips the event (§8.4) */ }
      }
      schedule();
    };
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => { void tick(); }, pollMs);
      (timer as { unref?: () => void }).unref?.();
    };
    void tick();
    return { dispose() { stopped = true; clearTimeout(timer); } };
  }

  return { subscribe, replay };
}

/** A host with no stream to read (a process that isn't the daemon): both refuse, `unsupported` (§8.4). */
export const noEventSinks = {
  subscribe(): Disposable { throw new PluginError("unsupported", "events.subscribe needs the daemon (capcomd serve): this process has no event stream"); },
  async replay(): Promise<HarnessEventEnvelope[]> { throw new PluginError("unsupported", "events.replay needs the daemon (capcomd serve): this process has no event stream"); },
};
