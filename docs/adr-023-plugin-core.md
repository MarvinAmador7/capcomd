# ADR-023: Everything is a plugin: a lean core with primitives and lifecycle hooks

Status: **Accepted, spec in [docs/spec/plugin-api.md](spec/plugin-api.md)** (2026-11-04). The spec is normative; where this
ADR and the spec differ, the spec wins, and §10 below lists what the spec decided and why. Types:
[`packages/plugin`](../packages/plugin). Proposed 2026-11-04. Builds on ADR-016 (primitives), ADR-017 (sub-agents, capability tokens),
ADR-018 (capcomd as a plugin for the user's agent), ADR-020/021 (sandbox providers and their descriptors), ADR-022
(the agent workflow) and docs/harness-architecture.md (the harness.v1 API, scopes, capabilities). Research:
[docs/research/plugin-architecture.md](research/plugin-architecture.md), mainly deepseek-harness at
`fcc0ad46` (§2) and the comparison in §4.

The ADR numbers the owner asked for (019, 020) were taken (agents report up, sandbox providers), so this is 023 and the
profiles ADR is 024.

## 1. Context

capcomd's core already has seams that look like a plugin system, each built for one feature:

| Seam | Where | Shape |
|---|---|---|
| Sandbox providers | `src/providers/registry.ts` `PROVIDERS` (a `const` of descriptors), `src/dependencies.ts` `rawProviderFromEnv` (an `if` chain that `require`s `./providers/boxd` or `./providers/docker`), `src/providers/sandbox.ts` `SandboxProvider` | A typed interface, a descriptor served to clients (ADR-021), a conformance test (`tests/providers/conformance.test.ts`); selection by `CAPCOMD_SANDBOX` and a hard-coded switch |
| Agent CLIs | `src/agents/types.ts` `AgentAdapter`; `src/agents/adapters.ts` `claudeAdapter`, `codexAdapter`, `adapterFor`, `ALL_ADAPTERS`; `PROVIDER_KIND` in `profiles.ts` | A typed interface with two implementations in one file; `Provider = "claude" \| "codex"` is a closed union in the profile schema |
| Merge paths | `src/merge/service.ts` `mergeTask` (direct or PR by `cfg.mode`), `src/merge/github.ts` `GitHubApi` + `setGitHubApi()` for tests | An interface injected for tests only; GitHub is the only forge |
| Reviewer / critic | `src/primitives/ops.ts` `startReview`, `finishReview`, `reviewFits`; `src/primitives/review.ts` `parseVerdict` | A gate step hard-wired into `verifyRef`; the reviewer is an agent profile, the verdict format is fixed |
| MCP tools | `src/mcp/server.ts`: 24 `server.registerTool("capcomd_…")` calls in one file | Registration exists (the MCP SDK's); the list is static |
| CLI commands | `src/cli/index.ts`: a 1,000-line `switch` on the first argument; `src/cli/commands/*` | No registration; a command is a `case` |
| harness.v1 features | `src/api/contract.ts` `CAPABILITIES` (a flat list of names a client feature-detects), `src/api/server.ts` scope check (`read`, `steer`, `approve`, `configure`) | Feature flags for clients; every feature is in `server.ts` |
| Hooks into an agent's life | `src/actors/agent-workflow.ts` (prepare → drive loop → settle), `src/agents/runner.ts` `runAgent`, `src/subagents/skill.ts` (prompt injection), `src/agents/skills.ts` (skills on messages) | Fixed sequence; the only extension points are env vars (`CAPCOMD_*`) and killpoints (`src/utils/killpoint.ts`, test-only) |
| Front doors | `src/cli/commands/hermes.ts` (writes Hermes's config), `plugins/capcomd/` (Claude Code and Codex plugin), `src/cli/commands/setup.ts` | Each integration is bespoke code in the core |

Every new feature adds to `server.ts`, `index.ts`, `ops.ts` (1,700 lines) and `scope.ts` (1,300 lines). The owner's
direction is the opposite: a core that exposes **primitives and lifecycle methods**, and features that plug into them,
including capcomd's own. deepseek-harness ("DeepSeek Harness: Everything is a Plugin", research §2) is the model the
owner points to; it exists, is public, and its kernel/plugin split is what this ADR adapts.

## 2. Decision in one paragraph

capcomd keeps a **kernel**: the Rivet actors and their SQLite state (`scope`, `worker`, `verifier`, `run`), the
`harness.v1` API gateway and event stream, principals and scopes, the policy module (`src/primitives/policy.ts`), the
spool/token channel into sandboxes (ADR-017), and a **plugin host** that loads manifests, resolves order, and runs
hooks. Everything that gives the kernel something concrete to do is a **plugin** with a manifest: sandbox providers,
agent providers (the CLIs), merge paths (forges), gates (checks, reviewer), front doors (CLI command groups, MCP tool
groups, the Hermes writer), UI descriptors, observers (tracing, the runs index, cost). Built-in plugins ship inside the
capcomd package and are enabled by default; third-party plugins install from a git repository, run **out of process**
by default, and get a principal with scopes, exactly like an API client. Hooks have fixed names, typed payloads, a
declared mode (`observe`, `veto`, `modify`), an order, and a timeout; a gate's hook fails closed, an observer's fails
open.

## 3. The kernel's job after the change, and what leaves it

**Stays (the kernel):**

- Durable state and transactions: the actors in `src/actors/` and `src/registry.ts`, the event log, `lifecycle_events`,
  idempotency by key (`stableId`, `paramsHash`). Nothing outside the kernel writes an actor's SQLite.
- The agent tree policy: `policy.ts` (limits, budgets, narrowing), capability tokens (`src/subagents/token.ts`), the
  spool RPC (`src/subagents/rpc.ts`, `spool.ts`), fencing (`src/subagents/results.ts`).
- The `harness.v1` gateway: socket, client tokens and scopes (`src/api/clients.ts`, `server.ts` middleware), the SSE
  stream with resume and backpressure, the envelope and `describeEvent` (`src/api/describe.ts`), the OpenAPI output.
- The agent lifecycle workflow (`agent-workflow.ts`) as the **sequence** that emits hooks; what each step does becomes
  plugin calls (provision through a sandbox plugin, run through an agent-provider plugin, push through a forge plugin).
- The plugin host itself (§6) and the primitive API it hands to plugins (§4).
- Redaction (`src/agents/redact.ts`) and the inline-size caps: they run on every event before storage, so they cannot be
  optional.

**Leaves (becomes a plugin, in-process, enabled by default):**

| Today | Plugin | Kind |
|---|---|---|
| `src/providers/docker.ts`, `boxd.ts`, `fake.ts` | `@capcomd/sandbox-docker`, `-boxd`, `-fake` | sandbox provider |
| `src/agents/adapters.ts` `claudeAdapter`, `codexAdapter` (+ `runner.ts` CLI-specific parts, `claude-code.ts`) | `@capcomd/agent-claude-code`, `-codex` | agent provider |
| `src/merge/github.ts`, `pr.ts` | `@capcomd/forge-github` | forge (PR mode) |
| `src/merge/direct.ts` | `@capcomd/merge-direct` | merge path |
| `src/merge/verify.ts` checks (host and VM) | `@capcomd/gate-checks` | gate |
| `startReview`/`finishReview`/`parseVerdict` | `@capcomd/gate-reviewer` | gate |
| `src/mcp/server.ts` tool list, `src/mcp/driver.ts` | `@capcomd/front-mcp` | front door (MCP tools) |
| `src/cli/commands/hermes.ts` | `@capcomd/front-hermes` | front door (config writer) |
| `plugins/capcomd/` (the Claude Code / Codex plugin) | stays as it is; it is already a plugin *for the agent* (ADR-018) | |
| `src/utils/tracing-simple.ts` span sinks, `runsIndexPath` writer | `@capcomd/observe-traces`, `-runs-index` | observer |
| `src/api/sandboxes.ts` descriptors → settings/info/actions | stays data; each sandbox plugin owns its descriptor (ADR-021 already says so) | UI descriptor |
| The CLI `switch` | each group (`run`, `agents`/`profiles`, `sandbox`, `env`, `auth`, `clients`, `service`, …) is a command plugin; `src/cli/index.ts` becomes the host's dispatcher | front door (CLI) |

**Judgment call:** the hierarchical recipe (`src/recipes/hierarchical.ts`, the fake-model planner) becomes a plugin too
and is not enabled by default once `planner-agent.ts` is the only path users take; it stays for the parity eval.

## 4. The primitive set (the host API a plugin receives)

*Superseded by spec §8 (the context, 22 services, 77 primitives) and §7 (the seams); kept as the proposal's shape.*

A plugin gets one object, `host`, typed per permission (§6.4). Names are nouns with verbs; every mutating call takes
`key` for idempotency as the CLI and MCP do today. These are not new behaviours: each is a function that already exists
in `src/primitives/ops.ts`, `state.ts`, `src/api/*` or an actor, re-exposed with a principal attached.

| Primitive | Methods | Today |
|---|---|---|
| `host.runs` | `new`, `get`, `list`, `end`, `pause`, `resume`, `title`, `goal` | `ops.runNew`, `endRun`, `pauseAgents`, `recentRuns`, `setRunTitle`, `runGoal` |
| `host.agents` | `spawn`, `get`, `tree`, `inspect`, `await`, `cancel`, `grant`, `title`, `continue` | `spawnAgent`, `treeOf`, `inspectAgent`, `awaitAgents`, `cancelAgents`, `grantBudget` |
| `host.messages` | `send(to, body, {skills})`, `inbox(agent, after)` | `sendToAgent`, scope `inbox` |
| `host.gates` | `verify(ref, {check, acceptance})`, `merge(ref, {require, target})`, `decide(mrgId, approve)`, `pending()` | `verifyRef`, `mergeRef`, `decideMerge`, `pendingMerges` |
| `host.board`, `host.kv` | the task board and blackboard verbs | `state.ts` |
| `host.sandboxes` | `provider(name)`, `forRun(runId)`, `descriptors()` | `providerNamed`, `providerForRun`, `DESCRIPTORS` |
| `host.auth` | `credentialMode(provider, auth)`, `loginPresent(provider, sandbox)`, `redact(text)`; never a value | `credentialModeFor`, `profileFor`, `redactShapes` |
| `host.profiles` | `resolve(name, overrides)`, `list()` (ADR-024) | `resolveAgent`, `readAgentsFile` |
| `host.events` | `emit(type, data)` (plugin-namespaced types only: `plugin.<name>.<event>`), `subscribe(scope, filter)`, `replay(scope, after)` | scope `appendEvent`, `listEvents`, the SSE source |
| `host.storage` | `get/put/cas/list` in a per-plugin, per-scope namespace (`plugin/<name>/…` in the run's kv; a `plugins/<name>/` dir under the capcomd home for files) | kv with a reserved prefix (the `_`, `approval/`, `recipe/`, `handoff/` rule in ADR-017 extends to `plugin/`) |
| `host.cli` | `command(spec)` registers a command group: name, flags (zod), handler, `--json` envelope | the `switch` cases |
| `host.mcp` | `tool(spec)` registers an MCP tool with annotations; `instructions(text)` adds to the server's instructions | `server.registerTool` |
| `host.api` | `capability(name, doc)`, `route(method, path, scope, handler)` under `/v1/x/<plugin>/…`, `event(type, schema)` | `CAPABILITIES`, Hono routes, `HarnessEvent` schemas |
| `host.ui` | `descriptor(kind, data)`: settings rows, info rows, resource actions, cards, a profile's extra fields | ADR-021 `ProviderDescriptor` (`settings`, `info`, `actions`) generalised |
| `host.log`, `host.trace` | structured logs and spans under the plugin's name | `tracing-simple.ts` |

**What a plugin never gets:** an actor handle, the engine client (`src/core/relay.ts` `client()`), raw credentials, the
RPC signing key, or the spool. Those stay in the kernel. A plugin that needs to run something in a sandbox asks
`host.sandboxes.provider(name).exec(...)`, which goes through the traced, resilient wrapper (`src/dependencies.ts`).

**Three contracts are seams, not hooks.** A sandbox provider, an agent provider and a forge each have an interface
the kernel defines (`SandboxProvider` in `src/providers/sandbox.ts`, `AgentAdapter` in `src/agents/types.ts`, and a
new `Forge`), exactly one implementation selected by name per run, and consumers in the kernel that never name an
implementation. Every registration is a disposer, so disabling a plugin removes what it registered. **From the
research:** dsh's capability-seam rule (Service Definition + Provider + Consumer; "one provider swap changes the whole
product", research §2.2), its reversible-effect registrations, and Backstage's extension points. capcomd already works
this way for sandboxes (`sandboxCaps().snapshots`, never `name === "boxd"`); this ADR extends the rule to agents and
forges and removes the two places that still branch on a name (`dependencies.ts` `providerNamed`'s Docker sweep,
`worker.ts`'s `isBoxdAuthError`).

## 5. Lifecycle hooks

### 5.1 Modes, order, timeouts

- **Modes.** `observe` (after the fact, result ignored), `veto` (before the fact; may return `{deny, reason}`),
  `modify` (before the fact; returns a patched payload the kernel validates again). A hook's mode is fixed by the
  kernel per hook name; a plugin declares which hooks it implements and the manifest says which modes it needs.
- **Order.** Plugins run in manifest `order` (`pre | normal | post`, default `normal`), then by `after: [names]`
  dependencies (a topological sort; a cycle refuses to load the later plugin), then by name. `veto` hooks short-circuit
  on the first deny. `modify` hooks chain: each sees the previous result. `observe` hooks run in parallel.
- **Timeouts.** Default 10 s for `veto`/`modify`, 30 s for `observe`; a manifest may lower them, never raise above 60 s
  (the MCP clients' tool timeout, ADR-018 §3). On timeout or throw: a `veto`/`modify` hook on a **gate** (`verify.*`,
  `merge.*`, `approval.*`) **fails closed** (the action is denied with the plugin's name in the reason); on anything
  else it is skipped with a `plugin.hook_failed` event; an `observe` hook is always skipped. Three consecutive failures
  disable the plugin's hooks until the daemon restarts or `capcomd plugins enable` (a circuit breaker; a
  `plugin.disabled` event on the daemon stream).
- **Payloads** are the `harness.v1` shapes that already exist (`Run`, `Agent`, `Verification`, `Merge`, the envelope's
  `data`), plus a `principal` and a `plugin` context. Agent-written text in a payload is marked `untrusted` as in the API.
- **Where they fire.** From the kernel only: `ops.ts` (spawn, verify, merge, send, cancel), `agent-workflow.ts` (the
  agent's phases), `server.ts` (approvals), the plugin host (daemon start/stop). A plugin cannot fire a kernel hook.

### 5.2 The hooks

*Superseded by the catalog in spec §6.6 (21 hooks); the differences are listed in §10 below.*

| Hook | Mode | Payload (beyond `{runId, agentId?, principal, at}`) | Fires |
|---|---|---|---|
| `daemon.starting` | modify | `{config}` | before plugins are wired; a plugin may add config defaults |
| `daemon.started` | observe | `{plugins: [{name, version, enabled}], sandboxes, capabilities}` | after the API is listening |
| `daemon.stopping` | observe | `{reason}` | before actors drain; bounded by the stop timeout |
| `run.creating` | veto, modify | `{budget, label, goal, checks, reviewer, target, sandbox}` | in `runNew`, before the scope's `init` |
| `run.created` | observe | `Run` | after `RUN_NEW` |
| `run.ended` | observe | `Run`, `{state, reason}` | after `run.completed|failed|cancelled` |
| `profile.resolved` | modify (narrow-only) | `{profile, version, spec}` | in `host.profiles.resolve`, before `spawnChecks` (ADR-024) |
| `agent.spawning` | veto, modify (narrow-only: `task`, `contract`, `budget`, `grant`) | `SpawnOpts` + resolved spec | in `spawnAgent`, after `spawnChecks`, before the scope's `spawn` transaction |
| `agent.spawned` | observe | `Agent` | after `AGENT_SPAWNED` |
| `agent.preparing` | modify | `{env snapshot, egress, credentialMode, prompt parts: [system, append, skills[]]}` | workflow `prepare`, before the machine is ensured; the only place a plugin adds prompt text (the orchestration skill moves here) |
| `agent.started` | observe | `Agent`, `{machine, attempt}` | workflow `start-agent` |
| `agent.item` | observe | one `harness.v1` thread item (text, tool call/result, reasoning), `untrusted` | as the runner drains the stream (`putItems`); the closest thing to a turn/tool-call hook capcomd can offer (§5.3) |
| `agent.step` | observe | `{kind, n}` | the step history (`agent.step` event) |
| `agent.notice` | observe | `{kind: idle|spinning|failing|quota, detail}` | `notice` |
| `agent.pushing` | modify | `{branch, subject, trailers}` | before the worker's push; a plugin may add a trailer (`Capcomd-Task:` today) |
| `agent.ended` | observe | `Agent`, `{status, result, spent}` | after `finish`/`pause`/`cancel` |
| `message.sending` | modify | `{to, from, body, skills[]}` | `sendToAgent`, before `sendMessage`; a plugin may attach skills |
| `message.delivered` | observe | `{to, seq}` | after the agent read it (inbox cursor) |
| `verify.starting` | veto, modify (`acceptance` only; never `checks`) | `VerifyOpts` resolved | `verifyOnce` |
| `verify.checked` | observe | `{vfyId, passed, output, tested}` | after the checks step |
| `verify.reviewing` | veto | `{vfyId, profile, sha, targetSha}` | before the reviewer spawn |
| `verify.finished` | observe | `Verification` | after `finishOp` |
| `merge.requested` | veto | `MergeOpts` + `Verification` | `mergeRef`, after the `--require` check |
| `merge.gating` | veto | `{mrgId, ref, target, protected, fastPath}` | under the target lock, before the push; a plugin may park (`{park, reason}`) as protected branches do |
| `merge.landed` | observe | `Merge` | after `MERGED` |
| `merge.failed` | observe | `Merge`, `{reason}` | |
| `approval.requested` | observe | `Approval` | `parkOp` / approvals |
| `approval.deciding` | veto | `{approvalId, decision, by}` | `decideOp`, before the CAS; a plugin may require a second approver |
| `approval.decided` | observe | `Approval` | |
| `sandbox.ensuring` | modify | `VmSpec` | before `provider.ensure`; a plugin may add labels or a size |
| `sandbox.ready` | observe | `{id, provider, createdMs}` | after `waitReady` |
| `sandbox.destroying` | observe | `{id, provider, reason}` | before `destroy` |
| `plugin.hook_failed`, `plugin.disabled` | (events, not hooks) | `{plugin, hook, error}` | the host |

**Ordering within one agent's life:** `profile.resolved` → `agent.spawning` → `agent.spawned` → `agent.preparing` →
`sandbox.ensuring` → `sandbox.ready` → `agent.started` → (`agent.item` | `agent.step` | `agent.notice` |
`message.delivered`)* → `agent.pushing` → `agent.ended` → `sandbox.destroying`. A verify of that agent:
`verify.starting` → (`verify.reviewing` ∥ checks) → `verify.checked` → `verify.finished`. A merge: `merge.requested` →
`merge.gating` → `merge.landed | merge.failed | approval.requested`.

### 5.3 What is deliberately not a hook

- **Per-tool-call veto inside the agent.** The agent CLI runs in a sandbox with its permissions bypassed and no channel
  to the host except the spool (ADR-017 §1, ADR-019 §7). A host plugin sees tool calls as `agent.item` after the fact
  and may act (cancel, send a message, raise a notice); it cannot block one. Claude Code's `PreToolUse` lives inside the
  agent, where capcomd's plugin for the agent (ADR-018) can add hooks later; that is a different plugin system.
- **A hook to run host shell on agent output.** Checks come only from the operator (ADR-017 §2). `verify.starting` may
  not change `checks`.
- **Widening anything.** Every `modify` hook is validated by the same narrowing code as a user override
  (`applyOverrides`, `applyGrant`); a widening is refused with the plugin's name.

**From the research:** one mode word per hook, fixed in the hook's definition (dsh's `emit | parallel | serial |
bail | waterfall`, where a waterfall listener vetoes by not calling `next()`, research §2.3; Rollup's
`first | sequential | parallel`); dsh's rule that every event documents its mode and a generator checks the dispatch
sites against it (adopted as a test in §8 step 1); a veto that returns a decision object with a reason (dsh's
`tools/pre-execute` → `allow | deny{reason} | cancel | ask`, Claude Code's exit 2 with stderr as the reason and
`permissionDecision`); `pre|normal|post` placement (Vite `enforce`); fail-closed gates (dsh's approval seam is
fail-closed, and "missing approval support turns `ask` into denial"); a circuit breaker (Hermes logs and skips a
crashed callback; Kubernetes' `failurePolicy` is the vocabulary); hooks fired by the kernel only, with durable events
published after commit and listener failures contained (dsh `session/event`). **Where this departs from dsh:** dsh has
no hook timeout at all (not found in Cordis); capcomd needs one because a hook may be a child process and a gate must
answer before an MCP client's tool timeout. **Judgment calls:** the exact names (dotted `noun.verb-ing` for before,
`noun.verb-past` for after, matching the `harness.v1` event convention decided 2026-10-25), the timeout values, three
modes rather than dsh's five (`serial` and `bail` collapse into `veto`; `parallel` and `emit` into `observe`), and
`agent.item` as the turn/tool surface.

## 6. Manifest, discovery, loading, isolation, config, versioning

*Superseded by spec §4 (manifest), §5 (lifecycle), §9 (protocol), §10 (config), §11 (security), §12 (versioning).*

### 6.1 Manifest (`capcomd.plugin/v1`)

```jsonc
{
  "schema": "capcomd.plugin/v1",
  "name": "sandbox-docker",             // ^[a-z0-9][a-z0-9-]{0,62}$; the name hooks, kv, events and routes are namespaced by
  "version": "0.9.0",                   // semver; built-ins use the package version
  "description": "Containers on this machine's Docker.",
  "capcomd": ">=0.9 <1",               // the kernel's version range this plugin was tested with
  "api": 1,                             // the host API major it codes against
  "kind": ["sandbox"],                  // sandbox | agent | forge | gate | front | observe | ui (one or more)
  "runtime": "in-process",              // in-process (built-in or trusted) | process (stdio JSON-RPC, default for third party)
  "entry": "./dist/index.js",           // in-process: a module exporting `activate(host)`; process: the command to run
  "hooks": { "sandbox.ensuring": "modify", "sandbox.ready": "observe" },
  "order": "normal", "after": ["observe-traces"],
  "permissions": ["sandboxes", "events:emit", "storage", "ui"],      // §6.4
  "config": { "$ref": "./config.schema.json" },                      // JSON Schema for plugins.<name> (§6.5)
  "provides": { "sandbox": { "descriptor": "./descriptor.json" } }   // kind-specific: the ADR-021 descriptor
}
```

### 6.2 Discovery

In this order, later entries of the same name are refused with a `plugin.conflict` event (no silent shadowing):

1. **Built-ins**: a static list in the capcomd package (`src/plugins/builtin.ts`), compiled into the single executable
   like every other asset (`src/utils/assets.ts`; DEVELOPMENT.md's rule: import, never `readFileSync` a package file).
2. **User**: `~/.capcomd/plugins/<name>/plugin.json`, installed by `capcomd plugins install <owner/repo>[@ref]`, with a
   `LOCK` (source, commit, file hashes) as ADR-024 §2.5 does for profiles.
3. **Project**: `.capcomd/plugins/<name>/` or `.capcomd/config.json` `plugins.use: ["owner/repo#name@ref"]`, enabled
   only after a one-time operator trust prompt per content hash (`capcomd plugins trust`), because a cloned repository
   must not run code on the host by being opened (the same reason project skills are hashed in harness-architecture §8).

`capcomd plugins list|show|install|update|remove|enable|disable|trust|validate` and `GET /v1/plugins` (capability
`plugins`, the `read` scope; writes need `configure`).

### 6.3 Loading: in-process and out-of-process

- **In-process** (`runtime: "in-process"`): a TypeScript/JavaScript module imported by the daemon, `activate(host)`
  called once at `daemon.starting`. Allowed for built-ins and for third-party plugins the operator marks
  `trusted: true` in the user config. Fast; no isolation beyond the permission-typed `host`.
- **Out-of-process** (`runtime: "process"`, the default for anything installed): the host starts the plugin's command
  and speaks JSON-RPC over stdio, the same transport shape as MCP and the in-VM CLI (`src/subagents/rpc.ts`), with
  the hook payloads as requests and `host.*` calls as reverse requests. The process gets a filtered environment (what
  Hermes gives a stdio MCP server: `PATH, HOME, USER, LANG, TERM, TMPDIR`, plus its own `env`), no capcomd secrets, and
  a **client token** minted for it with its manifest's scopes (`src/api/clients.ts` `addClient`), so its `host.*` calls
  are ordinary `harness.v1` calls the gateway already authorises and audits. A crash restarts it with backoff; a crash
  during a gate hook is a fail-closed deny.
- **Sandbox-side plugins** (what runs inside the agent's VM: the supervisor, the in-VM CLI, MCP servers an ADR-024
  profile declares) are not host plugins. They are files the sandbox plugin uploads; they hold a capability token at
  most (ADR-017).

**From the research:** VS Code's extension host (out-of-process by default, a typed API over RPC) and Hermes's
`plugins.isolation: host` (third-party plugins in one host process per profile over a stdio pipe). **Where this departs
from dsh:** dsh has no plugin sandbox; its plugins are trusted in-process code and its `SAFETY.md` tells users to run
the whole harness in a disposable VM (research §2.6). That fits a single-user agent that owns its loop; it does not fit
a daemon that holds client tokens and git credentials and whose trust boundary is the sandbox, so capcomd keeps
harness-architecture.md §2's line. **Judgment call:** reuse client tokens and scopes rather than a second permission
model; a plugin is a client that happens to be started by the daemon.

### 6.4 Permissions, mapped onto harness.v1 scopes

| Manifest permission | What it allows | Scope the plugin's token gets |
|---|---|---|
| `read` | `host.runs.get/list`, `agents.get/tree`, `events.subscribe/replay`, `profiles.list`, `sandboxes.descriptors` | `read` |
| `steer` | `agents.spawn/send/cancel/grant`, `runs.new/pause/resume`, `gates.verify`, `gates.merge` into non-protected targets, `board`, `kv` | `steer` |
| `approve` | `gates.decide`, `approval.deciding` veto | `approve` |
| `configure` | `host.profiles` writes, settings, `host.ui.descriptor` | `configure` |
| `sandboxes` | be a sandbox provider: receive `ensure/exec/…` calls for its own name | (kernel-internal; in-process only, or a process the kernel calls, never an API scope) |
| `agents` | be an agent provider: supply an `AgentAdapter` | same |
| `forge` | be a merge path: receive `merge.gating` as the implementer, push with the engine's git credentials via the kernel (never the token itself) | same |
| `events:emit` | `host.events.emit("plugin.<name>.*")` | `steer` (write) |
| `storage` | the plugin's kv prefix and files dir | none needed (kernel-local) |
| `cli`, `mcp`, `api` | register commands, tools, routes | none needed; the registered handler runs with the **caller's** principal, not the plugin's |

Two rules follow: a plugin's own calls carry its principal (`{kind: "plugin", name, scopes}`), and a front-door plugin's
handlers carry the user's or driver's. `ops.ts` and `policy.ts` already key enforcement on the principal
(ADR-018 §4: `operator | driver | agent`); `plugin` and `viewer` join that union. Human-only approvals stay human:
no plugin permission grants `approve` on a protected-target merge; a plugin may only *add* a requirement.

### 6.5 Config

`plugins.<name>` in `~/.capcomd/config.json` (user) and `.capcomd/config.json` (project; project wins key by key, as
`driverPolicy()` merges `driver` today), validated against the manifest's JSON Schema on load and on `capcomd plugins
validate`; invalid config disables the plugin with a `plugin.config_refused` event rather than running it with
defaults. `CAPCOMD_PLUGIN_<NAME>_<KEY>` env overrides, the way `applyConfig` lets a real env var win. Secrets go through
`userConfig`-style sensitive entries kept in the keychain (`src/config/keychain.ts`), never in the file; a plugin reads
them through `host.auth`, which hands back a presence check or a sandbox-bound placeholder (ADR-015 §3), not the value,
unless the manifest asks `secrets:read` and the operator granted it.

### 6.6 Versioning and compatibility

- The host API has an integer major (`api: 1`). The kernel serves `api` 1 for the life of 0.x; additive changes keep the
  number, a removal bumps it and the kernel serves both for one minor release (the `typeVersion` rule of
  harness-architecture §6.2, reused).
- `capcomd` range in the manifest is checked at load (semver). Outside the range the plugin is **not loaded** (a
  `plugin.incompatible` event on the daemon stream names the range and the running version), unless the operator
  recorded an exemption for that exact `name@version` with `capcomd plugins allow-version <name@version>
  --accept-risk`, kept in `~/.capcomd/plugins/compatibility.json`. **From the research:** this is dsh's gate as it
  is (`engines.dsh` decides alone when present; denied rows are disabled; exact exemptions via `allow-version
  --accept-risk`, research §2.8); the same check runs before install. A missing range imposes no constraint but
  `capcomd plugins validate` warns.
- Hook names are never renamed; a replaced hook keeps firing with a `deprecated` flag for one minor release.
- The descriptor shapes (`descriptorVersion` in ADR-021) and event `typeVersion` keep their own numbers.
- `capcomd plugins list` and `/v1/health` `plugins[]` show name, version, api, runtime, enabled, and the hooks it
  implements, so an app can explain why a feature is missing.

### 6.7 Errors

A hook error is `{plugin, hook, kind: timeout|threw|crashed|invalid_result, message}`; `message` is the plugin's and is
shown as untrusted text. A gate denied by a plugin returns the `relay.v1` error `forbidden` with `reason:
"plugin:<name>"` and the plugin's message as `hint`, so the MCP driver and the app can show who refused and why.

## 7. Today's built-ins as plugins: before and after

### 7.1 Docker sandbox provider

**Before.** `src/providers/docker.ts` implements `SandboxProvider`; `src/providers/registry.ts` lists its descriptor
in the `PROVIDERS` const; `src/dependencies.ts` `rawProviderFromEnv` `require`s it when `CAPCOMD_SANDBOX=docker`;
`providerNamed` special-cases `name === "docker"` to start its sweep; `src/api/run-options.ts` `AVAILABLE.docker`
asks `docker version`; `src/cli/commands/serve.ts` starts the 5-minute sweep.

**After.** `plugins/builtin/sandbox-docker/` with `plugin.json` (`kind: ["sandbox"]`, `provides.sandbox.descriptor`
= today's descriptor object, `hooks: {"daemon.started": "observe"}` to start its own sweep, `config.schema.json` with
`agentMemory`, `idleLifetime`, `image`, `bin`), `activate(host)` returning `{provider: new DockerProvider(...),
available: () => dockerReachable()}`. `registry.ts` becomes `DESCRIPTORS = host.plugins.ofKind("sandbox").map(d =>
d.descriptor)`; `dependencies.ts` becomes `host.plugins.sandbox(name).provider`, still wrapped by `resilientProvider`
and `tracedProvider` in the kernel. `run-options.ts` calls `plugin.available()`. Nothing in `worker.ts`,
`agent-workflow.ts` or the API changes; `tests/providers/conformance.test.ts` runs unchanged against the plugin's
provider and becomes the conformance suite every sandbox plugin must pass (`capcomd plugins validate --conformance`).

### 7.2 boxd sandbox provider

**Before.** `src/providers/boxd.ts` + `boxd-machine.ts` + `boxd-errors.ts`; the descriptor in `PROVIDERS`; `BOXD_API_KEY`
from env, keychain or file via `applyConfig` (`src/config/store.ts`); `isBoxdAuthError` checked in `worker.ts` and
`recipes/hierarchical.ts`; `src/api/run-options.ts` `boxdKeyConfigured`.

**After.** `sandbox-boxd` plugin with `permissions: ["sandboxes", "secrets:read"]` (the API key), `config.schema.json`
with `idleLifetime`, and a `classifyError(e) → {kind: "config"|"transient"|…, retryable, hint}` method on the provider
interface so `worker.ts` stops naming boxd (`isBoxdAuthError` becomes `provider.classifyError`). Host-bound secrets and
egress allowlists stay capabilities in the descriptor (`caps.hostBoundSecrets`, `caps.egressAllowlist`), which the
kernel's `spawnChecks` already consults by capability, not by name (`ops.ts:199`'s Docker egress refusal becomes a
capability check). The live tests (`tests/providers/boxd.live.test.ts`) move with it.

### 7.3 GitHub merge path

**Before.** `src/merge/service.ts` `mergeTask` picks `directMerge` or `prMerge` by `cfg.mode`; `prMerge` needs a
`GitHubApi` (`HttpGitHub` with `githubToken()` from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`); `setGitHubApi`
injects a fake in tests; `src/api/project-git.ts` and `src/mcp/server.ts` `capcomd_pr_open` call `gh` directly; the
merge config (`src/merge/config.ts`) has `github.{repo, api, pollMs, timeoutMs}` fields baked in.

**After.** Two plugins. `merge-direct` (`kind: ["forge"]`, implements `land(req) → MergeOutcome` for `mode: direct`,
owns the fast path and the target lock use) and `forge-github` (`kind: ["forge"]`, implements `land` for `mode: pr`,
`openPullRequest`, `findPullRequest`, `publishRepository`; owns `HttpGitHub`, token lookup via `host.auth`, the
`github.*` config keys as its own schema). `mergeTask` becomes `host.plugins.forge(cfg.mode).land(req)` under the
kernel's target lock. `capcomd_pr_open`, `POST /v1/runs/{runId}/pull-request` and `POST /v1/projects/publish` call the
forge's methods; a GitLab or Gitea forge is then one plugin with no change to the API. `tests/merge/fake-github.ts`
becomes a `forge-fake` test plugin. The CAS, the push lock and the `expectSha` check stay in the kernel.

### 7.4 Reviewer / critic gate

**Before.** `verifyOnce` in `ops.ts` runs the checks (`merge/verify.ts`), then `startReview` spawns the run's reviewer
profile with a brief from `review.ts` `reviewBrief`, `finishReview` awaits it and parses `{"passed", "reasons"}` with
`parseVerdict`; `reviewFits` replaces a reviewer that read the wrong tree. The reviewer profile comes from kv
`_reviewer`; both steps are inside one function.

**After.** `gate-checks` (`kind: ["gate"]`, implements `verify.starting`'s checks step by calling
`host.sandboxes.forRun(runId)` and the kernel's integrate; owns the pass cache) and `gate-reviewer` (`kind: ["gate"]`,
hooks `verify.reviewing` (veto: no reviewer configured → skip) and runs the reviewer through `host.agents.spawn` with
`review: true`, awaits it with `host.agents.await`, parses the verdict, and returns `{passed, reasons}` to the kernel,
which keeps "both must pass for the same tree" (`reviewFits`) and fails closed on no verdict). A second gate plugin
(a security scanner, a coverage threshold, a PerfLoop budget) is the same shape: it registers for `verify.starting`
and returns a verdict; the kernel ANDs verdicts. The verdict format `{passed, reasons[]}` and the 20×500-char caps stay
kernel rules. `tests/scenarios/review.test.ts` is the regression gate.

## 8. Migration plan

*Refined in spec §17.2 (13 steps, with jobs, triggers and the watchdog interleaved); this is the original plan.*

Small, shippable steps; each leaves `bun run typecheck`, `test:fast` and `test:scenarios` green and adds its own tests.
No step changes the `relay.v1`/`capcomd.v1` CLI output or the `harness.v1` contract except by adding a capability.
Every step that turns a built-in into a plugin keeps a **real-composition test**: the daemon booted with that plugin
through the host (not the plugin's functions called directly), on the fake sandbox with scripted agents, asserting
user-visible output (dsh's rule for product-visible plugins, research §2.10; `tests/scenarios/` already works this way).

1. **The host, in-process only, with zero plugins.** `src/plugins/host.ts`: manifest schema (zod), load order, hook
   registry with modes, timeouts, the circuit breaker, `plugin.*` events, `GET /v1/plugins` (capability `plugins`),
   `capcomd plugins list`. Tests: `tests/plugins/host.test.ts` (ordering, chaining, veto short-circuit, fail-closed vs
   fail-open, timeout, breaker), `tests/api/contract.test.ts` for the capability, and two rules borrowed from dsh
   (research §2.10): a **dispose test** for every registry (deactivate a plugin, assert every command, tool, route,
   descriptor and hook it registered is gone) and a **mode-consistency test** (every `host.hooks.fire(name, …)` call
   in `src/` uses the mode the hook table declares; a grep-based script in `scripts/`, run by `test:fast`).
2. **Fire the hooks from the kernel** without any listener: `agent.*`, `run.*`, `verify.*`, `merge.*`, `approval.*`,
   `sandbox.*`, `message.*`, `daemon.*` at the places named in §5. Tests: a scenario with a recording test plugin that
   asserts the order in §5.2 for one agent, one verify and one merge (`tests/scenarios/hooks-order.test.ts`); the
   existing scenarios prove nothing else moved.
3. **Sandbox providers as built-in plugins** (§7.1, §7.2). `PROVIDERS` is derived; `dependencies.ts` asks the host.
   Tests: `tests/providers/*` unchanged; `descriptors.test.ts` asserts the derived list equals today's; the conformance
   suite is wired to `capcomd plugins validate --conformance`.
4. **Agent providers as built-in plugins**: `AgentAdapter` becomes a plugin's `provides.agent`; `Provider` in
   `profiles.ts` becomes "a registered agent plugin's name" (validated against the registry, built-ins `claude`,
   `codex`). Tests: `tests/agents/claude-code.test.ts`, `codex.test.ts`, `profiles.test.ts` unchanged; one test that an
   unknown provider is refused at `validate`.
5. **Gates as plugins** (§7.4): `gate-checks`, `gate-reviewer`. Tests: `tests/primitives/verify-merge.test.ts`,
   `tests/scenarios/review.test.ts`, plus a second test gate that fails and shows the AND.
6. **Forges as plugins** (§7.3). Tests: `tests/merge/*` with `forge-fake`; `tests/api/project-git.test.ts`.
7. **Front doors**: the MCP tool list and the CLI `switch` become registrations by built-in `front-*` plugins; the
   `hermes` writer is `front-hermes`. Tests: `tests/mcp/client.test.ts` lists the same tools; `tests/cli` passes; a test
   plugin registers one command and one tool and both answer with the `relay.v1` envelope and the caller's principal.
8. **Out-of-process runtime**: the stdio JSON-RPC transport, the filtered environment, the plugin's client token,
   restart and fail-closed on crash. Tests: a fixture plugin as a child process (the `tests/agents/fake-claude.sh`
   pattern), chaos killpoints `plugin.hook.mid` and `plugin.process.crash` in `chaos:fast` with the audit "gate denied,
   nothing landed".
9. **Install, trust, update**: `capcomd plugins install|trust|update|remove`, `LOCK`, the project trust prompt, the
   marketplace listing. Tests: a local git fixture repository, a manifest that escapes its directory is refused, a
   changed hash is reported, an untrusted project plugin never activates.
10. **Documentation and the SDK**: `@capcomd/plugin` types published from the package (`host`, hook payloads, the
    manifest), `docs/plugins.md`, and one example third-party plugin in `examples/plugins/` (a cost observer) that CI
    installs and runs against the fake sandbox.

Steps 1–2 are pure additions. Steps 3–7 are refactors behind unchanged tests. Steps 8–10 are the third-party surface,
and the first point at which the owner's trust decisions (§9) must be final.

## 9. Risks and decisions

Decided by the owner on 2026-11-04 (recorded in the spec where cited):

1. **In-process third-party plugins: no `trusted: true` for now.** Only built-ins run in-process; third-party plugins
   run out of process as harness.v1 clients. The loader is the same for both, so the option can be added later; the
   spec does not specify it (spec §5.2).
2. **Operator merges bypass plugin vetoes** the way `--operator` bypasses `--require`. The bypass is always recorded in
   the run's event log as `plugin.gate_bypassed`, naming each vetoing plugin and its reason, and `merge.changed`
   `landed` carries the same list (spec §6.5, §6.6.15).
3. **`permissions.approve` on profiles is deferred.** Approvals stay human. `approve` is not grantable to a plugin and
   there is no decide primitive; nothing in the design forecloses an ancestor-agent rule later (spec §11.1; ADR-024).
4. **Profile packages are YAML; `extends` cannot cross projects; project skills and personas get a one-time trust prompt
   per content hash** (ADR-024 §2.3, §2.5, §8).
5. **`recipes/hierarchical.ts` becomes a disabled built-in plugin**, kept for the parity eval (spec §17.1).
6. **`@capcomd/plugin` is a private workspace package**, not published to npm yet; its types are typechecked and its
   examples tested in `test:fast` (`packages/plugin`). (Superseded with §17.2 step 13: published at capcomd's version by
   the release workflow, behind a repository variable; §10.)

Decided by the owner on 2026-11-08:

7. **Third-party plugins are self-contained.** A plugin's trust hash and its `LOCK` cover its own directory only (the
   critic's C12), so a plugin whose entry, or any module it resolves, lies outside that directory (made real, so a link
   that points out is outside; its own `node_modules` is inside; `node:`, Node and Bun built-ins are allowed, and the
   kernel-provided client library `@capcomd/plugin`, read as capcomd's own copy: another copy outside the directory is
   refused like any module) is refused at `install`, `update`, `trust` and `validate`, and by the host when it
   validates the plugin and before every start of its process, naming each path. Out of process, the child's module
   loading is guarded too: a Bun and a Node preload refuse a module outside the directory as it loads. Built-ins are
   exempt. What this does and doesn't hold is in spec §4.9 and §11.6 (spec 1.0.63).

Risks that stay:

- **Latency on the hot path.** `agent.item` fires per thread item; `observe` hooks run concurrently on a bounded queue
  and are never awaited by the runner. Gates are on spawn/verify/merge/approval/trigger intake only.
- **Fail-closed gates can wedge a run.** The breaker suspends a plugin's listeners after three failures and the daemon
  stream says so; a suspended gate still denies, safely; `capcomd plugins enable` resets it; the operator merge is the
  audited escape (decision 2).
- **Two plugin systems with the same word.** `plugins/capcomd/` is capcomd *as* a plugin for Claude Code and Codex
  (ADR-018); this ADR is plugins *for* capcomd. Docs say "capcomd plugin (host)" and "agent plugin".
- **The single executable.** Built-in plugins are bundled (`assets.ts` rule); out-of-process plugins bring their own
  runtime (the launcher pattern in `plugins/capcomd/mcp/launch.mjs`: Bun, else Node).
- **Scope creep.** Spec §6.8 says what is deliberately not a hook; anything new needs a consumer first.
- The TUI and canvas (`apps/tui`, `apps/canvas`) are clients, not front-door plugins. A plugin never ships Swift: it
  ships descriptors the app renders (ADR-021; spec §4.7.5).

## 10. Decisions made in the spec

Judgment calls made while writing [docs/spec/plugin-api.md](spec/plugin-api.md), each with its reason. They supersede
the corresponding text above.

| Decision | Reason | Spec |
|---|---|---|
| The plugin receives a **context** (`PluginContext`, `ctx`), and "host" means only the loader | §4 above used `host` for both; one idea, one name | §2, §8 |
| **18 → 21 hooks, grouped as `noun.changed` with a discriminated `change`** (`run.changed`, `agent.changed`, `verify.changed`, `merge.changed`, `approval.changed`, `sandbox.changed`, `job.changed`, `trigger.changed`) instead of one hook per past-tense verb | fewer hooks; a new kind of change is a union member, not a new name; listeners switch on `change.kind` | §6.6 |
| **One mode per hook; `modify` ⊇ `veto`** (a modify listener may deny; a veto listener may not patch) | "veto, modify" on one hook was two modes; the result types say everything | §6.2 |
| `merge.requested` + `merge.gating` → **one `merge.landing`** under the target lock, with `allow \| deny \| hold` | one gate, one place; `hold` is "add a human requirement", the only way a plugin touches approvals | §6.6.15 |
| `verify.reviewing` → **`verify.judging`**: every listener is a judge returning allow/deny; the kernel ANDs them with the checks | the reviewer, a scanner and a coverage gate are the same shape; 30 min deadline because a judge may run an agent | §6.6.13 |
| **Dropped `daemon.starting`, `agent.pushing`, `message.sending`, `message.delivered`** | no listener can exist before plugins load; trailers belong to the forge's `LandRequest`; skills attach at `agent.preparing`; messages are events | §6.8 |
| **Per-listener `failure: closed \| open`** in the manifest, with gates always closed | a policy plugin on `agent.spawning` wants fail-closed; the kernel keeps the floor | §6.5 |
| **The breaker suspends listeners, not the plugin**; a suspended gate denies | disposing a sandbox provider mid-run because a hook threw would be worse than a denied merge | §6.5 |
| `permissions` → **`scopes`**: the manifest names harness.v1 scopes directly; kernel abilities (be a provider) are `provides`, registrations are `contributes` | one permission model; §6.4 above had a second vocabulary mapped onto the first | §4.5, §4.6, §4.7, §11.1 |
| **`provides`/`requires` capability ids** (`seam:…`, `source:…`, `plugin:…`, `kernel:…`) drive resolution and order | dependencies between plugins are the seams and sources; a typed id is enough, no DI container | §4.6, §6.3 |
| **Secrets are `x-secret` config properties holding references** (`env:`, `keychain:`), resolved by the kernel, readable only by the declaring plugin; built-ins follow the same rule | one mechanism for boxd's key, GitHub's token and a Slack webhook; no `secrets:read` permission | §10.3 |
| **Config is constant for the plugin's life**; per-run overrides (`x-per-run`) are run data in storage; no file watching | every listener stays a pure function of its call plus one read; reload is `disable`/`enable` | §10.2, §5.4 |
| **No hot reload of code** | a changed in-process module needs a daemon restart; out of process, `disable`/`enable` runs new code | §5.4 |
| **The forge seam owns direct pushes too** (`forge-git`), and is selected by `matches(remote)`; the kernel keeps lock, CAS, integration and checks | goal branches need `openPullRequest` even in direct mode; "direct" is a `LandRequest.mode`, not a second seam | §7.4 |
| **`classifyError` on every seam** | removes the last places the kernel names an implementation (`isBoxdAuthError`) | §7.2.3 |
| **Protocol v1 exposes only the primitives with routes**; spawn, gates, board, kv, jobs and triggers are in-process until the next protocol version | the first third-party plugins are notifiers and sources; the routes land with the kernel features they wrap | §9.6 |
| **Secrets reach a process once, in the handshake response**, never in env or argv | env is readable by `ps e`; the 0600 socket is already the trust channel | §9.3 |
| **The process speaks harness.v1 (HTTP and SSE) over a plugin socket of its own**, not JSON-RPC over stdio (§6.3 above); its token lives in the daemon's memory only | one transport, one auth and one audit for every client; the socket is bound before plugins load while the operator's opens after; a token that dies with the daemon can't outlive a crash | §9.1-§9.3 (spec 1.0.22) |
| **Gate calls to one process are one at a time; observe frames are dropped when 1 000 queue** | the modify chain needs order; observers must never block a gate | §9.4, §9.5 |
| **Ordering is `order`, then `after`/`requires` topology, then name; built-ins hold no reserved positions** | deterministic and explainable; Vite's `enforce` without numeric priorities | §6.3 |
| **Load one plugin at a time; dispose in reverse** | determinism over startup speed with a dozen plugins | §5.5 |
| **Replays re-ask gates; observers are at-least-once; `idempotencyKey` is on every call** | the kernel's workflows replay (ADR-022); listeners key their side effects | §6.7 |
| **The watchdog, sources' polls, the Docker sweep and background shell share one primitive: a job** (`exec` or `timer`) | "work that reports back later" is one thing; one durable record, one owner rule | §16.2 |
| **The trigger intake's gate is deterministic**; content judgement is the planner's | auditable record-only mode; a model in the intake would be a plugin later | §16.3.2 |
| **`tools.mode: orchestrate` is a profile capability** enforced by the agent provider's tool lists and the kernel's refusal to land an orchestrator's branch | a property of the agent for its life, not a hook; no planner special case | §16.1 |
| **The attention budget is a design rule** with a `--strict` validation warning for notifier-shaped plugins without a quiet option | the kernel can only enforce the structural parts | §16.5 |
| **Trust is given to one content hash of one plugin at one place**, kept in `<home>/trust.json`; a project's `plugins.use` entries are fetched to the user's home, never the checkout | a project can write neither the trust nor what it covers; the same plugin in another repository, or one changed file, asks again; fetching into the checkout would dirty the user's working tree | §4.8 (spec 1.0.31) |
| **An install writes the plugin's files out of the fetched commit itself** (no checkout, no submodules, no link that leaves the package), through the host's own repo | a checkout runs filters and can follow links; one fetch path (`host-git.ts`) for every network git on the host | §4.8, §11.7 (spec 1.0.31) |
| **A repository's config can neither turn plugins on nor point a secret elsewhere**: `enabled` is the user's (a project turns off only its own plugins), secret references come from the user or the environment, and a project's settings that a plugin's schema refuses are set aside unless the plugin is the project's own | §6.5 above (and 1.0.24) let the project win key by key; for `enabled` and secrets that would let a cloned repository switch off a gate or hand a plugin `GITHUB_TOKEN`, and failing a plugin `config_invalid` on a project's bad value would switch it off just the same | §10.2, §10.3, §10.4 (spec 1.0.31) |
| **`@capcomd/plugin` is published at capcomd's own version, by the release workflow, behind a repository variable** (`PUBLISH_PLUGIN_PACKAGE`; supersedes decision 6 above), built from the private workspace package (`packages/plugin/scripts/pack.ts`) | one version to reason about: `@capcomd/plugin@X.Y.Z` is the API capcomd X.Y.Z serves, and a plugin's `engines.capcomd` says the rest; the workspace package keeps pointing at the sources the kernel imports; publishing stays the workflow's (AGENTS.md), and off until the owner creates the npm scope | §14.6 (spec 1.0.34) |
| **`testkit.bootWith` runs whichever `capcomd` the author installed**, as a separate `capcomd serve` in a temp home, and takes plugin directories only | the published package can't import the kernel, and a third-party plugin is a program, never an in-memory module; a home of its own means a plugin's tests never read or touch the developer's capcomd | §14.3 (spec 1.0.34) |
