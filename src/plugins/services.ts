// The kernel's primitives for a plugin in the daemon (docs/spec/plugin-api.md §8.1), beyond `ctx.jobs`
// (src/jobs/service.ts): `ctx.agents` (`get`, `tree`, `cancel`, `notice`) and `ctx.storage` at daemon scope. Each is
// the kernel's own path (src/primitives/ops.ts, the scope actor), with the plugin as the caller; the host has already
// checked the plugin's scopes (packages/plugin/src/host/context.ts). Errors reach the plugin as PluginErrors (§8.3).
// What isn't here (`agents.spawn`, `await`, `grant`, `title`, storage at run scope, …) answers `unsupported` until a
// later step implements it.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { AgentsService, StorageService } from "../../packages/plugin/src/context";
import { PluginError } from "../../packages/plugin/src/errors";
import type { ScopeAgent } from "../actors/scope";
import { RelayError } from "../core/errors";
import { stateDir } from "../utils/home";
import { agentOf } from "./shapes";

/** A kernel error as a plugin sees it (§8.3). */
export function asPluginError(e: unknown): never {
  if (e instanceof PluginError) throw e;
  if (e instanceof RelayError) {
    const code = e.reason === "unsupported" ? "unsupported" : e.code === "usage" || e.code === "config" ? "invalid" : e.code === "not_found" ? "not_found" : e.code === "engine_unreachable" ? "unavailable" : e.reason === "forbidden" ? "forbidden" : "conflict";
    throw new PluginError(code, e.message, e.hint, code === "unavailable");
  }
  throw e;
}

const RUN_ID = /^run-[A-Za-z0-9_-]+$/;
const AGENT_ID = /^agt-[A-Za-z0-9_-]+$/;
/** Notice kinds only plugins raise (§8.4): the kernel raises `idle`, `spinning`, `failing`, `quota` (and its own
 *  `sandbox_outage`); a plugin may raise these and clear only these. */
export const PLUGIN_NOTICES: ReadonlySet<string> = new Set(["stalled"]);

/** The run's scope, when the run exists: a plugin's call never creates one. */
async function scopeOf(runId: string) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new PluginError("invalid", `not a run id: ${String(runId).slice(0, 80)}`);
  const { existingActor } = await import("../core/relay");
  const s = await existingActor("scope", [runId]).catch((e) => { throw new PluginError("unavailable", `the engine didn't answer: ${(e as Error)?.message ?? e}`, undefined, true); });
  if (!s) throw new PluginError("not_found", `no run ${runId}`);
  return s;
}

async function agentRecord(runId: string, agentId: string) {
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) throw new PluginError("invalid", `not an agent id: ${String(agentId).slice(0, 80)}`);
  const a = await (await scopeOf(runId)).getAgent({ agentId });
  if (!a) throw new PluginError("not_found", `agent ${agentId} not found in ${runId}`);
  return a;
}

/** `ctx.agents` for one plugin (§8.1, §8.4). */
export function pluginAgents(plugin: string): Partial<AgentsService> {
  return {
    get: async (runId, agentId) => agentOf(await agentRecord(runId, agentId)),
    async tree(runId, root) {
      const all = await (await scopeOf(runId)).listAgents({});
      if (!root) return all.map(agentOf);
      const keep = new Set([root]);
      // Parents come before their children in spawn order; one more pass covers any that don't.
      for (let grew = true; grew;) { grew = false; for (const a of all as ScopeAgent[]) if (a.parent && keep.has(a.parent) && !keep.has(a.agentId)) { keep.add(a.agentId); grew = true; } }
      if (!(all as ScopeAgent[]).some((a) => a.agentId === root)) throw new PluginError("not_found", `agent ${root} not found in ${runId}`);
      return (all as ScopeAgent[]).filter((a) => keep.has(a.agentId)).map(agentOf);
    },
    /** Cancels the agent and its descendants, as `capcomd cancel` does, saying which plugin did and why. */
    async cancel(runId, agentId, reason) {
      await agentRecord(runId, agentId);
      const why = String(reason ?? "").trim().slice(0, 300) || "no reason given";
      const { cancelAgents } = await import("../primitives/ops");
      await cancelAgents(runId, agentId, `by the ${plugin} plugin: ${why}`, `plugin:${plugin}`).catch(asPluginError);
    },
    /** Raises a plugin's kind of notice on a running agent, or clears one (null): never one the kernel raised. */
    async notice(runId, agentId, notice) {
      await agentRecord(runId, agentId);
      if (notice !== null && (typeof notice !== "object" || !PLUGIN_NOTICES.has(notice.kind)))
        throw new PluginError("forbidden", `a plugin raises only ${[...PLUGIN_NOTICES].join(", ")} notices; ${String((notice as { kind?: unknown } | null)?.kind)} is the kernel's (§8.4)`);
      const s = await scopeOf(runId);
      if (notice === null) {
        for (const kind of PLUGIN_NOTICES) await s.notice({ agentId, notice: null, only: kind });
        return;
      }
      const detail = String(notice.detail ?? "").trim();
      if (!detail) throw new PluginError("invalid", "a notice says what is wrong (detail)");
      await s.notice({ agentId, notice: { kind: notice.kind, detail: detail.slice(0, 300) } });
    },
  };
}

// ---- storage --------------------------------------------------------------------------------------------------------

const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/;
const VALUE_MAX = 64 * 1024;

/** `ctx.storage` at daemon scope for one plugin (§8.4): a JSON file per key under `<state>/plugins/<name>/storage/`.
 *  Run scope (kv `plugin/<name>/` on the run) is not here yet: `unsupported`. */
export function pluginStorage(plugin: string, root = () => join(stateDir(), "plugins", plugin, "storage")): StorageService {
  const daemon = (scope: unknown) => {
    if (scope === "daemon") return;
    throw new PluginError("unsupported", "storage at run scope is not available to plugins yet: use daemon scope");
  };
  const pathOf = (key: string) => {
    if (typeof key !== "string" || !KEY.test(key) || key.split("/").some((p) => p === "" || p === "." || p === "..")) throw new PluginError("invalid", `not a storage key: ${String(key).slice(0, 80)} (letters, digits, . _ / -; no empty, . or .. parts)`);
    return join(root(), `${key}.json`);
  };
  const read = (key: string): unknown | undefined => {
    const p = pathOf(key);
    if (!existsSync(p)) return undefined;
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; }
  };
  const write = (key: string, value: unknown) => {
    const text = JSON.stringify(value);
    if (text === undefined) throw new PluginError("invalid", "a stored value is JSON (not undefined or a function)");
    if (Buffer.byteLength(text) > VALUE_MAX) throw new PluginError("invalid", "a stored value is at most 64 KB");
    const p = pathOf(key);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, p);
  };
  // Every call is synchronous inside: one daemon, one process, so a cas compares and writes with nothing in between.
  return {
    async get(scope, key) { daemon(scope); return read(key); },
    async put(scope, key, value) { daemon(scope); write(key, value); },
    async cas(scope, key, expect, value) {
      daemon(scope);
      const cur = read(key);
      if (JSON.stringify(cur) !== JSON.stringify(expect)) return false;
      write(key, value);
      return true;
    },
    async delete(scope, key) { daemon(scope); rmSync(pathOf(key), { force: true }); },
    async list(scope, prefix) {
      daemon(scope);
      const base = root();
      if (!existsSync(base)) return [];
      const out: string[] = [];
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else if (f.endsWith(".json")) out.push(relative(base, p).slice(0, -".json".length).split("\\").join("/"));
        }
      };
      walk(base);
      return out.filter((k) => k.startsWith(prefix ?? "")).sort();
    },
  };
}
