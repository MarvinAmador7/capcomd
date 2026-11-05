// The three seams (spec §7): a kernel-defined interface, exactly one implementation chosen per run by name, and
// kernel consumers that never name an implementation. Every method takes an AbortSignal and has a deadline.
import type { Untrusted, VmSpec } from "./shapes";

/** Passed to every seam method. `deadline` is absolute; `signal` aborts at the deadline and on cancellation. */
export interface SeamCall { signal: AbortSignal; deadline: string; trace: { traceId: string; spanId: string } }

/** How an implementation classifies one of its own errors (§7.2.3), so the kernel never names a provider
 *  (`src/actors/worker.ts` isBoxdAuthError becomes `provider.classifyError`). */
export type ErrorClass =
  | { kind: "config"; retryable: false; hint: string }
  | { kind: "auth"; retryable: false; hint: string }
  | { kind: "not_found"; retryable: false }
  | { kind: "transient"; retryable: true; retryAfterMs?: number }
  | { kind: "quota"; retryable: true; retryAfterMs?: number; hint: string }
  | { kind: "timeout"; retryable: true }
  | { kind: "unknown"; retryable: false };

// ---- sandbox ----------------------------------------------------------------------------------------------------

export interface SandboxCaps {
  isolation: "vm" | "container" | "host";
  snapshots: boolean;
  hostBoundSecrets: boolean;
  egressAllowlist: boolean;
  interactive: boolean;
  idleLifetime: "platform" | "sweep" | "none";
  shell: boolean;
}

/** ADR-021's ProviderDescriptor (`src/providers/registry.ts`), served to clients as data. */
export interface SandboxDescriptor {
  name: string;
  descriptorVersion: 1;
  label: string;
  kind: "local" | "cloud";
  vendor: string;
  title: string;
  mark: string;
  listed: boolean;
  caps: SandboxCaps;
  settings: readonly ("idleLifetime" | "agentMemory")[];
  info: readonly ("logins" | "checkpoints" | "agentSlots")[];
  resourceKinds: readonly "machine"[];
  actions: readonly ("open_terminal" | "delete")[];
}

export interface ExecResult { code: number; stdout: string; stderr: string }
export interface MachineInfo { id: string; name: string; state: string; createdAt?: number | null; deleteAt?: number | null }

/** `src/providers/sandbox.ts` SandboxProvider plus `describe`, `available`, `classifyError` and a SeamCall on every
 *  method (§7.2). Conformance: tests/providers/conformance.test.ts (§14.2). */
export interface SandboxProvider {
  describe(): SandboxDescriptor;
  /** Cheap and cached by the kernel: can this place run agents now, and why not (`src/api/run-options.ts` AVAILABLE). */
  available(c: SeamCall): Promise<{ ok: true } | { ok: false; reason: string; fix: string | null }>;
  classifyError(e: unknown): ErrorClass;
  /** Idempotent by `spec.idemKey`: the same key returns the same machine with `created: false`. */
  ensure(spec: VmSpec, c: SeamCall): Promise<{ id: string; created: boolean }>;
  /** Resolves when `exec` will work; rejects `not_found` for an id that no longer exists. */
  waitReady(id: string, c: SeamCall): Promise<void>;
  /** Runs argv (no shell); kills it at the deadline inside the machine, not only on this side. Rejects `not_found`
   *  for a destroyed machine; a non-zero exit is a result, not an error. */
  exec(id: string, cmd: string[], opts: { env?: Record<string, string>; cwd?: string }, c: SeamCall): Promise<ExecResult>;
  upload(id: string, path: string, data: Uint8Array, c: SeamCall): Promise<void>;
  download(id: string, path: string, c: SeamCall): Promise<Uint8Array>;
  /** Rejects `unsupported` unless `caps.egressAllowlist`. */
  setEgress(id: string, allow: string[], c: SeamCall): Promise<void>;
  /** Rejects `unsupported` unless `caps.snapshots`. */
  snapshot(id: string, name: string, c: SeamCall): Promise<void>;
  checkpoint(id: string, name: string, c: SeamCall): Promise<void>;
  restore(id: string, name: string, c: SeamCall): Promise<void>;
  suspend(id: string, c: SeamCall): Promise<void>;
  resume(id: string, c: SeamCall): Promise<void>;
  /** Idempotent: destroying a machine twice resolves both times. */
  destroy(id: string, c: SeamCall): Promise<void>;
  list(prefix: string, c: SeamCall): Promise<MachineInfo[]>;
  /** Move the delete deadline to `seconds` from now (a lease the running work renews). */
  extendTtl?(id: string, seconds: number, c: SeamCall): Promise<void>;
  /** Resolves when the provider answers at all (about `id` when given; not-found is an answer), rejects when it does not. */
  probe?(id: string | undefined, c: SeamCall): Promise<void>;
  /** `caps.idleLifetime === "sweep"`: delete machines past their deadline; the kernel calls it every few minutes. */
  sweep?(c: SeamCall): Promise<{ deleted: string[] }>;
}

// ---- agent -------------------------------------------------------------------------------------------------------

/** `src/agents/config.ts` AgentConfig, the parts an adapter reads. */
export interface AgentConfig {
  model?: string;
  effort?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** `auto`: the sandbox's host-bound secret placeholder when it has one, else the key in the agent's environment. */
  credentialMode: "auto" | "secret" | "env" | "subscription" | "none";
  /** USD per million tokens, for a CLI that reports tokens and not cost: the provider's budget guard estimates from
   *  them (codex: CAPCOMD_CODEX_USD_PER_MTOK_IN, _OUT). */
  usdPerMtok?: { in: number; out: number };
}

/** `src/agents/types.ts` AgentCommandCtx. */
export interface AgentCommandCtx {
  bin: string;
  repo: string;
  promptFile: string;
  jsonl: string;
  errFile: string;
  systemFile?: string;
  appendSystemFile?: string;
  dir: string;
  cfg: AgentConfig;
  capcomd?: { cli: string; mcpConfig: string };
  stdinPrompt?: boolean;
}

export interface AgentEvent { type: string; subtype?: string; tool?: string; text?: string; calls?: string[]; results?: Array<{ call: string; error?: string }>; raw: Record<string, unknown> }
/** One run's accumulated state. The kernel keeps the same object for the whole run, so a provider may keep fields of
 *  its own on it between `parse` calls (Claude Code's per-message usage, its tool-use ids). */
export interface AgentRunState {
  events: number; turns: number; inputTokens: number; outputTokens: number; costUsd: number;
  resultText?: string; done: boolean; error?: string; stopReason?: string;
  quota?: { message: string; resetAt?: number };
}

/** `src/agents/types.ts` AgentAdapter, as a seam (§7.3). The kernel's runner (`src/agents/runner.ts`) does clone,
 *  install, credentials, start, streaming, guards, cancel, commit and push; the provider says how its CLI is run and
 *  how its stream is read. Every method is pure except `available`. */
export interface AgentProvider {
  describe(): {
    name: string;
    label: string;
    /** CLI binary on PATH inside the sandbox, and the npm package that installs it pinned. */
    bin: string;
    npmPackage: string;
    pinnedVersion: string;
    /** API key env name (also the host-bound secret name) and the host it is bound to. */
    secretName: string;
    apiHost: string;
    efforts: readonly string[];
    defaultEffort: string | null;
    /** The CLI reads user messages on stdin while it runs (`send` reaches it mid-run). */
    streamInput: boolean;
    loginEgress: readonly string[];
    /** The tool lists that make an `orchestrate` agent (ADR-024 `tools.mode`, §16.1): only reading and the capcomd
     *  command; no file edits, no work shell. The kernel applies them on top of the profile's own lists: `allowed`
     *  replaces the profile's allowlist (or narrows it to these), `disallowed` joins its denylist, and `sandbox`, for
     *  a CLI whose own sandbox is the limit (codex `--sandbox`), is the loosest mode the agent runs in. */
    toolPolicies: { orchestrate: { allowed: readonly string[]; disallowed: readonly string[]; sandbox?: "read-only" | "workspace-write" } };
  };
  /** Is this provider usable here now (its CLI pinned in the environment, a login or key present)? */
  available(input: { sandbox: string; auth: "apikey" | "subscription" }, c: SeamCall): Promise<{ ok: true } | { ok: false; reason: string; fix: string | null }>;
  classifyError(e: unknown): ErrorClass;
  credentialEnv(value: string): Record<string, string>;
  baseEnv(): Record<string, string>;
  /** One shell line that runs the agent headless with stdout to `ctx.jsonl`; `q` quotes for `sh`. */
  command(ctx: AgentCommandCtx, q: (s: string) => string): string;
  /** Parse one line of the stream and update `state`; null for a partial or foreign line. Text must pass `redact`. */
  parse(line: string, redact: (s: string) => string, state: AgentRunState, cfg: AgentConfig): AgentEvent | null;
  /** Why to stop the agent now (a turn or budget guard), or null. */
  guard(state: AgentRunState, cfg: AgentConfig): string | null;
  subscriptionCheck(home: string, q: (s: string) => string): string;
  subscriptionPrelude(home: string, q: (s: string) => string): string;
  loginCommand(bin: string): string[];
  verifyCommand(bin: string, q: (s: string) => string): string;
  outcome(state: AgentRunState, exitCode: number): { ok: boolean; stopReason: string };
}

const CREDENTIAL_KEY = /api[_-]?key|token|secret|password|authorization/i;

/** What `parse` does with a parsed JSON line before reading it (§7.3): every string through `redact`, and a string
 *  under a key that names a credential (`api_key`, `token`, `secret`, `password`, `authorization`) replaced whole.
 *  The kernel's own rule (`src/agents/redact.ts` `Redactor.value`), so a provider redacts as the built-ins do. */
export function redactJson<T>(v: T, redact: (s: string) => string): T {
  if (typeof v === "string") return redact(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactJson(x, redact)) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = CREDENTIAL_KEY.test(k) && typeof x === "string" ? "[REDACTED]" : redactJson(x, redact);
    return o as T;
  }
  return v;
}

// ---- forge -------------------------------------------------------------------------------------------------------

export type MergeStrategy = "squash" | "rebase" | "merge";

/** What the kernel hands a forge after it integrated and checked the work (§7.4): push this, or open and merge a PR. */
export interface LandRequest {
  runId: string;
  mrgId: string;
  remote: string;
  repo: string | null;
  branch: string;
  target: string;
  /** The integrated commit the checks passed on; the forge lands exactly this tree. */
  sha: string;
  /** The target commit the kernel integrated onto; a direct push is a CAS on it. */
  targetSha: string;
  /** The branch commit `sha` was integrated from. `pr`: the pull request is merged at exactly this head (the hosting
   *  service makes the merge commit itself, with `strategy`). `direct` with `leaseBranch`: the branch is leased at it. */
  branchSha?: string;
  /** `direct`: lease the branch at `branchSha` in the same atomic push as the target (the kernel integrated from refs
   *  it didn't fetch). A remote that refuses atomic pushes is `{status: "failed", retryable: true}`: the kernel fetches
   *  and lands again without it. */
  leaseBranch?: boolean;
  mode: "direct" | "pr";
  strategy: MergeStrategy;
  subject: string;
  body: string;
  trailers: Record<string, string>;
  /** Local clone the kernel prepared, with `sha` present and credentials configured. */
  workdir: string;
}

export type LandOutcome =
  | { status: "merged"; sha: string; already: boolean; how: string; pr: number | null }
  /** The target moved (a refused lease), or the service can't merge it: `targetSha` when the forge knows it, else "";
   *  `detail` is what the forge saw, for the record. */
  | { status: "conflict"; targetSha: string; detail?: string }
  | { status: "failed"; reason: string; retryable: boolean };

export interface PullRequestRef {
  number: number; url: string | null; state: "open" | "closed" | "merged"; head: string; base: string;
  /** The commit the merge made on the base, once merged: a replay records it without merging again. */
  mergeSha?: string | null;
}

/** The hosting service a repository's remote points at (§7.4). Selected by `merge.forge` in the project's config,
 *  default by `matches(remote)`; the built-in `git` forge matches every remote and lands by push only. */
export interface Forge {
  describe(): { name: string; label: string; pullRequests: boolean };
  /** Whether this forge serves `remote` (a URL as `git remote get-url` prints it); the kernel asks the forges in
   *  order and takes the first `true`. */
  matches(remote: string): boolean;
  classifyError(e: unknown): ErrorClass;
  /** Land under the kernel's target lock. Idempotent by `mrgId`: a replay after a crash finds the PR or the pushed
   *  commit and reports `already: true`. Must reject `unsupported` for `mode: "pr"` when `pullRequests` is false. */
  land(req: LandRequest, c: SeamCall): Promise<LandOutcome>;
  openPullRequest(input: { remote: string; head: string; base: string; title: string; body: Untrusted | string }, c: SeamCall): Promise<PullRequestRef>;
  findPullRequest(input: { remote: string; head: string; base: string }, c: SeamCall): Promise<PullRequestRef | null>;
  /** Create the remote repository for a plain folder (POST /v1/projects/publish). */
  publishRepository(input: { path: string; owner: string | null; name: string; visibility: "private" | "public" }, c: SeamCall): Promise<{ remote: string; url: string | null }>;
  defaultBranch(remote: string, c: SeamCall): Promise<string | null>;
}
