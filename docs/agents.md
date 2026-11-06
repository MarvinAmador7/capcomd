# Agent profiles

Named harness agents (a capcomd primitive, see ADR-016) in `.capcomd/agents.json` (override with `CAPCOMD_AGENTS_FILE`), and profile files (below). Schema: `capcomd profiles schema v1` (JSON Schema, id `capcomd.agents/v1`). Design: ADR-015 §5–7, ADR-024.

```bash
capcomd profiles add rev --provider claude --auth subscription --max-turns 20 --append-system-prompt "Be terse." --default
capcomd profiles add cx  --provider codex  --auth apikey --sandbox workspace-write --egress github.com
capcomd profiles set rev --model claude-sonnet-4-5 ; capcomd profiles set rev --unset model
capcomd profiles list --json ; capcomd profiles show rev --json   # spec + where each value came from + effective config + readiness
capcomd profiles validate ; capcomd profiles rm cx
capcomd run --profile rev --set maxTurns=10 --set children.maxDepth=1 "goal"   # narrowing only
capcomd run --profile rev --overrides '{"maxTurns":50}' --operator "goal"       # widening needs --operator
```

For Hermes or another orchestrator: define profiles with `profiles add NAME --spec '<json>' --json`, read them with `profiles list --json` (or `GET /v1/profiles` on the harness API, capability `profiles`), and select one per goal with `--profile`, or a per-task directive `[agent:NAME] …` in the goal text.

`capcomd agents …` is the old name of `capcomd profiles …` and works until the next minor release (it says so on
stderr). Two of its outputs stay as they were: `agents list --json` lists the rows under `agents` (`profiles list
--json` under `profiles`), and `agents schema` prints the `agents.json` schema (`profiles schema` prints a profile
file's).

### Where a profile comes from: `capcomd profiles show`

`show <name>` prints its `fit` line, the files laid together to make the profile, first to last (its `extends`
ancestors, the profile itself, then its overrides), and every resolved value with the number of the file that set it:

```text
lead: version 2, found in the project's profiles
Fit: orchestrates: sees everything, runs nothing; Claude Code, sonnet, medium cost; up to 30 turns; can't spawn
Files, first to last (a later one wins):
   1  extends  worker           project /work/app/.capcomd/agents.json
   2  profile  lead             project /work/app/.capcomd/profiles/lead/profile.yaml
   3  override lead             project /work/app/.capcomd/profiles/lead/override.yaml
Values (the number is the file that set it):
  harness.provider               claude                                           1
  harness.model                  sonnet                                           1
  tools.mode                     orchestrate                                      2
  limits.maxTurns                30                                               3
```

`--json` gives the same as `applied` (the files) and `values` (`{path, value, from}`, `from` being one of `applied`),
plus `spec` (what an agent is pinned with), `effective` (with capcomd's defaults) and readiness. `list` shows each
profile's layer (`project`, `user` or `bundled`), and `list --json` its `version`, `format` (`v1` for an
`agents.json` entry, `v2` for a profile file), `path` and `applied`.

## Profile files (v2: `profile.yaml`)

A profile can also be a YAML (or JSON) file of its own, schema `capcomd.profile/v2` (design: ADR-024 §2): a
directory `.capcomd/profiles/<name>/profile.yaml` (a package: the files it names sit next to it), or a single
`.capcomd/profiles/<name>.yaml`. Your own profiles, for every project, go in `~/.capcomd/profiles/`.

```yaml
# .capcomd/profiles/lead/profile.yaml
schema: capcomd.profile/v2
name: lead
extends: worker                  # a profile of this project, your own or a bundled one; never another project's
description: Leads a part of the work.
harness: { model: claude-opus-5-5, effort: high }   # provider and auth come from worker
prompt: { append: prompt.md }    # a file name in the profile's directory is read from it
tools: { mode: orchestrate }
limits: { maxTurns: 40, timeoutMs: null }           # null removes what worker set
children: { allowSpawn: true, allowedChildProfiles: [worker], maxChildren: 3 }
```

- The blocks are `harness` (provider, auth, model, effort), `prompt` (system, append), `tools` (mode, allowed,
  disallowed), `sandbox` (codex, egress), `limits`, `lifecycle` (checkpointEveryMs), `children`, plus `description`,
  `tags`, `version` and `default: true`. Each `agents.json` field has a home there (ADR-024 §6). Unknown keys are
  refused, except `x-<name>` ones a plugin may read.
- `extends` lays the child over its parent: values and lists replace, blocks merge key by key, and `null` removes a
  key. A child may do more than its parent (a lead is a worker that can spawn); only the profiles a profile may
  *spawn* (`children.allowedChildProfiles`) must be no wider than it, and that is checked on the resolved profiles.
- A name is looked up in the project's `.capcomd/profiles/`, then `~/.capcomd/profiles/`, then the ones bundled with
  capcomd. An `override.yaml` in `<name>/` changes a profile without copying it (same blocks, no `name`): yours over a
  bundled one, the project's over yours or a bundled one.
- `agents.json` keeps working as before; a `profile.yaml` of the same name in the same place wins, and `capcomd
  profiles validate` says so. `capcomd profiles list`, `show` and `validate` read both.
- `capcomd profiles set <name>` changes the file the profile is defined in, wherever it is: its `profile.yaml` (or
  `<name>.yaml`) or its `agents.json` entry, never a profile it `extends` or an `override.yaml` laid over it. It takes
  the flags (`--model`, `--max-turns`, …), `--set` with the v2 paths (`--set limits.maxTurns=40 --set
  tags=review,security`) and `--unset` (which removes the profile's own value, so an inherited one shows again). A YAML
  file keeps its comments, and its `version` goes up by one (an `agents.json` entry has none: it stays 1). The change
  is checked as the files would be after it: one that would leave any profile unreadable (a value out of range, a
  child wider than the profile that spawns it), or that an `override.yaml` would hide, is refused and nothing is
  written. `capcomd profiles add <name> --extends <parent>` (or with a `--set` only a profile file holds, such as
  `tags`) writes `.capcomd/profiles/<name>.yaml` at version 1; without, `add` writes `agents.json` as before. `rm`
  removes an `agents.json` entry or a single profile file, but not a package (a directory with its own files) or a
  profile another one extends.
- The harness API does the same: `GET /v1/profiles/{name}` serves a profile as rows an app renders and edits (each
  value with its type, the file that sets it, and whether it can be changed there; never a prompt's text), and `PUT
  /v1/profiles/{name}` changes them (a token with the `configure` scope, an `Idempotency-Key` and the `rev` it read).
  Every change made through the API is a `profile.changed` event on the daemon stream; a change made with `capcomd
  profiles set` or by editing the file isn't (capability `profiles.edit`).
- What a planner reads to choose a profile (`capcomd_profiles`, `capcomd profiles list --json` and `show`): `identity.title` (the
  name to show; not passed to a profile that `extends` it, nor is `identity.avatar`), `tags` (lowercase words, what
  the profile is for: `[review, security]`), `sharing` (`source`, `license`: where an installed profile came from) and
  `canReport` from `permissions.report`. capcomd adds `fit`, one line it writes from the profile's settings, never
  from its text ("read-only; Claude Code, claude-opus-5-5, high effort, high cost; up to 40 turns; can't spawn"), and
  `cost`, its model's list price (`low`: Haiku, `-mini`/`-nano`; `medium`: Sonnet, GPT; `high`: Opus, `-pro`; null
  when the profile leaves the model to the CLI). `capcomd_profiles` also gives each profile's `capacity`: how many of
  it can start now (the sandbox's slots, which every profile shares, or 0 with `waitsUntil` while its login is at a
  usage limit).
- `permissions: { report: false }` keeps a profile from being spawned with `report` (read-only work whose answer is
  its result): such a spawn is refused (`reason: "report_not_allowed"`). Unset or `true`, it may be, as before.
- `identity.persona`, `skills`, `tools.mcp`, `context` (with `memory` read as its old name),
  `sandbox.provider|environment|size` and `lifecycle.onStart|onEnd` are checked but don't change what an agent does
  yet; `capcomd profiles validate` lists the ones a profile sets. `jobs` (`foregroundMs`, `max`, `afterTurnMs`) sets the
  agent's background jobs (`capcomd job start`), as the flat `jobs` field does in `agents.json`.
- `capcomd profiles schema` prints the JSON Schema of a profile file (id `capcomd.profile/v2`), for an editor.
- `--set` and `--overrides` take the v2 paths too: `--set limits.maxTurns=10 --set tools.allowed=Read,Grep`.
- An agent keeps the profile it was started with: what the profile resolved to then, its `version` (1 when it sets
  none, and for every `agents.json` profile) and the layer it came from (`project`, `user` or `bundled`). Editing the
  profile changes the next agents, not the running ones. `capcomd inspect <runId> <agentId>` shows it as
  `[worker v3, project]`; `spawn`, `inspect` and `await --json` and the API's `Agent` carry `profileVersion` and
  `profileSource`.

## The planner's provider, model and effort for one run

A run with a planner agent uses the project's `planner` profile. Three flags change it for that run only, without
editing the profile:

```bash
capcomd run "goal" --planner-provider codex           # the planner on Codex (your codex profile's model and login)
capcomd run "goal" --planner-model claude-sonnet-5-5  # the planner on that model
capcomd run "goal" --planner-effort high              # its reasoning effort
```

`--planner-model` takes one of the models its provider offers: Claude Code `claude-opus-5-5`, `claude-sonnet-5-5`,
`claude-haiku-5-5`; Codex `gpt-5.6`; plus any other model a profile on that provider in the project names. Anything
else is refused with the list. The model reaches the agent CLI the way a profile's `model` does (Claude Code
`--model`, Codex `-m`), and replaces the profile's. `CAPCOMD_AGENT_MODEL`, when set, still wins over both.
`GET /v1/run-options` lists each provider's models (`drivers[].models`: an id, a name and a one-line note, capability
`runs.options.models`), and `POST /v1/runs` takes the pick as `model`. The curated list lives in
`src/config/models.ts`.

Limits are optional: `maxTurns`, `timeoutMs` and `maxBudgetUsd` (`--max-turns`, `--timeout-ms`, `--budget`) are unset unless you set them, and an unset limit means none (ADR-019). Turns count differently per provider: Claude Code counts model turns, Codex counts tool steps. Nothing else restricts an agent by default either: a run without `--budget` has none, a profile that may spawn has no depth or descendant limit unless its `children` block sets one, and an agent without `allowedTools` gets every tool with no permission prompts, nothing disallowed, Codex's `danger-full-access` sandbox and open egress from its VM (the VM is the boundary, and agents never hold push credentials). Narrow any of these per profile: `allowedTools`, `disallowedTools`, `sandbox`, `egress`. What is always on is a watch for an agent that looks stuck. It reads what the agent does, not how long it takes: **idle** (its CLI produced no output for `idleAfterMs`, `--idle-after-ms`, default 30 minutes), **spinning** (the same tool call with the same input `stuckRepeats` times in a row, `--stuck-repeats`, default 8) or **failing** (the same command failing with the same error `stuckRepeats` times, numbers aside). One more kind is opt-in, since reading code for a long time is normal: with `noChangeAfterMs` (`--no-change-after-ms`) an agent that keeps working but changes nothing in its workspace for that long is **spinning** too, and stopped after twice that. The first window is only a notice: `inspect` and `tree` show it as `notice`, the event log gets `AGENT_NOTICE`, the supervisor checkpoints the work, and `capcomd await --notices` (and `capcomd_await`, and `await` inside a VM) return early with `notices` so the parent can step in. By default that's all: the agent keeps running. A profile that sets the window (`idleAfterMs` for idle, `stuckRepeats` for spinning and failing, or `CAPCOMD_AGENT_IDLE_MS` / `CAPCOMD_AGENT_STUCK_REPEATS`) also gets a stop: if the agent is still stuck after a second window (twice the idle time, twice the repeats), it's stopped with `result.limit` idle, spinning or failing. Any stop keeps the work: it's pushed to the agent's branch and the agent ends `failed` with `result.limit`.

Budgets (`run new --budget`, `spawn --budget`) are enforced from live spend: while an agent works, its runner reports what it has spent every few seconds (Claude's from each message's token usage at list prices, until its final cost arrives; Codex's from tokens × `CAPCOMD_CODEX_USD_PER_MTOK_IN/OUT`), and the engine stops the agent (`result.limit: max_budget_usd`, work kept) when its own budget, an ancestor's or the run's is spent. A spawn reserves only the units it names (or its profile caps), so agents spawned without a budget share what's left.

Every agent runs under a small supervisor in its VM (when the VM has `node`, which the npm-installed CLIs bring). It reports a heartbeat every 30 seconds and checkpoints the workspace every `checkpointEveryMs` (`--checkpoint-every-ms`, default 10 minutes) and right after the agent commits: a commit of the working tree on top of HEAD, made through a temporary index so the agent's files, index and history are untouched. The engine pushes it to `refs/capcomd/checkpoints/<agentId>` (the VM holds no push credentials), and the agent's record shows it as `checkpoint`. To continue an agent's work in a new agent: `capcomd spawn <runId> --continue <agentId> --task …` starts from its branch, or from its last checkpoint when it pushed none.

When an agent's provider says its usage limit is reached (a plan's limit or the API's), the agent is `paused`, not failed: what it changed is pushed to its branch (`Capcomd-Stop: quota`) and its result has `limit: "quota"`, the login (`claude:subscription`) and `resetAt`. It runs again after the reset (when it gave none, after `CAPCOMD_QUOTA_RETRY_MS`, default an hour), as a new attempt in a new VM that continues on its branch. The login is remembered on the engine host (`quotas.json` in the state directory), so other agents on it wait for the reset instead of starting. `capcomd resume <runId> [agt]` runs paused agents now and clears the login's wait. Paused agents are woken while someone awaits them.

You can pause agents yourself: `capcomd pause <runId> [agt]` (or `POST /v1/runs/{runId}/pause` and `POST /v1/runs/{runId}/agents/{agentId}/pause` on the harness API) pauses an agent and its descendants, or every agent of the run. One that hasn't started is paused at once; a running one stops at its next check (every 2 seconds), its work is committed and pushed to its branch (`Capcomd-Stop: paused`), and it is `paused` with `limit: "paused"` and no reset time. It waits for `capcomd resume <runId> [agt]` (which runs the agent and its paused descendants, or every paused agent of the run), then continues from its branch as a new attempt. An agent that finishes before it stops ends `done` as usual. Pausing some agents leaves the others working; the run reads as paused (`run.paused` in the lifecycle feed) only once every agent still live is paused.

`capcomd send <runId> <agt> <text> --skill NAME` (repeatable, at most 8 skills and 256 KB of `SKILL.md` together) sends skills with a message: the agent reads each skill's `SKILL.md` with the message text, as one more part of the message. `capcomd skills` lists the names: the bundled capcomd skills and your `~/.claude/skills`. Only `SKILL.md` goes: files next to it in the skill's directory are not copied into the agent's VM.

Auth is exactly one of `apikey` (the provider's API key, from local env or a boxd secret) or `subscription` (from `capcomd auth login claude|codex`). Giving both or neither is an error. `CAPCOMD_AGENT` still works as an override, set to a kind or a profile name.

`children` (policy only for now): `{allowSpawn, maxDepth, maxChildren, maxTotalDescendants, allowedChildProfiles, budgetShare}`. Children may only narrow their parent.

`provider` is the name of an active agent provider: `claude` and `codex` are built-in plugins (`agent-claude`, `agent-codex` in `capcomd plugins list`), and another plugin may add one. A profile naming one that isn't active is refused when it's validated.

`toolMode: "orchestrate"` (default `"execute"`) makes an agent that plans, spawns, verifies and merges but never changes a file itself (docs/spec/plugin-api.md §16.1): Claude Code gets only `Read, Glob, Grep, LS, Bash(capcomd:*)` with the edit tools denied, Codex runs with `--sandbox read-only` (its capcomd MCP tools still work), nothing it does is committed or pushed, and capcomd refuses to verify or merge its own ref. It needs `children.allowSpawn`; its children run in their own mode, and an override can't lift it without `--operator`. `capcomd setup project` gives it to `planner` and `lead`.
