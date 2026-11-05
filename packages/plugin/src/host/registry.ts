// The hook registry (spec §6): listeners by hook, in the §6.3 order, dispatched by mode with deadlines (§6.4), the
// failure policy and the per-plugin circuit breaker (§6.5). The kernel fires hooks only through `fire`, with the mode
// spelled at the call site so `scripts/check-hook-modes.ts` can check it against HOOKS (§14.4).
import { createHash, randomBytes } from "node:crypto";
import { PluginError, type HookFailureKind } from "../errors";
import { HOOKS, PATCH_KEYS, type HookCall, type HookListener, type HookName, type HookPatch, type HookPayload, type ModifyHook, type ObserveHook, type ReviewReport, type VetoHook } from "../hooks";
import type { PluginEventData, PluginEventType } from "../events";
import type { Disposable } from "../context";
import type { Principal } from "../shapes";

/** An event the host writes (§13.1): on the `daemon` stream, or a run's for the gate events. */
export type HostEvent = { [T in PluginEventType]: { type: T; stream: "daemon" | string; entity: string; text: string; data: PluginEventData[T] } }[PluginEventType];

/** Where a fire happens and who caused it (§6.1). `entity` names what the decision is about (a run, agent, verification
 *  or merge id) and with `attempt` makes the idempotency key `<hook>:<entity>:<attempt>` (§6.7). */
export interface FireOptions {
  principal: Principal;
  entity: string;
  attempt?: number;
  runId?: string | null;
  agentId?: string | null;
  trace?: { traceId: string; spanId: string };
  /** Veto hooks: ask every listener even after a deny or a hold (`merge --operator` records and bypasses them, §6.5).
   *  The outcome is still the first refusal or hold; `vetoes` lists every one, in order. */
  askAll?: boolean;
}
export interface ModifyOptions<N extends ModifyHook> extends FireOptions {
  /** The kernel's patch rule for this hook (§6.6): the payload with `patch` applied, or a `PluginError("widening")`
   *  (or `invalid`) when the patch widens what the kernel only narrows. Called once per listener, in order. */
  apply(payload: HookPayload<N>, patch: HookPatch<N>, plugin: string): HookPayload<N>;
}

/** A refused operation. `plugin` is who refused it (null: the daemon is stopping); the kernel reports
 *  `reason: "plugin:<name>"` with `text` as the hint (§6.2). `failure` is set when the listener failed closed (§6.5). */
export type Refusal = { decision: "deny"; plugin: string | null; text: string; reasons: string[]; failure: HookFailureKind | null } & VetoExtras;
export type Hold = { decision: "hold"; plugin: string; text: string } & VetoExtras;
/** What a veto fire collected on the way: the judges' review reports (`verify.judging`, in order) and, with `askAll`,
 *  every deny and hold. */
export type VetoExtras = { reviews?: Array<{ plugin: string; review: ReviewReport }>; vetoes?: Array<{ plugin: string; decision: "deny" | "hold"; text: string }> };
export type VetoOutcome<N extends VetoHook> = ({ decision: "allow" } & VetoExtras) | Refusal | (N extends "merge.landing" ? Hold : never);
export type ModifyOutcome<N extends ModifyHook> = { decision: "allow"; payload: HookPayload<N>; patches: Array<{ plugin: string; patch: HookPatch<N> }> } | Refusal;

/** Per-plugin hook statistics (§13.2, §13.5). */
export interface HookStats { calls: number; failures: number; dropped: number; p50Ms: number | null; p95Ms: number | null; lastFailureAt: string | null }

export interface RegistryOptions {
  emit(e: HostEvent): void;
  /** A plugin's place in the load order (§6.3); listeners run by it, then by plugin name. */
  rank(plugin: string): number;
  now?: () => number;
  /** Consecutive failed calls that suspend a plugin's listeners (§6.5). */
  breakerAt?: number;
  /** Pending observe calls per plugin before the oldest are dropped (§6.2). */
  observeQueue?: number;
}

type Listener = { plugin: string; hook: HookName; fn: HookListener<HookName>; timeoutMs: number; failure: "closed" | "open"; live: boolean };
type PluginHooks = {
  signal: AbortSignal;
  consecutive: number;
  suspended: boolean;
  calls: number;
  failures: number;
  dropped: number;
  ms: number[];
  lastFailureAt: number | null;
  queue: Array<() => Promise<void>>;
  pump: Promise<void> | null;
};

const DURATIONS = 256;
const TIMEOUT = Symbol("timeout");
const hex = (n: number) => randomBytes(n).toString("hex");
const iso = (ms: number) => new Date(ms).toISOString();
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const pct = (xs: number[], p: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : null;

/** The failure policy a listener runs under (§6.5): gates always closed, observe always open, others as declared. */
export function failurePolicy(hook: HookName, declared: "closed" | "open" | undefined): "closed" | "open" {
  const meta = HOOKS[hook];
  return meta.gate ? "closed" : meta.mode === "observe" ? "open" : declared ?? "open";
}

export class HookRegistry {
  private readonly listeners = new Map<HookName, Listener[]>();
  private readonly plugins = new Map<string, PluginHooks>();
  private readonly now: () => number;
  private readonly breakerAt: number;
  private readonly observeQueue: number;
  private stopping = false;

  constructor(private readonly o: RegistryOptions) {
    this.now = o.now ?? Date.now;
    this.breakerAt = o.breakerAt ?? 3;
    this.observeQueue = o.observeQueue ?? 1000;
  }

  /** Start tracking a plugin; `signal` is its `ctx.signal`, composed into every call's signal (§5.3). Resets the breaker. */
  attach(plugin: string, signal: AbortSignal): void {
    const prev = this.plugins.get(plugin);
    this.plugins.set(plugin, { signal, consecutive: 0, suspended: false, calls: prev?.calls ?? 0, failures: prev?.failures ?? 0, dropped: prev?.dropped ?? 0, ms: prev?.ms ?? [], lastFailureAt: prev?.lastFailureAt ?? null, queue: [], pump: null });
  }

  /** Stop delivering to a plugin (§5.3 step 2): queued observe calls are dropped; calls in flight run to their deadline. */
  detach(plugin: string): void {
    const p = this.plugins.get(plugin);
    if (p) p.queue.length = 0;
    for (const ls of this.listeners.values()) for (const l of ls) if (l.plugin === plugin) l.live = false;
  }

  /** Register `fn` for `hook`. The context checks the manifest (§4.7); this is the registry's half. */
  on<N extends HookName>(plugin: string, hook: N, fn: HookListener<N>, decl: { timeoutMs?: number; failure?: "closed" | "open" } = {}): Disposable {
    const meta = HOOKS[hook];
    const l: Listener = { plugin, hook, fn: fn as unknown as HookListener<HookName>, timeoutMs: Math.min(decl.timeoutMs ?? meta.timeoutMs.default, meta.timeoutMs.max), failure: failurePolicy(hook, decl.failure), live: true };
    const ls = this.listeners.get(hook) ?? [];
    ls.push(l);
    this.listeners.set(hook, ls);
    return { dispose: () => {
      l.live = false;
      const cur = this.listeners.get(hook) ?? [];
      const i = cur.indexOf(l);
      if (i >= 0) cur.splice(i, 1);
    } };
  }

  /** Whether any listener would be called for `hook` (a suspended plugin's gate listener counts: it denies). Synchronous,
   *  so a kernel site that nothing listens to builds no payload and awaits nothing (§17.2 step 2). */
  listening(hook: HookName): boolean {
    return (this.listeners.get(hook) ?? []).some((l) => l.live);
  }

  /** Listening plugins for `hook`, in the order their listeners run (§6.3). */
  order(hook: HookName): string[] {
    return this.ordered(hook).map((l) => l.plugin);
  }

  private ordered(hook: HookName): Listener[] {
    return (this.listeners.get(hook) ?? []).filter((l) => l.live)
      .sort((a, b) => this.o.rank(a.plugin) - this.o.rank(b.plugin) || (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
  }

  /** The daemon is stopping (§5.5 stop step 2): from now on a gate that fires is denied, other hooks do nothing. */
  stop(): void { this.stopping = true; }
  /** Undo `stop` (a host that starts again: tests). */
  restart(): void { this.stopping = false; }

  suspended(plugin: string): boolean { return this.plugins.get(plugin)?.suspended ?? false; }

  /** Reset the breaker (§6.5: `capcomd plugins enable` on an active plugin). False when it wasn't suspended. */
  resume(plugin: string, by: string): boolean {
    const p = this.plugins.get(plugin);
    if (!p?.suspended) return false;
    p.suspended = false;
    p.consecutive = 0;
    this.o.emit({ type: "plugin.resumed", stream: "daemon", entity: `plugin:${plugin}`, text: `The ${plugin} plugin's hooks were resumed.`, data: { plugin, by } });
    return true;
  }

  stats(plugin: string): HookStats {
    const p = this.plugins.get(plugin);
    if (!p) return { calls: 0, failures: 0, dropped: 0, p50Ms: null, p95Ms: null, lastFailureAt: null };
    return { calls: p.calls, failures: p.failures, dropped: p.dropped, p50Ms: pct(p.ms, 0.5), p95Ms: pct(p.ms, 0.95), lastFailureAt: p.lastFailureAt === null ? null : iso(p.lastFailureAt) };
  }

  /** Resolves once every queued observe call has run (tests, and the host before it disposes). */
  async idle(): Promise<void> {
    for (;;) {
      const pumps = [...this.plugins.values()].map((p) => p.pump).filter((x): x is Promise<void> => !!x);
      if (!pumps.length) return;
      await Promise.all(pumps);
    }
  }

  /** Fire a hook (§6.2). `mode` must be the hook's (the type says so, and the mode-consistency script checks it). */
  fire<N extends ObserveHook>(hook: N, mode: "observe", payload: HookPayload<N>, o: FireOptions): void;
  fire<N extends VetoHook>(hook: N, mode: "veto", payload: HookPayload<N>, o: FireOptions): Promise<VetoOutcome<N>>;
  fire<N extends ModifyHook>(hook: N, mode: "modify", payload: HookPayload<N>, o: ModifyOptions<N>): Promise<ModifyOutcome<N>>;
  fire(hook: HookName, mode: "observe" | "veto" | "modify", payload: unknown, o: FireOptions): void | Promise<unknown> {
    if (HOOKS[hook].mode !== mode) throw new PluginError("invalid", `${hook} is ${HOOKS[hook].mode === "observe" ? "an" : "a"} ${HOOKS[hook].mode} hook, fired as ${mode}`);
    if (mode === "observe") return this.observe(hook, payload, o);
    if (mode === "veto") return this.veto(hook as VetoHook, payload, o);
    return this.modify(hook as ModifyHook, payload, o as ModifyOptions<ModifyHook>);
  }

  /** One plugin's listener called as the host would (deadline, result check, failure accounting), returning its raw
   *  answer: the test kit's `fire` (§14.5). `timeoutMs` replaces the listener's deadline. */
  async callOne(plugin: string, hook: HookName, payload: unknown, o: FireOptions & { timeoutMs?: number }): Promise<{ result: unknown; failure: { kind: HookFailureKind; message: string } | null; ms: number }> {
    const found = this.ordered(hook).find((x) => x.plugin === plugin);
    const p = this.plugins.get(plugin);
    if (!found || !p) throw new PluginError("not_found", `${plugin} does not listen to ${hook}`);
    const l = o.timeoutMs === undefined ? found : { ...found, timeoutMs: o.timeoutMs };
    const started = this.now();
    if (p.suspended) {
      if (l.failure === "closed") { p.calls++; this.failed(l, p, `call_${hex(8)}`, "suspended", "the plugin's hooks are suspended"); }
      return { result: undefined, failure: { kind: "suspended", message: "the plugin's hooks are suspended" }, ms: 0 };
    }
    const r = await this.invoke(l, p, structuredClone(payload), o, started);
    const mode = HOOKS[hook].mode;
    const v = !r.ok ? r : mode === "veto" ? checkVeto(hook as VetoHook, r.value) : mode === "modify" ? checkModify(hook as ModifyHook, r.value) : { ok: true as const, result: undefined };
    const ms = this.now() - started;
    if (!v.ok) { this.failed(l, p, r.callId, v.kind, v.message); return { result: undefined, failure: { kind: v.kind, message: v.message }, ms }; }
    this.succeeded(p);
    return { result: v.result, failure: null, ms };
  }

  // ---- dispatch ---------------------------------------------------------------------------------------------------

  private observe(hook: HookName, payload: unknown, o: FireOptions): void {
    if (this.stopping) return;
    const at = this.now();
    for (const l of this.ordered(hook)) {
      const p = this.plugins.get(l.plugin);
      if (!p || p.suspended) continue;
      const value = structuredClone(payload);
      if (p.queue.length >= this.observeQueue) { p.queue.shift(); p.dropped++; }
      p.queue.push(async () => {
        // Disposed, or suspended since it was queued (§6.5: an open listener of a suspended plugin is skipped).
        if (!l.live || p.suspended) return;
        const r = await this.invoke(l, p, value, o, at);
        if (r.ok) this.succeeded(p); else this.failed(l, p, r.callId, r.kind, r.message);
      });
      if (!p.pump) p.pump = this.drain(p);
    }
  }

  /** One plugin's observe calls, one at a time and in order. */
  private async drain(p: PluginHooks): Promise<void> {
    await Promise.resolve();
    try {
      for (let next = p.queue.shift(); next; next = p.queue.shift()) await next();
    } finally { p.pump = null; }
  }

  private async veto(hook: VetoHook, payload: unknown, o: FireOptions): Promise<VetoOutcome<VetoHook> | Hold> {
    const meta = HOOKS[hook];
    if (this.stopping) return meta.gate ? { decision: "deny", plugin: null, text: "daemon stopping", reasons: [], failure: null } : { decision: "allow" };
    const at = this.now();
    const reviews: NonNullable<VetoExtras["reviews"]> = [];
    const refused: Array<Refusal | Hold> = [];
    // A deny or hold is the answer, unless every listener is to be asked (askAll): then the chain goes on.
    const stop = (r: Refusal | Hold): boolean => { refused.push(r); return !o.askAll; };
    for (const l of this.ordered(hook)) {
      const p = this.plugins.get(l.plugin);
      if (!p) continue;
      const pre = this.preflight(l, p);
      if (pre === "skip") continue;
      if (pre) { if (stop(this.refuse(l, o, pre))) break; continue; }
      const r = await this.invoke(l, p, structuredClone(payload), o, at);
      const v = r.ok ? checkVeto(hook, r.value) : r;
      if (!v.ok) {
        const effect = this.failed(l, p, r.callId, v.kind, v.message);
        if (effect === "denied" && stop(this.refuse(l, o, { kind: v.kind, message: v.message }))) break;
        continue;
      }
      this.succeeded(p);
      if (v.result.review) reviews.push({ plugin: l.plugin, review: v.result.review });
      if (v.result.decision === "deny") { if (stop(this.refuse(l, o, null, v.result.reason, v.result.reasons ?? []))) break; continue; }
      if (v.result.decision === "hold") {
        this.gateEvent(l, o, "hold", v.result.reason);
        if (stop({ decision: "hold", plugin: l.plugin, text: v.result.reason })) break;
      }
    }
    const extras: VetoExtras = { ...(reviews.length ? { reviews } : {}), ...(o.askAll ? { vetoes: refused.map((x) => ({ plugin: x.plugin ?? "", decision: x.decision, text: x.text })) } : {}) };
    return refused[0] ? { ...refused[0], ...extras } : { decision: "allow", ...extras };
  }

  private async modify(hook: ModifyHook, payload: unknown, o: ModifyOptions<ModifyHook>): Promise<ModifyOutcome<ModifyHook>> {
    const meta = HOOKS[hook];
    let current = structuredClone(payload) as HookPayload<ModifyHook>;
    if (this.stopping) return meta.gate ? { decision: "deny", plugin: null, text: "daemon stopping", reasons: [], failure: null } : { decision: "allow", payload: current, patches: [] };
    const at = this.now();
    const patches: Array<{ plugin: string; patch: HookPatch<ModifyHook> }> = [];
    for (const l of this.ordered(hook)) {
      const p = this.plugins.get(l.plugin);
      if (!p) continue;
      const pre = this.preflight(l, p);
      if (pre === "skip") continue;
      if (pre) return this.refuse(l, o, pre);
      const r = await this.invoke(l, p, structuredClone(current), o, at);
      let v = r.ok ? checkModify(hook, r.value) : r;
      let next = current;
      if (v.ok && v.result.decision === "allow" && v.result.patch !== undefined) {
        try { next = o.apply(structuredClone(current), v.result.patch as HookPatch<ModifyHook>, l.plugin); } catch (e) {
          const code = e instanceof PluginError ? e.code : "invalid";
          v = { ok: false, kind: "invalid_result", message: `${code === "widening" ? "widening" : "invalid patch"}: ${(e as Error).message}` };
        }
      }
      if (!v.ok) {
        const effect = this.failed(l, p, r.callId, v.kind, v.message);
        if (effect === "denied") return this.refuse(l, o, { kind: v.kind, message: v.message });
        continue;
      }
      this.succeeded(p);
      if (v.result.decision === "deny") return this.refuse(l, o, null, v.result.reason, v.result.reasons ?? []);
      if (v.result.patch !== undefined) { patches.push({ plugin: l.plugin, patch: v.result.patch as HookPatch<ModifyHook> }); current = next; }
    }
    return { decision: "allow", payload: current, patches };
  }

  /** A suspended plugin's listener (§6.5): a closed one is a failed call that denies, an open one is skipped. */
  private preflight(l: Listener, p: PluginHooks): { kind: HookFailureKind; message: string } | "skip" | null {
    if (!p.suspended) return null;
    if (l.failure === "open") return "skip";
    p.calls++;
    this.failed(l, p, `call_${hex(8)}`, "suspended", "the plugin's hooks are suspended (three failed calls in a row)");
    return { kind: "suspended", message: "the plugin's hooks are suspended" };
  }

  private refuse(l: Listener, o: FireOptions, failure: { kind: HookFailureKind; message: string } | null, text?: string, reasons: string[] = []): Refusal {
    const t = failure ? `the ${l.plugin} plugin's ${l.hook} listener failed (${failure.kind}): ${failure.message}` : text!;
    if (HOOKS[l.hook].gate) this.gateEvent(l, o, "deny", t);
    return { decision: "deny", plugin: l.plugin, text: t, reasons, failure: failure?.kind ?? null };
  }

  private gateEvent(l: Listener, o: FireOptions, decision: "deny" | "hold", reason: string) {
    this.o.emit({ type: "plugin.gate_denied", stream: o.runId ?? "daemon", entity: o.entity, text: `The ${l.plugin} plugin ${decision === "hold" ? "held" : "denied"} ${l.hook}.`, data: { plugin: l.plugin, hook: l.hook, entity: o.entity, decision, reason } });
  }

  // ---- one call -----------------------------------------------------------------------------------------------------

  private async invoke(l: Listener, p: PluginHooks, payload: unknown, o: FireOptions, at: number): Promise<{ ok: true; value: unknown; callId: string } | { ok: false; kind: HookFailureKind; message: string; callId: string }> {
    const callId = `call_${hex(8)}`;
    const deadline = new AbortController();
    const started = this.now();
    const call: HookCall = {
      callId, hook: l.hook, mode: HOOKS[l.hook].mode, payloadVersion: 1,
      idempotencyKey: `${l.hook}:${o.entity}:${o.attempt ?? 1}`,
      deadline: iso(started + l.timeoutMs),
      signal: AbortSignal.any([deadline.signal, p.signal]),
      trace: o.trace ?? { traceId: o.runId ? createHash("sha256").update(`trace:${o.runId}`).digest("hex").slice(0, 32) : hex(16), spanId: hex(8) },
      principal: o.principal, runId: o.runId ?? null, agentId: o.agentId ?? null, at: iso(at),
      payload: payload as never,
    };
    p.calls++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const run = Promise.resolve().then(() => l.fn(call));
      run.catch(() => {});   // a listener that rejects after its deadline must not become an unhandled rejection
      const v = await Promise.race([run, new Promise<typeof TIMEOUT>((r) => { timer = setTimeout(() => r(TIMEOUT), l.timeoutMs); })]);
      if (v === TIMEOUT) {
        deadline.abort(new PluginError("timeout", `${l.hook} deadline (${l.timeoutMs} ms) passed`));
        return { ok: false, kind: "timeout", message: `no answer within ${l.timeoutMs} ms`, callId };
      }
      return { ok: true, value: v, callId };
    } catch (e) {
      return { ok: false, kind: "threw", message: e instanceof Error ? e.message : String(e), callId };
    } finally {
      clearTimeout(timer);
      p.ms.push(this.now() - started);
      if (p.ms.length > DURATIONS) p.ms.shift();
    }
  }

  private succeeded(p: PluginHooks) { p.consecutive = 0; }

  /** Record a failed call (§6.5) and trip the breaker on the third in a row. Returns what the host did about it. */
  private failed(l: Listener, p: PluginHooks, callId: string, kind: HookFailureKind, message: string): "denied" | "skipped" {
    const effect = l.failure === "closed" ? "denied" : "skipped";
    p.failures++;
    p.consecutive++;
    p.lastFailureAt = this.now();
    this.o.emit({ type: "plugin.hook_failed", stream: "daemon", entity: `plugin:${l.plugin}`, text: `The ${l.plugin} plugin's ${l.hook} listener failed (${kind}); the call was ${effect}.`, data: { plugin: l.plugin, hook: l.hook, callId, kind, message, effect } });
    if (!p.suspended && p.consecutive >= this.breakerAt) {
      p.suspended = true;
      this.o.emit({ type: "plugin.suspended", stream: "daemon", entity: `plugin:${l.plugin}`, text: `The ${l.plugin} plugin's hooks were suspended after ${p.consecutive} failed calls in a row.`, data: { plugin: l.plugin, failures: p.consecutive, lastHook: l.hook } });
    }
    return effect;
  }
}

// ---- result shapes (§6.2) -------------------------------------------------------------------------------------------

type Checked<R> = { ok: true; result: R } | { ok: false; kind: "invalid_result"; message: string };
type Deny = { decision: "deny"; reason: string; reasons?: string[] };

function checkDeny(v: Record<string, unknown>): Checked<Deny> {
  if (typeof v.reason !== "string" || !v.reason.trim()) return { ok: false, kind: "invalid_result", message: "a deny carries a reason (a non-empty string)" };
  if (v.reasons !== undefined && !(Array.isArray(v.reasons) && v.reasons.every((r) => typeof r === "string"))) return { ok: false, kind: "invalid_result", message: "reasons is a list of strings" };
  return { ok: true, result: { decision: "deny", reason: v.reason, ...(v.reasons ? { reasons: v.reasons as string[] } : {}) } };
}

const isStr = (x: unknown): x is string => typeof x === "string";

/** A judge's `review` (§6.6.13): the reasons kept as the kernel keeps a reviewer's (at most 20 of 500 characters). */
function checkReview(v: unknown): ReviewReport | string {
  if (!isObject(v)) return "review is an object";
  if (!isStr(v.profile) || !v.profile) return "review.profile is the reviewer's profile name";
  if (v.agentId !== null && !isStr(v.agentId)) return "review.agentId is the reviewer's agent id, or null";
  if (typeof v.passed !== "boolean") return "review.passed is a boolean";
  if (!Array.isArray(v.reasons) || !v.reasons.every(isStr)) return "review.reasons is a list of strings";
  if (!isStr(v.sha) || !v.sha) return "review.sha is the commit the reviewer read";
  for (const k of ["error", "targetSha", "startedAt"] as const) if (v[k] !== undefined && !isStr(v[k])) return `review.${k} is a string`;
  return {
    profile: v.profile, agentId: v.agentId as string | null, passed: v.passed, reasons: (v.reasons as string[]).slice(0, 20).map((r) => r.slice(0, 500)), sha: v.sha,
    ...(isStr(v.error) ? { error: v.error.slice(0, 1000) } : {}), ...(isStr(v.targetSha) ? { targetSha: v.targetSha } : {}), ...(isStr(v.startedAt) ? { startedAt: v.startedAt } : {}),
  };
}

export function checkVeto(hook: VetoHook, v: unknown): Checked<({ decision: "allow" } | Deny | { decision: "hold"; reason: string }) & { review?: ReviewReport }> {
  if (!isObject(v)) return { ok: false, kind: "invalid_result", message: "a veto listener answers {decision: allow|deny}" };
  if ("patch" in v) return { ok: false, kind: "invalid_result", message: `${hook} is a veto hook: an answer carries no patch` };
  if (v.review !== undefined) {
    if (hook !== "verify.judging") return { ok: false, kind: "invalid_result", message: `only a verify.judging answer carries a review, not ${hook}'s` };
    const review = checkReview(v.review);
    if (isStr(review)) return { ok: false, kind: "invalid_result", message: review };
    const rest = checkVeto(hook, { ...v, review: undefined });
    return rest.ok ? { ok: true, result: { ...rest.result, review } } : rest;
  }
  if (v.decision === "allow") return { ok: true, result: { decision: "allow" } };
  if (v.decision === "deny") return checkDeny(v);
  if (v.decision === "hold" && hook === "merge.landing") {
    if (typeof v.reason !== "string" || !v.reason.trim()) return { ok: false, kind: "invalid_result", message: "a hold carries a reason (a non-empty string)" };
    return { ok: true, result: { decision: "hold", reason: v.reason } };
  }
  return { ok: false, kind: "invalid_result", message: `unknown decision ${JSON.stringify(v.decision)}` };
}

export function checkModify(hook: ModifyHook, v: unknown): Checked<{ decision: "allow"; patch?: Record<string, unknown> } | Deny> {
  if (!isObject(v)) return { ok: false, kind: "invalid_result", message: "a modify listener answers {decision: allow, patch?} or a deny" };
  if (v.decision === "deny") return checkDeny(v);
  if (v.decision !== "allow") return { ok: false, kind: "invalid_result", message: `unknown decision ${JSON.stringify(v.decision)}` };
  if (v.patch === undefined) return { ok: true, result: { decision: "allow" } };
  if (!isObject(v.patch)) return { ok: false, kind: "invalid_result", message: "a patch is an object" };
  const allowed: readonly string[] = PATCH_KEYS[hook];
  const extra = Object.keys(v.patch).filter((k) => !allowed.includes(k));
  if (extra.length) return { ok: false, kind: "invalid_result", message: `${hook} patches only ${allowed.join(", ")}; not ${extra.join(", ")}` };
  return { ok: true, result: { decision: "allow", patch: v.patch } };
}
