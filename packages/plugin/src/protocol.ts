// The out-of-process protocol (spec §9): a third-party plugin is a process the host starts, which connects to the
// harness.v1 socket as a client. These are the wire shapes; openapi/drafts/plugin-api.fragment.json is the OpenAPI.
import type { HookCall, HookName, HookResult } from "./hooks";
import type { PluginScope } from "./manifest";

export const PLUGIN_PROTOCOL_VERSION = 1 as const;

/** Environment the host sets for the process (§9.2). Nothing else of capcomd's reaches it. */
export interface ProcessEnvironment {
  CAPCOMD_PLUGIN_NAME: string;
  CAPCOMD_PLUGIN_ROOT: string;
  CAPCOMD_PLUGIN_DATA: string;
  CAPCOMD_PLUGIN_SOCKET: string;
  /** The session this process must present; a new one per start. */
  CAPCOMD_PLUGIN_SESSION: string;
  /** The minted client token (`cch_…`), scopes = the manifest's plus the plugin's own routes (§9.3). */
  CAPCOMD_PLUGIN_TOKEN: string;
  CAPCOMD_PLUGIN_PROTOCOL: "1";
}

/** POST /v1/plugins/{name}/sessions (§9.3). */
export interface SessionOpen {
  session: string;
  protocol: typeof PLUGIN_PROTOCOL_VERSION;
  /** sha256 of the manifest the process was started from; a mismatch is 409 `conflict`. */
  manifestHash: string;
  pid: number;
  /** The hooks this process will answer; must equal `contributes.hooks` (422 otherwise). */
  hooks: HookName[];
}
export interface SessionOpened {
  session: string;
  protocol: typeof PLUGIN_PROTOCOL_VERSION;
  plugin: { name: string; version: string; scopes: PluginScope[] };
  /** The layered, validated config without secret properties (§10.2). */
  config: Record<string, unknown>;
  /** Secret properties' values, once, over the 0600 socket (§10.3). Never logged. */
  secrets: Record<string, string>;
  /** Per hook, the deadline the host will apply, in ms. */
  hookTimeoutsMs: Partial<Record<HookName, number>>;
  /** How long the host waits for the hooks stream before treating the plugin as disconnected (§9.5). */
  connectWithinMs: number;
  /** The daemon's capabilities and version, for feature detection. */
  daemon: { version: string; capabilities: string[] };
}

/** The wire form of HookCall: no AbortSignal (the deadline is the signal). */
export type WireHookCall<N extends HookName = HookName> = Omit<HookCall<N>, "signal">;

/** Frames on GET /v1/plugins/{name}/hooks (SSE; `event:` is the frame's `frame` field, `id:` is `seq`) (§9.4). */
export type HookFrame =
  | { frame: "hook.call"; seq: number; call: WireHookCall }
  /** Observe frames the host dropped because the plugin's buffer was full (§9.5). Gate calls are never dropped. */
  | { frame: "hook.dropped"; seq: number; count: number; hooks: HookName[] }
  /** The host is stopping; answer open calls, then exit (§9.7). */
  | { frame: "session.closing"; seq: number; reason: "daemon_stopping" | "disabled" | "replaced" };

/** POST /v1/plugins/{name}/hooks/{callId} (§9.4). Observe calls take no answer; answering one is 204 anyway. */
export interface HookAnswer<N extends HookName = HookName> {
  session: string;
  result: HookResult<N>;
}

/** POST /v1/plugins/{name}/events (§9.6): `ctx.events.emit` over the wire. */
export interface EmitBody { type: string; stream: string; entity: string; text: string; data: Record<string, unknown>; durability?: "durable" | "ephemeral" }

/** GET/PUT/DELETE /v1/plugins/{name}/storage/{key} and GET /v1/plugins/{name}/storage (§9.6). */
export interface StoragePutBody { value: unknown; /** For a compare-and-swap: the JSON text of the expected current value, or null for "must not exist". */ expect?: string | null }
export interface StorageEntry { key: string; value: unknown; rev: string }

/** GET /v1/plugins and GET /v1/plugins/{name} (§13.2). */
export interface PluginSummary {
  name: string;
  version: string;
  apiVersion: 1;
  runtime: "in-process" | "process";
  source: "builtin" | "user" | "project";
  state: "discovered" | "validated" | "resolved" | "loading" | "active" | "disposing" | "disposed" | "failed";
  enabled: boolean;
  cause: string | null;
  hooks: HookName[];
  seams: Array<{ kind: "sandbox" | "agent" | "forge"; name: string }>;
  hooksSuspended: boolean;
  stats: { calls: number; failures: number; p50Ms: number | null; p95Ms: number | null; lastFailureAt: string | null };
}

/** How a plugin's runtime talks to the host, as an interface a client library implements (§9.8). The Slack example
 *  codes against this; no implementation ships yet. */
export interface PluginClient {
  open(body: SessionOpen): Promise<SessionOpened>;
  /** Yields frames in order; resumes from the last `seq` on reconnect. Ends when the session closes. */
  hooks(signal: AbortSignal): AsyncIterable<HookFrame>;
  answer<N extends HookName>(callId: string, answer: HookAnswer<N>): Promise<void>;
  emit(body: EmitBody): Promise<{ seq: number }>;
  storage: { get(key: string): Promise<StorageEntry | null>; put(key: string, body: StoragePutBody): Promise<StorageEntry>; delete(key: string): Promise<void>; list(prefix: string): Promise<StorageEntry[]> };
  /** Any other harness.v1 route, with the plugin's token (§9.6). */
  fetch(path: string, init?: { method?: string; body?: unknown; idempotencyKey?: string }): Promise<Response>;
}
