// The kernel's plugin host (ADR-023 step 1; docs/spec/plugin-api.md §5, §6, §13): packages/plugin's host with what only
// the kernel knows: the running version, the kernel's feature flags, where plugin data lives, the redactor, and where
// the host's events go (the daemon stream, `harnessState().recordDaemonEvent`). `capcomd serve` starts it after the
// actors answer and before the harness.v1 socket opens (§5.5); the kernel fires no hooks yet (§17.2 step 2).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PluginHost, type Candidate, type PluginSummary } from "../../packages/plugin/src/host/host";
import { PluginError } from "../../packages/plugin/src/errors";
import { CAPABILITY_NAMES } from "../api/contract";
import { Redactor } from "../agents/redact";
import { stateDir } from "../utils/home";
import { VERSION } from "../utils/self";
import { BUILTINS } from "./builtins";

/** A durable daemon-stream event (`harnessState().recordDaemonEvent`). */
export type DaemonEventSink = (e: { type: string; entity: string; text: string; data: Record<string, unknown> }) => { seq: number };

/** What the daemon discovers (§4.8). Built-ins only in this version: user and project plugins arrive with the
 *  out-of-process runtime and `capcomd plugins install|trust` (§17.2 steps 9 and 12). */
export function builtinCandidates(): Candidate[] {
  return BUILTINS.map((b) => ({ source: "builtin" as const, manifest: b.manifest, module: b.module }));
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

export function kernelHost(o: { record?: DaemonEventSink; snapshot?: string | null } = {}): PluginHost {
  const redactor = new Redactor();
  const record = (e: { type: string; stream: string; entity: string; text: string; data: Record<string, unknown> }) => {
    // Run streams (plugin.gate_denied, a plugin's own run events) are written by the kernel's hook sites (§17.2 step 2).
    if (e.stream !== "daemon") throw new PluginError("unsupported", `events on run streams are not written yet (${e.type})`);
    return o.record?.({ type: e.type, entity: e.entity, text: e.text, data: e.data }) ?? { seq: 0 };
  };
  return new PluginHost({
    capcomd: VERSION,
    kernel: CAPABILITY_NAMES.map((n) => `kernel:${n}`),
    emit: (e) => { try { record(e); } catch { /* a run-stream host event before step 2: nothing fires one */ } },
    dataDir: (name) => join(stateDir(), "plugins", name),
    sinks: {
      redact: (t) => redactor.text(t),
      // §13.3: one JSON line per log call in the daemon's log, never an event.
      log: (l) => console.log(JSON.stringify({ plugin: l.plugin, level: l.level, message: l.message, fields: l.fields })),
      emit: async (e) => record({ ...e, entity: e.entity || `plugin:${e.type}` }),
    },
    ...(o.snapshot ? { onChange: (plugins: PluginSummary[]) => writeSnapshot(o.snapshot!, plugins) } : {}),
  });
}
