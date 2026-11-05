// The kernel's plugin host (ADR-023 step 1; docs/spec/plugin-api.md §5, §6, §13): packages/plugin's host with what only
// the kernel knows: the running version, the kernel's feature flags, where plugin data lives, the redactor, and where
// the host's events go (the daemon stream, `harnessState().recordDaemonEvent`; a gate's on the run's). `capcomd serve`
// starts it after the actors answer and before the harness.v1 socket opens (§5.5); the kernel fires its hooks through
// its registry (src/plugins/hooks.ts). Another process that runs a gate starts a local one with the built-in gates.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PluginHost, type Candidate, type PluginSummary } from "../../packages/plugin/src/host/host";
import { PluginError } from "../../packages/plugin/src/errors";
import type { HookRegistry } from "../../packages/plugin/src/host/registry";
import { CAPABILITY_NAMES } from "../api/contract";
import { Redactor } from "../agents/redact";
import { stateDir } from "../utils/home";
import { VERSION } from "../utils/self";
import { BUILTINS } from "./builtins";
import { recordGateEvent } from "./hooks";
import { resolveSecret } from "./secrets";

/** A durable daemon-stream event (`harnessState().recordDaemonEvent`). */
export type DaemonEventSink = (e: { type: string; entity: string; text: string; data: Record<string, unknown> }) => { seq: number };

/** What the daemon discovers (§4.8). Built-ins only in this version: user and project plugins arrive with the
 *  out-of-process runtime and `capcomd plugins install|trust` (§17.2 steps 9 and 12). */
export function builtinCandidates(env: Record<string, string | undefined> = process.env): Candidate[] {
  return [...BUILTINS.map((b) => ({ source: "builtin" as const, manifest: b.manifest, module: b.module })), ...testPlugins(env)];
}

/** Tests only (`bun test` sets NODE_ENV=test): CAPCOMD_TEST_PLUGINS, `:`-separated plugin directories, load in process
 *  like built-ins, so a scenario's daemon can carry a recording plugin (tests/scenarios/hooks-order.test.ts). */
function testPlugins(env: Record<string, string | undefined>): Candidate[] {
  if (env.NODE_ENV !== "test" || !env.CAPCOMD_TEST_PLUGINS) return [];
  return env.CAPCOMD_TEST_PLUGINS.split(":").filter(Boolean).map((dir) => ({ source: "builtin" as const, dir }));
}

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

export function kernelHost(o: { record?: DaemonEventSink; snapshot?: string | null; log?: boolean } = {}): PluginHost {
  const redactor = new Redactor();
  const record = (e: { type: string; stream: string; entity: string; text: string; data: Record<string, unknown> }) => {
    if (e.stream !== "daemon") throw new PluginError("unsupported", `a plugin's own events on run streams are not written yet (${e.type})`);
    return o.record?.({ type: e.type, entity: e.entity, text: e.text, data: e.data }) ?? { seq: 0 };
  };
  return new PluginHost({
    capcomd: VERSION,
    kernel: CAPABILITY_NAMES.map((n) => `kernel:${n}`),
    emit: (e) => {
      // A gate's audit goes on the run's stream (§13.1), from whichever process ran the gate.
      if (e.type === "plugin.gate_denied" && e.stream !== "daemon") {
        void recordGateEvent(e.stream, { type: e.type, data: e.data }).catch((err) => console.error(`[plugins] ${e.stream}: recording ${e.type}: ${(err as Error)?.message ?? err}`));
        return;
      }
      try { record(e); } catch { /* not a daemon-stream event */ }
    },
    dataDir: (name) => join(stateDir(), "plugins", name),
    secret: async (m, key) => resolveSecret(m, key),
    sinks: {
      redact: (t) => redactor.text(t),
      // §13.3: one JSON line per log call in the daemon's log, never an event. A CLI's local host keeps its output clean.
      log: (l) => { if (o.log !== false) console.log(JSON.stringify({ plugin: l.plugin, level: l.level, message: l.message, fields: l.fields })); },
      emit: async (e) => record({ ...e, entity: e.entity || `plugin:${e.type}` }),
    },
    ...(o.snapshot ? { onChange: (plugins: PluginSummary[]) => writeSnapshot(o.snapshot!, plugins) } : {}),
  });
}

/**
 * The gates of a process that isn't the daemon (src/plugins/hooks.ts `gates`): the built-ins marked `everyProcess`
 * (the reviewer gate), and in tests CAPCOMD_TEST_PLUGINS, in a host of its own. It writes no daemon-stream events (that
 * stream is the daemon's) and no listing; its gate events go on the run's stream like the daemon's.
 */
export async function localHost(env: Record<string, string | undefined> = process.env): Promise<HookRegistry> {
  const host = kernelHost({ log: false });
  await host.start([...BUILTINS.filter((b) => b.everyProcess).map((b) => ({ source: "builtin" as const, manifest: b.manifest, module: b.module })), ...testPlugins(env)]);
  return host.hooks;
}
