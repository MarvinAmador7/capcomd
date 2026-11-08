# Agent profiles

Named harness agents (a capcomd primitive, see ADR-016): profile files in `.capcomd/profiles/` (below; `capcomd
setup project` writes them, schema `capcomd profiles schema`), and the older `.capcomd/agents.json` (override with
`CAPCOMD_AGENTS_FILE`; schema `capcomd profiles schema v1`, id `capcomd.agents/v1`), which capcomd still reads for two
more minor releases: `capcomd profiles migrate` moves it into profile files (below). Design: ADR-015 §5–7, ADR-024.

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

A profile is a YAML (or JSON) file of its own, schema `capcomd.profile/v2` (design: ADR-024 §2): a directory
`.capcomd/profiles/<name>/profile.yaml` (a package: the files it names sit next to it), or a single
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
  `tags`, or in a project whose profiles are files: a `profiles/` folder and no `agents.json` entries) writes
  `.capcomd/profiles/<name>.yaml` at version 1; otherwise `add` writes `agents.json` as before. `--default` (on `add`
  or `set`) moves the default as it does in `agents.json`: the profile file of that place that said `default: true`
  loses it (a write to that file, so its `version` goes up too). `rm`
  removes an `agents.json` entry, a single profile file or a package `capcomd profiles install` put there (below), but
  not a package you made yourself (a directory with its own files) or a profile another one extends.
- The harness API does the same: `GET /v1/profiles/{name}` serves a profile as rows an app renders and edits (each
  value with its type, the file that sets it, and whether it can be changed there; never a prompt's text), and `PUT
  /v1/profiles/{name}` changes them (a token with the `configure` scope, an `Idempotency-Key` and the `rev` it read).
  Every change made through the API is a `profile.changed` event on the daemon stream; a change made with `capcomd
  profiles set` or by editing the file isn't (capability `profiles.edit`).
- What a planner reads to choose a profile (`capcomd_profiles`, `capcomd profiles list --json` and `show`, and the
  app in `GET /v1/profiles`): `identity.title` (the
  name to show; not passed to a profile that `extends` it, nor is `identity.avatar`), `tags` (lowercase words, what
  the profile is for: `[review, security]`), `sharing` (`source`, `license`: where the profile is published; an
  installed one's `LOCK` says where it was installed from) and
  `canReport` from `permissions.report`. capcomd adds `fit`, one line it writes from the profile's settings, never
  from its text ("read-only; Claude Code, claude-opus-5-5, high effort, high cost; up to 40 turns; can't spawn"), and
  `cost`, its model's list price (`low`: Haiku, `-mini`/`-nano`; `medium`: Sonnet, GPT; `high`: Opus, `-pro`; null
  when the profile leaves the model to the CLI). `capcomd_profiles` also gives each profile's `capacity`: how many of
  it can start now (the sandbox's slots, which every profile shares, or 0 with `waitsUntil` while its login is at a
  usage limit).
- `permissions: { report: false }` keeps a profile from being spawned with `report` (read-only work whose answer is
  its result): such a spawn is refused (`reason: "report_not_allowed"`). Unset or `true`, it may be, as before.
- `skills` gives every agent of the profile skills at its start (below).
- `identity.persona` is checked but doesn't change what an agent does yet; `capcomd profiles validate` lists it when a
  profile sets it. `context` (with `memory` read as its old name) does: see "Project memory" below. `jobs`
  (`foregroundMs`, `max`, `afterTurnMs`) sets the agent's background jobs (`capcomd job start`), as the flat `jobs`
  field does in `agents.json`. They are limits like `limits`: an override (`--set jobs.max=2`, which keeps the
  block's other values) may lower one but not raise or unset one the profile sets (without `--operator`), and a
  profile in `children.allowedChildProfiles` may not either. A job started with a longer `--timeout-ms` than the
  profile's `afterTurnMs` gets `afterTurnMs`.
- `tools.mcp` gives the profile's agents MCP servers: `- { name: semgrep, command: [semgrep-mcp, --quiet], trust:
  untrusted }`. The agent's CLI starts each one inside its sandbox (never on your machine), beside capcomd's own server
  (so `capcomd` isn't a name you can use), so the program must be in the sandbox's environment (the agent's log says
  when it isn't). `trust: trusted` approves the server's tools up front, as capcomd's are; `untrusted` (the default)
  leaves them to the profile's tool rules: with `tools.allowed`, Claude Code runs only the ones it names
  (`mcp__semgrep`, or `mcp__semgrep__<tool>`), Codex asks its own approval rules (which refuse what needs asking). An
  orchestrate profile can't have servers: it runs nothing, so give them to the profiles it spawns (an override that
  makes one orchestrate is refused: `reason: "orchestrate_mcp"`).
- `sandbox.provider` runs the profile's agents on that sandbox (`docker`, `boxd`), whatever the run's is (`capcomd run
  --sandbox`) or the daemon's; it must be an active sandbox plugin, and it can't take them out of isolation (a sandbox
  that runs agents on your machine, as the test ones do, is refused unless the run's is one too: `reason:
  "sandbox_isolation"`). `sandbox.environment` is what their machines boot
  from there: `default` (the current `capcomd env build`, as for every agent), `image` (the provider's plain image: the
  agent CLI is installed at start) or a build's name from `capcomd env status --sandbox <name>`. With a plan login kept
  in an image (`capcomd auth login`), that image is the one used, so the environment must be `default` or the one it
  was made from. `sandbox.size: { vcpu: 1 | 2 | 4 | 8 }` is the machine's size on boxd; Docker containers share your
  CPUs and don't take it.
- `lifecycle.onStart` and `lifecycle.onEnd` name plugins that must be active for the profile's agents: each one hears
  the agent's `agent.changed` (its start, steps, end), which carries the names (`lifecycle`), so it knows it was named.
  A spawn of a profile that names a plugin that isn't active and listening to `agent.changed` is refused (`reason:
  "lifecycle_inactive"`), and an agent whose plugin was turned off since doesn't start.
- These runtime blocks are fixed when the agent is spawned and can't be changed with `--set`, `--overrides` or by a
  parent spawning a child. `capcomd profiles validate` checks them against this host too: a lifecycle plugin the
  running daemon doesn't have is an error, an environment the sandbox doesn't have a warning (a spawn refuses it,
  `reason: "environment"`).
- `capcomd profiles schema` prints the JSON Schema of a profile file (id `capcomd.profile/v2`), for an editor.
- `--set` and `--overrides` take the v2 paths too: `--set limits.maxTurns=10 --set tools.allowed=Read,Grep`.
- An agent keeps the profile it was started with: what the profile resolved to then, its `version` (1 when it sets
  none, and for every `agents.json` profile) and the layer it came from (`project`, `user` or `bundled`). Editing the
  profile changes the next agents, not the running ones. `capcomd inspect <runId> <agentId>` shows it as
  `[worker v3, project]`; `spawn`, `inspect` and `await --json` and the API's `Agent` carry `profileVersion` and
  `profileSource`.

### The profiles `capcomd setup project` writes

`capcomd setup project` (and setting a project up from the app) writes one file per profile in `.capcomd/profiles/`,
each starting with a comment saying what it is for:

| File | What it is |
|---|---|
| `worker.yaml` | `harness` (the first agent you chose, and its login), the project's memory (`context: {providers: [{name: memory}]}`), `default: true` |
| `codex-worker.yaml` (or `claude-worker.yaml`) | the same for your second agent, when you chose both |
| `reviewer.yaml` | `extends: worker`; read-only tools plus your check's commands, `tags: [review]`, `permissions.report: true` |
| `lead.yaml` | `extends: worker`; orchestrates, up to 3 worker helpers one level down |
| `planner.yaml` | `extends: worker`; orchestrates, may spawn the workers, `lead` and the consolidator, `tags: [plan]` |
| `context-consolidator.yaml` | its own `harness` (no model: it runs on the run's strongest), read-only, `context.review: human` |

Because `reviewer`, `lead` and `planner` extend `worker`, a model, effort or limit you set on the worker is theirs too
until they set their own (`capcomd profiles show <name>` says which file set each value). The planner extends the
worker rather than the lead, so the lead's helper caps aren't the planner's. A reviewer inherits the memory block but
gets only the project's facts from it (reviewers judge the code, not remembered opinions). Running setup again keeps
every profile you have, a profile file or an `agents.json` entry of the same name; one that wouldn't resolve with
yours (a lead extending a worker you gave MCP servers, which an orchestrating profile can't have) is left out, and
setup says it kept it.

### Moving `agents.json` to profile files: `capcomd profiles migrate`

`agents.json` is still read, for the next two minor releases; then `capcomd profiles validate` warns about it, and a
later release stops reading it. `capcomd profiles migrate` moves it:

```text
$ capcomd profiles migrate
Moved 3 profiles from /work/app/.capcomd/agents.json to /work/app/.capcomd/profiles, each resolving as before:
  worker           → /work/app/.capcomd/profiles/worker.yaml (the default)
  reviewer         → /work/app/.capcomd/profiles/reviewer.yaml
  planner          → /work/app/.capcomd/profiles/planner.yaml
/work/app/.capcomd/agents.json stays, without them, with a note saying where they went; capcomd still reads it.
Agents already running keep the spec they were spawned with. Commit the new files to share them.
```

- Each entry becomes `<name>.yaml` beside it at version 1, with its values where a profile file keeps them (ADR-024
  §6: `model` → `harness.model`, `maxTurns` → `limits.maxTurns`, …); the default becomes that file's `default: true`.
  An `override.yaml` of the profile keeps applying. Before writing anything, migrate checks that every profile
  resolves to exactly what it did (the same spec, version, skills and default), and refuses otherwise.
- `agents.json` stays with a `$comment` saying where its profiles went; an entry migrate can't move stays in it: one a
  profile file of the same name already hides, and one whose prompt is a single word ending `.md` or `.txt` (a profile
  file reads that as a file's name: make it a `<name>/profile.yaml` with the prompt in a file).
- `--keep` leaves `agents.json` exactly as it was, for teammates whose capcomd reads only `agents.json`: the profile
  files win for a capcomd that reads them, and `validate` names each entry they hide. `--dry-run` writes nothing.
- It moves the agents file capcomd reads here: the project's, or your own `~/.capcomd/agents.json` into
  `~/.capcomd/profiles/`.

### Skills in a profile

```yaml
# .capcomd/profiles/reviewer/profile.yaml
name: reviewer
harness: { provider: claude, auth: subscription }
skills:
  - name: threat-model            # .capcomd/profiles/reviewer/skills/threat-model/SKILL.md
  - name: owasp-top-10
    source: user                  # ~/.claude/skills/owasp-top-10/SKILL.md
    hash: sha256:9f2c…            # optional: refuse the skill if its SKILL.md has changed
```

An agent of the profile gets each skill's `SKILL.md` in its instructions when it starts (Claude Code's appended
system prompt, Codex's prompt), after the profile's `prompt.append`, each in a `<skill name="…">` block, the way
`capcomd send --skill` sends skills with a message.

- Where a skill comes from (`source`): `package` is the profile's own `skills/<name>/SKILL.md` (an `override.yaml`'s
  directory first, then the profile's, then the profiles it extends); `user` is your `~/.claude/skills`, as
  `capcomd skills` lists them; `bundled` is capcomd's. Without `source`: the profile's own, then capcomd's. A
  single-file profile (`<name>.yaml`) has no `skills/` directory. A `SKILL.md` must stay inside the profile's
  directory (a link out of it is refused). Only `SKILL.md` goes to the agent, not the files next to it.
- Skills are read when the agent is spawned, and the agent is pinned to them by the sha256 of each `SKILL.md`: one
  edited after that changes the next agents, never one already spawned (a retried or resumed agent gets the same
  text). `capcomd profiles show <name>` prints each skill's source and hash; `hash:` in the profile pins one, and a
  `SKILL.md` that no longer matches it is refused, never taken silently.
- `capcomd-orchestration` is capcomd's own: every agent that may spawn (`children.allowSpawn: true`) gets it anyway,
  written for that agent (its limits, budget and the run's goal branch), so naming it changes nothing and the agent
  gets it once. Naming it in a profile that can't spawn, or with a `hash`, is refused.
- At most 8 skills and 256 KB of `SKILL.md` together, as on a message; a profile that may spawn keeps one of the 8 and
  32 KB for the orchestration skill. A missing, empty or too big skill makes the profile invalid (`capcomd profiles
  validate` names it), as any other mistake in it does.
- A skill from the project's profiles (`.capcomd/profiles/`, which come with the repository) is instructions someone
  else may have written, so its agents get it only once you have looked at it: `capcomd profiles trust <name>` shows
  each of the profile's project skills that you haven't trusted as it is (its description, file, size and sha256) and
  asks (`--yes` for scripts; without a terminal it is required). Until then a spawn of the profile is refused
  (`reason: "untrusted"`), and `capcomd profiles validate` and `show` say so, as do `untrustedSkills` in `capcomd
  profiles list --json`, `capcomd_profiles` and `GET /v1/profiles`, and a planner's `reason` in `GET /v1/run-options`
  `planners`. Trust is kept per `SKILL.md` content and
  place in `~/.capcomd/trust.json`: an edited skill, or the same one in another checkout, needs trusting again. Your
  own profiles' skills (`~/.capcomd/profiles/`) and your `~/.claude/skills` need no trust. `capcomd profiles trust`
  with no name lists the project's skills and whether each is trusted.

### Sharing profiles: `install`, `update`, `export`

A profile package is a directory with a `profile.yaml` and the text files it names (prompts, a persona,
`skills/<name>/SKILL.md`), in any git repository.

```bash
capcomd profiles install acme/capcomd-profiles#security-critic@v1   # a git URL or a local repository path works too
capcomd profiles install acme/capcomd-profiles#security-critic --project
capcomd profiles update security-critic --dry-run
capcomd profiles export lead --flat --out ./shared
```

- `install <owner/repo>[#<name>][@<ref>]` copies the package into your profiles (`~/.capcomd/profiles/<name>/`), or
  with `--project` into the project's (`.capcomd/profiles/<name>/`, in the checkout, to commit), with a `LOCK` file:
  where it came from, the commit, each file's sha256 and a hash of them all (the same `LOCK` as a plugin's, `kind:
  "profile"`). `#name` picks the package whose `profile.yaml` has that name (else the repository's root one, else its
  only one); `@ref` is a branch, tag or commit (else the default branch). capcomd fetches it the way it fetches
  plugins: nothing in it runs, and a link out of the package, more than 5000 files or 100 MB are refused. Profiles are
  data, so a package with an executable file is refused, and so is one with an `override.yaml` (overrides are yours),
  one whose manifest names a file outside its directory, and one the profiles here wouldn't resolve with (its
  `extends` names a profile you don't have, say). A name already in that place is a conflict; one this project
  defines too is installed and said to be hidden by the project's. A project's installed package is like any other
  profile there: its skills wait for `capcomd profiles trust`.
- `update <name>` fetches it again from the `LOCK`'s source (a branch moves, a tag or commit doesn't) and shows what
  changed before replacing it: the files changed, added and removed, each skill whose `SKILL.md` hash changes, the old
  and new commit and hash, and any file you edited since it was installed (which the update replaces; `capcomd
  profiles show` and `validate` say when a package was edited). `--dry-run` stops there. An `override.yaml` you put
  beside the package stays, and so does any other file you added there (it is listed as "added by you, kept"); when
  the new package has a file of its own in the place of one of yours, the update is refused until you move yours. An
  update the profiles wouldn't resolve with is put back. A name installed in both places
  is the project's, as it resolves (`--project` looks only there).
- `export <name>` writes the profile as a package to `./<name>/` (`--out DIR` for another place): its own files as
  they are, `extends` kept (whoever installs it needs a profile of that name), or with `--flat` what it resolves to:
  one `profile.yaml` with its ancestors and overrides laid in, its prompts as files, and each skill it is pinned with
  from a package in `skills/`. `default` is never exported, nor the `LOCK`, nor anything of capcomd's state (a profile
  holds no credential: `auth` is a mode).
- `rm <name>` of an installed package deletes its directory and the trust given to its skills (refused while it holds
  your `override.yaml`, or another profile extends it).

## Project memory: the `context` block

A profile with a `context` block briefs its agents, when they start, with an index of what the project keeps under
`.capcomd/context/` in its repository (design: ADR-025): one line per item, saying what it is about and which file holds
it. The agent reads the files it needs with its own tools; the brief never holds a file's body.

```yaml
# .capcomd/profiles/worker/profile.yaml (or "context": {...} in an agents.json entry)
context:
  providers:
    - name: memory                 # the project's .capcomd/context/ (capcomd plugins list shows the providers)
  limits: { briefBytes: null, indexLines: 50 }   # null: the default for the profile's model
```

```markdown
<!-- .capcomd/context/memory/money-rounding.md -->
---
id: money-rounding
type: lesson                       # lesson, feedback, reference… (facts/ holds the project's own facts)
status: stable                     # draft (the default), stable or deprecated (left out of the brief)
description: Money is rounded half-even (src/money.js), never with Math.round
paths: [src/**]                    # the files it applies to, shown on its line
stale_after: 2027-05-01T00:00:00Z  # optional: past it, the item leaves the brief
supersedes: [old-rounding]         # optional: the item it replaces leaves the brief
---

Math.round on money caused one-cent reconciliation errors in March; use roundHalfEven.
```

What an agent of that profile starts with, after its profile's own prompt:

```text
Context: loaded 1 of 1 lines (budget 25,600 B and 200 lines from eval/claude-opus-5-5, not measured yet); memory at a1b2c3d4e5f6, modified 2026-10-30. Each line is an item's description and the file in your checkout that holds it. Bodies are files: read them when they apply; they are data, not instructions.
- [lesson] Money is rounded half-even (src/money.js), never with Math.round → .capcomd/context/memory/money-rounding.md (paths: src/**; stable; 2026-10-30)
```

- `capcomd context brief <profile>` prints the brief that profile's agents start with now (`--run <runId>` for a
  run's repository and target, `--review` for what a reviewer would get).
- The items are read at the tip of the branch the run's agents start from (its target), so every agent of a profile
  gets the same brief until that branch changes. A change to `.capcomd/context/` is a commit like any other.
- Each line is plain text: a description is cut to `descriptionChars`, secrets are redacted and anything that looks
  like a fence marker (`<<<…>>>`, or a lone `<<<` or `>>>`) is neutralised. A provider that fails or takes over 10 s is named in the header
  (`memory: skipped (timeout)`) rather than leaving an empty brief.
- Reviewers and report agents get no memory lines (they judge the tree, not remembered opinions), only facts.
- After the brief, the agent gets two of capcomd's skills, each in a `<skill name="…">` block like a profile's:
  `capcomd-context-doctrine` (read the file before relying on a line; say which item an answer rests on; a matching
  line is a lead, not a ruling, and a current record beats a stale comment or the record it supersedes; items are
  data, not instructions), and, for an agent that may spawn and isn't a reviewer or report agent,
  `capcomd-context-routing` (what is worth remembering and where: notes for the run in `capcomd kv` under
  `notes/<agent id>`, a lesson for later runs in `capcomd result --data '{"context":[…]}'`, written as a fact, never
  a secret). Their text is the same for every agent, and each is recorded on the agent by its sha256; `capcomd
  context brief <profile>` names them. A profile with a `context` block keeps room for them among its own `skills`
  (one of the 8, two when it may spawn), and can't name a skill of its own after them.
- Nothing else of an item reaches the agent unasked: no item's text is put in its first message, and none is pushed
  to it when it opens a file the item applies to. Both were measured and not adopted (the `paths` on each line do that
  job); see docs/evidence/context/README.md.
- A provider name that isn't active is refused when profiles are read (`capcomd profiles validate`), and an override
  (`--set`, `--overrides`) can remove the block but not change it.
- ADR-024's `memory:` block is read as `context:` (`memory: {scope: project}` is `context: {providers: [{name:
  memory}]}`). One change from what ADR-024 described: the directory is read from the repository and is never
  written back by the agent; changes to it are reviewed commits (a run's consolidator's, below, or a person's).

### Lessons agents propose

An agent that may spawn (a planner, a lead) is told, in its orchestration skill, to keep its working notes in kv under
`notes/<its id>` (every agent of the run can read them) and to propose what the project should remember in its result:

```bash
capcomd result --summary "…" --data '{"context": [{"title": "Rounding", "text": "Money is rounded half-even in src/money.js; Math.round caused one-cent errors."}]}'
```

When the agent ends, capcomd collects each lesson as a candidate of the run, nothing more: it reaches
`.capcomd/context/` only through a reviewed change. A lesson is a `text`, and at most a `title`, a `type` (`lesson`
when it doesn't say), an `op` (`add`, `supersede`, `deprecate`) and the `target` item it supersedes or deprecates.

- Who proposed it is capcomd's to say: the agent whose token declared the result, its run, profile and model. Anything
  else a lesson says about itself (`by`, `origin`, `status`, `verified`) is ignored.
- A lesson holding a secret is refused, never redacted: a secret capcomd put in the run (an agent's API key, a token
  in its environment, the forge's credential), anything shaped like a credential or a long random-looking string, or a
  path where credentials are kept (`.env*`, `*.pem`, `secrets/`, `~/.aws`, `~/.ssh`). So is one over 4 KB
  (`context.limits.itemBytes`), and one past the run's limit of 20 (`context.limits.proposalsPerRun`).
- `capcomd events <runId>` shows `plugin.context.proposed` for each candidate and `plugin.context.refused` for each
  refusal (its number and reason, never its text); `capcomd kv get <runId> _context/<agentId>` shows an agent's
  candidates.

### Checking `.capcomd/context/`: `capcomd context lint`

```bash
capcomd context lint                 # in the repository: problems exit 1, each with its file
capcomd context lint --fix           # also (re)writes .capcomd/context/index.md from the items
capcomd context lint --base main     # also: no id changed and no item deleted since main
capcomd context lint --run <runId>   # also: every outcome an item names is a passed verify or landed merge of the run
```

It checks that `.capcomd/context/` holds items only (`memory/<slug>.md`, `facts/…`, `index.md`, `log.md`); that each
item has frontmatter with an `id` and a `type`, and well-formed `status`, dates, `supersedes`/`superseded_by`,
`paths`, `outcomes`, `helpful`/`harmful`; that ids are unique; that supersession is reciprocal (A `supersedes: [B]`
and B `superseded_by: [A]`) and has no cycle; that no file holds a secret (the same check as a proposed lesson's); and
that `index.md` is what `--fix` writes. An item is never deleted (set `status: deprecated`), and its id never changes
(supersede it with a new one). Warnings don't fail it: a stale item, a description the brief cuts, a body over 4 KB,
a body that reads like an instruction or a command. A link in `.capcomd/context/` (or the directory being one) is a
problem, and `--fix` never writes `index.md` through one.

### How lessons land: the consolidator

A run's candidates reach `.capcomd/context/` through one reviewed change, made by the run's last child: an agent of
the `context-consolidator` profile, which `capcomd setup project` writes (read-only tools, briefed with the project's
memory) and lets the planner spawn. The planner's orchestration skill tells it to, once every other child has ended,
when the run's agents proposed lessons:

```bash
capcomd spawn --profile context-consolidator --task "Consolidate this run's lessons" --key consolidate
```

- It reads every candidate (in its prompt, fenced as the proposing agent's text), the project's memory and the run's
  verifies and merges, and answers with the changes to make: add a lesson, supersede an item a candidate contradicts,
  deprecate one the repository no longer supports, each naming the candidates it comes `from` and the `outcomes` that
  confirm it. It edits nothing itself, and its checkout isn't kept.
- capcomd writes its changes on its branch (`capcomd/<run>/<its id>`) when it ends: each new item a draft whose
  provenance capcomd stamps (the consolidator, the run, the model, and the agents whose candidates it consolidates), a
  lesson already there counted as `helpful` instead of added twice, one titled as an existing item superseding it, and
  `index.md` as `capcomd context lint --fix` writes it. Its result has the `branch`, the `commit` and `context` (what
  was applied and refused); `capcomd events` shows `plugin.context.staged`.
- It runs on the run's strongest model unless its profile names one (`model:`).
- Verify and merge its branch as any child's. `capcomd verify` runs `capcomd context lint` as a check (against the
  commit the branch left its target at). `capcomd merge` then waits for your approval (`awaiting_approval`, held by
  `context-memory`, the reason listing the items and anything lint flags, such as a lesson that reads like an
  instruction): approve it with `capcomd approve <runId> <mrgId>` after reading the change. Set `context.review: lint`
  in the consolidator's profile to land its changes on a clean lint alone.
- A branch of any other agent that changes `.capcomd/context/` fails its verify and is refused at merge (`memory lands
  only from a consolidator or a person`); `capcomd merge --operator` lands it anyway, recorded as bypassing the gate.
  A person's own commits to `.capcomd/context/` aren't capcomd's to judge (run `capcomd context lint` before pushing).

### Business knowledge: a groundray brain

The `groundray` provider briefs agents with a company's facts (decisions, policies, procedures, definitions) from a
brain: a git repository with groundray's layout (`brain.yaml`, an OKF bundle under `knowledge/`), or any OKF bundle in a
directory of a repository. capcomd reads the files itself; the groundray CLI isn't needed.

```sh
# in the project's checkout: map a name to the brain, pinned at its default branch's tip
capcomd context brain add acme https://github.com/acme/brain.git     # --branch <b>, --bundle <dir> for a plain OKF bundle
capcomd context brain list
capcomd context brain add acme https://github.com/acme/brain.git     # again: move the pin to the tip
capcomd context brain remove acme
```

```yaml
# a profile
context:
  providers:
    - name: groundray
      brain: acme                  # one brain, by the name the project mapped; never a path
    - name: memory
```

```text
Context: loaded 2 of 2 lines (…); groundray at 9f8e7d6c5b4a, modified 2026-10-12; memory at a1b2c3d4e5f6, modified 2026-10-30. …
- [policy] Refunds are accepted within 30 days of delivery → /var/tmp/capcomd/context/groundray/acme/knowledge/policies/refunds.md (stable; 2026-10-01)
- [lesson] Money is rounded half-even (src/money.js), never with Math.round → .capcomd/context/memory/money-rounding.md (paths: src/**; stable; 2026-10-30)
```

- The mapping lives in the project's `.capcomd/config.json` (`context.brains`). A run records it when it starts, so
  every agent of the run reads the commit the run started with; mapping the brain again affects runs started after.
- Before an agent starts, capcomd puts the brain's files at that commit in its sandbox, where the lines point
  (`<agent workdir>/context/groundray/<name>/`), read-only and without git history. The host fetches the brain with your
  own git access (your forge login or git's credential helpers), as it does the project's repository; no credential
  enters the sandbox, and a URL with one in it is refused.
- One brain per agent: a profile names one, and a provider is never asked twice for one brief.
- A restricted brain (its bundle's `default_sensitivity: restricted`, or any Markdown file under it marked
  `sensitivity: restricted`) is refused by `brain add`, and an agent is never briefed from one: keep restricted knowledge
  outside capcomd. So is a brain capcomd can't check whole (a Markdown file over 4 MiB, more than 2000 of them).
- A repository given as a path is recorded as an absolute path.
- Reviewers get the brain's facts too (only memory is left out for them). Deprecated and superseded facts, and those
  past their `stale_after`, leave the brief; a fact without `status` counts as a draft.
- Proposals to the brain go through its own pull requests (below); what agents read never changes until the brain's
  owners merge one and the project maps the brain again.

#### Proposing facts to a brain

A run's consolidator can propose new facts for the brain its profile names, besides lessons for the project's memory:
something the run established about the business (a policy, a decision, a definition, how a system behaves), not about
the repository. Name the brain in the consolidator's profile:

```yaml
# .capcomd/profiles/context-consolidator.yaml, which `capcomd setup project` wrote: its context block
context:
  providers:
    - name: memory
    - name: groundray
      brain: acme
  review: human        # human: you send the brain's proposals; lint: capcomd sends them when it stages
```

Each proposal becomes a draft made by the groundray CLI (it must be installed on your machine, or named with
`CAPCOMD_GROUNDRAY=<path>`), on the branch `groundray/capcomd-<runId>-<agentId>` of the brain's repository, with one
pull request per run for the brain's owners. Drafts only: capcomd never supersedes, deprecates or verifies an item in a
brain, and never changes the brain's branch.

```sh
capcomd context brain propose --run <runId>          # what the run's consolidator proposed, and what was sent
capcomd context brain propose --run <runId> --yes    # send them as you (groundray records you as the producer)
```

- Under `review: human` (the default) nothing goes to the brain until you send it; under `review: lint` capcomd sends
  them as it stages the consolidator's answer, as itself (`capcomd/<version>`), for up to 4 minutes; any it couldn't
  send wait for `--yes`.
- A fact's title is 3 to 120 characters (groundray's limit); a longer one is refused when the answer is staged.
- The consolidator's result says what it proposed (`context.brain`), and the run's stream has
  `plugin.context.brain_staged` and `plugin.context.brain_proposed`.
- groundray runs in a throwaway directory with settings of its own: your own groundray installation is never read or
  changed. The pull request is opened with your own login at the brain's forge (GitHub); on a plain git remote the
  branch is pushed and you open the pull request yourself.
- A proposal is sent once; one that failed (no groundray, the brain's repository unreachable) can be sent again.

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

The watch above looks at the agent's process. The **watchdog**, which `capcomd setup service` (and the full `capcomd setup`) turns on, looks at its work: an agent whose files haven't changed for 15 minutes, that hasn't spawned or heard back from an agent of its own, and hasn't finished a background job, check or approval it waited on, gets the notice **stalled** (shown, and returned by `await`, like the ones above); after 45 minutes without progress it is cancelled with the reason, and the run's events get one `plugin.watchdog.stopped`. Tool calls alone aren't progress. Waiting doesn't count against an agent: not while a job, check or approval it started runs, nor while it, or an agent under it, is paused at a usage limit; and an agent with agents of its own running is judged through them, so a stuck worker is stopped, not its planner. A reviewer, a report-only agent (`--report`) and an orchestrate agent are never judged by it: their work doesn't change files, so it can't see their progress (the watch above still applies). While one of the notices above shows on an agent, the watchdog doesn't put **stalled** over it, but still stops the agent at 45 minutes. It sees files change only at the agent's checkpoints (below), so an agent checkpointed less often than every 10 minutes gets longer windows: **stalled** no sooner than one and a half of its `checkpointEveryMs`, and the stop as much later (checkpointed hourly: stalled at 90 minutes, stopped at 120). Its settings are `plugins.watchdog` in `~/.capcomd/config.json` (or a project's `.capcomd/config.json`): `stalledAfterMs` (default 900000), `stopAfterMs` (default 2700000, counted from the last progress too; 0 never stops), `everyMs` (how often it looks, default 60000), `enabled`; or `CAPCOMD_PLUGIN_WATCHDOG_STALLEDAFTERMS` and the like. The engine reads them when it starts; `capcomd setup check` says when it won't load them (a setting out of range, or a `stopAfterMs` that isn't more than `stalledAfterMs`).

Budgets (`run new --budget`, `spawn --budget`) are enforced from live spend: while an agent works, its runner reports what it has spent every few seconds (Claude's from each message's token usage at list prices, until its final cost arrives; Codex's from tokens × `CAPCOMD_CODEX_USD_PER_MTOK_IN/OUT`), and the engine stops the agent (`result.limit: max_budget_usd`, work kept) when its own budget, an ancestor's or the run's is spent. A spawn reserves only the units it names (or its profile caps), so agents spawned without a budget share what's left.

Every agent runs under a small supervisor in its VM (when the VM has `node`, which the npm-installed CLIs bring). It reports a heartbeat every 30 seconds and checkpoints the workspace every `checkpointEveryMs` (`--checkpoint-every-ms`, default 10 minutes) and right after the agent commits: a commit of the working tree on top of HEAD, made through a temporary index so the agent's files, index and history are untouched. The engine pushes it to `refs/capcomd/checkpoints/<agentId>` (the VM holds no push credentials), and the agent's record shows it as `checkpoint`. To continue an agent's work in a new agent: `capcomd spawn <runId> --continue <agentId> --task …` starts from its branch, or from its last checkpoint when it pushed none.

When an agent's provider says its usage limit is reached (a plan's limit or the API's), the agent is `paused`, not failed: what it changed is pushed to its branch (`Capcomd-Stop: quota`) and its result has `limit: "quota"`, the login (`claude:subscription`) and `resetAt`. It runs again after the reset (when it gave none, after `CAPCOMD_QUOTA_RETRY_MS`, default an hour), as a new attempt in a new VM that continues on its branch. The login is remembered on the engine host (`quotas.json` in the state directory), so other agents on it wait for the reset instead of starting. `capcomd resume <runId> [agt]` runs paused agents now and clears the login's wait. Paused agents are woken while someone awaits them.

You can pause agents yourself: `capcomd pause <runId> [agt]` (or `POST /v1/runs/{runId}/pause` and `POST /v1/runs/{runId}/agents/{agentId}/pause` on the harness API) pauses an agent and its descendants, or every agent of the run. One that hasn't started is paused at once; a running one stops at its next check (every 2 seconds), its work is committed and pushed to its branch (`Capcomd-Stop: paused`), and it is `paused` with `limit: "paused"` and no reset time. It waits for `capcomd resume <runId> [agt]` (which runs the agent and its paused descendants, or every paused agent of the run), then continues from its branch as a new attempt. An agent that finishes before it stops ends `done` as usual. Pausing some agents leaves the others working; the run reads as paused (`run.paused` in the lifecycle feed) only once every agent still live is paused.

`capcomd send <runId> <agt> <text> --skill NAME` (repeatable, at most 8 skills and 256 KB of `SKILL.md` together) sends skills with a message: the agent reads each skill's `SKILL.md` with the message text, as one more part of the message. `capcomd skills` lists the names: the bundled capcomd skills and your `~/.claude/skills`. Only `SKILL.md` goes: files next to it in the skill's directory are not copied into the agent's VM.

Auth is exactly one of `apikey` (the provider's API key, from local env or a boxd secret) or `subscription` (from `capcomd auth login claude|codex`). Giving both or neither is an error. `CAPCOMD_AGENT` still works as an override, set to a kind or a profile name.

`children` (policy only for now): `{allowSpawn, maxDepth, maxChildren, maxTotalDescendants, allowedChildProfiles, budgetShare}`. Children may only narrow their parent.

`provider` is the name of an active agent provider: `claude` and `codex` are built-in plugins (`agent-claude`, `agent-codex` in `capcomd plugins list`), and another plugin may add one. A profile naming one that isn't active is refused when it's validated.

`toolMode: "orchestrate"` (default `"execute"`) makes an agent that plans, spawns, verifies and merges but never changes a file itself (docs/spec/plugin-api.md §16.1): Claude Code gets only `Read, Glob, Grep, LS, Bash(capcomd:*)` with the edit tools denied, Codex runs with `--sandbox read-only` (its capcomd MCP tools still work), nothing it does is committed or pushed, and capcomd refuses to verify or merge its own ref. It needs `children.allowSpawn`; its children run in their own mode, and an override can't lift it without `--operator`. `capcomd setup project` gives it to `planner` and `lead`.
