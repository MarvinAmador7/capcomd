// The test kit (spec §14): what `@capcomd/plugin/testkit` will ship. Interfaces only; the conformance suite's
// behaviour is normative in §14 and the implementation lands with ADR-023 step 1.
import type { PluginContext, PluginModule } from "./context";
import type { HookCall, HookName, HookPayload, HookResult } from "./hooks";
import type { PluginManifest } from "./manifest";
import type { AgentProvider, Forge, SandboxProvider } from "./seams";
import type { Principal } from "./shapes";

/** A recorded registration, so a test can assert that disposing the plugin removed every one (§14.1). */
export type Registration =
  | { kind: "hook"; hook: HookName } | { kind: "seam"; seam: "sandbox" | "agent" | "forge"; name: string }
  | { kind: "cli"; name: string } | { kind: "mcp"; name: string } | { kind: "api"; method: string; path: string }
  | { kind: "ui"; id: string } | { kind: "capability"; name: string } | { kind: "subscription"; stream: string } | { kind: "onDispose" };

/** An in-memory context: every service answers from fixtures the test sets; every registration is recorded. */
export interface FakeContext<C = Record<string, unknown>> {
  ctx: PluginContext<C>;
  registrations(): Registration[];
  /** Fire a hook at the plugin's listener as the host would: builds the HookCall, applies the deadline, validates the result. */
  fire<N extends HookName>(hook: N, payload: HookPayload<N>, opts?: { principal?: Principal; runId?: string; agentId?: string; timeoutMs?: number }): Promise<{ result: HookResult<N> | undefined; failure: { kind: string; message: string } | null; ms: number }>;
  /** Everything the plugin emitted, logged and traced. */
  emitted(): Array<{ type: string; stream: string; data: Record<string, unknown> }>;
  logs(): Array<{ level: string; message: string; fields: Record<string, unknown> }>;
  /** Dispose the plugin and return what was still registered afterwards (must be empty). */
  dispose(): Promise<Registration[]>;
}

export interface TestKit {
  /** Parse and validate a manifest from a plugin directory, as `capcomd plugins validate` does (§4.9). */
  validateManifest(dir: string): Promise<{ ok: true; manifest: PluginManifest } | { ok: false; issues: Array<{ path: string; message: string }> }>;
  /** Build a fake context for `manifest` with `config`; `activate` is not called until `load`. */
  fakeContext<C>(manifest: PluginManifest, config?: C): FakeContext<C>;
  /** Load the module into the fake context: `activate`, the manifest-vs-code check (§4.7), the activate deadline. */
  load<C>(fake: FakeContext<C>, module: PluginModule<C>): Promise<void>;
  /** §14.1: load, assert registrations ⊆ manifest, dispose, assert nothing remains. */
  loadDispose<C>(manifest: PluginManifest, module: PluginModule<C>, config?: C): Promise<void>;
  /** §14.3: boot a daemon on the fake sandbox with these plugins (and the built-ins) through the host, run `fn`
   *  against its harness.v1 socket, stop it. Mocks only the agents (`CAPCOMD_SPAWN_EXEC=script`). */
  bootWith(plugins: Array<{ dir: string } | { manifest: PluginManifest; module: PluginModule }>, fn: (daemon: { socket: string; token: string; stop(): Promise<void> }) => Promise<void>): Promise<void>;
  /** §14.4: fire each declared hook with a generated payload and check the result's shape, the deadline and idempotency. */
  hookContract<C>(manifest: PluginManifest, module: PluginModule<C>, config?: C): Promise<void>;
  /** §14.2: the seam conformance suites. */
  conformance: {
    sandbox(make: () => SandboxProvider, opts?: { skipSnapshots?: boolean }): void;
    agent(make: () => AgentProvider, fixtures: { streams: string[] }): void;
    forge(make: () => Forge, fixtureRepo: string): void;
  };
  /** A HookCall for a unit test of a listener, with a real AbortSignal and a deadline `timeoutMs` ahead. */
  call<N extends HookName>(hook: N, payload: HookPayload<N>, opts?: { timeoutMs?: number; principal?: Principal }): HookCall<N>;
}
