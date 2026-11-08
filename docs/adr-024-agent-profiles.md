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
  in review. The `jobs` block is limits like `limits` (spec §16.2 rule 2): an override or a `profile.resolved` patch
  may lower `max`, `foregroundMs` or `afterTurnMs` (`--set jobs.max=2` keeps the block's other values), never raise
  one the profile sets or unset it; a spawned profile is held to its spawner's `max` and `afterTurnMs`, while its
  `foregroundMs` is its own, as its tool mode is (an orchestrate planner waits 5 s, its workers 60 s). A job's own
  `timeoutMs` (`capcomd job start --timeout-ms`) is at most an `afterTurnMs` the profile sets, so a start can't lift
  that limit either.
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
  ones) and treated as a bump with a notice. (Step 6 bumps on writes and catches a hand edit between a read and a
  write by the profile's `rev`; the recorded hash waits for step 7's `LOCK`: §9.)
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
  `memory`) are user-owned and never touched. So is any file the user added in the package's directory (one its `LOCK`
  doesn't list): kept and reported as kept, and a new package file in its place is a conflict (spec 1.0.45; before, the
  update replaced the whole directory but the override). A changed hash on a pinned skill or persona is shown before
  it is applied.
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
  profile that can plan, not only the one named `planner` (`planners`, each with its readiness; done 2026-11-07, spec
  1.0.47). `GET /v1/profiles` rows carry what §4 gives the planner (`title`, `fit`, `cost`, `canReport`) and the
  skills each is pinned with and their trust (`untrustedSkills`), so the app and a planner see that a spawn would wait
  on the operator's trust before it is refused.
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
   Tests: `tests/api` idempotency and scope tests as for `PATCH /v1/sandboxes`. Done but the Crew screen, which has no
   approved design yet (§9, "Made while building the writes").
7. **Install/export/update** with `LOCK`. Tests: a local git fixture repository (the `tests/merge/gitfixture.ts`
   pattern), a package that names a file outside its directory is refused, a hash change is reported. Done, with the
   trust prompt for a project's skills (decision 4) (2026-11-06; §9, "Made while building install, export and update").
8. **`memory`, `tools.mcp`, `sandbox.provider|environment|size`, `lifecycle.onStart|onEnd`**: each needs the plugin
   core's hook or wiring (ADR-023 §4.5, §5) and ships after that step of ADR-023 lands. Tests: the scenarios suite with
   scripted agents (`CAPCOMD_SPAWN_EXEC=script`), one per block. `memory` isn't built here: ADR-025 D2 folds it into
   `context`, whose steps build it (it stays read as `context`'s alias). Done for the others (2026-11-06; §9, "Made while
   building the runtime blocks").
9. **`capcomd profiles migrate`** and the `setup project` templates in v2 form; `agents.json` v1 stays readable for two
   minor releases, then `validate` warns and a later release stops reading it (breaking, changelog). Done for migrate,
   the templates and the deprecation notice (2026-11-06; §9, "Made while building migrate and the templates"); the
   warning and the end of reading are later releases'.

## 8. Risks

- **Two sources of truth during the overlap.** Mitigated by "directory wins, validate warns", and by `show` printing
  where every value came from.
- **A shareable file that references host state** (`sandbox.environment`, `memory`). Names, not paths; a missing
  environment is warned about by `capcomd profiles validate` and refused at spawn (`reason: environment`, §9), not left
  to the provider's boot error; and shown before the run: `GET /v1/run-options` `planners` says a planner whose
  environment isn't built (or whose `lifecycle` plugin isn't active) isn't ready, and why (2026-11-07, spec 1.0.47).
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
- **Blocks with no runtime yet** (`identity.persona` and `harness.cliVersion` until 2026-11-08, below;
  `permissions.report` until step 4, `skills` until step 5, `context` until ADR-025 step 1, below, `tools.mcp`, `sandbox.provider|environment|size` and
  `lifecycle.onStart|onEnd` until step 8) are checked and kept on the resolved profile, not pinned (`jobs` is pinned as
  is since the jobs service, spec §17.2 step 7); `capcomd profiles validate` names the ones a profile sets.
  `sandbox.provider` is checked against the active sandbox seams.
- **The bundled layer is empty** until step 9: `capcomd setup project` still writes its four profiles into
  `agents.json`, and shipping them as data now would make names that are unknown today resolve. (Step 9 kept it
  empty: below.)
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
  `agents.json`'s. `add`, `set` and `rm` still edit only `agents.json` until step 6 (which changed that: below).
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
- **`GET /v1/profiles/{name}` waits for step 6** (shipped there: below): §3's descriptor (`fields[]` with `editable` and `source`, the
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
  where every spawn is (`ops.spawnAgent`, after `profile.resolved`, and again after `agent.spawning` so a `report` a
  plugin adds is refused too), not pinned. Unset means allowed, as before any profile could say: `true` changes nothing
  at spawn and says, in `fit`, that the profile answers with a report.
- **`identity.title` and `identity.avatar` are not inherited**, like `name`: a `lead` that extends `worker` would
  otherwise show as "Worker" with worker's face. `identity.persona` and `tags` are inherited (a child of `reviewer` is
  a reviewer until it says otherwise).
- **`fit` is built from the resolved spec and `permissions` only**: what the tools allow (orchestrate, read-only,
  edits; a plain `Bash`, or a rule starting with a wildcard (`Bash(* *)`), isn't read-only, `Bash(<cmd>:*)` rules
  are, as `does` says; read-only is what the provider
  applies, `src/profiles/v1.ts` `readOnlySpec`: Claude Code's tool allow-list, Codex's `sandbox.codex: read-only`
  since it has no per-tool allow-list, never for a provider capcomd doesn't know), report, provider label, model,
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
  trust mechanism, spec §4.8; built there: below). Until then a project's skills are used as its `prompt.append` and
  `agents.json` prompts always were: as text the project supplies. The mechanism landed with the plugin core's step 12 (spec 1.0.31) as
  `src/install/`, for step 7 to reuse: `source.ts` parses `<owner/repo>[#<name>][@<ref>]`, `fetch.ts` fetches a package
  directory out of a commit through the host's repo (`pick` chooses it, here by `profile.yaml`), `lock.ts` writes and
  checks `LOCK` (`kind: "profile"`, every file's sha256 and mode, the content hash) and `diffTrees` is what `update`
  shows before it applies, and `trust.ts` keeps trust per content hash and place (`kind: "profile"` beside the
  plugins'); `src/plugins/install.ts` is how the plugins use them.

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
  sandbox runs), nor an agent that an override makes orchestrate (refused at spawn, `reason: orchestrate_mcp`). A
  program the sandbox doesn't have is the CLI's to report; the runner logs it first. Nothing is installed for a server:
  its environment must have it.
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
- **`harness.provider` and `sandbox.provider` are checked the same way** (spec 1.0.49, 2026-11-07;
  `src/plugins/snapshot.ts` `seamPresence`): a seam only the daemon loads made every resolution in the CLI fail,
  `capcomd profiles list` included, so outside the daemon a name is a built-in or one the running daemon lists from an
  active, enabled plugin; any other is an error while a daemon runs and a warning (from every reader of profiles, not
  only `validate`) when none does, and the daemon checks it when it resolves the profile. A candidate checked before
  it is written and an override, which have nowhere to put a warning, still need one this process or the daemon has;
  so does a write (`profiles add|set|rm`, `src/profiles/write.ts` `checked`) that leaves a profile naming one it didn't
  name before (a typo is caught where it is made), while one a profile already names doesn't stop a change to
  something else. `validate` looks for a `sandbox.environment` only in a sandbox this process has: one only the
  daemon's plugins provide keeps its environments there, and a spawn checks it.

Made while building the writes (§7 step 6, 2026-11-06; `src/profiles/write.ts`, `src/profiles/fields.ts`,
`src/api/profiles.ts`):

- **A write changes the profile's own file and nothing else**: its `profile.yaml`, `<name>.yaml` or `agents.json`
  entry, never an ancestor it `extends` (a change there is every child's) or an `override.yaml` (the user's or the
  project's own). A value a later file sets is refused (`editable: false` on its row, and from `capcomd profiles set`),
  because writing it would change a file and not the profile. `null` (`--unset`) removes the profile's own value, so
  an inherited one shows again; removing an inherited value outright (`key: null` in the file) is for the file.
- **Checked before anything is written**: the loader reads through an overlay of the files as the write would leave
  them (`readProfiles(…, overlay)`), so a write that would make any profile unreadable (a value out of range, a child
  wider than its parent, an orphaned `extends`) is refused with `validate`'s message and the disk is untouched. Files
  are written whole (a temporary file renamed over).
- **`version` is the file's own and goes up by one on a write that changed something** (a write that sets what is
  there writes nothing). An `agents.json` entry has no `version` (its schema has none) and stays 1 until it moves to a
  profile file (step 9's `migrate`). A profile that extends an edited one keeps its version: its pin and `rev` change,
  its version doesn't. **No content hash is recorded next to an agent's `profile_version`** (the question step 3 left):
  the API's `rev` (a hash of the files laid together, hand edits included) stops a write made from a stale read, and a
  hash per file arrives with step 7's `LOCK`, where §2.4's notice belongs.
- **YAML is edited in place** (the `yaml` document model): comments and layout stay; a scalar replaced by a scalar
  keeps its comment; a new `version` goes right after `name`. A JSON profile file stays JSON.
- **`capcomd profiles add` writes a profile file only when it needs one**: `--extends`, or a `--set` path an
  `agents.json` entry can't hold (`tags`, `identity.title`, `permissions.report`), as `<the project's
  profiles>/<name>.yaml` (the user's when the agents file is). Otherwise it writes `agents.json` as before, so scripts
  that add and then read `agents.json` keep working. `rm` removes an entry or a single profile file; a package (a
  directory, which holds its own files) is the user's to delete.
- **The descriptor**: `GET /v1/profiles/{name}` serves rows typed like ADR-021's settings (`type`, `label`, `help`,
  `value`, `display`, `choices`, `source`, `editable`), plus `from` (the index in `applied`) and `untrusted` (the
  `description`, `identity.title` and any row outside capcomd's catalog are the file's text). Every `value` is a string
  in the encoding `PUT` takes (a list as a JSON array), as the settings rows' are. A prompt row says whether it is set
  and how long, never its text (`GET /v1/profiles` serves no prompt; neither does this). Values capcomd has no row for
  (`skills`, `tools.mcp`, `x-` fields) are read-only rows labelled by their path, so they show without an app release;
  `tools.mcp` and `context.providers` show their names only, since a command line or a provider's own settings may
  carry a token, and any other such row has the redactor's token shapes taken out, a value under a key named like a
  secret (`password`, `apiKey`, `token`, …, as the redactor's values) replaced whole and a URL's password removed;
  a secret with none of these shapes still shows, as the file's other free text does. Files are written through a
  temporary file with an unguessable name, created exclusively (spec 1.0.45): a project's profiles directory is its
  repository's, and a link planted at a predictable name would be written through. A file keeps its mode (spec
  1.0.51); a link in its place is replaced by a file with the umask's mode, never its target's.
- **`PUT` takes an `Idempotency-Key` and the `rev`**: the key makes a retry after a lost response replay its first
  answer (the write-route rules), the `rev` refuses a change made from a read that is out of date (409 with the current
  one), as `PATCH /v1/sandboxes/{name}/settings` does. The `configure` scope, as project setup. Writes in the daemon
  run one at a time.
- **The capability is `profiles.edit`**, not `profiles`: `profiles` already names `GET /v1/profiles`, and a client
  has to know whether it may offer editing.
- **`profile.changed` is the API's**: the daemon records it (entity `profile:<name>`, data `{name, version,
  previousVersion, layer, path, changes, clientId}`), so a change made with `capcomd profiles set`, which runs without
  a daemon and inside agents' VMs, or by editing the file, isn't on the stream. Its text names every changed value and
  says the values only where capcomd wrote them (numbers, toggles, choices, names): free text (a description, a
  title, a prompt) is "changed".
- **Not in this step**: creating a profile with `PUT` (a name that isn't a profile is 404) and `DELETE
  /v1/profiles/{name}` (§5), which have no client yet; `ctx.profiles` gains no write method (spec §11.1's `configure`
  writes wait for it). **The app's Crew screen isn't built**: no approved mockup covers it (apps/menubar/design), so the
  API ships first and the screen waits for a design.

Made while building install, export and update (§7 step 7, 2026-11-06; `src/profiles/install.ts`,
`src/profiles/trust.ts`):

- **An installed package is in the user's or the project's layer**, not a layer of its own: `capcomd profiles install`
  writes `~/.capcomd/profiles/<name>/`, or with `--project` the checkout's `.capcomd/profiles/<name>/` (to commit, so
  the team shares it through the repository; a project plugin is fetched into the user's home instead because it is
  code, a profile is data and is gated as any project profile is: below). Its `LOCK` is a plugin's (`kind:
  "profile"`, the same content hash: every file but `LOCK`), and says where it came from; `profileSource` stays
  `project | user | bundled`. **`sharing.source` isn't written into `profile.yaml`** (§2.2's comment): it would make
  the installed files differ from the commit's; the `LOCK` has it and `show` prints it.
- **"Any executable" is a file with mode `100755`**; a link inside the package is allowed (the fetch refuses one out,
  and the loader reads a prompt, persona or skill only inside the directory). A package holding an `override.yaml` is
  refused too: an override is the user's or the project's (§2.6). `update` keeps one the user put beside the package
  and leaves it out of "edited since it was installed".
- **Checked in place**: install, update and `rm` of an installed package change the directory, read the profiles, and
  put it back when they now have a problem they didn't have (a file named outside the package, an `extends` nothing
  here answers, a child another profile extends gone). The writes' overlay (step 6) can't hold a new directory, and a
  reader sees the change for one read at most. A project with a broken profile can still install a package that adds
  no problem. A change to the user's layer is also read as every other project reads it (the user's layer alone): a
  package the current project hides with a profile of the same name isn't resolved there, and would otherwise break
  the user's profiles everywhere else.
- **§2.4's hand edit "treated as a bump with a notice" is the notice only**: `show` and `validate` say a package was
  edited since it was installed (its files against its `LOCK`, the user's override left out), and `update` lists the
  edits it replaces. Its `version` stays the file's: a version made up from a hash can't keep going up, and the agent's
  pin already records what it ran.
- **`update` shows each skill whose `SKILL.md` hash changes** (§2.5 "shown before it is applied") with the files,
  commit and content hash, and applies without asking, as `capcomd plugins update` does; `--dry-run` stops at the
  report. A project's changed skill then waits for trust again.
- **Trust is per `SKILL.md`, not per package**: kind `profile` in `trust.json`, the file made real as the place, and
  the sha256 the agent is pinned with as the hash, so what the operator trusted is exactly the text an agent gets (no
  window between a check and a read), and two profiles using one directory's skills don't compete for one entry. Only
  the project layer's skills need it: the user's own profiles, installed or written, and `~/.claude/skills` are the
  user's. The kernel refuses a spawn of a profile with an untrusted project skill (`config`, reason `untrusted`) in its
  spawn checks, which `capcomd run` also runs for its planner before starting; an agent already spawned keeps the text
  it was pinned with. `identity.persona` gets the same rule since it has a runtime (2026-11-08, below); prompt files
  stay as `agents.json` prompts are, the project's text.
- **`export` keeps `extends` by default**; `--flat` writes what the profile resolves to (its ancestors and overrides
  laid in, a prompt of more than a line as a file, every skill it is pinned with from a package copied into
  `skills/`, a `source: user` skill still by name). `default` is never exported, nor a `LOCK`.
- **Not in this step**: `POST /v1/profiles/install` (§5; no client yet, and the plugins have no install route
  either), the marketplace file's `profiles` (§2.5), `profiles add --from`, and trust in the API (`GET /v1/profiles`
  rows don't say it yet).

Made while building migrate and the templates (§7 step 9, 2026-11-06; `src/profiles/migrate.ts`,
`src/config/project-setup.ts`):

- **The templates are written into the project, and the bundled layer stays empty.** §6's four (five with ADR-025's
  consolidator, six with a second agent's worker) depend on the project: its agents and their logins, its check (the
  reviewer's tools). A bundled profile would need a harness every user can run, and a bundled `lead` that `extends:
  worker` would break every project without a `worker` (an `extends` nothing answers is an error for the whole set).
  So `capcomd setup project` writes them, `POST /v1/projects` writes the same bytes, and ADR-025's "until step 9 ships
  bundled profiles" is answered by the consolidator staying a profile file setup writes.
- **One `<name>.yaml` per profile, not `<name>/profile.yaml`.** A single file holds everything the templates set, and
  it is what `capcomd profiles add` writes and `rm` removes (a package is the user's to delete); a person who adds a
  `prompt.md` or `skills/` moves it into a directory. Each file starts with a comment saying what the profile is for and
  that it is the user's to change.
- **§6's shapes, with two changes.** `reviewer` extends `worker` (its read-only tools, `tags: [review]`,
  `permissions.report: true`); `lead` extends `worker` (orchestrate, three helpers one level down). **`planner`
  extends `worker`, not `lead`**: inheriting the lead's `children.maxChildren: 3` and `maxDepth: 1` would cap the
  planner, which has no fan-out limits, unless its file removed them with `null`, a line nobody reading it should need.
  **`context-consolidator` extends nothing**: with no model of its own it runs on the run's strongest (ADR-025 D6), and
  a worker's `harness.model` would otherwise become its. A second agent's worker (`codex-worker`) extends nothing either:
  its harness is all it has.
- **Every template has the project's memory** (`context: {providers: [{name: memory}]}`, on `worker` and so on what
  extends it; the consolidator's own with `review: human`), as ADR-025 §6.1 has it: a planner and a lead list it, a
  worker gets the same index, and a reviewer inherits it and is given only the facts (the kernel's D11 rule, by role,
  not by profile). The routing skill and the run's lessons need it on the planner, and the consolidator has been
  written since ADR-025 step 3.
- **Setup keeps what the project has**: a template whose name the project's layer has (a profile file or an
  `agents.json` entry) is kept, so a project set up before keeps its `agents.json` and gets only the missing profiles
  as files, extending its own `worker` entry. Each template is checked with every profile before it is written (the
  loader's overlay), and one they wouldn't resolve with (a `lead` extending a worker the user gave MCP servers, which an
  orchestrate profile can't have) is left out and reported as kept, rather than make every profile unreadable. Only the
  first worker template becomes the default, and only when the project's layer has none (setup used to make the first
  profile it added the default, which could be the reviewer).
- **`migrate` moves an entry to `<name>.yaml` at version 1 with the entry's own values** (`fromFlat`, §6's table), the
  file's `default` as that file's `default: true`, and checks through the overlay that every profile resolves to the
  same spec, version, runtime and skills and the default stays, before it writes anything; otherwise it refuses. An
  override of the entry keeps applying, now to the file. It leaves in `agents.json` an entry a profile file of its
  layer already hides (the person removes it; `validate` names it) and one whose prompt is one word ending `.md` or
  `.txt`, which a profile file reads as a file's name and only a package can hold (the overlay can't check a new
  directory, as step 7 found). Profile files go first and `agents.json` last, so an interrupted migrate leaves files
  that win over entries still there.
- **`agents.json` is left in place with a note**: §6's "a comment" is a `$comment` (JSON has no comments), which the
  v1 schema now allows and the loader ignores. An older capcomd refuses an unknown top-level key, but it doesn't read
  profile files either, so a team member on one is served by `--keep` instead, which leaves `agents.json` exactly as it
  was: the files win where they are read, and `validate` names each entry they hide (§6: "the v2 directory wins and
  `validate` warns").
- **`capcomd profiles add` follows the project**: a profile file where the project's profiles are files (its
  `profiles/` folder exists and `agents.json` has no entries, as setup and `migrate` leave it), `agents.json` where it
  has entries. Step 6 kept `add` on `agents.json` for scripts that add and then read it; those projects keep that.
- **`default: true` on `add` or `set` moves the default**, as `agents.json`'s `default` always did: the profile file of
  that layer that said it loses it (a write to that file too, so its version goes up), since two in one layer are an
  error and setup's `worker.yaml` says it. Otherwise `capcomd profiles add rev --default`, the first line of
  docs/agents.md, would be refused in every project set up from now on. An `override.yaml` that sets it is left alone
  (the write is refused, saying so).
- **The deprecation is a notice in this release**: the changelog says `agents.json` is read for the next two minor
  releases, then `validate` warns, then it isn't read. Nothing warns yet.

Made while giving `identity.persona` and `harness.cliVersion` their runtime (2026-11-08; `src/profiles/persona.ts`,
`src/env/cli-version.ts`, spec §6.6.7, 1.0.56):

- **The persona is pinned like a skill**: read when the profile resolves, from the directory of the manifest that set
  `identity.persona` (its own, an ancestor's, since a persona is inherited, or an override's), at most 32 KiB and not
  empty; pinned on the agent at spawn by `{hash, source}` with its text kept with the run (content-addressed, never in
  an event); each attempt's `agent.preparing` reads it and checks the pin (a missing or different text fails the
  attempt for good). A retried or resumed agent gets exactly the persona it was spawned with.
- **"First in the system prompt" is the first text of the agent's instructions, once**: Claude Code keeps its own
  system prompt (replacing it would drop its tools' instructions), so the persona is the first text of what is appended
  to it, before the profile's `prompt.append`, the plugins' appends and every skill; with a profile's `prompt.system`
  (which replaces Claude Code's) it is the first text of that. A CLI without system prompt flags (Codex) reads the
  system prompt first in its prompt, so the persona leads it there. The runner places it (the prepared spec carries the
  text), so the order holds whatever the plugins append; `agent.preparing`'s `prompt.persona` shows it to plugins and
  no patch changes it.
- **A project's persona is trusted per file and hash, like its skills** (decision 4): trust kind `profile`, the file
  made real, the sha256 the agent is pinned with. A spawn before `capcomd profiles trust <name>`, or after the file
  changed, is refused (`untrusted`); a profile that extends one shares its file, so one trust covers both. The user's
  own persona needs none. `capcomd profiles trust` shows the persona's file, first line, size and hash before asking;
  `show` and `validate` name it; `rm` of an installed package revokes the trust given to its persona too.
- **`harness.cliVersion` is a semver range checked when the profile is read** (Bun's `semver.satisfies` accepts any
  text and says yes to some it can't read, so the range's shape is checked first) **and at spawn against the version
  the agent's environment recorded** (`capcomd env build` records each CLI's version per build): the profile's
  `sandbox.environment`, else the sandbox's current build, or, for a plan login kept in an image, the environment that
  image was made from. Not satisfied: the spawn is refused (`config`, reason `environment`), `capcomd run` refuses
  such a planner, GET /v1/run-options says it isn't ready, and `validate` warns. **An environment that recorded no
  version of the CLI** (the sandbox's plain image, no build yet, a version that couldn't be read) **can't be shown to
  satisfy the range, so the spawn is refused too** (the conservative reading of "a pin the environment must have"). The
  range is checked against the CLI the agent runs, so an operator's provider swap on a pinned profile is held to it.
  A project template is matched by name when it is what the agent boots from; the spawn check, like the environment
  check, doesn't know the run's repository, so it reads the current build's versions (a template is built on the same
  CLI pins).
- **Nothing is left "read but not used"**: `notApplied` is empty, and `validate` and `show` say nothing of it until a
  block is added before its runtime.
- **Not in this step**: `GET /v1/profiles` rows and `capcomd_profiles` don't list the persona or its trust (the run
  options' planner readiness does), and `capcomd profiles update` lists a changed persona among the changed files, not
  on a line of its own as a changed skill is.

Judgment calls made in the spec on the profile side (spec §16.1–16.2; reasons in ADR-023 §10):

| Decision | Spec |
|---|---|
| **`tools.mode: execute \| orchestrate`**: the planner never executes, as a profile capability: it sees everything (read-only git with fetch, files, every capcomd read) and runs nothing (no edits, commits, merges, pushes, installs, builds or tests). The agent provider's `describe().toolPolicies.orchestrate` gives the CLI's tool lists (and, for a CLI with command rules of its own, `denyCommands`); `children.allowSpawn` must be true; the kernel refuses `verify`/`merge` of the agent's own ref and skips its push; `planner` and `lead` from `capcomd setup project` get it; `plannerBrief`'s "don't change files yourself" stays as explanation | §16.1 |
| **A `jobs` block** (`foregroundMs`, `max`, `afterTurnMs`) with `foregroundMs` defaulting to 5 000 for orchestrate agents and 60 000 otherwise | §16.2 |
| **`lifecycle.onStart`/`onEnd` name plugins that must be active**, which listen to `agent.changed` for that profile; there is no per-profile hook | §6.6.8 |
| **`harness.provider` and `sandbox.provider` are seam names**, validated against the active plugins at `validate` | §7.1 |
| **`identity.persona` and `skills` reach the prompt through `agent.preparing`**, the one place a plugin adds prompt text | §6.6.7 |
| **`profile.resolved` patches are narrow-only through `widenings()`**, and must be pure (it fires on every resolution) | §6.6.5 |
