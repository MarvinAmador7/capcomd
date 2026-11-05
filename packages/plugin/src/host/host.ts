// The plugin host (spec §5): discovers, validates, resolves, loads, runs and disposes plugins through the §5.4 states,
// owns the registries, and writes the plugin.* events (§13.1). In-process only in this version: an out-of-process
// plugin (§9) is listed at `validated` and not loaded.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PluginError, type PluginFailureCause } from "../errors";
import type { HookName } from "../hooks";
import { loadManifest, readManifest, type LoadedManifest } from "../load";
import { PLUGIN_NAME_PATTERN, type PluginManifest } from "../manifest";
import type { PluginModule } from "../context";
import { createContext, ContributionStore, type ContextOptions, type PluginRuntime } from "./context";
import { provided, resolveOrder } from "./order";
import { HookRegistry, type HookStats, type HostEvent } from "./registry";

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
  /** The plugin's config over its schema's defaults (§10.2; layering lands with the config service). */
  config?: Record<string, unknown>;
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
  /** An operator's `allow-version` exemption (§4.4). */
  exempt?(name: string, version: string): boolean;
  /** Called after every state change, with the new listing. */
  onChange?(plugins: PluginSummary[]): void;
  activateTimeoutMs?: number;
  disposeBudgetMs?: number;
  breakerAt?: number;
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
  }

  /** `capcomd plugins disable` (§5.4): an active plugin disposes; any plugin is held at `validated` until enabled. */
  async disable(name: string): Promise<PluginSummary> {
    const r = this.rec(name) ?? (() => { throw new PluginError("not_found", `no plugin ${name}`); })();
    r.enabled = false;
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
    if (!r.manifest || r.state === "failed" && ["invalid_manifest", "incompatible", "untrusted"].includes(r.cause ?? "")) {
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

  // ---- states ---------------------------------------------------------------------------------------------------

  private rec(name: string): Rec | undefined { return this.records.find((r) => r.name === name && r.cause !== "duplicate") ?? this.records.find((r) => r.name === name); }

  private discover(c: Candidate, index: number) {
    const raw = c.dir ? (() => { try { return JSON.parse(readFileSync(join(c.dir!, "plugin.json"), "utf8")); } catch { return null; } })() : c.manifest;
    const name = nameOf(raw, c.dir, index);
    const r: Rec = { index, name, source: c.source, dir: c.dir ?? null, candidate: c, manifest: null, state: "discovered", enabled: c.enabled ?? true, cause: null, message: null, runtime: null, module: (c.module as PluginModule<unknown> | undefined) ?? null };
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
    const check = (exempt: boolean): LoadedManifest => c.dir ? readManifest(c.dir, { capcomd: this.o.capcomd, exempt }) : loadManifest(c.manifest, { capcomd: this.o.capcomd, exempt });
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
    for (const w of loaded.warnings) this.o.sinks?.log?.({ plugin: r.name, level: "warn", message: `manifest: ${w.path}: ${w.message}`, fields: {} });
    if (loaded.manifest.entry.runtime === "in-process" && r.source !== "builtin")
      return this.fail(r, "untrusted", "only built-in plugins run in process (§5.2)");
    this.set(r, "validated", r.enabled ? null : "disabled");
  }

  /** Whether a validated plugin goes on to `resolved`: enabled, and in process (§9 is not in this version). */
  private loadable(r: Rec): boolean {
    if (r.state !== "validated" || !r.enabled || !r.manifest) return false;
    if (r.manifest.entry.runtime === "process") {
      this.o.sinks?.log?.({ plugin: r.name, level: "warn", message: "out-of-process plugins are not loaded by this capcomd yet; it stays validated", fields: {} });
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
      manifest: m, runtime: m.entry.runtime, root: r.dir ?? "", dataDir: this.o.dataDir(r.name),
      hooks: this.hooks, store: this.contributions, config, ...(this.o.services ? { services: this.o.services(m) } : {}), ...this.o.sinks,
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

  /** `active → disposing → disposed` (§5.3). */
  private async unload(r: Rec, why: "daemon_stopping" | "disabled") {
    this.set(r, "disposing", null);
    const d = await r.runtime?.dispose(this.o.disposeBudgetMs);
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
      enabled: r.enabled, cause: r.cause,
      hooks: r.state === "active" ? regs.flatMap((x) => x.kind === "hook" ? [x.hook] : []) : declaredHooks,
      seams: r.state === "active" ? regs.flatMap((x) => x.kind === "seam" ? [{ kind: x.seam, name: x.name }] : []) : (m?.contributes?.seams ?? []).map((s) => ({ kind: s.kind, name: s.name })),
      hooksSuspended: r.state === "active" && this.hooks.suspended(r.name),
      stats: this.hooks.stats(r.name),
    };
  }
}
