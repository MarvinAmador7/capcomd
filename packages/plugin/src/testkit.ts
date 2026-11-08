// The test kit (spec §14.5): `@capcomd/plugin/testkit`. The fake context is the host's own context (host/context.ts)
// over an in-memory hook registry, so a plugin is held to the same manifest, scope and dispatch rules it meets in the
// daemon. `bootWith` (./boot.ts) boots a real daemon with the plugin, through the capcomd the test names. The sandbox
// suite is ./conformance.ts, the agent suite ./agent-conformance.ts, the context suite ./context-conformance.ts; the
// forge suite isn't in the kit: only built-ins are forges (the kernel tests them in tests/plugins/forges.test.ts).
import { PluginError } from "./errors";
import { HOOKS, type HookCall, type HookName, type HookPayload, type HookResult, type JobChange } from "./hooks";
import { readManifest } from "./load";
import type { HarnessEventEnvelope, PluginContext, PluginModule } from "./context";
import type { PluginManifest } from "./manifest";
import type { AgentProvider, Forge, SandboxProvider } from "./seams";
import type { Agent, Approval, Job, Merge, PinnedSpec, Principal, Run, Trigger, Untrusted, Verification } from "./shapes";
import { ContributionStore, createContext, type ContextOptions, type PluginRuntime } from "./host/context";
import { configDefaults } from "./host/host";
import { HookRegistry, type HostEvent } from "./host/registry";
import { sandboxCases, type SandboxConformanceOptions } from "./conformance";
import { agentCases, type AgentConformanceOptions } from "./agent-conformance";
import { contextCases, type ContextConformanceOptions } from "./context-conformance";
import type { ContextProvider } from "./context-layer";
import { bootWith, type BootedDaemon, type BootOptions } from "./boot";

export type { BootedDaemon, BootOptions } from "./boot";

/** A recorded registration, so a test can assert that disposing the plugin removed every one (§14.1). */
export type Registration =
  | { kind: "hook"; hook: HookName } | { kind: "seam"; seam: "sandbox" | "agent" | "forge"; name: string } | { kind: "context"; name: string }
  | { kind: "cli"; name: string } | { kind: "mcp"; name: string } | { kind: "api"; method: string; path: string }
  | { kind: "ui"; id: string } | { kind: "capability"; name: string } | { kind: "subscription"; stream: string } | { kind: "instructions" } | { kind: "onDispose" };

/** An in-memory context: every service answers from fixtures the test sets; every registration is recorded. */
export interface FakeContext<C = Record<string, unknown>> {
  ctx: PluginContext<C>;
  registrations(): Registration[];
  /** Fire a hook at the plugin's listener as the host would: builds the HookCall, applies the deadline, validates the result. */
  fire<N extends HookName>(hook: N, payload: HookPayload<N>, opts?: { principal?: Principal; runId?: string; agentId?: string; timeoutMs?: number }): Promise<{ result: HookResult<N> | undefined; failure: { kind: string; message: string } | null; ms: number }>;
  /** Everything the plugin emitted, logged and traced. */
  emitted(): Array<{ type: string; stream: string; data: Record<string, unknown> }>;
  logs(): Array<{ level: string; message: string; fields: Record<string, unknown> }>;
  /** Put an event on its stream (`event.scope`: `daemon` or a run id) as the daemon would (§8.4): every subscription of
   *  the plugin to that stream whose filter matches gets it, one at a time, in the order published; `ctx.events.replay`
   *  returns it afterwards. Resolves once the handlers have run (one that throws is logged and skipped). */
  publish(event: HarnessEventEnvelope): Promise<void>;
  /** Dispose the plugin and return what was still registered afterwards (must be empty). */
  dispose(): Promise<Registration[]>;
  /** The seam implementation the plugin registered for `kind`, if any (what the conformance suites run against). */
  seam<K extends "sandbox" | "agent" | "forge">(kind: K): (K extends "sandbox" ? SandboxProvider : K extends "agent" ? AgentProvider : Forge) | undefined;
  /** The context provider the plugin registered under `name` (ADR-025 §3.1), if any. */
  contextProvider(name: string): ContextProvider | undefined;
}

export interface TestKit {
  /** Parse and validate a manifest from a plugin directory, as `capcomd plugins validate` does (§4.9). The `engines`
   *  check runs when `capcomd` names the version to check against. */
  validateManifest(dir: string, opts?: { capcomd?: string }): Promise<{ ok: true; manifest: PluginManifest } | { ok: false; issues: Array<{ path: string; message: string }> }>;
  /** Build a fake context for `manifest` with `config` (over the schema's defaults); `activate` is not called until
   *  `load`. `services` are the primitives' fixtures; one the test doesn't set rejects `unsupported`. */
  fakeContext<C>(manifest: PluginManifest, config?: C, opts?: { services?: ContextOptions<C>["services"]; dir?: string }): FakeContext<C>;
  /** Load the module into the fake context: `activate`, the manifest-vs-code check (§4.7), the activate deadline. */
  load<C>(fake: FakeContext<C>, module: PluginModule<C>): Promise<void>;
  /** §14.1: load, assert registrations ⊆ manifest, dispose, assert nothing remains. */
  loadDispose<C>(manifest: PluginManifest, module: PluginModule<C>, config?: C): Promise<void>;
  /** §14.3: boot a daemon (`capcomd serve`, the capcomd `opts.capcomd` names) in a home of its own, on the fake sandbox
   *  with scripted agents (`CAPCOMD_SPAWN_EXEC=script`), with these plugin directories as the user's plugins (and the
   *  built-ins); wait until each is `active`, run `fn` against its harness.v1 socket and CLI, stop it, remove the home.
   *  Mocks only the agents. A plugin runs as the daemon runs it: an out-of-process one is started, handshakes and gets
   *  its hooks over the plugin socket (§9). */
  bootWith(plugins: Array<{ dir: string }>, fn: (daemon: BootedDaemon) => Promise<void>, opts?: BootOptions): Promise<void>;
  /** §14.4: fire each declared hook with a generated payload and check the result's shape, the deadline and idempotency. */
  hookContract<C>(manifest: PluginManifest, module: PluginModule<C>, config?: C): Promise<void>;
  /** §14.2: the seam conformance suites. */
  conformance: {
    sandbox(make: () => SandboxProvider, opts?: SandboxConformanceOptions): void;
    agent(make: () => AgentProvider, fixtures?: AgentConformanceOptions): void;
    /** Not in the kit: throws `unsupported` (forges are built-ins; the kernel tests them, §14.2). */
    forge(make: () => Forge, fixtureRepo: string): void;
    /** ADR-025 §3.1: a context provider's suite, against the scope a test brings (a fixture repository). */
    context(make: () => ContextProvider, opts?: ContextConformanceOptions): void;
  };
  /** A HookCall for a unit test of a listener, with a real AbortSignal and a deadline `timeoutMs` ahead. */
  call<N extends HookName>(hook: N, payload: HookPayload<N>, opts?: { timeoutMs?: number; principal?: Principal }): HookCall<N>;
}

// ---- the implementation -----------------------------------------------------------------------------------------

const OPERATOR: Principal = { kind: "operator", clientId: null };
const AT = "2026-11-04T12:00:00.000Z";
const said = (text: string): Untrusted => ({ text, untrusted: true, by: "agt-test1" });
const RUN: Run = { id: "run-test1", projectId: null, label: "test", state: "running", goal: "Add a test", title: null, repo: null, createdAt: AT };
const AGENT: Agent = { id: "agt-test1", runId: RUN.id, parent: null, depth: 0, profile: "worker", status: "running", text: "Working", task: "Add a test", provider: "claude", model: null, effort: null, updatedAt: AT };
const SPEC: PinnedSpec = { provider: "claude", auth: "subscription", maxTurns: 50, maxBudgetUsd: 5, egress: ["api.anthropic.com"] };
const VERIFICATION: Verification = { vfyId: "vfy-test1", runId: RUN.id, ref: AGENT.id, target: "main", check: "test", state: "running", tested: { sha: "a".repeat(40), targetSha: "b".repeat(40) }, passed: null, reasons: [] };
const MERGE: Merge = { mrgId: "mrg-test1", runId: RUN.id, ref: AGENT.id, target: "main", state: "running", sha: null, pr: null, reason: null };
const APPROVAL: Approval = { approvalId: "apr-test1", runId: RUN.id, agentId: AGENT.id, kind: "merge", question: "Merge into main?", subject: {}, status: "pending", requestedAt: AT, expiresAt: null };
const JOB: Job = { jobId: "job-test1", plugin: null, spec: { kind: "timer", runId: RUN.id, owner: { run: true }, label: "tick", everyMs: 60_000 }, state: "running", startedAt: AT, endedAt: null, result: null, reason: null };
const TRIGGER: Trigger = { source: "test", id: "t-1", thread: "thread-1", at: AT, actor: { id: "u-1", display: "someone", bot: false }, addressed: "mention", text: said("please look"), replyTo: null, data: {} };

const SAMPLES: { [N in HookName]: HookPayload<N> } = {
  "daemon.started": { version: "0.0.0", api: { socket: "/tmp/capcomd-test.sock", capabilities: [] }, plugins: [], sandboxes: ["fake"] },
  "daemon.stopping": { reason: "signal", deadline: AT },
  "run.creating": { options: { runId: RUN.id, label: "test", goal: said("Add a test"), budget: { usd: 5 }, checks: { test: "bun test" }, reviewer: null, target: "main", goalBranch: null, sandbox: "fake", profile: null, driver: null, repo: null } },
  "run.changed": { run: RUN, change: { kind: "started" } },
  "profile.resolved": { profile: { name: "worker", version: 2, source: "bundled" }, spec: SPEC, overrides: null },
  "agent.spawning": { spawn: { runId: RUN.id, parent: null, profile: "worker", task: said("Add a test"), contract: null, budget: { usd: 1 }, grant: null, review: false, operator: false }, spec: SPEC, parent: null },
  "agent.preparing": { agent: AGENT, spec: SPEC, prompt: { system: null, append: null, skills: [] }, env: [], egress: ["api.anthropic.com"], credentialMode: "subscription", sandbox: { provider: "fake", environment: null } },
  "agent.changed": { agent: AGENT, change: { kind: "checkpointed", files: 1, commit: null, at: AT } },
  "agent.item": { agent: { id: AGENT.id, runId: RUN.id, profile: "worker" }, item: { id: "itm-1", agentId: AGENT.id, rev: 1, kind: "message", at: AT, body: {}, untrusted: true } },
  "sandbox.ensuring": { runId: RUN.id, agentId: AGENT.id, purpose: "agent", provider: "fake", spec: { idemKey: "relay-test1", egressAllow: [], isolated: true, ttlSeconds: 3600, labels: {} } },
  "sandbox.changed": { provider: "fake", machine: { id: "m-1" }, runId: RUN.id, agentId: AGENT.id, change: { kind: "ready", createdMs: 10 } },
  "verify.starting": { verification: { vfyId: VERIFICATION.vfyId, runId: RUN.id, ref: AGENT.id, target: "main", check: "test" }, acceptance: null, reviewer: null, requestedBy: OPERATOR },
  "verify.judging": { verification: { ...VERIFICATION, tested: { ...VERIFICATION.tested!, commit: "c".repeat(40) } }, acceptance: null, task: said("Add a test"), reviewer: null },
  "verify.changed": { verification: VERIFICATION, change: { kind: "started" } },
  "merge.landing": { merge: MERGE, verification: VERIFICATION, target: { branch: "main", protected: false, sha: "b".repeat(40) }, sha: "a".repeat(40), fastPath: false, operator: false, requestedBy: OPERATOR },
  "merge.changed": { merge: MERGE, change: { kind: "requested" } },
  "approval.deciding": { approval: APPROVAL, decision: "approve", by: OPERATOR, reason: null },
  "approval.changed": { approval: APPROVAL, change: { kind: "requested" } },
  "job.changed": { job: JOB, change: { kind: "fired", n: 1 } },
  "trigger.admitting": { trigger: TRIGGER, gate: { allowed: true, strength: "explicit", mode: "observe", subscribed: null } },
  "trigger.changed": { trigger: TRIGGER, decision: { kind: "recorded", wouldHave: "start", runId: null } },
};

/** One change of each kind, for the hook contract of a job.changed listener that declared `changes` (§4.7). */
const JOB_CHANGES: { [K in JobChange["kind"]]: Extract<JobChange, { kind: K }> } = {
  started: { kind: "started" }, output: { kind: "output", stdout: "", stderr: "" }, fired: { kind: "fired", n: 1 }, ended: { kind: "ended", state: "done" },
};
/** The contract's call for `hook`: its sample, or for a job.changed listener with `changes`, a change it is called for. */
function contractPayload(manifest: PluginManifest, hook: HookName): HookPayload<HookName> {
  const kinds = hook === "job.changed" ? manifest.contributes?.hooks?.["job.changed"]?.changes : undefined;
  return kinds?.length ? { ...samplePayload("job.changed"), change: structuredClone(JOB_CHANGES[kinds[0]!]) } : samplePayload(hook);
}

/** A payload of the right shape for `hook`, for unit tests and the hook contract (§14.4). A fresh copy each time. */
export function samplePayload<N extends HookName>(hook: N): HookPayload<N> {
  return structuredClone(SAMPLES[hook]);
}

const STORAGE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/;
/** `ctx.storage` in memory, with the §8.4 key and size rules. */
function memoryStorage(): PluginContext["storage"] {
  const data = new Map<string, string>();
  const head = (scope: "daemon" | { runId: string }) => `${scope === "daemon" ? "daemon" : scope.runId}\u0000`;
  const at = (scope: "daemon" | { runId: string }, key: string) => {
    if (!STORAGE_KEY.test(key)) throw new PluginError("invalid", `storage key ${JSON.stringify(key)} (§8.4)`);
    return head(scope) + key;
  };
  const json = (v: unknown) => {
    const s = JSON.stringify(v);
    if (s === undefined || Buffer.byteLength(s) > 64 * 1024) throw new PluginError("invalid", "a storage value is JSON of at most 64 KB");
    return s;
  };
  return {
    async get(scope, key) { const s = data.get(at(scope, key)); return s === undefined ? undefined : JSON.parse(s); },
    async put(scope, key, value) { data.set(at(scope, key), json(value)); },
    async cas(scope, key, expect, value) {
      const k = at(scope, key), cur = data.get(k);
      if (expect === undefined ? cur !== undefined : cur !== JSON.stringify(expect)) return false;
      data.set(k, json(value));
      return true;
    },
    async delete(scope, key) { data.delete(at(scope, key)); },
    async list(scope, prefix) {
      const h = head(scope);
      return [...data.keys()].filter((k) => k.startsWith(h + prefix)).map((k) => k.slice(h.length)).sort();
    },
  };
}

class Fake<C> implements FakeContext<C> {
  readonly hooks: HookRegistry;
  readonly store = new ContributionStore();
  readonly runtime: PluginRuntime<C>;
  private readonly out: Array<{ type: string; stream: string; data: Record<string, unknown> }> = [];
  private readonly lines: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];
  private readonly host: HostEvent[] = [];
  private seq = 0;
  // The streams `publish` writes (§8.4 in the daemon reads the real ones): what subscriptions hear and replay returns.
  private readonly streams = new Map<string, HarnessEventEnvelope[]>();
  private readonly subs = new Set<{ stream: string; types: Set<string> | null; after: number; deliver: (e: HarnessEventEnvelope) => void | Promise<void> }>();
  private delivering: Promise<void> = Promise.resolve();

  constructor(readonly manifest: PluginManifest, config: C | undefined, opts: { services?: ContextOptions<C>["services"]; dir?: string }) {
    this.hooks = new HookRegistry({ emit: (e) => { this.host.push(e); }, rank: () => 0 });
    this.runtime = createContext<C>({
      manifest, runtime: manifest.entry.runtime, root: opts.dir ?? "", dataDir: `/nonexistent/plugins/${manifest.name}`,
      hooks: this.hooks, store: this.store,
      config: { ...configDefaults(manifest, opts.dir ?? null), ...(config ?? {}) } as C,
      services: { storage: memoryStorage(), ...(opts.services ?? {}) },
      emit: async (e) => { this.out.push({ type: e.type, stream: e.stream, data: e.data }); return { seq: ++this.seq }; },
      log: (l) => { this.lines.push({ level: l.level, message: l.message, fields: l.fields }); },
      subscribe: (stream, filter, deliver) => {
        const sub = { stream: streamOf(stream), types: filter.types?.length ? new Set(filter.types) : null, after: filter.after ?? 0, deliver };
        this.subs.add(sub);
        return { dispose: () => { this.subs.delete(sub); } };
      },
      replay: async (stream, after) => {
        const evs = this.streams.get(streamOf(stream));
        if (!evs && stream !== "daemon") throw new PluginError("not_found", `no run ${stream} (nothing was published on it)`);
        return (evs ?? []).filter((e) => e.seq > after);
      },
    });
    this.hooks.attach(manifest.name, this.runtime.ctx.signal);
  }
  get ctx() { return this.runtime.ctx; }
  registrations() { return this.runtime.registrations(); }
  async fire<N extends HookName>(hook: N, payload: HookPayload<N>, opts: { principal?: Principal; runId?: string; agentId?: string; timeoutMs?: number } = {}) {
    const r = await this.hooks.callOne(this.manifest.name, hook, payload, { principal: opts.principal ?? OPERATOR, entity: opts.runId ?? RUN.id, runId: opts.runId ?? null, agentId: opts.agentId ?? null, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    return { result: r.result as HookResult<N> | undefined, failure: r.failure, ms: r.ms };
  }
  emitted() { return [...this.out]; }
  logs() { return [...this.lines]; }
  publish(event: HarnessEventEnvelope) {
    const stream = streamOf(event.scope);
    // One publish's handlers finish before the next one's start: never two calls to a handler at once.
    const run = this.delivering.then(async () => {
      this.streams.set(stream, [...(this.streams.get(stream) ?? []), event]);
      for (const sub of [...this.subs]) {
        if (!this.subs.has(sub) || sub.stream !== stream || event.seq <= sub.after || (sub.types && !sub.types.has(event.type))) continue;
        await sub.deliver(event);
      }
    });
    this.delivering = run.catch(() => {});
    return run;
  }
  /** The host's own events about this plugin (plugin.hook_failed, plugin.suspended, …). */
  hostEvents() { return [...this.host]; }
  async dispose() { return (await this.runtime.dispose()).remaining; }
  seam<K extends "sandbox" | "agent" | "forge">(kind: K) {
    return this.store.list("seam").find((e) => e.value.seam === kind)?.value.impl as (K extends "sandbox" ? SandboxProvider : K extends "agent" ? AgentProvider : Forge) | undefined;
  }
  contextProvider(name: string) { return this.store.get("context", name)?.value.impl; }
}

const fail = (message: string): never => { throw new Error(message); };
/** A stream is `daemon` or a run id, as in the daemon (§8.4). */
const streamOf = (stream: string) => {
  if (stream === "daemon" || /^run-[A-Za-z0-9_-]+$/.test(stream)) return stream;
  throw new PluginError("invalid", `a stream is daemon or a run id (run-…), not ${JSON.stringify(stream)}`);
};

async function loadInto<C>(fake: FakeContext<C>, module: PluginModule<C>, timeoutMs = 30_000): Promise<void> {
  if (!(fake instanceof Fake)) throw new PluginError("invalid", "load takes a context from testkit.fakeContext");
  if (typeof module?.activate !== "function") fail("the module has no `activate` (export `plugin = definePlugin({ activate })`, §5.1)");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([
    Promise.resolve().then(() => module.activate(fake.ctx)).then(() => null, (e: unknown) => e),
    new Promise((res) => { timer = setTimeout(() => res(new PluginError("timeout", `activate did not return within ${timeoutMs} ms (§5.4)`)), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (fake.runtime.violations.length) fail(`${fake.manifest.name} registered what its manifest doesn't declare: ${fake.runtime.violations.join(", ")} (§4.7)`);
  if (r) throw r;
}

async function loadDisposeOnce<C>(manifest: PluginManifest, module: PluginModule<C>, config: C | undefined, round: number): Promise<void> {
  const fake = new Fake<C>(manifest, config, {});
  await loadInto(fake, module);
  const missing = fake.runtime.missing();
  if (missing.length) fail(`${manifest.name} declares but never registers: ${missing.join(", ")} (§4.7, §14.1; activation ${round})`);
  const left = await fake.dispose();
  if (left.length) fail(`${manifest.name}: registrations left after dispose: ${JSON.stringify(left)} (§5.3)`);
  for (const hook of Object.keys(manifest.contributes?.hooks ?? {}) as HookName[])
    if (fake.hooks.order(hook).length) fail(`${manifest.name}'s ${hook} listener is still registered after dispose`);
  for (const kind of ["seam", "context", "cli", "mcp", "instructions", "api", "capability", "ui"] as const)
    if (fake.store.list(kind).length) fail(`${manifest.name}: a ${kind} contribution is still listed after dispose`);
  let refused = false;
  try { fake.ctx.onDispose(() => {}); } catch (e) {
    if (!(e instanceof PluginError && e.code === "disposed")) throw e;
    refused = true;
  }
  if (!refused) fail(`${manifest.name}: the context still takes registrations after dispose`);
}

export const testkit: TestKit = {
  async validateManifest(dir, opts = {}) {
    const r = readManifest(dir, opts);
    return r.ok ? { ok: true, manifest: r.manifest } : { ok: false, issues: r.issues };
  },
  fakeContext: (manifest, config, opts = {}) => new Fake(manifest, config, opts),
  load: (fake, module) => loadInto(fake, module),
  async loadDispose(manifest, module, config) {
    // Twice, each in a fresh context: a module must be re-activatable (§5.4 `enable`, §14.1).
    await loadDisposeOnce(manifest, module, config, 1);
    await loadDisposeOnce(manifest, module, config, 2);
  },
  bootWith,
  async hookContract(manifest, module, config) {
    const fake = new Fake(manifest, config, {});
    await loadInto(fake, module);
    try {
      for (const hook of Object.keys(manifest.contributes?.hooks ?? {}) as HookName[]) {
        // A primitive the fake doesn't serve fails the call with `threw`: not the contract's business. A result of the
        // wrong shape for the mode, or a patch outside the hook's patchable fields, is.
        const r = await fake.fire(hook, contractPayload(manifest, hook));
        if (r.failure?.kind === "invalid_result") fail(`${manifest.name}'s ${hook} listener answered with the wrong shape: ${r.failure.message} (§6.2)`);
        fake.hooks.resume(manifest.name, "testkit");
        // A 100 ms deadline: the call settles (the host gives up on it) well within a second.
        const t = await fake.fire(hook, contractPayload(manifest, hook), { timeoutMs: 100 });
        if (t.ms > 1000) fail(`${manifest.name}'s ${hook} call with a 100 ms deadline took ${t.ms} ms (§14.4)`);
        fake.hooks.resume(manifest.name, "testkit");
      }
    } finally { await fake.dispose(); }
  },
  conformance: {
    sandbox(make, opts = {}) {
      // Registered as bun tests (bun:test is loaded only when a suite is): one test per case, one shared run.
      const { afterAll, describe, test } = require("bun:test") as typeof import("bun:test");
      describe(`sandbox seam conformance (§14.2)${opts.name ? `: ${opts.name}` : ""}`, () => {
        const { cases, cleanup } = sandboxCases(make(), opts);
        afterAll(cleanup);
        for (const c of cases) (c.skip ? test.skip : test)(c.name, c.run, (opts.readyMs ?? 120_000) + 60_000);
      });
    },
    agent(make, fixtures = {}) {
      // Pure methods only: no CLI runs, so every case is a plain test.
      const { describe, test } = require("bun:test") as typeof import("bun:test");
      describe(`agent seam conformance (§14.2)${fixtures.name ? `: ${fixtures.name}` : ""}`, () => {
        for (const c of agentCases(make(), fixtures)) test(c.name, c.run);
      });
    },
    // A seam is in process only (protocol 1 carries none, §9.6), so only a built-in can be a forge; theirs are tested by
    // the kernel against local bare repositories (tests/plugins/forges.test.ts, tests/merge).
    forge() { throw new PluginError("unsupported", "the forge conformance suite is not in the test kit: forges are built-in plugins (a seam is in process only, spec §9.6); see tests/plugins/forges.test.ts"); },
    context(make, opts = {}) {
      const { describe, test } = require("bun:test") as typeof import("bun:test");
      describe(`context provider conformance (ADR-025 §3.1)${opts.name ? `: ${opts.name}` : ""}`, () => {
        for (const c of contextCases(make(), opts)) (c.skip ? test.skip : test)(c.name, c.run, 60_000);
      });
    },
  },
  call(hook, payload, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? HOOKS[hook].timeoutMs.default;
    return {
      callId: `call_test_${Math.random().toString(16).slice(2, 10)}`, hook, mode: HOOKS[hook].mode as HookCall<typeof hook>["mode"], payloadVersion: 1,
      idempotencyKey: `${hook}:${RUN.id}:1`, deadline: new Date(Date.now() + timeoutMs).toISOString(), signal: AbortSignal.timeout(timeoutMs),
      trace: { traceId: "0".repeat(32), spanId: "0".repeat(16) }, principal: opts.principal ?? OPERATOR, runId: RUN.id, agentId: null, at: new Date().toISOString(),
      payload,
    };
  },
};
