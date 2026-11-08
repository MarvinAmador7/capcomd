// The kernel's plugin host (ADR-023 step 1; docs/spec/plugin-api.md §5, §6, §13): packages/plugin's host with what only
// the kernel knows: the running version, the kernel's feature flags, where plugin data lives, the redactor, and where
// the host's events go (the daemon stream, `harnessState().recordDaemonEvent`; a gate's on the run's). `capcomd serve`
// starts it after the actors answer and before the harness.v1 socket opens (§5.5); the kernel fires its hooks through
// its registry (src/plugins/hooks.ts). Another process that runs a gate starts a local one with the built-in gates.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PluginHost, type Candidate, type PluginSummary } from "../../packages/plugin/src/host/host";
import { PluginError } from "../../packages/plugin/src/errors";
import { eventTypeOwner } from "../../packages/plugin/src/event-type";
import { CAPABILITY_NAMES } from "../api/contract";
import { Redactor } from "../agents/redact";
import { capcomdHome, stateDir } from "../utils/home";
import { VERSION } from "../utils/self";
import { BUILTINS, candidateOf } from "./builtins";
import { inBackground, recordGateEvent } from "./hooks";
import { resolveSecret } from "./secrets";
import { pluginJobs } from "../jobs/service";
import { mergePatch, pluginConfigFiles, pluginSettings } from "./config";
import { daemonServices, localServices } from "./services";
import { pluginTriggers } from "../triggers/intake";
import { announce } from "../install/trust";
import { isExempt, projectOf, projectPluginDirs, projectPluginTrusted } from "./install";
import { pluginStore, storageService } from "./storage";
import { eventSinks, noEventSinks, scopeEvents, type EventReads } from "./events";
import { processLauncher } from "./process";
import type { ProcessTimings } from "../../packages/plugin/src/host/process";

/** A durable daemon-stream event (`harnessState().recordDaemonEvent`). */
export type DaemonEventSink = (e: { type: string; entity: string; text: string; data: Record<string, unknown> }) => { seq: number };

/** What the daemon discovers (§4.8), in this order: the built-ins, the user's plugins (<home>/plugins/<name>/plugin.json)
 *  and the plugins of the project it serves (the checkout of its working directory: `.capcomd/plugins/<name>/` and the
 *  `plugins.use` entries fetched for it), each with its settings. The third-party ones run out of process (§5.2); a
 *  project's only once the operator trusted its content (`trusted` in kernelHost). */
export function builtinCandidates(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Candidate[] {
  const files = pluginConfigFiles({ env, cwd });
  return [...BUILTINS.map(candidateOf), ...testPlugins(env), ...userPlugins(env), ...projectPlugins(env, cwd)].map((c) => configured(c, env, files));
}

/** The user's plugins (§4.8 step 2), in name order: each directory of <home>/plugins holding a plugin.json. */
export function userPlugins(env: Record<string, string | undefined> = process.env): Candidate[] {
  const dir = join(capcomdHome(env), "plugins");
  let names: string[] = [];
  try { names = readdirSync(dir).sort(); } catch { return []; }
  return names.filter((n) => !n.startsWith(".") && existsSync(join(dir, n, "plugin.json"))).map((n) => ({ source: "user" as const, dir: join(dir, n) }));
}

/** The project's plugins (§4.8 step 3): its own `.capcomd/plugins/<name>/` in name order, then its `plugins.use` entries
 *  fetched to the user's home (not read with CAPCOMD_NO_CONFIG, like the rest of its config). Listed, never run, until
 *  trusted. */
export function projectPlugins(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): Candidate[] {
  const project = projectOf(cwd, env);
  if (!project) return [];
  return projectPluginDirs(project, env, !env.CAPCOMD_NO_CONFIG).map((dir) => ({ source: "project" as const, dir }));
}

/**
 * A candidate with its settings (§10.2, src/plugins/config.ts) over its schema's defaults (the host's): `plugins.<name>`
 * in the user's, then the project's config (neither under CAPCOMD_NO_CONFIG), then CAPCOMD_PLUGIN_<NAME>_<KEY>.
 * `enabled` from the last layer that says (false holds it at `validated`; true turns on a built-in that is off until
 * asked for, the watchdog); what its schema refuses is `configErrors` (the host fails it `config_invalid`). A plugin
 * from a directory (a user's, a project's) is read for its name and schema; one that can't be read is as it was (the
 * host fails it). `source` limits what a project may set (src/plugins/config.ts).
 */
export function configured(c: Candidate, env: Record<string, string | undefined> = process.env, files = pluginConfigFiles({ env })): Candidate {
  const raw = c.manifest ?? (c.dir ? (() => { try { return JSON.parse(readFileSync(join(c.dir!, "plugin.json"), "utf8")) as unknown; } catch { return null; } })() : null);
  const m = raw as { name?: unknown; config?: unknown } | null;
  if (!m || typeof m !== "object" || typeof m.name !== "string") return c;
  const s = pluginSettings(m as { name: string; config?: unknown }, { env, files, dir: c.dir ?? null, source: c.source });
  const config = mergePatch(c.config ?? {}, s.config) as Record<string, unknown>;
  return { ...c, ...(Object.keys(config).length ? { config } : {}), ...(s.enabled !== undefined ? { enabled: s.enabled } : {}), ...(s.errors.length ? { configErrors: s.errors } : {}), ...(Object.keys(s.sources).length ? { configSources: s.sources } : {}) };
}

/** Tests only (`bun test` sets NODE_ENV=test): CAPCOMD_TEST_PLUGINS, `:`-separated plugin directories, load in process
 *  like built-ins, so a scenario's daemon can carry a recording plugin (tests/scenarios/hooks-order.test.ts). */
function testPlugins(env: Record<string, string | undefined>): Candidate[] {
  if (env.NODE_ENV !== "test" || !env.CAPCOMD_TEST_PLUGINS) return [];
  return env.CAPCOMD_TEST_PLUGINS.split(":").filter(Boolean).map((dir) => ({ source: "builtin" as const, dir }));
}

/** A plugin's data directory (§4.2): <home>/state/plugins/<name>/, made by whoever writes there first. */
export const pluginDataDir = (name: string, env: Record<string, string | undefined> = process.env) => join(stateDir(env), "plugins", name);

/** Where the running daemon keeps its plugin listing for `capcomd plugins list` (the CLI has no API token). */
export const pluginsSnapshotPath = (env: Record<string, string | undefined> = process.env) => join(stateDir(env), "plugins.json");
export type PluginsSnapshot = { pid: number; at: string; plugins: PluginSummary[] };

function writeSnapshot(path: string, plugins: PluginSummary[]) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), plugins } satisfies PluginsSnapshot), { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* the listing is a convenience; the daemon runs without it */ }
}

/** The running daemon's listing, or null when there is none or the daemon that wrote it is gone. */
export function readSnapshot(path = pluginsSnapshotPath()): PluginsSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as PluginsSnapshot;
    process.kill(s.pid, 0);
    return Array.isArray(s.plugins) ? s : null;
  } catch { return null; }
}

/** Remove the listing on the way out, only while it is still this process's. */
export function releaseSnapshot(path = pluginsSnapshotPath()) {
  try { if ((JSON.parse(readFileSync(path, "utf8")) as PluginsSnapshot).pid === process.pid) rmSync(path, { force: true }); } catch { /* gone already */ }
}

/** A plugin's own event on a run's stream (§4.7.4): a scope event of the run, read back like any other. */
export type RunEventSink = (runId: string, e: { type: string; entity: string; text: string; data: Record<string, unknown>; key: string }) => Promise<{ seq: number }>;

/** The run's scope actor, when the run exists (a plugin can't create one by writing to it). */
const scopeSink: RunEventSink = async (runId, e) => {
  const { existingActor } = await import("../core/relay");
  const scope = /^run-[A-Za-z0-9_-]+$/.test(runId) ? await existingActor("scope", [runId]) : null;
  if (!scope) throw new PluginError("not_found", `no run ${runId}`);
  return scope.recordPluginEvent(e);
};

/**
 * Where a plugin's own `plugin.<name>.<event>` goes (§4.7.4): the daemon stream or a run's. The type must be a plugin's
 * own (the host built it from the manifest's name and a declared event, packages/plugin/src/event-type.ts), so a plugin
 * never writes a kernel type. Its `entity` is what it named, else `plugin:<name>`; its text is its own sentence.
 */
export function pluginEventWriter(o: { daemon?: DaemonEventSink; run?: RunEventSink } = {}) {
  const run = o.run ?? scopeSink;
  return async (e: { type: string; stream: string; entity?: string; text: string; data: Record<string, unknown>; durability?: "durable" | "ephemeral" }): Promise<{ seq: number }> => {
    const owner = eventTypeOwner(e.type);
    if (owner?.kind !== "plugin") throw new PluginError("invalid", `not a plugin's own event type: ${e.type}`);
    if (e.durability === "ephemeral") throw new PluginError("unsupported", "ephemeral plugin events are not written yet: leave durability out");
    const ev = { type: e.type, entity: e.entity || `plugin:${owner.plugin}`, text: e.text, data: e.data };
    if (e.stream === "daemon") return o.daemon?.(ev) ?? { seq: 0 };
    return run(e.stream, { ...ev, key: `plugin-${owner.plugin}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` });
  };
}

/**
 * `events`: where the daemon's host reads streams for `ctx.events.subscribe` and `replay` (§8.4, src/plugins/events.ts):
 * the daemon's own events, and a run's through the engine unless given. A host without it (a CLI's, the MCP server's)
 * refuses both, `unsupported`: the streams are the daemon's.
 * `jobs`: the daemon's host, whose plugins get `ctx.jobs` (§16.2), `ctx.storage` (§8.4; one process writes a plugin's
 * storage) and the engine's primitives, `ctx.runs`, `agents`, `messages`, `kv`, `board`, `gates.pending` and `profiles`
 * (§8.4, src/plugins/services.ts): a CLI's local host has none of them, `unsupported`. Every host's plugins get
 * `ctx.sandboxes` and `ctx.auth`, this process's places and logins. `triggers`: they get `ctx.triggers` too (§16.3; the
 * daemon's only). `process`: the plugin socket out-of-process plugins connect to (§9.2); without it they stay
 * `validated` (a CLI's local host).
 */
export function kernelHost(o: { record?: DaemonEventSink; events?: { daemon: EventReads["daemon"]; run?: EventReads["run"]; pollMs?: number }; snapshot?: string | null; log?: boolean; run?: RunEventSink; jobs?: boolean; triggers?: boolean; process?: { socket: string; timings?: ProcessTimings } } = {}): PluginHost {
  const redactor = new Redactor();
  const record = (e: { type: string; stream: string; entity: string; text: string; data: Record<string, unknown> }) => {
    if (e.stream !== "daemon") throw new PluginError("unsupported", `the host writes its own events on the daemon stream only (${e.type})`);
    return o.record?.({ type: e.type, entity: e.entity, text: e.text, data: e.data }) ?? { seq: 0 };
  };
  const pluginEvent = pluginEventWriter({ ...(o.record ? { daemon: o.record } : {}), ...(o.run ? { run: o.run } : {}) });
  const dataDir = pluginDataDir;
  const streams = o.events ? eventSinks({ daemon: o.events.daemon, run: o.events.run ?? scopeEvents }, o.events.pollMs ? { pollMs: o.events.pollMs } : {}) : noEventSinks;
  // §13.3: one JSON line per log call in the daemon's log, never an event. A CLI's local host keeps its output clean.
  const log = (l: { plugin: string; level: string; message: string; fields: Record<string, unknown> }) => { if (o.log !== false) console.log(JSON.stringify({ plugin: l.plugin, level: l.level, message: l.message, fields: l.fields })); };
  return new PluginHost({
    capcomd: VERSION,
    kernel: CAPABILITY_NAMES.map((n) => `kernel:${n}`),
    emit: (e) => {
      // A gate's audit goes on the run's stream (§13.1), from whichever process ran the gate.
      if (e.type === "plugin.gate_denied" && e.stream !== "daemon") {
        inBackground(recordGateEvent(e.stream, { type: e.type, data: e.data }).catch((err) => console.error(`[plugins] ${e.stream}: recording ${e.type}: ${(err as Error)?.message ?? err}`)));
        return;
      }
      try { record(e); } catch { /* not a daemon-stream event */ }
    },
    dataDir,
    services: (m) => ({
      ...localServices(),
      ...(o.jobs ? { jobs: pluginJobs(m.name), storage: storageService(pluginStore(m.name, dataDir(m.name))), ...daemonServices(m) } : {}),
      ...(o.triggers ? { triggers: pluginTriggers(m.name, m.scopes ?? []) } : {}),
    }),
    // Only a shipped built-in (no directory) may name the kernel's own variables (§10.3): resolveSecret checks both.
    secret: async (m, key, dir, source) => resolveSecret(m, key, process.env, dir, { builtin: source === "builtin" }),
    exempt: (name, version) => isExempt(name, version),
    // A project's plugin runs only with its content as the operator trusted it (§4.8). The daemon audits each trust
    // the first time it acts on it (`plugin.trusted`; the CLI that recorded it can't write the daemon's stream).
    trusted: (name, dir) => {
      const t = projectPluginTrusted(dir);
      if (t.trusted && o.record) {
        const e = announce("plugin", dir, t.hash!);
        if (e) record({ type: "plugin.trusted", stream: "daemon", entity: `plugin:${name}`, text: `The ${name} plugin of a project was trusted.`, data: { plugin: name, source: "project", hash: t.hash, by: e.by } });
      }
      return t.trusted;
    },
    sinks: { redact: (t) => redactor.text(t), log, emit: pluginEvent, subscribe: streams.subscribe, replay: streams.replay },
    ...(o.process ? { launcher: processLauncher({ socket: o.process.socket, log }), ...(o.process.timings ? { processTimings: o.process.timings } : {}) } : {}),
    ...(o.snapshot ? { onChange: (plugins: PluginSummary[]) => writeSnapshot(o.snapshot!, plugins) } : {}),
  });
}

/** What a process that isn't the daemon loads: the built-ins marked `everyProcess` (the reviewer gate, the forges, the
 *  front doors, the orchestration skill), and in tests CAPCOMD_TEST_PLUGINS. */
export function localCandidates(env: Record<string, string | undefined> = process.env): Candidate[] {
  const files = pluginConfigFiles({ env });
  return [...BUILTINS.filter((b) => b.everyProcess).map(candidateOf), ...testPlugins(env)].map((c) => configured(c, env, files));
}

let local: Promise<PluginHost> | null = null;
/**
 * The plugin host of a process that isn't the daemon, started once on first use: its gates (src/plugins/hooks.ts
 * `gates`), its forges (src/plugins/forges `forgeFor`) and its front doors (the CLI's commands, src/cli/front-doors.ts;
 * the MCP server's tools, src/mcp/server.ts) are this host's. It writes no daemon-stream events (that
 * stream is the daemon's) and no listing; its gate events go on the run's stream like the daemon's.
 */
export function localHost(env: Record<string, string | undefined> = process.env): Promise<PluginHost> {
  local ??= (async () => {
    const host = kernelHost({ log: false });
    await host.start(localCandidates(env));
    return host;
  })();
  return local;
}
