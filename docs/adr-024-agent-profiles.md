# ADR-024: Agent profiles v2, a composable unit on the plugin core

Status: **Accepted, spec in [docs/spec/plugin-api.md](spec/plugin-api.md)** (2026-11-04): the plugin core this builds on
is specified there (seams §7, `profile.resolved` and `agent.preparing` §6.6, `tools.mode` and the `jobs` block §16.1–16.2);
§9 below records the owner's decisions and the judgment calls the spec made on the profile side. Proposed 2026-11-04.
Builds on ADR-015 §6–7 (profiles and children policy), ADR-016 (primitives),
ADR-017 (sub-agents), ADR-019 (optional limits) and ADR-023 (the plugin core). Research:
[docs/research/plugin-architecture.md](research/plugin-architecture.md) §3 (Hermes profiles) and §5.

The ADR numbers the owner asked for (019, 020) were taken by the time this was written (agents report up, sandbox
providers), so this is 024 and the plugin core is 023.

## 1. Context

A capcomd profile today is one object in `.capcomd/agents.json` (schema `capcomd.agents/v1`, `src/agents/profiles.ts`
`AgentSpec`): a provider (`claude | codex`), exactly one auth mode, an optional model and effort, optional limits
(`maxTurns`, `maxBudgetUsd`, `timeoutMs`, the stuck windows), a Codex sandbox level, an egress list, a system prompt
and append, tool allow/deny lists, and a `children` block that caps spawning. `capcomd setup project` writes four of
them (`src/config/project-setup.ts` `planProject`: `worker` per agent, `reviewer`, `lead`, `planner`), the app shows
them as four kinds (`apps/menubar/app/Sources/CapcomdStore/Model.swift` `ProfileKind`: planner, lead, worker, critic,
other), the MCP driver reads them through `capcomd_profiles` (`abilityText`, `leadText`), and every spawn pins the
resolved spec on the agent record (`src/primitives/ops.ts` `spawnAgent` → `spec`, `pinSpec`), so the engine never needs
the file.

That is a good base: validation is strict (unknown fields refused), narrowing is enforced (`widenings()`), and the spec
travels with the agent. It is also narrow. A profile cannot say who the agent is (a persona, an avatar), what it knows
(skills, memory), which tools beyond the agent CLI's own it gets (MCP servers), where it runs (the profile can't pick a
sandbox or an environment image), how it is reviewed (approval kinds), or where it came from (no version, no source,
nothing to share or install). Composition is by hand: `lead` repeats `worker`'s settings because there is no `extends`.

Hermes (Nous Research's hermes-agent, read at `ed1afb0`) went the other way: a profile is a whole home directory
(`~/.hermes/profiles/<name>/`: `config.yaml`, `.env`, `SOUL.md`, `skills/`, `memories/`, `sessions/` and `state.db`,
`cron/`, `plugins/`, `hooks/`, `profile.yaml` metadata), selected with `hermes -p <name>` or a sticky
`active_profile` file, cloned as a one-time copy (`--clone`, `--clone-all`; "independent islands" afterwards, no
inheritance), exported and imported as a tarball with credentials stripped, and installed from a git repository as a
"distribution" whose `distribution.yaml` says which paths the distributor owns (`SOUL.md`, `config.yaml`, `skills`,
`cron`) and which the user owns (`memories`, `sessions`) so `profile update` replaces one and never the other
(research §3). Its orchestrator routes kanban tasks by each profile's `describe` text. The owner wants capcomd's
profiles to be first-class in that sense, while keeping what capcomd adds that Hermes doesn't have: a VM per agent,
narrow-only limits down a tree, and gates (Hermes is explicit that profiles are not sandboxes).

## 2. Decision

### 2.1 A profile is a package, resolved to a pinned spec

A **profile** is a directory (or a single YAML/JSON file for the small case) with a manifest and the files it refers
to. Resolving it produces exactly the thing the engine already understands: a flat, validated spec pinned on the agent
at spawn (`pinSpec`). So the engine, the policy (`src/primitives/policy.ts`), the runner and the pinning path do not
change shape; what changes is how the spec is written, composed, versioned and shown.

```
.capcomd/profiles/
  worker/profile.yaml
  reviewer/profile.yaml
  lead/profile.yaml                 # extends: worker
  planner/profile.yaml              # extends: lead
  security-critic/                  # an installed profile package
    profile.yaml
    SOUL.md
    skills/threat-model/SKILL.md
    LOCK                            # source, commit, content hash (written on install)
.capcomd/agents.json                # v1, still read; v2 wins on a name collision (§6)
~/.capcomd/profiles/<name>/         # the user's profiles, below the project's
```

### 2.2 The schema (`capcomd.profile/v2`)

Every block is optional except `name` and `harness.provider`/`harness.auth` (the two fields v1 requires). A block a
profile doesn't set is the harness default, exactly as unset limits mean none today (ADR-019).

```yaml
schema: capcomd.profile/v2
name: security-critic             # ^[a-z0-9][a-z0-9_-]{0,62}$, as today (lowercase stays: decided 2026-10-25)
version: 3                        # bumps on every edit; agents record name@version (harness-architecture.md §5.1)
extends: reviewer                 # one parent, by name; resolved before validation (§2.3)
description: Reviews a change for security regressions and reports a verdict.
tags: [review, security, read-only]   # what the planner matches on (§4)

identity:
  title: Security critic          # what the app shows; the agent's tab title still comes from title rules
  persona: SOUL.md                # a file next to the manifest; goes first in the system prompt (Hermes slot 1)
  avatar: { seed: security-critic }   # packages/bot-avatar input; absent: derived from the agent id as today

harness:
  provider: claude                # claude | codex | <a provider plugin's name> (ADR-023 §4.2)
  auth: subscription              # exactly one, as v1
  model: claude-opus-4-1
  effort: high
  cliVersion: ">=2.1"             # optional pin on the agent CLI the environment must have

prompt:
  system: null                    # replaces the CLI's system prompt (claude --system-prompt); rare
  append: prompt.md               # appended (claude --append-system-prompt; codex: appended to the prompt)

skills:
  - name: capcomd-orchestration   # bundled; only for profiles that may spawn (today's gating stays)
  - name: threat-model            # from this package's skills/ (hashed on install)
  - name: owasp-top-10
    source: user                  # ~/.claude/skills or ~/.capcomd/skills
    hash: sha256:…                # pinned; a changed hash raises a notice, never a silent change

tools:
  mode: execute                   # execute | orchestrate (spec §16.1): an orchestrate agent sees everything and runs
                                  # nothing: it reads any file, branch and history (read-only git, `capcomd fetch`)
                                  # and every capcomd report (logs, events, verify and merge results with their full
                                  # check output), routes, spawns and decides; it never edits, commits, merges,
                                  # pushes, installs, builds or runs tests (checks run at verify and merge). The agent
                                  # provider's tool policy enforces it in the sandbox (Claude Code: allow/deny lists;
                                  # Codex: command rules); the kernel refuses to land its ref and never pushes it
  allowed: [Read, Glob, Grep, LS, "Bash(git diff:*)", "Bash(bun test:*)"]
  disallowed: []
  mcp:                            # MCP servers the agent CLI gets inside the sandbox (ADR-023 §4.5 wires them)
    - name: semgrep
      command: [semgrep-mcp]
      trust: untrusted

memory:                           # superseded by ADR-025's `context` block (its D2), and read as an alias of it:
  scope: project                  # project → context.providers: [{name: memory, layers: [project, run]}]; none → [];
                                  # profile | user are refused (ADR-025 D15: those layers wait)
  files: [MEMORY.md]              # one file: the memory provider's index
  retain: 30d                     # every item kind's retention

sandbox:
  provider: docker                # a sandbox plugin's name (ADR-020/021 descriptor); absent: the run's, else the daemon's
  environment: default            # the env snapshot / image to boot from (capcomd env build --name)
  egress: [github.com, api.anthropic.com]   # as v1; absent: open (ADR-019 §7)
  codex: workspace-write          # v1 `sandbox` (codex --sandbox)
  size: { vcpu: 2 }

limits:                           # v1 names kept; all optional (ADR-019)
  maxTurns: 40
  maxBudgetUsd: 3
  timeoutMs: 1800000
  idleAfterMs: 1800000
  stuckRepeats: 8
  noChangeAfterMs: null

jobs:                             # background work (spec §16.2); all optional
  foregroundMs: 60000             # a command run through capcomd's in-VM job wrapper returns "started" after this;
                                  # default 5000 for tools.mode orchestrate, 60000 otherwise
  max: 8                          # running jobs per agent
  afterTurnMs: 1800000            # jobs are killed this long after the agent's last step, and when the agent ends

lifecycle:
  checkpointEveryMs: 600000
  onStart: []                     # plugins that must be active for this profile; they listen to agent.changed (spec §6.6.8)
  onEnd: [post-review-summary]

children:                         # v1 block, unchanged semantics (narrow-only)
  allowSpawn: false

permissions:
  report: true                    # may be spawned with --report (read-only, result is its final message)
                                  # (`approve` is deferred, decision 3 in §9: approvals stay human; not in the v1 schema)

sharing:
  source: github:acme/capcomd-profiles#security-critic   # written by `capcomd profiles install`
  license: MIT
```

What is new against v1, by block: `identity`, `skills`, `tools.mode`, `tools.mcp`, `memory`, `sandbox.provider|environment|size`,
`jobs`, `lifecycle.onStart|onEnd`, `permissions`, `sharing`, `version`, `extends`, `tags`. Everything in v1 has a home:
`provider/auth/model/effort` → `harness`; `systemPrompt/appendSystemPrompt` → `prompt`; `allowedTools/disallowedTools`
→ `tools`; `sandbox` (codex level) → `sandbox.codex`; `egress` → `sandbox.egress`; the limits and stuck windows →
`limits`; `checkpointEveryMs` → `lifecycle`; `children` and `description` keep their names.

**Judgment calls here:** the block names; putting `persona` under `identity` rather than `prompt` (it is who the
agent is, and the app shows it); `memory.scope` as an enum rather than a path (paths leak host layout into a
shareable file); `extends` at all (Hermes has none: a clone is a copy; capcomd's four setup profiles repeat each
other today, which is the case for it). **From the research:** a persona file first in the prompt (Hermes `SOUL.md`
is "identity slot #1" of its system prompt, `agent/prompt_builder.py`), skills and memory as parts of the profile
(Hermes), a per-profile plugin and MCP list (Hermes `plugins/`, `mcp_servers`), hashed pins on skills
(harness-architecture §8.4), one credential per profile (ADR-015), an installed persona scanned as untrusted (Hermes
treats a distribution-owned `SOUL.md` that way).

### 2.3 Inheritance and composition

- **`extends: <name>`**, one level at a time, any depth, no cycles. The child's blocks are merged onto the parent's:
  scalars replace, lists replace (not append; `skills` and `tools.allowed` are the two places a reader must see the
  whole list), maps merge one level. `null` removes a key, as `applyOverrides` already does for v1 overrides.
- **Narrowing is checked on the resolved spec, not the file.** Today `validateFile` checks that each
  `allowedChildProfiles` entry is no wider than its parent (`widenings`). That stays, on resolved specs. A profile
  that `extends` another may widen it (a lead is a worker that can also spawn) because `extends` is authoring, not
  delegation; only the parent → child spawn relation is narrow-only. This distinction is the main thing to get right
  in review.
- **Per-run and per-spawn overrides** keep today's mechanism: `--set k=v` and `--overrides` produce an `Overrides`
  that `applyOverrides` merges and checks (`profiles.ts`); the ref encoding `name;ov=…[;op=1]` is unchanged, so the
  planner → worker carry (`encodeAgentRef`/`decodeAgentRef`) needs no change. Keys use the v2 paths
  (`limits.maxTurns`), with the v1 names accepted as aliases for one release.
- **Project over user over bundled.** A name is looked up in the project's `.capcomd/profiles/`, then
  `~/.capcomd/profiles/`, then the profiles bundled with capcomd (the four `setup` writes, shipped as data so a project
  without an agents file still has `worker` and `planner`). The first hit wins; `capcomd profiles show <name>` says
  where it came from.

### 2.4 Versioning

- `version` is an integer the tooling bumps on every write (`capcomd profiles set`, the app, `PUT /v1/profiles/{name}`).
  A hand edit without a bump is detected by a content hash in `LOCK` (installed packages) or in the agents index (local
  ones) and treated as a bump with a notice.
- An agent records `profile: name`, `profileVersion`, and the resolved spec (the pin), so a run that outlives an edit
  shows what it actually ran with (`harness.v1` `Agent.profile`, `Agent.profileVersion`; both already planned in
  harness-architecture.md §5.1), and the layer the profile came from (`Agent.profileSource`). Done in §7 step 3.
- The schema id bumps only on a breaking change (`capcomd.profile/v3`); additions never bump. Unknown keys are refused,
  as today, except under `x-` (vendor extensions a plugin may read: `x-perfloop.gestures`).

### 2.5 Sharing and installing

- A profile package is a directory with `profile.yaml` and the files it names. It can live in any git repository;
  `capcomd profiles install <owner/repo>[#<name>][@<ref>]` copies it into `~/.capcomd/profiles/<name>/` (or
  `--project`), writes `LOCK` (source, commit, per-file sha256), and refuses a package whose manifest names a file
  outside its directory or any executable. **Profiles are data**: a `persona`, `prompt.append` and skills are text the
  agent reads; `tools.mcp` names a command the *sandbox* runs, never the host (ADR-017 §1); `lifecycle.onStart|onEnd`
  name hook plugins that must already be installed and enabled on the host (ADR-023 §6), so a profile can't smuggle code.
- `capcomd profiles export <name>` writes the package (resolved or with `extends` kept, `--flat`). Nothing from
  `~/.capcomd` state goes in it, and a profile never holds a credential (ADR-015: `auth` is a mode), so there is
  nothing to strip, unlike Hermes's export.
- `capcomd profiles update <name>` re-fetches at the locked source and replaces only the **package-owned** files
  (`profile.yaml`, `SOUL.md`, `prompt.md`, `skills/`); a project's `override.yaml` and the profile's memory (§2.2
  `memory`) are user-owned and never touched. A changed hash on a pinned skill or persona is shown before it is applied.
  **From the research:** Hermes's `distribution_owned` list is exactly this split; adopted as is.
- Discovery of shareable profiles uses the same marketplace files as the plugin (ADR-018 §1): a repository's
  `.claude-plugin/marketplace.json` may list `profiles` beside `plugins`. **Judgment call:** reuse the marketplace file
  rather than a new registry; cheap and already indexed by the agent platforms.

### 2.6 Per-project overrides

A project may **override** an installed or user profile without copying it: `.capcomd/profiles/<name>/override.yaml`
with the same schema and no `name`; it is applied last, as `extends` would be. This is how a project pins its own
`sandbox.environment` or `limits` on a shared `security-critic`. `capcomd profiles show` prints the three layers
(source, user override, project override) and the result.

## 3. How it is built on the plugin core (ADR-023)

- **Resolution is a core primitive**, `profiles.resolve(name, {project, overrides}) → PinnedSpec`, replacing the direct
  `readAgentsFile` calls in `resolveAgent`, `spawnChecks`, `reviewerSpec`, `plannerDriver` and `run-options.ts`. The
  pin keeps the v1 flat shape plus `profile {name, version, source}` so every consumer of `spec` in the scope actor and
  the runner is untouched.
- Profiles name **plugins by the names they register**: `harness.provider` is an agent-provider plugin
  (`claude`, `codex` are the built-ins), `sandbox.provider` is a sandbox plugin (`docker`, `boxd`), `tools.mcp[]` are
  MCP server declarations the sandbox-side runner wires (today only capcomd's own in-VM MCP is wired, `runner.ts`
  `capcomd?: {cli, mcpConfig}` in `AgentCommandCtx`), `lifecycle.onStart|onEnd` are hook plugins. Validation asks the
  core's registry whether each name exists and is enabled, so a profile for a provider that isn't installed fails at
  `validate`, not at spawn.
- The **`profile.resolved`** hook (ADR-023 §5, modify) lets a plugin adjust the resolved spec narrow-only (a cost
  plugin lowering `limits.maxBudgetUsd` for a project; PerfLoop attaching its skill to every `worker`). Widening from a
  hook is refused with the same `widenings()` message.
- **UI surfaces**: the app renders a profile from a descriptor the daemon serves (`GET /v1/profiles/{name}` with
  `fields[]` typed like the sandbox settings rows of ADR-021, each with `editable` and `source`), so a new block or a
  plugin's `x-` fields show up without a Swift release, as ADR-021 did for places.

## 4. How the planner chooses profiles

The planner (a Claude Code or Codex session driving `capcomd mcp`, or the `planner` profile in its VM) chooses by
reading, not by magic. Today `capcomd_profiles` returns `{name, provider, auth, model, canSpawn, canLead, ready, does}`
(`src/cli/commands/profiles.ts` `list`, `abilityText`), and the orchestration skill says "any profile whose entry has
`canLead` can lead". v2 adds, per profile:

- `tags` and `description` as written;
- `fit`: a sentence the daemon writes from structured fields ("read-only; reviews; Claude, high effort; can't spawn"),
  never agent text;
- `capacity`: how many of this profile can run at once right now (from `src/providers/capacity.ts` and the login
  quota ledger), so the planner sizes fan-out from facts (the team-shape eval in DEVELOPMENT.md measures exactly this);
- `cost`: the model's list price tier (`low | medium | high`), so a planner can pick the cheap worker for mechanical
  parts.

`children.allowedChildProfiles` stays the hard rule: the planner may only spawn what its own profile allows, narrowed
by its ancestors (`childLimits`). A planner that wants a profile outside that list is refused today and stays refused.

**Judgment call:** no automatic matching of tags to tasks in the daemon. The planner is a model; give it the facts and
the orchestration skill's guidance, and measure with the eval. A matcher would be a plugin later if the eval shows a gap.
**From the research:** Hermes's kanban dispatcher routes tasks on each profile's `describe` text (an
auto-generated description, `hermes_cli/profile_describer.py`), which is the same bet: a good description, read by a
model, beats a rule engine. `fit` is capcomd's daemon-written equivalent, so it can't be poisoned by a shared package.

## 5. How the app and the CLI show and edit profiles

- **CLI.** `capcomd profiles list|show|add|set|rm|validate|schema` replaces `capcomd agents …` (kept as an alias for one
  minor release, printing the new name). `show` prints the three layers and the resolved spec with the source of every
  value. `add` takes `--extends`, `--from <owner/repo#name>` and the v2 flags (`--skill`, `--tag`, `--persona FILE`,
  `--memory project`, `--sandbox-provider docker`). `--json` keeps the `capcomd.cli/v1` envelope.
- **API.** `GET /v1/profiles`, `GET/PUT/DELETE /v1/profiles/{name}` (the `configure` scope for writes, as project setup
  has), `POST /v1/profiles/install`, each with `Idempotency-Key`. A write is a `profile.changed` event on the `daemon`
  stream (entity `profile:<name>`, text daemon-written: "Profile reviewer changed: limits.maxTurns 20 → 40."). This is
  capability `profiles` in `/v1/health`.
- **App.** Settings › Crew (the owner's word for the team) lists profiles grouped by project, each with its avatar,
  title, provider mark, tags and readiness (login present, environment built, sandbox up), with the resolved values
  and their source on the details screen (the ADR-021 settings-row pattern). Editing writes through `PUT`. The run
  setup sheet's driver picker keeps using `GET /v1/run-options` (`src/api/run-options.ts`), which now also lists every
  profile that can plan, not only the one named `planner`.
- **In a run.** `agent.spawned` carries `profile`, `profileVersion` and the avatar seed, so a bot's face is stable
  across runs of the same profile (bot-avatar memory: "agent id + role + size → SVG"; the seed becomes the profile's
  when it sets one).

## 6. Mapping today's profiles onto v2

| v1 (`.capcomd/agents.json`) | v2 | Notes |
|---|---|---|
| `provider`, `auth`, `model`, `effort` | `harness.*` | same values; `provider` may now be a plugin name |
| `description` | `description` | |
| `systemPrompt`, `appendSystemPrompt` | `prompt.system`, `prompt.append` | may be a file name in a package |
| `allowedTools`, `disallowedTools` | `tools.allowed`, `tools.disallowed` | |
| `sandbox` (codex level) | `sandbox.codex` | |
| `egress` | `sandbox.egress` | |
| `maxTurns`, `maxBudgetUsd`, `timeoutMs`, `idleAfterMs`, `stuckRepeats`, `noChangeAfterMs` | `limits.*` | |
| `checkpointEveryMs` | `lifecycle.checkpointEveryMs` | |
| `children` | `children` | unchanged |
| `default` (file level) | `default: true` on one profile, or the project config's `run.profile` | |
| (none) | `identity`, `skills`, `tools.mcp`, `memory`, `sandbox.provider/environment/size`, `lifecycle.onStart/onEnd`, `permissions`, `sharing`, `version`, `extends`, `tags` | new |

The four profiles `capcomd setup project` writes become: `worker` (harness + nothing else), `reviewer` (`extends:
worker`, read-only tools from `testTools()`, `permissions.report: true`, tag `review`), `lead` (`extends: worker`,
`children` as today), `planner` (`extends: lead`, `children.allowedChildProfiles: [worker, lead]`, tag `plan`). The
app's `ProfileKind` keeps working: it reads the name; v2 adds `tags` so a `security-critic` can render as a critic
without being named `critic`.

`agents.json` v1 keeps being read. The loader converts each v1 entry to a v2 spec in memory; `capcomd profiles migrate`
writes the directory form and leaves the file in place with a comment. A name in both places: the v2 directory wins and
`validate` warns.

## 7. Migration plan

Each step ships alone, with tests, and leaves every existing test green.

1. **Loader and schema** (`src/agents/profiles.ts` → `src/profiles/`): parse v2 YAML/JSON, `extends`, overrides,
   layers, resolution to the v1 flat pin; `validateFile` runs on resolved specs. Tests: `tests/agents/profiles.test.ts`
   grows golden resolutions (a package, a user override, a project override, a cycle, a widening child, a `null`
   removal). No behaviour change for v1 files (the existing suite is the regression gate).
2. **`capcomd profiles` CLI and `GET /v1/profiles`** (read-only), with `show` printing sources. `capcomd agents` becomes
   an alias. Tests: `tests/cli`, `tests/api/contract.test.ts` (new capability `profiles`), the generated
   `docs/harness-contract.md`.
3. **Pin the version**: `agent.spawned` and `Agent` carry `profileVersion` and `source` (named `profileSource`, §9). Tests:
   `tests/scenarios/contract.test.ts`, `tests/api/agent-provider.test.ts`.
4. **New blocks that need no new runtime**: `identity.title`, `tags`, `prompt.*` as files, `permissions.report`,
   `sharing`. `capcomd_profiles` returns `tags`, `fit`, `capacity`, `cost`. Test: `scripts/eval-team-shape.ts` before and
   after (DEVELOPMENT.md), to see the planner's choices move or hold.
5. **Skills in the profile**: resolved and sent the way `send --skill` sends them today (`src/agents/skills.ts`
   `withSkills`), pinned by hash, at the agent's start. Tests: `tests/api/steer-skills-agent-pause.test.ts` pattern, a
   scenario that asserts the prompt file has the skill once.
6. **Writes**: `PUT /v1/profiles/{name}`, `capcomd profiles set`, `profile.changed` events, the app's Crew screen.
   Tests: `tests/api` idempotency and scope tests as for `PATCH /v1/sandboxes`.
7. **Install/export/update** with `LOCK`. Tests: a local git fixture repository (the `tests/merge/gitfixture.ts`
   pattern), a package that names a file outside its directory is refused, a hash change is reported.
8. **`memory`, `tools.mcp`, `sandbox.provider|environment|size`, `lifecycle.onStart|onEnd`**: each needs the plugin
   core's hook or wiring (ADR-023 §4.5, §5) and ships after that step of ADR-023 lands. Tests: the scenarios suite with
   scripted agents (`CAPCOMD_SPAWN_EXEC=script`), one per block. `memory` isn't built here: ADR-025 D2 folds it into
   `context`, whose steps build it (it stays read as `context`'s alias). Done for the others (2026-11-06; §9, "Made while
   building the runtime blocks").
9. **`capcomd profiles migrate`** and the `setup project` templates in v2 form; `agents.json` v1 stays readable for two
   minor releases, then `validate` warns and a later release stops reading it (breaking, changelog).

## 8. Risks

- **Two sources of truth during the overlap.** Mitigated by "directory wins, validate warns", and by `show` printing
  where every value came from.
- **A shareable file that references host state** (`sandbox.environment`, `memory`). Names, not paths; a missing
  environment is warned about by `capcomd profiles validate` and refused at spawn (`reason: environment`, §9), not left
  to the provider's boot error; showing it as readiness before the run (`GET /v1/run-options`) is still to do.
- **Persona text is prompt text.** An installed persona is as trusted as an installed skill: shown by hash, trusted once
  per hash (decision 4 below).
- A profile may later set `harness.provider` to a model-API provider without an agent CLI: an agent seam
  implementation may supply its own runner parts (spec §7.3); not in this version.

## 9. Decisions

Decided by the owner on 2026-11-04:

3. **`permissions.approve` is deferred.** Approvals stay human. It is out of the v1 schema; adding it later is a new
   optional block, which never bumps the schema id (§2.4), and a `policy.ts` rule on the `agent` principal, which the
   plugin core does not touch (spec §11.1).
4. **Profile packages are YAML** (`profile.yaml`; JSON stays accepted). **`extends` cannot cross projects**: a parent is
   found in the same project, the user's profiles or the bundled ones, never in another project's. **A project's skills
   and personas get a one-time trust prompt per content hash** (`capcomd profiles trust`, the same mechanism as a
   project plugin's, spec §4.8).

Made while building the loader (§7 step 1, 2026-11-05; `src/profiles/load.ts`, `src/profiles/v2.ts`):

- **The project's layer is the `profiles/` directory next to the agents file** (`.capcomd/agents.json` →
  `.capcomd/profiles/`), so `CAPCOMD_AGENTS_FILE`, which a run already carries to the daemon, carries it too; a project
  with only `.capcomd/profiles/` counts as having profiles (`defaultAgentsFile`, and a run the daemon starts for it,
  `POST /v1/runs` with `repo`). The user's layer is
  `~/.capcomd/profiles/` (`$CAPCOMD_HOME/profiles`); when the agents file is the user's, there is no project layer.
- **`agents.json` entries are profiles of the layer their file is in**; there a `profile.yaml` of the same name wins
  (with a warning), and a v2 profile may `extends` a v1 entry. With no v2 file anywhere, the result is exactly the v1
  file.
- **`extends` is looked up like any name** (project, user, bundled), so a profile extending its own name is a cycle;
  the parent comes with its own overrides applied. `name`, `version`, `default` and `sharing` are not inherited (nor,
  since step 4, `identity.title` and `identity.avatar`).
- **Overrides apply from the profile's own layer upward**: a bundled profile gets the user's, then the project's
  `override.yaml`; a user profile the user's, then the project's; a user override of a name the project defines itself
  doesn't apply (a warning). An override may not set `name`, `extends`, `version` or `sharing`.
- **A `prompt.system` or `prompt.append` that is one word ending `.md` or `.txt` names a file** in the profile's
  directory, read at resolution (step 4's "prompt.* as files", pulled forward: the pin already has a home for the
  text); a name outside the directory (`..`, absolute, a symlink out of it) or in a single-file profile is refused. A
  manifest that doesn't parse is reported by line and column, never by its text (the error can reach an agent that
  asked for a spawn, and the file may be a link to anything on the host).
- **`default: true`**: the highest layer's wins, two in that layer are an error, and it beats `agents.json`'s `default`
  in the same layer.
- **Blocks with no runtime yet** (`identity.persona`, `harness.cliVersion`; `permissions.report` until step 4, `skills`
  until step 5, `context` until ADR-025 step 1, below, `tools.mcp`, `sandbox.provider|environment|size` and
  `lifecycle.onStart|onEnd` until step 8) are checked and kept on the resolved profile, not pinned (`jobs` is pinned as
  is since the jobs service, spec §17.2 step 7); `capcomd profiles validate` names the ones a profile sets.
  `sandbox.provider` is checked against the active sandbox seams.
- **The bundled layer is empty** until step 9: `capcomd setup project` still writes its four profiles into
  `agents.json`, and shipping them as data now would make names that are unknown today resolve.
- **`context` (and `memory`, read as it) has a runtime since ADR-025 step 1**: it is pinned with the flat spec
  (`AgentSpec.context`, a field an `agents.json` entry may hold too), its provider names are checked against the active
  context providers when profiles are read, and an override may remove it but never change it. The behaviour change
  from §2.2: the memory directory is no longer mounted read/write and written back by the agent; it is the repository's
  `.capcomd/context/`, read at the run's target and changed by reviewed commits (ADR-025 §4, D2).

Made while building the CLI and `GET /v1/profiles` (§7 step 2, 2026-11-05; `src/cli/commands/profiles.ts`,
`src/api/profiles.ts`, `src/profiles/describe.ts`):

- **`capcomd agents` is the same command under its old name**: it prints the new name on stderr (not with `--json`,
  whose stdout is a reader's), and keeps the two outputs that would otherwise change under a script: `agents list
  --json` lists its rows under `agents` (`profiles list --json` under `profiles`), and `agents schema` prints the
  `agents.json` schema. `profiles schema` prints a profile file's (`capcomd.profile/v2`), `profiles schema v1`
  `agents.json`'s. `add`, `set` and `rm` still edit only `agents.json` until step 6.
- **`show` numbers the files laid together and gives each value the number of the file that set it** (§2.6's "the
  three layers and the result"). The loader records it as it lays the files (`ResolvedProfile.setBy`, by v2 path,
  one level deep as `layerOver` merges); what a child removes with `null` is no file's, and what isn't inherited
  (`name`, `version`, `default`, `sharing`) is the child's own or nobody's. `--json` carries `applied` and
  `values: [{path, value, from}]`.
- **`GET /v1/profiles` takes `repo`** as `GET /v1/run-options` does (a project's profiles, as `POST /v1/runs` with that
  `repo` resolves them; 422 when it isn't a project). **Profiles that can't be read are a 200 with `error`** (every
  problem, as `validate` says it) and no rows, not a 422: the request was right, the files are wrong, and the app shows
  why where the list would be. A row's `description` is marked untrusted (a project's profile files are in its
  repository, which agents change); `does` and `canLead` are daemon-written; no prompt text and no credential is
  served. A layer is a string, not an enum, so step 7's `installed` adds no breaking value. `ready` is the login
  for the daemon's own sandbox, as `capcomd profiles list` says it; `GET /v1/logins` has every sandbox's.
- **`GET /v1/profiles/{name}` waits for step 6**: §3's descriptor (`fields[]` with `editable` and `source`, the
  ADR-021 rows) is what the Crew screen edits through `PUT`, so it ships with the writes; until then a row's `applied`
  says where a profile came from, and `capcomd profiles show` where each value did.

Made while pinning the version (§7 step 3, 2026-11-05; `src/actors/scope.ts`, `src/api/contract.ts`):

- **The field is `profileSource`, not `source`**, on `Agent` and on `agent.spawned`: a bare `source` next to `profile`,
  `provider` and `workspace` doesn't say whose source it is. Its values are the layers (`project`, `user`, `bundled`;
  more may be added, so a client shows an unknown one as it is). `profile.resolved` keeps `profile.source`.
- **Both are optional and nullable**: absent from older daemons, null for an agent without a profile (a fake one, or
  `CAPCOMD_AGENT` naming a provider) and for an agent spawned before they were recorded. An `agents.json` profile is
  version 1.
- **Fixed at the first spawn**: the scope stores them with the agent (two columns beside the pinned spec), outside the
  spawn's params hash, so a keyed retry after an edit is the same spawn and keeps the version it was first recorded
  with. The spec pin itself (what the agent runs with) is unchanged; the version says which profile text produced it.
- **Where they show**: `Agent` (`GET /v1/runs/{runId}/agents`, `snapshot.agents`), `agent.spawned`, the plugin API's
  `Agent` and `agent.preparing`'s `spec.profile`, and the CLI's `spawn`/`inspect`/`await --json` and the `inspect` line
  (`[worker v3, project]`). The tree (`capcomd tree`) doesn't carry them.

Made while building the blocks with no new runtime (§7 step 4, 2026-11-05; `src/profiles/describe.ts`):

- **`permissions.report: false` refuses a spawn with `report`** (`reason: report_not_allowed`), checked on the host
  where every spawn is (`ops.spawnAgent`, after `profile.resolved`), not pinned. Unset means allowed, as before any
  profile could say: `true` changes nothing at spawn and says, in `fit`, that the profile answers with a report.
- **`identity.title` and `identity.avatar` are not inherited**, like `name`: a `lead` that extends `worker` would
  otherwise show as "Worker" with worker's face. `identity.persona` and `tags` are inherited (a child of `reviewer` is
  a reviewer until it says otherwise).
- **`fit` is built from the resolved spec and `permissions` only**: what the tools allow (orchestrate, read-only,
  edits; a plain `Bash` isn't read-only, `Bash(<cmd>:*)` rules are, as `does` says), report, provider label, model,
  effort, cost, limits, an egress allowlist's size, whether it leads (`leadText`). No `description`,
  `tags`, `title` or `sharing` goes into it, so a shared package can't word it.
- **`cost` is a tier by model family** (Haiku, `-mini`, `-nano`: low; Sonnet, GPT, `o<N>`: medium; Opus, `-pro`:
  high), null when the profile leaves the model to the CLI or names one outside those families. No price table is
  kept: list prices change, the relative tiers rarely do.
- **`capacity` is the sandbox's slots, shared by every profile** (`placeCapacity` of the project's configured
  sandbox, as `capcomd_setup` reports it), or 0 with `waitsUntil` while the profile's login is in the quota ledger;
  readiness (a missing login) stays in `ready`/`detail`, not in `capacity`. Only `capcomd_profiles` reports it:
  `capcomd profiles list` also runs in an agent's VM, which can't see the host's sandbox.
- **`prompt.*` as files** shipped with step 1 (above).

Made while building skills in the profile (§7 step 5, 2026-11-06; `src/profiles/skills.ts`, spec §6.6.7):

- **`source` is `package`, `user` or `bundled`.** `package` is the profile's `skills/<name>/SKILL.md`, looked up in the
  nearest directory that has it: an `override.yaml`'s, the profile's own, then each ancestor's (a child that extends a
  package uses its parent's skills unless it has its own); `user` is `~/.claude/skills`, read as `capcomd send
  --skill` reads it (`src/agents/skills.ts`); `bundled` is capcomd's. **Unset is `package`, then `bundled`, never
  `user`**: a profile shared in a repository must not quietly depend on what each user has installed. `~/.capcomd/skills`
  (§2.2's comment) isn't read: `send --skill` doesn't read it either, and one list of a user's skills is simpler.
- **Skills are read when the profile resolves and pinned at spawn**: the agent's spec records `{name, hash, source}`
  and the run keeps each text (the scope's content-addressed attachments, in the spawn's transaction), so the process
  that prepares the agent (the daemon, a driver) needs no access to the project's files, and a retried or resumed
  agent gets exactly what it was spawned with. The text never goes into the spec or the `agent.spawned` event (up to
  256 KB per agent). A skill missing or changed at preparation fails the attempt (`config`) rather than run without it.
- **A missing, empty, too big or changed (against `hash:`) skill makes the profile invalid**, like any other error in
  it, so `validate` names it and a spawn of any profile is refused until it is fixed; a warning instead would start
  agents without the skill their profile promises.
- **`capcomd-orchestration` stays the kernel's** (one mechanism, `agent.preparing`): a profile that may spawn may name
  it and the built-in `skill-orchestration` plugin attaches it, written for the agent, so the agent gets it once; it is
  never pinned (its text depends on the agent's limits, budget and goal branch), so a `hash` on it is refused, and so
  is naming it in a profile that can't spawn ("today's gating stays"). A profile that may spawn keeps one of the 8
  skills and 32 KB for it.
- **The agent reads each skill in a `<skill name="…">` block**, the profile's after its `prompt.append` and before the
  plugins' (`skillBlock`, the same as a message's skills): every skill an agent gets reads the same way, the
  orchestration skill included.
- **The trust prompt for a project's skills (decision 4) waits for step 7** (`capcomd profiles trust`, with the plugin
  trust mechanism, spec §4.8, which isn't built yet). Until then a project's skills are used as its `prompt.append`
  and `agents.json` prompts always were: as text the project supplies.
Made while building the runtime blocks (§7 step 8, 2026-11-06; `src/profiles/runtime.ts`, `src/plugins/lifecycle.ts`,
`src/env/resolve.ts` `bootSnapshot`):

- **Pinned beside the flat spec, not in it.** `tools.mcp`, `sandbox.provider|environment|size` and `lifecycle` are read
  from the resolved manifest (`ResolvedProfile.runtime`) and recorded on the agent's spec at spawn as `mcp`,
  `sandboxProvider`, `environment`, `size` and `lifecycle` (`PinnedSpec`, additive), so the daemon runs what was
  resolved. They aren't `AgentSpec` fields: `agents.json` (v1) has none of them, and no `--set`, `--overrides`, `;ov=`
  ref or `profile.resolved` patch reaches them (refused as unknown fields). A parent can't add an MCP server to its
  child, move it to another sandbox (`fake-host` is this host), give it another image or drop the plugin that must hear
  it; narrowing them would need a rule each, and nothing asks for one yet.
- **`tools.mcp`**: each server is started by the agent's CLI in its sandbox. Claude Code gets one `--mcp-config` file
  with the profile's servers and capcomd's own (when the agent may spawn), Codex `-c mcp_servers.<name>.command|args`.
  `trust` (default `untrusted`) is whether its tools are approved up front: `trusted` adds `mcp__<name>` to a Claude
  Code allowlist and sets Codex's `default_tools_approval_mode="approve"`, as capcomd's own server has; `untrusted`
  leaves them to the profile's tool rules (no allowlist is every tool, as for every other tool). `capcomd` is
  reserved. **An orchestrate profile can't have servers** (spec §16.1: it runs nothing, and a server is a program its
  sandbox runs). A program the sandbox doesn't have is the CLI's to report; the runner logs it first. Nothing is
  installed for a server: its environment must have it.
- **`sandbox.provider` wins over the run's sandbox** for that profile's agents (§2.2 "absent: the run's, else the
  daemon's"): the machine is made, run, pushed from and destroyed there (`providerForAgent`, recorded on the worker as
  its `sandbox`, which `capcomd sandbox shell` and the drain read), its idle lifetime is that place's current setting (a
  run records its own place's), and its slot is that place's. A run's checks stay on the run's sandbox. **It never
  takes an agent out of isolation**: a sandbox that runs its agents on this host (`isolation: host`, the test fakes) is
  refused at spawn (`reason: sandbox_isolation`) unless the run's own sandbox is one too, since a profile is data
  (§2.5) and its agent's commands and MCP servers run in a sandbox, never on the host.
- **`sandbox.environment` names an environment of the agent's sandbox**: `default` (or unset) is the current build, as
  for every agent; `image` is the provider's plain image (the CLI is installed at start, as `CAPCOMD_ENV=image`); any
  other name is a build in that sandbox's env ledger (`capcomd env status`), by its name. `capcomd env build --name`
  isn't built: a build's content is its pins and the project's lockfile, so a second name for the same content would
  pin nothing a build's own name doesn't. A plan login kept in an image wins (the agent boots from one image), so a
  named environment must be the one the login's image was made from; otherwise the spawn is refused. A scripted or fake
  agent boots a named environment too (it is the profile's machine), and `default` as before (none). A missing one is
  refused at spawn (`reason: environment`) and warned about by `validate`, not left to the provider's boot error.
- **`sandbox.size` is `VmSpec.size`**, which boxd applies; Docker doesn't (containers share the host's CPUs, and `--cpus`
  above the Docker host's count fails the start). `sandbox.ensuring` may still lower it.
- **`lifecycle.onStart|onEnd` is a guarantee and a field.** The kernel refuses a spawn (`reason: lifecycle_inactive`)
  and an agent's start (its claim, before its machine) while a named plugin isn't active and listening to
  `agent.changed`: in the daemon its own host says, in the CLI or a run's driver the running daemon's listing (no daemon
  running: nobody to ask, the daemon asks at the start). `agent.changed` carries `lifecycle: {onStart, onEnd}` when the
  agent's profile names any, so a plugin filters on its own name instead of keeping a list of profiles. The two lists
  differ only in what they say to a reader (the plugin cares about the start, or the end); the kernel treats them alike.
  `validate` reports a plugin the running daemon doesn't have as an error (spec §7.1's rule for seams), and as a
  warning when no daemon runs.

Judgment calls made in the spec on the profile side (spec §16.1–16.2; reasons in ADR-023 §10):

| Decision | Spec |
|---|---|
| **`tools.mode: execute \| orchestrate`**: the planner never executes, as a profile capability: it sees everything (read-only git with fetch, files, every capcomd read) and runs nothing (no edits, commits, merges, pushes, installs, builds or tests). The agent provider's `describe().toolPolicies.orchestrate` gives the CLI's tool lists (and, for a CLI with command rules of its own, `denyCommands`); `children.allowSpawn` must be true; the kernel refuses `verify`/`merge` of the agent's own ref and skips its push; `planner` and `lead` from `capcomd setup project` get it; `plannerBrief`'s "don't change files yourself" stays as explanation | §16.1 |
| **A `jobs` block** (`foregroundMs`, `max`, `afterTurnMs`) with `foregroundMs` defaulting to 5 000 for orchestrate agents and 60 000 otherwise | §16.2 |
| **`lifecycle.onStart`/`onEnd` name plugins that must be active**, which listen to `agent.changed` for that profile; there is no per-profile hook | §6.6.8 |
| **`harness.provider` and `sandbox.provider` are seam names**, validated against the active plugins at `validate` | §7.1 |
| **`identity.persona` and `skills` reach the prompt through `agent.preparing`**, the one place a plugin adds prompt text | §6.6.7 |
| **`profile.resolved` patches are narrow-only through `widenings()`**, and must be pure (it fires on every resolution) | §6.6.5 |
