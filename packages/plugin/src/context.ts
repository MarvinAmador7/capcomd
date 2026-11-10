// The context a plugin receives (spec §5): one object, services grouped by noun, every registration a Disposable.
import type { PluginManifest } from "./manifest";
import type { HookListener, HookName, Grant } from "./hooks";
import type { AgentProvider, Forge, SandboxProvider } from "./seams";
import type { ContextProvider } from "./context-layer";
import type { Agent, AgentNotice, Approval, AttachedSkill, Budget, Job, JobSpec, Merge, PinnedSpec, Principal, Run, Timestamp, Trigger, TriggerDecision, TriggerReply, TriggerSubscription, Untrusted, Verification } from "./shapes";

/** Every registration returns one. Disposing twice is a no-op. The host disposes every outstanding one on unload, in
 *  reverse registration order (§5.3). */
export interface Disposable { dispose(): void | Promise<void> }

/** Options every async primitive takes last (§8.2). */
export interface CallOptions {
  /** Idempotency key for a mutating call: the same key with the same arguments does it once (as the CLI's `--key`). */
  key?: string;
  /** Cancel the call. Composed with `ctx.signal`. */
  signal?: AbortSignal;
  /** Deadline for this call, in ms (default 30 000; a seam call may set its own). */
  timeoutMs?: number;
}

export interface PluginIdentity {
  name: string;
  version: string;
  runtime: "in-process" | "process";
  /** The plugin's files (read-only, replaced on update). */
  root: string;
  /** Durable per-plugin directory, kept across updates (`~/.capcomd/state/plugins/<name>/`). */
  dataDir: string;
  manifest: PluginManifest;
}

export interface ConfigService<C> {
  /** The validated, layered config (§10.2). Secret properties are absent here. */
  get(): Readonly<C>;
  /** The value of a property marked `x-secret` in the config schema; `not_found` when unset (§10.3). */
  secret(key: string): Promise<string>;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface Span { setAttributes(a: Record<string, string | number | boolean>): void; event(name: string, a?: Record<string, string | number | boolean>): void; end(): void }
export interface Tracer {
  /** A span named `plugin.<name>.<op>`, a child of the active hook call's span when there is one (§13.4). */
  span<T>(op: string, fn: (span: Span) => Promise<T>): Promise<T>;
}

export interface HookService {
  /** Register the listener for `hook`. The hook must be declared in `contributes.hooks` (§4.7); one listener per hook. */
  on<N extends HookName>(hook: N, listener: HookListener<N>): Disposable;
}

export interface SeamService {
  /** Implement a seam under the name declared in `contributes.seams` (§7.1). A second implementation of the same
   *  (kind, name) by another plugin is `conflict`. */
  sandbox(impl: SandboxProvider): Disposable;
  agent(impl: AgentProvider): Disposable;
  forge(impl: Forge): Disposable;
}

/** The context layer (ADR-025 §3.1): a provider a profile names in `context.providers`, under the name declared in
 *  `contributes.context` (its `describe().name`). The kernel's router composes them; a second registration of the same
 *  name, by any plugin, is `conflict`. In process only in protocol v1, like the seams. */
export interface ContextService { register(impl: ContextProvider): Disposable }

/** The relay.v1 envelope a command or tool answers with (`src/core/errors.ts` SCHEMA). */
export type Envelope = { schema: "relay.v1"; ok: true } & Record<string, unknown>;

export interface CliCommandSpec {
  /** Declared in `contributes.cli`. Invoked as `capcomd <name> …`. */
  name: string;
  summary: string;
  /** Usage lines for `--help`. */
  usage: string[];
  /** Runs with the caller's principal (§11.2). `args` are the words after the command name; `flags` the parsed `--k v`
   *  pairs (a flag given more than once: a list). Answers with an envelope, which the CLI prints (§4.7.1). */
  run(input: { args: string[]; flags: Record<string, string | boolean | string[]>; json: boolean; principal: Principal; signal: AbortSignal }): Promise<Envelope | CliExit>;
}
/** A built-in front door's own answer (§4.7.1): the kernel's commands print text, stream and prompt themselves, then
 *  exit with `exit`. The dispatcher takes it from those alone; from any other plugin it is an error. */
export interface CliExit { exit: number }
export interface CliService { command(spec: CliCommandSpec): Disposable }

export interface McpToolSpec {
  /** Declared in `contributes.mcp`; registered as `capcomd_<plugin>_<name>`. */
  name: string;
  /** A short human title, for clients that show one. */
  title?: string;
  description: string;
  /** JSON Schema of the arguments (an object schema, draft 2020-12 or draft-07): listed as it is; the arguments are
   *  checked against it before `run`, and properties it doesn't name are dropped (§4.7.2). */
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** The tool's listed `_meta`, e.g. `{"anthropic/requiresUserInteraction": true}` so a client asks its person first. */
  _meta?: Record<string, unknown>;
  run(input: { args: Record<string, unknown>; principal: Principal; signal: AbortSignal }): Promise<Envelope>;
}
export interface McpService {
  tool(spec: McpToolSpec): Disposable;
  /** Text appended to the MCP server's instructions, under a heading with the plugin's name. */
  instructions(text: string): Disposable;
}

export interface ApiRouteSpec {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Relative to `/v1/x/<plugin>`; declared in `contributes.api`. */
  path: string;
  scope: "read" | "steer" | "configure";
  /** JSON in, JSON out. Throw a PluginError for a non-2xx; the gateway maps the code to a status (§8.3). */
  handler(input: { params: Record<string, string>; query: Record<string, string>; body: unknown; principal: Principal; signal: AbortSignal }): Promise<unknown>;
}
export interface ApiService {
  route(spec: ApiRouteSpec): Disposable;
  /** Add a harness.v1 feature flag (`GET /v1/health` capabilities), named `x.<plugin>.<name>`. */
  capability(name: string, doc: string): Disposable;
}

/** What a `settings` or `info` row's `read` answers (§4.7.5): its value and, optionally, the rest of the `SandboxField`
 *  shape of GET /v1/sandboxes/{name} (`help` replaces the descriptor's when it depends on the value). */
export interface UiRowValue {
  value: string | null; display: string; source: string; editable: boolean; state?: "ok" | "warn" | "bad" | "none";
  help?: string | null; default?: string | null; appliesTo?: "new_runs" | "new_agents" | null; needsRestart?: boolean;
}
/** Descriptor kinds the app renders generically (§4.7.5). `profile-field` is how ADR-024 `x-` blocks show up. */
export type UiDescriptor =
  | { kind: "settings" | "info"; id: string; label: string; help: string | null; type: "choice" | "toggle" | "info" | "status"; choices?: Array<{ value: string; label: string }>; read(): Promise<UiRowValue>; write?(value: string): Promise<void> }
  | { kind: "action"; id: string; label: string; destructive: boolean; confirm: string | null; run(input: { resourceId: string; principal: Principal }): Promise<void> }
  | { kind: "card"; id: string; title: string; read(): Promise<{ lines: string[]; state: "ok" | "warn" | "bad" | "none" }> }
  | { kind: "profile-field"; id: string; label: string; path: string; type: "text" | "number" | "toggle" | "choice"; choices?: Array<{ value: string; label: string }> };
export interface UiService { descriptor(d: UiDescriptor): Disposable }

export interface EmittedEvent { type: string; stream: "daemon" | string; entity: string; text: string; data: Record<string, unknown>; durability?: "durable" | "ephemeral" }
export interface HarnessEventEnvelope { v: 1; id: string; scope: string; seq: number; entity: string; entitySeq: number; type: string; typeVersion: number; durability: "durable" | "ephemeral"; ts: Timestamp; epochMs: number; projectId: string | null; runId: string | null; agentId: string | null; text: string; data: Record<string, unknown> }
export interface EventService {
  /** Emit `plugin.<name>.<type>` on a stream (`daemon`, or a run id). `type` must be declared in `contributes.events`.
   *  `data` is redacted and `text` must be the plugin's own words (§4.7.4, §8.4). `entity` is what the event is about
   *  (`""`: the plugin itself, `plugin:<name>`). Durable: `ephemeral` is refused (`unsupported`) for now. */
  emit(e: EmittedEvent, o?: CallOptions): Promise<{ seq: number }>;
  /** Live events of a stream, after `after`; the handler is called in order and never concurrently. */
  subscribe(stream: "daemon" | string, filter: { types?: string[]; after?: number }, handler: (e: HarnessEventEnvelope) => void | Promise<void>): Disposable;
  replay(stream: "daemon" | string, after: number, o?: CallOptions): Promise<HarnessEventEnvelope[]>;
}

/** Per-plugin storage (§8.4): keys `^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$`; values JSON ≤ 64 KB. Run scope lives in the
 *  run's kv under `plugin/<name>/` and is deleted with the run; daemon scope lives in the plugin's data dir. */
export interface StorageService {
  get(scope: "daemon" | { runId: string }, key: string, o?: CallOptions): Promise<unknown | undefined>;
  put(scope: "daemon" | { runId: string }, key: string, value: unknown, o?: CallOptions): Promise<void>;
  /** Compare-and-swap on the JSON text of the current value (`expect` undefined: must not exist). */
  cas(scope: "daemon" | { runId: string }, key: string, expect: unknown | undefined, value: unknown, o?: CallOptions): Promise<boolean>;
  delete(scope: "daemon" | { runId: string }, key: string, o?: CallOptions): Promise<void>;
  list(scope: "daemon" | { runId: string }, prefix: string, o?: CallOptions): Promise<string[]>;
}

export interface RunsService {
  /** Quoted: a bare `new(` in an interface declares a constructor, not this method. */
  "new"(input: { budget: Budget; label?: string; goal?: string; checks?: Record<string, string>; reviewer?: string; target?: string; sandbox?: string }, o?: CallOptions): Promise<Run>;
  get(runId: string, o?: CallOptions): Promise<Run>;
  list(input: { limit?: number }, o?: CallOptions): Promise<Run[]>;
  end(runId: string, input: { state: "failed" | "cancelled"; reason: string }, o?: CallOptions): Promise<void>;
  pause(runId: string, o?: CallOptions): Promise<void>;
  resume(runId: string, o?: CallOptions): Promise<void>;
  title(runId: string, title: string, o?: CallOptions): Promise<void>;
}

/** A plugin's spawn (§8.4). `review` is refused (`forbidden`): a reviewer is a verification's. `title` names its tab, set
 *  by the plugin (as `capcomd spawn --title`). */
export interface SpawnInput { runId: string; parent?: string; profile: string; task: string; contract?: Record<string, unknown>; budget?: Budget; grant?: Grant; review?: boolean; title?: string }
export interface AgentsService {
  spawn(input: SpawnInput, o?: CallOptions): Promise<Agent>;
  get(runId: string, agentId: string, o?: CallOptions): Promise<Agent>;
  tree(runId: string, root?: string, o?: CallOptions): Promise<Agent[]>;
  /** Resolves when every (or, with `any`, one) agent ended, or at the deadline with what ended so far. */
  await(runId: string, ids: string[], input: { any?: boolean }, o?: CallOptions): Promise<{ ended: Agent[]; pending: string[] }>;
  cancel(runId: string, agentId: string, reason: string, o?: CallOptions): Promise<void>;
  grant(runId: string, agentId: string, add: Budget, o?: CallOptions): Promise<void>;
  title(runId: string, agentId: string, title: string, o?: CallOptions): Promise<void>;
  /** Raise or clear a notice on an agent (`stalled` is the watchdog's, §16.4). `detail` is the plugin's text, shown as
   *  untrusted. Clearing a notice the kernel raised is refused (`forbidden`). */
  notice(runId: string, agentId: string, notice: { kind: AgentNotice["kind"]; detail: string } | null, o?: CallOptions): Promise<void>;
}

/** Background work and timers (§16.2): one primitive for jobs, schedules and the watchdog's clock. Every job is a
 *  durable record on its run (or the daemon, for a plugin-owned timer); its changes arrive as `job.changed` hook calls
 *  and `job.*` events, never by polling. */
export interface JobsService {
  /** Start a job. An `exec` job that ends within `foregroundMs` (default: the owner's `jobs.foregroundMs`, else 60 000)
   *  returns `done` with its result; otherwise it returns `running` and the result arrives as `job.changed`. Idempotent
   *  by `key`. Refused (`conflict`) past the owner's `jobs.max`. */
  start(spec: JobSpec, o?: CallOptions): Promise<Job>;
  get(jobId: string, o?: CallOptions): Promise<Job>;
  list(filter: { runId?: string; agentId?: string; state?: Job["state"] }, o?: CallOptions): Promise<Job[]>;
  /** Ask the job to stop; it settles `killed` once its work stopped (exec: SIGTERM, then SIGKILL after 5 s). */
  cancel(jobId: string, reason: string, o?: CallOptions): Promise<Job>;
  /** Resolve when the job settled or at the deadline (`o.timeoutMs`, default 30 000), with its current record. */
  wait(jobId: string, o?: CallOptions): Promise<Job>;
}

/** External events (§16.3). A source plugin emits triggers; the kernel's intake dedupes, authorizes and applies the
 *  accept mode, then starts a run, continues one, or only records what it would have done. */
export interface TriggersService {
  /** Hand a trigger to the intake. `trigger.source` must be one of this plugin's `contributes.sources`. Returns the
   *  decision; the same `(source, id)` within the dedupe window returns `deduped`. */
  emit(trigger: Trigger, o?: CallOptions): Promise<TriggerDecision>;
  /** Later triggers on `thread` reach the run as messages to its planner without a new admission, until `until`
   *  (default: 14 days after the run ends). A run subscribes to the thread its trigger came from automatically. */
  subscribe(sub: Omit<TriggerSubscription, "until"> & { until?: Timestamp }, o?: CallOptions): Promise<TriggerSubscription>;
  unsubscribe(sub: Pick<TriggerSubscription, "runId" | "source" | "thread">, o?: CallOptions): Promise<void>;
  subscriptions(filter: { runId?: string; source?: string }, o?: CallOptions): Promise<TriggerSubscription[]>;
  /** A source's reply path (§16.3.7): how the daemon posts a short result where a request came from, when the operator
   *  turned replies on for the source (`triggers.sources.<source>.reply`). `source` must be one of this plugin's
   *  `contributes.sources`; one reply path per source. What it posts must carry the source's own mark, so its next read
   *  drops it (§16.3.1). Resolves with where the reply is (a URL, or null); a rejection that is `retryable` is tried again
   *  (at most three times), any other is given up. In process only in protocol v1, like the seams. */
  onReply(source: string, reply: (r: TriggerReply, o: CallOptions) => Promise<{ url: string | null }>): Disposable;
}

export interface MessagesService {
  send(runId: string, input: { to: string; body: string; skills?: AttachedSkill[] }, o?: CallOptions): Promise<{ seq: number }>;
  inbox(runId: string, agentId: string, after: number, o?: CallOptions): Promise<Array<{ seq: number; from: string; body: Untrusted; at: Timestamp }>>;
}

export interface GatesService {
  verify(runId: string, input: { ref: string; check?: string; acceptance?: unknown; target?: string; reviewer?: string }, o?: CallOptions): Promise<Verification>;
  /** Never bypasses vetoes: a plugin cannot pass `operator` (§11.3). */
  merge(runId: string, input: { ref: string; require: string; target?: string }, o?: CallOptions): Promise<Merge>;
  pending(runId: string, o?: CallOptions): Promise<Approval[]>;
}

export interface BoardTask { id: string; goal: Untrusted; state: "pending" | "leased" | "running" | "done" | "released"; holder: string | null; after: string[] }
export interface BoardService {
  /** `goal`: checked as a run's goal is, not blank, at most 16 KB (UTF-8), no NUL; `invalid` otherwise (§8.4). */
  add(runId: string, input: { id: string; goal: string; after?: string[] }, o?: CallOptions): Promise<BoardTask>;
  claim(runId: string, input: { id?: string }, o?: CallOptions): Promise<BoardTask | null>;
  done(runId: string, id: string, o?: CallOptions): Promise<void>;
  release(runId: string, id: string, o?: CallOptions): Promise<void>;
  list(runId: string, o?: CallOptions): Promise<BoardTask[]>;
}

/** The run's shared blackboard. Reserved prefixes (`_`, `approval/`, `recipe/`, `handoff/`, `plugin/`) are read-only (§8.4). */
export interface KvService {
  get(runId: string, key: string, o?: CallOptions): Promise<unknown | undefined>;
  put(runId: string, key: string, value: unknown, o?: CallOptions): Promise<void>;
  cas(runId: string, key: string, expect: unknown | undefined, value: unknown, o?: CallOptions): Promise<boolean>;
  list(runId: string, prefix: string, o?: CallOptions): Promise<string[]>;
}

export interface SandboxesService {
  /** The provider registered under `name`; `not_found` when none is active. Calls go through the kernel's traced,
   *  resilient wrapper (`src/dependencies.ts`), never to the plugin's object directly. */
  provider(name: string): SandboxProvider;
  forRun(runId: string, o?: CallOptions): Promise<{ provider: SandboxProvider; name: string }>;
  descriptors(): ReadonlyArray<ReturnType<SandboxProvider["describe"]>>;
}

export interface ProfilesService {
  resolve(name: string, input: { project?: string; overrides?: Record<string, unknown> }, o?: CallOptions): Promise<PinnedSpec>;
  list(input: { project?: string }, o?: CallOptions): Promise<Array<{ name: string; version: number; source: string; description: string | null; tags: string[] }>>;
}

/** Facts about credentials, never values (§11.4). */
export interface AuthService {
  credentialMode(provider: string, auth: "apikey" | "subscription"): "secret" | "env" | "subscription" | "none";
  loginPresent(provider: string, sandbox: string, o?: CallOptions): Promise<boolean>;
  /** The kernel's redactor (`src/agents/redact.ts`): run it on anything before logging or emitting it. */
  redact(text: string): string;
}

/** What `activate` receives (§5.1). `C` is the plugin's config type, matching its config schema. */
export interface PluginContext<C = Record<string, unknown>> {
  readonly plugin: PluginIdentity;
  readonly principal: Extract<Principal, { kind: "plugin" }>;
  /** Aborted when the plugin starts disposing. */
  readonly signal: AbortSignal;
  readonly config: ConfigService<C>;
  readonly log: Logger;
  readonly trace: Tracer;
  readonly hooks: HookService;
  readonly seams: SeamService;
  readonly context: ContextService;
  readonly cli: CliService;
  readonly mcp: McpService;
  readonly api: ApiService;
  readonly ui: UiService;
  readonly events: EventService;
  readonly storage: StorageService;
  readonly runs: RunsService;
  readonly agents: AgentsService;
  readonly messages: MessagesService;
  readonly gates: GatesService;
  readonly board: BoardService;
  readonly kv: KvService;
  readonly sandboxes: SandboxesService;
  readonly profiles: ProfilesService;
  readonly auth: AuthService;
  readonly jobs: JobsService;
  readonly triggers: TriggersService;
  /** Run `fn` when the plugin disposes, after its registrations are removed (§5.3). */
  onDispose(fn: () => void | Promise<void>): Disposable;
}

/** What an in-process entry module exports as `plugin` (§5.1). Dispose is `ctx.onDispose`; there is no second method. */
export interface PluginModule<C = Record<string, unknown>> {
  activate(ctx: PluginContext<C>): void | Promise<void>;
}

/** Identity with inference: `export const plugin = definePlugin<Config>({ activate })`. */
export function definePlugin<C = Record<string, unknown>>(m: PluginModule<C>): PluginModule<C> {
  return m;
}
