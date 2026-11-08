# Changelog

All notable changes, newest first. Versions follow [Semantic Versioning](https://semver.org); while capcomd is 0.x,
minor versions may break things (marked **Breaking:**). Releases are built by CI from tags (DEVELOPMENT.md).

## Unreleased

- Fixed: `capcomd profiles update <name>` no longer deletes files you added to an installed profile's directory (a
  `notes.md`, an extra file in a skill's folder). It keeps every file the package didn't install, as it keeps your
  `override.yaml`, and lists them as "added by you, kept" (`kept` in `--json`). If the new version of the package
  ships a file in the place of one of yours (on macOS, a name that differs only in case or accents counts), the
  update is refused and nothing changes: move your file and update again.
- Fixed: trusting or untrusting plugins and profile skills from the CLI while the daemon also records a trust no
  longer loses one of the two changes in `~/.capcomd/trust.json`. If another change holds the file for more than 5
  seconds, the command fails with nothing changed; run it again. If `trust.json.lock` is something capcomd didn't
  make (a directory or a link), the command says so at once: remove it.
- Fixed: writing a profile file, `agents.json` or `trust.json` never writes through a link a repository placed next
  to it under the name of the temporary file capcomd used.
- Fix: an in-process plugin's `ctx.events.subscribe` now delivers events, and `ctx.events.replay` works. In the daemon
  a subscription to `daemon` or a run id gets that stream's events (the ones `GET /v1/events` lists) in order, one at a
  time, filtered by `types` if you give them, from `after` or else from now; a handler that throws is logged and that
  event skipped. Outside the daemon both now fail with `unsupported` instead of `subscribe` quietly never calling your
  handler. In the test kit, `fakeContext(...).publish(event)` puts an event on the fake's streams: your subscriptions
  hear it by the same rules and `replay` returns it.
- Fix: a profile with `permissions: {report: false}` is now never spawned to report, even when a plugin's
  `agent.spawning` listener adds `report: true` to the spawn's contract. Such a spawn is refused with reason
  `report_not_allowed`, the same as when the spawner asks for `--report` itself. For plugin authors: an
  `agent.spawning` patch may no longer add `from`, `review`, `checks` or `orphansPolicyOverride` to the contract (only
  `--continue`, verify and the operator set them), and a `report` it adds must be `true` and a `check` one of the run's
  check names; such a patch is refused like any other widening or invalid patch, and a check the run doesn't have
  refuses the spawn.
- Fix: a plugin you install, or a project's, can no longer read capcomd's own keys through a secret reference. A
  reference that names one of capcomd's variables (`BOXD_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, any `CAPCOMD_*` or its
  old `RELAY_*` spelling, `GIT_*` or `RIVET*`, and the agents' `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*` and `CODEX_*`, in
  any case) or its keychain items (`keychain:capcomd…`) is refused, whether it is the plugin's own default, in your
  `~/.capcomd/config.json` or in `CAPCOMD_PLUGIN_<NAME>_<KEY>`: the plugin doesn't start (`capcomd plugins list` shows
  it failed, `config_invalid`, naming the setting) and the variable is never read. Give the plugin a variable of its
  own instead: `export GH_NOTIFY_TOKEN=…` and `"plugins": {"<name>": {"token": {"$secret": "env:GH_NOTIFY_TOKEN"}}}`.
  `capcomd plugins validate <dir>` flags such a default and `capcomd plugins trust` marks the reference as refused.
  capcomd's built-in plugins keep theirs (`sandbox-boxd` still reads `BOXD_API_KEY`).
- Fix: a lesson an agent proposes, or an item `capcomd context lint` checks, can no longer slip a secret past the
  check with an invisible character (a variation selector, a combining mark, a Hangul filler) or by wrapping it over
  two lines or spacing it out. Secrets you give your own or a project's plugins (`plugins` in
  `~/.capcomd/config.json`, or a `CAPCOMD_PLUGIN_<NAME>_<KEY>` variable) are checked for as well as the built-ins', and
  so are GitLab, npm, Hugging Face and Google OAuth tokens. `capcomd context lint` now fails on a
  `.capcomd/context/` with more than 2000 files (it reads that many) instead of passing without reading the rest.
- Fix: `capcomd context brain add`, and every agent briefed from a brain, now see a restricted marking however its YAML
  is written (a quoted `"sensitivity"` key in any case, the value on the next line, as a block scalar or as an alias, a
  flow mapping, a key given twice) and in a Markdown file of any extension case (`.MD`, `.markdown`). Before, such a
  brain could be added and its files copied into agents' sandboxes.
- Changed: every agent that does work has `capcomd` in its sandbox now, workers that can't spawn too (before, only
  agents that may spawn had it, so with the profiles `capcomd setup project` writes no agent could run a background
  job). A worker can run a long command as a background job (`capcomd job start -- npm test`: its result comes back
  to it as a message), keep notes (`capcomd kv`), propose lessons for the project's memory (`capcomd result --data
  '{"context": [...]}'`), read the run's tree, and end with a summary (`capcomd result --summary`); its instructions
  say so. It still can't spawn, verify or merge (refused), and a worker that runs no commands of its own (its
  profile's allow-list has no plain `Bash` or denies it, its Codex sandbox is read-only, or the daemon's
  `CAPCOMD_AGENT_ALLOWED_TOOLS`, `CAPCOMD_AGENT_DISALLOWED_TOOLS` or `CAPCOMD_CODEX_SANDBOX` say so) gets no
  background jobs. Reviewers, `--report`
  agents and the context consolidator are unchanged.
- Changed: an agent that ends without declaring a summary gets its final message as its `result.summary` (up to
  2,000 characters), so a parent, the driver and the apps always have something to read; a reviewer's verdict is
  never used as one. `capcomd result` with nothing in it (no summary, artifacts or data) is refused instead of
  recording an empty result over the one the agent declared.
- Fixed: the watchdog no longer stops agents that save their work less often than every 10 minutes. It sees an
  agent's files change only when the agent saves a checkpoint, so with a profile's "Saves its work every"
  (`checkpointEveryMs`, `--checkpoint-every-ms`) or `CAPCOMD_AGENT_CHECKPOINT_MS` set to an hour, a busy agent got
  "stalled" between checkpoints and was stopped at 45 minutes. Now such an agent gets "stalled" only after one and a
  half of its interval without progress, and is stopped that much later too (saving hourly: 90 and 120 minutes). At
  the default interval the watchdog's 15 and 45 minutes are unchanged; a `stalledAfterMs` you set below 15 minutes
  now waits that long too, since a change can't show sooner.
- Fix: `capcomd env templates` and `capcomd env templates rm` now refuse on a sandbox that keeps no project templates
  (Docker, or none set), as `capcomd env build --project` already did. Before, `rm --repo URL` run without
  `CAPCOMD_SANDBOX=boxd` (or `--sandbox boxd`) forgot the project's boxd template and said "removed", but left its
  snapshot on boxd with nothing recording it. Run it with `--sandbox boxd` (or `CAPCOMD_SANDBOX=boxd`), or in a project
  checkout whose `.capcomd/config.json` sets the boxd sandbox.
- For contributors: the live context eval (`scripts/eval-context.ts --agents live`) and the e2e scripts that create a
  throwaway repository (`mac-e2e.sh`, `mac-subagents-e2e.sh`, `mac-agent-ops-e2e.sh`, `mac-plugin-e2e.sh`) run with
  project templates off (`CAPCOMD_PROJECT_TEMPLATES=off` unless you set it), so they no longer leave a boxd snapshot of
  8 GB or more per repository behind; with `CAPCOMD_PROJECT_TEMPLATES=auto`, remove the template afterwards with
  `capcomd env templates rm --repo URL --sandbox boxd`. The team-shape eval no longer kills itself (exit 137) at the end
  when given `--work`, and refuses a `--work` folder that isn't empty (it deletes the folder at the end), as the context
  eval does. Neither eval's end-of-run cleanup kills the shell or command that started it any more.

- New: `capcomd profiles migrate` moves the profiles in `agents.json` into profile files beside it
  (`.capcomd/profiles/<name>.yaml`, or `~/.capcomd/profiles/` for your own `~/.capcomd/agents.json`). Each profile
  resolves exactly as before (capcomd checks that before it writes anything, and changes nothing if one wouldn't), its
  version stays 1, and the default stays the default. `agents.json` stays where it is, without the moved profiles and
  with a note saying where they went; `--keep` leaves it exactly as it was (for teammates on an older capcomd: the
  profile files win, and `capcomd profiles validate` names each entry they hide), `--dry-run` says what it would write.
  A profile whose prompt is a single word ending `.md` or `.txt` stays in `agents.json` (a profile file would read it
  as a file's name), and so does one a profile file already hides; migrate says so.
- Changed: `capcomd setup project` (and setting a project up from the app) writes its profiles as profile files in
  `.capcomd/profiles/` (`worker.yaml`, `reviewer.yaml`, `lead.yaml`, `planner.yaml`, `context-consolidator.yaml`, and
  `codex-worker.yaml` when you chose both agents) instead of `.capcomd/agents.json`. `reviewer`, `lead` and `planner`
  extend `worker`, so a model or limit you set on the worker is theirs too unless they set their own; the reviewer is
  tagged `review` and may answer as a report, the planner is tagged `plan`. Every profile it writes now has the
  project's memory (`context: {providers: [{name: memory}]}`): agents start with the index of `.capcomd/context/`, and
  a reviewer sees only its facts. A project that already has profiles keeps them (an `agents.json` entry of the same
  name counts), and a profile that wouldn't work with yours (a lead extending a worker with MCP servers, say) is left
  out rather than break the others. Each file starts with a comment saying what the profile is for.
- Changed: `capcomd profiles add <name>` writes `.capcomd/profiles/<name>.yaml` in a project whose profiles are files
  (a `profiles/` folder and no `agents.json` entries, as `capcomd setup project` and `capcomd profiles migrate` leave
  it); a project with `agents.json` entries gets another entry, as before. `--default` (on `add` or `set`) moves the
  default to that profile there too, taking `default: true` off the profile file that had it.
- Deprecated: `.capcomd/agents.json` (and `~/.capcomd/agents.json`). capcomd keeps reading it for the next two minor
  releases (0.10 and 0.11); after that `capcomd profiles validate` warns about it, and a later release stops reading
  it. Move your profiles with `capcomd profiles migrate`.
- New: project templates on boxd. `capcomd env build --project` builds a snapshot per project with its whole history,
  its setup step (`CAPCOMD_SETUP_COMMAND` in the project's `.capcomd/config.json` `env`, else its lockfile's install)
  and the agent CLIs; every agent's VM then boots from it and gets only what changed since, instead of a clone of the
  whole repository. Without one (or with one it can't use) an agent clones as before and capcomd builds or rebuilds the
  template in the background (not when the branch it was built from hasn't moved), never holding up the run; it also
  rebuilds once an agent's delta passes 50 MB (`CAPCOMD_TEMPLATE_REBUILD_MB`) and daily for any project that moved (`CAPCOMD_TEMPLATE_REFRESH_HOURS`). `capcomd
  env templates` shows each template's age, size, how far behind it is and the delta an agent would get;
  `CAPCOMD_PROJECT_TEMPLATES=manual` or `off` turns the automatic builds or the templates off. Templates are capped at
  10 GB (`CAPCOMD_TEMPLATE_MAX_GB`) on top of the base image. See docs/boxd.md, "Project templates".
- Fix: a big repository no longer fails to clone after 10 minutes. The host's fetch into its mirror now fails only when
  git has reported no progress for 5 minutes (`CAPCOMD_GIT_STALL_SECONDS`), or after 3 hours
  (`CAPCOMD_GIT_FETCH_MAX_SECONDS`), and `capcomd env build` no longer gives it 15 minutes. Git bundles go to an
  agent's machine, and come back from it, 8 MiB at a time from disk (`CAPCOMD_TRANSFER_CHUNK_BYTES`) instead of whole
  in memory.
- New: a long clone, fetch or push says how far it is. Every 15 seconds (`CAPCOMD_TRANSFER_PROGRESS_SECONDS`) the
  agent's log (`capcomd logs <run> <agent>`) and engine.log get a line such as `[capcomd] git clone: uploading 120.0 MB
  of 478.0 MB (25%) to the sandbox, 5m 08s at 0.39 MB/s`, its trace span gets a `git.progress` event and the bytes
  moved (`git.bytes`), and `capcomd env build` prints the same lines.
- New: a guide to writing capcomd plugins, [docs/plugins.md](docs/plugins.md): the manifest, the hooks and how to
  answer them, settings and secrets, testing, and how to ship a plugin people install with `capcomd plugins install`.
- New: `@capcomd/plugin`, the package for writing plugins, can be published to npm with capcomd's releases, at
  capcomd's version (the release workflow does it once it is switched on). It runs on Node 20 or later as well as Bun.
  `sessionOpen()` builds a plugin process's handshake for you, and `testkit.bootWith` now works: it starts a real
  capcomd daemon in a throwaway home on the fake sandbox, with your plugin installed and running, for your own tests
  (`capcomd` from your `PATH`, or the `capcomd` option). Until it is on npm, `bun packages/plugin/scripts/pack.ts` in a
  capcomd checkout builds the package file to install.
- New: share agent profiles through git. `capcomd profiles install <owner/repo>[#<name>][@<ref>]` (a git URL or a
  local repository path works too) copies a profile package (a folder with a `profile.yaml`, its prompts and
  `skills/`) into `~/.capcomd/profiles/<name>/`, or with `--project` into the project's `.capcomd/profiles/<name>/` to
  commit, with a `LOCK` file recording where it came from, the commit and a hash of every file. Profiles are data:
  capcomd refuses a package with an executable file, one that points at a file outside its folder, and one your
  profiles wouldn't work with (it extends a profile you don't have, say). `capcomd profiles update <name>` fetches it
  again and shows which files, skills (by hash), commit and hash changed before replacing it, keeping an
  `override.yaml` you put beside it (`--dry-run` only shows); `capcomd profiles show` and `validate` say when you
  edited an installed package since. `capcomd profiles export <name>` writes a profile as a package to share (`--flat`:
  resolved into one `profile.yaml` with its skills, no `extends`; `--out DIR`), and `capcomd profiles rm` removes an
  installed one. See docs/agents.md, "Sharing profiles".
- Changed: skills in a project's profiles (`.capcomd/profiles/<name>/skills/`, which come with the repository) reach
  agents only once you trust them: `capcomd profiles trust <name>` shows each skill (description, file, hash) and asks
  (`--yes` for scripts). Until then spawning that profile is refused (`reason: "untrusted"`), and an edited skill
  needs trusting again. Your own profiles' skills (`~/.capcomd/profiles/`) and `~/.claude/skills` need no trust.
- New: a run's consolidator can propose new facts to the company brain its profile names (`context.providers: [{name:
  groundray, brain: acme}]` in the `context-consolidator` profile), besides lessons for the project's memory. Each
  becomes a draft made by the groundray CLI on the branch `groundray/capcomd-<runId>-<agentId>` of the brain's
  repository, with one pull request per run for the brain's owners; the brain's own branch, and what agents read, never
  change. Under `review: human` (the default) nothing is sent until you run `capcomd context brain propose --run
  <runId> --yes` (without `--yes` it lists them), and groundray records you as the producer; under `review: lint`
  capcomd sends them itself, for up to 4 minutes (any it couldn't send wait for that command). Needs the groundray CLI on your machine (or `CAPCOMD_GROUNDRAY=<path>`); your own groundray
  setup is never read or changed. Drafts only: capcomd never supersedes, deprecates or verifies an item in a brain.
- Fix: a background job that ended just as capcomd looked at it could be reported finished with its last output
  missing from its size; the size is now read after the exit code.
- New: install plugins from a git repository. `capcomd plugins install <owner/repo>[#<name>][@<ref>]` (a git URL or a
  local repository path works too; `#name` picks one plugin among several, `@ref` a branch, tag or commit) puts it in
  `~/.capcomd/plugins/<name>/` with a `LOCK` file recording where it came from, the commit and a hash of every file;
  the daemon runs it from its next start. capcomd refuses a plugin whose manifest points outside its folder, one with a
  link out of it, one that would run inside capcomd itself, and one made for another capcomd version, unless you allow
  that exact version with `capcomd plugins allow-version <name>@<version> --accept-risk`. `capcomd plugins update
  <name>` fetches it again and shows which files, commit and hash changed before replacing it (`--dry-run` only shows),
  `capcomd plugins remove <name>` deletes it (its data stays), and `capcomd plugins show <name>` shows one plugin with
  its settings, where each came from, and its source.
- New: a project's plugins (`.capcomd/plugins/<name>/` in the repository, or `"plugins": {"use":
  ["owner/repo#name@ref"]}` in its `.capcomd/config.json`, fetched into your home with `capcomd plugins install
  --project`) never run just because you opened the project: `capcomd plugins trust <name>` shows what would run (the
  command, its scopes and hooks, the secrets it would get, the hash of its files) and asks first (`--yes` for scripts). A changed file, or the same
  plugin in another project, needs trusting again; until then `capcomd plugins list` shows it `validated (untrusted)`.
- New: a run can set a plugin's per-run settings (the ones its schema marks `x-per-run`): `capcomd run
  --plugin-config <plugin>.<key>=<value>` (also `run new`), or `plugins` in `POST /v1/runs` (capability
  `plugins.config`); any other setting is refused before the run starts. A plugin's secrets take a reference you set in
  `~/.capcomd/config.json` (`{"$secret": "env:VAR"}`), never a value. A project's `.capcomd/config.json` can't turn a
  plugin on, turn off one that isn't the project's own (settings of it that the plugin refuses are ignored, with a
  warning, instead of failing the plugin), or set a secret; `capcomd plugins show <name>` says where each
  setting came from.
- New: lessons land in the project's memory through a reviewed merge. `capcomd setup project` adds a
  `context-consolidator` profile, and the planner spawns it as its run's last child when the run's agents proposed
  lessons. It reads the run's candidates, the project's memory (`.capcomd/context/`) and the run's verifies and merges,
  and answers with the changes to make (add a lesson, supersede an item a lesson contradicts, deprecate one); capcomd
  writes them on its branch, with the provenance capcomd records (which agents proposed each, on which model) and the
  `index.md` that `capcomd context lint --fix` writes. Its merge waits for your approval (`capcomd approve <runId>
  <mrgId>`), the approval saying what changes and what lint flags; `context.review: lint` in its profile lands it on a
  clean lint alone. It runs on the run's strongest model unless its profile names one. A run keeps at most 20 lessons
  (`context.limits.proposalsPerRun`). See docs/agents.md, "How lessons land".
- Changed: `capcomd verify` checks `.capcomd/context/` for any branch that changes it, and `capcomd merge` refuses one
  from any agent but a consolidator (`memory lands only from a consolidator or a person`): a worker that edits the
  project's memory directly now fails its verify. Have it propose the lesson in its result instead
  (`capcomd result --data '{"context": [...]}'`); `capcomd merge --operator` still lands such a branch, recorded as a
  bypass. A consolidator's branch must pass `capcomd context lint` against where it left its target.
- New: a profile file can give its agents MCP servers, its own sandbox, environment and machine size, and plugins that
  must hear them. `tools.mcp: [{name, command, trust}]` starts each server in the agent's sandbox (never on your
  machine) for Claude Code and Codex, beside capcomd's own; `trust: trusted` approves its tools up front, `untrusted`
  (the default) leaves them to the profile's tool rules. An orchestrate profile can't have any, and spawning one with
  `--set toolMode=orchestrate` is refused (`reason: "orchestrate_mcp"`). `sandbox.provider`
  runs the profile's agents on that sandbox (`docker`, `boxd`) whatever the run's is (never on your machine: a
  sandbox that runs agents on the host is refused, `reason: "sandbox_isolation"`); `sandbox.environment`
  is what their machines boot from there: `default` (the current `capcomd env build`), `image` (the provider's plain
  image) or a build's name from `capcomd env status`; `sandbox.size: { vcpu: 1 | 2 | 4 | 8 }` sizes their machines on
  boxd (Docker containers share your CPUs). `lifecycle.onStart` and `lifecycle.onEnd` name plugins that must be active
  and listening to `agent.changed`: a spawn of a profile that names one that isn't is refused (`reason:
  "lifecycle_inactive"`), and so is one whose environment its sandbox doesn't have (`reason: "environment"`).
  `capcomd profiles validate` says both before you spawn. None of these can be changed with `--set` or by a parent
  spawning a child; agents already running keep what they started with. See docs/agents.md, "Profile files".
- New: agents propose lessons for the project's memory. A planner or lead ends with lessons in its result
  (`capcomd result --data '{"context": [{"title": "…", "text": "…"}]}'`, which its orchestration skill now teaches,
  along with keeping working notes in kv under `notes/<its id>`), and capcomd keeps each as a candidate of the run,
  attributed to the agent that declared it whatever the lesson says about itself. A lesson holding a secret (one capcomd
  put in the run, anything shaped like a credential, a path like `.env` or `~/.aws`) is refused, never redacted, and so
  is one over 4 KB. `capcomd events` shows `plugin.context.proposed` and `plugin.context.refused`; `capcomd kv get <runId>
  _context/<agentId>` shows an agent's candidates. Candidates reach `.capcomd/context/` only through a reviewed change
  (the next step). See docs/agents.md, "Lessons agents propose".
- New: `capcomd context lint` checks a repository's `.capcomd/context/`: items only, each with an `id` and a `type` and
  well-formed fields, unique ids, reciprocal supersession without cycles, no secrets, and an `index.md` that matches the
  items (`--fix` writes it). `--base <ref>` also refuses a changed id or a deleted item; `--run <runId>` checks that the
  verifies and merges an item cites are that run's. Problems exit 1, each naming its file. A link in the directory is
  a problem, and `--fix` never writes through one.
- New: business knowledge from a groundray brain. `capcomd context brain add <name> <repo>` maps a brain (a git
  repository with groundray's `brain.yaml` and `knowledge/`, or any OKF bundle with `--bundle <dir>`) to a name in the
  project's `.capcomd/config.json`, pinned at its branch's tip (run it again to move the pin; `capcomd context brain
  list|remove`). A profile with `context: {providers: [{name: groundray, brain: <name>}]}` briefs its agents with one line
  per fact of that brain (a decision, a policy, a definition…), and each agent finds the brain's files at that commit in
  its sandbox, read-only, where the lines point. A run reads the commit the brain was pinned at when the run started.
  A restricted brain (`default_sensitivity: restricted`, or any file under its bundle marked restricted) is refused by
  `brain add` and never briefed, as is one too big to check (a file over 4 MiB, more than 2000 files); a URL with a
  credential in it is refused. Reads need no groundray CLI. See docs/agents.md, "Business
  knowledge: a groundray brain".
- The context brief names a provider a profile lists twice once (`skipped (named twice)` for the other), and a line's
  file path may now be up to 320 characters.
- New: `capcomd profiles set` changes any profile where it is defined: a profile file (`.capcomd/profiles/<name>.yaml`,
  `<name>/profile.yaml`, the same in `~/.capcomd/profiles/`) as well as an `agents.json` entry, with the same flags plus
  `--set path=value` (`--set limits.maxTurns=40 --set tags=review,security`). A YAML file keeps its comments and its
  `version` goes up by one. A change that would leave a profile unreadable, or that an `override.yaml` would hide, is
  refused and writes nothing. `capcomd profiles add <name> --extends <parent>` writes a new profile file; `rm` removes
  a single profile file too (not a package directory, nor a profile another one extends). Before, `add`, `set` and
  `rm` only edited `agents.json`. See docs/agents.md.
- New for apps (capability `profiles.edit`): `GET /v1/profiles/{name}` serves one profile as rows to render and edit
  (each value with its type, the file that sets it and whether it can be changed there; never a prompt's text), and
  `PUT /v1/profiles/{name}` changes them, with a token that has the `configure` scope, an `Idempotency-Key` and the
  profile's `rev`. Each change is a `profile.changed` event on the daemon stream. The menu bar app doesn't edit
  profiles yet.
- New: triggers. capcomd can start a run from something that happens outside it: a schedule you set, or a comment on
  a GitHub issue or pull request. Nothing runs until you say who may ask: in `~/.capcomd/config.json`,
  `"triggers": {"sources": {"<source>": {"allowed": [...], "opened": [...], "mode": "observe", "project": "/path"}}}`
  allows actors by their id at that source (a GitHub login, `schedule:<name>`), or anyone on threads you open
  (`"opened": ["acme/app#*"]`). A request from someone allowed that addresses capcomd (a GitHub comment with a line
  starting `/capcomd`, a schedule's fire) starts a run on `project` (else the daemon's repository) with its text as
  the goal (checked as a goal you type is: one that starts with `[agent:…]`, or is over 16 KB, starts nothing, so whoever
  wrote it can't pick the run's agent profile); one that doesn't address capcomd is only recorded while `mode` is `observe` (the default), never runs
  with `off`, and runs with `auto`. The same event twice is handled once. A run a trigger started follows its thread: later comments
  there from people reach its planner as messages, until 14 days after the run ends (at once when you stop it).
  `capcomd triggers log [--source S] [--limit N]` shows what happened to each trigger (and what would have run), and
  `capcomd triggers subscriptions` the threads runs follow; the daemon stream has `trigger.received`,
  `trigger.subscribed` and `trigger.unsubscribed`, and a started run's `trigger` says where it came from (capability
  `triggers`). Schedules: `"plugins": {"source-schedule": {"schedules": {"nightly": {"text": "update the
  dependencies", "everyMs": 86400000}}}}` (or `at` for once), allowed as `schedule:nightly`. GitHub comments:
  `"plugins": {"forge-github": {"sourceRepos": ["acme/app"]}}`, read every minute with your GitHub login (comments
  from before you set it are not read; an @-mention of that login addresses you, not capcomd, unless you set
  `"sourceMentions": true` for a login that is capcomd's own account). Plugins can add their own sources (`ctx.triggers`) and turn a trigger down
  (the `trigger.admitting` hook).
- New: built-in plugins take settings from `~/.capcomd/config.json` (`"plugins": {"<name>": {…}}`, and
  `"enabled": false` to turn one off) or from `CAPCOMD_PLUGIN_<NAME>_<KEY>` environment variables.
- New: your own plugins, run as separate programs. A plugin in `~/.capcomd/plugins/<name>/` (a `plugin.json` with
  `entry.runtime: "process"`) is started by the daemon, gets only `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`,
  its manifest's `env` and a token of its own (never your keys, GitHub token or boxd key; its own secrets arrive once
  when it connects, each from the variable you point it at in `plugins.<name>.<key>` of `~/.capcomd/config.json`:
  a default reference in a plugin's own manifest is ignored, so it can't pick which of your variables it gets), and
  can listen to capcomd's hooks: it can deny or hold a merge, deny a verification, or watch runs
  and agents. It hears what the daemon runs: every merge, and the verifications, spawns and approvals your agents ask
  for or the harness API makes; one that `capcomd verify`, `spawn` or `approve` or the driver's MCP tools run in their
  own process doesn't reach it yet. If it crashes while deciding, the decision is a deny, and it is started again (and
  anything it started that still runs is stopped); after five crashes in ten minutes it stays stopped and its gates
  deny until you start it again with `POST /v1/plugins/{name}/enable` (or turn it off with `/disable`). What it prints
  goes to the daemon's log with its token and secrets blanked out.
  `capcomd plugins list` shows it with `runtime: process`. Such a plugin contributes hooks and events only (no
  commands, tools or sandboxes), and a CLI never starts one. The client library `connect()` in `@capcomd/plugin` does
  the talking; the plugin API spec §9 is the protocol.
- New (harness.v1, capability `plugins.protocol`): the out-of-process protocol's routes (`/v1/plugins/{name}/sessions`,
  `/hooks` as an event stream, `/hooks/{callId}`, `/events`, `/storage`), usable only with the token capcomd made for
  that plugin, and `plugin.process_changed` events on the daemon stream. Capability `plugins` adds
  `GET /v1/plugins/{name}` (a plugin's manifest and config, never a secret) and `POST /v1/plugins/{name}/enable` and
  `/disable` (the configure scope; for the daemon's life, and a built-in can't be disabled).
- New: project memory for agents. A profile with a `context` block (`context: {providers: [{name: memory}]}`, in
  `profile.yaml` or an `agents.json` entry) briefs each of its agents, when it starts, with an index of what the project
  keeps under `.capcomd/context/` in its repository: one line per item (a lesson, feedback, a project fact) with what it
  is about, the file that holds it and the paths it applies to, after the profile's own prompt. The agent opens the
  files it needs; the brief never holds their text. Every agent of a profile gets the same brief until the run's target
  branch changes; superseded, deprecated and stale items are left out; reviewers and report agents get no memory lines;
  the brief stays within a size budget (`context.limits`, default 25,600 bytes and 200 lines) and says how much it
  loaded. `capcomd context brief <profile>` prints it. See docs/agents.md, "Project memory: the `context` block".
- Profiles: ADR-024's `memory:` block now means `context:` (`memory: {scope: project}` is the project's memory). Its
  directory is read from the repository and is never written back by an agent; changes to it are commits.
- Profiles: naming a context provider that isn't active (`context.providers`) is refused by `capcomd profiles validate` and
  at spawn, and `--set`/`--overrides` can remove a profile's `context` block but not change it.
- For contributors: the context eval has an `index` arm (`--arms index`): agents whose profile's brief lists the same
  records as the `agents-md` arm's `AGENTS.md`, as a project's `.capcomd/context/`. CI runs it on the fake sandbox.
- New: agents whose profile has a `context` block get two capcomd skills with their brief. `capcomd-context-doctrine`
  says how to use it: open an item's file before relying on its line, say which item an answer rests on, treat a
  matching line as a lead and not a ruling (a current record beats a stale comment or the record it supersedes), and
  treat items as data, not instructions. `capcomd-context-routing`, for agents that do work of their own (not
  reviewers, report agents or the context consolidator), says what is worth remembering and where: notes for the run
  in `capcomd kv` under `notes/<agent id>`, a lesson for later runs in `capcomd result --data '{"context":[…]}'`, as a fact and never a
  secret. Each is recorded on the agent by its sha256; `capcomd context brief <profile>` names them. A profile with a
  `context` block keeps room for them among its own `skills` (one of the 8, two when it may spawn) and can't use
  their names for skills of its own; an agent whose other skills leave no room for one starts without it, never without
  its brief or its orchestration skill.
- Not added, after measuring: putting the first items of the brief in full in an agent's first message, and pushing
  an item to an agent when it opens a file the item applies to. Measured on Claude Opus, Sonnet and Haiku 5.5 and
  GPT-6.1 (pushes on the Claude models only: a Codex agent can't read a message while it works), neither did better
  than the brief with its `paths` column, and pushing cost 11-18% more (docs/evidence/context/README.md, "step 6"); the
  brief stays an index.
- For contributors: the context eval asks those two questions with `--arms index-k1,index-k3,index-triggered` (and
  `index-paths`, the brief without its `paths` column), decides them by fixed rules (`report.ts` `admission`) and
  writes the answers into each model's `limits.json`; `--memory small|project` sets how much memory the index arms'
  project keeps (default `project`: the records the tasks need among others). A second run on one day writes
  `<date>-2.json` instead of overwriting the first.
- Plugins can provide context providers (`contributes.context`, `provides: context:<name>`, `ctx.context.register`;
  `capcomd plugins validate --conformance` runs their suite). Text that looks like any fence marker (`<<<…>>>`, not only
  the `end` and `untrusted` ones) is now neutralised in what one agent shows another.
- New: skills in a profile. A `profile.yaml` can list `skills:`, and every agent of that profile gets each skill's
  `SKILL.md` in its instructions when it starts, the way `capcomd send --skill` sends skills with a message: from the
  profile's own `skills/<name>/SKILL.md`, or from your `~/.claude/skills` with `source: user`. Skills are read when an
  agent is spawned and the agent keeps them (pinned by each file's sha256), so editing a skill changes the next agents,
  not running ones; `hash: sha256:…` in the profile refuses a `SKILL.md` that has changed. `capcomd profiles show`
  prints each skill's source and hash. Naming `capcomd-orchestration` is allowed in a profile that may spawn, and its
  agents still get it once. See docs/agents.md, "Skills in a profile".
- The skills an agent gets when it starts (the orchestration skill, a plugin's) are now each in a `<skill name="…">`
  block in its instructions, as a message's skills are; their text is unchanged.
- New: a watchdog for agents that keep busy but get nowhere. It watches the work, not the process: an agent whose
  files haven't changed for 15 minutes, and that hasn't spawned or heard back from an agent of its own or finished a
  background job, check or approval it was waiting on, gets a "stalled" notice (the amber hand in the app; its parent
  agent sees it too), and after 45 minutes without progress it is stopped, with one line on the run's stream saying
  so. Tool calls alone don't count as progress; waiting on a job, a check, an approval or a usage limit doesn't count
  against it; a planner is judged through the agents it started, so a stuck worker is stopped rather than its planner.
  Reviewers, report-only agents (`--report`) and orchestrate agents, whose work never changes files, aren't judged by
  it, and it doesn't put "stalled" over capcomd's own "idle", "spinning" or "failing" notice.
  It is off until you turn it on: `capcomd setup service` (and the full `capcomd setup`) turns it on unless you pass
  `--no-watchdog` or turned it off yourself; `capcomd setup check` says whether it is on, and when its settings
  would keep it from loading. Tune it in
  `~/.capcomd/config.json`: `"plugins": {"watchdog": {"stalledAfterMs": 900000, "stopAfterMs": 2700000}}` (`"enabled":
  false` turns it off; `stopAfterMs: 0` never stops an agent), then restart the engine.
- New: plugin settings live in `plugins.<name>` of `~/.capcomd/config.json` and a project's `.capcomd/config.json`, or
  in `CAPCOMD_PLUGIN_<NAME>_<KEY>` environment variables; `"enabled": false` turns a plugin off. Settings its schema
  refuses keep the plugin from loading (`capcomd plugins list` shows it failed with `config_invalid`) and are recorded
  as a `plugin.config_refused` event naming each bad setting.
- Fix: capcomd clearing its own "idle", "spinning" or "failing" notice on an agent no longer takes away a different
  notice a plugin raised on it.
- New: a profile file can say who it is and what it is for, and the planner sees it. `identity.title`, `tags` and
  `sharing` (`source`, `license`) are shown by `capcomd_profiles` and `capcomd profiles list|show`, which also
  give each profile a `fit` line capcomd writes from its settings (read-only or not, model and effort, limits, whether
  it leads) and a `cost` tier for its model (`low`, `medium`, `high`). `capcomd_profiles` adds each profile's
  `capacity`: how many of it can start now, 0 while its login waits for a usage limit to reset. `permissions:
  { report: false }` keeps a profile from being spawned with `report` (refused with `reason: "report_not_allowed"`).
  A profile's `identity.title` and `identity.avatar` aren't passed to one that `extends` it. See docs/agents.md,
  "Profile files".
- Fix: a profile whose allowed tools include a plain `Bash` (any command) is no longer described as read-only (a
  reviewer) in `capcomd_profiles` and `capcomd profiles list`; a shell limited to commands (`Bash(bun test:*)`) still is.
- New: `capcomd hermes` says whether Hermes is installed and has capcomd (what `capcomd setup check` says for it), and
  `capcomd hermes add [--approvals elicit|human] [--hermes-entry-per-project] [--yes]` adds capcomd to Hermes on its
  own, as `capcomd setup agent` does: its MCP server entry, the capcomd skills, and who approves merges into protected
  branches. Both take `--json`.
- Plugins can add CLI commands and MCP tools. capcomd's own commands and tools are now registered the same way, by
  built-in plugins (`front-run`, `front-primitives`, `front-profiles`, `front-env`, `front-setup`, `front-mcp`,
  `front-hermes`; `capcomd plugins list` shows them): every command, flag, tool, tool schema and output is unchanged. A
  plugin's command answers `capcomd <name> …` with a relay.v1 envelope (printed as JSON with `--json`, else its text),
  is listed by `capcomd --help` under "Plugin commands" and shows its own usage with `capcomd <name> --help`; a
  plugin's tool is `capcomd_<plugin>_<tool>` on `capcomd mcp`, checked against its schema, and runs as the driver.
  Built-in plugins only in this version (third-party plugins come with the out-of-process runtime). `capcomd --version`
  and `--help` start faster; other commands start about 30 ms slower, the time to load the built-in plugins.
- Plugins that prepare an agent (`agent.preparing`) can now give it skills and environment variables: a skill (its
  SKILL.md, pinned by its sha256) goes after the profile's own prompt in the agent's instructions, and a variable is
  set in the agent's environment, if its name is new (never one capcomd or the agent's provider sets, nor one that
  would steer the agent: `CAPCOMD_*`, `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*`, `CODEX_*`, `NODE_*`, `LD_*`, `GIT_*`, the
  proxy and certificate variables and the like; the plugin API spec §6.6.7 lists them) and its value doesn't look like
  a secret. The orchestration skill that agents allowed to spawn get is
  now such a skill, from the built-in `skill-orchestration` plugin; agents get the same text as before.
- Forge plugins: a forge can now supply the credential capcomd's git uses on your machine for its https remotes (the
  optional `remoteCredential` method, docs/spec/plugin-api.md §7.4), so a GitLab or Gitea forge plugin can push and
  fetch with your login there. The built-in GitHub forge supplies your GitHub login for https://github.com as before;
  nothing changes for GitHub users, and capcomd still never hands the credential to your own credential helper to save.
- `GET /v1/projects/branches` `source` is now any forge's name (the forge whose service listed the branches), not only
  `github`, `git` or `local`; a client that checks it should accept other names. Where a goal branch's pull request is
  merged ("They review and merge it on GitHub", in `capcomd_goal`, `capcomd_pr_open` and the pull request's text) names
  the run's forge.
- New: `capcomd profiles`, the new name of `capcomd agents` (`list`, `show`, `add`, `set`, `rm`, `schema`,
  `validate`). `capcomd profiles show <name>` now prints where a profile comes from: the files laid together to make
  it (the profiles it `extends`, the profile, its `override.yaml` files) and, for every value, the file that set it
  (`--json`: `applied` and `values`). `list` shows each profile's layer (project, user or bundled) and `list --json`
  its `version`, `format`, `path` and files. `capcomd profiles schema` prints the JSON Schema of a `profile.yaml`
  (`capcomd profiles schema v1`: `agents.json`'s). `capcomd agents …` keeps working until the next minor release and
  says the new name on stderr; `capcomd agents list --json` still lists its rows under `agents`, and `capcomd agents
  schema` still prints `agents.json`'s schema.
- New on the harness API: `GET /v1/profiles` (capability `profiles`, the `read` scope) lists every agent profile a run
  can use, the daemon's or, with `?repo=`, a project's: each one's version, layer and files, provider, model, tool
  mode, what it does, and whether its login is there. Profiles that can't be read come back with `error` saying why.
- Fix: an `agents.json` that isn't valid JSON is reported by where it goes wrong, without quoting what is in the file
  (as profile files already were), so an error shown in the app or to an agent never repeats the file's text.
- New: agent profiles as YAML files. Put a profile in `.capcomd/profiles/<name>/profile.yaml` (or
  `.capcomd/profiles/<name>.yaml`; JSON works too), or in `~/.capcomd/profiles/` for every project, with blocks
  (`harness`, `prompt`, `tools`, `sandbox`, `limits`, `lifecycle`, `children`) instead of `agents.json`'s flat fields.
  A profile can `extends: <another profile>` and change only what differs (`null` removes an inherited value), and an
  `override.yaml` in `<name>/` adjusts a profile without copying it. A prompt can live in a file next to the profile
  (`prompt: { append: prompt.md }`). Runs, spawns, `capcomd_profiles` and `capcomd profiles list|show|validate` see
  these profiles; `.capcomd/agents.json` works as before, and a `profile.yaml` of the same name in the same project
  wins. `--set` takes the new paths too (`--set limits.maxTurns=10`). See docs/agents.md, "Profile files".
- Each agent now records which version of its profile it was started with, and where that profile came from
  (`project`, `user` or `bundled`), so an agent that outlives an edit of its profile still says what it runs with.
  `capcomd inspect <runId> <agentId>` shows it (`[worker v3, project]`), and the `--json` answers of `spawn`,
  `inspect` and `await` carry `profileVersion` and `profileSource`. For apps: `Agent.profileVersion` and
  `Agent.profileSource` on `GET /v1/runs/{runId}/agents` and the `snapshot.agents` frame, and the same two fields on
  `agent.spawned` events (both null for an agent without a profile). A profile's version is its `version:` field,
  else 1 (a whole number up to 2^53 - 1; a larger one is refused when the profile loads); `agents.json` profiles are
  version 1.
- New: background jobs for agents. An agent runs a long command (a test suite, a build) with
  `capcomd job start -- <command>` in its VM (or the `capcomd_job_start` tool): when the command ends within the
  foreground wait (60 s by default; `--foreground-ms N`) it answers with the exit code and output; otherwise it
  answers `running` with a job id at once, the agent keeps working, and the command's result arrives as a message in
  its inbox when it ends. `capcomd job output <job>`, `job list` and `job kill <job>` show and stop its jobs. Jobs run
  in the agent's own machine and keep running if capcomd restarts (their result is still delivered); they end when
  their agent ends, and after 30 minutes by default. While a job runs the agent keeps its slot and isn't flagged idle.
  A profile can set `jobs: {foregroundMs, max, afterTurnMs}` (how long a start waits, how many run at once, 8 by
  default, and how long one may run); the defaults for every agent are `CAPCOMD_JOBS_FOREGROUND_MS`,
  `CAPCOMD_JOBS_MAX` and `CAPCOMD_JOBS_AFTER_TURN_MS`. A planner or lead in orchestrate mode starts none (it runs
  nothing). Each job is on the run's stream as `job.started` and `job.ended` (`JOB_*` in `capcomd events`), and its
  record is the run's `_jobs/<id>` key. For plugins: `ctx.jobs` (start, get, list, cancel, wait) with `exec` jobs in
  an agent's machine and timers (`at`, or `everyMs` until `until`; re-armed when the daemon restarts, a missed one
  fired once), and the `job.changed` hook. See docs/spec/plugin-api.md §16.2.
- Docker's idle-container sweep now runs on the Docker plugin's own timer (when the daemon starts and every 5 minutes,
  as before); nothing changes for you.
- The key capcomd signs agents' capability tokens with now lives in the capcomd home like the rest of its state:
  `$CAPCOMD_HOME/rpc.key` when you set `CAPCOMD_HOME` (and `.relay/rpc.key` in a checkout of capcomd), instead of
  always `~/.capcomd/rpc.key`, so a second home no longer signs with (or creates) your main home's key. An installed
  capcomd without `CAPCOMD_HOME` is unchanged: the key stays `~/.capcomd/rpc.key`. `CAPCOMD_RPC_KEY_FILE` still names
  another file.
  If you use `CAPCOMD_HOME`: after upgrading, the daemon makes a new key there when it restarts (the old key is not
  copied over; `~/.capcomd/rpc.key` is left as it is). An agent still running across that restart gets a new
  token as soon as capcomd picks it up again; a capcomd call it made with its old token in between fails once with
  "token rejected: bad_signature" and works when tried again.
- New for contributors: `scripts/eval-context.ts`, the context eval (ADR-025 §12). It generates a fictional company
  and its repository from a seed and runs agents through capcomd on five kinds of task (a fact one agent finds and the
  next needs, a convention learned in one run and needed in the next, a superseded business rule, a stale fact in the
  code, an instruction planted in a data file), scoring each with a hidden check on the agent's branch. Today it
  compares agents given nothing with agents given an `AGENTS.md`; later arms add capcomd's context layer. Results per
  model, from live runs on Claude Code and Codex, are in `docs/evidence/context/`; CI runs it on the fake sandbox.
  See DEVELOPMENT.md, "Context eval".
- Traces: an agent's span now also records how many of its input tokens were cache reads
  (`gen_ai.usage.cache_read.input_tokens`) and the model its CLI reported running (`gen_ai.response.model`, Claude
  Code), when the CLI says.
- Security: your git credentials never reach an agent's sandbox any more. Before, capcomd's own git commands in an
  agent's VM or container (cloning its checkout, pushing its branch and checkpoints, `capcomd fetch`) ran with your
  GitHub token, so an agent could take it by planting git settings, a hook or a `git` program in its sandbox. Now
  capcomd fetches and pushes for the agent from your machine, by the repository's URL, and moves the commits in and
  out of the sandbox as files; nothing in the agent's checkout decides where a push goes. On your machine capcomd runs
  git with credentials only in repositories it made itself (a mirror per repository next to its clones, under
  `~/.capcomd/work`), and refuses one whose git settings or hooks something else changed; the first merge after
  upgrading makes its clones again. For https://github.com, capcomd uses your GitHub login (`GITHUB_TOKEN`, `GH_TOKEN`
  or `gh auth login`) and never hands it to your own credential helper to save (such as the macOS keychain); without a
  login, and for other remotes, your own git credentials (credential helper or ssh key) are used. `capcomd fetch` no
  longer refuses a checkout because of its git settings. A check that runs on your machine (`CAPCOMD_CHECKS=host`) and
  changes capcomd's clone's git settings now fails the merge. See docs/spec/plugin-api.md §11.7.
- A Codex agent whose stream reconnected mid-turn ("Reconnecting... 1/5 (stream disconnected before completion)") and
  then finished is no longer marked failed with its work dropped: an error Codex recovers from is not the run's error.
  A failed turn, or an error the stream ends on, still fails it. Checked against Codex 0.166 as well as 0.163.
- A verify whose reviewer couldn't be run because capcomd's engine didn't answer one of the reviewer gate's calls no
  longer fails at once as if the reviewer had said no: the gate tries again within the verify's deadline (4 tries;
  `CAPCOMD_REVIEW_INFRA_TRIES`), and the reviewer's verdict decides. When it still can't, the verify fails with "the
  reviewer couldn't be run: <the error>" and `result.review.retryable: true` (no verdict was given: verify again),
  instead of "review failed: An internal error occurred".
- Errors from capcomd's engine now carry their own text everywhere (CLI, MCP tools, the harness API, a verify's
  record, agent failures) instead of "An internal error occurred", with code `internal` for a failure inside the
  engine as opposed to a refusal.
- `scripts/eval-team-shape.ts` keeps the engine's log (`engine.log`) in its scratch folder, for `--keep`.
- New: `capcomd check <runId> [<branch|agt>]` runs the run's checks on that branch's commit as it is (default: the
  run's target, so the combined code after its merges), in a fresh sandbox like `capcomd verify`, and prints the full
  output and pass or fail. It merges, integrates and reviews nothing. Pick one of the run's named checks with
  `--check NAME` (or a command of your own with `--checks CMD`); show an earlier check again with `--id chk-…`. The
  driver gets it as `capcomd_check`, and agents that lead or plan get it in their VM (`capcomd check`, or the
  `capcomd_check` tool), so a planner or lead that runs nothing itself can see whether the combined code works. The
  same commit checked with the same command is one check (asking again, or two agents asking at once, gets that
  check); `--key` checks it again. On Docker a check waits for a free agent slot like an agent does. Each check is on
  the run's stream as `check.started` and `check.passed` or `check.failed` (`CHECK_*` in `capcomd events`), and
  `capcomd await` / `capcomd_await {ops}` take its `chk-…` id.
- **Breaking:** a planner or lead in orchestrate mode that changes files or commits in its checkout now fails, naming
  the files (`result.errorKind: "orchestrate_wrote_files"`, `result.wrote`), on every provider: Claude Code's rules
  already refused its edits, but Codex's could be got past (`echo x > f`, `sh -c`). It is stopped when the turn in
  which it wrote ends. Before, what it wrote was dropped and only logged, and it could still end done. Its changes
  are still never committed or pushed, and its checkout is no longer checkpointed. If one fails this way, give that
  work to a worker it spawns.
- A merge a plugin holds for your approval now shows the files it changes, as a merge into a protected branch does:
  on the approval card in the apps (`subject.files`), on the `merge.approval_requested` event, and in `capcomd merge`
  and `capcomd approve`, which also print the plugin's reason. For plugin authors, a `merge.landing` hold can carry an
  optional `holdId` (`{decision: "hold", reason, holdId}`): once the person approves it, a later hold from your plugin
  with the same `holdId` doesn't ask them again, even if its reason changed. Without a `holdId` the hold is still
  matched by its exact reason. Approvals show it as `subject.heldBy.holdId`.
- An agent whose daemon restarted under it no longer loses one of its three attempts when the restarted engine is
  still getting ready: its attempt runs again without a `DRIVE_FAILED` event, as after any other restart.
- When a plugin holds a merge for your approval, the approval now says which plugin held it and why: in the question
  and `subject.heldBy` the apps show, in `capcomd approve`'s output, in the prompt `capcomd_approve` asks under
  `driver.approvals: "elicit"`, and as `heldBy` on the `merge.approval_requested` event. Approving satisfies only that
  plugin's hold: approving a merge into a protected branch no longer also lets a plugin's later hold through unseen;
  the merge waits again, showing the plugin's reason, and lands on your second approval. Each park and approval is
  now its own event, so the approval shows as pending again. For plugin authors, each re-asked `merge.landing` is a new
  attempt with its own `idempotencyKey` (`merge.landing:<mrg>:2`, …), and a `run.creating` patch can only pick a
  sandbox an active plugin provides.
- Denying a merge a plugin held no longer leaves it looking in flight: its verification record ends as failed, and the
  engine stops reporting it as an in-flight verification each time it wakes.
- Plugins watching runs, agents, verifies, merges and approvals (the `*.changed` hooks) are now told who caused each
  change: the agent for its own work, the parent agent that spawned it, the agent that asked for a verify or a merge
  from its VM, or the person who approved, paused or cancelled, instead of always the operator. A plugin that stops
  listening and starts again is told only what changes from then on, not what happened in between.
- Every event type follows one pattern, published with the event envelope (`type` in `openapi/capcomd.json`,
  docs/events.md): capcomd's own are dotted lowercase (`run.created`, `plugin.loaded`), and a plugin's own are
  `plugin.<plugin>.<event>`, hyphenated plugin names included (`plugin.gate-reviewer.verdict`). Only that plugin
  writes them, and it can now write them on a run's stream as well as the daemon's: apps read them back from
  `GET /v1/events` and the run's stream with the plugin's own sentence as `text` (plain text, like an agent's).
- The reviewer is now a built-in plugin, `gate-reviewer` (listed by `capcomd plugins list`), one judge of a verify
  beside the checks: a verify passes only when the checks, the run's reviewer and every other plugin judge pass, for
  the same tree. Reviews work as before (`run new --reviewer`, `verify --review-profile`), from the CLI, the MCP
  server and agents alike; a verify's result gains `judges` (each judge asked, and which one refused it). A reviewer
  now gets at most an hour for its verdict (before, a reviewer profile without `timeoutMs` could be waited on forever).
  `capcomd merge --operator` still lands past plugin vetoes, now asking every landing plugin and recording each one
  that vetoed as a `plugin.gate_bypassed` event on the run (`PLUGIN_GATE_BYPASSED` in `capcomd events`); a plugin that
  denies or holds a verify or a merge is recorded as `plugin.gate_denied` (`PLUGIN_GATE_DENIED`).
- capcomd's sandboxes are now its first built-in plugins: `sandbox-docker`, `sandbox-boxd` and the test fakes
  (`sandbox-fake`, `sandbox-fake-host`, never shown to apps). Runs, logins and environments work as before, and
  `capcomd plugins list` shows the four. New: `capcomd plugins validate [<dir>|<name>] [--conformance] [--json]` checks
  a plugin's manifest (a directory, or a built-in by name; every built-in with neither), and with `--conformance` loads
  it and runs its sandbox's conformance suite against the real backend (for `sandbox-docker` that makes and removes
  containers in your Docker; for `sandbox-boxd`, VMs in your boxd org). The boxd key is still read from
  `BOXD_API_KEY`, the keychain or the credentials file `capcomd setup` wrote.
- Claude Code and Codex are now plugins: `capcomd plugins list` shows `agent-claude` and `agent-codex`, and a
  profile's `provider` is the name of an active agent provider (`claude`, `codex`, or one another plugin adds). A
  profile naming a provider that isn't there, or whose plugin the daemon has disabled, is refused when it is
  validated (`capcomd agents validate`, reading the agents file), with the providers you can use. In
  `capcomd agents schema`, `provider` and `effort` are strings checked against the provider rather than fixed lists.
  `capcomd plugins validate <plugin> --conformance` now runs the agent provider suite too (no agent CLI is started).
- New profile field `toolMode: "orchestrate"` (default `"execute"`) for agents that plan and route but never code: an
  orchestrate agent sees everything and runs nothing. It can read and search every file, use read-only git (`fetch`,
  `log`, `show`, `diff`, `status`, `branch -a`, `ls-tree`, `blame`, `grep`, `git switch --detach origin/<branch>` to
  read a branch) and every capcomd read (status, tree, events, logs, inspect, verify and merge reports with their full
  check output). It can't edit files, commit, merge, rebase, push, install packages, or run builds, tests or the
  program: checks run at verify and merge, and it reads their results. Claude Code enforces it with allow and deny
  lists, Codex with command rules (its own read-only sandbox can't fetch and can't start in Docker); anything an
  orchestrate agent writes anyway is never committed or pushed, and its log says so. capcomd refuses to verify or merge
  its own ref ("an orchestrate agent has no work of its own"), and one that finishes without spawning any agent now
  ends failed ("spawned no agents, so nothing it did can land"), so a run whose planner was blocked no longer reports
  success. It needs `children.allowSpawn`, and an override can't turn it back to `execute` without `--operator`.
  `capcomd setup project` writes it on the `planner` and `lead` profiles, with a `description` saying what it means;
  `capcomd agents list` and the `capcomd_profiles` tool show each profile's `toolMode`, and the planner's brief, the
  orchestration skill and the MCP server's instructions tell whoever briefs a lead or planner not to give it work that
  needs running code. Profiles you already have are kept as they are.
- New in-agent command `capcomd fetch [branch…]` (and the `capcomd_fetch` tool): fetches the latest branches into the
  agent's checkout as `origin/<branch>`, using capcomd's git credentials (so it works for private repositories, which
  an agent's own `git fetch` can't reach), for example to read the target after a merge.
- A verify's and a merge's result now say plainly whether the checks ran on the combined code: `result.combined`, with
  a line such as "checks ran on the combined code (this change on main with 1 earlier merge from this run): pass".
  `capcomd verify` and `capcomd merge` print the line, and the `capcomd_verify`/`capcomd_merge` tools put it in `next`.
- `capcomd logs <agent>` now shows the tool calls of every agent, planners and leads included (before, an agent that
  could spawn showed only its `[capcomd] <op> → ok` lines), and a call the agent's CLI refused shows as
  `refused <call>: <reason>` (Claude Code's permission denials, Codex's command rules).
- Codex agents that spawn now get the capcomd MCP tools approved up front; before, an orchestrate Codex agent's
  `capcomd_*` tool calls were refused ("MCP tool call requires approval, but approval policy is never").
- Fix: Codex agents in Docker could not find `bun`, `node` or `capcomd` in their shell ("command not found"): Codex
  ran each command in a login shell, whose `/etc/profile` reset `PATH`. Codex now runs them in a plain shell.
- Merges, goal-branch pull requests and **Publish** now go through forges, built-in plugins too:
  `forge-github` (pull requests, `gh repo create`) and `forge-git` (a compare-and-swap push to any remote). Merges land
  as before; `capcomd plugins list` now lists both. Name a project's forge with `CAPCOMD_MERGE_FORGE` (for example
  `CAPCOMD_MERGE_FORGE=git` in your environment or in the project's `.capcomd/config.json` `env`); without one, a
  github.com remote or `CAPCOMD_GITHUB_REPO` uses GitHub and any other remote uses git. A forge that isn't active is
  refused when you start the run, not at its first merge: `capcomd run`, `capcomd run new` and `capcomd_run_new` say
  "merge.forge names …, which no active plugin provides" with the forges you can name, and `POST /v1/runs` answers
  422. The forge also reads a run's branches when you give no base: for a GitHub repository with your GitHub login,
  the default branch is GitHub's (else `git ls-remote`, as before), the same list the run setup screen shows. Your
  GitHub login (setup, **Publish**, the accounts you can publish as, opening a goal branch's pull request) is the
  forge's answer too, so it reads as before; `capcomd setup project` now also suggests pull requests when only
  `GITHUB_TOKEN` is set. In pr mode with no forge that has pull requests (for example with `forge-github` disabled), a
  merge now says that no active forge supports pull requests instead of asking for a GitHub repo.
- The plugin host now hears what capcomd does: runs, agents, sandboxes, verifies, merges and approvals each tell it
  their steps at the points the plugin API names (docs/spec/plugin-api.md §6.6), so a plugin will be able to watch
  them, narrow them or refuse them. Only the reviewer gate listens so far (the built-in sandboxes, agent providers and
  forges have no hooks), and for a hook no plugin listens to capcomd does no extra work.
- capcomd has a plugin host, the first step of making its providers, forges, gates and front doors plugins
  (docs/spec/plugin-api.md). `capcomd plugins list [--json]` shows the
  plugins the running daemon has (or would load, when none runs): each one's state, why it failed, its hooks and
  seams. Apps can read the same with `GET /v1/plugins` (the `read` scope; capability `plugins`), and the daemon stream
  carries `plugin.*` events (loaded, failed, disposed, version_refused, duplicate_refused, hook_failed, suspended,
  resumed).
- The window opens on **Home**: "What are we building?", the composer, and every run that's running, one line each
  (where it runs, its title, a few words on what its crew is doing, the crew's heads and how long it's been going). A
  run that asks shows its question, the files it would land with their +/−, and **Deny** / **Approve ↩** right there.
  Click a run to open it. The **Home** button at the left of the title bar (⌘0) brings Home back and takes you back
  to the project; **+** (⇧⌘N) now opens Home with the composer ready to type, and so does just typing on Home. Start
  opens the new run on its planner. Home replaces the new project column. The mic in the composer starts macOS
  dictation into the goal.
- Choose the model the planner runs on. In the window's composer, the model button lists Claude Code's and Codex's
  models, each with a note, and the effort; a provider that isn't logged in where the run would go stays listed,
  dimmed, with why. On the command line: `capcomd run <goal> --planner-model <id>` (for example
  `claude-sonnet-5-5`, or `gpt-5.6` with `--planner-provider codex`); a model its provider doesn't offer is refused
  with the list.
- `GET /v1/run-options` lists each driver's models (`drivers[].models`, capability `runs.options.models`), and
  `POST /v1/runs` takes `model`.
- In the Mac app's window, the agents' columns now always come to rest on a column edge after a slow drag with two
  fingers. Before, a slow drag could leave them 25–30 pt off the edge, with a sliver of the next column showing.
- The Mac app welcomes you the first time you open it: the capcomd bot comes on the air on your desktop, his crew pours
  out of his laptop, and the window opens around him. Then, in five short steps, it finds the capcomd command line
  tool, starts capcomd (at every login, or only now: your choice), pairs this Mac, signs in Claude Code and Codex,
  picks where agents work (Docker on this Mac or boxd in the cloud), picks a first project from the Git repositories
  on your Mac, and launches your crew on a first goal (or skip it). It shows once; finishing or skipping is remembered,
  and **Settings › General › Show Onboarding Again** brings it back. With Reduce Motion on, it opens without the intro.
  Until you've finished it, it also comes back when the app can't reach or pair with capcomd.
- Codex shows OpenAI's mark in the app (Settings, the composer, the bots' badges) instead of a placeholder glyph.
- `capcomd service install --no-login` starts capcomd in the background now without starting it at your next login.
- `GET /v1/projects/known` (capability `projects.known`) lists capcomd's projects with their checkout folders, and
  which is the default.
- The Mac app is one app now: the window with each run's agents side by side, and the menu bar item with approvals
  and notifications. Install it with Homebrew (it brings the CLI along): `brew install --cask MarvinAmador7/tap/capcomd-app`.
  Each release also has it as `capcomd-app-X.Y.Z.zip` (universal: Apple silicon and Intel). If you built the separate
  menu bar or desktop app before, delete them: this app reads the same Keychain token (macOS asks once whether it may)
  and takes over their settings.
- The menu bar panel and the window are two views of the same app. Click a project or an agent in the panel and the
  window opens on it, at that agent's column; **Open capcomd** (⌘O) opens the window, and so does clicking a
  notification. Approve and deny stay in the panel. What you focus in the window is marked in the panel. The menu bar
  item is the app's home: closing the window keeps capcomd running there, and the Dock icon shows only while a window
  is open. Settings › General has **Show in menu bar** and **Keep in Dock** (one of them stays on). Quit is in the
  panel's + menu.
- The app isn't notarized by Apple yet, so macOS blocks it the first time you open it. Click **Done**, then in **System
  Settings › Privacy & Security** click **Open Anyway** next to "capcomd" and confirm. After that it opens normally.
- The app sets itself up without a terminal: it finds the capcomd CLI, offers to start capcomd as a login service when
  it isn't running (**Start capcomd**), and connects without a token to paste. It says when it and capcomd are
  versions apart that matter, and offers **Restart capcomd** when an upgraded CLI left the old one running. Pasting a
  token still works.
- `capcomd clients pair --app <name>` makes a token for an app on this computer and prints only the token, for the app
  to keep (the Mac app runs it to connect). It has all four scopes unless you pass `--scopes`, and it revokes the token
  that app paired before. `--json` adds the client id, its scopes and what it revoked.
- Fix: in the window's new project composer, choosing a project folder (the folder chip, + › **Choose Project
  Folder…**, **Choose Another Folder…**) opens the folder panel in front. Before, a click there while another app was
  in front opened the panel behind that app's windows, so nothing seemed to happen.
- Fix: the window's driver chip opens even when no AI can drive a run where it would start (say, Local without a Local
  login). It lists Claude Code and Codex with the reason each can't run there, as the menu bar's composer does; switch
  to the other place, or run the command it names. Before, it was a name that did nothing when clicked.
- Fix: `capcomd service install` from a Homebrew install runs capcomd through Homebrew's stable `opt` path, so the
  service keeps working after `brew upgrade` (before, it pointed at the old version's folder, which Homebrew removes).
  Run `capcomd service install` once more to update an existing service.

## 0.9.0 (2026-11-03)

Drivers get much further on their own. A project's runs use its own sandbox, setup registers the project and offers
the Docker env build, and a merge of a verified commit lands in about 2 seconds when the target hasn't moved. Verifies
run side by side, `capcomd_await` waits on verifies and merges, the orchestration skill opens with team shapes, and a
`lead` profile lets parts of the work have helpers. **Breaking:** a goal-branch run you drive yourself becomes ready
only when you mark it done (`capcomd goal done`, or `capcomd_goal` with `done: true`). Checked with a live run before
the release: an Opus driver built a small project with 16 Claude agents on Docker, with no workarounds.

- Fix: verify's reviewer now judges the same code the checks test: your agent's change merged onto the target
  branch. Before, an agent branch cut before the target got code its tests need could fail review even though its
  checks passed. If the target moves during a verify, the review runs again on what the checks tested.
- Fix: `capcomd run new --key` (and `capcomd_run_new`) scopes the key to the project, so two projects whose drivers
  pick the same key get separate runs. Runs created before this keep working for their own project.
- Fix: `capcomd_setup` no longer reports "not ready" because a Codex login is missing when no profile in the project
  uses Codex, or because the plugin is missing when your agent already reaches capcomd's tools. Before a project is
  set up, `capacity` describes the sandbox your config names.
- Fix: agents' commit subjects, and the pull requests made from them, read like commit messages ("Add X" instead of
  "I added X…"). The title you give an agent with `--title` is used before the task text, and names like `printExpr`
  keep their case.
- Fix: `capcomd setup`'s env-image check respects `CAPCOMD_WORKDIR`. When `CAPCOMD_HOME` is set, clones default to
  `$CAPCOMD_HOME/work`.
- Fix: `capcomd status <runId>` for a run you drive yourself (no planner) shows its agents' state, its budget and
  spend, and its total number of events. With `--json`, `scope` includes them, and `events` counts every event of the
  run.
- `capcomd <command> --help` (for example `capcomd setup project --help`) shows that command's usage.

- `capcomd run`'s planner can now hand a part of the goal that splits further to a lead, which splits it among
  helpers and verifies and merges their work itself. New projects get this from `capcomd setup`. In an existing
  project, add `"lead"` to the planner's `children.allowedChildProfiles` in `.capcomd/agents.json`.

- The orchestration skill now starts with "Choose a team shape": a single loop, a wide fan-out, contract first then
  wide, or leads with helpers. It says which shape fits what you asked for, and has the driver check its plan before
  the first agent starts (the tree, the longest chain of steps, and how many agents can run at once).
- `capcomd setup` now writes a `lead` profile, which can spawn up to 3 worker helpers one level down and verifies and
  merges their work itself. Give a part of the work that splits into pieces to a lead, spawned with
  `children: {maxChildren: N, maxDepth: 1}`. Existing profiles are kept; re-running setup only adds missing ones.
- The `reviewer` profile that setup writes can now run your project's test runner (`bun test`, `npm test`,
  `pnpm test`, `cargo test`, …) as well as the check's own commands.
- `capcomd_setup` and `capcomd_run_new` say how many agents can run at once in that sandbox (`capacity`).
  `capcomd_profiles` and `capcomd agents list` say what each profile can do and whether it can lead (`canLead`).
- The capcomd MCP server now gives your agent short instructions as soon as it connects: the team shapes, the skill
  to load, and to start with `capcomd_setup`.
- Asking a profile that can't spawn (such as `worker`) to fan out is refused with a message that names the profile
  and what to spawn instead (`reason: "cannot_spawn"`).

- Merging a verified commit is much faster. When the target hasn't moved since the verify, capcomd pushes the verified
  commit as it is, in one round trip, with no second run of the checks. When the target has moved, the checks still
  run again first. Merge results show `timings.path` (`fast` or `full`).
- Verifies of the same target run side by side instead of one at a time, and the reviewer starts alongside the checks
  instead of after them. Set `CAPCOMD_REVIEW_PARALLEL=0` to review only after the checks.
- `capcomd_await` waits on verifies and merges as well as agents (`ops: ["vfy-…", "mrg-…"]`). With `mode: "any"`, it
  returns as soon as the first one finishes.
- Checking on a verify or merge no longer fails with a conflict. Poll it with `capcomd_verify {runId, id}` or
  `capcomd_merge {runId, id}`, or with the same key without resending `acceptance`; only a parameter you give that
  differs is a conflict. Both tools always answer with the id, and `timeoutMs: 0` starts one without waiting.
- Verify and merge results and events include `timings` (checks, review, queue, fetch, push), so you can see where
  the time went.

- **Breaking:** if you drive a goal-branch run yourself (no planner agent), it is now ready only when you mark it done,
  with `capcomd goal done <runId> --summary "…"` or `capcomd_goal {runId, done: true, summary}`. Before, it became
  ready as soon as its first agent finished, so the apps showed it ready while most of the work was still running.
- A run uses its project's sandbox (from `.capcomd/config.json`), then the one in your user config, instead of the
  sandbox the engine was started with. You can choose one per run with `capcomd run new --sandbox docker|boxd` or
  `sandbox` on `capcomd_run_new`, and the result says which sandbox the run uses and why. Set a project's sandbox with
  `capcomd setup project --sandbox docker|boxd`.
- `capcomd setup project` adds the project to capcomd's project list right away, so your agent's `capcomd_projects`
  and `capcomd_setup` see it without a restart. `capcomd setup agent --default-project` now works without Hermes.
- `capcomd setup check` and `capcomd_setup` report the sandbox the project's runs will use and where that setting
  comes from. They also run that sandbox's checks: whether Docker is running or a boxd key is set, the logins, and the
  env image.
- On Docker, setup tells you when the env image has no warm checkout of your repository, or an outdated one, and
  offers to run `capcomd env build --sandbox docker` (`--env-build` builds without asking).
- Creating a run with a goal branch no longer clones the repository, so it takes a few seconds instead of about a
  minute. A new run can reuse a goal branch left empty by a cancelled run with the same name; a goal branch with
  commits is never reused or deleted.
- When the checks can't run, for example because the image has no bun, verify says so and tells you how to fix it,
  instead of reporting "tests failed". Verify also installs the project's pinned bun when the image lacks it.
- When capcomd commits an agent's work, the commit message uses the agent's own words (its commit, summary or title),
  not the first line of its task.
- `capcomd_runs` returns within seconds even when a run is slow to answer, and lists each run's state.
- A cancelled run and its agents show as cancelled everywhere (status, TUI, run list), never as "failed" or "error".

## 0.8.0 (2026-11-03)

Local mode on Docker is now fast enough to use day to day. Each agent starts from a warm checkout baked into the agent
image instead of cloning, and only as many agents run at once as fit in Docker's memory. Desktop threads also open on
their newest messages. Checked with a live run before the release: three Claude Code agents ran on OrbStack with a Claude
plan login, two at a time, each starting from the warm checkout, and all three pushed their work.

- Desktop app: opening an agent's column shows its newest messages right away, even on very long threads (about
  50 ms instead of up to 20 s on a thread of 6,000 items). Earlier messages load as you scroll up.
- Desktop and menu bar apps: a column stuck on "Couldn't load the thread" while capcomd was unreachable now reloads by
  itself as soon as capcomd is back.
- API: a new route, `GET /v1/runs/{runId}/agents/{agentId}/thread/tail` (capability `agents.thread_tail`), returns an
  agent's newest thread items. It also returns cursors to page further back and to continue with live updates.
- Local (Docker): `capcomd env build --sandbox docker` now keeps a warm checkout of your project in the agent image:
  its full history with the dependencies installed. Each agent starts from it in place instead of cloning and copying
  `node_modules`. On a repository the size of capcomd, 16 agents get their workspace in about 3 s instead of 18 s,
  and each uses about 1.5 MB of disk instead of about 590 MB. Rebuild it when your target branch moves on or the
  lockfile changes; until then, agents clone as before.
- Local (Docker): `capcomd env status` and `capcomd doctor` show how many commits the warm checkout is behind your
  target branch, and whether the lockfile has changed (agents then clone and install their own dependencies). They
  also give the command that rebuilds it.
- Local (Docker): capcomd only runs as many agents at once as fit in Docker's memory. Choose how much memory each
  agent gets with Memory per agent in Local's details: 512 MB, 1 GB (the default), 2 GB or 4 GB. A change applies to
  the next agent that starts, and Agents at once shows the new limit right away. `CAPCOMD_DOCKER_AGENT_MEMORY_MB`
  still overrides the setting. Agents over the limit wait as pending and start as earlier ones finish. API: the Docker
  sandbox has a new `agentMemory` setting (`appliesTo: new_agents`) next to its `agentSlots` info row.
- Local (Docker): `capcomd env build --sandbox docker` now moves your Claude Code and Codex plan logins onto the new
  agent image, so their agents get the new CLIs and warm checkout without logging in again. Only the login's own files
  are copied, and the agent image itself never holds a login. If a login can't be moved, it keeps working from its old
  image, and the build says to run `capcomd auth login … --sandbox docker`.
- Fix: an agent's checkpoints no longer rewrite every unchanged file into git.
- Fix (Local): an agent that was paused, cancelled or failed before its container started no longer holds an
  agents-at-once slot for 10 minutes.

## 0.7.0 (2026-11-02)

The desktop app (build it with `apps/menubar/scripts/build-app.sh --desktop`), goal branches (a run's reviewed work
lands on a branch of its own, and you choose at the end whether to open one pull request), and agents that name their
own tabs; also everything in 0.7.0-rc.1. **Breaking:** `capcomd run <goal>` now works on a goal branch
(`--no-goal-branch` for the old behaviour). Checked with a live run on boxd before the release: a planner, two workers
and a reviewer landed a goal on its branch from `dev` with no approvals, and the pull request into `dev` opened from it.

- A goal branch's result lists each piece of work by its agent's title, in `capcomd goal`, the apps' ready card and the
  pull request's description. Work an agent continued from another (say, to fix a merge conflict) is listed once,
  under the agent that carried it on, instead of also showing the first try as "merge failed". API: each landed and
  not-landed entry of `GET /v1/runs/{runId}/goal` carries `title` and `continues`.
- Start a project from the desktop app: + (⇧⌘N) opens a new project column with the folder, the branch the work starts
  from and the goal branch it lands on, the goal, Local or Cloud, the model and its effort, and Start. A folder that
  isn't set up shows its setup steps in place. On Start the column becomes the planner's, and the crew's columns
  appear as it spawns them.
- The desktop app's project menu: click the open project's name for its goal, repos and place, then Message the
  planner (⌘L), Changes, Pause or Resume (⌥⌘P), Stop (asks first), Fold into the title bar (⌘W; a finished project
  offers Remove from the title bar, which lasts until it has news, also across relaunches) and Copy run ID. ⌘K opens a palette of these actions, the other projects, New
  project, Follow and the open project's agents by title. ⌘W folds the open project instead of closing the window.
- Agents name their own tabs. Each agent has a short title (1–4 lowercase words, e.g. "login redirect") that the
  desktop app's crew tabs and column headers, the menu bar's rows, approvals and notifications show instead of id
  fragments. Inside its VM an agent runs `capcomd title "<words>"`; a planner names its children with `spawn --title`
  and the run with `capcomd title --run`. An agent nobody named shows the first words of its task. Naming a tab
  doesn't show up in the agent's thread or activity, and an agent that can't spawn names itself with a small local
  `capcomd` that makes no extra calls (capcomd reads the name from the agent's own commands).
- Rename an agent yourself by double-clicking its tab or its column header in the desktop app, or with Rename… on
  its row in the menu bar. Your name stays until you clear it (empty the field); the agent's own name shows again
  after that. From your own harness, `capcomd title <runId> <agt> <words>` and the MCP tool `capcomd_title` name an
  agent, and `capcomd_spawn` takes `title`.
- The desktop app's column header reads "lead · login redirect · waiting on you" (no bot name), and a merge on the
  menu bar's Active card reads "Merge work from <agent> into <target>?".
- API (capability `agents.title`): agents carry `title` and `titleSource`; `PUT` and `DELETE
  /v1/runs/{runId}/agents/{agentId}/title`; new events `agent.titled` and `run.titled`; `Run.titleSource` can be
  `agent`.
- The desktop app is called capcomd: in the menu bar, its About/Hide/Quit items and the Dock. `apps/menubar/scripts/build-app.sh
  --desktop` packages it as `capcomd.app` (a regular Dock app). Its title bar shows each project by name only, without
  the clock or status line under it.
- A desktop app (`CapcomdDesktop`, a regular Dock app you can install without the menu bar one): the open project's
  agents as full-height columns that stream their threads live, each with its own message box, and an agent's ask
  docked at its column's foot (Approve ↩ / Deny; Return approves only the focused column's ask, Esc never denies).
  Other projects fold into decks in the title bar (⌘1–9); ⌃1–9 and ⌃←/→ move between agents, and a sideways swipe
  anywhere over the columns moves between them (scrolling up and down stays with the thread under the pointer). A
  merge waits on the agent that asked for it (the lead or planner merging its child's work), so its Approve/Deny
  docks on that agent's column. Follow (on by default,
  ⇧⌘F) scrolls to an agent that asks or fails, and scrolling yourself turns it off. A steer you send settles into the
  thread, and one that failed offers Retry or Discard. The window says when capcomd can't be reached (and reconnects
  by itself), when nothing is running, and when your token was refused.
- Fix: in the menu bar app, a long thread no longer opens on its oldest items and catches up over several seconds; it
  shows once it has been read.
- API: agents have `createdAt`, when they were spawned (null when unknown; older daemons omit it).
- API: a merge approval's `subject.askedBy` names the agent that asked for the merge and waits on the decision
  (`requestedBy.agentId` stays the agent whose work merges); absent for an operator's merge.
- **Breaking:** `capcomd run <goal>` with a planner (and every run the apps start) now works on a goal branch of its
  own, `capcomd/<goal-slug>`, cut from `--base` (default: the project's target, else the repository's default branch;
  never a guessed `main`). Its agents' reviewed work lands there with no approval and no pull request per child, even
  when the project merges by pull request. Pass `--no-goal-branch` to merge into the target as before.
- When the planner is done, `capcomd goal <runId>` shows the goal branch against its base, what landed (with its
  checks and review), what didn't and why, and the planner's summary. `capcomd pr open <runId>` opens one pull request
  from it into the base with your `gh` login (capcomd never merges it); `capcomd goal keep <runId>` keeps the branch
  without one. `capcomd run new --goal-branch G --base B` starts a scope on a goal branch; MCP `capcomd_run_new` takes
  `goalBranch` and `base`, and the new MCP tools `capcomd_goal` and `capcomd_pr_open` do the same (your agent asks you
  before opening a pull request).
- API (capability `runs.goal_branch`): `POST /v1/runs` takes `base` and `goalBranch` (a bad one is a 422 naming the
  `field`); runs carry `goalBranch` (its branch, base, state and pull request); `GET /v1/projects/branches` lists a
  checkout's branches for a base menu with a suggested base and goal branch; `GET /v1/runs/{runId}/goal` is the
  finished branch; `POST /v1/runs/{runId}/pull-request` and `/keep-branch` record the choice; new events
  `run.goal_completed`, `run.pr_opened` and `run.branch_kept`.
- As soon as you choose a project folder, the menu bar's composer shows the branch your run's work lands on and the
  branch it starts from: the starting branch is preselected from the project, and when the project doesn't say you
  pick it (never `main` by default). The branch name follows your goal as you type until you edit it, and a problem
  with either name shows under its field.
- When the planner is done, the desktop app docks a card on the planner's column with its summary, what landed and
  what didn't, and View diff · Keep branch · Open PR; the menu bar shows "Ready: <branch>" with the same actions, and
  older runs in its Recent list show a "Ready" or "Stopped" flag while their branch waits on you. Afterwards you see
  the pull request's link, or "Kept on <branch>".
- capcomd notifies you once when a goal-branch run is ready ("Ready: <branch> → <base>: 2 of 3 tasks landed") or
  stopped with some work landed ("Stopped: …"); clicking it opens the run. It follows the same Settings switch as
  finished-run notifications.
- When the planner failed or was cancelled, opening a pull request with what landed asks you first: in the apps, in
  `capcomd pr open` (y/N on a terminal, `--yes` otherwise) and for agents (`capcomd_pr_open` with `stopped: true`).
  The pull request's description then says the run stopped. API: `POST /v1/runs/{runId}/pull-request` answers 409
  `stopped` until the body is `{"stopped": true}`, and `GET /v1/runs/{runId}/goal` carries the question as
  `openPullRequest.confirm`.
- Fix: capcomd no longer guesses `main` as a project's target. `GET /v1/projects/inspect` sends `defaultBranch: null`
  when the checkout doesn't say, `capcomd setup project` suggests origin's real default branch, and running it again
  keeps the target you set instead of resetting it to `main`.

- Desktop window bench for coding agents (`apps/menubar/app/DESKBENCH.md`): `swift run -c release CapcomdDeskBench`
  hosts the desktop window on generated runs (1 to 64 agents, no daemon), drives it (open, project switch, reel steps,
  jumps, swipes, thread bursts, typing, resize, Follow), measures frames, main-thread stretches and which views
  re-rendered, judges the result against the SPEC §1 budgets, and compares builds within the machine's noise (`run`,
  `suite`, `ab`, `compare`, `profile` under Instruments, `snapshot`, `explain`; `--json` everywhere, stable exit codes).
- The desktop bench shows where a slow stretch went and what changed between builds: `run` samples the main thread's
  stack inside long stretches and `explain` prints each one's top frames (`--sampler off` to disable; `selftest
  sampler` checks it without a window); `diff A B` compares two time profiles as a call tree in ms per step. Results
  record the exact build (commit, dirty flag) even for a copied binary. `ab`, `compare` and `run --baseline` decide on
  main-thread CPU per step (`--objective instructions|frames|latency` to change it), with frame metrics as guards and
  late frames measured as ms of lateness per second. `profile` records the whole scenario, marks its results as
  profiled (never compared: exit 6), and warns that `.trace` files hold private data and must never be committed.
  The desktop app's views now live in the `CapcomdDesk` library the app and the bench both link; the app is unchanged.
- The desktop bench's `ab` is fair to both builds: it runs them in pairs with the order of each pair counterbalanced
  (`--order random|abba`, `--seed N` to redraw it), waits for a quiet machine before every run (`--quiet-wait`,
  `--quiet-busy`; it names any build running alongside), and decides on the per-pair differences. `explain` takes a
  stretch's likely causes from its sampled stacks, and the first step no longer starts inside the setup's work.
  `deskbench describe [--json]` lists the scenarios, objectives, guards, fixtures and runtime knobs; `--knob
  name=value` sets a knob (`reel.slide=ca|clip`, `build.perFrame=1..8`), results record every knob's value, and
  `ab <scenario> --a-knobs … --b-knobs …` compares two knob settings of one binary. A new `perfloop` tool
  (`tools/perfloop`: `perfloop exp new|screen|full|promote`, `champion`, `store`) keeps a ledger of experiments against the best
  build so far; `apps/menubar/app/PROGRAM.md` is the procedure an agent follows with it.
- Correctness guards for the desktop bench and perfloop: `deskbench run … --guards built-within,snapshot-diff` checks
  that the columns in view were built once the window is at rest and saves a snapshot; `deskbench snapdiff A.png
  B.png` compares two. perfloop asks both builds for the best build's guards on every pair: a build that fails one
  can't win, a snapshot unlike the best build's goes to the owner (`needsReview`), and the `burst`/`typing` isolation
  checks run before every promotion. `perfloop guards --exp ID` re-runs them; only the owner may pass
  `--guard-tolerance`.
- Bench results say why views re-rendered: each step and long stretch has `causes` (which desktop-model properties
  were set before its view bodies ran, and how many distinct columns or tabs re-ran), `explain` prints them under each
  stretch, and `perfloop causes <result.json>` prints the whole table. `profile --template swiftui` summarises the
  SwiftUI instrument's cause tables and says when the recording has none.
- `perfloop sweep step --set agents=4..64/12` measures the desktop window across a grid of crew sizes, thread lengths,
  knobs and scenario params and prints the cost curve with its fit ("ms/step grows 4.98 ms per agent (r² 0.84)");
  `--dry-run` shows the grid and an estimate, and running the same command again resumes. Generated fixtures take
  parameters (`crew@agents=32,items=200`). `deskbench fixture capture --from <socket> --run <id> --token-file <file>`
  saves a run as an anonymised fixture outside the repo, and the bench runs on it with `--fixture file:<name>`.
- `deskbench run swipe --gesture FILE` replays a recorded trackpad gesture into the desktop window's reel and reports
  how closely the content followed your fingers (position error, stalls, jerk). Record one with `deskbench
  record-gesture --name NAME` and list them with `perfloop gestures list`.
- perfloop experiments can run on a machine nobody is using. `perfloop queue add ID` and `perfloop queue run --runner
  local|ssh://user@host --until HH:MM` run queued screens and fulls. `local` waits until this Mac has been idle
  (`--idle 120`) and redoes a rep you interrupt. `ssh://` copies the build to a spare Mac and opens the window in its
  logged-in session, waiting while its screen is locked. Results record their runner and machine and are never
  mixed; `perfloop runner check R` shows a runner's state.
- Fix: deskbench's scene-hosted runs (the default) opened a second desktop window and measured both, so earlier
  numbers were about twice one window's cost. Compare new results only with results recorded after this fix.
- Fix: an agent whose engine restarted (a crash, a killed `capcomd serve`) while the engine was starting, provisioning
  or wrapping it up no longer stays "running" for up to an hour: it resumes by itself within seconds of the engine
  coming back, and whoever awaits it (you, or a parent agent's `capcomd await`) gets its result.

## 0.7.0-rc.1 (2026-10-29)

Release candidate: agents driven by a durable workflow inside the engine (no process per agent) that ride out a
sandbox provider outage, Rivet 2.3.31 with the engine's data under capcomd's home, and in the menu bar app: bots, run
titles, threads, Settings and the sandbox surface (place details, idle lifetime, Delete for machines left behind).

- The menu bar's Recent list shows each run by its title instead of "Done", with how it ended as an icon by its time
  (merged, done, merge denied, merge failed, failed, stopped; hover it, or ask VoiceOver, for the words). The title is
  the run's label when you (or the agent that started it, through `capcomd_run_new`) gave it one, else the title of
  the pull request its work merged as, else a short form of the goal ("Add a multiply(a, b) function to
  src/math.ts"), and it changes to the pull request's title once that lands. The goal shows under the title only when
  the title doesn't already say it; hover a cut title for all of it. Active cards and the run view use the same titles.
  The harness API's runs carry it as `title` and `titleSource`.
- Fix: a sandbox provider outage of up to 10 minutes (boxd's API not answering, Docker's daemon restarting) no longer
  fails running agents. They wait for their machine and carry on: an agent working in its VM keeps working, and the
  agent shows a "sandbox_outage" notice while it waits, cleared once the provider answers. Calls that are safe to
  repeat (looking up or creating a machine, uploads, renewals, deletes) are tried again with backoff; a command is never
  run twice. An outage longer than that fails the agent with `errorKind: "sandbox_unreachable"` and `retryable: true`
  in its result ("the sandbox provider (boxd) didn't answer for 10 min …"), so you can run it again once the provider
  is back. Set `CAPCOMD_SANDBOX_OUTAGE_MS` where `capcomd serve` runs to wait longer or shorter. Permanent errors (a
  rejected key, a machine that doesn't exist, a quota) still fail at once.
- Fix: an agent that fails no longer leaves its machine running until its idle lifetime runs out: it is deleted when
  the agent fails. A delete the provider doesn't answer is tried again, with backoff, until the machine is gone.
- Docker not answering ("Cannot connect to the Docker daemon") is now treated as an outage capcomd waits out, as
  above, instead of failing the agent at once.
- Fix: listing runs no longer creates empty runs in the engine. When your run list (`state/runs.jsonl`) names a run
  this engine doesn't have, for example one a test engine on another port recorded, the menu bar, the harness API and
  `capcomd_runs` show it as "unknown" with no agents. Before, every listing (twice a second while the menu bar is open)
  quietly created an empty run in the engine for it. Reading such a run's agents, events, thread or approvals no
  longer stalls for seconds either.
- The live end-to-end scripts (`scripts/mac-subagents-e2e.sh`, `scripts/mac-agent-ops-e2e.sh`) keep their runs out of
  your run list, so the menu bar no longer shows them. They write their own index in the run's work folder and still
  use your logins, environments, boxd key and settings. To do the same, set `CAPCOMD_RUNS_INDEX` to a file of your own.
- `capcomd serve` now opens the harness API only once its actors can answer, waiting at most 30 s. Before, the menu
  bar's first requests after a restart could arrive before the actors were up and fail with warnings in the engine log.
- Fix: a project's settings are looked for from the current folder up to your home folder and no further, even when
  `HOME` points somewhere else (a test or an agent's scratch home); capcomd's own `~/.capcomd/config.json` was read as
  a project's `.capcomd/config.json` then, so its sandbox and repository settings applied where they shouldn't.
- Agents are now driven by the engine itself: each agent runs as a durable workflow inside `capcomd serve` instead of a
  separate `capcomd agent-drive` process per agent. An agent carries on by itself when the engine restarts (nothing has
  to `await` it to get it going again), a usage-limit pause wakes at its reset from the engine, `capcomd await` waits
  for change events instead of polling, and a dozen running agents no longer cost a dozen extra processes. The settings
  that change how an agent runs (`CAPCOMD_SPAWN_EXEC`, scripted agents' `CAPCOMD_SCRIPT_*`, the agents file) are taken
  from the shell that spawned it, as before. If something goes wrong, start the engine with
  `CAPCOMD_AGENT_WORKFLOW=0` to get the old per-agent processes back (this escape hatch is kept for one release);
  set it where `capcomd serve` (or the background service) runs: every command follows the engine's mode and says so
  if its own setting differs. Design and limits: docs/adr-022-agent-lifecycle-workflow.md.
- capcomd's engine data now lives in capcomd's own folder: `~/.capcomd/engine/<port>/db` (or `$CAPCOMD_HOME/engine/<port>/db`)
  for every port, the default 6420 included, instead of rivetkit's shared `~/.rivetkit`, which any other project
  using Rivet on your Mac also writes (a newer one could stamp the database so capcomd's engine refused to start).
  capcomd no longer reads or writes `~/.rivetkit` at all; rivetkit's own engine logs go to
  `~/.capcomd/engine/<port>/.rivetkit/`. The first time the new version starts on 6420 it copies your existing data
  from `~/.rivetkit/var/engine/db` once (it never moves or deletes it: you can remove the old folder yourself once
  you're happy), checks the copy and prints one line saying so; if an engine is still running on the old folder it
  refuses with a sentence saying to stop it first. capcomd also records which engine version last opened its data
  (`engine-version.json`): before a different version opens it, it copies the database to
  `~/.capcomd/engine/<port>/backups/<old version>-<UTC time>/` (the newest three are kept; restore by putting its
  `db/` and `engine-version.json` back), it refuses to start on data a newer engine already opened, naming both
  versions and the newest backup, and when the engine doesn't come up it prints the engine's own last log lines.
  The engine is Rivet 2.3.31 (from 2.3.27), which keeps scheduled wake-ups (lease expiry, machine reaping, quota
  resets) across engine restarts.
- Menu bar app: Active cards are redesigned. While nothing needs you a card is one line: the agents' faces, who is
  doing what ("worker is editing 2 files") and how long the run has been going. When an approval waits, the card
  opens to the question ("Merge worker's work into main?"), who asked and who is waiting on it, the files it lands with
  lines added and removed, and **View diff**, **Deny** and **Approve ↩** (Return approves while the card has focus; Esc
  never denies). A failed agent opens the card to the lines that say why, with **Open thread** and **Hide**; agents
  stopped at a usage limit say when they pick up again, with **Resume now**. The chevron shows the agent tree. The
  newest finished run tops the Recent list with how it ended: "Merged into main" (or "Merge denied" when you denied
  it), files and lines, whether its checks passed, and what it cost when API spend was billed. The cards also read in
  light mode.
- Harness API: a merge waiting for approval now says what it would land. `approval.requested` and `snapshot.approvals`
  carry `subject.files` (path, status, lines added and removed; the 20 biggest changes), `subject.filesTotal`,
  `subject.added` and `subject.removed`, read when the merge was parked; snapshot approvals also carry `requestedAt`.
  An agent's `result` records how its merge ended (`merge`: target and merged, failed or denied) and, when its checks
  failed, how (`verification.checks.reason`) and the lines of the check output that name the failure
  (`verification.checks.excerpt`). `capcomd merge --json` of a parked merge includes the same `diff`.
- Menu bar app: the folder picker (**+ › Choose Project Folder…**, and Choose… in Settings › Runs) opens in front of
  other apps' windows and keeps the folder you pick; it could open behind the app you were using, and the first click
  in it closed it with no folder. After you pick a folder the menu bar panel opens again on what the folder needs.
- Menu bar app: set a project up right in the composer. Pick a folder with **+ › Choose Project Folder…**: a capcomd
  project is used at once as before; any other folder gets an orange dot on its chip and, in place of the tool row, what
  it needs next. A GitHub checkout shows its repository, the target branch, how changes land (pull requests, or pushes
  when the GitHub CLI isn't logged in, with **Log In…**), the agents that can work on it, and a spend cap when one of
  them would bill an API key where your runs go; edit any of them in place and press **Set Up**, or **Set Up and Start**
  when you've already typed a goal. A folder that isn't a git checkout offers **Initialize Git**; a checkout with no
  remote offers **Publish to GitHub** (pick the account or organization, the name and Private / Public; it says first if
  the first commit would include files that look like secrets), then goes straight into the setup. A checkout on
  another host offers **Open in Terminal** for `capcomd setup project`, and any folder **Choose Another Folder…**.
  **Cancel**, the chip's × or Esc go back to the project you had; new runs never move until the folder is set up.
  Needs a capcomd with `projects.setup` (and `projects.git` for Initialize Git and publishing); with an older one, a
  picked folder is used as before. Settings › General has a new **Keep .capcomd/ out of git** switch (off by default):
  projects you set up from the app from then on get `.capcomd/` added to their .gitignore.
- Harness API: take a plain folder all the way to a GitHub project from the menu bar app (capability `projects.git`).
  `POST /v1/projects/git-init` starts a git repository (`git init -b main`, no commit) in a folder that isn't in one
  (never your home folder, a folder that holds it, or capcomd's own settings). `GET /v1/projects/publish-options`
  (read scope) says, for a checkout with no origin, whether the GitHub CLI is logged in, the accounts you can publish
  as (your GitHub login, then your organizations), a repository name from the folder's name, and how many files the
  first commit would hold, listing any that look like secrets (`.env` and `.env.*` other than
  `.env.example`/`.env.sample`/`.env.template`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, SSH private keys, `.netrc`,
  `.git-credentials`, an `.npmrc` with an auth token). `POST /v1/projects/publish` makes the first commit ("Initial
  commit", what `.gitignore` ignores stays out) when there is none and creates the repository, private or public,
  with `gh repo create --source … --remote origin --push`. It refuses, with a sentence and the field it's about,
  while the first commit would include likely secrets (add them to `.gitignore`) or more than 2000 files (add a
  `.gitignore`), when git has no `user.name`/`user.email`, or when the GitHub CLI isn't logged in; a name that's
  taken on GitHub is 409. Both POSTs need the `configure` scope and an `Idempotency-Key`, and are recorded on the
  daemon stream as `project.git_initialized` and `project.published` (names and counts, never file names or
  contents).
- Harness API: `POST /v1/projects` no longer needs `check`: leave it out to keep the project's current check, or to
  use the one `GET /v1/projects/inspect` suggests (possibly none). Send `gitignore: true` to have capcomd add
  `.capcomd/` to the checkout's `.gitignore` (created if missing; nothing changes when git already ignores it).
  `capcomd setup project` is unchanged.
- Harness API: set a folder up as a capcomd project without Terminal (capability `projects.setup`), so the menu bar
  app can offer it for a folder you pick. `GET /v1/projects/inspect?path=` (read scope, writes nothing) says what a
  setup form needs: the git checkout the folder is in, its origin (the repository a project always uses), its branches
  as your local refs know them, the check `capcomd setup project` would suggest, whether pull requests work (`gh` is
  logged in), and which of Claude Code and Codex have a login and whether one would bill an API key (then a spend cap
  per run is asked). What blocks a folder comes back as `problems`, each with a code and a sentence to show: `not_git`,
  `home` (your home folder, where capcomd keeps its own settings), `no_origin`, `not_github` (the app sets up GitHub
  checkouts; others still work with `capcomd setup project` in Terminal) and `not_found`. `POST /v1/projects` (the
  `configure` scope, an `Idempotency-Key`) takes the answers (`mode` pr or direct, `target`, `check`, `agents`, and
  `budgetUsd` when asked), checks them again, writes the same `.capcomd/config.json` and `.capcomd/agents.json`
  `capcomd setup project` writes for the same answers (merged into what's there, keeping your profiles), and adds the
  folder to capcomd's projects; new runs can then use it (`repo` in `POST /v1/runs` and `GET /v1/run-options`). A
  refusal is 422 with the reason and the field it's about; if the folder's origin changed since it was inspected
  (send `expect.repo`), it's 409 and nothing is written; capcomd won't write through a `.capcomd` that's a symlink out
  of the checkout. Each setup that changed something is recorded on the daemon stream as `project.configured`.
  Setting up needs a token with the `configure` scope, as changing a place's settings does.
- Fix: a place's Machines list (and Delete) could show another capcomd's machines as "left behind". A boxd org lists
  every member's machines, and a second capcomd on the same Mac (another checkout, a test daemon) sees the same Docker
  containers, so a teammate's working agent could read "Delete this machine? No agent is using it." and Delete would
  have destroyed it. The same happened to a live agent of an old run (beyond the 500 most recent). capcomd now keeps
  its own record of every machine it creates (`~/.capcomd/state/machines/`, one file per machine, until the machine is
  deleted), lists a machine nobody uses only when it's in that record, and asks a recorded machine's agent directly
  before calling it left behind. Another capcomd's machines aren't listed at all, and deleting one by id is 404 without
  asking the provider. When capcomd can't read its record, those machines show without a Delete button. Machines made
  before this version aren't in the record: they no longer appear in the list (unless an agent is still using one) and
  can't be deleted from the app; their idle lifetime deletes them.
- Harness API: delete a machine (capability `sandboxes.actions`). `POST /v1/sandboxes/{name}/resources/{id}/actions/delete`
  (steer scope, an `Idempotency-Key`, no body) deletes one of capcomd's machines at a place. For an agent's machine it
  cancels that agent (and the agents it started) the way `capcomd cancel <run> <agent>` does, and the agent's machine
  is deleted as it stops; a machine left behind is deleted at the provider; a machine running capcomd's own checks,
  login or environment build can't be deleted (409). capcomd looks at the machine again just before it acts: if who
  uses it changed since it was listed, nothing is deleted (409), and a machine that's already gone answers
  `changed: false`. A provider that doesn't answer is a new 503 `unavailable`. Machines you can delete carry
  `destructive: true` and a `confirm` question to ask first ("Delete worker's machine? This stops the worker on “…”.
  Work since its last checkpoint is lost."). Every delete is recorded on the daemon stream as
  `sandbox.resource_action` (who asked, and which agent was stopped) and `sandbox.resource_deleted`; machines capcomd
  deletes by itself are recorded too, with why: `idle_lifetime` (Docker's 5-minute sweep, or a machine's own idle
  lifetime) or `run_ended` (its agent finished, failed or was stopped). Deletes boxd makes on its own aren't seen.
- Menu bar app: Delete… on a machine in a place's Details (with a capcomd that has `sandboxes.actions`), next to Open in
  Terminal. It asks first with capcomd's question and a red Delete button; for a working agent it says that the agent
  stops and its work since the last checkpoint is lost. If capcomd refuses (the machine changed, it's capcomd's own, the
  provider didn't answer), its reason shows under the machine. Machines running capcomd's own jobs still have no
  buttons.
- Docker's sweep no longer counts a container it failed to remove as removed; it tries again next time.
- Menu bar app: build it as a real Mac app. `apps/menubar/scripts/build-app.sh` makes
  `apps/menubar/build/capcomd.app` (with its pixel bot icon and the repo's version), so Open at login and
  notifications work and About shows the app's version. It's signed ad hoc, which means the Keychain asks again for
  the app's token after every rebuild; set `CAPCOMD_SIGN_IDENTITY` to a code-signing identity of yours and "Always
  Allow" lasts across rebuilds. `--debug` makes a debug build. See `apps/menubar/README.md`.
- Harness API: change a place's settings (capability `sandboxes.settings`). `PATCH /v1/sandboxes/{name}/settings`
  with `{values: {idleLifetime: "14400"}, rev}` sets how long an idle machine is kept before it's deleted: 15 minutes,
  1 hour (the default), 4 hours or 12 hours, per place. It needs a token with the new `configure` scope
  (`capcomd clients add <name> --scopes read,steer,approve,configure`); a stale `rev` is 409, a value that isn't one of
  the choices is 422. The choice is kept in your user config (`~/.capcomd/config.json` `sandboxes.<name>.idleLifetime`)
  and applies to runs started after it, no restart needed: each run keeps the lifetime it started with, and its agents'
  machines (and their renewals while the agent works) use it. `CAPCOMD_SANDBOX_IDLE_SECONDS` in capcomd's environment
  overrides it and makes the setting read-only. Each change is recorded as a `sandbox.settings_changed` event on the
  daemon stream, with who made it.
- Harness API: machines capcomd makes for its own jobs (a run's checks, `capcomd auth login`/`auth status`,
  `capcomd env build`, `capcomd env doctor`) are listed under `GET /v1/sandboxes/{name}/resources` as running with an
  owner of their kind (`check`, `login`, `env_build`, `doctor`) and a line saying what they do ("Checks for run-…",
  "Logging in to Claude Code", "Building the agent environment"), not as left behind; they offer no actions. Resource
  owners now carry `kind` and `label`, and `runId`/`agentId` are null when the machine isn't an agent's.
- Menu bar app: "Delete idle machines after" in a place's Details can be changed (with a capcomd that has
  `sandboxes.settings`). A token made before this release can't change it: the row says "Reset your token to change
  these", and Reset… in Settings now makes a token that can. Machines running a run's checks, a login or an
  environment build read as such ("checks · run-…") and are never shown as left behind.
- Harness API: a place's details, for a settings screen that works for any provider (capability `sandboxes`).
  `GET /v1/sandboxes` lists each place agents run (today Local · Docker and Cloud · boxd) with what it can do, whether
  it's available and whether it's the default. `GET /v1/sandboxes/{name}` adds its settings and info rows as typed
  fields the app renders as they come: "Delete idle machines after" (1 hour today; it can't be changed yet), Logins
  (whether every login there is bound to its AI's API host) and Checkpoints ("After each commit and every 10
  minutes"). Read scope, local reads only, never a credential.
- Harness API: the machines capcomd's agents run on (capability `sandboxes.resources`).
  `GET /v1/sandboxes/{name}/resources` lists them with the run, agent and task each belongs to, or `orphaned` for a
  machine capcomd left behind, with when it was created and when it will be deleted; `…/resources/{id}` adds the
  command that opens a shell in it. The provider is asked at most every 10 seconds; when it doesn't answer, you get
  its last list marked `stale` with the reason.
- `capcomd sandbox shell <runId> <agentId>` opens a shell in the machine an agent runs on (boxd VM or Docker
  container), and `capcomd sandbox shell --sandbox docker|boxd --machine <id>` in a machine capcomd left behind. It
  warns that you're inside an agent's sandbox, accepts only capcomd's own machines and uses your local credentials.
- Harness API: `GET /v1/logins` entries carry `hostBound` and `boundTo` (the host a login is bound to, e.g.
  api.anthropic.com), and `GET /v1/logins` and `GET /v1/environments` take `?sandbox=` for one place's rows.
- Harness API: place names in `POST /v1/runs` `sandbox`, `GET /v1/run-options` and the Settings routes are now
  plain strings checked against the places the daemon lists, and `drivers[].sandboxes` is a map keyed by place name.
  The same values are sent and accepted; a client generated from `openapi/capcomd.json` sees a string and a map where
  it saw an enum and a fixed object. A refused `driver`/`sandbox` pair now names boxd as "Cloud" (it said "VM").
- Menu bar app: Settings › Runs has one section per kind of place, "Local" (a laptop) and "Cloud" (a cloud), as the
  composer's Local / Cloud switch shows them; the provider's row in it
  (Docker, boxd) shows **Default** or **Make Default**, and **Details…** (with a capcomd that describes its places).
  Details… opens a sheet that shows whether the place can be used, its agent environment, the machines agents are running there right now (who
  uses each one and for how long, and any machine left behind that no agent owns), how long an idle machine is kept
  ("Delete idle machines after"), whether logins there are bound to their AI's API, and
  when work is checkpointed. **Open in Terminal** opens a shell in a machine. If the provider can't be reached, the
  last list stays with a note. Done or Esc closes it.
- capcomd can ask you itself before a merge into a protected branch: set `"driver": {"approvals": "elicit"}` in a
  project's `.capcomd/config.json` (or `capcomd setup agent --approvals elicit`). Your agent calls `capcomd_approve`
  and capcomd sends its own prompt through the agent's MCP client (in Hermes: the terminal, or Allow / Deny buttons in
  Telegram, Slack…) naming the project, repository, run, merge, target, the exact commit, the checks that passed and
  the reviewer's verdict (fenced as data). Only your accept approves, and only if the branch still points at that
  commit; decline, cancel or no answer within `driver.elicitTimeoutSeconds` (default 300) leaves the merge waiting,
  and the tool says "No decision: the merge is still waiting. Don't retry; ask the user." A client that can't show
  such a prompt is refused, as before. It's the recommended setting for Hermes; for Claude Code, whose hooks can answer
  prompts, only with managed hooks (add `"claude-code"` to `driver.elicitClients`). `client-confirmed` still works but
  is no longer recommended.
- `capcomd_approve` is marked as needing a person (Claude Code asks before every call, even in bypass or auto mode)
  and is no longer marked idempotent.
- Hermes: one capcomd for all your projects. `capcomd setup agent` now writes a single `mcp_servers.capcomd` entry with
  no `cwd` and adds the checkout you run it in to capcomd's project list (`projects` in `~/.capcomd/config.json`; the
  first is the default, `--default-project` changes it). An entry an earlier version pinned to a folder is migrated:
  the folder joins the list. MCP tools take an optional `project` (a name or a checkout's path; a run's tools default
  to the run's project), results and approval prompts name the project, and the new `capcomd_projects` tool lists
  them. `--hermes-entry-per-project` still writes a separate entry pinned to one checkout. In a terminal, setup now
  asks who approves merges for Hermes: capcomd asking you in Hermes (`elicit`, recommended) or you with `capcomd
  approve`; `--yes` alone changes nothing. The entry also gets `timeout: 360` when it has none, so a tool call
  outlives the approval prompt.
- Docs: Hermes recipes for a nightly run that stages but never merges into a protected branch, a morning digest with
  no model, and narration with `/heartbeat` ([integration-agents.md](docs/integration-agents.md#recipes-no-new-code)).

- Harness API: three read-only routes for a settings screen, each with its capability in `GET /v1/health`.
  `GET /v1/logins` (`logins`) says, for Claude and Codex in each sandbox (docker, boxd), whether agents can log in,
  how (a plan login or an API key), where the login is kept, and the `capcomd auth login … --sandbox …` command that
  logs in there. `GET /v1/environments` (`environments`) gives each sandbox's agent environment: `ready`, `missing`,
  `building` (a `capcomd env build` is running) or `failed` (the last build failed), with its tool versions, when it
  was built and the `capcomd env build --sandbox …` command. `GET /v1/service` (`service`) says whether capcomd is
  installed and loaded as a background service, with the install and uninstall commands. All three need the `read`
  scope, only read local state (cheap to poll) and never include a credential.
- `capcomd env build` now leaves a small status file next to the environment ledger while it runs, and records when a
  build fails, so `GET /v1/environments` can report a build in progress or a failed one.
- Menu bar app: a Settings window (⌘, or Settings… in the composer's + menu) with General, Accounts, Runs and About.
  General shows whether capcomd is connected and its version, keeps capcomd running as a background service, opens
  the app at login, turns the menu bar bot's faces on or off, and turns approval and finished-run notifications on or
  off (finished runs now include runs that failed or were stopped). Accounts shows whether Claude and Codex are logged
  in on Cloud and on Local, the boxd API key and this app's token, with Log In…, Set Up… and Reset… buttons that open
  Terminal with the command ready; the row updates by itself when you're done. Runs sets what new runs start with
  (project, driver, effort and where they run, the same default the composer's Local / Cloud switch changes) and shows
  each place's agent environment, with Build… and Rebuild…. With an older capcomd, the rows it can't report are hidden
  or say so.
- Menu bar app: the token prompt named a command that doesn't exist (`capcomd token`); it now says to make a token
  with `capcomd clients add menubar --scopes read,steer,approve`.

- Runs on boxd machines are now called **Cloud** (they were "VM") in the menu bar app and in run options and their
  messages (`GET /v1/run-options` `label`, e.g. "Not logged in to Claude Code for Cloud"). The sandbox's name stays
  `boxd` (`--sandbox boxd`, `"sandbox": "boxd"`).
- `capcomd setup agent` (and `capcomd setup`) now also sets up [Hermes](https://github.com/NousResearch/hermes-agent)
  when it's installed: it registers `capcomd mcp` in Hermes's `config.yaml` (`mcp_servers.capcomd`, run in the
  repository you set up, `trust: untrusted` so Hermes asks you before merging, cancelling or approving), denies
  `capcomd approve` to Hermes's terminal, and installs the orchestration and setup skills in Hermes's skills
  directory. The file is edited in place (your other servers, settings and comments stay; the old file is kept as
  `config.yaml.capcomd.bak`), and re-running updates the entry instead of adding another. In a terminal it asks
  whether Hermes may approve merges into protected branches after asking you (`--approvals client-confirmed`;
  default: you approve with `capcomd approve`). `--no-hermes` skips it. `capcomd setup check` has a `hermes` line.
  See docs/integration-agents.md#hermes.
- Inside a boxd machine without a boxd API key (Hermes on its own VM, say), capcomd started by Hermes or as a
  service now uses the machine's credentials too: `capcomd setup` records the machine in `~/.capcomd/config.json`
  (`CAPCOMD_BOXD_MACHINE`). Before, those processes didn't see the machine's `BOXD_VM_*` variables and asked for
  `BOXD_API_KEY`. If you set up capcomd on such a machine before, run `capcomd setup accounts` (or
  `capcomd setup agent`) once more.

- Agent threads no longer show "System: task_started" and "System: task_notification": Claude Code's notices that a
  background task (such as a planner's `capcomd await`) started or ended. The command's row and the child's hand-back
  already show both. Threads recorded before this keep them.
- Menu bar app: when capcomd comes back after being unreachable, the app reads again what it offers, so the composer's
  Local / Cloud switch and driver chip return. Opened while capcomd was down, the app used to lose them until restarted.
- Menu bar app: the panel no longer jumps when it changes height. Folding a thread's task (or a thought, a command or a
  diff) used to show the panel half the difference lower for a frame, so the header flashed down and back up; folds
  now snap without animating, and the window follows the panel in the same frame.
- Menu bar app: an agent's task at the top of its thread is folded by default ("› Task" and its first line, like a
  thought); a click shows all of it, no longer cut at four lines.
- Menu bar app: a reviewer's verdict in its thread shows as a card (a green or red seal, "Passed review" or "Didn't
  pass review", then each reason) instead of raw JSON (`{"passed": true, "reasons": [...]}`), under any prose before it.
  The reviewer's bot leads the card, cheering with a happy face when the work passes and making its "oops" face when
  it doesn't.
- Harness API: each agent's step history. Every time an agent finishes a step (read some files, edited, ran the
  tests, started sub-agents…) the run's event log gets an `agent.step` event for that agent, in order, with
  `{kind, n, startedAt, endedAt}` and a past-tense `text` ("Read 4 files", "Ran the tests"). They are durable: replayed
  by `GET /v1/events?scope=<runId>` and delivered on the run stream, so a client can show what a finished agent did,
  not only its last activity line. At most 500 per agent; a cancelled agent's unfinished last step is not recorded.
  Clients detect it with the capability `agent.steps` in `GET /v1/health`.
- Menu bar app: Activity shows each agent's steps in order ("[bot] Read 2 files", "[bot] Edited a file", "[bot] Ran
  the tests") instead of only its latest line; a working agent's live line follows its history. Needs a capcomd with
  `agent.step` events; older ones show one row per agent as before.
- Menu bar app: shell commands and other tool calls show a terminal icon (`>_`) instead of a wrench, in threads and in
  Activity; in a thread, every shell command does, since its row shows the command itself.
- Menu bar app: every Activity row leads with the bot of the agent that did it ("[bot] Ran the tests"), with its name
  and role as the tooltip; verify, merge and approval rows lead with the bot whose work they were. Steps of the run
  itself keep their icon.
- Menu bar app: the composer shows who can drive a run for the project you picked and where it runs. Claude logged in
  for Cloud only shows as unavailable on Local, saying which command fixes it; a folder that isn't a capcomd project says
  so. Before, it showed the daemon's own answer, so a run could be offered and then fail.
- Menu bar app: a run that hasn't started its first step is headed "Starting…" (not its goal twice), and its Activity
  says "Nothing has happened yet." instead of staying blank.
- Agents' commits, and the pull requests capcomd opens for them, are titled with what the change does, cut at a word
  ("In src/math.ts add and export function multiply(a: number, b: number)…"), instead of the agent's id followed by
  the task cut mid-word ("agt-k825d4…: In src/math.ts add and export function multiply(a: number, b"). The task and
  agent are still in the commit's `Capcomd-Task` trailer.
- Fix: runs started from the menu bar app or `POST /v1/runs` for a project (`repo`) now use that project's agent
  profiles (`.capcomd/agents.json` from `capcomd setup project`). Their planner used to fail about 5 seconds in with
  "An internal error occurred", because the daemon looked the profile up in its own agents file. Every agent now runs
  with the profile it was spawned with, including a planner whose provider `driver` swapped.
- When an agent can't start because of its configuration (an unknown or invalid profile, missing credentials), its
  result and its driver log now say what's wrong (e.g. `unknown agent profile "planner" …`) instead of "An internal
  error occurred", and it fails at once instead of retrying three times.
- `GET /v1/run-options?repo=<project checkout>` answers for a run of that project, with its own profiles (capability
  `runs.options.repo`); a directory that isn't a capcomd project is 422 with the same message `POST /v1/runs` gives.
  `POST /v1/runs` checks `effort` against the body's `repo` too.
- `GET /v1/run-options` says, for each driver, whether it can run in each sandbox: `drivers[].sandboxes.docker` and
  `.boxd`, with a reason naming the command that fixes it (capability `runs.options.sandbox`). Logins and agent
  environments are per sandbox, so Claude logged in for boxd only shows as unavailable for Local. `POST /v1/runs` with
  a `sandbox` the driver can't run in is now refused at once (422, with that reason) instead of failing later.
- `capcomd env build`, `env status`, `auth login|status|logout` and `doctor` take `--sandbox docker|boxd` to work on
  that sandbox instead of `CAPCOMD_SANDBOX`. The "no capcomd env snapshot" error names the sandbox and the exact
  command (`capcomd env build --sandbox docker`), and no longer says "in the VM" for Docker.
- A run that can't start is now refused with the reason, instead of showing as running forever with no agents. For
  example, starting a run on Local (Docker) before its agent environment is built (`capcomd env build --sandbox docker`) now fails
  right away: `capcomd run` exits with the error, and the menu bar app (`POST /v1/runs`) shows it. If the run's
  planner still can't be started once the run is under way, the run ends as failed with that error as its reason
  (in `capcomd status`, `GET /v1/runs` and the run's events) instead of staying "started".
- Stop (`capcomd cancel <runId>`, the menu bar app's Stop) now ends a run that never got an agent running, such as one
  whose start failed or whose agents were all stopped before they began. Before, it answered "nothing to cancel" and
  the run stayed open. Only a run that has already ended answers "nothing to cancel" now.
- Harness API: a run that ended without its agents ending it has a new `run.ended` event (`state` failed or
  cancelled, with a `reason`); the lifecycle feed shows it as `run.failed` or `run.cancelled` with that `reason`. `GET /v1/runs` shows
  such a run as `failed` or `cancelled`.

- Agents no longer fail when the daemon restarts. Before, agents that were running when `capcomd serve` stopped or
  restarted (a Ctrl-C, a service restart, an upgrade) ended as failed a few seconds later, with "An internal error
  occurred" or a connection error as their result. Now each agent waits for the daemon to come back (up to 5 minutes,
  `CAPCOMD_DRIVE_OUTAGE_MS`) and then runs its task again in its VM, without counting the interruption as a failure;
  the run it had going there is stopped first, so two copies never work in one checkout. If the daemon stays down
  longer, the agent stays running and the next `capcomd await` picks it up. The work done before the restart is not
  kept: the task starts over.
- Menu bar app: an approval that's still waiting keeps its project's card under Active, even after its agents have
  finished; before, the card moved to Recent and took its Approve / Deny with it, while the menu bar still counted it.
- Approvals for an agent's merge read "Merge this agent's work into main?" and name the branch, instead of the agent's
  id ("Merge agt-mvqa… into main?").
- Fix: a client on the daemon or project event stream (the menu bar app) could overload the engine until `capcomd
  serve` gave up on it ("engine on :6420 stopped answering") when the daemon's state remembered runs its run list no
  longer shows. Each such run is now checked once instead of twice a second, the stream never starts a new check
  before the last one finished, and reading a run's events no longer creates an empty run on the engine.
- Fix: `capcomd serve` now stops the Durable Streams services process (port 8642) when it exits, including when its
  watchdog stops it. It used to keep running, hold the port so the next `capcomd serve` couldn't start its own, and
  attach itself to that daemon's engine.
- `capcomd serve` names the process holding a port it needs ("capcomd serve: :6421 is held by pid 4242 (rivet-engine)"),
  and on the default port it also checks the services port (8642, or `RIVET_PORT`) before starting, instead of
  starting an engine whose services then can't bind.
- `capcomd serve` stops the engine together with anything the engine started, including after the engine died. When
  its watchdog gives up on the engine, it now waits for the engine to stop before exiting and lists the harness API
  requests that were still waiting for an answer.
- Menu bar app: after the daemon restarts, its feeds reconnect at random, growing intervals (up to 5 s) instead of all
  at once.
- Menu bar app: an ended run's view is titled by how it ended ("Done in 7s", "Stopped after 32s") instead of its
  last step.
- Menu bar app: in a run's view, click an agent's row in Activity to read its thread; that's how you get back to
  what each agent said once the run has ended.
- An agent's log no longer fills with the same "pump error: VM … not found" line after it's paused or stopped;
  the error shows once.
- Menu bar app: the panel stays live. It used to stop updating after a while (a quiet connection was dropped, or the
  daemon restarted) and kept showing old state; it now reconnects within a few seconds, and says "Can't reach capcomd. Reconnecting…" while the daemon is down. Runs started elsewhere (the
  CLI, another agent) appear as they start, with their agents, even with many runs around; before, past about seven
  runs, new ones showed no agents. An ended run's view no longer offers Pause and Stop. Agents you
  stopped show a grey stop mark instead of a red failure, and agents in the Activity list show their bots. When several agents
  changed files, each row in Files shows the bot of the agent that changed it.
- Daemon: event streams are no longer cut after 10 seconds of quiet (the heartbeat comes every 15).
- Trace: git steps are named after their command (push, clone, checkout) even when git gets options first; they read
  "-c" before, and a push could show the remote instead of the branch. In the menu bar's Trace view, paused agents
  show a pause mark instead of looking queued.
- Menu bar app: each goal you start is now its own card. Before, every run in the same repository was folded into one
  card, titled after whichever goal came first; reruns of the same goal still share a card. A paused agent now shows
  a pause mark in the tree and its thread.
- Menu bar app: the menu bar icon appears right away even while macOS is asking whether the app may read its token
  from the Keychain (the panel says it's waiting); before, nothing showed until that prompt was answered. When no AI
  can drive a run yet, its menu stays visible, dimmed, with the reason (for example "No planner profile").
- Menu bar app: the send button is always white (its arrow dims while there's nothing to send), and the panel grows
  wider when the controls under the goal need the room, instead of spilling past its edge.
- Menu bar app: choose how a new project runs. Under the goal, a two-icon switch (laptop or cloud) picks where its
  agents work (Docker on this Mac, or boxd VMs), and a Claude Code / Codex menu by the send button picks the AI that drives it as
  its planner, and how hard it thinks: the bars on that menu show the reasoning effort, which you can change in the
  same menu. Both apply to that run, and the app remembers your last picks. Needs a daemon that offers them.
- Menu bar app: you can now see which AI each agent runs on. The agent tree shows the Claude or Codex mark on every
  row (hover it for the model), and the agent's bot in the thread header, handoff cards and the team intro wears it
  as a small badge. Needs a daemon that reports it; older daemons show no mark. Folder chips in the tree now line up
  on finished agents too.
- API: `POST /v1/runs` takes `driver` (claude or codex), `effort` (the driver's reasoning effort) and `sandbox`
  (docker or boxd) to pick who drives a run, how hard it thinks and where it runs; `GET /v1/run-options` lists them,
  each driver's effort levels and whether each is available (capability `runs.options`). Agents now also report their
  `effort`. On the command line: `capcomd run <goal> --planner-provider claude|codex` runs the project's planner on
  that provider (with the model and login of your profile for it, else the provider's defaults), `--planner-effort
  LEVEL` sets its effort, and `--sandbox docker|boxd` runs that run's agents and checks there instead of on
  `CAPCOMD_SANDBOX`. Profiles take `effort` too (`capcomd agents set NAME --effort high`; claude: low to max, codex:
  minimal to high), and `CAPCOMD_AGENT_EFFORT` overrides it.
- API: agents now report which AI provider (claude or codex) and model they run on, as `provider` and `model` on
  each agent (GET /v1/runs/{runId}/agents and the stream's `snapshot.agents`). `provider` is null for a fake agent;
  `model` is null when the provider's default model is used. The `agent` field of `agent.spawned` events now has a
  documented shape (`kind`, `provider`, `model`, plus the profile's other settings).
- Menu bar app: opening the @ mention or / skill list in a thread no longer blanks out the top of the conversation;
  the list now floats over the thread.
- Menu bar app: when you @ mention an agent in a message, it becomes a pill with the agent's bot and name, right
  where you typed it ("ask [Bolt] to retry shard 3"). Delete removes it in one keystroke, and your sent message shows
  the same pills instead of the raw handles. The back button in a run or thread is now round.
- Menu bar app: every agent's bot now has a name, and inside a thread you talk to it by name. The header shows the
  bot's name ("Bolt") with its role and project on one quiet line under it, the message box says "Tell Bolt…",
  handoff cards lead with the bot's name, and you can @ mention an agent by its bot's name. The agent tree
  keeps roles; hover a bot to see its name. VoiceOver reads both.
- Menu bar app: a new look for the panel and for writing to agents. The panel has large rounded corners. Starting a
  project is now a roomy box at the top: which project folder it goes to is a chip you can change or clear, you type
  the goal in large text, and a round white button starts it. Writing to an agent works the same way, with the agent
  shown as a chip with its bot and buttons for @ mentions and / skills. Finished projects show as "Recent" rows with
  their bot, and ⌘1, ⌘2 and ⌘3 open the first three.
- Menu bar app: the panel no longer has a footer bar; it ends with your projects. A run's Pause, Stop and Open in
  terminal bar is unchanged.
- Menu bar app: two small moments with the bots. When a run starts, its card first introduces the team for a few
  seconds: the planner waves over the agents it spawns, each with its bot's name. When a run finishes successfully,
  its card shows the team cheering for a couple of seconds, in party hats and confetti, before it becomes the finished
  line. Failed or stopped runs don't celebrate; with Reduce Motion the team simply fades in.
- Menu bar app: on macOS 26 and later the panel's controls (the project field, the message box, Back, Approve and
  Deny, a run's Pause and Stop bar) use Liquid Glass; earlier macOS versions keep today's look. Approval notifications now show the
  waiting agent's bot and have Approve and Deny buttons, so you can decide without opening the panel. Clicking Approve
  or Deny gives a light trackpad tap. With Increase Contrast, cards get a clear border; with Reduce Transparency, the
  panel is drawn solid.
- Menu bar app: small finishing touches to match the bots. The agent tree's lines are dotted like circuit traces,
  agents that are working have a soft glow behind their visor, a bot blinks when you point at it, the agent waiting
  for your approval waves, a run that just finished gets a brief sparkle, and an empty panel shows the pixel CAPCOMD
  logo. The line between a card's folders and its agents is gone. Nothing moves when Reduce Motion is on.
- Menu bar app: every agent now has its own little pixel bot, in the agent tree, the thread header, handoff cards and
  the @ mention list. The bot is the same every time for the same agent, and agents in one run look different from each
  other. The menu bar icon is now a bot head whose face shows what is going on: sleepy when nothing runs, eyes open while
  agents work, and a raised hand (next to the approval count) when something needs you.
- Menu bar app: stop an agent from its thread. While it works, press Esc in the empty message field or click the stop
  button; the thread says "Stopping lead…" until the agent has pushed its work and paused, then "lead is paused" with
  Resume. Pausing an agent pauses the agents under it too; the rest of the run keeps going. Needs a capcomd daemon that
  supports pausing one agent (it advertises `agent.pause`); with an older one the stop control stays hidden.
- Menu bar app: in the run view, the Activity list and the collapsed step strip sit 4 pt closer to the step bar, as
  designed.
- Menu bar app: an agent's thread now shows what it actually did, as it happens: its messages with headings, lists,
  inline code, code blocks (lightly highlighted, with Copy) and tables; "Thought for 8s" lines that unfold into the
  reasoning; one line per tool call with its duration that opens to show the arguments and result; file edits as a small
  diff with the file's name and `+n −n`; and a card when a
  child agent hands back, with its summary and artifacts, that opens the child's thread. Your messages sit between
  them. Web links show where they really go and open in your browser; images the agent produced load from capcomd,
  and images from the internet load only when you click them. Needs a capcomd daemon with agent threads; with an
  older one the thread shows the same lines as before.
- `capcomd serve` no longer takes over a harness socket another daemon is serving. Before, a second `serve` (or a
  test run) replaced `~/.capcomd/harness.sock`, and the running daemon's menu bar app and other harness.v1 clients
  lost it (connection refused) until that daemon was restarted. Now `serve` exits 1 with an error naming the socket and
  the running daemon's version; to run a second daemon, give it its own socket with `--harness-socket PATH` or
  `CAPCOMD_HARNESS_SOCKET`. A socket left behind by a daemon that died is still replaced, and on shutdown `serve`
  removes the socket only if it is still its own. `CAPCOMD_NO_CONFIG=1` now also skips the config's `harness.socket`.
- Harness API: `GET /v1/runs/{runId}/agents/{agentId}/thread` returns an agent's thread ready to render: its messages
  and thinking as a sanitized block tree (headings, lists, code, tables, quotes, links, images), each tool call as one
  line ("Run bun test", "Read ids/v1/schema.json") that shows as running and then finished, with its duration when the
  agent's CLI reports one, its plan as a checklist, errors, and its final result. Links say where they really go (web
  host, a file in the agent's workspace, an attachment, another agent or run, or nowhere), and images point at files
  the daemon serves (`GET …/attachments/{id}/content`, `GET …/agents/{agentId}/workspace?path=`) or at remote URLs a
  client loads only on a click. Add `?thread=1` to a run stream for live `agent.thread_item_changed` updates. The
  transcript route and `capcomd logs` are unchanged.
- Agents that can spawn (planners, leads) now have a thread too; before, nothing they did themselves was recorded
  for a client to show. When a child finishes, its parent's thread gets a hand-back item with the child's summary and
  its artifacts as links and thumbnails.
- Harness API: a thread's tool items for Claude Code file edits (Edit, MultiEdit, Write, an inserted notebook cell)
  now carry `tool.diff`: the file's path in the workspace, `added` / `removed` line counts for the whole change, and
  its first 40 lines as context, removed and added lines (`op` " ", "-", "+", and "@" between hunks), ready to draw as
  a diff card. While the call runs it shows the change the agent asked for; when it returns, the patch Claude Code
  applied, with surrounding lines. The daemon never reads the file: everything comes from the agent's own events.
  `tool.diff` is null for other tools and for Codex file changes (Codex reports which files changed, not the lines;
  they stay in `tool.files`). The thread format stays `blocks/1`.

- Menu bar app: project cards now match the approved design. Each card is titled by the project's goal, shows the
  folders its agents work in as chips (up to three, then `+n`), and nests every run of the project as an agent tree.
  Run ids no longer appear on cards (they stay in the run view), and a card waiting for your approval gets a faint
  amber tint instead of a coloured border. Click a card's title to open its run. Running status marks are blue even
  when another app is in front.
- Menu bar app: each running agent on a project card shows what it is doing right now under its name ("Reading 4
  files"), updated live. An agent waiting for your approval shows the question there instead, with the branch line
  beneath it and Deny / Approve; Approve stays blue even when another app is in front. Needs a capcomd daemon that
  reports agent activity; with an older one the line is simply absent.
- Menu bar app: the Active list shows only work in progress. A run that finished, failed or was stopped leaves its
  project's card, and a project with nothing left running drops below the cards as one line saying how its latest run
  ended, how long it took and how many folders it touched ("Done in 4m · 3 repos", "Failed after 12m"); the newest
  three are kept, and clicking one opens its run. A paused run stays in the Active list.
- Menu bar app: the run view is rebuilt to the approved design. **Activity** lists each agent's work in plain words
  ("Read 4 files", "Editing 3 files") by phase, with "now" / "6m ago"; finished steps carry no status icon, and the
  list collapses to one row of step icons (⌘\). **Trace** shows the run's model calls, sandbox and git steps with
  timing lanes, follows live, and offers "Jump to now" when you scroll back. Activity or Trace (⌘1/⌘2) is remembered.
  Below, **Log** tails the working agent's output and **Files** lists what the run changed with `+n −n`, one at a
  time. The footer can **Pause**/**Resume** and **Stop** the run (Stop asks once) and **Open in terminal** runs
  `capcomd tui` for it. Pause, Stop and Files need a daemon with the new run controls and files routes; an older one
  says so instead.
- Menu bar app: the footer ("Open capcomd", "Summon ⌥Space") now sits on its own bar with a thin line above it, so
  projects scrolling underneath blur out instead of showing through the text.
- Menu bar app: talk to an agent from its thread. Type in "Tell lead…" and press Return (⇧Return for a new line);
  the message shows at once as your bubble and settles when capcomd confirms it, with Retry if it couldn't be sent.
  Type `@` to mention an agent working under this one, and `/` to attach a skill when your capcomd supports it.
  "lead is writing…" shows while the agent works. Needs a daemon with the agent messages route and a token with the
  steer scope.
- Menu bar app: start a run from the panel. Type a goal in "Start a project…" at the top (⌘K focuses it) and press
  Return; the new run shows up in the list. If capcomd has no default repository, the app asks once for the project's
  folder and remembers it. Needs a daemon with `POST /v1/runs` and a token with the steer scope.
- Menu bar app: the agent tree on each card matches the approved design: outline guide lines (they carry on past an
  approval or activity line), the folder each agent works in on its row when a run spans more than one, lowercase
  profile names with a short task id when two siblings share a profile, and profile icons drawn at one size
  (planner, lead, worker, critic; a hexagon with a dot for others). Folders come from capcomd's agent workspace.
- Menu bar app: opening a run or an agent's thread no longer draws it on top of the project list (both showed at
  once, and clicks could land on the hidden cards).
- Menu bar app: the panel is now as tall as what it shows instead of a fixed 520 pt. A short project list or a run
  view no longer leaves empty space at the bottom, and a long list grows up to 640 pt (or the height of your screen)
  before it scrolls. The Log box in the run view is now the designed four lines tall.
- harness.v1 now says what each agent is doing right now, in plain language: "Reading 4 files", "Running the tests",
  "Waiting for sub-agents", and in past tense once it stopped ("Read 4 files"). It is the new `activity`
  (`{text, kind, at}`, or null) on each agent in `GET /v1/runs/{runId}/agents` and `snapshot.agents`. For live updates,
  add `?activity=1` to a run stream, lifecycle feed included (`/v1/streams/{runId}/events?feed=lifecycle&activity=1`):
  you get `agent.activity_changed` frames, at most one per agent per second, sent live only (never replayed, no SSE
  `id`). The daemon writes the line from tool names, commands and capcomd calls; file names and command text never
  appear in it. Without `?activity=1` the streams are unchanged.
- The harness.v1 API can start a run: `POST /v1/runs` with `{goal, repo?, profile?, targetBranch?}` and an
  `Idempotency-Key` header does what `capcomd run --detach <goal>` does in that project's checkout and returns the
  new run at once (`state: "starting"`); it then appears on the `daemon` stream with `run.created` like a run started
  from the CLI. `repo` is the absolute path of a checkout you ran `capcomd setup project` in; without it the daemon's
  own repository settings (`CAPCOMD_REPO`) are used, and with neither the request is refused (422) with what to do.
  Retrying with the same key returns the same run instead of starting another. The client's token needs the `steer`
  scope: `capcomd clients add <name> --scopes read,steer,approve`.
- `capcomd run --detach -- "<goal>"` with a goal that starts with `-` now runs; the background run used to read the
  goal as a flag and fail.
- harness API: each agent now says where it works. `GET /v1/runs/{runId}/agents`, the `snapshot.agents` stream frame
  and `agent.spawned` events carry `workspace: {repo, path, label}` (null when the run has no repository), so a client
  can show a folder chip per agent and a run's distinct folders. Show `label` as is: the repository's name (e.g.
  `matchkey`), or the sub-folder when an agent is scoped to one. Today every agent works in its run's repository, so
  `path` is null; credentials in a repository URL are left out.
- The harness API has a new read route, `GET /v1/runs/{runId}/files`: the files a run's agents changed, each with
  lines added and removed (null for binary files), its status (added, modified, deleted, renamed…) and the agent
  whose work changed it. Each agent's work is its pushed commit, or its latest checkpoint while it still works,
  compared with where its branch left the run's target branch. Pass `agentId` for one agent and `limit` (at most
  500) to cap the rows; `truncated` says rows were left out. Refetch when the run stream shows a checkpoint, an
  agent finishing or pausing, or a merge with a seq above the answer's `asOf`. Merges now also record the target's
  commit before the merge (`targetBefore` on `merge.succeeded`).
- `capcomd pause <runId> [agt]` pauses agents: one that hasn't started is paused at once, and a running one stops at
  its next check with its work pushed to its branch (`Capcomd-Stop: paused`). `capcomd resume` runs them on from there.
- The harness API (what the menu bar app uses) can now control runs and steer agents, with a token that has the
  `steer` scope (`capcomd clients add <name> --scopes read,steer,approve`):
  `POST /v1/runs/{runId}/pause`, `/resume` and `/cancel`, and `POST /v1/runs/{runId}/agents/{agentId}/messages` with
  `{"body": "…"}` to send an agent a message. Each needs an `Idempotency-Key` header (a retry with the same key returns
  the first result), and the change shows up as the usual events on the run's stream (`agent.paused`, `run.paused`,
  `agent.resumed`, `run.cancelled`, `message.sent` with the `seq` the call returned). See docs/harness-contract.md.
- A run stopped with `capcomd cancel <runId>` now ends as `run.cancelled` in the lifecycle feed even when some of its
  agents had already finished (before, it could show as `run.completed` or `run.failed`).
- An agent that has just started no longer shows as stuck ("no heartbeat for Ns") in `tree`, `inspect` and the
  harness API while its VM is still coming up: its liveness is now counted from when it started, not from its spawn.
- Send skills with a message: `capcomd send <runId> <agt> <text> --skill NAME` (repeatable, at most 8), or `skills:
  ["name", …]` on the harness API's `POST /v1/runs/{runId}/agents/{agentId}/messages`. The agent reads each skill's
  `SKILL.md` along with the message; the thread shows only your text, and `message.sent` lists the skills' names
  (`data.skills`). `capcomd skills` (or `GET /v1/skills`) lists the names you can use: the bundled capcomd skills and
  your `~/.claude/skills`. An unknown name is refused and nothing is sent.
- The harness API can pause and resume one agent: `POST /v1/runs/{runId}/agents/{agentId}/pause` and `/resume` (steer
  scope, `Idempotency-Key`), the same as `capcomd pause|resume <runId> <agt>`. Pausing covers the agent's descendants;
  the rest of the run keeps working, and the run shows `run.paused` only once every agent still live is paused.
- `capcomd resume <runId> <agt>` now also resumes that agent's paused descendants, as `capcomd pause <runId> <agt>`
  paused them (before, only the agent itself ran again and its children stayed paused).
- `GET /v1/health` now lists `capabilities` (`run.controls`, `agents.messages`, `steer.skills`, `agent.pause`): a client
  checks for a name before it offers that feature, and treats a missing list as empty. See docs/harness-contract.md.

## 0.6.0 (2026-10-25)

Stable release of 0.6.0-rc.2, with no code changes since it: agents in Docker containers, `capcomd tui` in the CLI,
and `capcomd setup` fixes (boxd key, project checkout). See 0.6.0-rc.2 below for the details. The live Mac e2e
(`scripts/mac-subagents-e2e.sh`) was skipped for this release by owner decision.

## 0.6.0-rc.2 (2026-10-25)

Release candidate: agents in Docker containers, `capcomd tui` in the CLI, and `capcomd setup` fixes (boxd key, project checkout).

- `capcomd setup` run outside a git checkout (your home directory, say) now asks for the path to your project's
  checkout and offers that repository's `origin` as the repository, as it does when run inside one. Before, it asked
  for a repository URL with no default and saved the project's settings in the current directory, which from your
  home directory meant capcomd's own config. Without a terminal, it says to run `capcomd setup project` in the
  repository; it never writes project settings into capcomd's own config.
- `capcomd tui [runId]` opens the terminal debugger: the run's agents live, a waterfall of what each did, a timeline,
  cost rollups and events (`--view` picks the first tab). With no runId it opens the latest run. Before, it ran only
  from a git checkout (`apps/tui`); it now ships with the CLI and the single executable.
- `capcomd setup` can create its boxd key again: it failed with "org not found" because the boxd CLI rejects
  `keys create --org` for your active org. Setup now leaves `--org` out there (the key is fenced to that org anyway);
  for another org it says to `boxd auth switch` first.
- Running capcomd from inside a boxd machine (an agent like Hermes on boxd) no longer needs a `BOXD_API_KEY`: when
  the machine has credentials of its own, `capcomd setup` and preflight say so and use them. An explicit key still
  wins. Agent VMs never get such credentials: capcomd only ever runs agents in isolated VMs, which boxd refuses them
  to, and now refuses to use a VM that isn't isolated.
- capcomd can now run agents in Docker containers on your machine instead of boxd VMs: `CAPCOMD_SANDBOX=docker`
  (Docker Desktop, OrbStack, Colima or Podman's docker). `capcomd env build` bakes the agent CLIs into a local image
  and the engine removes expired containers. Differences from boxd: a container instead of a VM, an API key reaches
  the agent in its environment (plan logins are unaffected), and no egress allowlist (a profile that sets `egress` is
  refused). See [docs/providers.md](docs/providers.md).
## 0.6.0-rc.1 (2026-10-24)

Release candidate: a single executable; agents that report up (checkpoints, stuck notices, grants, quota pauses,
messages while they run); no restrictions by default; `capcomd run` with a planner agent.

- `capcomd send` (and `capcomd_send`) now tells you when the agent won't read your message now: a Codex agent can't
  read messages while it works, and a finished agent reads nothing (`note` in the result).
- An agent that keeps working but changes nothing can now be caught: set `noChangeAfterMs` on its profile
  (`capcomd agents set <profile> --no-change-after-ms 1200000`) and an agent with no change in its workspace for that
  long gets a `spinning` notice, then is stopped (its work kept) after twice that. Off by default.
- `capcomd verify` on work that is already merged into the target now passes and says so (`alreadyMerged: true`)
  instead of failing with `pass: false`.
- `capcomd logs <runId> <agent>` (and `capcomd_inspect`'s recent logs) now show what a working Claude Code or
  Codex agent does, a line per tool call, failed call, message and result; before, they were empty for agents that
  can't spawn. `capcomd logs … --follow` streams new lines until the agent finishes (`--json`: one object per line).
- A merge no longer re-runs the checks when nothing changed since `verify` (the same tree, the same check
  command), so it doesn't boot a second checks VM; the result says so (`not run again`). When the target moved, the
  checks run again as before. `CAPCOMD_CHECKS_REUSE=0` always re-runs them.
- Checks that run on your machine (local fake sandboxes, or `CAPCOMD_CHECKS=host`) no longer see your credentials:
  capcomd's settings, provider and GitHub keys, anything named like a key, token, secret or password, git
  credential settings and the SSH agent are removed from their environment. Your toolchain variables stay.
- `capcomd run "<goal>"` now plans real work with a planner agent: `--planner <profile>`, or on boxd by default
  the profile named `planner` (which `capcomd setup` writes). The run gets your project's checks, reviewer and
  target, the planner splits the goal into child agents, verifies and merges their work, and the command shows each
  agent's status as it changes and ends with the planner's summary. **Breaking:** on boxd, `capcomd run` without a
  planner profile now stops with a hint instead of running the built-in placeholder planner (which planned the same
  three generic tasks for any goal); pass `--recipe` to use that anyway.
- A paused agent (stopped by its provider's usage limit) now starts again by itself at the reset time, even when
  nothing is waiting on it; before, it only woke while something awaited it. `capcomd run` now waits through such a
  pause, however long, instead of failing the task after 6 hours (a weekly limit can reset days later).
- Merging an agent's work now deletes its checkpoint ref (`refs/capcomd/checkpoints/<agent>`) from your
  repository; checkpoints of agents whose work didn't land are kept, so you can continue from them.
- An agent with a budget (its own, a parent's or the run's) now also saves a checkpoint each time its spend passes
  another quarter of that budget, so stopping at the budget loses little work.
- `capcomd spawn <runId> --continue <agent> --task …` (`continue` on `capcomd_spawn`, and `capcomd spawn --continue`
  inside a VM for your own children) starts a new agent from a finished agent's work: its branch (for example one
  stopped at a limit), or its last checkpoint if it never pushed one. Before, the new agent's task had to fetch and
  merge that work itself. It is refused for an agent that is still running or paused.
- `capcomd send <runId> <agent> "…"` (and `capcomd_send`, or `capcomd send` from a parent inside its VM) now reaches
  a running Claude Code agent within seconds: it reads the message at its next step and carries on with it. Before,
  only agents allowed to spawn could read messages, by checking their inbox. A message also restarts the agent's
  stuck window, as a grant does. Codex agents still can't read messages while they run.
- **Breaking:** nothing restricts an agent by default any more; set limits on a profile or a run when you want
  them.
  - **Tools and network:** an agent whose profile sets no `allowedTools` can use every tool without permission
    prompts (Claude Code runs with `--permission-mode bypassPermissions`), nothing is disallowed (before:
    `git push`, `git remote`, `curl`, `wget`, web fetch and search), Codex runs with `--sandbox danger-full-access`
    (before: `workspace-write`), and the VM can reach any host (before: GitHub, the npm registry, nodejs.org and
    the provider's API). The VM is the boundary, and agents still never hold push credentials. To restrict a
    profile again: `capcomd agents set <profile> --egress github.com,api.anthropic.com,registry.npmjs.org` and
    `allowedTools` / `disallowedTools` / `sandbox` in its spec.
  - **Run budget:** `capcomd run new` without `--budget` creates a run with no budget (before: $10), and the `run`
    recipe no longer gives each task $1. `capcomd_run_new` takes `budget` as optional.
  - **Fan-out:** a profile that may spawn has no depth or descendant limit unless its `children` block sets one
    (before: one level, at most 10 agents below it), and `capcomd setup` writes the planner profile with only the
    worker profiles it may spawn (before: 3 at once, 6 in all, a third of the budget each).
  - **Stuck agents:** an agent that looks idle, spinning or failing gets a notice and keeps running; it is stopped
    only if its profile sets that window (`--idle-after-ms`, `--stuck-repeats`).
- capcomd now installs as a single executable, like any other CLI, with nothing to install first (no Bun or Node):
  `curl -fsSL https://raw.githubusercontent.com/MarvinAmador7/capcomd/main/install.sh | sh`. It picks your machine's build (macOS or Linux, arm64 or x64) from the release, checks its
  SHA-256 and puts it in `~/.capcomd/bin` (`CAPCOMD_INSTALL_DIR` to change that, `CAPCOMD_VERSION` for a specific
  version). Or `brew install MarvinAmador7/tap/capcomd`. `capcomd upgrade` replaces it with the latest release
  (`--to X.Y.Z` for a specific one, `--dry-run` to only check). The binary carries the engine, which it unpacks to
  `~/.capcomd/bin/<version>/` the first time it starts. The npm package (`bun add -g capcomd`) is still published,
  and the plugin works with either.
- You can now give a running agent more budget instead of letting it stop and starting over:
  `capcomd grant <runId> <agent> --budget usd=2,turns=20,wallSeconds=600` (or the new `capcomd_grant` MCP tool,
  or `capcomd grant <agent> --budget …` from a parent agent inside its VM, for its own children). The amount is
  added to what the agent already has and taken from what its parent (or the run) has left; it is refused if
  there isn't enough, if the agent has no budget of its own in that unit (grant its parent instead), or if it
  would go over a cap set in the agent's profile. A grant also restarts the agent's stuck window. Without an agent,
  `capcomd grant <runId> --budget …` raises the run's own budget. Pass `--key` so that a retried grant counts once.
- An agent's budget now applies while it runs as well: the engine stops it once its spend goes over (within a few
  seconds), instead of the agent's CLI being launched with the budget as a fixed cap. Claude agents' turns are
  now counted while they work too, not only when they finish.
- capcomd now notices an agent that looks stuck while it works, and tells its parent. An agent is **idle** when
  it has produced no output for `idleAfterMs` (default 30 minutes), **spinning** when it makes the same tool call
  over and over, and **failing** when it hits the same error over and over (both after `stuckRepeats` times,
  default 8). The agent keeps running: `inspect` and `tree` show the `notice`, its work is checkpointed, and
  `capcomd_await`, an agent's own `await` inside its VM, and `capcomd await --notices` return early with `notices`
  so you or the parent can step in. A profile that sets the window (`capcomd agents set <profile>
  --idle-after-ms N` or `--stuck-repeats N`) also stops the agent if it is still stuck after a second window
  (twice as long, or twice as many repeats), with its work kept and `result.limit` set to `idle`, `spinning` or
  `failing`.
- Agents now save checkpoints of their work while they run, so a crash, a cancel or a lost VM no longer loses
  everything since the last commit. Every 10 minutes, and right after the agent commits, a snapshot of its
  workspace is pushed to `refs/capcomd/checkpoints/<agent>` on your repository, without touching the agent's own
  files or git state. `inspect`, `tree` and `await` show the latest one as `checkpoint` (ref, commit, time, files
  changed). To continue from one, start the new agent with
  `git fetch origin refs/capcomd/checkpoints/<agent> && git merge FETCH_HEAD`. Change the interval per profile
  with `capcomd agents set <profile> --checkpoint-every-ms N`.
- Agents that can't spawn now report that they're alive from inside their VM, every 30 seconds, instead of the
  engine inferring it from their output. An agent that is thinking quietly is no longer reported as silent.
- An agent that hits its provider's usage limit (a Claude or ChatGPT plan's limit, or the API's) is now paused
  instead of failed. It keeps what it has done so far on its branch, shows as `paused` in `tree` and `inspect`
  with the time it resumes, and runs again by itself after the provider's reset time, continuing from that
  branch. Other agents on the same login wait for the reset too, instead of starting and failing. To resume
  sooner (for example after upgrading your plan), run `capcomd resume <runId> [agent]`, or call the new
  `capcomd_resume` MCP tool. Resuming happens while the run is being awaited (`capcomd await`, `capcomd_await`, a
  parent agent's `await`).
- **Breaking:** agents no longer have default turn, time or money limits. Before, every agent stopped at 30 turns,
  20 minutes or $2 unless its profile said otherwise, and `capcomd setup` wrote 15–40 minute limits into the
  profiles it created. Now an unset limit means none, so an agent can work for hours as long as it keeps going.
  To keep a limit, set it on the profile (`capcomd agents set worker --max-turns 30 --timeout-ms 1200000 --budget 2`).
  - **Long-running VMs:** a worker's VM is no longer deleted an hour after it was created. Its one-hour delete
    deadline is renewed while its agent runs, so long work isn't cut off and a VM whose engine died is still
    cleaned up.
  - **Setup:** `capcomd setup` asks API-key users once for a spend cap per run (`--budget 20`, or empty for none).
    Plan logins aren't asked, since a plan is already paid for.
- An agent that hits its time, turn or budget limit no longer loses its work or starts over. What it changed is
  pushed to its branch as a `WIP (stopped: <limit>)` commit with a `Capcomd-Stop` trailer, and it ends `failed`
  with `result.limit` (`timeout`, `max_turns` or `max_budget_usd`), `result.branch` and `result.commit`, after one
  attempt. Before, it was retried from scratch up to three times, then failed with nothing pushed. To carry on,
  spawn a new agent with more budget that starts from that branch.
- Agents that can't spawn children are no longer shown as stuck while they work. Only agents allowed to spawn get
  the in-VM `capcomd`, so a worker had no way to heartbeat and `tree`, `inspect` and `capcomd_tree` flagged it
  `stuck` five minutes in, even when healthy. capcomd now counts the agent's own Claude Code or Codex output as its
  heartbeat, so `stuck` means the model has really gone quiet. `capcomd heartbeat "<note>"` still adds a note.
- **Breaking:** a spawn no longer hands the child everything left of a budget it doesn't name. It reserves only
  the units it names, or the profile's own cap (`maxTurns`, `timeoutMs`, `maxBudgetUsd`), and otherwise nothing.
  Spend is now tracked while agents work instead of only when they finish, so `tree`, `inspect` and `budget show`
  are current, and an agent is stopped with its work kept (`result.limit: "max_budget_usd"`) as soon as its own
  budget, a parent's or the run's is spent. Before, the first worker spawned with only `turns` took every
  remaining dollar and second and the next ones were refused (seen in the plugin's live run). To give a child a
  cap of its own, name it: `spawn --budget usd=2`.

## 0.5.0 (2026-10-22)

capcomd as a plugin for your agent: install it in Claude Code or Codex, ask your agent for the outcome, and it runs
the swarm through capcomd's MCP tools. Setup makes the boxd key from your boxd CLI login.

- **Your agent drives capcomd over MCP** (ADR-018 phase 1). `capcomd mcp` now exposes the primitives as tools:
  `capcomd_setup`, `capcomd_profiles`, `capcomd_run_new`, `capcomd_runs`, `capcomd_spawn`, `capcomd_await`,
  `capcomd_send`, `capcomd_cancel`, `capcomd_verify`, `capcomd_merge`, `capcomd_approve`, `capcomd_task`,
  `capcomd_kv`, `capcomd_budget`, `capcomd_tree`, `capcomd_inspect`, `capcomd_events` and `capcomd_trace`. Waits
  return within 55 seconds with what's still pending (call again; the agents keep working). The agent is a
  *driver*: the checks, reviewer and target come from the project's `.capcomd/config.json`, a protected target or
  a budget over `driver.maxRunBudget` is refused, and merges into protected branches wait for a person unless the
  project sets `driver.approvals: "client-confirmed"`. Agents' text arrives fenced. The server starts the engine
  when none is running (`CAPCOMD_NO_ENGINE_AUTOSTART=1` turns that off) and leaves it running, and
  `capcomd_runs` finds runs from earlier sessions. Register it with `claude mcp add capcomd -- capcomd mcp`.
- **Breaking:** the MCP tools `capcomd_run` (it started the `capcomd run` recipe, whose planner is still a fake
  model) and `capcomd_status` are gone: start a run with `capcomd_run_new` and spawn agents, and use
  `capcomd_tree` or `capcomd_runs` for status. `capcomd_approve` takes `merge` (an `mrg-…` id) instead of `taskId`.
- The orchestration skill covers the MCP tools.
- **The capcomd plugin** for Claude Code and Codex (`plugins/capcomd`; this repository is its marketplace): the MCP
  tools and two skills, orchestration and setup. In Claude Code: `/plugin install capcomd --marketplace
  MarvinAmador7/capcomd`; in Codex: `codex plugin marketplace add MarvinAmador7/capcomd`, then `/plugins`. Its server
  runs the installed capcomd in your project, or, when capcomd is missing or older than the plugin, a single
  `capcomd_setup` tool that says what to install. The setup skill walks your agent through onboarding.
- `capcomd setup` installs the plugin in Claude Code and adds the marketplace to Codex (agent step; `--no-plugin`
  skips it), and replaces the skill copy earlier versions put in `~/.claude/skills`. `setup check` reports it.
- `capcomd setup` makes the boxd key itself when the boxd CLI is logged in: a key named `capcomd-<host>`, in your
  active org (or `--org`), kept in the OS keychain and never shown; revoke it with `boxd auth keys rm`. A stale key
  in the keychain is replaced. Without the CLI or a login, setup says exactly what to run.
- Verified live: a headless Claude Code session with only the plugin's tools fixed three files with a swarm of
  three workers (two Claude, one Codex), each checked and reviewed, merged as three PRs (`scripts/mac-plugin-e2e.sh`).
- `capcomd setup check` (and `capcomd_setup`) counts settings from the environment, not only the config files, and
  checks the engine at `CAPCOMD_ENDPOINT`, not only the default port.
- `capcomd_spawn` and the orchestration skill say that budget units a spawn leaves out take everything that's left.
- The orchestration skill moved to `plugins/capcomd/skills/capcomd-orchestration/`; the npm package ships `plugins/`
  instead of `skills/`.

## 0.4.0 (2026-10-21)

First public release: capcomd is open source under the MIT license and installs from npm.

- **Open source, MIT licensed.** capcomd is published to npm (`bun add -g capcomd`); the release workflow publishes
  the package it tested, with provenance. The package no longer pulls in TypeScript (it was a peer dependency) and
  ships the design docs without the chaos logs.
- Contributor guide (`CONTRIBUTING.md`), Code of Conduct, security policy (`SECURITY.md`, private reporting through
  GitHub), issue templates, and Dependabot for the workflows' actions.
- `capcomd serve` waits for its engine to stop when it's stopped (up to 5 seconds, then kills it) instead of
  exiting while the engine still runs.
- Removed leftovers from early development: the root `index.ts` and `test_*` scripts, an uploaded docs archive,
  stray screenshots and internal import notes.

## 0.3.0 (2026-10-21), private preview

Guided setup (`capcomd setup`), the engine as a background service, and releases built and tested by CI.

- **`capcomd setup`**: a guided setup, re-runnable and scriptable (`--yes`). An optional local demo with fake agents
  (no accounts), then the boxd key (validated, kept in the OS keychain: macOS Keychain or Linux Secret Service),
  the agent VM snapshot, Claude/Codex logins (plan or API key), `doctor`, your project (repository, target branch,
  PR or direct merges, a default check from `package.json`, `worker`/`reviewer`/`planner` profiles), the Claude
  Code skill, and the engine as a service. `capcomd setup check` reports what's configured and working.
- **`capcomd service install|uninstall|status`**: the engine in the background (launchd agent on macOS, systemd
  user unit on Linux), restarted on failure.
- **Persisted settings**: `~/.capcomd/config.json` and a project's `.capcomd/config.json` are defaults for the
  environment (a real env var wins); `run new` takes its checks, reviewer and target from the project when no
  flags are given. `CAPCOMD_NO_CONFIG=1` ignores them.
- **Runs carry their repository settings**: `run new` records the repository, merge mode, target, test command and
  protected branches, and the engine uses the run's. An engine started without any of them (the service) works,
  and one engine can serve runs on different repositories.
- `kv list` leaves out reserved `_` keys (the run's settings), as it already did inside VMs; `--prefix _` lists
  them and `kv get` reads them.
- **Releases from CI**: pushing a `vX.Y.Z` tag runs the tests on Linux and macOS and a strict chaos round, packs the
  package, installs it the way a user does (fresh `HOME`, fake agents: `setup demo`, a run, `setup check`, the
  service definition, state only in `~/.capcomd`) on both, then publishes the GitHub release with the package, its
  SHA-256 and this changelog's section as notes (`.github/workflows/release.yml`, `scripts/release-smoke.sh`).
- CI: the crash suite runs as four parallel jobs (one round per push, three nightly): ~8 minutes instead of ~45.
  Bun is pinned (`.bun-version`, 1.4.3) instead of `latest`; `test:fast` (unit, CLI, setup/config, tracing, auth, env, MCP) and the TUI tests run on every push; the
  old killpoint step, which could never fail, is gone (the chaos jobs cover it). CI also checks that CHANGELOG.md
  and the package version agree.
- `AGENTS.md` (and `CLAUDE.md`): the rules coding agents follow here: changes through PRs with a changelog entry,
  Semantic Versioning, releases only from a tag on `main` through CI, never by hand.

## 0.2.0 (2026-10-21), private preview

First tagged release. Installs from git (`bun add -g git+ssh://git@github.com/MarvinAmador7/capcomd.git#v0.2.0`);
needs Bun ≥ 1.4. What works and what's open: [STATUS.md](STATUS.md), [ROADMAP.md](ROADMAP.md).

### Orchestration
- **Primitives** (ADR-016): `run new`, `spawn`, `await` / `wait-any`, `cancel` (propagates), `tree`, a task board
  with fenced leases and dependencies (`task add --after`), a versioned kv blackboard, `events --follow`, multi-unit
  budgets (usd, turns, wallSeconds), idempotent `--key` on every write.
- **Sub-agents in VMs** (ADR-017): agents allowed to spawn get the same verbs inside their VM (in-VM CLI and MCP
  tools over the exec channel), with capability tokens, narrow-only fan-out set by the parent, budget carving,
  stuck detection and fencing of agent-written text.
- **Gates**: `verify` runs checks on the branch merged with the latest target; `merge --require` lands only that
  exact commit and re-runs the same checks. Operator-named checks (`run new --checks-set`), pinned per child at
  spawn (`spawn --check`).
- **Reviewer**: `run new --reviewer P`; after the checks pass, a reviewer agent reads the commit (read-only, never
  pushes); checks and review must both pass, no verdict fails. Replaces the old fake-model judge in `verify`.
- **Checks in a VM**: with real agents (boxd), checks run in a throwaway VM, never on the orchestrator host.
- **Report mode** (`spawn --report`), **per-run staging targets** (`run new --target T --target-from BASE`), and
  **approval requests**: an agent's merge into a protected branch waits for `capcomd approve <runId> <mrgId>`.
- **Interface-first** pattern for dependent work (planner guidance + scenario test).

### Agents and environments
- Claude Code and Codex adapters; agent profiles (`capcomd agents …`); subscription logins (`auth login`);
  boxd host-bound secrets (`secrets sync`); env snapshots (`env build`); `doctor`.
- Costs: billed USD plus the API-price estimate for subscription work (`~$0.04`) in `tree`, `budget` and the TUI.

### Observability
- Versioned JSON contract for every command (`--json`, schema `relay.v1`, exit codes), MCP server, traces,
  `inspect --follow` (snapshot, events, tree and trace updates).
- Terminal debugger (`apps/tui`): Live tree with parallel groups, reviewers and per-agent pipelines; Waterfall,
  Timeline, Rollups, Events and Replay views that fill in while a run executes.

### Reliability and CI
- Crash safety: atomic lifecycle transitions, epochs, an outbox, exactly-once merges; chaos killpoint suite and
  strict `chaos:fast`.
- CI runs for the first time (the workflow file had been invalid YAML): typecheck, state machines, the scenario
  suite, killpoints, nightly `chaos:fast`. Tests run on macOS and Linux.

### Upgrade notes
- An **installed** CLI keeps state in `~/.capcomd` (`state/`, `traces/`, `agents.json`), or `$CAPCOMD_HOME`. A git
  checkout of capcomd keeps its old layout (`.relay/`, `.traces/`, `.capcomd/agents.json`). Per-file overrides
  (`CAPCOMD_AUTH_LEDGER`, `CAPCOMD_ENV_LEDGER`, `CAPCOMD_TRACE_DIR`, `CAPCOMD_AGENTS_FILE`, …) still win. A project's
  own `.capcomd/agents.json` (in the current directory) is used when present.
- `verify --judge-profile` is now an alias of `--review-profile` and runs a real reviewer agent; an unknown profile
  is refused.

### Known limitations
- `capcomd run "<goal>"` is **experimental**: its planner and run-level judge still use a fake model. Use the
  primitives for real work.
- A real agent's spend is known only when it finishes; no stacked branches yet (dependent work goes interface
  first); one engine per machine (no Rivet Cloud); no standalone binary yet (`serve` doesn't work compiled).
- `capcomd ui` (the web canvas) isn't part of the package; run it from a checkout.
