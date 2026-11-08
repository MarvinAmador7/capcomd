// The context a plugin's `activate` receives (spec §5.1, §8), built by the host and by the test kit alike. Every
// registration is checked against the manifest (§4.7), recorded in order and disposed in reverse (§5.3); every
// primitive is checked against the plugin principal's scopes (§11.1) before it reaches the kernel's implementation.
import { PluginError } from "../errors";
import { pluginEventType } from "../event-type";
import { HOOKS, type HookName } from "../hooks";
import type { PluginManifest, PluginScope } from "../manifest";
import type { Registration } from "../testkit";
import type { ApiRouteSpec, CliCommandSpec, Disposable, EmittedEvent, HarnessEventEnvelope, LogLevel, McpToolSpec, PluginContext, Span, UiDescriptor } from "../context";
import type { AgentProvider, Forge, SandboxProvider } from "../seams";
import type { ContextProvider } from "../context-layer";
import type { HookRegistry } from "./registry";

/** Named contributions every plugin shares one namespace of (§4.2): a second registration of a key is `conflict`. */
export type ContributionKind = "seam" | "context" | "cli" | "mcp" | "instructions" | "api" | "capability" | "ui";
export type Contribution =
  | { kind: "seam"; seam: "sandbox" | "agent" | "forge"; impl: SandboxProvider | AgentProvider | Forge }
  | { kind: "context"; kinds: readonly ("fact" | "memory")[]; impl: ContextProvider }
  | { kind: "cli"; spec: CliCommandSpec } | { kind: "mcp"; spec: McpToolSpec } | { kind: "instructions"; text: string }
  | { kind: "api"; spec: ApiRouteSpec } | { kind: "capability"; doc: string } | { kind: "ui"; descriptor: UiDescriptor };

export class ContributionStore {
  private readonly items = new Map<string, { kind: ContributionKind; key: string; plugin: string; value: Contribution }>();
  add(key: string, plugin: string, value: Contribution): () => void {
    const k = `${value.kind}:${key}`;
    const had = this.items.get(k);
    if (had) throw new PluginError("conflict", `${value.kind} ${key} is already registered by ${had.plugin}`);
    const entry = { kind: value.kind, key, plugin, value };
    this.items.set(k, entry);
    return () => { if (this.items.get(k) === entry) this.items.delete(k); };
  }
  get<K extends ContributionKind>(kind: K, key: string): { plugin: string; value: Extract<Contribution, { kind: K }> } | undefined {
    const e = this.items.get(`${kind}:${key}`);
    return e ? { plugin: e.plugin, value: e.value as Extract<Contribution, { kind: K }> } : undefined;
  }
  list<K extends ContributionKind>(kind: K): Array<{ key: string; plugin: string; value: Extract<Contribution, { kind: K }> }> {
    return [...this.items.values()].filter((e) => e.kind === kind).map((e) => ({ key: e.key, plugin: e.plugin, value: e.value as Extract<Contribution, { kind: K }> }));
  }
}

/** The scope each primitive needs (§11.1); `null`: none. The services the kernel implements, by name. */
export const PRIMITIVES = {
  runs: { new: "steer", get: "read", list: "read", end: "steer", pause: "steer", resume: "steer", title: "steer" },
  agents: { spawn: "steer", get: "read", tree: "read", await: "read", cancel: "steer", grant: "steer", title: "steer", notice: "steer" },
  messages: { send: "steer", inbox: "read" },
  gates: { verify: "steer", merge: "steer", pending: "read" },
  board: { add: "steer", claim: "steer", done: "steer", release: "steer", list: "read" },
  kv: { get: "read", put: "steer", cas: "steer", list: "read" },
  sandboxes: { provider: null, forRun: null, descriptors: null },
  profiles: { resolve: "read", list: "read" },
  auth: { credentialMode: "read", loginPresent: "read", redact: null },
  jobs: { start: "steer", get: "read", list: "read", cancel: "steer", wait: "read" },
  triggers: { emit: null, subscribe: "steer", unsubscribe: "steer", subscriptions: "read" },
  storage: { get: null, put: null, cas: null, delete: null, list: null },
} as const satisfies Record<string, Record<string, PluginScope | null>>;
export type ServiceName = keyof typeof PRIMITIVES;
/** Primitives that answer synchronously: refused with a throw, not a rejection. */
const SYNC = new Set(["sandboxes.provider", "sandboxes.descriptors", "auth.credentialMode", "auth.redact"]);

/** The kernel's implementations of the primitives (absent ones are `unsupported`), plus the sinks the context writes to. */
export interface ContextOptions<C> {
  manifest: PluginManifest;
  runtime: "in-process" | "process";
  root: string;
  dataDir: string;
  hooks: HookRegistry;
  store: ContributionStore;
  config: C;
  /** The kernel's own front door (a built-in the kernel names, §4.2): its MCP tools are `capcomd_<tool>`, the names
   *  capcomd's tools have always had, not `capcomd_<plugin>_<tool>`. */
  kernelSurface?: boolean;
  services?: { [S in ServiceName]?: Partial<PluginContext[S]> };
  secret?(key: string): Promise<string>;
  /** Writes a checked, redacted `plugin.<name>.<type>` event (§4.7.4). */
  emit?(e: EmittedEvent & { type: string }): Promise<{ seq: number }>;
  subscribe?(stream: string, filter: { types?: string[]; after?: number }, handler: (e: HarnessEventEnvelope) => void | Promise<void>): Disposable;
  replay?(stream: string, after: number): Promise<HarnessEventEnvelope[]>;
  log?(line: { plugin: string; level: LogLevel; message: string; fields: Record<string, unknown> }): void;
  span?(s: { name: string; attributes: Record<string, string | number | boolean>; events: string[]; ms: number; ok: boolean }): void;
  redact?(text: string): string;
}

/** A context and what the host needs to hold it to the manifest and take it apart again. */
export interface PluginRuntime<C> {
  ctx: PluginContext<C>;
  /** Registrations still outstanding, in registration order. */
  registrations(): Registration[];
  /** Registrations the manifest doesn't declare (each also threw `conflict` inside `activate`). */
  violations: string[];
  /** Declared contributions the code never registered (§4.7: a warning, an error in the conformance suite). */
  missing(): string[];
  /** §5.3: abort the signal, stop hook delivery, dispose every registration in reverse order within `budgetMs`. */
  dispose(budgetMs?: number): Promise<{ timedOut: boolean; remaining: Registration[] }>;
  readonly disposed: boolean;
}

const EVENT_DATA_MAX = 64 * 1024;
const EVENT_TEXT_MAX = 500;

export function createContext<C>(o: ContextOptions<C>): PluginRuntime<C> {
  const m = o.manifest, name = m.name, declared = m.contributes ?? {};
  const scopes = [...(m.scopes ?? [])];
  const abort = new AbortController();
  const redact = o.redact ?? ((t: string) => t);
  const deep = (v: unknown): unknown => typeof v === "string" ? redact(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
  type Entry = { reg: Registration; remove(): void; finish?: () => void | Promise<void>; live: boolean };
  const entries: Entry[] = [];
  const violations: string[] = [];
  let disposed = false;

  const live = () => { if (disposed || abort.signal.aborted) throw new PluginError("disposed", `${name} is disposing`); };
  const refuse = (what: string): never => {
    violations.push(what);
    throw new PluginError("conflict", `${what} is not declared in ${name}'s manifest (contributes, §4.7)`);
  };
  const register = (reg: Registration, remove: () => void, finish?: () => void | Promise<void>): Disposable => {
    const e: Entry = { reg, remove, ...(finish ? { finish } : {}), live: true };
    entries.push(e);
    return { dispose: () => {
      if (!e.live) return;
      e.live = false;
      entries.splice(entries.indexOf(e), 1);
      e.remove();
    } };
  };
  const contribute = (reg: Registration, key: string, value: Contribution) => register(reg, o.store.add(key, name, value));

  const hooksOn = (hook: HookName, fn: (call: never) => unknown): Disposable => {
    live();
    if (!(hook in HOOKS)) throw new PluginError("invalid", `unknown hook ${String(hook)}`);
    const decl = declared.hooks?.[hook];
    if (!decl) refuse(`hook ${hook}`);
    if (entries.some((e) => e.reg.kind === "hook" && e.reg.hook === hook)) throw new PluginError("conflict", `${name} already listens to ${hook} (one listener per hook, §2)`);
    return register({ kind: "hook", hook }, o.hooks.on(name, hook, fn as never, decl!).dispose);
  };
  const seam = (kind: "sandbox" | "agent" | "forge") => (impl: SandboxProvider | AgentProvider | Forge): Disposable => {
    live();
    const d = (declared.seams ?? []).find((s) => s.kind === kind);
    if (!d) refuse(`${kind} seam`);
    const named = (impl as { describe?: () => { name?: string } }).describe?.().name;
    if (named !== undefined && named !== d!.name) throw new PluginError("invalid", `the ${kind} seam describes itself as ${named}, declared as ${d!.name} (§7.1)`);
    return contribute({ kind: "seam", seam: kind, name: d!.name }, `${kind}/${d!.name}`, { kind: "seam", seam: kind, impl });
  };

  const guarded = <S extends ServiceName>(service: S): PluginContext[S] => {
    const impl = o.services?.[service] as Record<string, (...a: unknown[]) => unknown> | undefined;
    const out: Record<string, (...a: unknown[]) => unknown> = {};
    for (const [method, scope] of Object.entries(PRIMITIVES[service]) as Array<[string, PluginScope | null]>) {
      const sync = SYNC.has(`${service}.${method}`);
      out[method] = (...args: unknown[]) => {
        const go = () => {
          live();
          if (scope && !scopes.includes(scope)) throw new PluginError("forbidden", `${service}.${method} needs the ${scope} scope (${name} has ${scopes.join(", ") || "none"}; §11.1)`);
          if (service === "triggers" && method === "emit") {
            const source = (args[0] as { source?: unknown } | undefined)?.source;
            if (!(declared.sources ?? []).some((s) => s.name === source)) throw new PluginError("forbidden", `${name} does not contribute the source ${String(source)} (§16.3)`);
          }
          const f = impl?.[method];
          if (!f) throw new PluginError("unsupported", `${service}.${method} is not available to plugins yet`);
          return f.apply(impl, args);
        };
        if (sync) return go();
        try { return Promise.resolve(go()); } catch (e) { return Promise.reject(e); }
      };
    }
    return out as unknown as PluginContext[S];
  };
  const auth = guarded("auth");
  if (!o.services?.auth?.redact) (auth as { redact: (t: string) => string }).redact = (t: string) => { live(); return redact(t); };

  const log = (level: LogLevel, message: string, fields: Record<string, unknown> = {}) => {
    o.log?.({ plugin: name, level, message: redact(String(message)), fields: deep(fields) as Record<string, unknown> });
  };

  const ctx: PluginContext<C> = {
    plugin: { name, version: m.version, runtime: o.runtime, root: o.root, dataDir: o.dataDir, manifest: m },
    principal: { kind: "plugin", name, scopes },
    signal: abort.signal,
    config: {
      get: () => o.config,
      secret: (key) => o.secret ? o.secret(key) : Promise.reject(new PluginError("not_found", `no secret ${key}`)),
    },
    log: { log, debug: (msg, f) => log("debug", msg, f), info: (msg, f) => log("info", msg, f), warn: (msg, f) => log("warn", msg, f), error: (msg, f) => log("error", msg, f) },
    trace: {
      async span(op, fn) {
        const attributes: Record<string, string | number | boolean> = { plugin: name };
        const events: string[] = [];
        const started = Date.now();
        const span: Span = { setAttributes: (a) => Object.assign(attributes, a), event: (n) => { events.push(n); }, end: () => {} };
        let ok = false;
        try { const r = await fn(span); ok = true; return r; } finally { o.span?.({ name: `plugin.${name}.${op}`, attributes, events, ms: Date.now() - started, ok }); }
      },
    },
    hooks: { on: hooksOn as PluginContext["hooks"]["on"] },
    seams: { sandbox: seam("sandbox"), agent: seam("agent"), forge: seam("forge") },
    context: {
      register(impl) {
        live();
        const named = impl?.describe?.().name;
        const d = (declared.context ?? []).find((c) => c.name === named);
        if (!d) refuse(`context provider ${String(named)}`);
        if (["resolve", "index", "search", "get", "propose", "available", "classifyError"].some((k) => typeof (impl as unknown as Record<string, unknown>)[k] !== "function"))
          throw new PluginError("invalid", `context provider ${d!.name}: describe, available, classifyError, resolve, index, search, get and propose are functions (ADR-025 §3.2)`);
        return contribute({ kind: "context", name: d!.name }, d!.name, { kind: "context", kinds: d!.kinds, impl });
      },
    },
    cli: {
      command(spec) {
        live();
        if (!(declared.cli ?? []).some((c) => c.name === spec.name)) refuse(`CLI command ${spec.name}`);
        if (typeof spec.run !== "function" || !Array.isArray(spec.usage)) throw new PluginError("invalid", `CLI command ${spec.name}: run is a function and usage a list of lines`);
        return contribute({ kind: "cli", name: spec.name }, spec.name, { kind: "cli", spec });
      },
    },
    mcp: {
      tool(spec) {
        live();
        if (!(declared.mcp ?? []).some((t) => t.name === spec.name)) refuse(`MCP tool ${spec.name}`);
        const schema = spec.inputSchema as { type?: unknown } | null;
        if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.type !== "object") throw new PluginError("invalid", `MCP tool ${spec.name}: inputSchema is a JSON Schema of an object (type: "object", §4.7.2)`);
        if (typeof spec.run !== "function") throw new PluginError("invalid", `MCP tool ${spec.name} has no run function`);
        const full = o.kernelSurface ? `capcomd_${spec.name}` : `capcomd_${name.replace(/-/g, "_")}_${spec.name}`;
        return contribute({ kind: "mcp", name: full }, full, { kind: "mcp", spec });
      },
      instructions(text) {
        live();
        return contribute({ kind: "instructions" }, name, { kind: "instructions", text: String(text) });
      },
    },
    api: {
      route(spec) {
        live();
        if (!(declared.api ?? []).some((r) => r.method === spec.method && r.path === spec.path && r.scope === spec.scope)) refuse(`API route ${spec.method} ${spec.path}`);
        const path = `/v1/x/${name}${spec.path}`;
        return contribute({ kind: "api", method: spec.method, path }, `${spec.method} ${path}`, { kind: "api", spec });
      },
      capability(flag, doc) {
        live();
        const full = `x.${name}.${flag}`;
        return contribute({ kind: "capability", name: full }, full, { kind: "capability", doc: String(doc) });
      },
    },
    ui: {
      descriptor(d) {
        live();
        if (!(declared.ui ?? []).some((u) => u.id === d.id && (u.kind === d.kind || (u.kind === "settings" && d.kind === "info") || (u.kind === "info" && d.kind === "settings")))) refuse(`UI ${d.kind} ${d.id}`);
        return contribute({ kind: "ui", id: d.id }, `${name}/${d.id}`, { kind: "ui", descriptor: d });
      },
    },
    events: {
      async emit(e) {
        live();
        if (!scopes.includes("steer")) throw new PluginError("forbidden", `events.emit needs the steer scope (§11.1)`);
        if (!(declared.events ?? []).includes(e.type)) throw new PluginError("forbidden", `event type ${e.type} is not declared in contributes.events (§8.4)`);
        if (String(e.text).length > EVENT_TEXT_MAX) throw new PluginError("invalid", `event text is over ${EVENT_TEXT_MAX} characters`);
        const data = deep(e.data) as Record<string, unknown>;
        if (Buffer.byteLength(JSON.stringify(data)) > EVENT_DATA_MAX) throw new PluginError("invalid", "event data is over 64 KB");
        if (!o.emit) throw new PluginError("unsupported", "events.emit is not available to plugins yet");
        return o.emit({ ...e, type: pluginEventType(name, e.type), text: redact(String(e.text)), data });
      },
      subscribe(stream, filter, handler) {
        live();
        if (!scopes.includes("read")) throw new PluginError("forbidden", "events.subscribe needs the read scope (§11.1)");
        const f = filter ?? {};
        if (f.types !== undefined && (!Array.isArray(f.types) || f.types.some((t) => typeof t !== "string"))) throw new PluginError("invalid", "events.subscribe: filter.types is a list of event types");
        if (f.after !== undefined && !(Number.isSafeInteger(f.after) && f.after >= 0)) throw new PluginError("invalid", "events.subscribe: filter.after is a seq (an integer ≥ 0)");
        if (typeof handler !== "function") throw new PluginError("invalid", "events.subscribe takes a handler function");
        if (!o.subscribe) throw new PluginError("unsupported", "events.subscribe is not available to plugins yet");
        // §8.4: the host calls `deliver` in order, one at a time; a handler that throws is logged and the event skipped,
        // and nothing reaches it once the subscription (or the plugin) is disposed.
        let on = true;
        const deliver = async (e: HarnessEventEnvelope) => {
          if (!on) return;
          try { await handler(e); } catch (err) {
            log("warn", "an events.subscribe handler threw; the event was skipped", { stream, type: e.type, seq: e.seq, error: err instanceof Error ? err.message : String(err) });
          }
        };
        const sub = o.subscribe(stream, { ...(f.types ? { types: [...f.types] } : {}), ...(f.after !== undefined ? { after: f.after } : {}) }, deliver);
        return register({ kind: "subscription", stream }, () => { on = false; void sub.dispose(); });
      },
      async replay(stream, after) {
        live();
        if (!scopes.includes("read")) throw new PluginError("forbidden", "events.replay needs the read scope (§11.1)");
        if (!(Number.isSafeInteger(after) && after >= 0)) throw new PluginError("invalid", "events.replay: after is a seq (an integer ≥ 0)");
        if (!o.replay) throw new PluginError("unsupported", "events.replay is not available to plugins yet");
        return o.replay(stream, after);
      },
    },
    storage: guarded("storage"),
    runs: guarded("runs"),
    agents: guarded("agents"),
    messages: guarded("messages"),
    gates: guarded("gates"),
    board: guarded("board"),
    kv: guarded("kv"),
    sandboxes: guarded("sandboxes"),
    profiles: guarded("profiles"),
    auth,
    jobs: guarded("jobs"),
    triggers: guarded("triggers"),
    onDispose(fn) {
      live();
      return register({ kind: "onDispose" }, () => {}, fn);
    },
  };

  const registered = () => entries.map((e) => e.reg);
  return {
    ctx,
    registrations: registered,
    violations,
    get disposed() { return disposed; },
    missing() {
      const regs = registered();
      const has = (p: (r: Registration) => boolean) => regs.some(p);
      return [
        ...Object.keys(declared.hooks ?? {}).filter((h) => !has((r) => r.kind === "hook" && r.hook === h)).map((h) => `hook ${h}`),
        ...(declared.seams ?? []).filter((s) => !has((r) => r.kind === "seam" && r.seam === s.kind)).map((s) => `${s.kind} seam ${s.name}`),
        ...(declared.context ?? []).filter((c) => !has((r) => r.kind === "context" && r.name === c.name)).map((c) => `context provider ${c.name}`),
        ...(declared.cli ?? []).filter((c) => !has((r) => r.kind === "cli" && r.name === c.name)).map((c) => `CLI command ${c.name}`),
        ...(declared.mcp ?? []).filter((t) => !has((r) => r.kind === "mcp" && r.name.endsWith(`_${t.name}`))).map((t) => `MCP tool ${t.name}`),
        ...(declared.api ?? []).filter((a) => !has((r) => r.kind === "api" && r.method === a.method && r.path === `/v1/x/${name}${a.path}`)).map((a) => `API route ${a.method} ${a.path}`),
        ...(declared.ui ?? []).filter((u) => !has((r) => r.kind === "ui" && r.id === u.id)).map((u) => `UI ${u.kind} ${u.id}`),
      ];
    },
    async dispose(budgetMs = 10_000) {
      if (disposed) return { timedOut: false, remaining: [] };
      abort.abort(new PluginError("disposed", `${name} is disposing`));
      o.hooks.detach(name);
      const until = Date.now() + budgetMs;
      let timedOut = false;
      for (const e of [...entries].reverse()) {
        e.live = false;
        entries.splice(entries.indexOf(e), 1);
        // Removal is synchronous, so a registration is inert even when its callback is dropped over budget.
        try { e.remove(); } catch { /* a registry entry already gone */ }
        if (!e.finish || timedOut) continue;
        const left = until - Date.now();
        if (left <= 0) { timedOut = true; continue; }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = Promise.resolve().then(e.finish).then(() => true, (err: unknown) => { log("warn", "an onDispose callback threw", { error: err instanceof Error ? err.message : String(err) }); return true; });
        const over = await Promise.race([done, new Promise<false>((r) => { timer = setTimeout(() => r(false), left); })]);
        clearTimeout(timer);
        if (!over) timedOut = true;
      }
      disposed = true;
      return { timedOut, remaining: registered() };
    },
  };
}
