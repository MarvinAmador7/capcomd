// The blocks of a profile that change where and with what its agents run, beyond the flat v1 spec (ADR-024 §7 step 8):
// `tools.mcp` (MCP servers the agent's CLI gets, run in its sandbox), `sandbox.provider|environment|size` (the sandbox
// its machine is made on, the environment it boots from, its size) and `lifecycle.onStart|onEnd` (plugins that must be
// active for it, which hear its `agent.changed`). Read from the resolved manifest, checked with it, and pinned on the
// agent at spawn beside the flat spec (src/primitives/ops.ts `spawnAgent`), so whoever runs it runs what was resolved.
// They aren't flat fields: no `--set`, `--overrides` or `profile.resolved` patch reaches them (a parent can't add an MCP
// server to its child, or move it to another sandbox), and agents.json (v1) has none of them.
import { NAME, type AgentSpec } from "./v1";
import type { ProfileDoc } from "./v2";

/** One `tools.mcp` entry: a server the agent's CLI starts in its sandbox (never on the host, ADR-017 §1). `trusted`:
 *  its tools are approved up front, as capcomd's own are; `untrusted` (the default): the profile's tool rules decide. */
export interface McpServer { name: string; command: string[]; trust: "trusted" | "untrusted" }
export type MachineSize = { vcpu: 1 | 2 | 4 | 8 };
export interface Lifecycle { onStart: string[]; onEnd: string[] }
/** What an agent is pinned with besides the flat spec; each key only when its profile sets it. */
export interface ProfileRuntime {
  mcp?: McpServer[];
  /** A sandbox plugin's name: its machine is made there instead of on the run's (or the daemon's) sandbox. */
  sandboxProvider?: string;
  /** The environment its machine boots from on that sandbox: `default`, `image` or a build's name (src/env/resolve.ts). */
  environment?: string;
  size?: MachineSize;
  lifecycle?: Lifecycle;
}
/** The pinned spec's keys for them (packages/plugin/src/shapes.ts PinnedSpec). */
export const RUNTIME_KEYS = ["mcp", "sandboxProvider", "environment", "size", "lifecycle"] as const;

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const block = (doc: ProfileDoc, b: string): Record<string, unknown> => (isMap(doc[b]) ? (doc[b] as Record<string, unknown>) : {});
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
const SIZES = [1, 2, 4, 8];

/** The runtime blocks of a resolved manifest (checked by ./v2.ts checkManifest); empty lists and unset values left out. */
export function runtimeOf(doc: ProfileDoc): ProfileRuntime {
  const out: ProfileRuntime = {};
  const t = block(doc, "tools"), sb = block(doc, "sandbox"), l = block(doc, "lifecycle");
  const mcp = Array.isArray(t.mcp) ? t.mcp.filter(isMap).map((m): McpServer => ({ name: String(m.name), command: names(m.command), trust: m.trust === "trusted" ? "trusted" : "untrusted" })) : [];
  if (mcp.length) out.mcp = mcp;
  if (typeof sb.provider === "string") out.sandboxProvider = sb.provider;
  if (typeof sb.environment === "string") out.environment = sb.environment;
  if (isMap(sb.size) && SIZES.includes(sb.size.vcpu as number)) out.size = { vcpu: sb.size.vcpu as MachineSize["vcpu"] };
  const onStart = names(l.onStart), onEnd = names(l.onEnd);
  if (onStart.length || onEnd.length) out.lifecycle = { onStart, onEnd };
  return out;
}

/**
 * What a resolved profile can't run with, as `profiles.<name>: <path>: …`: an orchestrate agent gets no MCP server (it
 * runs nothing, plugin API §16.1, and a server is a program its sandbox runs: give the servers to the agents it spawns),
 * and `capcomd` is capcomd's own server's name.
 */
export function runtimeProblems(name: string, rt: ProfileRuntime, spec: Pick<AgentSpec, "toolMode">): string[] {
  const e: string[] = [];
  if (rt.mcp?.length && spec.toolMode === "orchestrate")
    e.push(`profiles.${name}: tools.mcp: an orchestrate agent runs nothing, and an MCP server is a program its sandbox runs; give the servers to the profiles it spawns`);
  if (rt.mcp?.some((s) => s.name === "capcomd")) e.push(`profiles.${name}: tools.mcp: capcomd is the name of capcomd's own server (every agent that may spawn has it); name yours otherwise`);
  return e;
}

/** The runtime blocks an agent was pinned with (its spec as recorded at spawn), read defensively: a record from before
 *  them, or with a value this capcomd doesn't know, gives what it can read and nothing else (and no server that would
 *  take capcomd's own name). */
export function pinnedRuntime(spec: unknown): ProfileRuntime {
  if (!isMap(spec)) return {};
  const out: ProfileRuntime = {};
  if (Array.isArray(spec.mcp)) {
    const mcp = spec.mcp.filter((m): m is Record<string, unknown> => isMap(m) && typeof m.name === "string" && NAME.test(m.name) && m.name !== "capcomd" && names(m.command).length > 0 && names(m.command).length === (m.command as unknown[]).length)
      .map((m): McpServer => ({ name: m.name as string, command: names(m.command), trust: m.trust === "trusted" ? "trusted" : "untrusted" }));
    if (mcp.length) out.mcp = mcp;
  }
  if (typeof spec.sandboxProvider === "string" && NAME.test(spec.sandboxProvider)) out.sandboxProvider = spec.sandboxProvider;
  if (typeof spec.environment === "string" && NAME.test(spec.environment)) out.environment = spec.environment;
  if (isMap(spec.size) && SIZES.includes(spec.size.vcpu as number)) out.size = { vcpu: spec.size.vcpu as MachineSize["vcpu"] };
  if (isMap(spec.lifecycle)) {
    const onStart = names(spec.lifecycle.onStart), onEnd = names(spec.lifecycle.onEnd);
    if (onStart.length || onEnd.length) out.lifecycle = { onStart, onEnd };
  }
  return out;
}

/** What an agent's profile pinned for its machine (`sandbox.provider|environment|size`), as the worker that makes the
 *  machine takes it (src/actors/worker.ts provisionWorker, pushBranch): every agent's, a scripted one's too. */
export type ProfileMachine = { sandbox?: string; environment?: string; size?: MachineSize };
export function pinnedMachine(spec: unknown): ProfileMachine {
  const r = pinnedRuntime(spec);
  return { ...(r.sandboxProvider ? { sandbox: r.sandboxProvider } : {}), ...(r.environment ? { environment: r.environment } : {}), ...(r.size ? { size: r.size } : {}) };
}

/** Every plugin a lifecycle names, once each, onStart's first. */
export const lifecyclePlugins = (l: Lifecycle | undefined): string[] => [...new Set([...(l?.onStart ?? []), ...(l?.onEnd ?? [])])];
