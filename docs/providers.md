# Sandbox providers

Agents run in sandboxes from a provider, chosen with `CAPCOMD_SANDBOX` (ADR-020):

| `CAPCOMD_SANDBOX` | Sandboxes | Snapshots | Host-bound secrets | Egress allowlist | Needs |
|---|---|---|---|---|---|
| `boxd` | cloud VMs ([boxd](https://boxd.sh)) | ✓ | ✓ | ✓ | a boxd account (`BOXD_API_KEY`) |
| `docker` | containers on this machine | ✓ (images) | – | – | Docker: Docker Desktop, OrbStack, Colima, or Podman's docker |
| `fake`, `fake-host` | nothing (tests) | | | | |

## Docker

```bash
export CAPCOMD_SANDBOX=docker
capcomd env build              # a container from node:22-bookworm with the pinned agent CLIs, committed as an image
capcomd auth login claude      # a plan login, kept in a local image (capcomd-auth-…), never on the host
capcomd serve                  # the engine also removes expired sandbox containers every 5 minutes
```

Env snapshots and plan logins are kept per sandbox. To prepare Docker while the daemon runs on boxd (for runs started
with `--sandbox docker`, or Local in the menu bar app), pass the sandbox instead of exporting it:
`capcomd env build --sandbox docker`, `capcomd auth login claude --sandbox docker`.

- **Where it finds Docker:** `CAPCOMD_DOCKER_BIN`, `docker` on PATH, or OrbStack's and Docker Desktop's usual
  places. The base image is `CAPCOMD_DOCKER_IMAGE` (default `node:22-bookworm`: node, git, coreutils, util-linux).
- **A sandbox is a container** named after the agent's idempotency key, with capcomd's labels; it lives until the
  agent ends (or its delete-after time passes, if the engine went away). `docker ps --filter
  label=dev.capcomd.sandbox=1` lists them.
- **A warm workspace.** `capcomd env build` keeps a warm checkout of the project in the env image (the template, at
  `/var/tmp/capcomd/template`): the whole history of the target branch (`CAPCOMD_MERGE_TARGET`, else the default
  branch), its dependencies installed for Linux (with the package manager the lockfile needs when the base image has
  none: bun at the version the project pins in `packageManager` or `.bun-version`, else `CAPCOMD_BUN_VERSION` or
  1.4.3), and its record (commit, lockfile hash) in the template's `.git` and in the env manifest. The same secret scan
  runs before the image is committed; no credential is baked in (git gets its token per command, as before). Every
  container is its own copy-on-write copy of the image, so an agent works in the template in place: `git fetch`, then
  `git checkout -B <branch>`, edit, commit. Its branch, tree and commit are the same as from a fresh clone, and a new
  agent's workspace is ready in about a second instead of a clone plus a copy of `node_modules`.
- **When it clones instead.** The runner uses the template only when its commit is in the target's history, the
  lockfile of the tree the agent starts from is the one its dependencies were installed for, it is of the run's
  repository, and no earlier run in that container used it (a retry); otherwise it clones and copies the template's
  `node_modules` when the lockfile matches, as before (src/agents/workspace.ts `chooseWorkspace`). The agent's log
  says which (`[capcomd] workspace: …`), and so does its span (`agent.workspace`, `agent.workspace_ms`). boxd VMs
  always clone; their snapshot keeps a shallow template for `node_modules` only.
- **Drift.** Images change only on `capcomd env build`, never by themselves. `capcomd env status` and `capcomd env
  doctor` say how far the template is behind the target (agents fetch the difference), when the lockfile changed
  (agents then clone and install their own dependencies) and when the target was rewritten, and suggest `capcomd env
  build --sandbox docker`.
- **Plan logins move with the env image.** A plan login is an image made from the env image of its day (the env
  image plus the login's credential files), and agents with that login boot from it. So `capcomd env build --sandbox
  docker` carries every such login over onto the new env image (src/auth/carry.ts): it starts a container of the old
  login image and reads only the login's files from it (Claude Code: `~/.capcomd-auth/claude.env`, and
  `~/.claude/.credentials.json` if there is one; Codex: `~/.codex/auth.json` and `~/.codex/config.toml`), writes them
  into a container of the new env image (folders 0700, files 0600), checks that the agent finds the login there as
  the runner does (no model call), and saves that container as the new login image. Only then does the login point at
  it (`auths-docker.json`: `snapshot`, `env`, and `carriedFrom`/`carriedAt`), and the old login image is removed. The
  env image itself never holds a login: its secret scan runs before it is saved, as before, and nothing writes to it
  afterwards. The build lists each login it moved (`logins` in `--json`). A login it couldn't move keeps working from
  its old image (older CLIs and template); the build says why and what to run, and `env status` / `env doctor` keep
  naming it until the next build moves it or `capcomd auth login … --sandbox docker` replaces it.
- **Agents at once.** Agents' containers share Docker's memory (Docker Desktop's or OrbStack's VM), and memory runs out
  before disk does (one agent CLI is 0.3-0.6 GB). So at most `docker info` MemTotal ÷ the memory per agent run at once.
  The memory per agent is a setting, Memory per agent (`agentMemory`) in Local's details: 512 MB, 1 GB (the default),
  2 GB or 4 GB. `CAPCOMD_DOCKER_AGENT_MEMORY_MB` in capcomd's environment wins (any whole number of MB from 256; the
  setting is then read-only), then the user config (`sandboxes.docker.agentMemory`, MB), then 1 GB. It is read each
  time an agent asks for a slot, so a change applies to the next agent that starts (those waiting included) and needs
  no restart; the Agents at once row (`agentSlots`) shows the new cap at once. Above the cap a new agent stays
  `pending` (its log says it waits for a slot) and starts, oldest first, when a slot frees: when another agent's
  container is removed, or when an admitted agent's workflow ends before its container appeared (it was cancelled or
  paused first, or failed to start), or, as a backstop for one still starting, 10 minutes after it was admitted.
  Running capcomd agent containers count, so agents from before a daemon restart do too. It applies to every agent the
  engine's workflow drives (the default): agents spawned with `capcomd spawn`, by other agents, by a planner, and by
  `capcomd run`'s recipe. Agents driven by `CAPCOMD_AGENT_WORKFLOW=0` (agent-drive processes, being retired) and
  `capcomd run --legacy`'s single worker don't wait for a slot (their containers still count against it), and boxd
  has no cap.
- **Differences from boxd:**
  - Isolation is a container, not a VM: the agent can't see your files, but a kernel exploit would reach the host.
  - No host-bound secrets: an API key (auth `apikey`) reaches the agent in its environment, where it can read it.
    Plan logins (auth `subscription`) are unaffected.
  - No egress allowlist: containers get Docker's network. Agents have open egress by default anyway; a profile that
    sets `egress` is refused on Docker rather than run unrestricted. The checks sandbox (verify and merge) has open
    network too.
  - `capcomd secrets sync` is a boxd feature; on Docker there's nothing to sync.

## Writing a provider

1. Implement `SandboxProvider` (`src/providers/sandbox.ts`):
   - `ensure(spec)`: create the sandbox for `spec.idemKey`, or return the one that exists (idempotent, also across
     a crash); boot from `spec.fromSnapshot` when given; `ttlSeconds` is when it may be deleted if nobody renews it
     (`extendTtl`).
   - `exec(id, argv, {env, cwd, timeoutMs})`: run argv (no shell), with that env added, and kill it at the timeout;
     return `{code, stdout, stderr}`. Commands started detached (`setsid nohup … &`) must outlive the exec: the agent
     runs that way and later execs poll it.
   - `upload` / `download` absolute paths (parent directories exist), `destroy` (idempotent), `list(prefix)`.
   - Git network commands (`git clone/fetch/push`) get the per-exec credentials of a `GitCredentialHook`.
2. Add its descriptor to `PROVIDERS` in `src/providers/registry.ts` (ADR-021), and create it in `providerFromEnv`
   (`src/dependencies.ts`). The descriptor is what the engine asks (`sandboxCaps()`) and what the daemon serves to
   clients as data (`GET /v1/sandboxes`), so the app needs no change for a new place:

   ```ts
   lima: {
     name: "lima", descriptorVersion: 1, label: "Local VM", kind: "local", vendor: "Lima", title: "Local VM · Lima",
     mark: "lima", listed: true,
     caps: { isolation: "vm", snapshots: true, hostBoundSecrets: false, egressAllowlist: false, interactive: true,
             idleLifetime: "sweep", shell: true },
     settings: ["idleLifetime"], info: ["logins", "checkpoints"], resourceKinds: ["machine"],
     actions: ["open_terminal", "delete"],
   },
   ```

   - `label`, `vendor`, `title`: what clients call it ("Local VM", and "Local VM · Lima" on its details screen);
     `kind` (`local` or `cloud`) groups it and picks the app's fallback glyph; `mark` is the id of a mark the app may
     bundle (an unknown one falls back to the glyph). `listed: false` keeps it out of clients' lists (the test fakes).
   - `isolation`: `vm`, `container`, or `host` (tests only);
   - `snapshots`: also implement `snapshotCreate/Get/List/Delete` (`src/env/platform.ts`) for `capcomd env build`
     and plan logins;
   - `hostBoundSecrets`: `secretSet/List/Delete`, where the agent sees only a placeholder;
   - `egressAllowlist`: whether `spec.egressAllow` is enforced (`["*"]` means unrestricted);
   - `interactive`: `streamExec` with a terminal, for `capcomd auth login`;
   - `idleLifetime`: who deletes a machine left behind once `ttlSeconds` is up: `platform` (the provider does, like
     boxd's delete-after), `sweep` (capcomd's engine does, like Docker's ledger and 5-minute sweep), or `none`;
   - `shell`: `capcomd sandbox shell` can open an interactive shell in a live machine (`streamExec` with a terminal,
     or the provider's own CLI, like `docker exec -it`);
   - `settings`, `info`, `actions`: the rows and resource actions its details screen offers, from the closed lists in
     the registry (`SETTING_IDS`, `INFO_IDS`, `RESOURCE_ACTIONS`). The daemon serves only the actions it implements.
     `agentSlots` (Agents at once) is for a local place whose agents share one machine's memory: give it a memory probe
     in `src/providers/capacity.ts` (`PLACES`), and the engine caps its agents the same way as Docker's.
   - A sandbox that is each agent's own copy of its image (`isolation: "container"`) gets the warm workspace: `env
     build` keeps a warm template in its snapshot and the runner may use it in place (`warmTemplate`).

   **Settings** (`PATCH /v1/sandboxes/{name}/settings`, the `configure` scope; `src/providers/settings.ts`). Two today.
   `agentMemory` (Docker; with the `agentSlots` info row): how much of the machine's memory each agent gets, in MB,
   from the presets 512, 1024, 2048 and 4096 (`appliesTo: new_agents`; see Agents at once above for its precedence).
   A place that offers it needs a memory probe in `src/providers/capacity.ts`. And `idleLifetime`: how long a machine left behind lives, in seconds. It is a lease: `ensure` gets it as `ttlSeconds`,
   and a running agent renews it every 10 minutes (`extendTtl`), so the daemon refuses anything under 15 minutes. The
   presets are 15 minutes, 1 hour (the default), 4 hours and 12 hours, the same on every provider. Precedence:
   `CAPCOMD_SANDBOX_IDLE_SECONDS` in capcomd's environment (any whole number of seconds, raised to the 15-minute
   minimum; the field is then read-only), then the user config (`~/.capcomd/config.json`, or `$CAPCOMD_HOME`'s,
   `sandboxes.<name>.idleLifetime`), then the default. Settings live only in the user config, never a project's.
   `run new` records the place's settings with the run (kv `_sandbox`: `{name?, settings: {idleLifetime}}`; old readers
   only read `.name`), and the run's workers use the recorded value for the VM's `ttlSeconds`, their renewals and
   their own reap alarm, so a change applies to new runs and needs no restart. A run with nothing recorded uses the
   place's setting when its worker starts. A provider whose `idleLifetime` cap is `sweep` enforces each machine's own
   deadline (Docker's ledger), so a machine can outlive it by up to one sweep (5 minutes). Every change is audited as a
   durable `sandbox.settings_changed` event on the `daemon` stream.

   **Delete** (`POST /v1/sandboxes/{name}/resources/{id}/actions/delete`, capability `sandboxes.actions`, the steer
   scope; `src/api/sandboxes.ts`). A provider that declares `delete` needs nothing more than an idempotent `destroy`
   (a machine already gone is not an error) and a `list` that names machines by their `MACHINE_PREFIX` names: an
   agent's machine is deleted by cancelling the agent (its worker destroys the machine as it drains), and only a
   machine left behind reaches `destroy` directly, with the provider id its `list` gave. The daemon checks the id
   against its own list, lists again right before acting, and gives the provider 10 seconds to list and 30 to delete
   (then 503 `unavailable`). Deletes are audited on the `daemon` stream (`sandbox.resource_action`,
   `sandbox.resource_deleted` with cause `action`, `idle_lifetime` or `run_ended`): a provider whose `idleLifetime` is
   `sweep` reports its sweep's deletes through `reportMachineDeleted` (`src/providers/machine-audit.ts`), as Docker's
   `sweepIdle` does; deletes a platform makes by itself aren't reported.

   **Machines capcomd's own jobs make.** Every capcomd process that makes a machine outside an agent's worker (the
   checks VM in `verify`, `auth login` / `auth status`, `env build`, `env doctor`) records it in capcomd's machines
   ledger (`<state>/machines/<name>.json`, or `CAPCOMD_MACHINES_LEDGER`; `src/providers/machines.ts`) before `ensure`
   and removes the record once it destroyed the machine. A record counts while the process that wrote it is alive and
   the machine's lifetime isn't up. The resources route lists such a machine as `running` with an owner of its `kind`
   (`check`, `login`, `env_build`, `doctor`) and no actions, and calls a machine `orphaned` only when nothing in capcomd
   uses it: no live agent's worker and no live job. Provider labels are never trusted for this (a sandbox can forge
   them). A new place where capcomd makes machines for its own jobs records them the same way
   (`recordJobMachine`).

   A listed provider also needs an availability check in `src/api/run-options.ts` (`AVAILABLE`: cheap and local, like
   "is a key configured" or "does the CLI answer", cached), and its `list(prefix)` should fill `createdAt` and
   `deleteAt` when it knows them: `GET /v1/sandboxes/{name}/resources` shows them. Machines must be named with
   `MACHINE_PREFIX` (`src/providers/sandbox.ts`): that is how capcomd finds its own, and `capcomd sandbox shell` only
   accepts ids that carry it.
3. Run the conformance suite against it (`tests/providers/conformance.test.ts`: add it to `subjects`).
