# Research: plugin architectures and agent profiles, for capcomd

Date: 2026-11-04. Read-only research for [ADR-023 (plugin core)](../adr-023-plugin-core.md) and [ADR-024 (agent
profiles v2)](../adr-024-agent-profiles.md). Every external repository was cloned shallow into a scratch folder,
never built or run, and read at one pinned commit; the links below point at those commits. Where a claim is about a
system I did not read the source of, the public documentation URL is given instead.

| Repository | Commit read | What it is |
|---|---|---|
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | [`fcc0ad46`](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159) (`master`, 2026-11-04) | "DeepSeek Harness: Everything is a Plugin", the `dsh` coding agent and its plugin kernel |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | [`ed1afb08`](https://github.com/NousResearch/hermes-agent/tree/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df) (`main`, 2026-11-04) | Hermes Agent, whose "profiles" feature the owner pointed to |

The owner asked whether deepseek-harness exists. **It does.** It is public, MIT-licensed, very active (272k stars on
the day of reading, pushed the same day), and its tagline is the owner's phrase. Section 2 is what it actually is and how
its plugins work. An ecosystem of third-party lists and desktop wrappers has grown around it (`awesome-dsh-plugin`,
`dsh-desktop`, a plugin hub claiming 11,000+ plugins); none of those were read.

Sections: 1 method · 2 deepseek-harness · 3 Hermes profiles · 4 other plugin systems · 5 capcomd today · 6 what to
adopt, adapt, reject.

## 1. Method

Shallow clones (`--depth 50`) into the session scratchpad, outside the capcomd checkout. Reading with `grep`, `sed`,
`find`; no install scripts, no builds, no execution. Two sub-agents read the two repositories and reported back with
`path:line` citations that were checked with `grep -n` before being turned into permalinks. Comparable systems (§4)
come from their public documentation, fetched the same day, plus prior knowledge where the docs did not cover a point
(those are marked).

## 2. deepseek-harness (`dsh`)

Permalink base: `https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/`.

### 2.1 What it is

dsh is a coding agent (CLI, web, headless, SDK and ACP modes) built as a thin product layer on **Cordis**, a
dependency-injection and typed-event framework the repository vendors and patches
([vendor/README.md L3](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vendor/README.md#L3),
[L15–25](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vendor/README.md#L15-L25)).
"Everything is a plugin" is literal: "Every part of the product is a plugin, including the model adapter, the tool
registry, the session log, and the agent loop itself, so each is replaceable from configuration. There is no privileged
core to patch" ([docs/architecture.md L7–11](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md#L7-L11)).
The kernel is Cordis plus its Loader: `vendor/cordis/src` is 9 files and 2,811 lines, the Loader 1,224 lines; the
product is 370 packages in 53 groups, 2,974 source files, about 530,000 lines. MIT licensed.

Important for the owner's question: in dsh a **"profile"** is an ordered stack of plugin bundles plus a patch file
(§2.4–2.5), that is, a configuration of the harness. It is not an agent persona. The two meanings (dsh profile, Hermes
profile) are different things that happen to share a word; ADR-024 uses the Hermes meaning.

### 2.2 Primitives

The real kernel API is Cordis's, in `vendor/cordis/src`:

- A plugin is a function `(ctx, config) => any`, a constructor, or an object, with shared metadata `name`, `Config`
  (a Standard Schema), `inject` (the services it needs), `provide`, `intercept`
  ([registry.ts L91–124](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vendor/cordis/src/registry.ts#L91-L124)).
- `Context`: `ctx.plugin()`, `ctx.inject()`, `ctx.on/once/emit/parallel/serial/bail/waterfall`, `ctx.effect(() =>
  disposer)` (every registration is a reversible effect), `ctx.get(name)` for optional services
  ([context.ts L16–34](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vendor/cordis/src/context.ts#L16-L34),
  [events.ts L33–105](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vendor/cordis/src/events.ts#L33-L105),
  [fiber.ts L355–380](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vendor/cordis/src/fiber.ts#L355-L380)).
- `Service`: a class whose constructor registers it under a name and whose lifetime is its owning plugin's
  ([service.ts L5–59](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vendor/cordis/src/service.ts#L5-L59)).

The harness-level primitives are themselves plugins that other plugins register into
([docs/architecture.md L148–169](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md#L148-L169)):

| Primitive | API | Where |
|---|---|---|
| Tools | `ctx.tools.register(definition, options?) → disposer`; `ToolDefinition {execute, output, timeoutMs?, …}`; `options.when` activates a tool per step | [packages/core/tools/src/index.ts L128](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/index.ts#L128), [contracts.ts L26–69](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/contracts.ts#L26-L69), [L115–124](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/contracts.ts#L115-L124) |
| System prompt | `ctx.systemPrompt.section({name, order, text, complete?})`, `.context()`, `.tools()`, `.variable()`, each a disposer | [packages/core/system-prompt/src/index.ts L53–75](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/system-prompt/src/index.ts#L53-L75), [L484–567](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/system-prompt/src/index.ts#L484-L567) |
| LLM adapters | `ctx.llm.registerAdapter(providers[], adapter)` | [packages/llm/llm/src/index.ts L401](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/llm/llm/src/index.ts#L401) |
| Human commands | `ctx.commands.register(definition) → disposer` | [packages/interaction/commands/src/index.ts L285](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/interaction/commands/src/index.ts#L285) |
| Sessions, agents, turns | `ctx.sessions`; `ctx.agents` with `agent.ctx` for per-agent scoping; `createScope(ctx, key)` | [packages/core/agent/src/runtime-types.ts L270](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/runtime-types.ts#L270), [packages/core/scope/README.md L12–32](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/scope/README.md#L12-L32) |
| UI slots (web client) | `ctx.slots.register()`, `ctx.slots.inject(key, cb)` over a declaration-merged `SlotMap` | [docs/subsystems/slots.md L5–27](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/slots.md#L5-L27) |
| Approval | `ctx.approval` + an `approval/request` waterfall; outcomes `allowed-once \| rejected \| cancelled \| unavailable`, fail-closed | [docs/subsystems/approval.md L5–33](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/approval.md#L5-L33) |
| Storage, settings, jobs, fs, sandbox, shell, terminals… | each a `ctx.<key>` service; 109 services in the generated seam graph | [packages/README.md L29–83](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/README.md#L29-L83), [docs/capability-seams.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/capability-seams.md) |

The rule that organises all of it is the **capability seam**: "a swappable capability with three roles: a Service
Definition declaring the interface, a Service Provider implementing it, and a Consumer using it… Seams are why one
provider swap changes the whole product" ([docs/architecture.md L136–140](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md#L136-L140)).

### 2.3 Lifecycle hooks and events

- **Plugin lifecycle** is a fiber state machine `PENDING → LOADING → ACTIVE (→ FAILED)`, `ACTIVE → UNLOADING →
  DISPOSED` ([fiber.ts L142–155](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vendor/cordis/src/fiber.ts#L142-L155)).
  A plugin whose injected service disappears unloads, and reloads when the service returns. Disposers run in reverse
  registration order ([docs/user/develop/framework/index.md L7–63](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/framework/index.md#L7-L63)).
- **Dispatch modes**, one word per event: `emit | parallel | serial | bail | waterfall`
  ([events.ts L31](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vendor/cordis/src/events.ts#L31);
  table in [docs/cordis-primer.md L19–35](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/cordis-primer.md#L19-L35)).
  `emit` is fire-and-forget; `parallel` awaits all; `serial` runs in order and the first non-null return stops the
  chain; `bail` is `serial` without awaiting; `waterfall` wraps: a listener that omits `next()` vetoes or replaces.
  Every harness event documents `@mode` in JSDoc and a generator checks dispatch sites against it.
- **Agent-loop events** ([packages/core/agent/src/runtime-types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/runtime-types.ts#L288-L429)):
  `agent/created` (serial), `agent/disposed`, `agent/status`, `agent/inbox/inserted|claimed|discarded` (emit);
  `agent/pre-step` (**waterfall**, payload `{agent, messages, turn, step, signal, modelSelection}`, returns
  `{kind: 'reject'} | {kind: 'enter', messages}`: it can reject a step or rewrite the messages entering it,
  [L348–350](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/agent/src/runtime-types.ts#L348-L350));
  `agent/request-error` (waterfall, `{kind: 'retry'} | undefined`); `agent/turn-stopping` (serial); `agent/error`.
- **Tool pipeline events** ([packages/core/tools/src/events.ts L6–58](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/events.ts#L6-L58)):
  `tools/pre-execute` (waterfall → `allow | deny{reason} | cancel | ask{reason}`; "missing approval support turns `ask`
  into denial", [contracts.ts L357–361](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/contracts.ts#L357-L361)),
  `tools/execute` (waterfall around dispatch; wrappers may only change `exec.signal`), `tools/post-execute` (waterfall
  → `accept{content} | block{feedback}`), `tools/result` and `tools/change` (emit).
- **Turn order** ([docs/architecture.md L85–106](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md#L85-L106)):
  `turn/start → system-prompt/assemble → agent/pre-step → step/start → agent/request → llm/stream → tool/call* →
  tools/pre-execute → tools/execute → tools/post-execute → tool/result* → step/end → agent/turn-stopping → turn/end`.
  Durable session events go through `session/event` after commit, with listener failures contained
  ([packages/core/session/src/index.ts L66–76](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/session/src/index.ts#L66-L76)).
- **Timeouts:** none at the hook level in Cordis (not found). Tool deadlines are per tool (`ToolDefinition.timeoutMs`,
  whose doc says the value "is NEVER sent to the model",
  [packages/core/tools/src/contracts.ts L62–69](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/contracts.ts#L62-L69))
  and enforced by a plugin wrapping `tools/execute`
  ([packages/guard/timeout-policy/README.md L12](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/guard/timeout-policy/README.md#L12)).

### 2.4 Registration and discovery

- **Manifest:** an ordinary `package.json` with a `dsh` key: `dsh.bundle {patch, platforms?, listedByDefault?}`,
  `dsh.profile {bundles?}`, `dsh.client {platform, inject?, …}` for browser halves, and `engines.dsh` as a semver range
  ([packages/util/package-manifest/src/types.ts L7–100](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/util/package-manifest/src/types.ts#L7-L100)).
  The bundle's `patch` is a `cordis.patch.yml` that `insert`s rows `{id, name, config?, disabled?, inject?}`
  ([docs/user/develop/basic/publish.md L35–62](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.md#L35-L62);
  row shape [vendor/loader/src/config/entry.ts L10–23](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vendor/loader/src/config/entry.ts#L10-L23)).
- **Where plugins live:** a profile at `$DSH_HOME/profiles/<name>` (default `~/.dsh`) is an npm project whose
  `package.json` lists bundles as pnpm dependencies and orders them in `dsh.profile.bundles`; `dsh plugin --profile <p>
  add <spec>` forwards to pnpm ([publish.md L68–118](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.md#L68-L118);
  [packages/util/home-paths/src/index.ts L12–18](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/util/home-paths/src/index.ts#L12-L18)).
  Shipped templates: `web | headless | sdk | acp` = `dsh-base` + a mode bundle
  ([packages/util/official-bundles/src/bundles.ts L10–26](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/util/official-bundles/src/bundles.ts#L10-L26)).
- **Loading:** in-process ESM import through the Cordis Loader. No child-process or WASM plugin model (not found). MCP
  servers are bridged by an in-process plugin that registers their tools as `mcp__<server>__<tool>`
  ([packages/mcp/mcp-client/README.md L12](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/mcp/mcp-client/README.md#L12)).
- **Enable/disable:** per row `disabled` (may be a `!!js` expression on the context), per bundle by removing it from the
  profile. A Plugin Manager (web page and a `plugin_manager` tool) writes these; HMR applies without restart
  ([packages/boot/plugin-manager/README.md L14–40](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/plugin-manager/README.md#L14-L40)).
- The **export form rule** is load-bearing: function plugins named-export `name`/`inject`/`Config`/`apply` with no
  default export; mixing forms silently drops the plugin's namespace (a postmortem exists:
  [docs/postmortem/0001-acp-default-export-drops-inject.md](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/postmortem/0001-acp-default-export-drops-inject.md),
  [packages/AGENTS.md L5](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/AGENTS.md#L5)).

### 2.5 Composition and ordering

- **Load order is service availability, not list order.** "Row order carries no load semantics (activation is
  service-availability driven)" ([packages/bundle/base/cordis.patch.yml L12–13](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/base/cordis.patch.yml#L12-L13);
  [docs/cordis-primer.md L11](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/cordis-primer.md#L11)).
- **Layers:** empty root → the profile's bundles in list order → the profile's `cordis.patch.yml` → the home's
  `cordis.patch.yml` → `--patch` overlays. Later layers win **per row by `id`**, and a patch replaces the row's whole
  `config` (no deep merge) ([publish.md L120–134](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.md#L120-L134);
  [base/cordis.patch.yml L6–10](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/base/cordis.patch.yml#L6-L10)).
- **Two contributors to one slot:** a duplicate tool name in one scope throws
  ([packages/core/tools/src/index.ts L69–70](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/src/index.ts#L69-L70));
  prompt sections concatenate by `order`, a `complete` section replaces everything, two of them fail assembly;
  listeners run in registration order with `prepend` to go first; a UI slot child already owned fails activation.
  Per-agent variants register through `agent.ctx`: the nearest scope wins, children inherit. No numeric priority and
  no `conflicts` field (not found).

### 2.6 Isolation and permissions

**There is no plugin sandbox.** Plugins are trusted in-process code: "installed Host code executes in-process outside
the workspace sandbox" ([plugin-manager/README.md L31](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/plugin-manager/README.md#L31));
the compatibility check "is not a sandbox against malicious package code"
([packages/boot/app-boot/README.md L54](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/app-boot/README.md#L54));
`SAFETY.md` says the project is unaudited and may load untrusted plugins, and to run it least-privilege in a disposable
VM ([SAFETY.md L7–23](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/SAFETY.md#L7-L23)).
What is sandboxed is the **agent's actions**: `ctx.sandbox` with `read-only | workspace-write | danger-full-access`
on bwrap/Landlock/Seatbelt/Windows-token backends ([packages/sandbox/README.md L12–32](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/sandbox/README.md#L12-L32)),
`ctx.approval` (fail-closed), permission presets, and "monotonic guards" on `tools/pre-execute`
([docs/tool-execution-pipeline.md L7–21](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/tool-execution-pipeline.md#L7-L21)).
Trust levels are bundle classifications (official, optional, on-demand, experimental). Plugin signing: not found.

### 2.7 Config

Each plugin exports `Config` as a Schemastery schema (Standard Schema); Cordis validates and fills defaults at load and
an invalid config fails the load ([docs/user/develop/basic/config.md L9–92](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/config.md#L9-L92)).
The house rule: no hard-coded tunables, "the test is whether `cordis.yml` can change the value without a code edit".
Values live in the row's `config:` in bundle patches, overridden per profile and per user; `!!js` is allowed only in
`config` and `disabled` and a script enforces it ([scripts/verify-cordis-config.ts L1–11](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/scripts/verify-cordis-config.ts#L1-L11)).
A config catalog is generated from every package's declared type ([docs/config-catalog.md L4–10](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/config-catalog.md#L4-L10));
`dsh --dump-config-schema` prints the composed JSON Schema. No per-project (cwd) config layer (not found).

### 2.8 Versioning

APIs are declared pre-stable ([AGENTS.md L5–7](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/AGENTS.md#L5-L7)).
Before importing a plugin, dsh compares the manifest with the single runtime version: `engines.dsh` alone decides when
present, else every `peerDependencies` range on `@deepseek-ai/dsh*` must match; prereleases participate; a missing
declaration imposes no constraint; an invalid range is incompatible. Denied rows become `disabled: true`, denied bundles
are skipped; the same check runs before `pnpm add` ([app-boot/README.md L54–58](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/app-boot/README.md#L54-L58)).
Exact `package@version → [runtime versions]` exemptions go in the profile's `compatibility.json` via `dsh plugin …
allow-version <package@version> --dsh-version <range> --accept-risk`
([packages/boot/plugin-manager/README.md L83](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/boot/plugin-manager/README.md#L83)). `dsh.manifestVersion: 1` is independent of the package and session versions; the session
format has its own version and `vN→vN+1` migration packages.

### 2.9 Core features as plugins

`dsh-base`'s single `insert` patch mounts about 110 rows: `llm`, `session`, `agent`, `agent-loop`, `tools`,
`tool-executor-native`, `system-prompt`, `approval`, `permission`, `tool-bash`, `tool-fs`, `compaction-basic`,
`subagent`, `plugin-manager`, `hmr`, and the model adapter `llm-deepseek`
([packages/bundle/base/cordis.patch.yml L15–548](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/bundle/base/cordis.patch.yml#L15-L548)).
A user replaces any of them by `id`. The loop is swappable because extensions depend on `dsh-agent` (the interface),
not `dsh-agent-loop` ([packages/README.md L99](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/README.md#L99)).
What is **not** a plugin: Cordis itself and the Loader (vendored, pinned, 27 logged local patches, "so that the harness
fully owns its framework layer"), and the `dsh` launcher that computes layers and runtime resolution
([docs/architecture.md L41–45](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/architecture.md#L41-L45)).

### 2.10 Testing

Tiers: unit with a per-file 100% coverage gate, real-API e2e (self-skipping without a key), recorded-session
**snapshot replay** (`DSH_SNAPSHOT=replay|record|refresh`), benchmarks, web snapshots
([docs/testing.md L7–15](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/testing.md#L7-L15);
[vitest.snapshot.config.ts L30–40](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/vitest.snapshot.config.ts#L30-L40)).
Two rules matter for a plugin core: every registry gets an **HMR-safety test** (dispose the contributing plugin, assert
its registrations are gone, e.g. [packages/core/tools/tests/tools.spec.ts L603–612](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/core/tools/tests/tools.spec.ts#L603-L612)),
and every product-visible plugin needs a **real-composition test** that boots a test-only `cordis.yml` through the
Loader and the app process, mocking only the LLM ([packages/AGENTS.md L7](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/AGENTS.md#L7);
[docs/testing.md L39–41](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/testing.md#L39-L41)).
`packages/test-support/` ships `loader-smoke`, `agent-loop-testkit`, `tool-testkit`, `llm-mock-server`, `llm-replay`,
`session-snapshot`.

### 2.11 Other things worth knowing

- No marketplace in the repo (`dsh-external/hub` from the third-party lists: not found). A `plugin-market` reads
  user-configured index JSON files (`format: 1`, `plugins[].versions[].source {npm|git}`, `engines.dsh`), off by
  default; a generator builds such an index from npm names and git URLs; the `dsh-plugin` GitHub topic is the discovery
  path ([docs/user/guide/plugin-market.md L5–67](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/guide/plugin-market.md#L5-L67)).
- Runtime self-modification: agents can write config-only bundles and install them through the `plugin_manager` tool
  ([docs/user/develop/practice/dynamic-cordis.md L5–13](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/practice/dynamic-cordis.md#L5-L13)).
- A Python SDK speaks JSON-RPC over stdio to `dsh --profile sdk`; `native/` is a Landlock launcher and a flock binding.

### 2.12 What this means for capcomd

dsh's design is coherent because it has one process, one trust level and one agent loop it owns. capcomd has none of
those: the agent loop belongs to Claude Code or Codex inside a VM, the daemon holds tokens, and the trust boundary is
the sandbox. So the **mechanics** transfer (dispatch modes, reversible registrations, service-driven load order, layered
config by id, `engines` version gates with explicit exemptions, HMR-safety and real-composition tests, the seam rule)
and the **trust model** does not (in-process untrusted code). ADR-023 takes the first set and keeps
harness-architecture.md's line on the second.

## 3. Hermes Agent profiles

Permalink base: `https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/`.

### 3.1 What a profile is

A profile is a **separate Hermes home directory**, nothing more and nothing less: "Each profile gets its own directory
containing its own `config.yaml`, `.env`, `SOUL.md`, memories, sessions, skills, cron jobs, and state database"
([profiles.md L7–11](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/website/docs/user-guide/profiles.md#L7-L11)).
The mechanism is one environment variable: `hermes -p <name>` sets `HERMES_HOME=~/.hermes/profiles/<name>` and
"119+ files resolve paths via `get_hermes_home()`, so Hermes state automatically scopes to the profile's directory"
([profiles.md L401–405](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/website/docs/user-guide/profiles.md#L401-L405);
[hermes_constants.py L189–195](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_constants.py#L189-L195)).
A directory counts as a profile if it has one of the identity markers `config.yaml, .env, SOUL.md, profile.yaml,
auth.json, state.db`; names match `^[a-z0-9][a-z0-9_-]{0,63}$`
([hermes_constants.py L395–408](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_constants.py#L395-L408)).
The root `~/.hermes` is itself the `default` profile.

What a profile bundles, each under its own directory:

| Part | Evidence |
|---|---|
| `config.yaml`: model, provider, toolsets, every setting | [profiles.md L292–299](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/website/docs/user-guide/profiles.md#L292-L299); the model block seeded on create, [hermes_cli/profiles.py L1317–1320](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/profiles.py#L1317-L1320) |
| `.env` (API keys, bot tokens), `auth.json` (OAuth) | [profiles.md L265–273](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/website/docs/user-guide/profiles.md#L265-L273); root OAuth rows are shared unless the profile logs in itself, [L104–106](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/website/docs/user-guide/profiles.md#L104-L106) |
| `SOUL.md`: the persona, "identity slot #1" of the system prompt | [agent/prompt_builder.py L1512–1532](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/agent/prompt_builder.py#L1512-L1532); seeded from a default, [hermes_cli/profiles_initialization.py L46–49](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/profiles_initialization.py#L46-L49) |
| `skills/` (bundled skills seeded; `--no-skills` opts out) | [hermes_cli/profiles.py L90–93](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/profiles.py#L90-L93) |
| `memories/` (`MEMORY.md`, `USER.md`, a memory provider's files) | [hermes_cli/profiles.py L44–47](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/profiles.py#L44-L47) |
| `sessions/` and `state.db` (one SQLite store per profile) | [hermes_state_profile_repair.py L4–8](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_state_profile_repair.py#L4-L8) |
| `cron/jobs.json` (bound to the profile, never cloned) | [hermes_cli/profiles.py L94–103](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/profiles.py#L94-L103) |
| `plugins/` (per-profile user plugins) and MCP servers (`mcp_servers`, `mcp-tokens/`) | [hermes_cli/plugins_discovery.py L210–212](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/plugins_discovery.py#L210-L212); [multi-profile-gateways.md L578–596](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/website/docs/user-guide/multi-profile-gateways.md#L578-L596) |
| Messaging identity (bot tokens, allowlists, `platforms:`), `hooks/` | [profiles.md L120–170](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/website/docs/user-guide/profiles.md#L120-L170) |
| `profile.yaml`: `description`, `display_name`, `previous_names`, Bot Mode `ui_meta` | [hermes_cli/profiles.py L860–920](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/profiles.py#L860-L920) |
| `distribution.yaml` when installed from a repository | [hermes_cli/profile_distribution.py L107–150](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/profile_distribution.py#L107-L150) |

Not found: a profile schema or object beyond "a directory"; any profile-to-profile inheritance; "patch layers" (the
phrase from an awesome-list; nothing in the repo). The docs are explicit that profiles are not workspaces or sandboxes
([profiles.md L228–252](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/website/docs/user-guide/profiles.md#L228-L252)).

### 3.2 CLI and selection

`hermes profile list|use|show|create|alias|rename|delete|describe|export|import|install|update|info|migrate-identity|purge-identity`
([hermes_cli/subcommands/profile.py L8–164](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/subcommands/profile.py#L8-L164)).
`create` takes `--clone` (config, `.env`, `SOUL.md`, skills, `MEMORY.md`/`USER.md`, plugins; no sessions or cron),
`--clone-all` (everything but history and runtime files), `--clone-from`, `--clone-channels`, `--no-skills`,
`--description`. Selection: `-p` anywhere in argv → an existing `HERMES_HOME` under `profiles/` → the sticky
`~/.hermes/active_profile` file → default
([hermes_cli/main.py L592–671](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/main.py#L592-L671)).
Per-profile wrapper scripts (`~/.local/bin/<name>`) are `hermes -p <name>`. Reserved names: `hermes, default, test,
tmp, root, sudo` and every subcommand.

### 3.3 Isolation

Per profile: config, secrets, persona, skills, memory, sessions and state DB, cron, plugins, hooks, logs, gateway PID,
MCP connections and OAuth tokens, approvals, the outbound bot identity
([multi-profile-gateways.md L658–697](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/website/docs/user-guide/multi-profile-gateways.md#L658-L697)).
Shared: the code checkout and venv, root OAuth logins, the real OS `HOME` for tool subprocesses unless
`terminal.home_mode: profile`, the kanban board (`~/.hermes/kanban.db`). Session keys are namespaced
`agent:<profile>:…`. Two profiles may run at once (one gateway per profile, or one multiplexing gateway serving all of
them, the default); two processes on one profile home is forbidden. Profiles talk to each other only indirectly: the
shared kanban board (the dispatcher runs the assignee profile as a worker process and routes by each profile's
`describe` text, [kanban.md L105–138](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/website/docs/user-guide/features/kanban.md#L105-L138);
[hermes_cli/profile_describer.py L23–30](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/profile_describer.py#L23-L30)),
delegation routes (a child `delegate_task` runs as another profile), and hosted group rooms.

### 3.4 Sharing: export, import, distributions

Export is a `.tar.gz` with credentials stripped by file name
([hermes_cli/profiles.py L225–262](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/profiles.py#L225-L262)).
A **distribution** is a profile published in a git repository with `distribution.yaml` (`name`, `version`,
`description`, `hermes_requires`, `author`, `license`, `env_requires[]`, `distribution_owned[]`, tracked `source`,
`installed_at`); `hermes profile install <git-url|dir>`; `update` re-clones and replaces only the distribution-owned
paths (default `SOUL.md, config.yaml, mcp.json, skills, cron, distribution.yaml`), keeps `config.yaml` unless
`--force-config`, merges cron jobs by id (new ones paused), and never touches user-owned paths (`memories, sessions,
plans, workspace, home, backups`, credential stores)
([hermes_cli/profile_distribution.py L38–63](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/profile_distribution.py#L38-L63);
[profile-distributions.md L269–288](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/website/docs/user-guide/profile-distributions.md#L269-L288)).
`.git/` is stripped after clone and there is no ref pinning yet. A distribution-owned `SOUL.md` is scanned as untrusted
text ([agent/prompt_builder.py L1543–1556](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/agent/prompt_builder.py#L1543-L1556)).

### 3.5 Hermes plugins, briefly

Sources in override order: bundled `plugins/<name>/`, user `HERMES_HOME/plugins/<name>/` (so per profile), project
`./.hermes/plugins/` (opt-in), pip entry points. A plugin is `plugin.yaml` + `__init__.py` with `register(ctx)`
([hermes_cli/plugins.py L1–9](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/plugins.py#L1-L9);
[hermes_cli/plugins_discovery.py L206–235](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/plugins_discovery.py#L206-L235)).
Manifest fields: `name, version, kind (standalone|backend|exclusive|platform|model-provider), provides_tools,
provides_hooks, requires_env, requires_plugins (advisory, topologically sorted), config_schema, api_version,
capabilities`
([hermes_cli/plugins_manifest.py L26–45](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/plugins_manifest.py#L26-L45)).
About 60 hook names in `VALID_HOOKS`: directive hooks (`pre_tool_call` block/approve, `pre_llm_call` inject/block,
`pre_verify`), transforms (`transform_tool_result`, `transform_llm_output`: first non-None wins), observers
(`post_tool_call`, `on_session_*`, `subagent_start/stop`, `post_compaction`)
([hermes_cli/plugins.py L109–204](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/hermes_cli/plugins.py#L109-L204)).
Callback crashes are logged and skipped; per-callback timeout 30 s. Default in-process; `plugins.isolation: host`
runs third-party plugins in one plugin-host process per profile over a stdio pipe
([plugins.md L859–923](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/website/docs/user-guide/features/plugins.md#L859-L923)).
A catalog (`plugin-catalog/*.yaml`, 978 entries) pins each plugin to a 40-hex `sha`; CI validates at the pin
([plugins/AGENTS.md L62–81](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/plugins/AGENTS.md#L62-L81)).
The repo's own rule is "plugins never touch core"; memory providers and several integrations have moved out of core
into the catalog ([plugins/AGENTS.md L7–47](https://github.com/NousResearch/hermes-agent/blob/ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df/plugins/AGENTS.md#L7-L47)).

## 4. Other plugin systems, and the one lesson each teaches

Kept to what applies to an agent-orchestration daemon.

**Claude Code plugins and hooks** ([hooks](https://code.claude.com/docs/en/hooks), [plugins](https://code.claude.com/docs/en/plugins),
[manifest](https://code.claude.com/docs/en/plugins/manifest-reference)). A plugin is a directory with
`.claude-plugin/plugin.json` (only `name` required; `version`, `dependencies`, `userConfig` with `sensitive` values)
and conventional folders (`skills/`, `agents/`, `hooks/hooks.json`, `.mcp.json`). Every component is namespaced
`plugin:component`; MCP tools become `mcp__plugin_<plugin>_<server>__<tool>`. Hooks: ~33 events (`SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`,
`Notification`, `SessionEnd`…), JSON on stdin, exit 0 = allow (stdout JSON parsed: `continue`, `decision: "block"` +
`reason`, `hookSpecificOutput.permissionDecision allow|deny|ask|defer`, `updatedInput`, `additionalContext`), exit 2 =
block (stderr is the reason), anything else = non-blocking error; matchers are exact `A|B` or regex; matching hooks run
in parallel. `${CLAUDE_PLUGIN_ROOT}` (immutable per version) vs `${CLAUDE_PLUGIN_DATA}` (survives updates).
`claude plugin validate --strict` checks path containment and unknown keys. *Lessons:* one stdin/stdout JSON + exit-code
contract makes any language a plugin; say per event whether it can block; namespace everything under the plugin name;
split immutable code from durable data; ship a strict validator for CI (capcomd already runs it on its own plugin,
ADR-018 §1).

**OpenAI Codex plugins and hooks** ([hooks](https://developers.openai.com/codex/hooks), [plugins](https://developers.openai.com/codex/plugins/build)).
Deliberately the same shape: `.codex-plugin/plugin.json` (or a portable root `plugin.json` with
`extensions."com.openai"`), `skills/`, `mcp.json`, `hooks/hooks.json`; a marketplace file with
`policy.installation AVAILABLE|INSTALLED_BY_DEFAULT|NOT_AVAILABLE`; enablement in `.codex/config.toml` keyed
`name@marketplace`. 14 hook events with the same stdin/stdout and exit 0/2 contract, plus `PreModelRequest`,
`PostModelRequest`, `Interrupt`, and `async: true` background hooks (at most 8). Project hooks load only from a trusted
`.codex/`; non-managed hooks need review in `/hooks` before first run. It exports `CLAUDE_PLUGIN_ROOT` beside
`PLUGIN_ROOT` for compatibility. *Lessons:* converge on the de-facto hook wire format; a hook script is reviewed before
its first run and again when its bytes change; async observers with a concurrency cap; install policy in the catalog,
enablement in layered config.

**VS Code extensions** ([manifest](https://code.visualstudio.com/api/references/extension-manifest),
[activation events](https://code.visualstudio.com/api/references/activation-events),
[extension host](https://code.visualstudio.com/api/advanced-topics/extension-host)). `package.json` is the manifest;
`engines.vscode` (semver, never `*`) gates API compatibility; `contributes` declares static contribution points read
without activating the extension; activation is lazy on events; `extensionDependencies` (installed and activated
first) vs `extensionPack` (bundled only); all extensions run in an extension host process so one cannot block the UI;
proposed APIs are opt-in and unpublishable. *Lessons:* split declarative contributions (scanned at startup, so the
kernel can render menus without loading code) from code (activated lazily); out-of-process by default with a typed API
surface; version the API, refuse `*`; a proposed-API gate for unstable hooks.

**Rollup / Vite** ([Rollup](https://rollupjs.org/plugin-development/), [Vite](https://vite.dev/guide/api-plugin)).
Each hook has a kind: `async|sync` × `first` (stop at first non-null: `resolveId`, `load`), `sequential` (each waits,
value threads: `transform`), `parallel` (`buildStart`, `closeBundle`). Object-form hooks take `{order: 'pre'|'post',
handler, filter}`. Vite adds `config` (mutate) then `configResolved` (read-only), `enforce: 'pre'|'post'`, `apply:
'build'|'serve'`; the final order is alias → user pre → **core plugins** → user → build → user post → post-build, so
core features are plugins at fixed slots. Virtual modules use a `\0` prefix so other plugins skip them. *Lessons:*
declare each hook's kind in its definition (it fixes ordering, concurrency and return semantics in one word); core
features as plugins at fixed positions gives `pre|post` placement without priority integers; two-phase config; a
reserved prefix for host-synthesised resources.

**Fastify** ([plugins](https://fastify.dev/docs/latest/Reference/Plugins/), [hooks](https://fastify.dev/docs/latest/Reference/Hooks/),
[fastify-plugin](https://github.com/fastify/fastify-plugin)). `register(plugin, opts)` creates a child encapsulation
context; decorators, hooks and routes added inside stay inside unless the plugin opts out with `fastify-plugin`, which
also carries metadata checked at registration (`name`, a `fastify` version range, `dependencies` already registered,
`decorators` that must exist). Boot is an explicit DAG (`after()`, `ready()`); a fixed request pipeline
(`onRequest → preParsing → preValidation → preHandler → preSerialization → onError → onSend → onResponse`) where any
stage can short-circuit; `onClose` runs children before parents. *Lessons:* scoped registration (maps onto per-profile
vs shared); metadata checked at registration gives fail-fast wiring; an explicit boot DAG; a linear named pipeline;
teardown mirrors registration.

**Backstage backend system** ([architecture](https://backstage.io/docs/backend-system/architecture/index),
[plugins and modules](https://backstage.io/docs/backend-system/building-plugins-and-modules/index)). The kernel is
`createBackend()`; features are added with `backend.add(...)`. Three kinds: plugins (`createBackendPlugin`), modules
(`createBackendModule`, extend exactly one plugin), services (`createServiceRef`/`createServiceFactory`, root- or
plugin-scoped; `coreServices.*` are overridable). Plugins expose extension points (`createExtensionPoint<T>`) from a
separate `-node` package; a module depends on the extension point, never on the plugin's package. *Lessons:* typed
service refs as the only DI currency; extension points invert the dependency so the plugin owns the contract; one
service instantiated per plugin with its identity baked in (a per-plugin logger, kv prefix); publish the contract
separately from the implementation.

**Two more, briefly.** Webpack's **tapable** ([repo](https://github.com/webpack/tapable)): hook classes encode semantics
in the type name (`Sync|AsyncSeries|AsyncParallel` × `Bail|Waterfall|Loop`); taps carry `name`, `stage` and
`before: [names]`; `intercept({call, tap, result, error})` gives cross-cutting tracing. *Lesson:* name-based ordering
plus interceptors beats priority integers for debuggability. **Kubernetes** (prior knowledge, not re-read): the API
server stores declarative objects; every feature, including core ones, is a controller reconciling desired to observed
state; admission webhooks are the pre-hooks with an explicit `failurePolicy: Fail|Ignore`. *Lesson:* `failurePolicy` is
the right vocabulary for "does a dead hook block or allow", and plugin health should be observable like workload health.

## 5. capcomd today: the seams that already exist

What a plugin core would formalise, by file. This is the ground the ADRs stand on.

| Area | Where | What exists | What is hard-wired |
|---|---|---|---|
| Sandbox providers | `src/providers/sandbox.ts` `SandboxProvider`; `registry.ts` `PROVIDERS`/`ProviderDescriptor`/`ProviderCaps`; `dependencies.ts` `rawProviderFromEnv`, `providerNamed`; `tests/providers/conformance.test.ts` | A typed interface, a descriptor served to clients as data (ADR-021), capability flags consumers check by name (`sandboxCaps().snapshots`), a conformance suite | The `PROVIDERS` const; an `if` chain that `require`s `./providers/boxd` and `./providers/docker`; `name === "docker"` to start the sweep; `isBoxdAuthError` in `worker.ts` |
| Agent CLIs | `src/agents/types.ts` `AgentAdapter`; `adapters.ts` `claudeAdapter`, `codexAdapter`, `adapterFor`; `runner.ts` `runAgent` | A typed adapter interface (command, parse, guard, login, outcome) | `Provider = "claude" \| "codex"` closed in `profiles.ts`; `PROVIDER_KIND`, `PROVIDER_EFFORTS`, `AGENT_API_HOST` tables keyed on the two names |
| Merge paths | `src/merge/service.ts` `mergeTask`; `github.ts` `GitHubApi`, `setGitHubApi`; `direct.ts`, `pr.ts`; `config.ts` `github.*` keys | An interface for the forge, injected in tests | One forge; `gh` called directly from `api/project-git.ts` and `mcp/server.ts`; `mode` is a closed `pr \| direct` |
| Gates | `src/primitives/ops.ts` `verifyOnce`, `startReview`, `finishReview`, `reviewFits`; `review.ts` `parseVerdict`, `reviewBrief`; `merge/verify.ts` `runTests`, `checksMode` | Checks and reviewer as two steps, "both must pass for the same tree", fail-closed verdicts | Both steps inline in one function; one reviewer, one verdict format |
| MCP tools | `src/mcp/server.ts` (24 `registerTool` calls), `driver.ts` (policy), `projects.ts` | Registration via the MCP SDK, annotations, the `relay.v1` envelope, a principal (`driver`) | A static list in one file |
| CLI | `src/cli/index.ts` (a `switch` over ~40 commands), `src/cli/commands/*` | Per-command modules with `--json` envelopes | No registration; `index.ts` is 1,068 lines |
| harness.v1 | `src/api/contract.ts` `CAPABILITIES` (names clients feature-detect), `server.ts` scope middleware (`read`, `steer`, `approve`, `configure`), `clients.ts` tokens, `describe.ts` | Feature flags, scopes, principals, idempotency keys, an SSE stream with resume, daemon-written `text` | Every route in `server.ts`; the capability list is hand-maintained |
| Lifecycle | `src/actors/agent-workflow.ts` (prepare → drive loop → settle), `runner.ts`, `subagents/skill.ts` (prompt injection), `agents/skills.ts` (skills on messages), `utils/killpoint.ts` | A durable, named sequence of steps; killpoints as test-only hooks | No extension point; behaviour changes are env vars |
| Profiles | `src/agents/profiles.ts` `AgentSpec`, `validateSpec`, `widenings`, `applyOverrides`, `encodeAgentRef`, `pinSpec`; `config/project-setup.ts` `planProject`; `cli/commands/agents.ts`; `agents/run-driver.ts` `plannerDriver` | Strict schema, narrow-only overrides, the spec pinned on the agent, four generated profiles, a planner chooser | One flat JSON file; no `extends`, version, skills, memory, sandbox choice, persona or sharing |
| Front doors | `cli/commands/hermes.ts`, `plugins/capcomd/`, `cli/commands/setup.ts` | Bespoke, well-tested integrations | Each is core code |
| Principals | `primitives/ops.ts`, `policy.ts` keyed on `operator \| driver \| agent` (ADR-018 §4) | Enforcement in one place | No `plugin` principal |

Sizes (lines): `ops.ts` 1,700, `scope.ts` 1,324, `cli/index.ts` 1,068, `api/contract.ts` 993, `runner.ts` 917,
`worker.ts` 809, `api/server.ts` 776. The kernel the ADR keeps is the actors, `policy.ts`, the gateway and the
spool/token code; the rest is candidates.

## 6. What capcomd should adopt, adapt or reject

| Idea | From | Verdict | Why, and where it lands |
|---|---|---|---|
| Hook kinds declared in the definition (`observe` / `veto` / `modify`) | dsh `emit \| parallel \| serial \| bail \| waterfall` (§2.3), Rollup/Vite `first \| sequential \| parallel`, tapable, Hermes (`first non-None wins`) | **Adopt**, collapsed to three | One word fixes ordering, concurrency and return semantics; capcomd's hooks are either gates or observers, so five modes is more than it needs. ADR-023 §5.1 |
| Every event documents its mode and a generator checks dispatch sites | dsh (§2.3) | **Adopt** | A grep-based consistency test in `test:fast`. ADR-023 §8 step 1 |
| Registrations are reversible effects; a dispose test per registry | dsh (`ctx.effect`, HMR-safety tests, §2.2, §2.10) | **Adopt** | Disabling a plugin must remove its commands, tools, routes, descriptors and hooks, and a test proves it. ADR-023 §4, §8 step 1 |
| Capability seam: Service Definition + Provider + Consumer, consumers never name an implementation | dsh (§2.2) | **Adopt** for sandbox, agent and forge | capcomd already does this for sandboxes by capability flag; two name checks remain to remove. ADR-023 §4 |
| Load order from service availability, not list order | dsh (§2.5), Fastify boot DAG | **Adapt** | capcomd's plugins are few and their dependencies are the three seams; `after: [names]` plus `pre\|normal\|post` is enough and easier to read than a fiber scheduler. ADR-023 §5.1 |
| Layered config patches that win per row by id and replace the whole config | dsh (§2.5, §2.7) | **Adapt** | capcomd already layers user and project config key by key (`store.ts` `applyConfig`, `driverPolicy`); keep key-level merge for plugin config, which is what users expect from `.capcomd/config.json`. ADR-023 §6.5 |
| `engines` version gate that disables an incompatible plugin, with exact exemptions behind `--accept-risk` | dsh (§2.8), VS Code `engines.vscode` | **Adopt** | ADR-023 §6.6 |
| Real-composition test for every product-visible plugin (boot through the loader, mock only the model) | dsh (§2.10) | **Adopt** | `tests/scenarios/` already is this; the rule makes it a requirement per converted built-in. ADR-023 §8 |
| Plugins as trusted in-process code, no sandbox | dsh (§2.6) | **Reject** | The daemon holds client tokens and git credentials; harness-architecture.md §2 already rejected this. Built-ins and explicitly trusted plugins only. ADR-023 §6.3 |
| "Profile" = an ordered bundle stack plus a patch file | dsh (§2.1) | **Reject** as the meaning of "profile" | capcomd's profile is an agent (Hermes's meaning); dsh's concept is a daemon configuration, which `.capcomd/config.json` `plugins.use` covers. ADR-024 §1 |
| A `plugin_manager` tool that lets the agent install plugins at run time | dsh (§2.11) | **Reject** | capcomd agents run in sandboxes and never change the host; a driver may read `GET /v1/plugins`, never install. ADR-023 §6.4 |
| `pre \| normal \| post` placement, core features at fixed slots | Vite `enforce`, Rollup `order` | **Adopt** | No priority integers; built-ins are plugins at known positions. ADR-023 §5.1 |
| Fail-closed on gates, fail-open on observers, as a per-hook policy | Kubernetes `failurePolicy`, Claude Code exit 2 | **Adopt** | capcomd's gates (verify, merge, approval) must never pass because a plugin died. ADR-023 §5.1 |
| Circuit breaker on a misbehaving plugin, visible as an event | Hermes (log and skip), Backstage/Fastify practice | **Adopt** | A broken gate plugin can't wedge every merge silently. ADR-023 §5.1, §9 |
| Out-of-process by default with a typed API over stdio JSON-RPC | VS Code extension host, Hermes `plugins.isolation: host` (not dsh, which is in-process) | **Adopt** | harness-architecture.md §2 rejected in-process TS extensions because the daemon holds tokens; this keeps that line. ADR-023 §6.3 |
| A plugin is a client: scoped token, audited calls | capcomd's own `clients.ts` + t3code pairing grants (harness-architecture §2) | **Adopt** | One permission model, already enforced in `ops.ts`/`policy.ts`. ADR-023 §6.4 |
| Declarative contributions scanned without activating code (descriptors) | VS Code `contributes`, ADR-021 descriptors | **Adopt** | The app renders settings rows, actions and profile fields from data; no Swift per plugin. ADR-023 §4 `host.ui` |
| Strict validator for CI, path containment, no executables in a data package | Claude Code `plugin validate --strict` | **Adopt** | `capcomd plugins validate`, `capcomd profiles validate`. ADR-023 §6.2, ADR-024 §2.5 |
| Review-before-first-run and on byte change for project-level code | Codex trusted `.codex/`, Claude Code marketplaces | **Adopt** | `.capcomd/plugins` enable only after `capcomd plugins trust` per content hash. ADR-023 §6.2 |
| Content-hash pins in a catalog (`sha`), CI validates at the pin | Hermes plugin catalog | **Adopt** | `LOCK` files for installed plugins and profiles. ADR-023 §6.2, ADR-024 §2.5 |
| Owner-owned vs user-owned paths on update | Hermes `distribution_owned` | **Adopt** | `profiles update` replaces the manifest, persona and skills, never memory or a project override. ADR-024 §2.5 |
| Persona file first in the prompt; installed persona treated as untrusted text | Hermes `SOUL.md` | **Adopt** | ADR-024 `identity.persona`; shown by hash, trusted once per hash |
| Profile as a bundle of identity, config, skills, memory, plugins, MCP servers | Hermes | **Adapt** | capcomd's profile is a **spec resolved to a pin**, not a home directory: agents run one task in a VM, so sessions and cron don't belong; memory is a declared scope the sandbox plugin mounts. ADR-024 §2.1–2.2 |
| No inheritance; clone is a copy | Hermes | **Reject** | capcomd's four setup profiles repeat each other; `extends` with narrowing checked on the resolved spec is cheap and testable. ADR-024 §2.3 |
| Routing by the profile's description text, read by a model | Hermes kanban dispatcher | **Adapt** | The planner reads `description`, `tags`, a daemon-written `fit` and live `capacity`; no rule engine. ADR-024 §4 |
| Per-tool-call `PreToolUse` veto | Claude Code, Codex, Hermes `pre_tool_call` | **Reject** for host plugins | The agent runs in a VM with no host channel (ADR-017 §1, ADR-019 §7); the host sees tool calls after the fact (`agent.item`). It belongs in the agent-side plugin (ADR-018), later. ADR-023 §5.3 |
| Hooks that run arbitrary host shell on agent output | Claude Code `command` hooks | **Reject** | Checks come only from the operator (ADR-017 §2). ADR-023 §5.3 |
| Encapsulation contexts (a plugin's additions visible only to its subtree) | Fastify | **Adapt** | Not a general mechanism; the one place it matters is "profile-scoped plugins" (`lifecycle.onStart` names hooks for that profile only). ADR-024 §2.2 |
| Extension points owned by the plugin, modules fill them | Backstage | **Adapt** | Used for exactly three contracts: sandbox provider, agent provider, forge. Everything else is a hook. ADR-023 §4, §7 |
| Typed service refs / DI container | Backstage | **Reject** | capcomd is one process with one `host` object; a DI container is more than it needs. ADR-023 §4 |
| Multiplexing many profiles in one gateway process, bot-to-bot rooms | Hermes | **Reject** for now | capcomd agents already run in their own VMs and talk through the scope (messages, kv, board); nothing to add |
| Virtual-module `\0` prefix for host resources | Rollup | **Adapt** | capcomd already has reserved kv prefixes (`_`, `approval/`, `recipe/`, `handoff/`); `plugin/<name>/` joins them. ADR-023 §4 |
| Immutable plugin root vs durable data dir | Claude Code `PLUGIN_ROOT`/`PLUGIN_DATA` | **Adopt** | `~/.capcomd/plugins/<name>/` (code, replaced on update) and `~/.capcomd/state/plugins/<name>/` (data). ADR-023 §4 `host.storage` |
| Async observers with a concurrency cap | Codex `async: true` | **Adopt** | `observe` hooks never block the runner; a bounded queue. ADR-023 §9 |
