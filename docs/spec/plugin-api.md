# capcomd plugin API, version 1 (normative)

Status: **accepted** with [ADR-023](../adr-023-plugin-core.md) and [ADR-024](../adr-024-agent-profiles.md), 2026-11-04.
Types: [`packages/plugin`](../../packages/plugin) (`@capcomd/plugin`, published at capcomd's version, §14.6). Guide for
plugin authors: [docs/plugins.md](../plugins.md). API additions: in
[`openapi/capcomd.json`](../../openapi/capcomd.json) (capabilities `plugins` and `plugins.protocol`, generated from
`src/api/contract.ts`). Research: [plugin-architecture.md](../research/plugin-architecture.md).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119. Sections are numbered so ADRs,
code and tests can cite them (`§6.6.15`). Where this document and the types in `packages/plugin` disagree, the types are
wrong and this document wins; the test suite (§14) holds them together.

Contents: 1 scope · 2 glossary · 3 shapes and principals · 4 manifest · 5 lifecycle · 6 hooks · 7 seams · 8 primitives ·
9 out-of-process protocol · 10 config · 11 security · 12 versioning · 13 observability · 14 testing · 15 worked examples ·
16 super-agent primitives · 17 migration · 18 changes.

## 1. Scope

This document specifies the interface between the capcomd **kernel** and its **plugins**: what a plugin declares, how it
is loaded and unloaded, what it may call, what it is called for, how it is isolated, versioned, configured, observed and
tested. It does not specify how the kernel implements any of it, except where an implementation detail is observable to a
plugin (ordering, timing, failure handling).

Everything that gives the kernel something concrete to do is a plugin, including capcomd's own sandbox providers, agent
providers, forges, gates, front doors and observers (ADR-023 §3). There is one API for built-in and third-party plugins;
the difference is where the code runs (§5.2) and which scopes its principal holds (§11.1).

## 2. Glossary

Each term is used in exactly one sense in this document and in the types.

| Term | Meaning |
|---|---|
| **kernel** | The daemon code that is not a plugin: the Rivet actors and their SQLite (`src/actors/`), the harness.v1 gateway (`src/api/`), principals and scopes, the policy module (`src/primitives/policy.ts`), the spool and capability tokens (`src/subagents/`), redaction (`src/agents/redact.ts`), and the host. |
| **host** | The kernel component that discovers, validates, resolves, loads, runs and disposes plugins, owns every registry, fires hooks and enforces this document. |
| **plugin** | A directory with a manifest (§4) and either an in-process module or a command (§5.2). Identified by its **name**. |
| **manifest** | `plugin.json`, schema `capcomd.plugin/v1` (§4). |
| **contribution** | Something a plugin adds to the kernel: a hook listener, a seam implementation, a trigger source, a CLI command, an MCP tool, an API route, a UI descriptor, an event type, a feature flag. Every contribution is declared in the manifest (§4.7) and registered through the context (§8); every registration is a **disposable** (§5.3). |
| **context** | The one object a plugin receives, `PluginContext` (§8). Its properties are **services**. |
| **service** | A group of **primitives** on the context, named by a noun: `ctx.runs`, `ctx.jobs`. |
| **primitive** | One method of a service: `ctx.runs.get`. The unit the API surface is counted in. |
| **hook** | A named point where the kernel calls plugins (§6). A hook has one **mode**: `observe`, `veto` or `modify`. |
| **listener** | A plugin's function registered for one hook. One listener per hook per plugin. |
| **call** | One invocation of a listener: a `HookCall` (§6.1). |
| **gate** | A hook whose denial stops a kernel operation that lands or releases something: `verify.*`, `merge.*`, `approval.*`, `trigger.admitting`. Gates always fail closed (§6.5). |
| **seam** | A kernel-defined interface with exactly one implementation chosen by name per use: the sandbox provider, the agent provider and the forge (§7). |
| **source** | A plugin contribution that turns an external system's events into **triggers** (§16.3). Many may be active at once. |
| **context provider** | A plugin contribution that serves items of the context layer (a project's memory, a company's facts; ADR-025) under a name a profile's `context.providers` lists. Many may be active and a profile may name several; the kernel's **router** composes them into an agent's brief at `agent.preparing` (§6.6.7). Not a seam (§7.1): no use selects exactly one. |
| **job** | Kernel-tracked work that outlives the call that started it and reports back as events: an `exec` in a sandbox machine or a `timer` (§16.2). |
| **principal** | Who acts: `operator`, `driver`, `agent`, `viewer` or `plugin` (§3.2). |
| **scope** | A harness.v1 token scope: `read`, `steer`, `approve`, `configure` (`src/api/clients.ts` `CLIENT_SCOPES`). The word is used in no other sense here; the event envelope's `scope` field is called a **stream** below, and `src/actors/scope.ts` is "the scope actor". |
| **stream** | Where events are published: `daemon`, a run (`run-…`) or a project (`prj-…`). |
| **capability** (manifest) | A named thing one plugin `provides` and another `requires` (§4.6). harness.v1's feature flags (`GET /v1/health` `capabilities`) are called **feature flags** here. |
| **built-in** | A plugin shipped inside the capcomd package, discovered from a static list, enabled by default. |
| **third-party** | A plugin installed from a repository into the user's home or a project. |
| **untrusted text** | Text an agent or a plugin wrote. Carried as `{text, untrusted: true, by}`; rendered as plain text; never the basis of an action (§11.5). |

## 3. Shapes and principals

### 3.1 harness.v1 shapes

Hook payloads and primitive results carry the harness.v1 shapes (`src/api/contract.ts`: `Run`, `Agent`, `Decision`,
`ApprovalKind`, `ApprovalStatus`, the event envelope) and the primitives' own records (`Verification`, `Merge`,
`PinnedSpec`, `VmSpec`, `Job`, `Trigger`). `packages/plugin/src/shapes.ts` mirrors them; `test/shapes.test.ts` asserts
each mirror is assignable from the kernel's zod schema, so a contract change that breaks a payload fails `typecheck`.
The kernel's schemas MUST remain the source of truth; the mirrors MUST NOT add fields the kernel does not send.

### 3.2 Principals

```ts
type Principal =
  | { kind: "operator"; clientId: string | null }     // a human client, or the CLI on the host
  | { kind: "driver";   clientId: string | null }     // the user's agent through `capcomd mcp` (ADR-018 §4)
  | { kind: "agent";    agentId: string; runId: string } // an agent in its sandbox, through the spool
  | { kind: "viewer";   clientId: string }            // a read-only client
  | { kind: "plugin";   name: string; scopes: ("read" | "steer" | "configure")[] };
```

`plugin` and `viewer` join the union `ops.ts` and `policy.ts` already enforce on (ADR-018 §4). A plugin's own calls
carry its `plugin` principal (§11.1). A contribution that serves a caller (a CLI command, an MCP tool, an API route) runs
with the **caller's** principal, never the plugin's (§11.2). A hook call carries the principal that caused the kernel
operation, never the listening plugin's (§6.1).

## 4. The manifest

A plugin is a directory containing `plugin.json`. The schema is `packages/plugin/src/manifest.ts` (zod) and its
generated JSON Schema `packages/plugin/schema/plugin-manifest.schema.json`. The host MUST refuse a manifest the schema
refuses; `capcomd plugins validate` prints the same issues (§4.9).

### 4.1 Fields

| Field | Type | Required | Default | Rule |
|---|---|---|---|---|
| `schema` | `"capcomd.plugin/v1"` | yes | | Any other value is `invalid_manifest` (§12.2). |
| `name` | string | yes | | `^[a-z0-9][a-z0-9-]{0,62}$`. Every contribution is namespaced by it (§4.2). |
| `version` | semver | yes | | The plugin's own version. Built-ins use the capcomd package version. |
| `description` | string 1–500 | yes | | Shown by `capcomd plugins list` and the app. |
| `apiVersion` | `1` | yes | | The plugin API major (§12.1). |
| `engines.capcomd` | semver range | yes | | The capcomd versions the plugin was tested with (§4.4). `*` is refused. |
| `entry` | object | yes | | `{runtime: "in-process", module}` or `{runtime: "process", command, env?}` (§5.2). |
| `scopes` | `("read"\|"steer"\|"configure")[]` | no | `[]` | The plugin principal's scopes (§11.1). `approve` is refused. |
| `provides` | capability id[] | no | `[]` | §4.6. Every `seam:` and `source:` entry MUST match a contribution and vice versa. |
| `requires` | capability id[] | no | `[]` | §4.6. A plugin MUST NOT require itself or what it provides. |
| `order` | `pre\|normal\|post` | no | `normal` | Placement (§6.3). |
| `after` | name[] | no | `[]` | Plugins this one follows within its `order` (§6.3). Unknown names are ignored; a cycle fails resolution. |
| `contributes` | object | no | `{}` | §4.7. An in-process plugin MUST contribute at least one thing. |
| `config` | JSON Schema or `{$ref}` | no | `{type: "object"}` | §10.1. |
| `homepage`, `license` | string | no | | Informational. |

Unknown keys at any level are refused (`strict`). This is deliberate: a misspelled key is a bug, not an extension point.
Vendor data goes in `config`.

### 4.2 Namespacing

Everything a plugin contributes carries its name, so two plugins never collide and a user can tell where a thing came
from:

| Contribution | Public name |
|---|---|
| MCP tool `t` | `capcomd_<name>_<t>` |
| API route `/p` | `/v1/x/<name>/p` |
| Event type `e` | `plugin.<name>.<e>` |
| Feature flag `f` | `x.<name>.<f>` |
| kv storage key `k` (run scope) | `plugin/<name>/<k>` (a reserved kv prefix beside `_`, `approval/`, `recipe/`, `handoff/`) |
| Sandbox labels a `sandbox.ensuring` patch adds | `plugin.<name>.<label>` |
| Spans | `plugin.<name>.<op>` |
| Data directory | `<capcomd home>/state/plugins/<name>/` |

**One pattern for event types.** Every harness.v1 event type, the kernel's and every plugin's, matches
`EVENT_TYPE_PATTERN` (`packages/plugin/src/event-type.ts`; the envelope schema, `openapi/capcomd.json` and the manifest
schema are generated from it): the kernel's are dotted lowercase `noun.verb_past` (`run.created`) and never under
`plugin.` except its own two-part events about plugins (`plugin.loaded`, §13.1); a plugin's own are exactly three parts,
`plugin.<name>.<e>`, where `<name>` is the manifest's name and `<e>` a `contributes.events` entry
(`^[a-z][a-z0-9_]*$`). So any name and event the manifest allows make a valid type, the type alone says who wrote the
event, and a plugin can never write a kernel type. Past tense is the kernel's naming rule for its own types (a plugin's
SHOULD follow it), not part of the pattern: `agent.step` and `sandbox.resource_action` are nouns.

Seam names (`docker`, `claude`, `github`) and source names (`github`) are **not** prefixed: they are the names users
select by, and uniqueness is enforced at resolution (§7.1, §16.3).

**The kernel's own front doors** (§17.2 step 8) are the one exception: the built-ins the kernel's built-in list names as
its surface (`src/plugins/builtins.ts` `kernelSurface`: the CLI's `front-<group>` plugins, `front-mcp`, `front-hermes`)
register the names capcomd has always had: their tools are `capcomd_<t>` and their CLI groups are the kernel's commands
(`KERNEL_COMMANDS`). The flag is the kernel's list's, not the manifest's: the same manifest from a directory (a
third-party or a test plugin) gets the prefix and fails the command collision check. They are placed `order: pre`, so a
plugin whose prefixed tool name happens to equal one of theirs (`capcomd_pr_open` from a plugin `pr`) loses it: its
registration is `conflict` (§4.7).

### 4.3 Entry forms

Exactly one form per plugin. The export-form rule is strict because a wrong form fails silently in other systems
(research §2.4): an in-process module MUST have a named export `plugin` of type `PluginModule` (§5.1). A default export is
ignored and `capcomd plugins validate` warns about it.

### 4.4 `engines` compatibility

The host compares `engines.capcomd` with the running version (`src/utils/self.ts` `VERSION`) with semver range
semantics, prereleases included. Outside the range the plugin is `failed(incompatible)` and a `plugin.version_refused`
event names both values. An operator MAY record an exemption for one exact `name@version` with
`capcomd plugins allow-version <name@version> --accept-risk` (kept in `<home>/plugins/compatibility.json`); the
exemption applies only to that version, and the daemon's host honours it at validation (`src/plugins/install.ts`
`isExempt`). The same check runs before `capcomd plugins install`, which refuses an incompatible plugin and names the
`allow-version` command. `*` is refused at validation so that "tested with everything" cannot be claimed.

### 4.5 Scopes

§11.1. The manifest's `scopes` are the harness.v1 scopes minted into the plugin's token (out of process) or checked
on every `ctx` call (in process). A plugin with no scopes can still answer hooks and implement seams; it cannot call
`ctx.runs`, `ctx.agents`, `ctx.gates`, `ctx.board`, `ctx.kv`, `ctx.messages`, `ctx.jobs`, `ctx.triggers.subscribe`
or `ctx.events.emit`.

### 4.6 Capabilities: `provides` and `requires`

A capability id is one of:

| Form | Means |
|---|---|
| `seam:sandbox/<n>`, `seam:agent/<n>`, `seam:forge/<n>` | An implementation of that seam under name `n` (§7). |
| `source:<n>` | A trigger source named `n` (§16.3). |
| `context:<n>` | A context provider named `n` (ADR-025 §3.1), what a profile's `context.providers[].name` selects. |
| `plugin:<n>` | The plugin `n`, active. Every plugin provides `plugin:<own name>` implicitly. |
| `kernel:<feature>` | A kernel feature by its harness.v1 feature-flag name (`kernel:runs.goal_branch`). |

Resolution (§5.4) fails a plugin whose `requires` names a capability no active plugin or the kernel provides
(`unresolved`), and orders providers before requirers (§6.3). Two active plugins MUST NOT provide the same `seam:` or
`source:` id (`seam_conflict`; the later one in load order fails), nor register the same context provider name (`conflict`
at `ctx.context.register`, so the later one in load order fails activation).

### 4.7 Contributions

`contributes` is declarative: the host reads it at `validated`, before any code runs, so `capcomd plugins list`, the
app and the MCP server can describe a plugin without loading it (VS Code's `contributes`, research §4). The code MAY
register only what the manifest declares; a registration not declared is `conflict` and fails activation (§5.4). A
declaration the code never registers is a warning in `capcomd plugins validate --strict` and an error in the conformance
suite (§14.1), and the host logs it at each activation (`declared but never registered`): a listener that matters only
under some settings is registered anyway and does nothing without them, as the built-ins' `job.changed` listeners do
(forge-github with no `sourceRepos`, source-schedule with no schedules, sandbox-boxd with the template refresh off).

| Key | Item | Registered through |
|---|---|---|
| `hooks` | `{ [hook]: { timeoutMs?, failure? } }` (§6) | `ctx.hooks.on` |
| `seams` | `{ kind, name }`, at most one per kind (§7) | `ctx.seams.sandbox/agent/forge` |
| `sources` | `{ name, summary }` (§16.3) | `ctx.triggers.emit` (no registration call: emitting names the source) |
| `context` | `{ name, kinds: ("fact" \| "memory")[] }`, each also in `provides` as `context:<name>` (ADR-025 §3.1) | `ctx.context.register(impl)`: `impl.describe().name` is the declared name; in process only in protocol v1, like the seams |
| `cli` | `{ name, summary }` (§4.7.1) | `ctx.cli.command` |
| `mcp` | `{ name, summary }` (§4.7.2) | `ctx.mcp.tool` |
| `api` | `{ method, path, scope }` (§4.7.3) | `ctx.api.route` |
| `ui` | `{ kind, id }` (§4.7.5) | `ctx.ui.descriptor` |
| `events` | type names (§4.7.4) | `ctx.events.emit` |

#### 4.7.1 CLI commands

A command group `capcomd <name> …`. `name` MUST NOT be one of the kernel's commands (`KERNEL_COMMANDS` in
`packages/plugin/src/load.ts`: the ones the dispatcher answers itself, `serve`, `plugins`, `help`, `version`, `tui`, and
the ones the kernel's own front doors register, `run`, `spawn`, `verify`, `merge`, `profiles`, `agents`, `sandbox`, `setup`, `mcp`,
`hermes`, …, §4.2); the host keeps the list and refuses a collision at validation. The handler receives the words after
the command name, the parsed flags, whether `--json` was given, the caller's principal (the operator, on the host's CLI)
and an `AbortSignal` (SIGINT; a second SIGINT, or 5 s without an answer, ends the process), and MUST return a `relay.v1`
envelope (`src/core/errors.ts` `SCHEMA`), or throw a `PluginError` which the CLI prints as `{schema, ok: false, error}`
with the matching exit code (`src/core/errors.ts` `EXIT`: `invalid`, `forbidden` and `widening` are usage, 2;
`not_found`, 3; `unsupported`, config, 2; the rest 1) and `reason: "plugin:<name>"` (`forbidden` keeps `forbidden`). The
CLI prints the envelope as one JSON line with `--json`, else its `text` when that is a string, else the envelope as JSON.
Flags: `--k v` (the next word, unless it starts with `-`), `--k=v`, a flag of the kernel's table keeps its type (so
`--json` takes no value), a flag given twice is a list, `--` ends them. `capcomd <name> --help` prints the command's
`usage`; `capcomd --help` lists every plugin's command after the kernel's.

The CLI dispatcher is the kernel's (`src/cli/index.ts`, `src/cli/front-doors.ts`). It answers its own commands itself and
looks every other one up among the registrations of the process's plugin host (`src/plugins/host.ts` `localHost`: the
built-ins every process loads, the front doors among them). A kernel front door's command is parsed with the kernel's
own flag table (a misspelled flag is a usage error before anything runs), prints its own output (the kernel's text, its
streams, its prompts) and MAY answer `{exit: number}` (`CliExit`) instead of an envelope; from any other plugin that is an
error. An in-process command runs in the CLI's own process, so only a built-in's (or, under `bun test`, a
`CAPCOMD_TEST_PLUGINS` directory's) can. A third-party plugin runs out of process, and protocol 1 carries no command (§9.6):
its manifest can't declare one (§4.9), so no command of it can run host code, with or without the host.

#### 4.7.2 MCP tools

`capcomd_<name>_<tool>` on the `capcomd mcp` server (`src/mcp/server.ts`), with a JSON Schema for its arguments (an
object schema, draft 2020-12 or draft-07: any other is `invalid` at registration, and one the server can't read leaves
that tool out of the listing), an optional `title` and `_meta`, and the MCP annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`). The server lists the schema exactly as registered, checks a call's
arguments against it (the MCP SDK's validation error when they don't fit) and drops properties it doesn't name, so a
client's extra argument never reaches the handler. The handler runs with the **driver** principal and the driver policy
(`src/mcp/driver.ts`), returns a `relay.v1` envelope, and MUST answer within 55 s (`WAIT_MAX_MS`): MCP clients time out
at 60 s. A thrown `PluginError` is the `relay.v1` error, coded as on the CLI (§4.7.1), with `isError`.
`ctx.mcp.instructions` appends text to the server's instructions under a heading `## <name>`; it SHOULD be short (§16.5).
capcomd's own tools are front-mcp's registrations (`src/mcp/tools.ts`, as `capcomd_<tool>`, §4.2) and its instructions
come first, without a heading. The tools are served in the process that runs `capcomd mcp` (its plugin host's
registrations); a call's session (its MCP server, for elicitation, and the servers it started for other projects) is the
kernel's own and reaches only front-mcp's handlers.

#### 4.7.3 API routes

`METHOD /v1/x/<name>/<path>`. The gateway (`src/api/server.ts`) authenticates the caller, checks the route's declared
`scope` against the caller's token, parses JSON, runs the handler with the caller's principal, and maps a thrown
`PluginError` to a status: `forbidden` 403, `not_found` 404, `conflict` 409, `invalid` 422, `unavailable` 503, anything
else 500 with the message replaced by "plugin error" (the message goes to the daemon log). Routes are not in
`openapi/capcomd.json`; `GET /v1/plugins/{name}` lists them. A route MUST NOT serve SSE (streams are the kernel's; a
plugin publishes events instead).

#### 4.7.4 Events

`plugin.<name>.<type>` on the `daemon` stream or a run's. Durable, so they are replayed by `GET /v1/events` and the
SSE stream like any kernel event; `ephemeral` is refused (`unsupported`) until the host can send events live only. The
envelope's `entity` is the one the plugin names, else `plugin:<name>`; a run that doesn't exist is `not_found`. `data` is redacted (§11.5) and capped at 64 KB.
`text` is the plugin's own sentence; the kernel does not write it for plugin events, and the envelope's `text`
description in the contract tells clients to render a plugin's own event text as plain text, never markdown, links or
actions (the type alone says it is a plugin's: three parts under `plugin.`, `eventTypeOwner`).

#### 4.7.5 UI surfaces

Descriptors the app renders generically, so a plugin never ships Swift (ADR-021 §2; ADR-023 §9): `settings` and
`info` rows (the `SandboxField` shape of `GET /v1/sandboxes/{name}`), `action` (a resource action with a daemon-written
`confirm`), `card` (a few lines with a state dot on the run or settings screen) and `profile-field` (how an ADR-024
`x-<plugin>` block is shown and edited). Every string a descriptor shows is the plugin's and is rendered as plain text.

### 4.8 Discovery

In this order; a later manifest with a name already seen is refused with `plugin.duplicate_refused` (no shadowing):

1. **Built-ins**: a static list in the capcomd package, bundled into the single executable (`src/utils/assets.ts` rule:
   import, never `readFileSync` a package file).
2. **User**: `<home>/plugins/<name>/plugin.json`, installed by `capcomd plugins install <owner/repo>[#<name>][@<ref>]`,
   with a `LOCK` file (source, commit, per-file sha256). The daemon discovers them from §17.2 step 9 (in name order; the
   operator put them there), and runs them out of process; a CLI's local host lists them and runs none (§9.2).
3. **Project**: `.capcomd/plugins/<name>/plugin.json`, or `.capcomd/config.json` `plugins.use: ["owner/repo#name@ref"]`.
   A project plugin is `validated` but not `resolved` until the operator trusts its content hash once
   (`capcomd plugins trust <name>`; event `plugin.trusted`), because opening a repository MUST NOT run code on the host.
   A changed hash resets trust.

`plugins.<name>.enabled: false` in config (§10) keeps a discovered plugin at `validated`. A built-in is enabled by
default except one a person turns on: the watchdog (§16.4) is listed but held at `validated` (`disabled`) until
`plugins.watchdog.enabled: true`, which `capcomd setup` writes (`src/plugins/builtins.ts` `off`).

**Installing** (§17.2 step 12, `src/plugins/install.ts`, `src/install/`). The source is `owner/repo` (GitHub), a git URL
or a local repository path, with `#<name>` choosing one plugin among several (else the repository's root `plugin.json`,
else its only one) and `@<ref>` a branch, tag or commit (else the remote's `HEAD`). The host fetches it through its own
host repo (`src/merge/host-git.ts`, §11.7) and writes the plugin directory's files out of the commit itself: no checkout,
hooks, filters or submodules, no link that leaves the directory, nothing written through a link or over a file already
written (paths that differ only in case or normalization, which macOS reads as one), at most 5 000 files and 100 MB.
`install` refuses a
manifest §4.9 refuses (a `command[0]` or `$ref` resolving outside the directory among it), an `in-process` plugin
(§5.2), a built-in's name, a name already installed, and an incompatible one (§4.4). `LOCK` (JSON, schema
`capcomd.lock/v1`) records `kind`, `name`, `version`, `source`, `remote`, `ref`, `commit`, `path` (the directory in the
repository), `files` (each file's `sha256` and git `mode`) and `hash`, the **content hash**: sha256 over the sorted
`path, mode, sha256` of every file but `LOCK` (a link counts as its target). `capcomd plugins update <name>` fetches
again from the LOCK's source and reports the changed, added and removed files, the old and new commit and hash, and any
file edited since the install, before replacing it (`--dry-run` stops there); a tag or commit stays put, a branch moves.
`capcomd plugins remove <name>` removes the files and any trust given to them; the plugin's data directory stays. The
running daemon picks up any of these at its next start or the plugin's `enable` (§5.4: `enable` reads a plugin's
directory again). A profile package (ADR-024 §7 step 7, `capcomd profiles install|update|export`) is fetched and
locked the same way, with `kind: "profile"` in its `LOCK` and the same content hash.

**Trusting** a project's plugins. `capcomd plugins install --project [<source>]` adds the source to `plugins.use` and
fetches every entry into the user's home (`<home>/plugins/.project/<key>/<name>/`, keyed by the project's directory),
never into the checkout; an entry not fetched yet isn't discovered. A `.capcomd/plugins/<name>/` that is a link out of
the checkout (to another project's plugin) isn't one of the project's plugins. Trust is given to one content hash of one
plugin at one place (its directory, made real) and kept in `<home>/trust.json` (0600), which no project can write: a
changed file, or the same plugin copied to another project, needs trusting again. In a checkout the hash covers every
file, a `LOCK` there included (only a copy capcomd installed leaves out the `LOCK` it wrote). `capcomd plugins trust
<name>` is the prompt: it shows what would run (the command, the scopes its token gets, the hooks it answers, the secret
references it is given, its directory and hash; the manifest's text with control and format characters shown escaped,
so it can't redraw the prompt) and asks;
`--yes` answers for a script (without a terminal it is required). An untrusted project plugin is listed `validated` with
cause `untrusted` and `enabled: false`, and stays there through `enable`; without a trust check (any host but the
daemon's) none runs. The daemon writes `plugin.trusted {plugin, source: "project", hash, by}` the first time it runs a
plugin under a trust (the CLI that records it can't write the daemon's stream); a CLI's listing doesn't use that up. A
project's `plugins.use` and config are not read with `CAPCOMD_NO_CONFIG`; its own `.capcomd/plugins/` always is.

### 4.9 Validation

`capcomd plugins validate [dir]` (and the test kit, §14.5) runs the schema, the cross-field rules in
`PluginManifest.superRefine`, path containment (a `module`, `$ref` or `command[0]` under `./` MUST resolve inside the
plugin's directory), the `engines` check, the kernel-command collision check, the out-of-process rule (a `process`
plugin contributes hooks and events only: `seams`, `sources`, `context`, `cli`, `mcp`, `api` and `ui` are refused, as protocol 1
carries none of them, §9.6) and, with `--conformance`, the seam suites (§14.2). Output is a list of `{path, message}`;
the exit code is 1 on any error.

## 5. Plugin lifecycle

### 5.1 Module and activation

An in-process entry module exports `plugin: PluginModule`:

```ts
interface PluginModule<C> { activate(ctx: PluginContext<C>): void | Promise<void> }
```

`activate` is called exactly once per load. It registers contributions and returns; it MUST NOT start long work of its
own (use a `daemon.started` listener or a job). There is no `deactivate`: cleanup is `ctx.onDispose` and the automatic
disposal of every registration (§5.3). `definePlugin` is an identity function that infers `C`.

### 5.2 Runtimes and trust

| Runtime | Who | Where the code runs | Isolation |
|---|---|---|---|
| `in-process` | **built-ins only** (ADR-023 decision 1) | the daemon process | none beyond scope checks on `ctx` |
| `process` | third-party plugins | a child process the host starts | a filtered environment, a scoped token, the harness.v1 API (§9) |

A third-party manifest with `entry.runtime: "in-process"` is `failed(untrusted)`. The design leaves the door open (the
host's loader is the same for both; a future `plugins.<name>.trusted` key could lift the rule), but this version does
not specify such an option.

### 5.3 Registrations and disposal

Every registration (`ctx.hooks.on`, `ctx.seams.*`, `ctx.cli.command`, `ctx.mcp.tool`, `ctx.mcp.instructions`,
`ctx.api.route`, `ctx.api.capability`, `ctx.ui.descriptor`, `ctx.events.subscribe`, `ctx.onDispose`) returns a
`Disposable`. The host records each in order. On unload it:

1. aborts `ctx.signal`;
2. stops delivering hook calls to the plugin (calls in flight run to their deadline; §6.5 applies to their outcome);
3. disposes every outstanding registration in **reverse registration order**, awaiting each, with a 10 s budget for the
   whole list (`dispose_timeout` after it; remaining registrations are dropped without awaiting);
4. runs `onDispose` callbacks (they are registrations, so they run in the same reverse order, interleaved);
5. for a `process` runtime, sends `session.closing`, waits up to 5 s for the process to exit, then SIGTERM, then SIGKILL
   after 5 s more.

A disposed registration MUST be inert: a disposed hook listener is never called again, a disposed tool is not listed, a
disposed seam is no longer selectable (a run already using it keeps the object it holds until the run's current operation
ends; §7.1). Disposing twice is a no-op. The conformance suite proves all of this (§14.1).

### 5.4 The state machine

```
discovered → validated → resolved → loading → active → disposing → disposed
     │            │           │          │         │
     └─ failed ◄──┴───────────┴──────────┴─────────┘
```

| State | Entered when | Leaves by |
|---|---|---|
| `discovered` | the manifest file was found (§4.8) | parse and validate → `validated`; else `failed(invalid_manifest)`; a second manifest of the same name → `failed(duplicate)` |
| `validated` | the manifest passed §4.9, `engines` passed (§4.4) | config `enabled: false` or untrusted project code: stays here (listed, `enabled: false`); else → `resolved` when its `requires` are satisfiable; else `failed(unresolved \| cycle \| seam_conflict)`; config invalid → `failed(config_invalid)` (§10.4); `engines` outside range → `failed(incompatible)` |
| `resolved` | dependencies, order and config are fixed | the host loads it in order (§5.5) → `loading` |
| `loading` | in-process: the module is imported and `activate` runs; process: the child is spawned and the handshake (§9.3) is pending | `activate` returned and every declared contribution is registered → `active`; `activate` threw → `failed(activate_threw)`; 30 s passed → `failed(activate_timeout)`; the process exited or did not open a session within `connectWithinMs` → `failed(handshake_timeout \| crashed)`; an undeclared registration → `failed(conflict)` |
| `active` | the breaker (§6.5) suspends the plugin's hooks without leaving this state | `capcomd plugins disable`, daemon stop, a replaced out-of-process session → `disposing`; the process crashed past its restart budget (§9.5) → `failed(restart_limit)` |
| `disposing` | §5.3 is running | done → `disposed`; over budget → `disposed` with `dispose_timeout` recorded |
| `disposed` | terminal for this daemon lifetime, except: | `capcomd plugins enable` → back to `validated` and onward (a fresh module import is **not** performed in-process: the same module instance's `activate` runs again; out of process a new child runs, so its code may differ) |
| `failed` | with a `PluginFailureCause` | `capcomd plugins enable` → `validated` and onward; a `failed` plugin's partial registrations are disposed as in §5.3 before the state is entered, except `restart_limit`'s listeners, which stay held until `enable` or `disable` (§9.5) |

A plugin in `failed` or `disposed` keeps appearing in `GET /v1/plugins` with its `cause`, so an app can explain why a
feature is missing. **There is no hot reload of code.** A changed in-process module takes effect at the next daemon
start. A changed out-of-process plugin takes effect at `capcomd plugins enable` after `disable` (or `capcomd plugins
reload <name>`, which is the pair). A changed config takes effect the same way (§10.2); the host does not watch files.

### 5.5 Daemon start and stop ordering

Start (`capcomd serve`, `src/cli/commands/serve.ts`):

1. The engine starts and the kernel's actors are reachable.
2. The host discovers, validates and resolves every plugin (§5.4), producing one total load order (§6.3).
3. Plugins load **one at a time** in that order. A failure does not stop the others; plugins that `require` the failed
   one fail `unresolved`.
4. The harness.v1 gateway starts listening. Out-of-process plugins connect during step 3 already (the socket for them is
   bound before step 3; the operator's socket accepts clients only after step 4, so a client never sees a half-loaded
   daemon).
5. `daemon.started` fires (observe) with the final plugin list.

Stop (a signal, `capcomd service stop`, an upgrade):

1. `daemon.stopping` fires (observe, 5 s budget) with the reason.
2. The host stops firing hooks: an in-flight gate call runs to its deadline; a gate that would fire now is **denied**
   with reason `daemon stopping` (the kernel is not starting new verifies or merges anyway). A gate no plugin listens
   to does not fire, so nothing is denied: a daemon without plugins stops as it always did.
3. Plugins dispose in **reverse load order** (§5.3). Out-of-process plugins can still call the API during their own
   disposal.
4. The gateway closes.
5. Actors drain and the engine stops (today's `stopEngine`).

### 5.6 Errors and failure causes

Every error a plugin sees or raises is a `PluginError` with a code from `PLUGIN_ERROR_CODES`: `forbidden`,
`unsupported`, `widening`, `invalid`, `conflict`, `not_found`, `disposed`, `timeout`, `unavailable` (the last is the only
retryable one). Why a plugin failed is a `PluginFailureCause` (§5.4 table). Why a hook call produced nothing is a
`HookFailureKind`: `timeout`, `threw`, `crashed`, `invalid_result`, `disconnected`, `suspended` (§6.5). All three are
closed enums in `packages/plugin/src/errors.ts`.

## 6. Hooks

### 6.1 Model

A hook is a named point in a kernel operation. The kernel fires it; plugins listen. A plugin MUST NOT fire a kernel hook
(there is no primitive for it) and MUST declare each hook it listens to (§4.7). Hooks fire from the kernel only, at the
sites named in §6.6: `src/primitives/ops.ts` (spawn, verify, merge, send, cancel), `src/actors/agent-workflow.ts` (the
agent's phases), `src/api/server.ts` (approvals, run creation), the host (daemon, plugins), the jobs and triggers
services (§16).

A hook fires in the process its kernel operation runs in, and only the daemon has a plugin host. The scope actor's
changes (every `*.changed` hook), the sandbox calls, the agent's phases, `merge.landing` (under the target's lock) and
everything an agent asks from its VM run in the daemon. An operation a CLI or the MCP server runs against the engine
itself (`capcomd run new`, `spawn`, `verify`, `merge`, `approve` from the host shell or `capcomd mcp`) fires its
`ops.ts` gates in that process, where nothing listens. Since §17.2 step 8 those commands and tools are front doors'
registrations, but they still run in the process that serves them; sending their operations through the daemon is not
part of this version (a later step; until then a third-party plugin's gates judge only what the daemon runs).
The exception is the built-in gates the kernel's own contract depends on (the reviewer gate, §15.3): before a verify
runs, a process that isn't the daemon starts them in a local host of its own (`src/plugins/hooks.ts` `gates()`; in
tests also `CAPCOMD_TEST_PLUGINS`), so a run's reviewer judges every verify wherever it runs; the daemon's verifies wait
for its host to start instead. Such a local host writes no daemon-stream events; its gate events go on the run's stream.
With no listener a site builds no payload and awaits nothing (`HookRegistry.listening`). The same holds for the
built-ins every process loads (`everyProcess` in `src/plugins/builtins.ts`): the front doors, the forges, the reviewer
gate and the orchestration skill; an attempt prepared outside the daemon (a run's driver) waits for that local host, and
one the daemon prepares before its plugins have loaded (an agent resumed at start) waits for them, so an agent that may
spawn always gets its skill (§6.6.7).

Every call is a `HookCall<N>`:

| Field | Meaning |
|---|---|
| `callId` | Unique per invocation. The answer key out of process (§9.4). |
| `hook`, `mode`, `payloadVersion` | What is being asked, how (§6.2), and the payload's shape version (§12.3). |
| `idempotencyKey` | `<hook>:<entity id>:<attempt>`; the same across kernel replays of the same decision (§6.7). |
| `deadline` | Absolute. After it the host applies the failure policy (§6.5) whatever the listener returns. |
| `signal` | Aborted at the deadline and when the plugin disposes. In-process only; out of process the deadline is the signal. |
| `trace` | The run's trace id (`sha256("trace:"+runId)`, `src/utils/tracing-simple.ts`) and the call's span id (§13.4). |
| `principal` | Who caused the operation (§3.2). Never the listening plugin. |
| `runId`, `agentId`, `at` | Where and when. |
| `deprecated` | Present while the hook is deprecated (§12.4). |
| `payload` | The hook's typed payload (§6.6). Agent-written text inside it is `Untrusted`. |

Payloads are passed **by value**: a listener that mutates `call.payload` changes nothing; only a `patch` changes
anything, and only in `modify` hooks.

### 6.2 Modes and results

| Mode | When | Listener returns | Dispatch | Result |
|---|---|---|---|---|
| `observe` | after the fact | nothing (ignored) | all listeners **concurrently**, never awaited by the kernel operation | none |
| `veto` | before the fact | `{decision: "allow"}` or `{decision: "deny", reason, reasons?}` | listeners **in order** (§6.3), serially; the first deny stops the chain | the operation proceeds or is refused with `reason: "plugin:<name>"` and the plugin's text as `hint` (`src/core/errors.ts` RelayError) |
| `modify` | before the fact | `{decision: "allow", patch?}` or a deny | in order, serially; each listener sees the payload **with the previous patches applied**; the first deny stops the chain | the kernel validates the merged patch (§6.6 says per hook what may change; a widening is refused with `widening`, naming the plugin) |

`modify` ⊇ `veto`: a modify listener may deny. `veto` listeners cannot patch (a patch in a veto answer is
`invalid_result`). `merge.landing` adds a third decision, `hold` (§6.6.15). No hook has two modes; a hook that needs to
veto and patch is `modify`.

Observe listeners run on a bounded queue per plugin (1 000 calls). When it is full the oldest observe calls are dropped;
drops are counted in the plugin's stats and, out of process, in `hook.dropped` frames (§9.5); they never raise
`plugin.hook_failed`. Gate and modify calls are never dropped.

### 6.3 Ordering

For one hook, listeners run in this order, which is total and deterministic:

1. by the plugin's `order`: `pre`, then `normal`, then `post`;
2. within an `order`, by the topological order of `after` edges and `requires` edges (a provider before its requirers);
   a cycle fails the later plugin in discovery order with `cycle`;
3. ties by plugin name, byte order.

This order is also the **load order** (§5.5) and, reversed, the dispose order. Built-ins are placed like any other
plugin; the kernel does not reserve positions. A plugin that must see every other plugin's patch declares `order: post`.

### 6.4 Timeouts

Each hook has a default and a maximum deadline (`HOOKS[name].timeoutMs`). A manifest MAY lower the default per hook
(`contributes.hooks[h].timeoutMs`) and MUST NOT exceed the maximum (validation refuses it). Defaults: `observe` 30 s
(`agent.item` and `job.changed` 5 s), `veto` and `modify` 10 s, `verify.judging` 30 min (max 60 min; a reviewer agent
runs inside it), `daemon.stopping` 5 s. The 60 s ceiling on gates other than judging exists because an MCP client's tool
call times out at 60 s (ADR-018 §3) and a verify or merge answers inside one.

### 6.5 Failure policy and the circuit breaker

A call **fails** when the listener throws, returns a result of the wrong shape, a `modify` patch widens, the deadline
passes, the process crashed or is disconnected, or the plugin's hooks are suspended. Each failure is a
`plugin.hook_failed` event with its `kind` and `effect`.

| Hook class | `failure` | Effect of a failed call |
|---|---|---|
| gate (`verify.*`, `merge.*`, `approval.*`, `trigger.admitting`) | always `closed` | the operation is **denied** (`effect: denied`), with `plugin:<name>` as the reason. A manifest declaring `open` on a gate is refused. |
| other `veto`/`modify` (`run.creating`, `profile.resolved`, `agent.spawning`, `agent.preparing`, `sandbox.ensuring`) | default `open`; MAY declare `closed` | `open`: the listener is skipped and the chain continues (`effect: skipped`); `closed`: denied as above |
| `observe` | always `open` | skipped |

**Breaker.** Three consecutive failed calls (any hooks) suspend the plugin's listeners: `plugin.suspended`, state stays
`active`, `hooksSuspended: true`. While suspended, a gate listener counts as a failed call every time (so a suspended
gate denies, safely), an open listener is skipped. Seams, commands, tools and routes are unaffected. `capcomd plugins
enable <name>` (or `POST /v1/plugins/{name}/enable`) resets the breaker (`plugin.resumed`); a daemon restart does too.
The count resets on any successful call.

**Operator bypass** (ADR-023 decision 2). `capcomd merge --operator` lands without a passing verify and **without plugin
vetoes**: `merge.landing` still fires and every listener is asked, a deny or hold not stopping the chain (the
registry's `askAll`), so all their decisions are known; but a `deny` or `hold` does not stop the merge. The kernel records `plugin.gate_bypassed {hook, entity, by, plugins: [{plugin, reason}]}` on the
run's stream, naming each vetoing plugin, and `merge.changed` `landed` carries the same list as `bypassedVetoes`. No
other gate has a bypass. A plugin cannot bypass (`ctx.gates.merge` has no `operator`).

### 6.6 The catalog

Twenty-one hooks. Each entry: mode · fires where · payload · patch (modify) · justification. Names follow harness.v1's
convention: `noun.verb-ing` before the fact, `noun.changed` with a discriminated `change` after it (ADR-023 §5.1;
decision: one `changed` hook per noun instead of one hook per past-tense verb, so a new kind of change is a new union
member, not a new hook).

#### 6.6.1 `daemon.started` · observe · the host, after §5.5 step 4
`DaemonStarted {version, api: {socket, capabilities}, plugins[], sandboxes[]}`. For plugins that start their own loops
(the Docker sweep) and notifiers. Fires once per daemon lifetime.

#### 6.6.2 `daemon.stopping` · observe · the host, §5.5 stop step 1
`DaemonStopping {reason: signal|operator|upgrade|error, deadline}`. Flush and say goodbye; 5 s.

#### 6.6.3 `run.creating` · modify · `ops.runNew` before the scope's `init`; `POST /v1/runs` before `runNew`
`RunCreating {options: RunCreateOptions}`. Patch `{label?, budget?, sandbox?}`: `budget` may only lower each unit;
`sandbox` must be a listed, available provider (available: an active plugin provides its seam, §7.2); `checks`, `reviewer`, `target` and `goalBranch` are the operator's and
read-only (ADR-018 §4). For cost caps and run policies. Fires once per run. At `POST /v1/runs` (the daemon, before
it starts `capcomd run`) only `sandbox` applies: the request has no label or budget to lower, so such a patch there
is `invalid_result`.

#### 6.6.4 `run.changed` · observe · after the run's event is committed
`RunChanged {run, change: created|started|paused|resumed|titled|ended{state, reason}}`. Notifiers, the runs index,
cost observers.

#### 6.6.5 `profile.resolved` · modify · `ctx.profiles.resolve` (ADR-024 §3), before `spawnChecks`
`ProfileResolved {profile: {name, version, source}, spec, overrides}`: `profile` is the resolved profile's (its
`version`, else 1; `source`, the layer it was found in, ADR-024 §2.3). Patch: a `ProfilePatch`, validated by
`src/profiles/v1.ts` `widenings()` exactly as a user override is; a widening is refused with `widening`. A cost
plugin lowering `maxBudgetUsd`, PerfLoop attaching nothing here (skills go through `agent.preparing`). Fires on every
resolution, so the patch MUST be a pure function of its inputs.

#### 6.6.6 `agent.spawning` · modify · `ops.spawnAgent` after `spawnChecks`, before the scope's `spawn` transaction
`AgentSpawning {spawn: SpawnRequest, spec, parent}`. Patch `{budget?, grant?, contract?}`: `budget` and `grant` narrow
only (`policy.ts` `applyGrant`); `contract` may add keys, never change one; `task` is agent text and immutable. Deny
refuses the spawn with `plugin:<name>`. Team-shape policies, fan-out caps. Once per spawn.

#### 6.6.7 `agent.preparing` · modify · workflow `prepare` (`agent-workflow.ts`), before the machine is ensured
`AgentPreparing {agent, spec, prompt: {system, append, skills[]}, env: names[], egress[], credentialMode, sandbox}`.
`spec` is the agent's pinned spec with `profile: {name, version, source}` when the agent recorded one at spawn (as
`profile.resolved` had it; `agent.profileVersion` and `agent.profileSource` say the same), and its profile's runtime
blocks when it has them (ADR-024 §7 step 8: `mcp`, `sandboxProvider`, `environment`, `size`, `lifecycle`; additive).
`sandbox` is where its machine is made: `provider`, its profile's `sandbox.provider`, else the run's, else the
daemon's; `environment`, its profile's `sandbox.environment`, else null (the sandbox's current build). Patch
`{prompt?: {append?, skills?}, env?, egress?}`: `append` is appended after the profile's own (never replaces); `skills` are added (pinned by hash, `src/agents/skills.ts`); `env` adds variables whose names match `^[A-Z][A-Z0-9_]*$`
and are not already set, and whose values match no secret pattern (`src/agents/redact.ts`); `egress` may only remove
hosts. **The only place a plugin adds prompt text**: the orchestration skill (`src/subagents/skill.ts`) and ADR-024's
`skills` and `identity.persona` land here. Fires per attempt (a retried agent prepares again), in the attempt's
ensure-machine step (`ops.ensureMachine`; a driver's `ensureWorker`); the spec it makes is the one the attempt's
machine and run get. A deny fails the attempt for good (code `config`, reason `plugin:<name>`).

The kernel's rules (`src/plugins/hooks.ts` `applyPreparePatch`; since §17.2 step 8, before it `skills` and `env` were
refused): a skill is `{name, hash, source, text}` with a name of `^[a-z0-9][a-z0-9._-]{0,63}$`, a non-empty `text` (its
SKILL.md), `source` one of `builtin`, `user`, `project`, `plugin`, and `hash` the sha256 (hex) of `text`; a name already
attached is `invalid`; at most 8 skills and 256 KB of them per agent, as on a message. `env` holds at most 32 variables
per patch, each value a string of at most 4 096 characters; a name the agent's environment has (the payload's `env`: the
runner's `HOME`, `PATH`, `CAPCOMD_RPC_DIR` and `CAPCOMD_CHECKOUT`, the provider's own variables and its credential's) or
a reserved one is `widening`. Reserved (`reservedEnvName`), whether or not the agent has it, is a name that would steer
the agent without prompt text: the kernel's `CAPCOMD_*`; the agent providers' families `ANTHROPIC_*`, `CLAUDE_*`,
`OPENAI_*`, `CODEX_*` (where a CLI sends its credential, which login it reads); what a shell or runtime loads first
(`LD_*`, `DYLD_*`, `NODE_*`, `NPM_CONFIG_*`, `PYTHON*`, `PERL5*`, `RUBY*`, `BASH_ENV`, `ENV`, `SHELL`, `IFS`, `CDPATH`,
`PS4`, `PROMPT_COMMAND`, `ZDOTDIR`); the proxy and certificates its traffic trusts (`HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`); git's `GIT_*`; and
`TMPDIR`, `USER`, `LOGNAME`. A value the redactor would change is `invalid` (secrets reach a sandbox as placeholders,
§11.4). The payload a later listener sees has the earlier skills and the earlier variables' names; their values stay in
the patches. The kernel then attaches them to the attempt's run: each skill's text in a `<skill name="…">` block, as a
message's skills are (`src/agents/skills.ts` `skillBlock`), after the profile's `append` and the plugins' appends (the
profile's skills first, then the plugins' in the order they added them), where the agent reads its instructions (Claude
Code's appended system prompt, Codex's prompt), and recorded on the attempt's spec by `{name, hash, source}`; the
variables in the agent's process environment, never in place of the runner's, the provider's or the credential's. The
kernel's own listener, `skill-orchestration`, reads the agent's record from the kernel's call rather than the engine, so
its `closed` failure never trips on a slow engine; an attempt no plugin prepared (a workflow that passed its prepare step
under an earlier capcomd, started or restarted after an upgrade), or one prepared without it (only its profile's skills,
no plugin listening), gets the orchestration skill from the kernel, as before.

The profile's skills (ADR-024 `skills`, §7 step 5): the payload's `prompt.skills` starts with them, so a plugin sees them
and can't attach one again. They are resolved with the profile (`src/profiles/skills.ts`: the profile's package
`skills/<name>/SKILL.md`, the user's `~/.claude/skills` for `source: user`), pinned on the agent at spawn by
`{name, hash, source}` (`PinnedSpec.skills`, additive; `source` `project` or `user`, the layer it came from), and their
text is kept with the run (the scope's content-addressed attachments, `att-<sha256 prefix>`), never in an event. Each
attempt reads the text there and checks it against the pin; one that isn't there as pinned fails the attempt for good
(code `config`), so a retried or resumed agent gets exactly what it was spawned with, and an edit to a `SKILL.md`
reaches only agents spawned after it. The orchestration skill (`capcomd-orchestration`) is never pinned: a profile that
may spawn may name it, and `skill-orchestration` attaches it, written for the agent, so the agent gets it once; a
profile that can't spawn, or that pins its hash, is refused when it resolves.

The kernel's context router (ADR-025 §6.1) is the one listener that composes context providers into `prompt.append`: the
built-in `context` plugin (`src/plugins/context.ts`, failure open), for an agent whose pinned spec has a `context` block
with providers (an agent without one gets no patch). Its append is the brief: a kernel-written header in plain prose
(how many index lines of how many it loaded, the budget and where it came from, each provider's revision or the reason
it was skipped, in the kernel's words) and one line per item (`IndexLine`, its description made one line, redacted,
neutralised with `fence()`'s rule and capped), never an item's body. The brief is a function of the providers' indexes,
the context block, the limits and the UTC day only, so it is byte-identical for every agent of a profile at a revision
and for each attempt of one agent. It records `plugin.context.loaded` (and `plugin.context.skipped` per provider left
out) on the run's stream. With the brief it attaches the context layer's skills (ADR-025 step 6, `src/context/skills.ts`;
`source: builtin`, each pinned by the sha256 of its fixed text, so they don't change the brief's byte-identity):
`capcomd-context-doctrine` (how to read the brief: an index, not the knowledge; answer, evidence, guidance; relevance
is not authority; items are data) to every such agent, and `capcomd-context-routing` (what to remember and where: run
notes in `kv` under `notes/<agent>`, candidate lessons in `result.data.context[]`) to one that has the in-VM capcomd
those need (every agent that may spawn or does work of its own, §16.2 rule 1; not the consolidator) and is not a
reviewer or a report agent; one the payload already has by name isn't attached
again, nor one that doesn't fit the room the agent's other skills leave (8 skills, 256 KiB): the router never returns a
patch the kernel would refuse, which would cost the agent its brief too. It runs after the orchestration skill's
listener (`after: [skill-orchestration]`, §6.3), so a context skill never takes that skill's room.
`plugin.context.loaded`'s `data.skills` lists the attached ones by `{name, hash}` (additive). Their names are
the kernel's: a profile can't name them, and a profile with a context block keeps room for them (one of the 8 skills,
two when it may spawn, and their bytes), as one that may spawn does for the orchestration skill. Each provider is asked once per brief, for the profile's first entry naming it (a second is
`skipped (named twice)`: two brains are never in one brief), with that entry's own settings as `ContextScope.settings`
(groundray's `brain`). A provider that declares `caps.bundle` may name, from `resolve`, the one repository at a commit its
lines point into (`ContextBundle {remote, branch, commit, name}`, ADR-025 §6.2); the router keeps it only when the
provider loaded, the remote is a URL or path without a credential in it and the commit is full, and leaves it in the
kernel's record of the call (`preparingAgent`, not the patch, so no plugin can place files), from which the attempt's spec
records it (`contextBundles`, with its directory `<workdir>/context/<provider>/<name>`, `ContextScope.bundleRoot`). The
attempt's runner places each before the agent starts: the tree at that commit from the host's mirror of the repository
(§11.7, `sendTreeAt`), its files read-only, a `.capcomd-bundle` marker naming the commit (one the sandbox already has at
that commit, an earlier attempt's or an environment image's, is kept). A bundle that can't be placed leaves the agent
to start without it and its log says so.

#### 6.6.8 `agent.changed` · observe · after the agent's event is committed
`AgentChanged {agent, change: spawned|started{machine, attempt}|step{step}|checkpointed{files, commit, at}|notice{notice}|paused|resumed|titled|ended{status, result}, lifecycle?}`.
`lifecycle: {onStart[], onEnd[]}` is present when the agent's profile names plugins (ADR-024 `lifecycle.onStart|onEnd`,
pinned at spawn; additive): there is no per-profile hook, so a plugin a profile names listens here and filters on its own
name. The kernel refuses a spawn of such a profile (`config`, reason `lifecycle_inactive`), and the agent's start (its
claim, before its machine is ensured), while a named plugin isn't active and listening to this hook: the daemon asks its
own host, another process the running daemon's listing (§13.2; with no daemon running, nothing is refused there and the
daemon asks at the start). `capcomd profiles validate` reports it the same way (§7.1).
`checkpointed` is the progress signal (§16.4). Notifiers, the watchdog, cost and runs-index observers. `started` is
recorded when the agent is claimed, before its machine is ensured, so its `machine` is null (`sandbox.changed`
`ready` names the machine); it is told once, at the agent's first claim, which is always attempt 1 (a retried attempt
prepares again, `agent.preparing`; a resumed agent is `resumed`). Each change's `principal` is who caused it: the agent
for its own work, its spawner (the parent agent, else the operator) for `spawned` and `started`, the `by` the kernel
recorded for a pause, resume, cancel or title; a verification's and merge's changes are their asker's, a decision its
approver's (`src/plugins/changes.ts` `causeOf`).

The kernel's context capture (ADR-025 §5.1) is the built-in `context` plugin's listener: on `ended` (not `cancelled`)
of an agent whose result has `data.context`, it reads the result from the record the agent's token wrote (kv
`_result/<agentId>`, written by `capcomd result` as the token's `sub`; not the payload, which only says there is
something to read and is redacted on its way), and only when that writer is the agent. Each element is a
`ContextProposal` (`text`, and at most `title`, `type`, `op`, `target`); its other fields are ignored and named
(`ignored`), so an agent can't say who wrote a lesson or how far it is trusted. Each is refused when it isn't one, holds
a secret (§11.5's seeded scan), is over `limits.itemBytes`, or would pass the run's `limits.proposalsPerRun`; else it is
a candidate whose `provenance` the kernel stamps from its records (`method: agent-generated`, `by: process:<agentId>`,
`origin: {runId, agentId, profile, model, image}`). The agent's candidates and refusals (a number and a reason, never
the text) are kept once, in kv `_context/<agentId>` of the run (reserved: only the kernel writes it, every agent of the
run reads it), with `plugin.context.proposed` per candidate and `plugin.context.refused` per refusal on the run's
stream. Nothing reaches a shared layer. The listener never throws (a failure is logged): three failed calls would
suspend the plugin's `agent.preparing` listener with it (§6.5).

An agent of the `context-consolidator` profile (ADR-025 §5.2) isn't captured: its answer (its `context` list, in its
declared result's `data`, else in a JSON block of its final message) is a list of changes to the project's memory,
which the kernel stages on its branch before it records the agent's end (`ops.settlePushed`,
`src/context/consolidator.ts`): `.capcomd/context/` at the run's target, changed by plain rules and no model
(`src/context/consolidate.ts`: an `add` titled as an active memory item becomes a supersede of it, one the lexical match
finds said already adds nothing, every string scanned as a candidate's is, `proposalsPerRun` changes at most, each new
item a draft with kernel-stamped provenance, `index.md` as lint writes it), committed and pushed on the host; its
result carries the `branch`, the `commit` and `context` (what was applied and refused). It runs as a reporting agent
does (a read-only checkout of the target, nothing of it kept), with the run's candidates and its verifies and merges in
its prompt, fenced as their agents' text; its profile naming no model, it runs on the run's strongest (the most capable,
by `src/config/models.ts`, of the models the run's agents on its provider use). The `context` plugin's listener then
records `plugin.context.staged` (the branch, the commit, each change) and a `plugin.context.refused` per refused change.

A consolidator's answer may also propose new facts to a company's brain (ADR-025 step 5): a change with `brain: <name>`
for the brain its own profile names (its `groundray` entry), one of groundray's types (`concept`, `decision`,
`procedure`, `policy`, `system`, `source-summary`, `question`), a one-line title of 3 to 120 characters (groundray's schema) and the text, a new draft only (`add`:
a brain's items are superseded, deprecated and verified by its owners). Each is checked as a memory change is (the
seeded scan, `itemBytes`, its `from` the run's candidates; it takes its share of the run's `proposalsPerRun`), refused
`no_brain` for a brain its profile doesn't name, and never staged on the branch: the kernel keeps it in kv
`_context/brain/<agentId>.<n>` of the run (reserved, under the run's `_context/`), and the consolidator's result says
so (`context.brain {name, proposals[], awaits, sent[]}`, additive). They go to the brain through its provider's
`propose` (§4.7; `context-groundray` is writable, ADR-025 §11.2): under the consolidator's profile's `context.review:
lint` the kernel sends them as the staging ends, as capcomd (groundray's actor `capcomd/<version>`), within 4 minutes
for all of them (those it leaves no time for, or a send that can't start, wait for the command below, and
`context.brain.awaits` says `person` when none could be sent); under `review:
human` (the default) they wait for a person, who sends them with `capcomd context brain propose --run <runId> --yes` and
is their actor (`human:<id>`, from the operator's or a driver's principal: an agent never names a person, ADR-025 §7).
A sent proposal keeps its receipt in its record and is never sent again; one that failed keeps why, and can be sent
again. The `context` plugin records `plugin.context.brain_staged` (they wait for a person) and
`plugin.context.brain_proposed` (one was sent, and where).

groundray's `propose` makes the draft with the groundray CLI (`CAPCOMD_GROUNDRAY`, else `groundray` on `PATH`;
`unavailable` without one), never on what agents read: in a throwaway directory, a bare host repo fetches the brain's
branch and the run's proposal branch (`groundray/capcomd-<runId>-<agentId>`, groundray's namespace for proposals), an
authoring clone made from it locally sits on `main` at that branch's tip (else the brain's), and groundray runs with its
own config, data, cache, `HOME` and `XDG_*` there (`setup --non-interactive`, `brain add <authoring clone>`, then
`knowledge create … --method agent-generated --confidence low` planned and then `--apply`, a source naming the run and
agent as the proposal's marker). Its commit is pushed only when it descends from the base and changes nothing outside
the bundle, from the bare repo with a lease (§11.7), and the forge that serves the brain's remote (`matches`, §7.1)
opens or finds the pull request into the brain's branch; a forge without pull requests leaves the pushed branch. A
proposal the branch holds already (its marker) is found, not made again. Only `add` is taken (`unsupported` otherwise),
and only for a brain with groundray's `brain.yaml`.

#### 6.6.9 `agent.item` · observe · the runner, as it drains the thread (`putItems`)
`AgentItem {agent: {id, runId, profile}, item: ThreadItem}`, untrusted. The only turn and tool-call surface capcomd can
offer (ADR-023 §5.3): the host sees tool calls after the fact and cannot block them. High volume: 5 s deadline, bounded
queue, drops counted. Transcript exporters, cost per item.

#### 6.6.10 `sandbox.ensuring` · modify · before `provider.ensure` (`ops.ensureMachine`, checks, logins, env builds)
`SandboxEnsuring {runId, agentId, purpose: agent|check|login|env_build|doctor, provider, spec: VmSpec}`. Patch
`{labels?, size?, ttlSeconds?}`: labels are added under `plugin.<name>.`; `size` may not grow; `ttlSeconds` may not
grow. Cost caps on machine size, labelling for a provider's billing.

#### 6.6.11 `sandbox.changed` · observe · after `waitReady`; before and after `destroy`
`SandboxChanged {provider, machine: {id}, runId, agentId, change: ready{createdMs}|destroying{reason}|destroyed}`.

#### 6.6.12 `verify.starting` · modify · gate · `ops.verifyRef` → `verifyOnce`, before the checks step
`VerifyStarting {verification: {vfyId, runId, ref, target, check}, acceptance, reviewer, requestedBy}`. Patch
`{acceptance?}` only: **never `checks`** (checks come only from the operator, ADR-017 §2). Deny fails the verify closed.
Once per verification.

#### 6.6.13 `verify.judging` · veto · gate · `verifyOnce`, once the checks passed on the branch put on the target
`VerifyJudging {verification (with tested: {sha, targetSha, commit}), acceptance, task, reviewer}`; `tested.commit` is
the agent's commit the checks put on the target (`tested.sha` is the result). Each listener is a **judge**: `allow`
passes, `deny{reason, reasons[]}` fails. The kernel ANDs the checks result and every judge, asked in order (§6.3) until
the first deny; the reasons are capped at 20 × 500 chars. Fail-closed: no answer is a fail. The reviewer gate (§15.3) is
one judge; a security scanner or a coverage threshold is another of the same shape. 30 min default.
The checker puts the branch on the target and runs the checks in one call, so the judges are asked once the checks
passed (the tree they passed is `tested`); checks that fail ask no judge.

A judge that ran the run's reviewer profile (`reviewer`) adds `review: ReviewReport {profile, agentId, passed, reasons,
error?, retryable?, sha, targetSha?, startedAt?}` to its answer (any decision; a malformed one, or one on another hook, is
`invalid_result`). The kernel records it as the verification's `review` (capcomd.v1's `result.review`, `judge`, the
review timings) and keeps "both must pass for the same tree" (`reviewFits`): a review counts only when its `sha` and
`targetSha` are `tested.commit` and `tested.targetSha`. A verification with a reviewer whose judges all allowed it
without a review (no reviewer gate active) fails closed. Review-mode agents a judge spawned for it (their contract's
`review.vfyId`) that still run when it finishes are stopped by the kernel.

The built-in `context-memory` is a judge too (ADR-025 §5.3, "lint as a check"): for an agent's branch whose
`tested.commit` changes `.capcomd/context/` (against its merge base with `tested.targetSha`; a file under it, or the
directory or `.capcomd` made a file or a link), it denies when the agent isn't a consolidator (`memory lands only from a
consolidator or a person`), when a consolidator's branch changes a file outside that directory or makes it a file or a
link, and when `capcomd context lint` fails on the directory at `tested.commit` against the merge
base (`src/context/promotion.ts`); a branch that touches nothing there, or isn't an agent's, is allowed unread. It is
built in and loaded in every process (§6.1), and it judges before the reviewer gate (§6.3, by name), so a memory change
that can't land costs no review. It reads the branch in a clone of the run's repository it keeps (a host repo,
§11.7).

#### 6.6.14 `verify.changed` · observe
`VerifyChanged {verification, change: started|checked{passed, where, excerpt}|judged{by, passed, reasons}|finished{passed}}`.
`judged` is told once per judge plugin asked (until the first deny) and once for the run's reviewer (`by`
`reviewer:<profile>`).

#### 6.6.15 `merge.landing` · veto (+ `hold`) · gate · `ops.mergeRef`, under the target lock, after the `--require` check and the fast-path decision, before the forge's `land`
`MergeLanding {merge, verification, target: {branch, protected, sha}, sha, fastPath, operator, requestedBy}`. Results:
`allow`; `deny{reason}` (the merge fails with `plugin:<name>`); `hold{reason, holdId?}` parks the merge for a **human** approval
of kind `merge` exactly as a protected target does (`parkOp`): a plugin may add a requirement, never decide one (§11.3).
When `operator` is true the decisions are recorded and bypassed (§6.5). Once per merge attempt. Replaces ADR-023's
`merge.requested` + `merge.gating` pair (decision: one gate under the lock; a cheap policy denial a few hundred ms
later costs nothing that matters). It fires before the forge's path is chosen: `fastPath` says the merge has a verified
commit to try the fast path with, and `sha` and `target.sha` are that commit and the target it was verified on (empty
without one). A held merge carries the hold (`heldBy {plugin, reason, holdId?}`) on its record, with the holds a person
approved for it (`approvedHolds`, each added when the person approves it; `heldBy` stays the last one), and its approval (the
question and `subject.heldBy`, the park event, the elicitation prompt), so the person sees the plugin's reason, and the
files the merge changes (`subject.files`, `filesTotal`, `added`, `removed`), read as a protected target's park reads
them. A person's approval of that hold satisfies **only that hold**: the same plugin and, when the hold carries a
`holdId` (a non-empty string of at most 200 characters, the plugin's own stable name for it), the same `holdId`, else
the same `reason` text; a hold with a `holdId` never matches one without. So a plugin whose reason changes per call
(a count, a timestamp, a link) names its hold, and the person isn't asked again for it. The approved merge fires again as a
new attempt (`idempotencyKey` `merge.landing:<mrg>:<n>`, one more per approved hold; a replay keeps its key), every
listener is asked (`askAll`), and the first veto that isn't an approved hold stops it as it would have (a deny fails
it, a new hold parks it again). An approval of anything else (a protected target's) satisfies no hold. A person's deny
of a held merge ends its verifier record `failed`. A dry run (no repository) has no lock and lands nothing, and fires
no `merge.landing`.

Promotion is a merge (ADR-025 §5.3): the built-in `context-memory` listens here, fail-closed, judging the agent's commit
(its result's `commit`, from its merge base with `target.sha` when the payload has one, else with the target's tip) as
its `verify.judging` judge does (§6.6.13), and denies what that judge would. A consolidator's
branch that passes is held for a person under its profile's `context.review: human` (the default), with what changes
and what lint flags for a reader (an item that reads like an instruction, a stale or large one) in the reason and
`holdId` `memory@<commit, 12 characters>`, so an approval holds for that commit only; under `review: lint` it is allowed
on the lint alone. `merge --operator` lands a branch it denied, recorded as bypassing it (§6.5).

#### 6.6.16 `merge.changed` · observe
`MergeChanged {merge, change: requested|landed{sha, pr, bypassedVetoes[]}|failed{reason}|parked{approvalId}}`.

#### 6.6.17 `approval.deciding` · veto · gate · `decideOp` / `POST /v1/approvals/{id}/decision`, before the CAS
`ApprovalDeciding {approval, decision, by, reason}`. `deny` refuses the decision (a second approver, a four-eyes rule,
"no agent may approve budget raises above X"). A plugin cannot approve: the hook has no `allow`-with-effect; §11.3.

#### 6.6.18 `approval.changed` · observe
`ApprovalChanged {approval, change: requested|decided{decision}|expired|withdrawn}`.

#### 6.6.19 `job.changed` · observe · the jobs service (§16.2)
`JobChanged {job, change: started|output{stdout, stderr}|fired{n}|ended{state}}`. Results of background work arrive
here; timers tick here. 5 s deadline. Fired by `src/jobs/service.ts` in the process that watches the job (the daemon,
where agents' spools are pumped and timers armed); `output` frames are read only while a plugin listens. `trigger.*`'s
sites are the intake's (§16.3.2, `src/triggers/intake.ts`).

#### 6.6.20 `trigger.admitting` · veto · gate · the intake (§16.3), after the kernel's gate, before any action
`TriggerAdmitting {trigger, gate: {allowed, strength, mode, subscribed}}`. A listener may only **deny**; it cannot
admit what the gate refused (its result is consulted only when `gate.allowed`). Fail-closed: a failed call denies the
trigger (recorded, not acted on). For team policies the kernel's allowlist cannot express ("no triggers from forks").
It is asked only about a trigger the gate allowed (§16.3.2 step 4), with the source plugin as the principal and
`trigger:<source>/<hash of id>` as the entity of its idempotency key.

#### 6.6.21 `trigger.changed` · observe
`TriggerChanged {trigger, decision}` with the full `TriggerDecision`. The audit a team reads before leaving
record-only mode (§16.3.4).

### 6.7 Idempotency and repeated calls

The kernel's operations are durable workflows that replay after a crash (ADR-022). Therefore:

- A `veto`/`modify` call MAY be repeated for the same decision after a replay, with the **same `idempotencyKey`**. A
  listener with side effects (spawning a reviewer, posting a message) MUST key them by it (the reviewer example keys its
  spawn by the verification id, §15.3). The kernel does not persist a gate decision across a replay: it asks again.
- An `observe` call is **at-least-once**: the same change may be delivered twice after a crash. Observers dedupe on
  `idempotencyKey`, or on `(entity, entitySeq)` when they also read the event stream.
- `HOOKS[name].fires` says whether a hook fires once per entity (`run.creating`, `agent.spawning`, `verify.starting`,
  `verify.judging`, `merge.landing`, `approval.deciding`, `trigger.admitting`) or many times (`profile.resolved`,
  `agent.preparing` per attempt, every `changed` hook, `agent.item`, `job.changed`).

### 6.8 What is deliberately not a hook

- **A per-tool-call veto inside the agent** (Claude Code's `PreToolUse`): the agent runs in a sandbox with no channel to
  the host but the spool (ADR-017 §1); the host sees tool calls after the fact (`agent.item`). That hook belongs to
  capcomd's plugin *for* the agent (ADR-018), a different system.
- **Running host shell on agent output**: checks come only from the operator.
- **`agent.pushing`** (ADR-023 §5.2): dropped; commit trailers are the forge's `LandRequest.trailers` and nothing else
  needed it. **`message.sending`/`message.delivered`**: dropped; skills attach at `agent.preparing`, and messages are
  visible as `message.sent` events through `ctx.events.subscribe`. **`daemon.starting`**: dropped; no listener can exist
  before plugins load, and `activate` is where a plugin sets itself up. A hook returns when a consumer exists (§18).

## 7. Seams

### 7.1 The rule

A seam is a kernel-defined interface with exactly one implementation selected **by name** per use, and kernel consumers
that never name an implementation (`sandboxCaps().snapshots`, never `name === "boxd"`). Three seams exist: the sandbox
provider, the agent provider and the forge. A plugin implements a seam by declaring `contributes.seams: [{kind, name}]`,
providing `seam:<kind>/<name>`, and calling `ctx.seams.<kind>(impl)` once in `activate`. Two active plugins providing the
same `(kind, name)` is `seam_conflict`.

Selection, per use:

| Seam | Selected by | Today |
|---|---|---|
| sandbox | for an agent's machine, its profile's `sandbox.provider` (ADR-024; pinned at spawn as `PinnedSpec.sandboxProvider`, recorded on its worker; one whose `caps.isolation` is `host` is refused at spawn, `config` reason `sandbox_isolation`, unless the run's is `host` too); else, and for a run's checks, the run's `sandbox` (`POST /v1/runs`, `capcomd run --sandbox`, kv `RUN_SANDBOX_KV`), else the daemon's `CAPCOMD_SANDBOX` | `src/dependencies.ts` `providerNamed`, `providerForAgent`, `providerForRun` |
| agent | the resolved profile's `provider` (`PinnedSpec.provider`; ADR-024 `harness.provider`) | `src/agents/adapters.ts` `adapterFor` on the closed union `claude \| codex` |
| forge | the project's `merge.forge` (`CAPCOMD_MERGE_FORGE`, which `.capcomd/config.json` `env` can set and a run records; a GitHub repository named outright, `CAPCOMD_GITHUB_REPO`, names `github`; never the target tree's `.capcomd.json`, read only after the forge is chosen), else the first forge whose `matches(remote)` is true in load order; the built-in `git` forge matches every remote and is loaded last (`order: post`); creating a repository asks the first active forge whose `describe().publish` | `src/plugins/forges` `forgeFor`, from `mergeTask` (`prMerge`, `directMerge`), the goal branch's pull request, a run's base (`listBranches`), the logins the app shows (`login`); `publishForge` for `POST /v1/projects/publish` |

A profile or run naming an implementation that is not active fails at **validation** (`capcomd profiles validate`,
`POST /v1/runs` 422), not at spawn. For a forge that is the run's `merge.forge`: `POST /v1/runs` refuses it (422
`invalid`, "merge.forge names <name>, which no active plugin provides" and the active forges), and so do `capcomd run`
and `capcomd_run_new` (relay.v1 `config`, reason `forge`), before any merge. The kernel wraps every seam object in its
traced, resilient wrappers (`src/providers/resilient.ts`, `tracedProvider`; for a forge, `src/plugins/forges`
`kernelForge`: each SeamCall method in a `forge.<method>` span whose trace the forge is handed, the signal enforced at
the deadline even for a forge that ignores it (except `land`, which the kernel waits for under its lock), rejections
classified by the forge's `classifyError` and the reads `findPullRequest`, `openPullRequest` and `listBranches` tried
again while that says `retryable`, `login` never rejecting) and hands the wrapper to consumers and to
`ctx.sandboxes.provider`; no plugin ever receives another plugin's raw object. A seam object held by a running operation stays valid until that
operation ends even if the plugin disposes meanwhile; a new operation then fails `not_found` for the name.

Every seam method takes a `SeamCall {signal, deadline, trace}` as its last argument and MUST honour the signal: work in
progress is cancelled (an `exec` is killed inside the machine), and the method rejects `timeout`. Methods reject
`PluginError`s; the kernel classifies anything else through the seam's `classifyError`.

### 7.2 Sandbox provider

`SandboxProvider` (`packages/plugin/src/seams.ts`) is `src/providers/sandbox.ts` `SandboxProvider` plus `describe`,
`available`, `classifyError`, `sweep`, and the `SeamCall`. Contracts:

| Method | Pre | Post | Errors |
|---|---|---|---|
| `describe()` | | the ADR-021 descriptor; pure; `descriptorVersion: 1`; `name` equals the seam name | |
| `available(c)` | | `{ok}` or `{ok: false, reason, fix}`; the kernel caches it 5 s (`run-options.ts` `AVAILABLE`) | never rejects: an unreachable backend is `ok: false` |
| `classifyError(e)` | | an `ErrorClass`; pure; `unknown` when unsure | |
| `ensure(spec, c)` | `spec.isolated === true` | `{id, created}`; **idempotent by `spec.idemKey`**: the same key yields the same id with `created: false`; a machine with that key that is gone is recreated | `config`, `auth`, `quota`, `transient` |
| `waitReady(id, c)` | | resolves when `exec` will work | `not_found`, `timeout` |
| `exec(id, cmd, opts, c)` | argv, no shell | `{code, stdout, stderr}`; a non-zero exit is a result; at the deadline the command is killed **inside the machine** and `timeout` is rejected | `not_found` |
| `upload`, `download` | | bytes in, bytes out; paths absolute inside the machine | `not_found` |
| `setEgress` | `caps.egressAllowlist` | the allowlist applies to new connections | `unsupported` |
| `snapshot`, `checkpoint`, `restore` | `caps.snapshots` for `snapshot` | | `unsupported` |
| `suspend`, `resume` | | | `unsupported` when not supported |
| `destroy(id, c)` | | idempotent: a gone machine resolves | |
| `list(prefix, c)` | | machines whose name starts with `prefix` (`MACHINE_PREFIX`) | |
| `extendTtl?`, `probe?` | | as today's optional methods | |
| `sweep?(c)` | `caps.idleLifetime === "sweep"` | deletes machines past their deadline; the kernel calls it every 5 min | |

Conformance: the cases of `tests/providers/conformance.test.ts` (ADR-020 §3) on the seam, with `describe`,
`available`, `classifyError` and the `SeamCall` cancellation case added, is the suite every sandbox plugin MUST pass
(§14.2): `packages/plugin/src/conformance.ts`, run by the test kit and `capcomd plugins validate --conformance`.

#### 7.2.3 `classifyError`

Replaces every place the kernel names a provider's error (`src/actors/worker.ts` `isBoxdAuthError`,
`src/recipes/hierarchical.ts`). The kernel maps `kind` to its own behaviour: `config`/`auth` fail the run with the
`hint` as the user's next step; `transient`/`timeout` retry with backoff (`ops.ts` `MAX_OUTAGE_RETRIES`); `quota` pauses
(ADR-019 §6); `not_found` ends the attempt as `ended`; `unknown` is a plain failure.

### 7.3 Agent provider

`AgentProvider` is `src/agents/types.ts` `AgentAdapter` as a seam. `describe()` carries what today's tables keyed on
`claude | codex` carry (`src/agents/profiles.ts` `PROVIDER_KIND`, `PROVIDER_EFFORTS`, `PROVIDER_DEFAULT_EFFORT`,
`src/agents/config.ts` `AGENT_API_HOST`, `CLAUDE_CODE_VERSION`/`CODEX_VERSION`) plus `toolPolicies.orchestrate`
(§16.1). Every method but `available` is pure; `parse` MUST pass every string through the `redact` it is given before
returning it (today `Redactor.text`); `redactJson` (`packages/plugin/src/seams.ts`) does that to a parsed line with the
kernel's own rule, a credential-named key's string replaced whole. The kernel keeps one `AgentRunState` object per run,
so a provider may keep fields of its own on it between lines. A provider whose CLI reports them sets the optional
`cacheReadTokens` (of `inputTokens`) and `model` (the model the CLI says it ran); the kernel puts them on the agent's
span as `gen_ai.usage.cache_read.input_tokens` and `gen_ai.response.model`. The `AgentConfig` a provider reads has the kernel's
`credentialMode` values (`auto` included) and `usdPerMtok`, the operator's token rates for a CLI that reports tokens and
not cost, and `denyCommands`, the command prefixes an orchestrate agent's CLI must refuse (§16.1). The optional, pure
`refusal(line, redact)` reads a tool call the CLI refused from one line of its stderr, for a CLI that reports refusals
only there (codex). `command`'s `AgentCommandCtx.mcp` (additive) carries the profile's MCP servers (ADR-024
`tools.mcp`), which the CLI starts in the sandbox: `config`, a file holding them and capcomd's own (when `capcomd` is
set) as `{mcpServers: {<name>: {command, args}}}`, and `servers`, the list, for a CLI that takes servers as flags; a
provider MUST start them only inside the sandbox, and approves a `trusted` one's tools up front as it does capcomd's. The kernel's runner (`src/agents/runner.ts`) stays the kernel's: it does clone,
install, credentials, start, streaming, guards, cancel, commit and push; the provider says how its CLI is invoked and read.
ADR-024's `harness.provider` becomes "an active agent seam's name"; `claude` and `codex` are the built-ins
(`agent-claude`, `agent-codex`: `src/plugins/agent-claude.ts`, `agent-codex.ts`). Only the daemon has a plugin host: in
it the active providers are the ones its plugins registered; in every other process (the CLI, the MCP server, a
driver) they are the built-ins (`src/plugins/agents.ts`). The runner's agent kind stays the provider's name, except
Claude Code's, `claude-code` as before (CAPCOMD_AGENT, auth logins, the `Capcomd-Agent:` trailer).

Conformance (§14.2): the recorded streams in `apps/tui/fixtures` and `packages/agent-thread/fixtures` are replayed
through `parse` and `outcome`; `command` is checked to send stdout to `ctx.jsonl`; `guard` stops at the limits.

### 7.4 Forge

A forge is the hosting service a remote points at. The kernel keeps what is git: the target lock (`src/merge/lock.ts`),
fetch and integrate (`src/merge/integrate.ts`), the checks (`src/merge/verify.ts`), the fast path and the CAS on
`targetSha` (`src/merge/direct.ts`). It hands the forge an integrated, checked commit to **land**:

| Method | Contract |
|---|---|
| `describe()` | `{name, label, pullRequests, publish?}`; `publish`: `publishRepository` creates repositories (absent is false) |
| `matches(remote)` | pure; the default selection rule (§7.1) |
| `classifyError(e)` | §7.2.3 |
| `land(req, c)` | Called **under the kernel's target lock**. `mode: "direct"`: push `req.sha` to `req.target` as a compare-and-swap on `req.targetSha` (with `req.leaseBranch`, the branch leased at `req.branchSha` in the same atomic push; a remote that refuses atomic pushes is `{status: "failed", retryable: true}`); a moved target is `{status: "conflict", targetSha}` (`""` when the forge doesn't know it) and the kernel fetches and re-integrates. `mode: "pr"`: the branch is pushed already; find or open the pull request and merge it with `req.strategy` at exactly `req.branchSha`, the head the kernel integrated as `req.sha` and checked (the hosting service makes the merge commit, so the outcome's `sha` is the service's); a pull request the service can't merge is `conflict`, a wait past the deadline `{status: "failed", retryable: true}`. **Idempotent by `req.mrgId`**: a replay after a crash finds the existing PR or the pushed commit and reports `already: true`. MUST reject `unsupported` for `pr` when `pullRequests` is false. |
| `openPullRequest`, `findPullRequest` | `POST /v1/runs/{runId}/pull-request`, `capcomd_pr_open`, `capcomd pr` (goal branches); idempotent by `(remote, head, base)`. A merged pull request carries `mergeSha`, so a pr-mode merge that finds one records it without integrating again |
| `publishRepository` | `POST /v1/projects/publish`, asked of the first active forge whose `describe().publish` (forge-github: `gh repo create`); the event names where it went by the returned `url`. A name the service has already is `conflict` |
| `listBranches({remote, cwd, max}, c)` | `POST /v1/runs` base resolution (`capcomd run`, `capcomd_run_new`) and `GET /v1/projects/branches`: `{defaultBranch, branches, source, note}`, from the service's API (`source: "service"`; the kernel reports the forge's name, `describe().name`: `github`, or a forge plugin's own, so the route's `source` is a string) when it can, else from the remote itself (`"git"`: `git ls-remote`, its `HEAD` the default branch, never guessed), with `note` saying why the service wasn't used. Rejects, saying why, when the remote can't be read at all; the kernel then reads the checkout's own refs (`local`) |
| `login({use, accounts?}, c)` | Whether the user's own login at the service is on this machine for `use`: `pullRequests` (the goal branch's `openPullRequest.available`, the setup wizard's suggestion; forge-github: a token, `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`) or `publish` (`GET /v1/projects/inspect` and `publish-options` `ghReady`, publishing; forge-github: `gh auth status`); with `accounts`, as whom (`publish-options` `accounts`: the user, then its organizations; forge-github: `gh api user`, `gh api user/orgs`). Shaped like `available`: `{ok: true, accounts}` or `{ok: false, reason, fix}`, sentences the kernel puts in its own ("capcomd opens pull requests with your GitHub login, and there is none on this machine: <fix>, then try again"). Cheap (the forge may cache it; forge-github asks at most every 30 s) and never rejects |
| `remoteCredential?({remote}, c)` | Optional (absent: none). The user's credential for the kernel's host git over https to `remote` (§11.7): `{origin, username, password}`, `origin` the https origin it is for (scheme and host, no path; forge-github: `https://github.com`, `x-access-token` and the user's token, `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`), or null, when the user's own git credentials apply. Asked before each host fetch, push and ls-remote of an https remote, of the active forges whose `matches(remote)` is true, in load order; the first credential wins. Data only: the forge never runs network git or a credential helper; `src/merge/host-git.ts` applies it, and ignores one whose `origin` isn't the remote's or whose fields span lines. Cheap (the forge may cache it); a rejection is no credential. Its span records neither the remote nor the answer |

When the chosen forge has no pull requests in pr mode, or a goal branch's repository is on one, the kernel says so in
the words of the active forges that have them ("pr mode needs a GitHub repo", "isn't on GitHub"); with none active,
that no active forge supports pull requests. Where the person merges a goal branch's pull request is said with the
run's forge's `label` too ("review and merge it on GitHub"); when the forge can't be told, "where the repository is
hosted", never a guessed service.

Built-ins: `forge-github` (§15.2) and `forge-git` (direct pushes to any remote; `pullRequests: false`). A GitLab or
Gitea forge is one plugin and no API change. `tests/merge/fake-github.ts` stays the fake GitHub REST service that
`forge-github`'s tests run against; `tests/merge/forge-fake` is the `forge-fake` test plugin, which lands what the kernel
hands it without a hosting service, reads branches with `git ls-remote` unless a test hands it a listing, and logs in
and supplies a host git credential as a test says. Every process that lands work has the forges: the daemon's host, else the process's one local host
(`src/plugins/host.ts` `localHost`: the built-ins marked `everyProcess`, the gates and the forges, and in tests
`CAPCOMD_TEST_PLUGINS`; the CLI, `capcomd mcp`, tests). Until a project's layer of a plugin's config exists (§10.2), the
built-in forges read a run's recorded merge settings (`CAPCOMD_GITHUB_API`, `_POLL_MS`, `_TIMEOUT_MS`, `_REPO`) and the
caller's environment (`CAPCOMD_GH_CLI`, `GITHUB_TOKEN`) from the kernel for the call they serve.

## 8. Primitives: the context

### 8.1 Shape

`PluginContext<C>` has 23 services. Everything a plugin can do is a method on one of them; there is no second entry
point, no global, no ambient state. The full signatures are `packages/plugin/src/context.ts`; this section states the
rules the signatures cannot.

| Service | Primitives | Needs scope | Today |
|---|---|---|---|
| `plugin` | identity: `name`, `version`, `runtime`, `root`, `dataDir`, `manifest` | | |
| `principal`, `signal` | the plugin principal; aborted on dispose | | |
| `config` | `get`, `secret` | | §10 |
| `log` | `log`, `debug`, `info`, `warn`, `error` | | §13.3 |
| `trace` | `span` | | §13.4 |
| `hooks` | `on` | | §6 |
| `seams` | `sandbox`, `agent`, `forge` | | §7 |
| `context` | `register` | | ADR-025 §3.1 (`search`, `get`, `propose` for plugins once a consumer exists) |
| `cli` | `command` | | §4.7.1 |
| `mcp` | `tool`, `instructions` | | §4.7.2 |
| `api` | `route`, `capability` | | §4.7.3 |
| `ui` | `descriptor` | | §4.7.5 |
| `events` | `emit`, `subscribe`, `replay` | `emit`: steer; others: read | scope `appendEvent`, the SSE source (`src/api/source.ts`) |
| `storage` | `get`, `put`, `cas`, `delete`, `list` | | kv with the `plugin/<name>/` prefix; `state/plugins/<name>/` |
| `runs` | `new`, `get`, `list`, `end`, `pause`, `resume`, `title` | steer (`get`, `list`: read) | `ops.runNew`, `endRun`, `pauseAgents`, `recentRuns`, `setRunTitle` |
| `agents` | `spawn`, `get`, `tree`, `await`, `cancel`, `grant`, `title`, `notice` | steer (`get`, `tree`, `await`: read) | `spawnAgent`, `treeOf`, `awaitAgents`, `cancelAgents`, `grantBudget`, `setAgentTitle`, `notice` |
| `messages` | `send`, `inbox` | steer / read | `sendToAgent`, the scope's inbox |
| `gates` | `verify`, `merge`, `pending` | steer | `verifyRef`, `mergeRef` (never `operator`), `pendingMerges` |
| `board` | `add`, `claim`, `done`, `release`, `list` | steer | `src/primitives/board.ts` |
| `kv` | `get`, `put`, `cas`, `list` | steer / read | `src/primitives/state.ts`; reserved prefixes read-only |
| `sandboxes` | `provider`, `forRun`, `descriptors` | | `providerNamed`, `providerForRun`, `DESCRIPTORS` |
| `profiles` | `resolve`, `list` | read | `resolveAgent`, `readAgentsFile` (ADR-024 §3) |
| `auth` | `credentialMode`, `loginPresent`, `redact` | | `credentialModeFor`, login presence, `redactShapes` |
| `jobs` | `start`, `get`, `list`, `cancel`, `wait` | steer (`get`, `list`, `wait`: read) | new (§16.2) |
| `triggers` | `emit`, `subscribe`, `unsubscribe`, `subscriptions` | `emit`: the plugin must contribute the source; `subscribe`: steer | new (§16.3) |
| `onDispose` | | | §5.3 |

78 primitives in all (70 on the services above plus `log` ×5, `trace.span`, `ui.descriptor`, `onDispose`).

### 8.2 Call options

Every async primitive takes `CallOptions {key?, signal?, timeoutMs?}` last. `key` is the idempotency key of a mutating
call, with the semantics of the CLI's `--key` and the API's `Idempotency-Key`: the same key with the same arguments does
the thing once and returns the recorded result; the same key with different arguments is `conflict`. `signal` is
composed with `ctx.signal`. `timeoutMs` defaults to 30 000; past it the call rejects `timeout` and the kernel's side
either completed or did not (the caller re-reads).

### 8.3 Errors

Primitives reject `PluginError` (§5.6). The kernel's `RelayError` codes map onto them: `usage` → `invalid`,
`not_found` → `not_found`, `conflict` → `conflict`, `config` → `invalid` (with the hint), `engine_unreachable` →
`unavailable`, `forbidden` (a `reason`) → `forbidden`. A route handler's thrown `PluginError` maps to HTTP as in §4.7.3.

### 8.4 Rules per service

- `events.emit`: only `plugin.<name>.<type>` with a declared `type`; `data` redacted and ≤ 64 KB; `text` ≤ 500 chars.
  `subscribe` delivers in order and never concurrently to one handler; a handler that throws is logged and skipped.
- `storage`: private to the plugin. Keys `^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$`, values JSON ≤ 64 KB. Run scope is
  deleted with the run; daemon scope lives in `dataDir` and survives updates and reinstalls.
- `kv`: the run's shared blackboard; reserved prefixes (`_`, `approval/`, `recipe/`, `handoff/`, `plugin/`) are
  read-only (`forbidden`). Values ≤ 64 KB.
- `agents.spawn`: subject to `spawnChecks`, `checkSpawn` and the plugin's budget share as any caller; a plugin cannot
  pass `operator`. `agents.notice`: a plugin may raise kinds the kernel does not (`stalled`) and clear only notices it
  raised: raising a kernel kind is `forbidden`; a clear (`null`) takes away only a plugin kind, and the kernel's own
  clear takes away only the kind it raised (the runner's stuck notices, its sandbox outage), so a plugin's notice stays
  until progress or the plugin clears it. A notice needs a running agent (a later one replaces an earlier one of another
  kind, as the kernel's do). `agents.cancel` cancels the agent and its descendants as `capcomd cancel` does, the reason
  recorded as `by the <plugin> plugin: <reason>`. A call never creates a run (an unknown run is `not_found`).
- In the daemon since §17.2 step 11, beside `jobs` and `storage`: `agents.get`, `agents.tree`, `agents.cancel`,
  `agents.notice` (`src/plugins/services.ts`). The rest of `agents` answers `unsupported` until a later step; a CLI's
  local host has none of them.
- `gates.merge`: no `operator`; a plugin that wants to bypass vetoes cannot (§11.3).
- `sandboxes.provider(name)`: the kernel's wrapped object (§7.1), never a raw plugin object; a provider plugin asking
  for itself gets the wrapper too.
- `auth`: facts, never values. The only way a plugin gets a secret is `config.secret` for its own declared secrets (§10.3).
- `profiles.resolve`: fires `profile.resolved` (§6.6.5); the result is the same pinned shape the kernel spawns with.

### 8.5 What a plugin never gets

An actor handle, the engine client (`src/core/relay.ts` `client()`), raw credentials of the kernel or of another plugin,
the RPC signing key (`src/subagents/token.ts`), the spool, a path into another plugin's storage, or the ability to fire
a kernel hook. These stay in the kernel.

## 9. The out-of-process protocol

### 9.1 Overview

A third-party plugin is a process the host starts. It is a harness.v1 **client**: it holds a scoped token, calls the API
for its primitives, and receives hook calls on an SSE stream. Nothing in the protocol is plugin-specific except the
`/v1/plugins/{name}/…` routes; the transport, authentication, idempotency, envelope and resume rules are harness.v1's
(docs/harness-architecture.md §6–7). Decision: reuse client tokens and scopes rather than a second permission model; a
plugin is a client that happens to be started by the daemon.

### 9.2 Process and environment

The host spawns `entry.command` with cwd = the plugin's root, `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` substituted, and
**only** this environment: `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, the manifest's `entry.env`, and
(`ProcessEnvironment`) `CAPCOMD_PLUGIN_NAME`, `CAPCOMD_PLUGIN_ROOT`, `CAPCOMD_PLUGIN_DATA`, `CAPCOMD_PLUGIN_SOCKET`,
`CAPCOMD_PLUGIN_SESSION`, `CAPCOMD_PLUGIN_TOKEN`, `CAPCOMD_PLUGIN_PROTOCOL=1`. No `CAPCOMD_*` of the daemon's, no
`BOXD_*`, no `GITHUB_TOKEN`. stdout and stderr are captured: a line that parses as JSON with a `level` field is a
structured log (§13.3), any other line is logged at `info`, both under the plugin's name, redacted (its own token and
its secrets' values among what is redacted). A runtime on the user's machine is the plugin's concern (the launcher pattern in
`plugins/capcomd/mcp/launch.mjs`: Bun, else Node).

The kernel's launcher is `src/plugins/process.ts`. The process leads a process group of its own (the daemon's terminal
signals don't reach it; a kill takes what it started too, and so does its exit: once the process is gone, what is left
of its group is killed, so nothing it started outlives its token or holds what the next start needs). Its stdin is a
pipe the daemon holds and never writes: it closes when the daemon is gone, and the process SHOULD exit then (the client
library ends its hooks stream, §9.8). Each
start is recorded in `<data>/process.json`; a process an earlier daemon started and never stopped (it died) is killed
before the next start, only while that pid still runs the recorded command. `CAPCOMD_PLUGIN_SOCKET` is the daemon's
**plugin socket**, `<harness socket without .sock>-plugins.sock` (`src/api/socket.ts` `pluginSocketPath`, 0600), bound
before the plugins load (§5.5 step 4): it serves the harness.v1 API to plugin tokens only (401 for any other,
`src/api/server.ts` `pluginsOnly`). Only the daemon starts processes: a CLI's local host has no launcher, so a
`process` plugin stays `validated` there, and an operation a CLI or the MCP server runs itself fires its `ops.ts` gates
where the plugin doesn't listen (§6.1): a process plugin's gates judge what the daemon runs.

### 9.3 Handshake and token

Before spawning, the host mints a client token (`src/api/clients.ts` `mintPluginClient`: `addClient`'s shape) named
`plugin:<name>` with the manifest's `scopes` and a marker (`plugin`) that lets the gateway recognise it as *that plugin's*
token. It lives in the daemon's memory only, never in `harness-clients.json`, so a daemon that dies leaves no working
token behind. The token is revoked when the process is gone (it exited, or the plugin disposed); a new one is minted per
start. A session id is generated per start.

The process MUST `POST /v1/plugins/{name}/sessions` within `connectWithinMs` (30 s) with `SessionOpen {session,
protocol: 1, manifestHash, pid, hooks}`. The host checks: the token is the plugin's own (403 otherwise), the session id
is the one it issued and not yet open (409), `manifestHash` is the sha256 of the manifest it loaded (409: the process
was started from other files), `protocol` is one it speaks (422), `hooks` equals `contributes.hooks` (422). It answers
`SessionOpened {config, secrets, hookTimeoutsMs, connectWithinMs, daemon}`: the layered config without secret properties,
the secret values **once** (§10.3), and the deadlines it will apply. The plugin is `active` when the hooks stream (§9.4)
is open; `connectWithinMs` bounds that too, and a process past it is killed (`handshake_timeout`). A secret whose
reference resolves to nothing is left out of `secrets` with a warning in the daemon's log (§10.3). The plugin's listeners are registered when its first session opens, one per declared hook; they stay
through restarts (§9.5), so a gate fired while the process is down is still asked, and fails closed.

### 9.4 Hook delivery

The process opens `GET /v1/plugins/{name}/hooks?session=…` (SSE). Frames (`HookFrame`):

- `hook.call {seq, call: WireHookCall}`: a `HookCall` without the `AbortSignal`; `deadline` is the signal.
- `hook.dropped {seq, count, hooks}`: observe calls the host dropped (§9.5).
- `session.closing {seq, reason}`: finish open calls and exit (§9.7).

`id:` is `seq`, so `Last-Event-ID` resumes. For a `veto`/`modify` call the process MUST `POST
/v1/plugins/{name}/hooks/{callId}` with `HookAnswer {session, result}` before `deadline`; the host validates the shape
and the patch (§6.2) and answers 204, or 409 when the call was already answered or timed out (the host applied §6.5), or
422 when the result is invalid (the call is `invalid_result`). An observe call needs no answer; one is accepted.

**Ordering.** Frames are in kernel order per plugin. Gate and modify calls to one plugin are **one at a time**: the next
is sent after the previous is answered or timed out (the chain in §6.2 needs it). Observe calls are sent as they happen,
interleaved. **Deadlines** are absolute daemon-clock timestamps; the process SHOULD answer with ≥ 1 s margin. **Retries:**
the host never re-asks a timed-out gate call (the policy applied); a reconnecting process is re-sent the calls still open
(same `callId`); the client library retries a failed `POST …/hooks/{callId}` until the deadline. The answer route's 422
is the registry's own judgement of the answer (its shape for the mode, a modify patch's rule): the call fails
`invalid_result`, which a gate turns into a deny. Every frame passes the kernel's redactor before it is written (§11.5).

### 9.5 Backpressure, disconnects, restarts

- Observe frames queue per plugin, 1 000 frames or 4 MB; past that the oldest observe frames are dropped and counted
  in the next `hook.dropped`. Gate and modify frames are never dropped; a plugin that cannot keep up with gates times out
  and §6.5 applies.
- The SSE heartbeat is 15 s (`src/api/server.ts` `HEARTBEAT_MS`). A hooks stream closed for more than 60 s makes the
  plugin **disconnected** (`plugin.process_changed {event: disconnected}`): gate calls fail with kind `disconnected`, observe
  calls queue. The process may reconnect with `Last-Event-ID` within the same session (`reconnected`).
- A process that exits is restarted with backoff 1 s, 2 s, 4 s … 60 s (`plugin.process_changed {event: restarting, restarts}`),
  with a **new session and token**. Five exits within 10 minutes → `failed(restart_limit)`; its listeners stay **held**
  until `capcomd plugins enable` (a new process) or `disable` (the operator's call): each gate or modify call to it fails
  `crashed` at once (a gate denies, an open modify is skipped, §6.5) and observe calls are dropped, so a crash-looping
  gate denies, as a suspended one does (§11.3), instead of letting operations pass unjudged. A gate call in flight when
  the process exited is `crashed` (denied). A gate or modify call made while the process is down (between an exit and the
  next start's stream) waits for that start, within its deadline (`timeout`, denied, past it); observe calls queue.
  `restarts` in the event is the number of exits in the window. A start that never connects is killed and counts as an exit.
- The breaker (§6.5) counts crashes and disconnected gate calls as failures.
- The process runtime is `packages/plugin/src/host/process.ts` (transport-agnostic); the gateway maps the routes onto it.

### 9.6 Reverse calls: `ctx` over the API

The client library (§9.8) implements `PluginContext` on top of harness.v1. The mapping is fixed by this table; a
primitive without a route in protocol v1 rejects `unsupported` out of process (it works in process):

| `ctx` | Route (existing harness.v1 unless marked) |
|---|---|
| `runs.get/list`, `agents.get/tree`, `messages.inbox`, `gates.pending` | `GET /v1/runs`, `/v1/runs/{id}`, `/v1/runs/{id}/agents`, `/v1/runs/{id}/messages`, `/v1/approvals` |
| `runs.new`, `runs.pause/resume/end`, `runs.title` | `POST /v1/runs`, `/v1/runs/{id}/pause|resume|cancel`, `PUT …/title` |
| `agents.cancel`, `agents.title`, `messages.send` | `POST /v1/runs/{id}/agents/{a}/cancel`, `PUT …/title`, `POST …/messages` |
| `events.subscribe/replay` | `GET /v1/streams/{stream}/events`, `GET /v1/events` |
| `events.emit` | **new** `POST /v1/plugins/{name}/events` |
| `storage.*` | **new** `/v1/plugins/{name}/storage[/{key}]` |
| `profiles.list`, `sandboxes.descriptors`, `auth.loginPresent` | `GET /v1/profiles` (ADR-024; capability `profiles`; `project` is its `?repo=`, and its rows carry `name`, `version`, `source`, `description`, `tags` and more), `GET /v1/sandboxes`, `GET /v1/logins` |
| `agents.spawn/await/grant/notice`, `gates.verify/merge`, `board.*`, `kv.*`, `jobs.*`, `triggers.*`, `profiles.resolve`, `sandboxes.provider/forRun`, `seams.*`, `cli`, `mcp`, `api`, `ui` | **protocol v1: in-process only** (`unsupported`). Routes for spawn, gates, board, kv, jobs and triggers are the next protocol version's additions (§9.10); front-door and seam contributions stay in-process by design (a seam call must not cross a process boundary per `exec`). |

The caller's principal on these calls is the plugin's token's, so `ops.ts` and `policy.ts` enforce as for any client.
`events.emit` and `storage` over the wire go through the plugin's own context on the host (`PluginProtocol.context`), so
they are checked exactly as in process: `emit` needs the `steer` scope (§11.1) and a declared type, `storage` needs no
scope. `ctx.storage` is the kernel's in process too from §17.2 step 9 (`src/plugins/storage.ts`; the daemon's host only:
one process writes a plugin's storage). The `emit` route's Idempotency-Key is the plugin's, not the start's token's, so a
retry after a restart is answered with the first `seq`. The `storage/{key}` routes take the key with its `/` as is; a
compare-and-swap's 409 carries `current`, the entry now.

### 9.7 Shutdown

On dispose the host sends `session.closing`, keeps the API open for the process for 5 s, then SIGTERM, then SIGKILL
after 5 s more (§5.3). The process SHOULD answer open gate calls (deny with "plugin stopping" is acceptable) and exit 0.
A process with no hooks stream open can't hear `session.closing`: it gets SIGTERM at once. Its token is revoked once it
is gone; calls still open fail `disconnected`.

### 9.8 The client library

`@capcomd/plugin` ships `connect(env?: ProcessEnvironment): PluginClient` (`packages/plugin/src/client.ts`) implementing
`PluginClient` (`packages/plugin/src/protocol.ts`): `open`, `hooks` (an `AsyncIterable<HookFrame>` with reconnect and
resume by `Last-Event-ID`, ending on `session.closing`, on the caller's signal and when stdin closes), `answer` (retried
until the call's deadline while the daemon can't be reached; a refusal is final), `emit` (with an Idempotency-Key),
`storage` (with an optional run) and `fetch`. It uses `node:http` over the plugin socket, so a plugin runs on Bun or Node.
`manifestHash(root)` and `sessionOpen(env?, hooks?)` build the handshake (§9.3: this start's session, protocol 1, the
sha256 of the `plugin.json` in `CAPCOMD_PLUGIN_ROOT`, the pid, the manifest's hooks). The Slack example (§15.4) and the
test fixture (`tests/plugins/fixtures/proc-gate`) code against it. It is published with the package (§14.6), also as
the entry point `@capcomd/plugin/client`.

### 9.9 OpenAPI additions

The routes are in the committed contract, `openapi/capcomd.json`, generated from `src/api/contract.ts` (`plugins.*`):
`GET /v1/plugins`, `GET /v1/plugins/{name}`, `POST /v1/plugins/{name}/enable|disable` (feature flag `plugins`), and
`POST /v1/plugins/{name}/sessions`, `GET /v1/plugins/{name}/hooks`, `POST /v1/plugins/{name}/hooks/{callId}`, `POST
/v1/plugins/{name}/events`, `GET /v1/plugins/{name}/storage`, `GET|PUT|DELETE /v1/plugins/{name}/storage/{key}` (feature
flag `plugins.protocol`), with their bodies (`PluginDetail`, `SessionOpen`, `SessionOpened`, `HookFrame`, `HookAnswer`,
`EmitBody`, `StorageEntry`) and the `plugin.*` events the host writes. The draft fragment they were specified in
(`openapi/drafts/plugin-api.fragment.json`) is deleted (§17.2 step 9). `enable` and `disable` act for the daemon's life
(config doesn't record `plugins.<name>.enabled` until §10.2's layering), and a built-in can't be disabled through the
API (409: the kernel runs on its places, agents, forges and front doors). The events not written yet
(`plugin.config_refused`, `plugin.hook_deprecated`, `plugin.trusted`, `trigger.*`) join the contract with the steps that
write them; their data shapes are `packages/plugin/src/events.ts`. `packages/plugin/test/protocol.test.ts` checks the
contract holds every route and that its frames and hook names are the package's.

### 9.10 Protocol versioning

`SessionOpen.protocol` is an integer. The host serves a set of versions (today `{1}`) and refuses others with 422. A
new frame type, a new optional field or a new route is **not** a new version (clients ignore unknown frames and fields).
A changed answer shape, a removed route or a changed deadline rule is. The host serves the previous version for one
minor release after a bump (the `typeVersion` rule of harness-architecture §6.2).

## 10. Config

### 10.1 Schema

The manifest's `config` is a JSON Schema (draft 2020-12) for the object at `plugins.<name>` in capcomd's config files.
It MUST be an object schema with `additionalProperties: false` (validation warns otherwise). Two vendor keywords:
`"x-secret": true` marks a property whose value is a **secret reference** (§10.3); `"x-per-run": true` marks a property a
run may override (§10.2). Defaults in the schema are applied before validation.

### 10.2 Layering

Values are merged key by key, later layers winning, with JSON merge-patch semantics (objects merge recursively, arrays
replace, `null` deletes), as `src/config/store.ts` `applyConfig` and `driverPolicy` merge `driver` today:

1. the schema's defaults;
2. **user**: `~/.capcomd/config.json` `plugins.<name>`;
3. **project**: `.capcomd/config.json` `plugins.<name>` of the project the daemon serves: the checkout of its working
   directory (`src/plugins/host.ts` `configured`; a run's own `repo` doesn't change a plugin's config, which is constant
   for its life). The user and project layers are off with `CAPCOMD_NO_CONFIG`;
4. **env**: `CAPCOMD_PLUGIN_<NAME>_<KEY>` (name and key upper-cased, `-` and `.` → `_`; a real environment variable
   wins, as `applyConfig` lets one win today);
5. **run**: `plugins: {<name>: {…}}` in `POST /v1/runs` or `capcomd run --plugin-config name.key=value`, only for
   `x-per-run` properties; refused (422) otherwise.

Layers 1–4 are read at `resolved` (§5.4) and are what `ctx.config.get()` returns; they change only through
`disable`/`enable` (§5.4). Since §17.2 step 11 the kernel reads them for its built-ins, and since step 12 for every plugin (`src/plugins/config.ts`): the
project layer is the `.capcomd/config.json` found from where the process runs, an environment value that parses as JSON
is that value (`CAPCOMD_PLUGIN_WATCHDOG_STALLEDAFTERMS=600000` is a number), else a string, and it replaces that key's
value rather than patch it (`CAPCOMD_PLUGIN_SOURCE_SCHEDULE_SCHEDULES='{}'`: no schedules); `CAPCOMD_NO_CONFIG` skips
the files, not the environment. A secret property (`x-secret`) is never part of the config: its reference is read as
§10.3 says. Layer 5 is run data, not plugin config: the kernel validates it at run creation and stores it
at `ctx.storage` run scope under the key `config` (readable by the plugin, written only by the kernel), so a listener on
a run-scoped hook reads `await ctx.storage.get({runId}, "config")` for that run's overrides. Decision: `config.get()`
is a constant for the plugin's life, which keeps every listener a pure function of its call plus one read.

`enabled` is a reserved key at every layer: `plugins.<name>.enabled: false` holds the plugin at `validated` (§5.4). It is
the user's to set; a project's `enabled: false` turns off only a plugin of that project (a repository can't switch off a
gate the operator runs, nor switch on what the operator turned off). The project layer, like the run layer, can't set a
secret property (§10.3). Nor can it fail a plugin that isn't the project's own: settings of the project layer that the
schema refuses (a wrong type, a secret) for such a plugin are set aside, reported (`plugin.config_refused`, layer
`project`) and left out, and the plugin runs on its other layers; only the project's own plugins fail `config_invalid`
on their project layer (§10.4). Layer 5 is checked against the plugins the daemon would load (their manifests, not their code):
an unknown plugin, a property without `x-per-run` or a value its property's schema refuses is a 422 with `field`
`plugins.<name>.<path>` (`capcomd run` refuses it as a usage error, reason `plugins`, before the run exists); the stored
key `config` of the run scope is the kernel's, and a plugin's write or delete of it is `forbidden`
(`src/plugins/run-config.ts`). Capability `plugins.config` says a daemon takes `plugins` in `POST /v1/runs`.

### 10.3 Secrets

Config files never hold secret values. A property marked `x-secret` takes a **reference** `{"$secret": "<ref>"}` where
`ref` is `env:<VAR>` (an environment variable of the daemon) or `keychain:<account>` (the OS keychain through
`src/config/keychain.ts`, service `capcomd`; not resolved yet: `unsupported`). The reference is the user layer's, else one
held by `CAPCOMD_PLUGIN_<NAME>_<KEY>`, else, for a built-in only, the schema's `default`: a plugin from a directory (a
user's or a project's) never names its own, as its author would choose which of the daemon's variables it gets, so its
secret is unset (`not_found`) until the user points it at one. A project's or a run's reference is `config_invalid` (a
repository must not point a plugin at another of the daemon's variables), and so is a value where a reference belongs. A
reference that resolves to nothing is the plugin's to report: `ctx.config.secret` rejects `not_found`, and a process
plugin's is left out of `SessionOpened.secrets` with a warning (§9.3), so a built-in such as `sandbox-boxd` still loads
without its key and says why it can't run. A plugin reads its own secrets through `ctx.config.secret(key)` (in process) or receives them once in
`SessionOpened.secrets` (out of process, over the 0600 socket; never in the environment, never in argv). A secret
property never appears in `ctx.config.get()`, `GET /v1/plugins/{name}`, events or logs. A plugin MAY read only secrets
declared in **its own** schema; the kernel's secrets (`BOXD_API_KEY`, client tokens, the RPC key, git credentials) are
not reachable. Built-ins follow the same rule: the boxd plugin declares `apiKey` as `x-secret`, and the kernel's
existing keychain entry is mapped to it by the config migration (§17).

### 10.4 Validation errors

Config is validated against the schema at `resolved` (layers 1–4) and at run creation (layer 5). Invalid config is
`failed(config_invalid)` with `plugin.config_refused {errors: [{path, message}], layer}`; the plugin is **not** run with
defaults (a project layer for a plugin not the project's is set aside instead, §10.2). Each layer is checked on its own, so an error names its layer (one event per layer); the kernel checks the
subset of JSON Schema manifests use (`type`, `enum`, `minimum`/`maximum` and their exclusive forms, `minLength`/
`maxLength`, `items`, `required`, `properties`, `additionalProperties`); a disabled plugin's settings aren't checked. `plugin.failed`'s message and `capcomd plugins show` show the errors; `GET /v1/plugins/{name}`'s `config.sources` say which layer each value came from. A run-layer error is a 422 on `POST
/v1/runs` with `field: "plugins.<name>.<path>"`.

## 11. Security model

### 11.1 Scopes

| Scope | Grants a plugin's own calls | Not granted |
|---|---|---|
| `read` | every `GET`-shaped primitive: `runs.get/list`, `agents.get/tree/await`, `messages.inbox`, `gates.pending`, `events.subscribe/replay`, `kv.get/list`, `board.list`, `jobs.get/list/wait`, `profiles.*`, `auth.credentialMode/loginPresent` (`auth.redact` needs no scope, §11.5) | |
| `steer` | `runs.new/pause/resume/end/title`, `agents.spawn/cancel/grant/title/notice`, `messages.send`, `gates.verify`, `gates.merge` into **non-protected** targets, `board.*`, `kv.put/cas`, `events.emit`, `jobs.start/cancel`, `triggers.subscribe/unsubscribe` | merging into a protected target (parks for a human as for a driver) |
| `configure` | `ui.descriptor` writes (`write()`), `profiles` writes (ADR-024 step 6: `PUT /v1/profiles/{name}`; `ctx.profiles` has no write method yet) | |
| `approve` | **never grantable to a plugin** (`approve` in `scopes` fails validation) | `gates.decide` does not exist on the context |

A plugin with no scopes answers hooks and implements seams only. The plugin principal is enforced where the others are:
`ops.ts` and `policy.ts` (ADR-018 §4), and the gateway for out-of-process calls. Decision 3 (ADR-023): approvals stay
human; `permissions.approve` on profiles is deferred and nothing here forecloses it (an ancestor agent approving is a
`policy.ts` rule on the `agent` principal, orthogonal to plugins).

### 11.2 Caller principals

A CLI command, MCP tool or API route a plugin contributes runs with the **caller's** principal and scopes: the plugin's
code is a front door, not an actor. It cannot do through a tool what the caller could not do directly. A plugin that
wants to act on its own behalf uses `ctx` from a hook or a timer, with its own principal.

### 11.3 How veto power is constrained

- A gate listener can **refuse** or **hold** (merge only); it can never make the kernel do something it would not have
  done: no `allow` carries an effect, `hold` creates a human approval, `approval.deciding` has no approve.
- A `modify` patch can only **narrow** (§6.6): budgets, grants, egress, size and TTL go down; tool lists and skills grow
  only in the direction the profile already allows; `checks`, `target`, `task` and `reviewer` are immutable.
- The breaker bounds a broken gate's damage to "denies until an operator looks" (§6.5); the operator's `--operator`
  merge is the audited escape (decision 2).
- A plugin cannot fire hooks, cannot see or answer another plugin's calls, and cannot bypass a gate through `ctx.gates`.

### 11.4 Credentials

A plugin never receives a value for a credential that is not its own declared secret (§10.3). `ctx.auth` answers with
facts (`credentialMode`, `loginPresent`) and offers the redactor. Sandbox-bound secrets stay placeholders
(`bxds_…`, ADR-015 §3); the git credentials the kernel pushes with stay on the host and are configured into the forge's
`workdir` by the kernel, not handed to the forge as a string. They never reach a sandbox, and never meet a checkout an
agent can edit (§11.7).

### 11.5 Untrusted text and redaction

Agent-written text (tasks, titles, results, items, verdict reasons) and plugin-written text (deny reasons, event text,
notice details, descriptor strings) are `Untrusted`: clients render them as plain text and derive no action from them
(harness-architecture §8.2). Every hook payload, event `data`, log line and job output passes the kernel's redactor
(`src/agents/redact.ts`: known secret values and the token shapes `sk-ant-`, `sk-proj-`, `gh?_`, `github_pat_`, JWTs,
`cct1.`, `bxd_`) before it reaches a plugin or a stream. A plugin SHOULD run `ctx.auth.redact` on anything it writes
itself; the kernel runs it again on what the plugin emits.

Untrusted text another agent reads arrives inside a fence naming its author (`src/subagents/results.ts` `fence()`), and
every `<<<…>>>` on one line inside it is neutralised, whatever it says, so no marker, today's or a later one, can be
forged from inside (and, as before, an `end` or `untrusted` one split over lines). The context brief (§6.6.7, ADR-025 §6.1) is the one place untrusted text is the basis of a model's
attention from system-role text (Claude Code's appended system prompt; Codex's prompt): an item's description, written
by whoever wrote the item. What fences it there: the header is the kernel's, in plain prose, with no marker syntax and
none of a provider's own words (a failure is named with the kernel's reason); each description is first made one line
(invisible format characters dropped, control characters and line breaks made spaces), then redacted (the kernel's
shapes and the agent providers' credentials), neutralised with `fence()`'s rule and a lone `<<<` or `>>>` with it (so
two fields of one line can't make a marker together), and capped at `limits.descriptionChars`, and so are an item's
path and `paths`; an item's body never enters the brief. A `context` message kind, rendered fenced as recalled context that grants nothing,
is reserved for ADR-025 §6.3 and not shipped: the step-6 eval did not admit triggered injection (ADR-025 §13, "Made
while building step 6"; `docs/evidence/context/`), and inline items, which would be a fenced first message, were not
admitted either.

What an agent proposes for a durable layer (a candidate lesson, §6.6.8; an item lint checks, ADR-025 §5.3) is not
redacted but **refused** when it holds a secret (`src/context/scan.ts`): a redacted text could still hold a shorter
secret. The scan is seeded with every secret value the kernel puts in the run (the agent providers' credentials, the
plugins' secrets of §10.3, every variable of the run's environment named like a credential, the in-VM tokens' signing
key, the forge's credential for the run's repository), then the redactor's shapes and a few more (AWS, Slack, boxd and
Google keys, a private key, a URL with a password), a long random-looking string, and the paths credentials are kept
in (`.env*`, `*.pem`, `secrets/`, `~/.aws`, `~/.ssh`), over the text with invisible characters dropped and look-alikes
folded (NFKC, every dash a hyphen). Every string a candidate keeps is scanned, and a field name it ignores is repeated
only when it holds no secret. Its reasons are the kernel's words, never the matched text.

### 11.6 Isolation

In-process plugins are built-ins: the trust boundary is the capcomd package. Out-of-process plugins get a filtered
environment (§9.2), a scoped token (§9.3), secrets once over a 0600 socket (§10.3), and nothing else; their calls are
authorised and audited by the gateway like any client's (`client.action` events carry the plugin's client id). As with
drivers (ADR-018 §4), a process running as the same OS user is a guardrail against mistakes, not a containment boundary.

### 11.7 Git credentials and agent-editable checkouts

An agent can write anything in its sandbox: its checkout's `.git/config`, hooks and remotes, its `HOME`'s `.gitconfig`,
a `git` earlier on its `PATH`, and processes that read other processes' environments. Git reads all of these, and some
run commands (a credential helper, `core.sshCommand`, `core.fsmonitor`, hooks, filters, `include.path`) or send the
credential elsewhere (`url.*.insteadOf`, `pushInsteadOf`, a push URL, `http.proxy`). So:

1. **No git credential enters a sandbox.** The sandbox providers pass an exec exactly the env capcomd gives it, and
   capcomd runs no network git in a sandbox (no clone, fetch, push or ls-remote). Objects move through the host
   (`src/merge/transfer.ts`): to fetch (an agent's clone, `capcomd fetch`, a review's target, a continued agent's work,
   an env build's template, a context bundle at its commit), the host fetches the run's repository into its mirror and uploads a bundle of what the
   sandbox lacks, which the sandbox reads and whose refs the host names; to push (an agent's branch, its checkpoints),
   the sandbox bundles the commit, the host downloads it into its mirror, checks it is the commit asked for, and pushes
   it to the repository's URL with a lease. In the sandbox git only makes and reads bundle files. A proposal to a brain
   (groundray's `propose`, §6.6.8) runs on the host only: a bare host repo of its own fetches the brain and pushes the
   proposal branch with a lease; the authoring clone the groundray CLI commits in is fetched from it as a local path,
   and groundray itself talks to no remote.
2. **On the host, network git runs only through `src/merge/host-git.ts`**: `remoteGit` in a *host repo* (one capcomd
   made with `initHostRepo`: the mirror, the merge clones, the scratch and files repos), checked before every call: its
   local settings are only those `git init`, `git remote add`, a fetch and `git worktree add` write, its hooks are the
   ones it had when it was made, and it has no alternates; else it is refused (`HostRepoRefused`) and a disposable one is
   made again. `lsRemote` runs outside any repository. The remote is always the repository's URL as capcomd knows it,
   never a remote's name. Git runs with `GIT_TERMINAL_PROMPT=0` and `GIT_ALLOW_PROTOCOL=file:git:http:https:ssh` (no
   `ext::`); the user's own git settings (their credential helper, ssh keys, global `url.*` rewrites) apply, except that
   for an https remote whose forge has the user's credential for it (§7.4 `remoteCredential`; forge-github: the user's
   GitHub token, `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`, for `https://github.com`), it is the only credential
   helper for the remote's origin (the helper list is reset first, so git never hands the credential to the user's own
   helpers, such as `osxkeychain`, to store), in that one process's environment. The forge supplies the credential as
   data; `host-git.ts` builds the helper, and only for the remote's own origin.
3. `tests/unit/host-git-lint.test.ts` fails when a network git command is spelled anywhere else, or a credential helper
   is built outside `host-git.ts`; `tests/unit/host-git-credentials.test.ts` plants each vector above and checks that
   no planted command sees a token and nothing goes anywhere but the run's repository.
4. **Project templates** (a place whose sandbox is a VM per agent with snapshots, `caps.isolation: "vm"` and
   `caps.snapshots`: boxd; `src/env/templates.ts`). A project's template is an env build whose VM received the
   repository the same way as in item 1 (every branch's history, as a bundle from the host's mirror) and ran the
   project's setup step (`CAPCOMD_SETUP_COMMAND`, else its lockfile's install), so neither the VM nor its snapshot ever
   held a git credential. The setup step is the repository's own code: the build VM is isolated (no platform
   credentials), its egress leaves out every host that reaches a domain a host-bound secret of the place is bound to
   (the domain, a wildcard over it, `*`; nothing left fails the build), so a placeholder it can read can't be spent, the step runs with those placeholders unset, and the snapshot passes the same secret scan
   as every env build. A template is named `capcomd-env-<base>-<project>-<build>` (`<base>`: the env build of the same
   agent CLI pins without a repository; `<project>`: the repository URL's key; `<build>`: its commit, branch tips,
   lockfile and setup step), adds at most `CAPCOMD_TEMPLATE_MAX_GB` (10) to the base image (its checkout and agent home), and is recorded in the place's templates ledger
   (`templates.json`), which lists every snapshot capcomd made as one: a rebuild keeps the template it replaces and
   deletes the one before that, and capcomd deletes or overwrites no snapshot that list doesn't name. An agent's machine
   boots from its project's template when nothing else chose its image (`sandbox.environment`, a plan login's image,
   `CAPCOMD_ENV_SNAPSHOT`, `CAPCOMD_ENV=image`) and the template was built on the agent's CLI pins; the runner then
   uses the template's checkout in place under the same rules as Docker's warm checkout (`chooseWorkspace`), so the host
   sends only a bundle of what the template lacks; when the rules say clone, the clone borrows the template's objects
   (git alternates, `SendRequest.seed`) and the bundle again holds only what they lack. Without a usable template the
   machine boots from the base env and clones the whole repository. A run never waits for a template: with `CAPCOMD_PROJECT_TEMPLATES=auto` (the default; `manual`, `off`)
   the worker starts a background build when its project has none or one on other pins, and a rebuild when its agent
   couldn't use the template in place (unless the branch it was built from hasn't moved: the same template again) or
   got a delta over `CAPCOMD_TEMPLATE_REBUILD_MB` (50); one build per project at a time (another process's running
   build refuses `capcomd env build --project`), none within an hour of a failed one; and `sandbox-boxd` keeps a timer (§16.2: a plugin-owned job, `job.changed`
   `fired`), daily by default (`CAPCOMD_TEMPLATE_REFRESH_HOURS`, 0 for none), that rebuilds every template whose
   repository moved since it was built.

Checks that run on the host (`CAPCOMD_CHECKS=host`, or the test sandboxes) run agent-written code as the operator, which
no git setting can contain: there a planted setting or hook in the merge clone is refused (the merge fails), but the
check is a tripwire, not a boundary (that code can also rewrite the host repo's marker, or race the check), and the
code could read the operator's credentials directly. Use a real sandbox for agents you don't trust.

## 12. Versioning and compatibility

### 12.1 The plugin API

`apiVersion` is an integer major. Within a major, changes are **additive only**: a new hook, a new optional payload
field, a new primitive, a new union member in a `change` type, a new optional manifest key. A plugin written against
1.0 keeps working on 1.x. A removal or an incompatible change bumps the major; the host serves the previous major for
one minor release of capcomd. The spec records additive changes in §18 as 1.1, 1.2, …

### 12.2 The manifest

`schema: capcomd.plugin/v1`. Additions never bump it; unknown keys are refused, so a plugin using a 1.x key fails on a
1.(x−1) host with a clear path in the error, which is the intended behaviour (it names the feature it needs).

### 12.3 Hook payloads

Each hook has a `payloadVersion` (all 1). Adding a field or a `change` member keeps it; removing or renaming a field
adds a new hook name rather than bumping (hook names are never reused) and deprecates the old (§12.4). A listener MUST
ignore `change.kind`s it does not know.

### 12.4 Deprecation

A deprecated hook keeps firing for one minor release with `call.deprecated = {since, replacement}`; the host emits
`plugin.hook_deprecated` once per daemon start per listening plugin; `capcomd plugins validate` warns. After the release it
is removed from `HOOKS` and a manifest declaring it fails validation (which is the signal to the author).

### 12.5 The matrix the loader enforces

| Check | Where | Failure |
|---|---|---|
| `schema === "capcomd.plugin/v1"` | validate | `invalid_manifest` |
| `apiVersion ∈ host.apiVersions` | validate | `incompatible` |
| `engines.capcomd` satisfied by the running version, or exempted | validate | `incompatible` |
| every declared hook exists and is not removed | validate | `invalid_manifest` |
| `requires` satisfiable | resolve | `unresolved` |
| `SessionOpen.protocol ∈ host.protocols` | handshake | 422 → `handshake_timeout` |
| `manifestHash` matches | handshake | 409 → `crashed` |

## 13. Observability

### 13.1 Events every plugin emits automatically

On the `daemon` stream: `plugin.loaded`, `plugin.failed`, `plugin.disposed`, `plugin.version_refused`,
`plugin.duplicate_refused`, `plugin.config_refused`, `plugin.hook_failed`, `plugin.suspended`, `plugin.resumed`,
`plugin.hook_deprecated`, `plugin.process_changed`, `plugin.trusted` (`plugin.config_refused` and `plugin.trusted` in the
contract with capability `plugins.config`). On the run's stream: `plugin.gate_denied` and
`plugin.gate_bypassed`. Jobs: `job.started`, `job.ended`. Triggers: `trigger.received`, `trigger.subscribed`,
`trigger.unsubscribed`. Data shapes: `packages/plugin/src/events.ts`, and the contract for those written (§9.9). All durable, written
by the host, with daemon-written `text`; a plugin's `reason` inside them is untrusted. The run-stream ones are written from
§17.2 step 5 (the gates), as scope events (`PLUGIN_GATE_DENIED`, `PLUGIN_GATE_BYPASSED` in capcomd.v1) by whichever
process ran the gate; `plugin.hook_failed` stays on the daemon stream. A plugin's own events (`plugin.<name>.<type>`,
§4.7.4) are written on either stream: on a run's, as a scope event of that run that keeps the plugin's `entity` and
`text` (never an agent's event: `agentId` is null).

### 13.2 `GET /v1/plugins`

Every discovered plugin with `state`, `enabled`, `cause`, `hooks`, `seams`, `hooksSuspended` and `stats {calls, failures,
dropped, p50Ms, p95Ms, lastFailureAt}` (`dropped`: observe calls dropped from a full queue, §6.2); `GET /v1/plugins/{name}` adds the manifest and the config with sources and without
secrets. `capcomd plugins list|show` print the same. `/v1/health` gains the feature flag `plugins`.

### 13.3 Logs

`ctx.log.<level>(message, fields)` writes one JSON line to the daemon log with `plugin`, `level`, `message`, `fields`
(redacted), `runId`/`agentId` when inside a hook call, and `traceId`/`spanId`. Out of process, stdout/stderr lines are
parsed as in §9.2. Logs are not events: they never reach clients.

### 13.4 Tracing

Every hook call is a span `plugin.hook` with attributes `plugin`, `hook`, `mode`, `callId`, `outcome`
(`allow|deny|hold|skipped|failed`), `failure.kind`, under the run's trace (`tracing-simple.ts`: `traceId =
sha256("trace:"+runId)`, the agent span `agentSpanId`). `call.trace` carries the ids so an out-of-process plugin can
continue the trace; `ctx.trace.span(op, fn)` opens `plugin.<name>.<op>` as a child of the active call's span. Seam
calls are spans already (`tracedProvider`); they gain `plugin` as an attribute.

### 13.5 Metrics

Derived from events and spans, no new pipeline: per plugin, hook calls and failures, p50/p95 per hook, breaker trips,
observe drops, process restarts; per seam, calls and errors by `ErrorClass.kind`. Exposed in `GET /v1/plugins` `stats`
and by `capcomd doctor`.

## 14. Testing

Every plugin MUST pass the conformance suite; built-ins run it in `test:fast` (`bun test packages/plugin` and the
plugin's own tests), third-party plugins through `capcomd plugins validate --conformance` and the test kit.

### 14.1 Load and dispose

`loadDispose(manifest, module)`: activate in a fake context; assert every registration is declared in the manifest and
every declaration was registered; dispose; assert no registration remains (`FakeContext.dispose()` returns `[]`), the
hooks do not fire, the tools and routes are gone (dsh's HMR-safety test, research §2.10). Then activate **again** in a
fresh context and repeat: a module must be re-activatable (§5.4 `enable`).

### 14.2 Seam conformance

- **sandbox**: `tests/providers/conformance.test.ts` as today (idempotent `ensure`, `exec` semantics, timeouts that kill
  inside the machine, `destroy` idempotent, `list` by prefix) plus `describe` matches the seam name, `available` never
  rejects, `classifyError` returns `not_found` for a destroyed machine and `transient` for a refused connection, and a
  `SeamCall.signal` abort during `exec` rejects `timeout` within 5 s.
- **agent**: recorded streams (`apps/tui/fixtures`, `packages/agent-thread/fixtures`) through `parse` produce the
  golden `AgentRunState`; `guard` fires at `maxTurns`, or `command` hands the limit to a CLI that enforces it itself
  (Claude Code `--max-turns`); `outcome` of each fixture matches; `command` writes to `ctx.jsonl`; `parse` returns null
  for a foreign line and redacts every string; `toolPolicies.orchestrate` contains no edit or write tool (and, with no
  allowlist, has `sandbox: "read-only"` or `denyCommands` that refuse `git commit` and `git push`). The suite is `packages/plugin/src/agent-conformance.ts`; every method it calls
  is pure, so `capcomd plugins validate --conformance` runs it with no streams, and a plugin's own tests pass theirs to
  `testkit.conformance.agent`.
- **context** (ADR-025 §3.1): `describe` names the declared provider with kinds and layers the kernel knows,
  `available` never rejects, `classifyError` classifies anything (its own `not_found` as `not_found`), `propose` is
  refused `unsupported` unless `caps.writable` and never stages through a handle `resolve` didn't give, a call whose
  signal is already aborted rejects; with a scope that has
  items (a fixture repository the plugin's tests bring), `resolve` binds it to the same handle and revision each time
  and names a bundle only when `caps.bundle` (a repository at a full commit, under a plain name), `index` is deterministic for a handle and every line is well-formed (its `ref.provider` the provider, a declared
  kind, untrusted description), `get` returns an indexed item with untrusted text and rejects an id that isn't there
  `not_found`, and `search` answers at most `limit` hits. `packages/plugin/src/context-conformance.ts`; `capcomd plugins
  validate --conformance` runs it without a scope (the item cases skipped).
- **forge**: against a local bare repository (`tests/merge/gitfixture.ts`): `land direct` is a CAS (a moved target is
  `conflict`), `land` twice with the same `mrgId` is `already: true`, `pr` mode without `pullRequests` rejects
  `unsupported`, `matches` is pure; `remoteCredential`, when present, answers null for a remote the forge's service
  doesn't host and an `origin` that is the remote's for one it does, and host git applies it as the only helper for that
  origin and refuses one for another origin (`tests/plugins/forges.test.ts`).

### 14.3 Real composition

`bootWith(plugins, fn, opts?)`: a daemon booted **through the host** on the fake sandbox with scripted agents
(`CAPCOMD_SPAWN_EXEC=script`), the plugin loaded like any other, `fn` driving it over the harness.v1 socket, asserting
user-visible output (dsh's rule, research §2.10; `tests/scenarios/` already works this way). Every built-in converted in
§17 keeps one.

`packages/plugin/src/boot.ts` (§17.2 step 13) runs `capcomd serve` as a separate program (`opts.capcomd`, an argv
prefix; else `CAPCOMD_TESTKIT_BIN`, else `capcomd` on the `PATH`), so a published package boots whichever capcomd the
plugin's author installed. The daemon gets a home of its own (a temp directory: engine data, both sockets, its clients,
state), `CAPCOMD_NO_CONFIG`, the fake sandbox, scripted agents with the profiles `planner`, `worker` and `reviewer`
(`opts.profiles` replaces them), a free engine port block, and none of the caller's `CAPCOMD_*`, `RELAY_*`, `RIVET*`,
`BOXD_*`, `GITHUB_TOKEN`, `GH_TOKEN` or `GIT_*` (a test run from a git hook has `GIT_DIR` and the like set: the daemon's
git would act on the developer's repository). Each plugin is a directory, validated (§4.9) first and linked as the user's
(`<home>/plugins/<name>`, §4.8 step 2): a plugin is a program out of process (§5.2), so there is no in-memory form.
`opts.config` becomes `CAPCOMD_PLUGIN_<NAME>_<KEY>` (§10.2; a secret's value is its reference, its variable in
`opts.env`). It waits for `GET /v1/health`, then for each plugin to be `active` (a `failed` one, or one held at
`validated` with a cause, fails the boot with the cause and the daemon's log), within `opts.readyMs` (120 s). `fn` gets
`{socket, token, home, env, fetch, cli, log, stop}`: an operator's token (`capcomd clients add`, every scope but none of
the developer's), `cli(args)` running the CLI against this daemon, `log()` the daemon's output. The daemon is stopped
(SIGTERM, which stops its engine and plugins; SIGKILL after 30 s) and its home removed (`opts.keep` keeps it).

### 14.4 Hook contract

`hookContract(manifest, module)`: for each declared hook, fire a generated payload; assert the result's shape for the
mode, that a `modify` patch touches only patchable fields, that the listener respects `call.signal` (a call with a 100 ms
deadline settles within 1 s), and that firing twice with the same `idempotencyKey` has one effect (the fake context
counts primitive calls by key). A mode-consistency script in `scripts/` greps every `hooks.fire(` site in `src/` and
checks the mode against `HOOKS` (ADR-023 step 1).

### 14.5 The test kit

`@capcomd/plugin/testkit` (`packages/plugin/src/testkit.ts`): `validateManifest`, `fakeContext`, `load`,
`loadDispose`, `bootWith`, `hookContract`, `conformance.{sandbox, agent, forge, context}`, `call`, and `samplePayload`.
Implemented with ADR-023 step 1 on the host's own context and hook registry (`packages/plugin/src/host/`), and what
`test:fast` runs on `packages/plugin/examples` (`tests/plugins/host.test.ts`). `bootWith` is §14.3. `conformance.forge`
rejects `unsupported`: a seam is in process only (§9.6), so only a built-in is a forge, and the kernel tests those against
local repositories (`tests/plugins/forges.test.ts`, `tests/merge`). The conformance suites register `bun:test` tests;
everything else runs on Node too.

### 14.6 The published package

`@capcomd/plugin` is built by `packages/plugin/scripts/pack.ts` from the workspace package, which points at the
TypeScript sources and stays `private` (its `exports` are the repository's). The published one: ESM JavaScript for
Node ≥ 20 and Bun (no Bun API at run time: `semver.ts` compares versions itself), declarations whose relative imports
carry `.js` (`moduleResolution: nodenext`), the manifest's JSON Schema, a README and the LICENSE; entry points `.`,
`./client`, `./testkit`, `./schema`; `zod` its one dependency. Its version is capcomd's: `@capcomd/plugin@X.Y.Z` is the
API capcomd X.Y.Z serves. `packages/plugin/package.json`'s `version` is bumped with `package.json`'s in the release commit
(`scripts/release-notes.ts --check` and `pack.ts` refuse a difference). `packages/plugin/scripts/smoke.sh` installs the
tarball into a fresh project with npm and uses it from Node (every entry point, the manifest checks, `loadDispose` and
`hookContract`, `connect()` speaking the protocol to a stand-in daemon over a Unix socket) and typechecks a TypeScript 5
consumer under `nodenext`: CI on every change (Node 20), and the release before publishing. The release workflow
(`.github/workflows/release.yml` `npm-plugin`) publishes it from the release tag after capcomd's own checks, with
provenance and the same dist-tag, only while the repository variable `PUBLISH_PLUGIN_PACKAGE` is `true`; an
already-published version is skipped.

## 15. Worked examples

All five typecheck against the package, which they import by its name, `@capcomd/plugin` (`packages/plugin/examples`,
`bun test packages/plugin`); their manifests validate against the JSON Schema. The in-process ones pass `loadDispose`
and `hookContract` (`tests/plugins/host.test.ts`); the Slack example has its own tests and runs against a real daemon
(§15.4).

### 15.1 The Docker sandbox provider (`sandbox-docker`, in-process)

`examples/sandbox-docker`. `src/providers/docker.ts` `DockerProvider` becomes the module; the descriptor from
`registry.ts` is `describe()`; `available()` is `run-options.ts`'s `docker version` probe; `classifyError` replaces
regexes elsewhere; the 5-minute sweep `serve.ts` started is the seam's `sweep`, which the plugin runs on its own
timer (§16.2: a plugin-owned `timer` job with the key `sweep`, everyMs 300 000, started in `activate` and re-armed by
the daemon after a restart) when the daemon starts and when the timer fires, for a place in use (the daemon's, or one
a run asked for) through the kernel's wrapper (`src/plugins/sandboxes.ts` `sweepPlace`); the example schedules its own
from a `daemon.started` listener, which a third-party plugin MAY do. Outside the daemon `ctx.jobs` is `unsupported`,
so a CLI's plugins sweep nothing. Config: `bin`, `image`, `agentMemoryMb` (the `agentMemory` setting, with a `settings` descriptor),
`idleLifetimeSeconds` (`x-per-run`). Nothing in `worker.ts`, `agent-workflow.ts` or the API changes.

### 15.2 The GitHub forge (`forge-github`, in-process)

`examples/forge-github`. `HttpGitHub`, `prMerge`'s poll loop and the `gh` calls become `land`, `openPullRequest`,
`findPullRequest`, `publishRepository`, `listBranches`, `login`, `remoteCredential` (the token for host git over https to
github.com). The token is an `x-secret` config property with `gh auth token` as the fallback; `classifyError` maps rate limits to `quota` and 401/403 to `auth`. The kernel keeps the lock, the CAS,
integration and the checks.

### 15.3 The reviewer as a gate (`gate-reviewer`, in-process)

`examples/gate-reviewer`. `startReview`/`finishReview`/`parseVerdict`/`reviewBrief` become one `verify.judging`
listener: spawn the run's reviewer profile with `review: true`, keyed by the verification id (so a replay finds it),
await it until the call's deadline, parse the verdict from structured result data first, emit a `verdict` event, answer
`allow` or `deny{reasons}`. No reviewer configured → `allow` (the checks decide alone). No verdict → `deny` (fail
closed). Scopes `read`, `steer`.

The built-in (`src/plugins/gate-reviewer`, §17.2 step 5) is that listener with today's behavior kept: `order: post`
(the last judge, and it sees every `verify.starting` patch); a `verify.starting` listener that answers at once and starts
the reviewer alongside the checks in the background (`CAPCOMD_REVIEW_PARALLEL=0` turns it off), which `verify.judging`
takes up or replaces when it read another tree; the reviewer spawned under the verify's caller (who pays for it) through
the kernel's own agent primitives, not `ctx.agents` (a plugin's spawn has no parent or review mode); the answer carries
the `review` report (§6.6.13) instead of a `verdict` event (the verdict is on the reviewer's result and in the
verification's record). Its `verify.judging` deadline is the maximum, 60 min. It fails closed with its own `deny` (the
error in its `review`), never by failing the call: three failed calls would suspend it, and a suspended gate denies every
verify (§6.5). A call it made that failed in capcomd's own machinery (the engine or an actor didn't answer: not a
UserError, not a kernel refusal such as an unknown profile or the budget) is tried again, keyed, within the deadline (4
tries by default, `CAPCOMD_REVIEW_INFRA_TRIES`); still failing, its deny says the reviewer couldn't be run, with the
error's own text, and its `review` is `retryable: true` (no verdict was given: verify again). A CLI that ran a verify
waits (bounded) for the reviewer it started or stops before it exits.

### 15.4 A Slack notifier (`slack-notifier`, out of process)

`examples/slack-notifier`. `entry.runtime: process`, scopes `read` and `steer` (steer only to emit its own event, §11.1), observe hooks `run.changed`, `agent.changed`,
`merge.changed`; the webhook is an `x-secret`. The process opens its session, iterates the hooks stream, renders a
sentence from daemon-written fields (agent text escaped as plain text), posts within the call's deadline, and emits
`plugin.slack-notifier.posted`. It follows §16.5: it speaks on failures, attention and landed work, and is quiet otherwise.
Its tests are a plugin author's (§17.2 step 13): `render` per payload and `main` against a stand-in `PluginClient`
(`examples/slack-notifier/index.test.ts`), and the example unchanged as a user's plugin of a daemon on the fake sandbox,
booted by `testkit.bootWith`, with a local HTTP server as the webhook (`tests/scenarios/plugin-slack-example.test.ts`): it
posts a run's start and end and a failed agent, nothing for a finished or cancelled one, writes its `posted` events on
the run's stream, and its webhook never reaches the daemon's log.

### 15.5 A watchdog (`watchdog`, in-process)

`examples/watchdog`. §16.4. Observe hooks plus one `timer` job; raises `stalled`, then cancels. capcomd's built-in is
`src/plugins/watchdog.ts` (§16.4 says what it counts as progress).

## 16. Super-agent primitives

Four requirements from DeepSeek's super-agent work (the essay *Exploring Super-agent Design: Towards a More Autonomous
Agent System*, DeepSeek Harness team, 2026-10-31, and its prototype `deepseek-ai/dsh-superagent-prototype` at
`8c32a9dc`, read 2026-11-04; research §7) are designed in here so they are first-class and not retrofits. They add one
service pair (`jobs`, `triggers`), one contribution kind (`sources`), three hooks and one profile capability, and share
one scheduler: a **job**.

### 16.1 The planner never executes

Prototype: "Router never executes": the main Session routes, decides and replies; every change is a worker's
(`docs/001-domain.md`, `003-execution.md`: the router preset has "a smaller tool set for routing"). capcomd's planner
today is told so in prose (`src/recipes/planner-agent.ts` `plannerBrief`: "Don't change files yourself") and gets no
tool limits (`src/config/project-setup.ts` `planProject`: `planner` has `children.allowSpawn` and nothing else).

**Specification.** ADR-024's profile schema gains `tools.mode: execute | orchestrate` (default `execute`), pinned as
`PinnedSpec.toolMode`; in today's `capcomd.agents/v1` file, whose fields are the pinned spec's, it is the flat
`toolMode` field. For `orchestrate`:

1. **It sees everything and runs nothing.** Allowed: reading and searching files; read-only git, `fetch` included
   (`log`, `show`, `diff`, `status`, listing branches, `ls-tree`, `ls-files`, `rev-parse`, `rev-list`, `blame`, `grep`,
   `cat-file`, `merge-base`, a detached checkout of a ref to read it: `git switch --detach origin/<branch>`); every
   capcomd read and inspect command and tool (status, tree, events, logs, inspect, results, verify and merge reports
   with their full check output) and `capcomd fetch` (below). Refused: file edits and writes; commits, merges, rebases,
   resets and pushes (its children's work lands only through `capcomd verify`/`merge`); package installs; builds,
   tests and running the program. It knows the code works the way a router does: the checks run at verify and merge,
   and it reads their output (a merge's `result.combined`, below, says whether they ran on the combined code).
   The agent provider's `describe().toolPolicies.orchestrate` (§7.3) gives the CLI's lists:
   - Claude Code: an allowlist (`Read, Glob, Grep, LS`, `Bash(capcomd:*)`, `Bash(<read-only command>:*)` for the
     commands above and `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `jq`, …) and a denylist (`Edit, Write,
     MultiEdit, NotebookEdit`, `Bash(<prefix>:*)` for git's writes, package managers, test runners and builds, and
     `Bash(git fetch *--upload-pack*)`, `Bash(git grep *-O*)`, `Bash(git * --output*)`: options of allowed commands
     that run a command or write a file). With an allowlist Claude Code runs without `bypassPermissions` and refuses
     any command the list doesn't name, headless. No denied prefix starts an allowed one: a deny rule outranks every
     allow (a bare `Bash` deny would take `Bash(capcomd:*)` with it). Compound lines of allowed commands run
     (`git log --oneline | head`, `git fetch -q origin x && git log origin/x`); Claude Code itself refuses a command
     whose shell variables it can't check (`id=$(capcomd spawn …); capcomd await $id`), so briefs say to run each
     capcomd command on its own.
   - Codex: no lists; `denyCommands`, the refused command prefixes, which the provider writes as codex execpolicy
     rules (`$CODEX_HOME/rules/capcomd-orchestrate.rules`, `decision = "forbidden"`), and the capcomd MCP server's
     tools approved up front (`default_tools_approval_mode = "approve"`; `codex exec` never asks, so a tool that needs
     an approval is refused). Its sandbox stays the agent's: `--sandbox read-only` blocks `git fetch` (a write to
     `.git`, and no network) and can't start in a container at all (bubblewrap needs user namespaces, which Docker
     doesn't allow), so every command failed, reads included. Codex's rules see the commands of a simple shell line
     (`cd x && bun test` is refused) but not a redirection (`echo x > f` runs), `sh -c` or option tricks: so the kernel
     doesn't rely on any CLI's rules for writes (item 3).
   The kernel applies them on top of the profile's own lists when it builds the agent's config, after
   `agent.preparing`: `allowed` replaces the profile's allowlist or narrows it, `disallowed` joins its denylist,
   `denyCommands` joins `AgentConfig.denyCommands`, `sandbox` is the loosest the CLI runs in. A profile cannot widen
   them (`widenings()` treats mode as a limit; a child's own mode is its own, as its provider is).
   **`capcomd fetch [branch…]`** (`capcomd_fetch`; an in-VM op, `fetch`): the host fetches the run's repository (by its
   URL, with the host's git credentials, which the agent never has, so a private repository's branches are readable
   too) into its mirror and brings the new commits into the agent's checkout as `refs/remotes/origin/*` with a bundle
   (§11.7): nothing in the checkout takes part in the fetch from the remote, so whatever its git settings say, they see
   no credential and change nothing. It answers each branch's commit.
   **A merge says whether its checks ran on the combined code**: a verify's and a merge's result gain `combined`
   (additive): `{checked, passed, at: "verify" | "merge", on, earlierMerges, text}`, `on` the target commit the change
   was put on and `earlierMerges` the run's merges into that target already on it; `text` says it plainly ("checks ran
   on the combined code (this change on main with 1 earlier merge from this run): pass"). The CLI prints the text; the
   MCP tools' `next` carries it.
   **`capcomd check [<ref>]`** (`capcomd_check` for the driver and in the VM; an in-VM op, `check`; host
   `capcomd check <runId> [<ref>] [--check NAME | --checks CMD] [--key K] [--id chk-…]`; harness.v1 has no verify
   route, so none for it either): the run's checks on a ref's commit **as it is** (a goal branch, the target after
   merges, a child's branch; an agent id means its pushed branch; default: the run's target), in a sandbox as a verify's
   run (`src/merge/check.ts`, through the verifier actor), with pass/fail and the full output (its last 64 KB,
   `result.checks.output`; `result.text` says it plainly, e.g. "trunk at 4f2c… (with 2 merges from this run) is a tree
   that already passed these checks in this run: pass"). It integrates, merges and reviews nothing and needs no work of
   the caller's own, so an orchestrate agent may ask for it from its VM: it is how a router knows the state of the
   combined code without executing anything itself (in-VM `verify` takes only a child, and a host verify of the goal
   branch onto itself runs no checks). Rules: the commit is the branch's tip when asked (`result.commit`); the command is
   an operator-named check (`--check`), else the one pinned to the agent checked, else the run's (the repository's command; with none,
   the run's one named check, and with several the caller must name one; an in-VM call can't pass `--checks`; a verify
   takes its command the same way, the run's one named check recorded as its `check` and re-run by its merge, so a run
   whose project names one check in `run.checks` never verifies on "no test command configured", but with several it
   keeps the repository's command, as an unpinned child's in-VM verify can't name one); a check id (`chk-…`) is one per (run, commit, command, key), so identical checks running at once
   run once and a later one gets the record (`--key` checks a commit again); a tree that already passed the same
   command in the run isn't run again (`checks.where: "reused"`); the check's sandbox takes a machine slot where the
   run's place has a cap (§16.2 rule 3; `src/providers/capacity.ts` `holdSlot`), waiting with the agents, and gives up
   after 20 minutes; it can't check an orchestrate agent (`invalid`: no branch of its own). Recorded on the run as the
   scope events `check.started`, `check.passed`, `check.failed` (capcomd.v1 `CHECK_*`, additive; on the agent checked,
   else the agent that asked; the output stays on the record) and in the trace (`git.check`, `check.run`). A check
   is an op of the scope (`kind: "check"`): `capcomd await`/`capcomd_await {ops}` wait for it as for a verify.
2. `children.allowSpawn` MUST be true (an orchestrator with no children can do nothing; `validate` refuses it).
3. The kernel refuses `verify` and `merge` of such an agent's **own** ref (`ops.verifyRef`, `mergeRef`: `invalid`,
   relay.v1 code `usage` with reason `invalid`, "an orchestrate agent has no work of its own"), and the runner never
   commits or pushes its work, not even as a checkpoint (its supervisor makes none). **Writes fail it**, in the kernel
   for every provider (the owner's call, 2026-11-05, as a CLI's rules can be got past): the runner looks at the agent's
   checkout when a turn ends (the CLI's `result` / `turn.completed`) and when it ends; changed files (untracked
   included) or commits on no remote branch stop it there, and it ends `failed` with `result.errorKind:
   "orchestrate_wrote_files"`, `result.wrote: {files, total, commits, at: "turn" | "end"}` and an `error` naming the
   files. Nothing it wrote is committed or pushed; its log says so and its trace has `agent.orchestrate_discarded`
   (`agent.orchestrate_failed: true`). An orchestrate agent that finishes having spawned no agents (its tools refused, or it
   gave up) ends `failed` (`result.errorKind: "orchestrate_no_children"`, with its last words), never a silent `done`:
   nothing it did can land, so a run whose planner did that doesn't report ok. Its final message is its `summary` when
   it declared none.
4. Everyone who hands an orchestrate agent work is told what the mode means: the profile's `description` and `does`
   (`capcomd_profiles`, `capcomd profiles list`, which also show `toolMode`), the MCP server's instructions, the driver
   skill, the planner's brief and the orchestration skill an orchestrate agent gets. They say: it sees everything and
   runs nothing; give it no task that needs it to run code itself (its helpers write and test the code); checks happen at verify and merge, and their results are
   readable.
5. `capcomd logs <agt>` shows every agent's tool calls and refusals (`tool …`, `error …`, `refused <call>: <reason>`)
   next to the `[capcomd] <op> → …` lines, planners and leads included. A provider whose CLI reports refusals only on
   stderr implements `refusal(line)` (§7.3; codex 0.163 leaves a command its rules forbid out of `--json`).
6. `jobs.foregroundMs` defaults to 5 000 for `orchestrate` agents and 60 000 otherwise (§16.2), matching the prototype's
   router and `standard` presets, so a planner's shell never blocks its inbox. An orchestrate agent starts no `exec` job
   (`capcomd job start` is refused, `forbidden`): it runs nothing, in the background either; a long command is a
   helper's, and `capcomd check` runs the checks.

Enforcement is the agent provider (its CLI's permission system inside the sandbox) and the kernel's refusal to land an
orchestrator's branch: no special case in the planner recipe. The `planner` and `lead` profile files `capcomd setup project`
writes get `tools.mode: orchestrate` and a `description` that says what it means; `plannerBrief` explains it (item 4). This is a profile capability, not
a hook, because it is a property of the agent for its whole life.

### 16.2 Background jobs

Prototype (`003-execution.md`): a tool call past a threshold "moves foreground shell commands to background jobs after 5
seconds" (router and worker presets; 60 s under `standard`), the result wakes the session later, a Ticket "keeps its
worker slot" while background work runs, background work has "at most 30 minutes to finish" after a turn, jobs are
killed when the Assignment ends, subagents are released, and a restart ends background work "outright". dsh's
`ctx.jobs` (research §7) is the registry: owner-scoped ids, output ring, settlement as an event.

**Specification.** `ctx.jobs` (§8) is the one primitive for work that outlives a call and for time. A **job** is a
durable record on its run (kv `_jobs/<id>`, written by the kernel) or on the daemon for a plugin's timer, with two
kinds:

| Kind | Runs | Owner | Reports |
|---|---|---|---|
| `exec` | argv in a sandbox machine: the owner agent's machine, or a **run-owned job machine** (`owner: {run: true}`; ensured through `sandbox.ensuring` with `purpose: "job"`, the same way a run's checks machine is) | an agent or the run | `job.changed` `output` (coalesced, ≤ 1/s, ≤ 16 KB) and `ended {state}`; `job.ended` event; `result` holds the exit code and the last 64 KB |
| `timer` | nowhere: it fires | an agent, the run or the plugin | `job.changed` `fired {n}`; `at` once, or `everyMs` until `until` |

Rules:

1. **Start returns at once.** `jobs.start` of an `exec` waits `foregroundMs` (the spec's, else the owner's
   `jobs.foregroundMs`, else 60 000; never more than 90 000, an in-VM call's hold); a job that ends within it returns
   `done` (or `failed`) with its result; otherwise `running`.
   The in-VM `capcomd` CLI exposes the same to agents as `capcomd job start -- <cmd>`, `job output`, `job list`,
   `job kill` (spool ops `job.start`, `job.output`, `job.list`, `job.kill`, ADR-017; MCP tools `capcomd_job_*`). Every
   agent that does work of its own has that CLI, one that may not spawn too (a leaf token: its tab, reads, notes, its
   result and these ops; ADR-017 §2), and not verify's reviewer, a report agent or the consolidator, which answer with
   their final message. The job ops are in a token only when the agent's profile, and the config it runs with (the daemon's tool and
   Codex sandbox settings narrow it too), let it run a command of its own (no allow-list without an unrestricted shell,
   no denied shell, no read-only Codex sandbox), so a job is never a way around its tool policy; an orchestrate agent keeps them and its start is refused by name (§16.1 item 6). So an
   agent's long command returns "running" and its result arrives as an inbox message from the job (`from: <jobId>`)
   that the supervisor delivers at the next step (as dsh's completion notice); a job the agent stops itself sends
   none. The agent CLI's own shell tool is not changed (ADR-023 §5.3): auto-backgrounding applies to commands run
   through capcomd's wrapper, which the orchestration skill tells agents to use. A single-string command runs with
   `sh -c`; more strings are argv. The job runs in the agent's machine with the agent's working directory and `PATH`
   (no credential: the exec carries none) as a detached runner (`src/jobs/machine.ts`) whose files,
   `<spool>/jobs/<id>/{spec.json, out, err, exit, killed}`, outlive the daemon; `quiet` there tells the supervisor
   that no result message comes for it (its caller had the result in the foreground, or a plugin started it).
2. **Limits** (profile `jobs` block, ADR-024; daemon defaults `CAPCOMD_JOBS_MAX`, `CAPCOMD_JOBS_FOREGROUND_MS`,
   `CAPCOMD_JOBS_AFTER_TURN_MS`, settable in config `env`): `max` running jobs per owner (8), `foregroundMs` (60 000;
   5 000 for `orchestrate`), `afterTurnMs` (1 800 000): an agent's `exec` jobs are killed when the agent ends;
   `timeoutMs` per job (default `afterTurnMs`, counted from the job's start; counting it from the agent's last step
   is a later refinement). A settled record keeps the last 48 KB of stdout and 16 KB of stderr (`job output` reads up
   to 64 KB of each from the machine while it runs). A `timer`'s `everyMs` ≥ 1 000; `at` with `everyMs` is the first
   fire.
3. **Slots.** An agent with a running `exec` job keeps its slot (`src/providers/capacity.ts`): it is not `idle` and the
   kernel's idle notice is not raised while jobs run. Its supervisor keeps the agent CLI's input open while one of its
   jobs runs or a result message is on its way (so the CLI is there to read it), and says in each heartbeat how many
   run; the runner's stuck watch starts again on each. A run-owned job holds no agent slot but counts against the run's
   machine count (run-owned job machines are a later step: `owner: {run: true}` for `exec` is refused
   `unsupported` until then).
4. **Handoff** (`capcomd spawn --continue`): the agent's `exec` jobs are **killed** with its machine when it ends
   (today its machine is destroyed after its push, `ops.ts` → `worker.ts`); a job meant to outlive the agent (a server
   kept for review) is started `owner: {run: true}` and lives until the run ends or its `timeoutMs`. Timers owned by an
   agent end with it; run-owned and plugin-owned timers do not.
5. **Cancel**: `jobs.cancel` and an agent's cancel kill its jobs (SIGTERM, SIGKILL after 5 s; state `killed`).
6. **Daemon restart**: job records are durable. `exec` jobs keep running inside their machine (their runner holds the
   process, in a session of its own); on restart the kernel re-attaches when the agent's spool pump starts again, by
   reading the job's files through the same exec, and settles it (its end time is the runner's); a job whose machine
   or runner is gone settles `lost`, as does one whose agent ended while nobody watched (when it is next read). Timers
   are re-armed from their records once the daemon's plugins have loaded; a missed `at` (or interval) fires once on
   restart. A plugin's timer is a file in the daemon's state (`state/jobs/<id>.json`); a run's job is kv `_jobs/<id>`,
   with a pointer there for `get` by id and re-arming.
7. **Events**: results arrive as `job.changed` hook calls and `job.started`/`job.ended` events; nobody polls. `wait` is
   a convenience bounded by its deadline.

Why one primitive: the watchdog's clock (§16.4), a source's poll loop (§16.3), the Docker sweep (§15.1, `sandbox-docker`'s
own timer) and background shell are all "work that reports back later"; one durable record, one owner rule, one event
shape.

### 16.3 Triggers

Prototype (`001-domain.md`, `002-authorization.md`): a **Source** produces immutable **Triggers**; a deterministic
**gate** checks the sender against the Source's allowed list and whether the message addresses the agent (`mention`,
`direct`), and "anyone in a conversation the team opened to requests" may ask; an **accept mode** `off | observe | auto`
with `observe` the default "records what the agent would have done"; accepted work **subscribes** to its Thread so later
messages reach the worker without a new decision, for "two weeks after" the work ended; accepting a Trigger twice
"creates one Ticket".

**Specification.**

#### 16.3.1 Sources

A plugin contributes `sources: [{name, summary}]`, provides `source:<name>`, and calls `ctx.triggers.emit(trigger)`
for each external event, from a webhook route (`ctx.api.route`) or a poll (a `timer` job). It MUST drop its own bot's
messages and events outside what it listens to before emitting, keep its own read position in `ctx.storage` (a restart
must not replay), and fill `trigger.actor` and `trigger.addressed` from the source's own facts. `trigger.data` is
structured context, never used for authorization. `trigger.text` is an `Untrusted` (a plain string is taken as one);
the kernel checks the shape (`src/triggers/intake.ts` `checkTrigger`: `id` ≤ 200 characters, `thread` ≤ 500, `at` an
ISO time, `actor {id, display, bot}`, no control characters in `id`, `thread` or the actor's id (`capcomd triggers
log` prints them; the display name loses its), text and data ≤ 64 KB each) and refuses a malformed trigger `invalid`
before recording anything. A source keeps its read position in `ctx.storage`'s daemon scope (§8.4).

Two built-in sources ship with step 10, each on its plugin's own `timer` job (§16.2), in the daemon only:

- `schedule` (`source-schedule`, `src/plugins/sources/schedule.ts`): its config `schedules: {<name>: {text, everyMs?,
  at?, until?}}` (§10.2); each schedule is one timer, keyed by its settings (a changed schedule is a new timer, the
  old one is cancelled; settings changed back to a cancelled timer's start it again under a new key,
  `src/plugins/sources/timer.ts`), and each fire a trigger `{id: <name>/<jobId>/<n>, thread: schedule:<name>@<fire time>, actor:
  {id: schedule:<name>, bot: true}, addressed: direct, text}`. Every fire is its own thread, so one night's run never
  gets the next night's fire as a message. The operator allows the actor (or opens `schedule:*`) like any other.
- `github` (`forge-github`, `src/plugins/forges/github-source.ts`; no GitHub code in the kernel): the issue and pull
  request comments of its config's `sourceRepos` (`owner/name`), and of the repositories of the `github` threads runs
  follow, read every `sourceEveryMs` (60 s) with the user's GitHub login; thread `owner/name#<number>`, id
  `comment-<id>`, actor the author (`bot` from GitHub's user type), `addressed: mention` when a line starts with the
  command word (`sourceCommand`, `/capcomd`), or, with `sourceMentions: true` (off by default), when someone else
  @-mentions the login; `replyTo` the comment's URL. The login is usually the user's own: a mention of it addresses
  the user, not capcomd, and their comments are theirs, not the bot's: what the source drops as its own is what
  capcomd wrote (a comment carrying `<!-- capcomd -->`; capcomd posts none yet, replies are a later step's). Its read
  position is per repository in `ctx.storage`; the first poll of a repository only marks where it starts, and a
  comment whose emit was refused retryably (`unavailable`: the trigger may come again, §16.3.2 step 6) holds the
  position before it, so the next poll reads it again. GitHub's `since` includes its own second, so the position also
  keeps the comments read at that second, which the next poll skips (else each poll would emit them again, a
  `deduped` decision a minute). The source's `job.changed` listener is registered whatever its settings, as its
  manifest declares it (§4.7), and polls only when `sourceRepos` names a repository (as `source-schedule` schedules
  nothing without a schedule); the built-in sandboxes listen there already, so the daemon reads background jobs'
  output (§6.6.19) either way.

#### 16.3.2 The intake

`ctx.triggers.emit` hands the trigger to the kernel's **intake** (`src/triggers/intake.ts`; the daemon's only: in any other
process `ctx.triggers` is `unsupported`, as `ctx.jobs` is), which decides in this order and records a `trigger.received`
event (on the daemon stream), a line of its log (`state/triggers/log.ndjson`, §16.3.4) and a `trigger.changed` call
with the `TriggerDecision`:

1. **Dedupe**: `(source, id)` seen within 30 days → `deduped`.
2. **Subscription**: the thread is subscribed by a live run (or one ended < `until`) → the trigger is delivered to that
   run's planner as a message (`continued {runId, seq}`) **if the actor is a person** (bots and CI never resume an
   ended run; they reach a live run as context); no further gate. A person's stop is a message too; the planner decides
   (the prototype's rule). The planner is the run's `_planner` record, else its top-level agent spawned with the key
   `planner`; a run with neither (a run driven from outside, or the built-in recipe's) has no one to read it, and the
   trigger goes on to the gate. The message is `from: trigger:<source>`, its body who wrote on which thread and what
   (`triggerMessage`), and the agent reads it as someone outside capcomd's words, not the operator's. A person's trigger
   on an ended run's thread lands in its planner's inbox; starting the planner again on it is a later step's.
3. **Gate**: config `triggers.sources.<source>` (kernel-owned, operator-written: `allowed: [actor ids]`,
   `opened: [thread patterns]`, `mode: off|observe|auto`, `project`). The trigger is **allowed** when its actor's id is
   in `allowed` or its thread matches an `opened` pattern (exact, `*` matching any run of characters). Strength is
   `explicit` when `addressed` is set and it is allowed; `inferred` when it is allowed and not addressed. Not allowed →
   `denied {by: "allowlist"}` (an allowed, unaddressed trigger is what "inferred-eligible" means). The settings are
   `triggers` in the user's `~/.capcomd/config.json` (off with `CAPCOMD_NO_CONFIG`), or the JSON file
   `CAPCOMD_TRIGGERS_FILE` names; they are read again for every trigger. A source with no settings allows nobody
   and is in `observe`.
4. **`trigger.admitting`** (§6.6.20): a plugin may deny → `denied {by: "plugin"}`. Asked only about an allowed trigger
   (the payload's `gate.allowed` is therefore true).
5. **Mode**: `explicit` → act. `inferred`: `off` → `denied {by: "mode"}`; `observe` → `recorded {wouldHave}` and
   nothing happens; `auto` → act.
6. **Act**: start a run on the configured project (`project`, a checkout set up with `capcomd setup project`; unset,
   the daemon's own repository) with the trigger's text as the goal (`POST /v1/runs` semantics: `run.creating` fires,
   with the source plugin as the principal; harness.v1's additive `Run.trigger {source, id, thread, actor, at}`, under
   the capability `triggers`) → `started`, and subscribe the run to the thread. The goal is checked as `POST /v1/runs`
   checks one (`CreateRunBody.goal`: not empty, ≤ 16 KB, no NUL, no leading `[agent:NAME]`, so a source's words never
   pick the run's agent profile); a text that fails is a start that fails, `invalid`. `recorded.wouldHave` is `start` in
   this version: continuing a goal branch's run that a thread names comes with the pull-request subscriptions of
   §16.3.6. A start that fails (no repository, a `run.creating` refusal) is no decision: the log says `failed` with the
   reason, `trigger.received` has `decision: "failed"`, no `trigger.changed` is told, the dedupe mark is dropped (the
   trigger may come again) and `emit` rejects: `invalid` for the operator's settings, else `unavailable`.

What the intake does **not** do: judge content. The model-side assessment the prototype's "Eval" performs is the
planner's job once a run exists (it reads the trigger as its goal and may decide there is nothing to do, ending with a
`dropped`-style result). Decision: the kernel gate is deterministic and auditable; a rule engine or a model in the
intake would be a plugin later (ADR-024 §4's position on matching).

#### 16.3.3 Authorization

Allowed lists and opened threads are **source-scoped identities** in kernel config, never mapped across sources (the
prototype's rule). A trigger plugin cannot widen them: `trigger.admitting` can only deny, and `emit` cannot set
`gate`. Changing the config applies to the next trigger; it never revokes a running run.

#### 16.3.4 Record-only first

`mode` defaults to `observe`. A new source therefore starts by recording: every inferred trigger produces
`recorded {wouldHave}` in `trigger.received`, which `capcomd triggers log` and the app list, and nothing runs until the
operator sets `auto`. Explicit, addressed requests from allowed people work in every mode. `capcomd triggers log
[--source S] [--limit N] [--json]` lists the intake's log (oldest first: when, source, actor, thread, the decision and
the gate's finding, the text's first 300 characters, redacted), and `capcomd triggers subscriptions [runId]` the
threads runs follow, from the daemon's state on this machine (the daemon need not run).

#### 16.3.5 Subscriptions and lifetimes

`ctx.triggers.subscribe {runId, source, thread, until?}`; the intake subscribes a started run to its thread
automatically. Default `until` = 14 days after the run ends; the host expires them (`trigger.unsubscribed {cause:
expired}`). A stopped run (`run.ended {state: cancelled}` by a person) unsubscribes at once (`stopped`). Sources poll
subscribed threads while a subscription is live. `TriggerSubscription.until` is null while the run works and nobody set
one (the run's end is not known yet); a subscriber's own `until` ends it then, whatever the run does. "Stopped" is a
run-wide cancel (the lifecycle's `run.cancelled` with cause `cancelled`: the operator's Stop); a run that no longer
exists expires its subscriptions. The daemon checks them on every trigger, on every `subscriptions` call and on a sweep
(every `CAPCOMD_TRIGGERS_SWEEP_MS`, 1 min), which also drops dedupe marks past 30 days. Subscribing is idempotent; a
second call may change `until`. A subscription's run must exist (`not_found`).

#### 16.3.6 Mapping onto today's intake

| Today | With triggers |
|---|---|
| `POST /v1/runs` from the app, `capcomd run`, `capcomd_run_new` | an **explicit** trigger from source `operator`/`driver` that skips the gate: the same `runNew` path; `run.creating` fires either way (step 10 leaves these paths as they are: they don't pass through the intake yet) |
| a person replying in the app (messages) | source `app`, always allowed (likewise unchanged in step 10) |
| GitHub comments, CI, Slack, schedules | source plugins (`github`, `slack`, `schedule`: a timer job that emits) |
| goal branches and PRs (`run.pr_opened`) | the run subscribes to its PR's thread, so review comments reach the planner (a later step: step 10's `github` source already reads the threads runs follow) |

### 16.4 A watchdog

Essay: a "separate, scheduled" session judges "whether each Worker is making real progress", catching the failure where
"the process is still running" but the model loops or drifts, which liveness cannot see. capcomd already raises `idle`,
`spinning` (repeated identical calls, `src/agents/stuck.ts`), `failing` and `quota` from the kernel.

**Specification.** A watchdog is an ordinary plugin (§15.5) on: `agent.changed` for progress signals, a `timer` job for
its clock, `ctx.agents.notice` to raise `stalled` (a new `AgentNotice.kind`, raised only by plugins), and
`ctx.agents.cancel` to stop. Progress signals the kernel provides in `agent.changed`: `step {kind, n}` (tool kinds and
counts), `checkpointed {files, commit}` (the supervisor's checkpoints, ADR-019 §3: files changed is the hardest signal
that something landed), `notice`, and the agent's `activity` line in `Agent`. The kernel does not define "progress";
the plugin does, and `capcomd setup` enables the built-in `watchdog` with conservative defaults (15 min to `stalled`,
45 min to cancel). Raising an ask is the `stalled` notice (the app shows the amber hand; a planner sees it on its child)
and, through §16.5, one message to the person only when the watchdog stops an agent.

The built-in (`src/plugins/watchdog.ts`, §17.2 step 11) is in the daemon only and off until `plugins.watchdog.enabled:
true` (§4.8), which `capcomd setup` (its `service` part) writes in the user's config unless the user set it false or
passed `--no-watchdog`; `capcomd setup check` says whether it is on. Its config: `stalledAfterMs` (default 900 000),
`stopAfterMs` (default 2 700 000; 0 never stops; otherwise more than `stalledAfterMs`, else the plugin fails to
activate), both counted from the agent's last progress, and `everyMs` (default 60 000), how often it looks. Its
definition of progress:

- the agent's files changed (`checkpointed`: the supervisor reports a checkpoint only for a new tree), or an agent
  under it did;
- an agent under it was spawned or ended (delegating, a hand-back), or it resumed;
- a background job (`job.changed`), a verification it asked for (`verify.changed`, its principal) or an approval it
  waits on (`approval.changed`) ended.

Files changing show only at the agent's next checkpoint, every `checkpointEveryMs` of its profile (default 10 min), so
an agent's windows are at least its interval's: `stalled` no sooner than one and a half of the interval, and the stop
(when it isn't 0) as much later as `stalled` moved. At the defaults nothing moves (1.5 × 10 min is 15 min); an agent
checkpointed hourly is stalled at 90 min and stopped at 120. The built-in asks the kernel for the interval when it asks
whether the agent's work shows (`src/plugins/services.ts` `checkpointEvery`, as the agent's worker reads it; none for
an agent no supervisor runs under, which keeps the configured windows).

Tool calls (`step`) and the activity line are not progress. While it, or an agent under it, waits on a job, a
verification or an approval, or is paused, its clock doesn't run. An agent with agents of its own running is judged
through them: they stall first, and their end is its progress, so a stuck worker is stopped rather than its planner and
the planner can re-plan. On a fire of its one timer (key `clock-<everyMs>`; one with another interval is cancelled) it
confirms the agent is running (`agents.get`) before it raises `stalled` (once, with the time and the stop to come in
`detail`) or cancels (`agents.cancel`, then `plugin.watchdog.stopped {agentId, quietMs, stalledAt}` on the run's
stream: the one message). Progress clears its notice; a notice that went some other way is raised again while the agent
stays quiet, but never over a notice of the kernel's (`idle`, `spinning`, `failing`, …) while that one shows: the stop
still comes. An agent whose work never shows as files changing isn't judged at all: a reviewer (`contract.review`), a
report-only agent (`contract.report`) and an orchestrate agent (`toolMode: orchestrate`) are never checkpointed, so the
watchdog can't see their progress (the kernel's own notices still watch their process); the built-in asks the kernel
once per agent, when the agent is first due (`src/plugins/services.ts` `showsFileChanges`, a kernel helper outside
`ctx`, as `skill-orchestration` reads the kernel's record). What it knows of each agent is in its daemon storage
(`agents/<runId>/<agentId>`), with the time of its last look (`clock`): after a restart the time the daemon was down is
added to every agent's clock, so downtime never counts as an agent's quiet.

### 16.5 The attention budget

Adopted as a design rule for every plugin that talks to people (notifiers, sources' replies, MCP instructions, UI
cards), from the prototype's philosophy (`000-philosophy.md`: "take as little human attention as possible, and give as
much value as possible"; "speaks only when a person must act or can use a result"; "asks one concrete question at a
time"; "a healthy state takes no space") and capcomd's own positioning as a distraction-free control plane:

1. A plugin MUST speak to a person only when they must act (an approval, a `stalled` agent, a failure) or can use a
   result (landed work, a ready pull request). Progress is not a reason to speak; the app shows it.
2. A plugin MUST ask one concrete question at a time, as a structured approval (`hold`, `approval.*`) or a
   `custom` approval kind, never as free text in a long report.
3. The default is quiet: a notifier's config SHOULD make silence the default and loudness opt-in (the Slack example's
   `quiet`).
4. Messages are short (the prototype's rule of thumb: under 100 words) and go where the request came from
   (`trigger.replyTo`).
5. A plugin MUST NOT speak to explain its own noise; it is tuned down or disabled instead.

The kernel enforces the structural parts (approvals are the only questions; notices are the only asks; events carry
state, not prose); the rest is review guidance for built-ins and `capcomd plugins validate --strict` warnings where a
manifest declares a notifier-shaped plugin (`run.changed` + `agent.changed` observers) without a quiet option.

## 17. Migration

### 17.1 Mapping

| Today | Becomes | Kind | Spec |
|---|---|---|---|
| `src/providers/docker.ts`, `registry.ts` descriptor, `serve.ts` sweep | `sandbox-docker` (the sweep on its own timer job) | seam: sandbox | §15.1 |
| `src/providers/boxd.ts`, `boxd-machine.ts`, `boxd-errors.ts`, `isBoxdAuthError` | `sandbox-boxd` (`apiKey` as `x-secret`; `classifyError`) | seam: sandbox | §7.2 |
| `src/providers/fake.ts`, `fake-host` | `sandbox-fake`, `sandbox-fake-host` (`listed: false`) | seam: sandbox | |
| `src/agents/adapters.ts` `claudeAdapter`, `codexAdapter`, `claude-code.ts`, the `PROVIDER_*` tables | `agent-claude`, `agent-codex` | seam: agent | §7.3 |
| `src/merge/github.ts`, `pr.ts`, `gh` in `api/project-git.ts` and `mcp/server.ts` | `forge-github` | seam: forge | §15.2 |
| `src/merge/direct.ts`'s push | `forge-git` (the CAS push; integration stays kernel) | seam: forge | §7.4 |
| `startReview`, `finishReview`, `review.ts` | `gate-reviewer` | hook: `verify.judging` | §15.3 |
| `src/merge/verify.ts` checks (kernel keeps them; a plugin may add judges) | kernel | | §6.6.13 |
| `src/mcp/server.ts` tool list, `driver.ts` | `front-mcp` (25 tools as `ctx.mcp.tool`, `src/mcp/tools.ts`; `src/mcp/server.ts` serves the registrations) | front door | §4.7.2 |
| `src/cli/index.ts` `switch` groups | one `front-<group>` per group (`front-run`, `front-primitives`, `front-profiles`, `front-env`, `front-setup`; `mcp` is front-mcp's), their commands in `src/cli/groups/`; `index.ts` becomes the dispatcher (`serve`, `plugins`, `help`, `version`, `tui` stay its own) | front door | §4.7.1 |
| `src/cli/commands/hermes.ts` | `front-hermes` (`src/plugins/front/hermes-config.ts`; `capcomd hermes`, `capcomd hermes add`) | front door | §4.7.1 |
| `src/utils/tracing-simple.ts` sinks, `runsIndexPath` writer | `observe-traces`, `observe-runs-index` | observers | §6.6.4 |
| `src/subagents/skill.ts` prompt injection | `agent.preparing` patch from `front-mcp`'s sibling `skill-orchestration` (`src/plugins/skill-orchestration.ts`) | hook | §6.6.7 |
| `src/recipes/hierarchical.ts` | `recipe-hierarchical`, **disabled by default**, kept for the parity eval (decision 5) | front door | |
| `plugins/capcomd/` (Claude Code / Codex plugin) | unchanged: a plugin *for* the agent (ADR-018) | | |
| `src/api/sandboxes.ts` settings/info rows | each sandbox plugin's `ui` descriptors | UI | §4.7.5 |
| ADR-024 profiles: `harness.provider`, `sandbox.provider`, `skills`, `identity.persona`, `lifecycle.onStart/onEnd`, `tools.mcp`, `sandbox.environment/size` | seam names (`sandbox.provider` selects the agent's machine's sandbox); `agent.preparing`; `onStart/onEnd` → plugins listening to `agent.changed` filtered by profile (the `lifecycle` block names plugins that must be active; the change carries them); `tools.mcp` → the agent provider's `AgentCommandCtx.mcp`; `environment`/`size` → the machine's `VmSpec` | | §7, §6.6.7, §6.6.8 |
| `plannerBrief`'s "don't change files" | `tools.mode: orchestrate` on `planner` and `lead` | profile | §16.1 |

### 17.2 Steps

Refined from ADR-023 §8. Each leaves `typecheck`, `test:fast` and `test:scenarios` green and adds its own tests; no
step changes `relay.v1`/`capcomd.v1` output or harness.v1 except by adding feature flags.

| # | Ships | Tested by |
|---|---|---|
| 1 | The host, in-process, zero plugins: manifest loading (`packages/plugin` schema), §5.4 states, §6.3 order, hook registry with modes, deadlines and the breaker, `plugin.*` events, `GET /v1/plugins`, `capcomd plugins list`, the test kit (§14.5) | `tests/plugins/host.test.ts`: ordering, chaining, veto short-circuit, fail-closed vs open, timeout, breaker, dispose (§14.1), the mode-consistency script |
| 2 | Hooks fired from the kernel at every §6.6 site that exists (not `job.changed`, `trigger.*`: steps 7, 10), no listeners | `tests/scenarios/hooks-order.test.ts`: a recording plugin (loaded in tests with `CAPCOMD_TEST_PLUGINS`) asserts the order for one agent, one verify, one merge; existing scenarios unchanged; `tests/plugins/kernel-hooks.test.ts`: no listener, no payload or await; the §6.6 patch rules |
| 3 | Sandbox providers as plugins (§15.1, `sandbox-boxd`, fakes); `DESCRIPTORS` derived; `dependencies.ts` asks the host; `classifyError` replaces `isBoxdAuthError` | `tests/providers/*` unchanged; `descriptors.test.ts` equals today's list; conformance wired to `capcomd plugins validate --conformance` |
| 4 | Agent providers as plugins; `Provider` becomes "an active agent seam's name"; `toolPolicies.orchestrate` and `PinnedSpec.toolMode` (§16.1); `planner`/`lead` templates set `orchestrate` | `tests/agents/*`, `profiles.test.ts` unchanged; an unknown provider refused at `validate`; an orchestrate agent's verify refused; the team-shape eval before and after |
| 5 | Gates: `gate-reviewer`; a second test judge shows the AND; `--operator` bypass recorded (`plugin.gate_bypassed`) | `tests/primitives/verify-merge.test.ts`, `tests/scenarios/review.test.ts`, a bypass scenario asserting the event names the plugin |
| 6 | Forges: `forge-github`, `forge-git`, `forge-fake`; `mergeTask` → `forge.land` under the kernel lock | `tests/merge/*` with `forge-fake`; `tests/api/project-git.test.ts` |
| 7 | Jobs (§16.2): the service, `_jobs/` records, `exec` on the owner's machine via the spool, timers, `job.*` events, in-VM `capcomd job`, slots | a scenario: a scripted agent starts a 10 s job with `foregroundMs: 1000`, gets `running`, its result arrives as a message; restart mid-job settles it; the Docker sweep as a timer |
| 8 | Front doors: MCP tools and CLI groups as registrations; `front-hermes`; `skill-orchestration` on `agent.preparing`, with `skills` and `env` attached to the agent's run (§6.6.7) | `tests/mcp/client.test.ts` lists the same tools; `tests/cli` passes; a test plugin's command and tool answer with the envelope and the caller's principal (`tests/plugins/front-doors.test.ts`); a test plugin's skill and variable reach the agent (`tests/subagents/prepare-skills.test.ts`) |
| 9 | Out-of-process runtime (§9): spawn, filtered env, token minting, handshake, hooks stream, answers, restart, `plugins.protocol` routes applied to `contract.ts` (the fragment deleted) | a fixture process plugin (`tests/agents/fake-claude.sh` pattern); chaos killpoints `plugin.hook.mid`, `plugin.process.crash` with the audit "gate denied, nothing landed": `plugin.process.crash` kills the plugin's process, `plugin.hook.mid` the daemon, each with a gate call in flight (`tests/scenarios/plugin-process.test.ts`); the runtime against the fixture (`tests/plugins/process.test.ts`) and its frames (`packages/plugin/test/process.test.ts`) |
| 10 | Triggers (§16.3): sources, the intake, `triggers.sources.*` config, `observe` default, subscriptions, `trigger.*` events, `capcomd triggers log`; a `schedule` source; the GitHub source | a scenario with a fixture source: deduped, denied, recorded, started, continued; a subscription expires; `observe` runs nothing |
| 11 | Watchdog built-in (§16.4) enabled by `setup` | a scenario with a scripted agent that stops producing checkpoints: `stalled` raised at the configured time, cancelled after |
| 12 | Install, trust, update: `capcomd plugins install|trust|update|remove|allow-version`, `LOCK`, the project trust prompt; with it (the owner's call) config layering: the project layer, validation per layer, the run layer | a local git fixture repository; a manifest escaping its directory refused; a changed hash reported; an untrusted project plugin never activates (`tests/plugins/install.test.ts`, `trust.test.ts`); the layers, a refused layer named, the run layer through a real engine (`tests/plugins/config-layers.test.ts`, `tests/scenarios/plugin-run-config.test.ts`) |
| 13 | `@capcomd/plugin` publishable (the client library `connect`, the test kit with `bootWith`; §14.6) and published by the release workflow once the repository variable `PUBLISH_PLUGIN_PACKAGE` is on, `docs/plugins.md`, the Slack example run by CI against the fake sandbox | the examples' conformance in CI (`tests/plugins/host.test.ts`, `bun test packages/plugin`, `tests/scenarios/plugin-slack-example.test.ts`); the package packed, installed and used from Node (`packages/plugin/test/pack.test.ts`, `scripts/smoke.sh` in CI) |

Steps 1–2 are additions. Steps 3–8 are refactors behind unchanged tests. Steps 9–13 are the third-party surface.
ADR-024's steps interleave: its loader (step 1 there) and the blocks with no new runtime (step 4 there: `identity.title`,
`tags`, `permissions.report`, `sharing`, and `fit`, `cost`, `capacity` in `capcomd_profiles`) need nothing here; its `harness.provider` validation needs step 4;
`skills`/`persona` at `agent.preparing` need step 2; `tools.mode` needs step 4; `lifecycle.onStart/onEnd` need step 2.

## 18. Changes

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-11-04 | First normative version: 21 hooks, 3 seams (40 methods), 22 services (77 primitives), protocol 1, manifest `capcomd.plugin/v1`. Includes the super-agent primitives (§16). |
| 1.0.1 | 2026-11-05 | With the kernel's hook sites (§17.2 step 2): which process a hook fires in (§6.1); no listener, no stop-time denial (§5.5); `run.creating` at `POST /v1/runs` takes only `sandbox`; `agent.preparing`'s site, and `skills`/`env` refused until step 8; `agent.changed` `started` has a null `machine`; `verify.judging` after the checks pass; `merge.landing`'s `fastPath`/`sha`, a satisfied hold, no dry-run gate; run-stream plugin events from step 5. |
| 1.0.2 | 2026-11-05 | With sandbox providers as plugins (§17.2 step 3): the sandbox conformance suite's home (§7.2); the Docker sweep is the seam's `sweep`, called by the kernel (§15.1). |
| 1.0.3 | 2026-11-05 | With the agent providers as plugins (§17.2 step 4): §7.3's `AgentConfig` gains `auto` and `usdPerMtok`, `toolPolicies.orchestrate` gains `sandbox`, `redactJson`, where the active providers come from, the runner's kind; §16.1's Claude Code policy denies no bare `Bash`, Codex's is its sandbox, v1 profiles spell the mode `toolMode`, the refusal's relay.v1 code, and the policy applied as the config is built; §14.2's agent suite: the turn limit may be the CLI's, `parse`'s null and redaction, a read-only sandbox for a policy with no allowlist, where it lives. |
| 1.0.4 | 2026-11-05 | With the gates (§17.2 step 5): the built-in gates in a process that isn't the daemon (§6.1); `merge --operator` asks every landing gate (§6.5); `verify.judging`'s `tested.commit`, judges in order, a judge's `review` report, the kernel's same-tree and no-review rules, stopped reviewers (§6.6.13); the built-in reviewer gate (§15.3); the gate events as scope events, a plugin's own run events not yet (§13.1). |
| 1.0.5 | 2026-11-05 | With the forges (§17.2 step 6): `LandRequest.branchSha`/`leaseBranch`, `PullRequestRef.mergeSha`, a conflict's `detail` and unknown `targetSha` (all additive); a pr land merges at the checked head (`branchSha`), not a pushed integrated commit; `merge.forge` from `CAPCOMD_MERGE_FORGE` (not `.capcomd.json`), `CAPCOMD_GITHUB_REPO` naming `github`; `forge-git` is `order: post`; `forge-fake` lives in `tests/merge/forge-fake`. |
| 1.0.6 | 2026-11-05 | Orchestrate means full read visibility and no execution (§16.1, the owner's call after a live run whose planner and lead couldn't `git fetch`): read-only git with fetch and a detached checkout, every capcomd read; edits, git writes, installs, builds and tests refused. Claude Code's lists gain the read-only commands and the refused prefixes (plus three option wildcards); Codex's policy is `denyCommands` as execpolicy rules with its sandbox the agent's (`read-only` can't fetch and can't start in Docker) and its capcomd MCP tools approved; `toolPolicies.orchestrate.denyCommands`, `AgentConfig.denyCommands` and the optional `refusal(line)` (§7.3; all additive); the agent suite accepts `denyCommands` that refuse commits and pushes in place of a read-only sandbox. `capcomd fetch`; a verify's and a merge's `result.combined`; an orchestrate agent that spawned nothing ends failed; the mode is explained to everyone who briefs one; `capcomd logs` shows every agent's tool calls and refusals. |
| 1.0.7 | 2026-11-05 | The rest of the forge's logic in the forge (§7.4): `listBranches` (replacing the unused `defaultBranch`) for a run's base and the setup screen's branches; `login` (`ForgeLogin`, `ForgeAccount`, `ForgeLoginUse`) for the logins the app shows and who you publish as; `describe().publish` choosing the forge that creates repositories; "pr mode" and "isn't on GitHub" said in the active forges' words. An inactive `merge.forge` is refused at `POST /v1/runs`, `capcomd run` and `capcomd_run_new` (§7.1); every forge method goes through the kernel's wrapper (§7.1); one local host for the gates and the forges. |
| 1.0.8 | 2026-11-05 | `merge.landing`'s `hold` takes an optional `holdId` (§6.6.15; additive): an approved hold is matched by plugin and `holdId`, falling back to the reason text without one; `heldBy.holdId` on the record and the approval. A plugin-held merge's approval carries the changed files, as a protected target's does. |
| 1.0.9 | 2026-11-05 | The reviewer gate tries a call that failed in capcomd's own machinery again, and when it still fails, says so: `ReviewReport.retryable` (additive), never a verdict (§6.6.13, §15.3). |
| 1.0.10 | 2026-11-05 | Git credentials and agent-editable checkouts (§11.7): no git credential enters a sandbox (the sandbox providers' per-exec git credential hook is gone; the host fetches and pushes for the sandbox through its mirror, with bundles); host network git runs only in a checked host repo or outside any repository, by URL; `capcomd fetch` brings a bundle instead of fetching in the checkout, so it no longer refuses a checkout for its git settings (§16.1). |
| 1.0.11 | 2026-11-05 | With ADR-024's loader (its §7 step 1): `profile.resolved`'s `profile` carries the resolved profile's `version` and the layer it was found in (`project`, `user`, `bundled`) instead of always `{version: 1, source: "user"}` (§6.6.5); the profile code is `src/profiles/`. |
| 1.0.12 | 2026-11-05 | The last forge logic in the forges (§7.4, §11.7): the optional `remoteCredential` (`ForgeRemoteCredential`; additive) supplies the credential host git uses for an https remote, which `host-git.ts` applies as the only helper for the remote's own origin (forge-github: the GitHub token for `https://github.com`, as before); `GET /v1/projects/branches` `source` is a string, the forge's name when its service answered; where a goal branch's pull request is merged is said with the run's forge's label. |
| 1.0.13 | 2026-11-06 | With the front doors (§17.2 step 8): the kernel's own front doors keep capcomd's names (`capcomd_<tool>`, the kernel's commands), named by the built-in list (`kernelSurface`), `order: pre` (§4.2); `KERNEL_COMMANDS` is the dispatcher's own commands and the front doors' (§4.7.1); a command's flags, its output, its PluginError's exit code and reason, `--help`, a kernel front door's `{exit}` (`CliExit`, additive), where an in-process command runs (§4.7.1); a tool's `title`, `_meta` and `openWorldHint` (additive), its schema listed as registered, its arguments checked and only the named ones passed on (§4.7.2); the front doors still run in the process that serves them (§6.1); `agent.preparing`'s `skills` and `env` accepted, with the kernel's rules (names that steer the agent's provider, loader, proxy or git reserved) and how they reach the agent, and the payload's `env` filled in (§6.6.7); `front-hermes` adds `capcomd hermes` (§17.1). |
| 1.0.14 | 2026-11-06 | With the context eval (ADR-025 step 0): §7.3's `AgentRunState` gains the optional `cacheReadTokens` and `model` (additive), which the kernel records on the agent's span (`gen_ai.usage.cache_read.input_tokens`, `gen_ai.response.model`): the eval's cache-read ratio and the model a result was measured on. |
| 1.0.15 | 2026-11-06 | With ADR-024's blocks that need no new runtime (its §7 step 4): they need no hook, seam or primitive here (§17.2); a profile's `permissions.report: false` is checked by the kernel at `ops.spawnAgent`, after `profile.resolved`, and never reaches a plugin's payload; the step's decisions are in ADR-024 §9. |
| 1.0.16 | 2026-11-05 | §16.1, the owner's two follow-ups to 1.0.6 (numbered 1.0.7 by mistake when it landed, next to the forge row): `capcomd check [<ref>]` (`capcomd_check`, in-VM op `check`): the run's checks on a ref's commit as it is, in a sandbox, merging nothing, deduplicated by commit and command, within the place's machine slots, recorded as `check.started`/`check.passed`/`check.failed` (additive) and in the trace; and an orchestrate agent whose checkout has changed files or new commits at the end of a turn or of its run fails (`orchestrate_wrote_files`, naming the files), whatever its provider, and is never checkpointed. |
| 1.0.17 | 2026-11-05 | With the jobs service (§17.2 step 7, §16.2): `exec` runs in the owner agent's machine through its spool pump's exec, as a detached runner whose files (`<spool>/jobs/<id>/`) outlive the daemon; the machine is attached while the agent runs, so re-attaching after a restart is the agent's pump starting again; a job whose agent ended unwatched settles `lost` when it is next read. A run-owned job machine (`owner: {run: true}` for `exec`) is refused `unsupported` until a later step; a job's `env` values are not kept on its record. The in-VM ops are `job.start`, `job.output`, `job.list`, `job.kill`, in every agent token (where an in-VM capcomd runs); a start's answer is the job as its agent reads it, and a job the agent stops itself sends no message. A single-string `cmd` runs with `sh -c`, more are argv. `afterTurnMs` is a job's default timeout (from its start), not yet counted from the agent's last step; daemon defaults are `CAPCOMD_JOBS_MAX`, `CAPCOMD_JOBS_FOREGROUND_MS`, `CAPCOMD_JOBS_AFTER_TURN_MS` (config `env`). The `jobs` block is pinned as is (`PinnedSpec.jobs`), from a v2 profile and as the flat field of a `capcomd.agents/v1` entry. A settled record keeps the last 48 KB of stdout and 16 KB of stderr; a job no message comes for is marked `quiet` in its directory, so the supervisor doesn't keep the CLI's input open for one. An agent's timers end with it (`killed`; one whose agent ended where no pump saw it, at its next fire). A timer may set both `at` (its first fire) and `everyMs`. An orchestrate agent starts no `exec` job (§16.1 item 6). The Docker sweep is `sandbox-docker`'s own timer (§15.1). `job.started`/`job.ended` are run events (additive), on the daemon stream for a plugin's timer. |
| 1.0.18 | 2026-11-06 | With ADR-024's version pin (its §7 step 3): the `Agent` shape gains `profileVersion` and `profileSource` (optional, nullable; additive, §3.1), fixed at spawn, and `agent.preparing`'s `spec` carries `PinnedSpec.profile` when the agent recorded one (§6.6.7). |
| 1.0.19 | 2026-11-06 | With ADR-024's `capcomd profiles` and `GET /v1/profiles` (its §7 step 2): the route `profiles.list` maps to exists (capability `profiles`, read scope); `ctx.profiles.list`'s `project` is its `?repo=` (§9.6). `capcomd profiles validate` is the command §7.1 names; `profiles` joins the kernel's commands (§4.7.1), and `capcomd agents` stays as its old name for one minor release. |
| 1.0.20 | 2026-11-06 | With ADR-024's skills in the profile (its §7 step 5): `agent.preparing`'s `prompt.skills` starts with the profile's skills, pinned on the agent at spawn by hash (`PinnedSpec.skills`, additive) with their text kept with the run, read and checked per attempt (a missing or changed one fails it, code `config`); every skill an agent gets at its start is in a `<skill name="…">` block, as a message's; the orchestration skill also comes from the kernel for an attempt prepared without it (§6.6.7). |
| 1.0.21 | 2026-11-06 | With the context router (ADR-025 step 1): a `context` contribution (§4.7: `contributes.context: [{name, kinds}]`, `provides: context:<name>` in §4.6, `ctx.context.register`, a 23rd service and 78th primitive in §8.1; all additive), the term context provider (§2), its conformance suite (§14.2) and `testkit.conformance.context` (§14.5); `PinnedSpec.context` (additive); the kernel's context router as the agent.preparing listener that composes a profile's providers into the brief (§6.6.7); §11.5: `fence()` neutralises every `<<<…>>>`, and the brief is the one place untrusted text is the basis of attention from system-role text, and what fences it. |
| 1.0.22 | 2026-11-06 | With the out-of-process runtime (§17.2 step 9): `failed(restart_limit)` holds the plugin's listeners, so its gates deny until it is enabled or disabled (§5.4, §9.5); the process's log lines are redacted of its own secrets as well as its token (§9.2); a `process` manifest's `contributes.context` is refused too (§4.9; ADR-025's providers are in process); the routes are in the committed contract and the draft fragment is gone (§9.9; `plugins.protocol`, additive); the plugin socket beside the harness socket, plugin tokens only (§9.2); the process's own process group, stdin held open, a leftover process from a dead daemon stopped (§9.2); the token in the daemon's memory only, revoked when the process is gone (§9.3); listeners registered at the first session and kept through restarts, a call made while the process is down waiting within its deadline (§9.3, §9.5); a secret that resolves to nothing left out until config layering (§9.3); frames redacted (§9.4); `events.emit` over the wire needs `steer` like in process, so the Slack example takes `steer` (§9.6, §15.4); `ctx.storage` implemented (both runtimes, the daemon's host) and the emit route's keys the plugin's (§9.6); no stream open, SIGTERM at once (§9.7); the client library `connect` ships (§9.8); `enable`/`disable` for the daemon's life, built-ins not disabled by the API (§9.9); a `process` manifest contributes hooks and events only (§4.9), so a third-party plugin has no command (§4.7.1); user plugins discovered (§4.8). |
| 1.0.23 | 2026-11-06 | With triggers (§17.2 step 10, §16.3): the intake's gate defined exactly (allowed: an allowed actor or an opened thread, `*` patterns; explicit: allowed and addressed; inferred: allowed and not addressed; not allowed: denied), its settings (`triggers.sources` in the user's config or `CAPCOMD_TRIGGERS_FILE`, read per trigger), `trigger.admitting` asked only about an allowed trigger, the planner a continued trigger reaches (and a run with none going on to the gate), a start that fails (logged `failed`, `decision: "failed"` on `trigger.received`, the emit rejecting, the trigger free to come again), `wouldHave` only `start` for now, `Run.trigger` and the capability `triggers` (additive), `TriggerSubscription.until` and `trigger.subscribed`'s `until` null while the run works, what stops a subscription, the sweep, `capcomd triggers log` and `subscriptions`; the built-in `schedule` source and forge-github's `github` source (§16.3.1: an @-mention of the login addresses capcomd only with `sourceMentions`, a retryable refusal is read again, a cancelled timer's settings start a new one); a built-in's config from the user layer and `CAPCOMD_PLUGIN_<NAME>_<KEY>` (§10.2); today's run and message paths don't pass through the intake yet, and a run's pull-request thread subscription is a later step (§16.3.6). |
| 1.0.24 | 2026-11-06 | With the watchdog (§17.2 step 11): the built-in `watchdog`, off until `plugins.watchdog.enabled: true`, which `capcomd setup` writes (§4.8); its config, its definition of progress (files changed, an agent under it spawned or ended, a job, verification or approval it waited on ended; never tool calls), waiting holding its clock, an agent judged through the agents under it, a reviewer, a report-only and an orchestrate agent not judged (their work is never checkpointed), `stalled` never raised over the kernel's own notice, `stopAfterMs` counted from the last progress like `stalledAfterMs`, its memory across a restart (§16.4; the worked example's `stopAfterMs` now means the same). Config layers 1–4 read for the built-ins, the schema subset checked, one `plugin.config_refused` per layer (a harness.v1 daemon event, additive), secret properties not read from layers yet (§10.2, §10.4). In the daemon: `agents.get`, `agents.tree`, `agents.cancel` and `agents.notice`; a plugin raises and clears only its own notice kinds and the kernel's clear only the kind it raised (§8.4). |
| 1.0.25 | 2026-11-06 | With ADR-024's writes (its §7 step 6): the `configure` scope's profile writes (§11.1) are `PUT /v1/profiles/{name}` (capability `profiles.edit`; additive, with `GET /v1/profiles/{name}` and the daemon-stream event `profile.changed`); `ctx.profiles` gains no write method yet. A write changes the profile's own file and bumps its `version`; what an agent pinned at spawn (`profileVersion`, §6.6.7) is unchanged. |
| 1.0.26 | 2026-11-06 | With capture and lint (ADR-025 step 2): `agent.changed`'s `ended` has a kernel listener, the `context` plugin's, that collects the lessons in an agent's `result.data.context` from the record its token wrote, stamps their provenance, refuses one holding a secret, too big or past the run's limit, and keeps the run's candidates in kv `_context/<agentId>` (§6.6.8); `plugin.context.proposed` and `plugin.context.refused` on the run's stream; §11.5: what is proposed for a durable layer is refused, never redacted, by the seeded scan; `capcomd context lint` joins the `context` command group. |
| 1.0.27 | 2026-11-06 | With ADR-024's runtime blocks (its §7 step 8): `PinnedSpec` gains `mcp`, `sandboxProvider`, `environment`, `size` and `lifecycle` (all additive), pinned at spawn and out of every override's and `profile.resolved` patch's reach (an override that makes an agent with MCP servers orchestrate is refused, `orchestrate_mcp`); an agent's machine is on its profile's `sandbox.provider` before the run's, never one that runs it on the host unless the run's does (`sandbox_isolation`, §7.1); `agent.preparing`'s `sandbox` says that place and the profile's environment (§6.6.7); `agent.changed` carries `lifecycle` and the kernel refuses a spawn and a start while a named plugin isn't active and listening (`lifecycle_inactive`, §6.6.8); `AgentCommandCtx.mcp` (additive) gives the agent provider the profile's MCP servers (§7.3). `memory` stays `context`'s alias (ADR-025 D2). |
| 1.0.28 | 2026-11-06 | With ADR-025 step 6: the context router attaches the context layer's skills at `agent.preparing` (§6.6.7): `capcomd-context-doctrine` to every agent whose spec has a context block, `capcomd-context-routing` to one of them that may spawn and isn't a reviewer or a report agent, `source: builtin`, pinned by hash, after the orchestration skill and only as many as fit the room the agent's other skills leave; their names are the kernel's and a profile with a context block keeps room for them; `plugin.context.loaded`'s `data.skills` (additive). Inline items and the `context` message kind (§11.5) stay unshipped: the step's eval did not admit them (ADR-025 §13). |
| 1.0.29 | 2026-11-06 | With groundray's read path (ADR-025 step 4): `ContextScope` gains `settings` (a provider entry's own settings from the pinned spec) and `bundleRoot`, `resolve` may answer a `bundle` (`ContextBundle`, a repository at a commit) when `caps.bundle` (all optional, additive); the router asks a provider once per brief (`skipped (named twice)`) and keeps the bundles its brief cites, which the attempt's runner places in the sandbox through the host's mirror (§6.6.7, §11.7); the conformance suite's bundle case (§14.2). The built-in `context-groundray` provides `context:groundray`. |
| 1.0.30 | 2026-11-06 | With consolidation and promotion as a merge (ADR-025 step 3): an agent of the `context-consolidator` profile isn't captured; the kernel stages its answer on its branch before recording its end, runs it as a reporting agent with the run's candidates and outcomes in its prompt, and on the run's strongest model when its profile names none (§6.6.8); `plugin.context.staged` on the run's stream (additive); the built-in `context-memory` is a `verify.judging` judge (lint as a check, before the reviewer gate) and a `merge.landing` gate (deny for a branch of any agent but a consolidator that changes `.capcomd/context/`, or one that fails lint; `hold` for a consolidator's under `context.review: human`, the default; allow under `lint`) (§6.6.13, §6.6.15). Both listen in every process, so a verify asks a judge and a merge fires `merge.landing` where none did before. |
| 1.0.31 | 2026-11-06 | With install, trust and update (§17.2 step 12) and the rest of config layering (the owner approved it with this step): installing from a git repository through the host's own repo, the files written out of the commit (no checkout, no link out, size limits), what `install` refuses, `LOCK`'s fields and the content hash, `update` reporting what changed before replacing, `remove` keeping the data (§4.8); `plugins.use` fetched to the user's home, trust per content hash and place in `<home>/trust.json` (a checkout's link out isn't its plugin; a checkout's `LOCK` is hashed), the trust prompt (with the secret references, its text escaped) and `--yes`, nothing written through a link or over a written file at install, an untrusted project plugin listed `validated`/`untrusted` through `enable` and checked again before every start of its process, `plugin.trusted` written by the daemon the first time it acts on a trust (§4.8); the daemon honours `allow-version` (§4.4); `enable` reads a directory plugin again (§4.8); every plugin's config is layered, not only a built-in's; `enabled` is the user's (a project turns off only its own plugins), a project's refused settings for a plugin not its own set aside rather than failing it, neither the project nor a run sets a secret, and a secret's reference is the user's or the environment's, a value where one belongs refused; `config.sources` per layer; the run layer checked against the manifests and its storage key the kernel's (§10.2, §10.4); a reference resolving to nothing still a warning, keychain references still unresolved (§9.3, §10.3); capability `plugins.config`, `POST /v1/runs` `plugins` and `plugin.trusted` in the contract (all additive, §13.1). |
| 1.0.32 | 2026-11-06 | With groundray's write path (ADR-025 step 5): a consolidator's change may name the brain its profile names (`brain`), checked and kept by the kernel in kv `_context/brain/<agentId>.<n>`, never staged on its branch (a title of 3 to 120 characters, as groundray's schema takes; refusal reason `no_brain`; the result's `context.brain`, additive); sent through the provider's `propose` by the kernel under `review: lint` (actor `capcomd/<version>`, within 4 minutes, the rest left for a person) or by a person with `capcomd context brain propose --run <runId> --yes` (actor `human:<id>`), and recorded as `plugin.context.brain_staged` and `plugin.context.brain_proposed` (§6.6.8). `context-groundray` is writable: a draft made by the groundray CLI in a throwaway authoring clone, pushed to `groundray/capcomd-<runId>-<agentId>` from a host repo (§11.7) and opened as a pull request through the forge that serves the brain; the conformance suite's propose case for a handle the provider didn't make (§14.2). |
| 1.0.33 | 2026-11-06 | With ADR-024's install, export and update (its §7 step 7): a profile package is fetched and locked as a plugin is, `LOCK` with `kind: "profile"` and the same content hash (§4.8); `trust.json` keeps the operator's trust in a project's profile skills as kind `profile`, one entry per `SKILL.md` (the file made real, the sha256 the agent is pinned with); the kernel refuses a spawn of a profile with an untrusted project skill (`config`, reason `untrusted`) in its spawn checks, after `profile.resolved`. No hook, seam, route or contract shape changes; the step's decisions are in ADR-024 §9. |
| 1.0.34 | 2026-11-06 | With the SDK (§17.2 step 13): `@capcomd/plugin` is built for publishing by `packages/plugin/scripts/pack.ts` (§14.6: Node ≥ 20 and Bun, no Bun API at run time, `nodenext` declarations, entry points `.`, `./client`, `./testkit`, `./schema`) at capcomd's own version, and published by the release workflow only while the repository variable `PUBLISH_PLUGIN_PACKAGE` is `true` (ADR-023 §9 decision 6 superseded); `testkit.bootWith` runs a separate `capcomd serve` in a home of its own with the plugin directories as the user's, and takes directories only, its in-memory form dropped (a plugin is a process) (§14.3); `conformance.forge` stays out of the kit, as only built-ins have seams (§14.5); the client library adds `manifestHash` and `sessionOpen` for the handshake (§9.8; additive); the examples import the package by its name, and the Slack example is tested as an author would, against a daemon on the fake sandbox (§15, §15.4); the guide for plugin authors is `docs/plugins.md`. |
| 1.0.35 | 2026-11-06 | Project templates (§11.7 item 4): on a VM provider with snapshots, a per-project env build with the repository's whole history (brought from the host's mirror as a bundle) and its setup step (`CAPCOMD_SETUP_COMMAND`), run with the place's secret placeholders unset and their domains out of the build VM's egress; named `capcomd-env-<base>-<project>-<build>`, adding at most 10 GB to the base image, recorded in `templates.json` with every snapshot capcomd made as one (the only ones it deletes); an agent boots from its project's template and the runner uses it in place under Docker's warm-checkout rules, so the host sends a delta bundle; a missing, stale or outgrown template is (re)built in the background, never waited for; `sandbox-boxd` gains a daily refresh timer (`job.changed`, a `steer` scope, both additive). `SnapshotInfo.sizeBytes`, `SendRequest.seed` and the runner's `onWorkspace` (all optional, additive). |
| 1.0.36 | 2026-11-06 | With ADR-024's migrate and templates (its §7 step 9): the `planner` and `lead` profiles of §16.1 are profile files `capcomd setup project` writes in the project's `.capcomd/profiles/` (`lead` and `planner` extend `worker`), no longer `agents.json` entries, and every profile it writes has the project's memory (`context.providers: [{name: memory}]`, ADR-025 §6.1); the bundled layer stays empty (a bundled profile would need a harness every user can run). `agents.json` (v1) is deprecated: read for two more minor releases, then warned about by `validate`, then no longer read; its schema gains an optional `$comment`, which `capcomd profiles migrate` leaves in it. No hook, seam, route or contract shape changes (`POST /v1/projects`'s description says what it writes); the step's decisions are in ADR-024 §9. |
| 1.0.37 | 2026-11-07 | From the review of §17.2 step 9: a secret's reference falls back to the schema's `default` for a built-in only (§10.3): a user's or a project's plugin named any of the daemon's variables in its own manifest (`env:GITHUB_TOKEN`) and got its value in `SessionOpened.secrets`, past §9.2's filter; the host's `secret` option gets the plugin's `source` (additive); `capcomd plugins trust` shows such a secret as unset. An out-of-process plugin's exit kills what is left of its process group, as a kill does, so a helper it started can't outlive its token or hold what the next start needs (§9.2); §9.2 says, after §6.1, that a process plugin's gates judge only what the daemon runs. The client library forgets observe calls' deadlines (§9.8). No hook, seam, route or contract shape changes. |
| 1.0.38 | 2026-11-07 | The watchdog's review (§17.2 step 11): an agent's windows are at least its checkpoint interval's (`stalled` no sooner than 1.5 × its `checkpointEveryMs`, the stop as much later), since its files changing show only at its checkpoints; the defaults are unchanged (§16.4). No hook, seam, route or contract shape changes. |
| 1.0.39 | 2026-11-07 | Every agent that does work of its own has the in-VM capcomd (§16.2 rule 1, ADR-017 §2), not only one that may spawn: with the profiles `capcomd setup project` writes, no agent could run a job (planner and lead orchestrate, workers had none) or propose a lesson. An agent that may not spawn gets the CLI, the MCP server and a leaf token: `title`, `status`, `tree`, `inspect`, `logs`, `events`, `budget`, `heartbeat`, `kv`, `task`, `inbox`, `send`, `result`, and `job.*` only when its profile and the config it runs with (the daemon's `CAPCOMD_AGENT_ALLOWED_TOOLS`, `CAPCOMD_AGENT_DISALLOWED_TOOLS`, a Codex agent's `CAPCOMD_CODEX_SANDBOX`; none when that config can't be read) let it run a command of its own; never `spawn`, `await`, `wait-any`, `cancel`, `handoff`, `verify`, `merge`, `grant`, `fetch` or `check` (the op list stays closed; a spawner's token is unchanged but loses `job.*` the same way). It is told so in its instructions (its tab, jobs, notes and lessons, its summary), still fails `no_changes` when it changed nothing, and its MCP `tools/list` shows only what its token allows. Verify's reviewer, a report agent and the consolidator keep the naming shim. §6.6.7's routing paragraph goes to every agent with the in-VM capcomd (not the consolidator), with no profile room kept for it unless it may spawn. Any agent that declared no `result.summary` has its final message as one (≤ 2,000 characters; never a reviewer's verdict): additive. An in-VM `result` with no summary, artifacts or data is refused (`usage`), so a tool called with no arguments can't record an empty result or erase a declared one. The worker's lines name nothing of the agent's own, so a profile's agents keep one cached prefix (ADR-025 §6.1). No hook, route or contract shape changes. |
| 1.0.40 | 2026-11-07 | Triggers, after review: §16.3.2 step 6, a trigger's text is checked as `POST /v1/runs` checks a goal before a run starts (a leading `[agent:NAME]` from a source no longer picks the run's agent profile; over 16 KB, empty or with a NUL: `invalid`, logged `failed`); §16.3.1, a trigger's `id`, `thread` and actor id carry no control characters (the display name loses them), and the `github` source keeps the comments it read at its position's second (GitHub's `since` includes it) so a poll with nothing new emits nothing. |
| 1.0.41 | 2026-11-07 | Small items from a live run: the built-ins register every hook they declare whatever their settings (forge-github's, source-schedule's and sandbox-boxd's `job.changed` listeners, which do nothing without repositories, schedules or the template refresh), so the host no longer logs `declared but never registered` at every start (§4.7, §16.3.1); a verify with no check named, given or pinned and no repository command takes the run's one named check (the project's `run.checks`), as `check` does, and keeps the repository's with several (§16.1); a merge's record adds a plugin's hold to `approvedHolds` when a person approves it, so it no longer reads `[]` after the approval (§6.6.15). No hook, seam, route or contract shape changes. |

Decisions made while writing this document, with reasons, are listed in ADR-023 ("Decisions made in the spec") and
ADR-024 (the profile-side ones).
