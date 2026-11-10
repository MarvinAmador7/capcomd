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
  /** Command prefixes (a command's first words, e.g. `git push`) the CLI must refuse: an `orchestrate` agent's
   *  `toolPolicies.orchestrate.denyCommands` (§16.1), for a CLI that takes command rules of its own (codex execpolicy). */
  denyCommands?: string[];
  /** `auto`: the sandbox's host-bound secret placeholder when it has one, else the key in the agent's environment. */
  credentialMode: "auto" | "secret" | "env" | "subscription" | "none";
  /** On `subscription`, for a provider with several plan logins (`describe().logins`): the one the agent runs on (its
   *  name, as `capcomd auth login` recorded it). Additive. */
  planLogin?: string;
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
  /** The profile's MCP servers (ADR-024 `tools.mcp`), which the CLI starts in the sandbox: `config` is a file holding
   *  them and capcomd's own (when `capcomd` is set) as `{mcpServers: {<name>: {command, args}}}`; `servers` is the list,
   *  for a CLI that takes servers as flags. A `trusted` server's tools are approved up front, as capcomd's own are. */
  mcp?: { config: string; servers: Array<{ name: string; command: string[]; trust: "trusted" | "untrusted" }> };
  stdinPrompt?: boolean;
}

/** `commands` (optional, §16.4): the foreground shell commands the event starts (`started`, by the CLI's call id) and
 *  the calls it ends (`ended`), so the kernel knows while the agent waits on one. */
export interface AgentEvent { type: string; subtype?: string; tool?: string; text?: string; calls?: string[]; results?: Array<{ call: string; error?: string }>; commands?: { started?: string[]; ended?: string[] }; raw: Record<string, unknown> }
/** One run's accumulated state. The kernel keeps the same object for the whole run, so a provider may keep fields of
 *  its own on it between `parse` calls (Claude Code's per-message usage, its tool-use ids). */
export interface AgentRunState {
  events: number; turns: number; inputTokens: number; outputTokens: number; costUsd: number;
  /** Of `inputTokens`, the cache reads, and the model the CLI reported running: when the CLI says (on the agent span). */
  cacheReadTokens?: number; model?: string;
  resultText?: string; done: boolean; error?: string; stopReason?: string;
  quota?: { message: string; resetAt?: number };
}

/** One release archive of an agent CLI (`describe().install`): where it is, and its sha256 (lowercase hex). */
export interface AgentArchive { url: string; sha256: string }

/** One of the plan logins a CLI offers when it has more than one (`describe().logins`): `capcomd auth login <provider>
 *  <name>` makes it (the first that isn't `refused` when no name is given). The login VM reaches BASE_EGRESS and this
 *  login's `egress`, not `loginEgress`. `refused`: capcomd can't make this login headless (a browser callback to the
 *  login VM's own localhost, say); the sentence says why and what to use instead, and nothing is started for it.
 *  `metered`: model calls on this login are billed per token, not by a plan (fx's Vercel login: the AI Gateway on the
 *  user's Vercel team), so an agent on it is spend as on an API key: its estimated cost counts and budgets hold. */
export interface AgentLogin { name: string; label: string; egress: readonly string[]; refused?: string; metered?: boolean }

/** `src/agents/types.ts` AgentAdapter, as a seam (§7.3). The kernel's runner (`src/agents/runner.ts`) does clone,
 *  install, credentials, start, streaming, guards, cancel, commit and push; the provider says how its CLI is run and
 *  how its stream is read. Every method is pure except `available`. */
export interface AgentProvider {
  describe(): {
    name: string;
    label: string;
    /** CLI binary on PATH inside the sandbox, and how it is installed pinned when the sandbox lacks it: the npm package
     *  (`npmPackage`), or a release archive (`install`). Exactly one of the two. */
    bin: string;
    npmPackage?: string;
    pinnedVersion: string;
    /** A CLI shipped as release archives rather than on npm: per architecture (`uname -m`, x86_64 or aarch64) the
     *  archive's https URL and its sha256, which the install checks before it unpacks anything (a mismatch fails it);
     *  `member` is the binary's path in the archive. It is installed as `<agent home>/bin/<bin>`, and only a binary
     *  there, at `pinnedVersion`, is used; node (the supervisor's) is installed beside it when the sandbox has none. */
    install?: { kind: "archive"; member: string; assets: { x86_64: AgentArchive; aarch64: AgentArchive } };
    /** API key env name (also the host-bound secret name) and the host it is bound to. */
    secretName: string;
    apiHost: string;
    /** The provider's environment variable families (additive, absent: none): name prefixes such as `ANTHROPIC_`, each
     *  `ENV_PREFIX` (upper case, ending in `_`), where its CLI reads its credential, its login and its settings. The
     *  kernel reserves them as its own (§6.6.7, §10.3): no plugin's `agent.preparing` patch sets one, no plugin's secret
     *  references one, and checks on the host don't get them. They only add protection: a prefix that would take in
     *  one of the kernel's own families (`C_` is fine, `GITHUB_` takes in `GITHUB_TOKEN`) is refused when the seam
     *  registers (§7.3). */
    envPrefixes?: readonly string[];
    efforts: readonly string[];
    defaultEffort: string | null;
    /** The CLI reads user messages on stdin while it runs (`send` reaches it mid-run). */
    streamInput: boolean;
    /** False: capcomd has no plan login for this CLI, so a profile on it must use `auth: "apikey"` (refused at
     *  validation otherwise). Absent: true. */
    subscription?: boolean;
    loginEgress: readonly string[];
    /** The plan logins the CLI offers, when it has more than one (fx: a Vercel or a Grok login). Absent: one login,
     *  `loginCommand(bin)` with `loginEgress`. Additive. */
    logins?: readonly AgentLogin[];
    /** The tool lists that make an `orchestrate` agent (ADR-024 `tools.mode`, §16.1): it sees everything (reading and
     *  searching files, read-only git with fetch, every capcomd read) and runs nothing that changes or runs code (no
     *  edits, commits, merges, pushes, installs, builds or tests: those are its children's, checked at verify and
     *  merge). The kernel applies them on top of the profile's own lists: `allowed` replaces the profile's allowlist
     *  (or narrows it to these), `disallowed` joins its denylist, `denyCommands` (command prefixes, for a CLI with
     *  command rules of its own and no per-tool allowlist: codex execpolicy) joins `AgentConfig.denyCommands`, and
     *  `sandbox`, for a CLI whose own sandbox is the limit (codex `--sandbox`), is the loosest mode the agent runs in. */
    toolPolicies: { orchestrate: { allowed: readonly string[]; disallowed: readonly string[]; denyCommands?: readonly string[]; sandbox?: "read-only" | "workspace-write" } };
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
  /** Shell printing "secret" and/or "file" when a plan login is in the VM; with `describe().logins`, "file <name>" for
   *  each one it finds, so an agent whose VM holds a `metered` login is spend whatever the ledger records. */
  subscriptionCheck(home: string, q: (s: string) => string): string;
  subscriptionPrelude(home: string, q: (s: string) => string): string;
  /** The interactive login (run in a PTY in the login VM); `login` names the one of `describe().logins` to make. */
  loginCommand(bin: string, login?: string): string[];
  verifyCommand(bin: string, q: (s: string) => string): string;
  /** Optional, pure: a shell line run in the login VM right after the login (after `subscriptionPrelude`) that prints
   *  one JSON line, `{"loggedIn": <boolean>}`, whether the CLI itself sees the login. Only that boolean leaves the VM;
   *  false fails the login before anything is saved. */
  loginCheck?(bin: string, q: (s: string) => string): string;
  outcome(state: AgentRunState, exitCode: number): { ok: boolean; stopReason: string };
  /** Optional, pure: a tool call the CLI refused, from one line of its stderr (`ctx.errFile`), for a CLI that reports
   *  refusals only there (codex 0.163 logs a command its rules forbid and leaves it out of `--json`); null otherwise.
   *  `reason` must pass `redact`. The kernel shows it in the agent's log as `refused <call>: <reason>`. */
  refusal?(line: string, redact: (s: string) => string): { call: string; reason: string } | null;
}

/** A family of environment variables an agent provider declares (`describe().envPrefixes`, §7.3): `ANTHROPIC_`,
 *  `AI_GATEWAY_`. Upper case and ending in `_`, so a family is never "every name starting C". */
export const ENV_PREFIX = /^[A-Z][A-Z0-9_]*_$/;

/** Why `describe().envPrefixes` isn't a list of families (§7.3), or null when it is (absent is none). */
export function envPrefixesIssue(v: unknown): string | null {
  if (v === undefined) return null;
  if (!Array.isArray(v)) return "describe().envPrefixes must be a list of variable name prefixes";
  const seen = new Set<string>();
  for (const p of v) {
    if (typeof p !== "string" || !ENV_PREFIX.test(p)) return `describe().envPrefixes: ${JSON.stringify(p)} must be an upper-case variable name prefix ending in "_" (${ENV_PREFIX.source})`;
    if (seen.has(p)) return `describe().envPrefixes: ${p} is listed twice`;
    seen.add(p);
  }
  return null;
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
  /** The pull request's conversation as a trigger source names it (§16.3.6): a goal branch's run follows it once the
   *  pull request is open, so what people write there reaches the run's planner. Absent or null: no source reads it. */
  thread?: { source: string; thread: string } | null;
}

/** A remote's branches and default branch, as a forge read them (§7.4 `listBranches`). */
export interface ForgeBranches {
  /** The default branch the remote reports; null when it doesn't say (never guessed). */
  defaultBranch: string | null;
  /** At most the `max` asked for. */
  branches: string[];
  /** service: the hosting service's own API; git: `git ls-remote`. */
  source: "service" | "git";
  /** Why the service's API wasn't used, or failed (a sentence for the person, in the forge's words), or null. */
  note: string | null;
}

/**
 * The user's own credential for git over https to a remote the forge serves (§7.4 `remoteCredential`, §11.7). Data
 * only: the kernel's host git (`src/merge/host-git.ts`) makes it the only credential helper for `origin`, in the one git
 * process that talks to the remote; the forge never runs git or a credential helper itself.
 */
export interface ForgeRemoteCredential {
  /** The https origin it is for (`https://github.com`; scheme and host, no path): the remote must be on it. */
  origin: string;
  username: string;
  /** Kept in that one process's environment, never in a file, a URL or a log. */
  password: string;
}

/** Someone the user's own login at the service can act as (`login` with `accounts`). */
export interface ForgeAccount { login: string; kind: "user" | "org" }

/** What the user's own login at the service is asked for (§7.4 `login`): opening and merging pull requests, or
 *  creating repositories (`publishRepository`). A forge may need a different login for each. */
export type ForgeLoginUse = "pullRequests" | "publish";

/** Whether the user's own login at the service is on this machine for a use, and as whom. Shaped like a sandbox's or
 *  an agent provider's `available`: `reason` and `fix` are sentences for the person. */
export type ForgeLogin = { ok: true; accounts: ForgeAccount[] } | { ok: false; reason: string; fix: string | null };

/** The hosting service a repository's remote points at (§7.4). Selected by `merge.forge` in the project's config,
 *  default by `matches(remote)`; the built-in `git` forge matches every remote and lands by push only. */
export interface Forge {
  /** `publish`: `publishRepository` creates repositories (POST /v1/projects/publish asks the first active forge that
   *  does); absent is false. */
  describe(): { name: string; label: string; pullRequests: boolean; publish?: boolean };
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
  /** The remote's branches and its default branch (POST /v1/runs base resolution, GET /v1/projects/branches): from
   *  the service when it can, else from the remote itself. `remote` is a URL as `git remote get-url` prints it (or a
   *  path), read from `cwd`. Rejects when the remote can't be read at all; the message says why, for the person. */
  listBranches(input: { remote: string; cwd: string; max: number }, c: SeamCall): Promise<ForgeBranches>;
  /** Whether the user's own login at the service is on this machine for `use` (with `accounts`, also as whom it can
   *  act: the user first, then its organizations). Cheap (the forge may cache it) and never rejects: no login, or a
   *  service that doesn't answer, is `{ok: false}`; so is a use the forge has none of (no pull requests, no publish). */
  login(input: { use: ForgeLoginUse; accounts?: boolean }, c: SeamCall): Promise<ForgeLogin>;
  /** Optional (absent: none). The user's credential for the kernel's host git over https to `remote` (§11.7), or null:
   *  then the user's own git credentials apply. Asked only for an https remote the forge `matches`, before each fetch,
   *  push or ls-remote: cheap (the forge may cache it). A credential for another origin than the remote's is ignored. */
  remoteCredential?(input: { remote: string }, c: SeamCall): Promise<ForgeRemoteCredential | null>;
}
