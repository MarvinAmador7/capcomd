// The plugin host (spec §5): discovers, validates, resolves, loads, runs and disposes plugins through the §5.4 states,
// owns the registries, and writes the plugin.* events (§13.1). An out-of-process plugin (§9) runs when the host has a
// launcher (the daemon's: src/plugins/process.ts); without one (a CLI's local host) it is listed at `validated`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PluginError, type PluginFailureCause } from "../errors";
import { HOOKS, type HookCall, type HookName } from "../hooks";
import { loadManifest, readManifest, type LoadedManifest } from "../load";
import { PLUGIN_NAME_PATTERN, type PluginManifest } from "../manifest";
import type { PluginModule } from "../context";
import { createContext, ContributionStore, type ContextOptions, type PluginRuntime } from "./context";
import { provided, resolveOrder } from "./order";
import { HookRegistry, type HookStats, type HostEvent } from "./registry";
import { ProcessPlugin, ProtocolError, type FrameSink, type ProcessLauncher, type ProcessTimings, type ProtocolCaller } from "./process";
import type { PluginContext } from "../context";
import type { SessionOpened } from "../protocol";

export const PLUGIN_STATES = ["discovered", "validated", "resolved", "loading", "active", "disposing", "disposed", "failed"] as const;
export type PluginState = (typeof PLUGIN_STATES)[number];
export type PluginSource = "builtin" | "user" | "project";

/** One plugin the host was given to discover (§4.8): a directory, or for a built-in its manifest and module. */
export interface Candidate {
  source: PluginSource;
  /** The plugin's directory: `plugin.json`, the entry module and anything its manifest `$ref`s. */
  dir?: string;
  /** The manifest value, when there is no directory (a built-in bundled into the executable). */
  manifest?: unknown;
  /** The entry module, when it is not imported from `dir` (a built-in: §4.8, imported, never read from disk). */
  module?: PluginModule<never>;
  /** `plugins.<name>.enabled` in config (§4.8); default true. */
  enabled?: boolean;
  /** The plugin's config over its schema's defaults: the user, project and environment layers merged (§10.2). */
  config?: Record<string, unknown>;
  /** What its schema refused in those layers (§10.4): an enabled plugin with any is failed `config_invalid`, except for
   *  those `setAside` (a project's settings for a plugin not its own, left out of `config`): those are only reported. */
  configErrors?: Array<{ path: string; message: string; layer: "user" | "project" | "env"; setAside?: true }>;
  /** The layer each top-level key of `config` came from (`GET /v1/plugins/{name}` `config.sources`); a key not listed
   *  is the user's. */
  configSources?: Record<string, "user" | "project" | "env">;
  /** One of the kernel's own front doors (§4.2, §4.7.1): its CLI groups take the kernel's command names and its MCP
   *  tools are `capcomd_<tool>`. The kernel's built-in list sets it; honoured for `source: "builtin"` only. */
  kernelSurface?: boolean;
}

/** `GET /v1/plugins` and `capcomd plugins list` (§13.2). */
export interface PluginSummary {
  name: string;
  version: string;
  apiVersion: 1;
  runtime: "in-process" | "process";
  source: PluginSource;
  state: PluginState;
  enabled: boolean;
  cause: PluginFailureCause | null;
  hooks: HookName[];
  seams: Array<{ kind: "sandbox" | "agent" | "forge"; name: string }>;
  hooksSuspended: boolean;
  stats: HookStats;
}

type HostSinks = Pick<ContextOptions<unknown>, "emit" | "subscribe" | "replay" | "log" | "span" | "redact" | "secret">;
export interface HostOptions {
  /** The running capcomd version, for `engines` (§4.4). */
  capcomd: string;
  /** The capability ids the kernel provides: `kernel:<feature flag>` (§4.6). */
  kernel: Iterable<string>;
  /** Where the host's own events go (§13.1). */
  emit(e: HostEvent): void;
  /** A plugin's durable data directory (§4.2): not created by the host. */
  dataDir(name: string): string;
  /** The kernel's primitive implementations for a plugin (absent: `unsupported`). */
  services?(manifest: PluginManifest): ContextOptions<unknown>["services"];
  sinks?: HostSinks;
  /** A plugin's own secret (§10.3): the value its `x-secret` property `key` references, for that plugin only. `source`:
   *  where it came from (only a built-in's schema default names a reference; a plugin from a directory's never does). */
  secret?(manifest: PluginManifest, key: string, dir: string | null, source: PluginSource): Promise<string>;
  /** An operator's `allow-version` exemption (§4.4). */
  exempt?(name: string, version: string): boolean;
  /**
   * Whether a project's plugin may run (§4.8): the operator trusted its content as it is now. Asked each time it would
   * go on from `validated` (at start and at `enable`) and before each start of its process. Without it no project
   * plugin runs.
   */
  trusted?(name: string, dir: string): boolean;
  /** Called after every state change, with the new listing. */
  onChange?(plugins: PluginSummary[]): void;
  activateTimeoutMs?: number;
  disposeBudgetMs?: number;
  breakerAt?: number;
  /** Starts out-of-process plugins (§9.2, §9.3). Without it a `process` plugin stays `validated` (a CLI's local host:
   *  a third-party plugin's code runs only beside the daemon). */
  launcher?: ProcessLauncher;
  processTimings?: ProcessTimings;
}

/** `GET /v1/plugins/{name}` (§13.2): the summary, the validated manifest and the config without secrets. */
export interface PluginDetail extends PluginSummary {
  manifest: PluginManifest | null;
  config: { values: Record<string, unknown>; sources: Record<string, "default" | "user" | "project" | "env"> };
}

/** The out-of-process protocol's routes as the host answers them (§9.3-§9.6); the gateway maps HTTP onto these. Every
 *  call checks that the caller's token is the plugin's own (a ProtocolError 403 otherwise). */
export interface PluginProtocol {
  open(name: string, caller: ProtocolCaller, body: unknown): SessionOpened;
  attach(name: string, caller: ProtocolCaller, session: string, lastEventId: number | null, sink: FrameSink): () => void;
  answer(name: string, caller: ProtocolCaller, callId: string, body: unknown): Promise<void>;
  /** The plugin's own context, for the primitives the protocol carries (`events.emit`, `storage`, §9.6): the same scope
   *  and declaration checks as in process. */
  context(name: string, caller: ProtocolCaller): PluginContext<unknown>;
}

type Rec = {
  index: number;
  name: string;
  source: PluginSource;
  dir: string | null;
  candidate: Candidate;
  manifest: PluginManifest | null;
  state: PluginState;
  enabled: boolean;
  cause: PluginFailureCause | null;
  message: string | null;
  runtime: PluginRuntime<unknown> | null;
  module: PluginModule<unknown> | null;
  /** sha256 of the manifest file (a plugin from a directory): what its process must present (§9.3). */
  hash: string | null;
  process: ProcessPlugin | null;
};

/** `plugins.<name>` defaults from the config schema (§10.1): top-level `properties.*.default`. */
export function configDefaults(m: PluginManifest, dir: string | null): Record<string, unknown> {
  let schema: unknown = m.config;
  if (schema && typeof schema === "object" && "$ref" in schema && dir) {
    try { schema = JSON.parse(readFileSync(join(dir, String((schema as { $ref: string }).$ref)), "utf8")); } catch { schema = null; }
  }
  const props = (schema as { properties?: Record<string, { default?: unknown; "x-secret"?: boolean }> } | null)?.properties ?? {};
  return Object.fromEntries(Object.entries(props).filter(([, p]) => p && "default" in p && !p["x-secret"]).map(([k, p]) => [k, structuredClone(p.default)]));
}

/** The `x-secret` properties of a plugin's config schema (§10.3). */
export function secretKeys(m: PluginManifest, dir: string | null): string[] {
  let schema: unknown = m.config;
  if (schema && typeof schema === "object" && "$ref" in schema && dir) {
    try { schema = JSON.parse(readFileSync(join(dir, String((schema as { $ref: string }).$ref)), "utf8")); } catch { schema = null; }
  }
  const props = (schema as { properties?: Record<string, { "x-secret"?: boolean }> } | null)?.properties ?? {};
  return Object.entries(props).filter(([, p]) => p?.["x-secret"] === true).map(([k]) => k);
}

/** A candidate the kernel names as one of its own front doors: a built-in only, never a plugin from a directory. */
const kernelSurfaceOf = (c: Candidate): boolean => c.source === "builtin" && !c.dir && c.kernelSurface === true;

const nameOf = (raw: unknown, dir: string | undefined, i: number): string => {
  const n = raw && typeof raw === "object" ? (raw as { name?: unknown }).name : undefined;
  if (typeof n === "string" && new RegExp(PLUGIN_NAME_PATTERN).test(n)) return n;
  const b = dir ? basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 63) : "";
  return b || `plugin-${i + 1}`;
};

export class PluginHost {
  readonly hooks: HookRegistry;
  readonly contributions = new ContributionStore();
  private records: Rec[] = [];
  private loadOrder: string[] = [];
  private readonly kernel: Set<string>;

  constructor(private readonly o: HostOptions) {
    this.kernel = new Set(o.kernel);
    this.hooks = new HookRegistry({ emit: (e) => o.emit(e), rank: (p) => { const i = this.loadOrder.indexOf(p); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }, ...(o.breakerAt ? { breakerAt: o.breakerAt } : {}) });
  }

  /** §5.5 start steps 2-3: discover, validate and resolve every candidate, then load them one at a time in order. */
  async start(candidates: Candidate[]): Promise<PluginSummary[]> {
    this.plan(candidates);
    for (const name of [...this.loadOrder]) await this.load(this.rec(name)!);
    this.changed();
    return this.list();
  }

  /** Discover, validate and resolve without running any plugin code (§4.7: what can be described before loading). */
  plan(candidates: Candidate[]): PluginSummary[] {
    this.hooks.restart();
    this.records = [];
    candidates.forEach((c, i) => this.discover(c, i));
    this.resolve();
    return this.list();
  }

  /** §5.5 stop steps 2-3: gates that fire from now on are denied; plugins dispose in reverse load order. */
  async stop(): Promise<void> {
    this.hooks.stop();
    for (const name of [...this.loadOrder].reverse()) {
      const r = this.rec(name);
      if (r?.state === "active") await this.unload(r, "daemon_stopping");
    }
    for (const r of this.records) await this.release(r);
  }

  /** `capcomd plugins disable` (§5.4): an active plugin disposes; any plugin is held at `validated` until enabled. */
  async disable(name: string): Promise<PluginSummary> {
    const r = this.rec(name) ?? (() => { throw new PluginError("not_found", `no plugin ${name}`); })();
    r.enabled = false;
    await this.release(r);
    if (r.state === "active") await this.unload(r, "disabled");
    else if (r.state === "validated" || r.state === "resolved") this.set(r, "validated", "disabled");
    else this.changed();
    return this.summary(r);
  }

  /** `capcomd plugins enable` (§5.4, §6.5): resets an active plugin's breaker; a disposed, failed or disabled one goes
   *  back to `validated` and onward. In process the same module's `activate` runs again (no fresh import). */
  async enable(name: string, by = "operator"): Promise<PluginSummary> {
    const r = this.rec(name) ?? (() => { throw new PluginError("not_found", `no plugin ${name}`); })();
    r.enabled = true;
    if (r.state === "active") { this.hooks.resume(name, by); return this.summary(r); }
    if (r.state === "loading" || r.state === "disposing") throw new PluginError("conflict", `${name} is ${r.state}`);
    if (r.state === "failed" && r.cause === "duplicate") return this.summary(r);
    await this.release(r);
    // A plugin from a directory is read again: out of process a new child runs, so its manifest may have changed too.
    if (!r.manifest || r.dir || r.state === "failed" && ["invalid_manifest", "incompatible", "untrusted"].includes(r.cause ?? "")) {
      this.validate(r);
      if (r.state === "failed") return this.summary(r);
    }
    this.set(r, "validated", null);
    if (!this.loadable(r)) return this.summary(r);
    // The active plugins first: they hold their seams and sources, so a clash or a cycle fails the one being enabled,
    // never one already running (§4.6). The order itself doesn't depend on this list's order (§6.3).
    const live = [...this.records.filter((x) => x !== r && x.state === "active"), r];
    const { order, failed } = resolveOrder(live.map((x) => ({ name: x.name, manifest: x.manifest! })), this.kernel);
    const f = failed.get(r.name);
    if (f) { this.fail(r, f.cause, f.message); return this.summary(r); }
    this.loadOrder = [...order, ...this.loadOrder.filter((n) => !order.includes(n))];
    this.set(r, "resolved", null);
    await this.load(r);
    return this.summary(r);
  }

  list(): PluginSummary[] {
    const ordered = this.loadOrder.map((n) => this.rec(n)).filter((r): r is Rec => !!r);
    return [...ordered, ...this.records.filter((r) => !ordered.includes(r))].map((r) => this.summary(r));
  }

  get(name: string): PluginSummary | null {
    const r = this.rec(name);
    return r ? this.summary(r) : null;
  }

  /** Why a plugin failed, in the host's words (the event's `message`); null when it didn't. */
  message(name: string): string | null { return this.rec(name)?.message ?? null; }

  /** `GET /v1/plugins/{name}` (§13.2). Never a secret: those are never in a plugin's config values (§10.3). */
  detail(name: string): PluginDetail | null {
    const r = this.rec(name);
    if (!r) return null;
    const secret = new Set(r.manifest ? secretKeys(r.manifest, r.dir) : []);
    const defaults = r.manifest ? configDefaults(r.manifest, r.dir) : {};
    const own = Object.fromEntries(Object.entries(r.candidate.config ?? {}).filter(([k]) => !secret.has(k)));
    const values = { ...defaults, ...own };
    const sources = Object.fromEntries(Object.keys(values).map((k) => [k, k in own ? r.candidate.configSources?.[k] ?? "user" as const : "default" as const]));
    return { ...this.summary(r), manifest: r.manifest, config: { values, sources } };
  }

  /** The out-of-process protocol (§9), for the gateway. */
  readonly protocol: PluginProtocol = {
    open: (name, caller, body) => this.processOf(name, caller).open(caller, body),
    attach: (name, caller, session, last, sink) => this.processOf(name, caller).attach(caller, session, last, sink),
    answer: (name, caller, callId, body) => this.processOf(name, caller).answer(caller, callId, body),
    context: (name, caller) => {
      this.processOf(name, caller);
      return this.rec(name)!.runtime!.ctx;
    },
  };

  /** The running process of plugin `name`, for a caller holding that plugin's token. */
  private processOf(name: string, caller: ProtocolCaller): ProcessPlugin {
    if (caller.plugin !== name) throw new ProtocolError(403, "forbidden", `only the token the host minted for the ${name} plugin may use its protocol routes`);
    const r = this.rec(name);
    if (!r?.process || !r.runtime) throw new ProtocolError(409, "conflict", `the ${name} plugin has no process running`);
    return r.process;
  }

  // ---- states ---------------------------------------------------------------------------------------------------

  private rec(name: string): Rec | undefined { return this.records.find((r) => r.name === name && r.cause !== "duplicate") ?? this.records.find((r) => r.name === name); }

  private discover(c: Candidate, index: number) {
    const raw = c.dir ? (() => { try { return JSON.parse(readFileSync(join(c.dir!, "plugin.json"), "utf8")); } catch { return null; } })() : c.manifest;
    const name = nameOf(raw, c.dir, index);
    const r: Rec = { index, name, source: c.source, dir: c.dir ?? null, candidate: c, manifest: null, state: "discovered", enabled: c.enabled ?? true, cause: null, message: null, runtime: null, module: (c.module as PluginModule<unknown> | undefined) ?? null, hash: null, process: null };
    const first = this.records.find((x) => x.name === name);
    this.records.push(r);
    if (first) {
      this.o.emit({ type: "plugin.duplicate_refused", stream: "daemon", entity: `plugin:${name}`, text: `A second plugin named ${name} was refused.`, data: { plugin: name, kept: first.source, refused: c.source, path: c.dir ?? "(built-in)" } });
      return this.set(r, "failed", "duplicate", `a plugin named ${name} was already discovered (${first.source})`);
    }
    this.validate(r);
  }

  /** `discovered → validated` (§4.9, §4.4, §5.2), or `failed`. */
  private validate(r: Rec) {
    const c = r.candidate;
    const kernelSurface = kernelSurfaceOf(c);
    const check = (exempt: boolean): LoadedManifest => c.dir ? readManifest(c.dir, { capcomd: this.o.capcomd, exempt, kernelSurface }) : loadManifest(c.manifest, { capcomd: this.o.capcomd, exempt, kernelSurface });
    let loaded = check(false);
    if (!loaded.ok && loaded.cause === "incompatible" && loaded.manifest && this.o.exempt?.(loaded.manifest.name, loaded.manifest.version)) loaded = check(true);
    if (!loaded.ok) {
      r.manifest = loaded.manifest;
      const message = loaded.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
      if (loaded.cause === "incompatible") {
        const m = loaded.manifest;
        const raw = loaded.raw as { version?: unknown; engines?: { capcomd?: unknown }; apiVersion?: unknown } | null;
        this.o.emit({ type: "plugin.version_refused", stream: "daemon", entity: `plugin:${r.name}`, text: `The ${r.name} plugin doesn't support this capcomd.`, data: { plugin: r.name, version: m?.version ?? String(raw?.version ?? ""), engines: m?.engines.capcomd ?? String(raw?.engines?.capcomd ?? ""), capcomd: this.o.capcomd, apiVersion: Number(m?.apiVersion ?? raw?.apiVersion ?? 0) } });
        return this.set(r, "failed", "incompatible", message);
      }
      return this.fail(r, "invalid_manifest", message);
    }
    r.manifest = loaded.manifest;
    r.hash = null;
    if (c.dir) try { r.hash = createHash("sha256").update(readFileSync(join(c.dir, "plugin.json"))).digest("hex"); } catch { /* read just now: gone again */ }
    for (const w of loaded.warnings) this.o.sinks?.log?.({ plugin: r.name, level: "warn", message: `manifest: ${w.path}: ${w.message}`, fields: {} });
    if (loaded.manifest.entry.runtime === "in-process" && r.source !== "builtin")
      return this.fail(r, "untrusted", "only built-in plugins run in process (§5.2)");
    // §10.4: invalid config fails the plugin rather than run it with defaults (a disabled one isn't run either way).
    const errors = r.enabled ? c.configErrors ?? [] : [];
    if (errors.length) {
      for (const layer of [...new Set(errors.map((e) => e.layer))]) {
        const mine = errors.filter((e) => e.layer === layer).map(({ path, message }) => ({ path, message }));
        this.o.emit({ type: "plugin.config_refused", stream: "daemon", entity: `plugin:${r.name}`, text: `The ${r.name} plugin's settings were refused.`, data: { plugin: r.name, errors: mine, layer } });
      }
      const fatal = errors.filter((e) => !e.setAside);
      if (fatal.length) return this.fail(r, "config_invalid", fatal.map((e) => `${e.layer}: plugins.${r.name}.${e.path}: ${e.message}`).join("; "));
      this.o.sinks?.log?.({ plugin: r.name, level: "warn", message: `the project's settings for it were refused and left out: ${errors.map((e) => `plugins.${r.name}.${e.path}: ${e.message}`).join("; ")}`, fields: {} });
    }
    this.set(r, "validated", r.enabled ? null : "disabled");
  }

  /**
   * Whether a validated plugin goes on to `resolved`: enabled, a project's only once the operator trusted its content
   * as it is now (§4.8: opening a repository runs no code; it stays `validated`, cause `untrusted`), and in process or
   * with a launcher for its process.
   */
  private loadable(r: Rec): boolean {
    if (r.state !== "validated" || !r.enabled || !r.manifest) return false;
    if (r.source === "project" && !(r.dir && this.o.trusted?.(r.name, r.dir))) {
      this.set(r, "validated", "untrusted", "a project's plugin runs only once you trust its content (capcomd plugins trust)");
      return false;
    }
    if (r.manifest.entry.runtime === "process" && (!this.o.launcher || !r.dir || !r.hash)) {
      this.o.sinks?.log?.({ plugin: r.name, level: "warn", message: "out-of-process plugins run only beside the daemon (capcomd serve); it stays validated here", fields: {} });
      return false;
    }
    return true;
  }

  /** `validated → resolved` for every loadable plugin, with one total order (§6.3). */
  private resolve() {
    const ready = this.records.filter((r) => this.loadable(r));
    const { order, failed } = resolveOrder(ready.map((r) => ({ name: r.name, manifest: r.manifest! })), this.kernel);
    for (const r of ready) {
      const f = failed.get(r.name);
      if (f) this.fail(r, f.cause, f.message);
    }
    this.loadOrder = order;
    for (const n of order) this.set(this.rec(n)!, "resolved", null);
  }

  /** `resolved → loading → active` (§5.4), or `failed` with the partial registrations disposed. */
  private async load(r: Rec) {
    const m = r.manifest!;
    const have = new Set([...this.kernel, ...this.records.filter((x) => x.state === "active").flatMap((x) => provided(x.manifest!))]);
    const missing = (m.requires ?? []).filter((id) => !have.has(id));
    if (missing.length) return this.fail(r, "unresolved", `nothing active provides ${missing.join(", ")}`);
    this.set(r, "loading", null);
    const started = Date.now();
    if (m.entry.runtime === "process") return this.loadProcess(r, started);
    let mod = r.module;
    if (!mod && r.dir && m.entry.runtime === "in-process") {
      try {
        const imported = await import(join(r.dir, m.entry.module)) as { plugin?: PluginModule<unknown> };
        mod = imported.plugin ?? null;
      } catch (e) { return this.fail(r, "activate_threw", `importing ${m.entry.module}: ${(e as Error).message}`); }
    }
    if (!mod || typeof mod.activate !== "function") return this.fail(r, "activate_threw", "the entry module has no named export `plugin` with an `activate` function (§4.3)");
    r.module = mod;
    const config = { ...configDefaults(m, r.dir), ...(r.candidate.config ?? {}) };
    const runtime = createContext({
      manifest: m, runtime: m.entry.runtime, root: r.dir ?? "", dataDir: this.o.dataDir(r.name), kernelSurface: kernelSurfaceOf(r.candidate),
      hooks: this.hooks, store: this.contributions, config, ...(this.o.services ? { services: this.o.services(m) } : {}), ...this.o.sinks,
      ...(this.o.secret ? { secret: (key: string) => this.o.secret!(m, key, r.dir, r.source) } : {}),
    });
    r.runtime = runtime;
    this.hooks.attach(r.name, runtime.ctx.signal);
    const limit = this.o.activateTimeoutMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      Promise.resolve().then(() => mod!.activate(runtime.ctx)).then(() => null, (e: unknown) => ({ cause: "activate_threw" as const, message: e instanceof Error ? e.message : String(e) })),
      new Promise<{ cause: "activate_timeout"; message: string }>((res) => { timer = setTimeout(() => res({ cause: "activate_timeout", message: `activate did not return within ${limit} ms` }), limit); }),
    ]);
    clearTimeout(timer);
    const failure = runtime.violations.length ? { cause: "conflict" as const, message: `registered what the manifest doesn't declare: ${runtime.violations.join(", ")}` } : outcome;
    if (failure) {
      await runtime.dispose(this.o.disposeBudgetMs);
      r.runtime = null;
      return this.fail(r, failure.cause, failure.message);
    }
    for (const what of runtime.missing()) this.o.sinks?.log?.({ plugin: r.name, level: "warn", message: `declared but never registered: ${what} (§4.7)`, fields: {} });
    this.set(r, "active", null);
    const s = this.summary(r);
    this.o.emit({ type: "plugin.loaded", stream: "daemon", entity: `plugin:${r.name}`, text: `The ${r.name} plugin is active.`, data: { plugin: r.name, version: m.version, runtime: m.entry.runtime, hooks: s.hooks, seams: s.seams.map((x) => `${x.kind}/${x.name}`), ms: Date.now() - started } });
  }

  /**
   * An out-of-process plugin (§9): `loading` until its process has opened its session and hooks stream (§9.3), then
   * `active`. Its listeners are registered through its own context once the session is open, one per declared hook,
   * each a call over the wire; they stay through restarts (§9.5). A process that can't be kept running fails it.
   */
  private async loadProcess(r: Rec, started: number) {
    const m = r.manifest!;
    const config = { ...configDefaults(m, r.dir), ...(r.candidate.config ?? {}) };
    const hooks = Object.keys(m.contributes?.hooks ?? {}) as HookName[];
    // The plugin's own secrets go to its process once, in the handshake's answer (§10.3), never in its environment.
    const secrets: Record<string, string> = {};
    for (const key of secretKeys(m, r.dir)) {
      try { if (this.o.secret) secrets[key] = await this.o.secret(m, key, r.dir, r.source); } catch (e) {
        this.o.sinks?.log?.({ plugin: r.name, level: "warn", message: `its secret ${key} is not available: ${(e as Error).message}`, fields: {} });
      }
    }
    const runtime = createContext({
      manifest: m, runtime: "process", root: r.dir!, dataDir: this.o.dataDir(r.name), hooks: this.hooks, store: this.contributions, config,
      ...(this.o.services ? { services: this.o.services(m) } : {}), ...this.o.sinks,
    });
    const redact = this.o.sinks?.redact;
    const deep = (v: unknown): unknown => typeof v === "string" ? redact!(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
    const proc: ProcessPlugin = new ProcessPlugin({
      name: r.name, manifest: m, root: r.dir!, dataDir: this.o.dataDir(r.name), manifestHash: r.hash!, launcher: this.trustedLauncher(r), secrets: Object.values(secrets),
      emit: (e) => this.o.emit(e), dropped: (n) => this.hooks.dropped(r.name, n),
      ...(this.o.processTimings ? { timings: this.o.processTimings } : {}), ...(redact ? { redact: deep } : {}),
      listen: () => { for (const h of hooks) runtime.ctx.hooks.on(h, ((call: HookCall) => proc.call(call)) as never); },
      opened: () => ({
        plugin: { name: m.name, version: m.version, scopes: [...(m.scopes ?? [])] },
        config,
        secrets,
        hookTimeoutsMs: Object.fromEntries(hooks.map((h) => [h, Math.min(m.contributes?.hooks?.[h]?.timeoutMs ?? HOOKS[h].timeoutMs.default, HOOKS[h].timeoutMs.max)])),
        daemon: { version: this.o.capcomd, capabilities: [...this.kernel].filter((k) => k.startsWith("kernel:")).map((k) => k.slice("kernel:".length)) },
      }),
      failed: (cause, message) => this.processFailed(r, proc, cause, message),
    });
    r.runtime = runtime;
    r.process = proc;
    this.hooks.attach(r.name, runtime.ctx.signal, { settled: (id, f) => proc.settled(id, f) });
    const failure = await proc.run();
    if (failure) {
      await proc.dispose("disabled");
      await runtime.dispose(this.o.disposeBudgetMs);
      r.runtime = null;
      r.process = null;
      return this.fail(r, failure.cause, failure.message);
    }
    this.set(r, "active", null);
    const s = this.summary(r);
    this.o.emit({ type: "plugin.loaded", stream: "daemon", entity: `plugin:${r.name}`, text: `The ${r.name} plugin is active.`, data: { plugin: r.name, version: m.version, runtime: "process", hooks: s.hooks, seams: [], ms: Date.now() - started } });
  }

  /**
   * The launcher for a plugin's process. A project's plugin is checked again before every start, restarts included
   * (§4.8): files changed since it was trusted (a pull while it ran) are never run; that start fails as a process that
   * couldn't be started, so its gates deny and it ends `failed(restart_limit)` until it is trusted and enabled again.
   */
  private trustedLauncher(r: Rec): ProcessLauncher {
    const launcher = this.o.launcher!;
    if (r.source !== "project") return launcher;
    return {
      ...launcher,
      start: (o) => {
        if (r.dir && this.o.trusted?.(r.name, r.dir)) return launcher.start(o);
        this.o.sinks?.log?.({ plugin: r.name, level: "error", message: "not started: its files changed since you trusted them (capcomd plugins trust)", fields: {} });
        return { clientId: "", pid: null, exited: Promise.resolve({ code: null, signal: null }), kill() {}, revoke() {} };
      },
    };
  }

  /**
   * The process couldn't be kept running (§9.5 `restart_limit`): the plugin is failed, but its listeners stay, held, until
   * an operator enables or disables it. Each of its gate calls fails `crashed` at once (denied, §6.5), an open one is
   * skipped: a crash-looping gate denies, as a suspended one does (§11.3), instead of letting merges pass unjudged.
   */
  private processFailed(r: Rec, proc: ProcessPlugin, cause: PluginFailureCause, message: string) {
    if (r.process !== proc || r.state !== "active") return;
    this.fail(r, cause, message);
  }

  /** A failed out-of-process plugin's held listeners (`processFailed`) go: it is enabled, disabled, or the daemon stops. */
  private async release(r: Rec) {
    if (r.state === "active" || (!r.runtime && !r.process)) return;
    const proc = r.process;
    r.process = null;
    await r.runtime?.dispose(this.o.disposeBudgetMs);
    r.runtime = null;
    await proc?.dispose("disabled");
  }

  /** `active → disposing → disposed` (§5.3; an out-of-process plugin's process last, §9.7). */
  private async unload(r: Rec, why: "daemon_stopping" | "disabled") {
    this.set(r, "disposing", null);
    const d = await r.runtime?.dispose(this.o.disposeBudgetMs);
    await r.process?.dispose(why);
    r.process = null;
    r.runtime = null;
    this.set(r, "disposed", d?.timedOut ? "dispose_timeout" : why === "disabled" ? "disabled" : null);
    this.o.emit({ type: "plugin.disposed", stream: "daemon", entity: `plugin:${r.name}`, text: `The ${r.name} plugin was unloaded.`, data: { plugin: r.name, cause: why } });
  }

  private fail(r: Rec, cause: PluginFailureCause, message: string) {
    this.set(r, "failed", cause, message);
    this.o.emit({ type: "plugin.failed", stream: "daemon", entity: `plugin:${r.name}`, text: `The ${r.name} plugin failed to load (${cause}).`, data: { plugin: r.name, version: r.manifest?.version ?? null, cause, message } });
  }

  private set(r: Rec, state: PluginState, cause: PluginFailureCause | null, message: string | null = null) {
    r.state = state;
    r.cause = cause;
    r.message = message;
    if (state === "failed" || state === "disposed") this.loadOrder = this.loadOrder.filter((n) => n !== r.name || state === "disposed");
    this.changed();
  }

  private changed() { this.o.onChange?.(this.list()); }

  private summary(r: Rec): PluginSummary {
    const m = r.manifest;
    const regs = r.runtime?.registrations() ?? [];
    const declaredHooks = Object.keys(m?.contributes?.hooks ?? {}) as HookName[];
    return {
      name: r.name, version: m?.version ?? "0.0.0", apiVersion: 1, runtime: m?.entry.runtime ?? "in-process", source: r.source, state: r.state,
      enabled: r.enabled && r.cause !== "untrusted", cause: r.cause,
      hooks: r.state === "active" ? regs.flatMap((x) => x.kind === "hook" ? [x.hook] : []) : declaredHooks,
      seams: r.state === "active" ? regs.flatMap((x) => x.kind === "seam" ? [{ kind: x.seam, name: x.name }] : []) : (m?.contributes?.seams ?? []).map((s) => ({ kind: s.kind, name: s.name })),
      hooksSuspended: r.state === "active" && this.hooks.suspended(r.name),
      stats: this.hooks.stats(r.name),
    };
  }
}
