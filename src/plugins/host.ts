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
import { pluginAgents } from "./services";
import { pluginTriggers } from "../triggers/intake";
import { pluginStore, storageService } from "./storage";
import { processLauncher } from "./process";
import type { ProcessTimings } from "../../packages/plugin/src/host/process";

/** A durable daemon-stream event (`harnessState().recordDaemonEvent`). */
export type DaemonEventSink = (e: { type: string; entity: string; text: string; data: Record<string, unknown> }) => { seq: number };

/** What the daemon discovers (§4.8): the built-ins, then the user's plugins (<home>/plugins/<name>/plugin.json, run out
 *  of process: a third-party plugin never runs in process, §5.2). Project plugins wait for `capcomd plugins trust`
 *  (§17.2 step 12). */
export function builtinCandidates(env: Record<string, string | undefined> = process.env): Candidate[] {
  const files = pluginConfigFiles({ env });
  return [...BUILTINS.map(candidateOf), ...testPlugins(env), ...userPlugins(env)].map((c) => configured(c, env, files));
}

/** The user's plugins (§4.8 step 2), in name order: each directory of <home>/plugins holding a plugin.json. */
export function userPlugins(env: Record<string, string | undefined> = process.env): Candidate[] {
  const dir = join(capcomdHome(env), "plugins");
  let names: string[] = [];
  try { names = readdirSync(dir).sort(); } catch { return []; }
  return names.filter((n) => !n.startsWith(".") && existsSync(join(dir, n, "plugin.json"))).map((n) => ({ source: "user" as const, dir: join(dir, n) }));
}

/**
 * A candidate with its settings (§10.2, src/plugins/config.ts) over its schema's defaults (the host's): `plugins.<name>`
 * in the user's, then the project's config (neither under CAPCOMD_NO_CONFIG), then CAPCOMD_PLUGIN_<NAME>_<KEY>.
 * `enabled` from the last layer that says (false holds it at `validated`; true turns on a built-in that is off until
 * asked for, the watchdog); what its schema refuses is `configErrors` (the host fails it `config_invalid`). A candidate
 * whose manifest isn't read yet (a directory: a user's plugin, a test plugin) is as it was.
 */
export function configured(c: Candidate, env: Record<string, string | undefined> = process.env, files = pluginConfigFiles({ env })): Candidate {
  const m = c.manifest as { name?: unknown; config?: unknown } | undefined;
  if (!m || typeof m.name !== "string") return c;
  const s = pluginSettings(m as { name: string; config?: unknown }, { env, files });
  const config = mergePatch(c.config ?? {}, s.config) as Record<string, unknown>;
  return { ...c, ...(Object.keys(config).length ? { config } : {}), ...(s.enabled !== undefined ? { enabled: s.enabled } : {}), ...(s.errors.length ? { configErrors: s.errors } : {}) };
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
 * `jobs`: the daemon's host, whose plugins get `ctx.jobs` (§16.2), `ctx.agents` (§8.4, src/plugins/services.ts) and
 * `ctx.storage` (§8.4; one process writes a plugin's storage): a CLI's local host has none of them, `unsupported`.
 * `triggers`: they get `ctx.triggers` too (§16.3; the daemon's only). `process`: the plugin socket out-of-process
 * plugins connect to (§9.2); without it they stay `validated` (a CLI's local host).
 */
export function kernelHost(o: { record?: DaemonEventSink; snapshot?: string | null; log?: boolean; run?: RunEventSink; jobs?: boolean; triggers?: boolean; process?: { socket: string; timings?: ProcessTimings } } = {}): PluginHost {
  const redactor = new Redactor();
  const record = (e: { type: string; stream: string; entity: string; text: string; data: Record<string, unknown> }) => {
    if (e.stream !== "daemon") throw new PluginError("unsupported", `the host writes its own events on the daemon stream only (${e.type})`);
    return o.record?.({ type: e.type, entity: e.entity, text: e.text, data: e.data }) ?? { seq: 0 };
  };
  const pluginEvent = pluginEventWriter({ ...(o.record ? { daemon: o.record } : {}), ...(o.run ? { run: o.run } : {}) });
  const dataDir = pluginDataDir;
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
    ...(o.jobs || o.triggers ? { services: (m) => ({
      ...(o.jobs ? { jobs: pluginJobs(m.name), agents: pluginAgents(m.name), storage: storageService(pluginStore(m.name, dataDir(m.name))) } : {}),
      ...(o.triggers ? { triggers: pluginTriggers(m.name, m.scopes ?? []) } : {}),
    }) } : {}),
    secret: async (m, key) => resolveSecret(m, key),
    sinks: { redact: (t) => redactor.text(t), log, emit: pluginEvent },
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
