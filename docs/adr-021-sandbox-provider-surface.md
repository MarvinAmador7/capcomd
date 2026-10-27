# ADR-021: A provider surface for place details: descriptors, settings, resources and actions

**Status:** accepted (2026-10-27; every open question decided by the owner). Nothing here is built yet. Builds on ADR-020 (the provider registry and
its capabilities), ADR-015 (host-bound secrets, plan logins), ADR-016 (primitives, scoped tokens) and ADR-019 §3, §7
(checkpoints; no restrictions by default).

## Context

The owner wants a **Cloud details** screen in Settings (Runs › a place's details; `apps/menubar/design/settings/
CloudExplore.dc.html`): the machines capcomd's agents run on, with Open in Terminal and Delete…, "Delete idle machines
after", "Sites agents can reach", Logins bound to each AI's API host, and Checkpoints. Today there are two places,
Local (Docker) and Cloud (boxd), and more clouds and local VM providers will come, so the app must not hard-code
boxd. ADR-020 made providers a contract for the *engine*; nothing describes a provider to *clients*.

Where provider behaviour is fixed in code today:

| Concern | Today | Where |
|---|---|---|
| Places offered | `RUN_SANDBOXES = ["docker","boxd"]`, labels `Local`/`Cloud`; `SETTINGS_SANDBOXES` again | `src/api/run-options.ts:16-18`, `src/api/settings.ts:17` |
| Place names in the API | `z.enum(["docker","boxd"])`; `drivers[].sandboxes` is an object with exactly those keys | `src/api/contract.ts:313,335,338,356` |
| Availability | boxd: an API key; Docker: `docker version`, cached 5 s, 3 s timeout | `src/api/run-options.ts:25-62` |
| Idle machine lifetime | `AGENT_VM_TTL_SECONDS = 3600`, renewed every 10 min while the agent runs; worker `ttlMs: 3_600_000` | `src/agents/runner.ts:118-119,525`, `src/actors/worker.ts:199,233,453` |
| How it's enforced | boxd: platform `deleteAfter` (`boxd.ts:196`, `setDeleteAfter` `:382`); Docker: a ledger plus a sweep every 5 min | `src/providers/docker.ts:56,182-193`, `src/cli/commands/serve.ts:150-157` |
| Default egress | real agents get `*` (open) unless `CAPCOMD_AGENT_EGRESS` or the profile's `egress` says otherwise (ADR-019 §7) | `src/agents/config.ts:206` |
| Egress on Docker | a profile that narrows egress is refused, since Docker can't enforce it | `src/primitives/ops.ts:199` |
| Host-bound logins | Claude plan token goes into a boxd secret bound to `api.anthropic.com` when the key allows it, else into the snapshot; Codex is always in the snapshot | `src/auth/login.ts:90-98`, `src/api/settings.ts:38,43-44` |
| Checkpoints | git checkpoints by the in-VM supervisor (ADR-019 §3), every `CAPCOMD_AGENT_CHECKPOINT_MS` (10 min) and after commits; provider `checkpoint/restore` are unused by the engine and throw on Docker | `src/agents/config.ts:194`, `src/providers/sandbox.ts:44-45`, `src/providers/docker.ts:164-165` |
| Machine ownership | worker actors hold `vmId` (`worker.ts:264`); boxd labels exist only in process memory, Docker's are on the container | `src/providers/boxd.ts:116,217`, `src/providers/docker.ts:113` |
| Machine end | an agent's machine is destroyed right after its push, paused agents included | `src/primitives/ops.ts:580` → `src/actors/worker.ts:123` |
| Terminal from the app | `capcomd tui <run>` via a `.command` file; Settings runs only plain `capcomd …` commands | `RunDrillDownView.swift:680-690`, `SettingsModel.swift:142-143`, `CapcomdStore/Settings.swift:318` |
| App branches on names | `place.name == "boxd"` / `"docker"` for the key row, footers and status copy | `SettingsRuns.swift:140-168` |
| Token scopes | `read`, `steer`, `approve`; GET needs read, POST needs steer | `src/api/clients.ts:9`, `src/api/server.ts:136` |

Two pieces of the canvas don't match the code. **"Sites agents can reach: Only what they need"** is not the
default: agents have open egress (`config.ts:206`), and only a profile's `egress` narrows it. **"asleep"** machines
don't exist: a paused agent's machine is destroyed after its push (`ops.ts:580`). The screen must show what is true.

Constraints we keep: reads stay cheap and pollable (as the `run-options`, `logins` and `environments` docs promise,
`contract.ts:348,366,376`); no route ever returns a credential; old apps and old daemons degrade through
`/v1/health` `capabilities` (`contract.ts:280`); the app only ever launches plain capcomd commands.

## Decision

### 1. Provider descriptor: declared in TypeScript, served as data

| Option | For | Against |
|---|---|---|
| **A. Static TS descriptor per provider** (extends the ADR-020 registry entry) | One place for caps, settings, actions; typechecked with the provider; zod gives OpenAPI for free | A new provider is a capcomd release |
| B. Data-driven manifest (JSON next to a provider plugin) | Out-of-tree providers | The engine still needs code for each provider, so the manifest can drift from what the code does; needs a loader and signing |
| C. No descriptor: bespoke routes per provider | Fastest for boxd | Every provider is new API and new Swift |

**Decision: A.** Each provider module exports a `ProviderDescriptor`; `PROVIDERS` (`registry.ts:21-30`) becomes the
list of descriptors, and `ProviderCaps` stays the engine's view of them. The daemon serves the descriptor as data,
so clients are data-driven even though providers are declared in code. A manifest (B) can come later, generated from
the same type, if out-of-tree providers become real.

```json
{ "name": "boxd", "descriptorVersion": 1, "label": "Cloud", "kind": "cloud", "vendor": "boxd",
  "title": "Cloud · boxd", "mark": "boxd", "listed": true,
  "caps": { "isolation": "vm", "snapshots": true, "hostBoundSecrets": true, "egressAllowlist": true,
            "interactive": true, "idleLifetime": "platform", "shell": true, "costs": false },
  "settings": ["idleLifetime"], "info": ["logins", "checkpoints"],
  "resourceKinds": ["machine"], "actions": ["open_terminal", "delete"] }
```

- `kind` is `local | cloud`, so the app can group places and pick a fallback glyph; `vendor` is what the title says
  after the dot. `listed: false` keeps `fake` and `fake-host` out of client lists.
- New caps: `idleLifetime` (`platform` when the provider deletes the machine itself, `sweep` when capcomd's engine
  does, `none`), `shell` (an interactive shell into a live machine), `costs` (the provider reports a price).
- **Versioning:** additions only. A field's meaning never changes; a breaking change needs a new `descriptorVersion`,
  and the daemon serves the highest version the client asks for (`?v=`). Clients ignore unknown caps, actions and
  setting ids. An unknown `kind` renders as `cloud` with the generic glyph.

### 2. Settings: a small typed schema the app renders generically

| Option | For | Against |
|---|---|---|
| **A. Generic field schema** (closed set of field types) | A new provider needs no Swift; validation lives in the daemon | Less freedom per screen |
| B. Bespoke Swift screen per provider | Pixel freedom | An app release per provider; an old app shows nothing for a new one |
| C. A plus a per-provider Swift override keyed by `name` | Escape hatch | Two paths to keep in step |

**Decision: A**, with C allowed only for visuals (marks), never for which settings exist. Field types are closed:
`choice` (durations are choices of presets), `toggle`, and read-only `info` and `status` rows. There is **no free text
and no secret input** in v1: host lists stay in agent profiles, and keys stay in `capcomd setup` in Terminal.

```json
{ "id": "idleLifetime", "type": "choice", "label": "Delete idle machines after",
  "help": "A machine left behind (a crash, a stopped run) is deleted after this, so it stops billing.",
  "value": "3600", "display": "1 hour", "default": "3600",
  "choices": [{"value":"900","label":"15 minutes"},{"value":"3600","label":"1 hour"},
              {"value":"14400","label":"4 hours"},{"value":"43200","label":"12 hours"}],
  "source": "default", "editable": true, "appliesTo": "new_runs", "needsRestart": false }
```

Every field carries `display`, a string the daemon writes. An app that doesn't know a field's `type` shows
`label` and `display` as a read-only row, so new field types never break old apps.

**Storage and precedence.** Provider settings are per machine and per account (they decide billing and exposure), so
they live in the **user config** under a new key, `~/.capcomd/config.json` `sandboxes.<name>.<id>`, not in project
config. Projects already narrow per profile (`egress`, limits). Precedence: an environment variable, then the user
config, then the descriptor's default. When a variable wins, the field says `source: "env"`, `editable: false` and
`display: "Set by CAPCOMD_AGENT_EGRESS in capcomd's environment"`. This is the rule `src/config/store.ts:1-3` already
states for `env`.

**How values reach the engine.** `applyConfig` copies config into the environment once, when the process starts
(`src/cli/apply-config.ts:7`), so a daemon would need a restart to see a change. Instead, `run new` reads the
provider's settings from the file and records them with the run's sandbox: the `_sandbox` value goes from `{name}`
(`ops.ts:142`) to `{name, settings: {idleLifetime}}`. Old readers only look at `.name`
(`run-sandbox.ts:34`). The worker reads them through `runSandbox()`. A setting applies to new runs (`appliesTo:
"new_runs"`), a run keeps the policy it started with, and nothing needs a restart. Runs without a recorded
sandbox read the daemon's current settings when the worker starts.

**The three canvas rows:**

- **Idle machine lifetime** (`idleLifetime`, needs `caps.idleLifetime != "none"`). This replaces
  `AGENT_VM_TTL_SECONDS` and the worker's `ttlMs` (`worker.ts:199,233,453`, `runner.ts:525`) with the run's value.
  The value is a lease, not a total lifetime: it renews every 10 min while the agent runs (`runner.ts:119`), so the
  daemon refuses anything under 15 min, which would delete live machines between renewals. boxd enforces it on the
  platform; Docker enforces it with the sweep, so a machine can outlive the setting by up to 5 min, and the help text
  says so. The environment variable is a new `CAPCOMD_SANDBOX_IDLE_SECONDS`.
- **Egress: not a setting (decided by the owner, 2026-10-27).** No restriction by default (ADR-019 §7), and site
  access is an internal policy best handled by the provider, not something capcomd's Settings exposes. So there is
  no `egressDefault` field and no "Sites agents can reach" row; the "Containers can't limit which sites agents reach"
  footer goes too. What stays: a profile's `egress` and `CAPCOMD_AGENT_EGRESS` for those who narrow it on purpose,
  and the `egressAllowlist` cap for the engine's own check (`ops.ts:199`).
- **Checkpoints** (`info`, the same on every provider). These are git checkpoints (ADR-019 §3) and have nothing to do
  with the provider, so the descriptor doesn't own the row; the daemon builds it from `CAPCOMD_AGENT_CHECKPOINT_MS`:
  "After each commit and every 10 minutes". Provider `checkpoint/restore` stays out of the UI.
- **Logins** (`info`): a summary of `/v1/logins` for this place (below), not a claim about the provider.

### 3. Resources and actions

A **resource** is something live that capcomd created at a provider. v1 has one kind, `machine`. The list comes from
capcomd's records joined with the provider's list. Ownership comes from capcomd, never from provider labels: the
worker actors that hold a `vmId` give the run, the agent and its role. Provider rows that carry capcomd's prefix
(`boxd.ts:399-401`; Docker's `dev.capcomd.sandbox` label) but have no live owner are `orphaned`. Those are the
"machines left behind" that the idle lifetime cleans up.

```json
{ "id": "relay-3f9c2a1b7e5d4c60", "kind": "machine", "state": "running",
  "owner": { "runId": "run-8kq2", "agentId": "agt-41", "role": "worker", "task": "Add an abs(a) function…" },
  "createdAt": "2026-10-27T09:12:03.000Z", "deleteAfter": "2026-10-27T10:22:03.000Z",
  "cost": null, "actions": ["open_terminal", "delete"] }
```

`state` is one of `starting | running | asleep | orphaned | stopping | unknown`. `asleep` is reserved: today no
machine sleeps (`ops.ts:580`). `cost` stays `null` unless `caps.costs` is set. Actions come from a **closed list**
declared in code; the descriptor only says which of them a provider supports:

| Action | Effect | Scope | Destructive | Request |
|---|---|---|---|---|
| `open_terminal` | returns a command, mutates nothing | read | no | `GET …/resources/{id}` gives `terminalCommand` |
| `delete` | owned machine: cancel that agent through the normal cancel path (`agent.cancelled`, machine destroyed); orphan: `provider.destroy` | steer | yes, the app confirms | `POST …/actions/delete`, Idempotency-Key |
| `extend` (later) | `extendTtl` by the idle lifetime | steer | no | POST, Idempotency-Key |
| `stop` (later) | `suspend`, only after the engine can resume a suspended machine | steer | yes | POST, Idempotency-Key |

`delete` on an owned machine goes through the agent's cancel path on purpose: calling the provider directly would
leave the agent's lifecycle claiming a machine that no longer exists. Cancelling a run already needs only `steer`
and already destroys machines (`runs.cancel`), so `delete` doesn't need a new scope.

**Open in Terminal stays safe.** The daemon builds `terminalCommand` from trusted ids, never from provider strings:
`capcomd sandbox shell run-8kq2 agt-41` for an owned machine, and `capcomd sandbox shell --sandbox boxd --machine
relay-3f9c2a1b7e5d4c60` for an orphan. The CLI looks the machine up again and only accepts ids matching
`[A-Za-z0-9._-]{1,128}` that carry capcomd's prefix. `capcomd sandbox shell` is a new command: boxd uses
`streamExec` with a tty (`boxd.ts:357`), Docker uses `docker exec -it`. It needs `caps.shell`, uses the CLI's own local
credentials (never the app's API token), and opens with a warning that the shell is inside an agent's sandbox. The
app runs the command with `TerminalLauncher.run`, which still checks `isSafeCommand` (`Settings.swift:318`).

### 4. API surface

| Route | Scope | Cost | Returns |
|---|---|---|---|
| `GET /v1/sandboxes` | read | local only | `{sandboxes: [descriptor + available/reason/default]}`, listed providers only |
| `GET /v1/sandboxes/{name}` | read | local only | `{descriptor, settings: Field[], info: Field[], rev}` |
| `PATCH /v1/sandboxes/{name}/settings` | **configure** | file write | body `{values: {id: value}, rev}` → the same shape as GET |
| `GET /v1/sandboxes/{name}/resources` | read | provider list, cached | `{resources, asOf, stale, error, next}`; `?limit` (≤ 200) and `?cursor` |
| `GET /v1/sandboxes/{name}/resources/{id}` | read | cached | one resource + `terminalCommand` |
| `POST /v1/sandboxes/{name}/resources/{id}/actions/{action}` | steer | provider call | `{resource, changed}`; `Idempotency-Key` required (the `WRITE_DOC` rules, `contract.ts:273`) |

New capabilities: `sandboxes` (the two GETs), `sandboxes.settings` (PATCH), `sandboxes.resources` (resource GETs),
`sandboxes.actions` (POST; the exact actions come from the descriptor). Each phase adds exactly one of them.

- **Relation to existing routes.** `run-options` `sandboxes` stays as it is (the composer and Runs on depend on it).
  In phase 1, `sandbox` becomes `z.string()` checked against the listed providers (`contract.ts:313,338,356`), and
  `drivers[].sandboxes` becomes a record. Both changes are wire-compatible: the app already decodes `name` as `String`
  and `drivers[].sandboxes` as `[String: …]` (`Ports.swift:178,221`). `/v1/logins` and `/v1/environments` stay and gain
  `?sandbox=`. The details screen reads them instead of copying their data into `/v1/sandboxes/{name}`. One source
  per fact.
- **Logins gain two fields**, `hostBound: boolean` and `boundTo: string | null`, set where the ledger records
  `store: "secret"` or `CAPCOMD_CREDENTIALS=secret` (`settings.ts:38,43-44`). The Logins info row says "Bound" only
  when every logged-in login here is bound, and otherwise names which ones are not (codex plan logins live in the
  snapshot, `login.ts:90-98`).
- **Cost and latency.** The descriptor and settings routes never call a provider. The resources route calls
  `provider.list` at most every 10 s per provider, single-flight, with a 3 s timeout (the `dockerReachable` pattern,
  `run-options.ts:25-42`). On a timeout or error it returns the last good list with `stale: true` and `error`, and
  the status is still 200, like `runs.files` `sources[].error`. It never makes one provider call per resource.
- **Errors** use `ApiError` (`contract.ts:26`): `not_found` (an unknown sandbox, resource or action, or an action the
  provider doesn't declare), `invalid` (422: a value not in `choices`, a lifetime under the minimum, a field that
  isn't editable), `conflict` (409: a stale `rev`, or a resource in the wrong state), `forbidden` (scope). A provider
  that doesn't answer during an action gets a new code, `unavailable` (503). Clients already treat unknown codes as
  generic errors.

### 5. Secrets and security

- **No secret values, anywhere.** No field type takes or shows a secret; `display`, `help` and `reason` are written
  by the daemon from fixed templates. Host binding appears as data (`hostBound`, `boundTo`) and never as a
  placeholder value.
- **A new `configure` scope** for `PATCH …/settings`. Settings change policy for future runs: widening egress, or
  keeping machines (and billing) around longer. That is a different power from steering one run.
  `capcomd clients add` accepts it. The app's token reset (`SettingsModel.swift:161`) asks for
  `read,steer,approve,configure`. An app whose token lacks the scope shows the settings read-only with "Reset your
  token to change these" (question 3).
- **Audit.** Durable events on the `daemon` scope: `sandbox.settings_changed {sandbox, id, from, to, clientId}`,
  `sandbox.resource_action {sandbox, resourceId, action, owner, clientId}` and `sandbox.resource_deleted {sandbox,
  resourceId, cause: "action" | "idle_lifetime" | "run_ended"}`. The sweep and the platform's delete-after report
  these too, where capcomd can observe them.
- **Bounding the generic action endpoint.** The risks are verbs nobody reviewed, injection through ids, deleting
  machines that aren't capcomd's (a boxd org lists everyone's machines), and mass deletion. The limits: actions come
  from a closed list in code, and each provider declares a subset; `{id}` must resolve to a resource in capcomd's own
  list (prefix + label or ledger) before any provider call; there are no batch or wildcard ids; destructive actions
  carry `destructive: true` and a daemon-written `confirm` text that the app shows in a sheet, and the daemon checks
  the state again before it acts; requests are idempotent; and requests carry no free-form parameters.

### 6. App rendering

- **`SandboxDetailsView(name)`**: one generic view, opened as a sheet by Details… on each place's status row in Runs
  (amended 2026-10-27: a sheet, as Wi-Fi's Details…, not a pushed page). Section headers name the kind of place only
  (the mark and `label`: "Cloud"); the provider's status row carries its name, the Default badge or Make Default, and
  Details…. Then Status (the existing availability and key rows),
  Agent environment (`/v1/environments`), Machines (resources plus `idleLifetime`), and Safety (
  Logins, Checkpoints) as `Form` sections in `.grouped` style. The section order and copy shells are fixed in Swift,
  matching the approved canvas. Which rows appear, their values, choices, help and footers come from the daemon.
- **Controls by type:** `choice` → `Picker(.menu)`; `toggle` → `Toggle`; `info` / `status` → `LabeledContent` with
  the existing status dot styles; resources → rows with a relative age and Open in Terminal or Delete… (a
  confirmation dialog using the daemon's `confirm` text). Everything uses native controls, so nothing needs custom
  drawing.
- **Marks are bundled, not downloaded.** `mark` is an id. `ProviderMarks` (`ProviderMark.swift:9`) maps known ids:
  `docker` is the official mark; `boxd` uses the cloud glyph until boxd's own mark arrives. An unknown id falls back
  to an SF Symbol chosen by `kind` (`desktopcomputer` for local, `cloud` for cloud). The daemon never sends SVG.
- **Remove the name checks.** `SettingsRuns.swift:140-168` switches from `place.name == "boxd"/"docker"` to
  descriptor data (`caps.egressAllowlist` for the "can't limit sites" footer, a `status` field for the key row).
- **Older daemons:** without `sandboxes`, the app shows today's Runs pane and no Details…; without
  `sandboxes.settings`, rows are read-only; without `sandboxes.resources`, the Machines section is hidden with
  "Update capcomd to see machines here." **Newer daemons with older apps:** a new provider shows up in Runs on and
  gets a place section from `run-options`, because both are already keyed by string.

### 7. Migration and phasing

1. **Read-only details (the slice the owner sees first).** Descriptors for docker and boxd; `RUN_SANDBOXES`,
   `SETTINGS_SANDBOXES`, `SANDBOX_LABEL` and the API enums are derived from the registry; `GET /v1/sandboxes`,
   `GET /v1/sandboxes/{name}` and `…/resources` with `terminalCommand`; `capcomd sandbox shell`; Logins `hostBound`.
   The idle lifetime row shows its real current value (1 hour) but can't be changed yet. App:
   Details… → `SandboxDetailsView`, with Open in Terminal working.
2. **Settings.** `PATCH …/settings`, the `configure` scope, `sandboxes.*` in the user config, per-run recording in
   `_sandbox`, and `AGENT_VM_TTL_SECONDS` and the worker `ttlMs` replaced by the run's value.
3. **Actions.** `delete` (owned and orphaned machines) and the audit events. `extend` follows; `stop` waits for
   resume support in the engine.

Deferred: cost, free-text fields (egress host lists), out-of-tree manifests, and per-project provider settings.

**A third provider, end to end.** Suppose a local VM provider, `lima` ("Local VM · Lima"):

| Step | Work | Swift changes |
|---|---|---|
| Engine | `LimaProvider implements SandboxProvider`; passes `tests/providers/conformance.ts` (ADR-020 §3) | – |
| Descriptor | `{name:"lima", kind:"local", label:"Local VM", vendor:"Lima", mark:"lima", caps:{isolation:"vm", snapshots:true, hostBoundSecrets:false, egressAllowlist:false, interactive:true, idleLifetime:"sweep", shell:true, costs:false}, settings:["idleLifetime"], actions:["open_terminal","delete"]}` | – |
| Availability | `available()` hook: is `limactl` on PATH and does it answer, cached like Docker | – |
| Settings | `idleLifetime` comes for free (sweep) | – |
| Resources | `list` by prefix; ownership from the worker actors as for the others | – |
| Shell | `shell(id)` hook: `limactl shell <vm>` | – |
| App | appears in Runs on, gets a place section and a Details… screen; the mark falls back to `desktopcomputer` | optional: a bundled `lima` mark |

A cloud ("Cloud · Acme") with host-bound secrets looks like boxd: the Logins row reports bound logins once `auth login` learns to store into Acme's secrets. That piece of
work is in `login.ts`, not in the surface.

## Consequences

- One declaration per provider drives the engine's capability checks, the API and the app. Adding a provider no
  longer means editing five lists and an enum.
- The 1 hour idle lifetime becomes visible and changeable. Egress stays open by default and out of Settings (the
  canvas's "Sites agents can reach" row is removed).
- A new token scope means existing app tokens see settings read-only until the token is reset.
- `capcomd sandbox shell` gives a human an interactive shell in an agent's sandbox. That is new power. It is
  deliberately local-CLI-only, and the shell opens with a warning.
- Docs: harness-contract (generated), `docs/providers.md` ("Writing a provider" gains the descriptor), settings-spec
  §4 and §7, and CHANGELOG entries per phase.

## Alternatives considered

- **Fold logins and environments into `/v1/sandboxes/{name}`.** That would mean one round trip, but two sources for
  the same fact, and both routes already ship. Rejected; we reference them instead.
- **A generic `PUT /v1/config`.** Rejected: there would be no per-field validation, and env vars and secrets would sit
  next to settings the user can change.
- **Server-driven UI (layout from the daemon).** Rejected: it fights the approved native look, and the closed field
  set already covers what providers need.
- **Taking ownership from provider labels.** Rejected: boxd labels aren't persisted (`boxd.ts:116`), and labels can
  be forged from inside a sandbox.

## Open questions for the owner

1. ~~**Default egress.**~~ **Decided (2026-10-27):** no restriction by default; site access is left to the provider
   and isn't a capcomd setting.
2. ~~**Idle lifetime presets.**~~ **Decided (2026-10-27):** 15 min, 1 h (default), 4 h and 12 h, the same on every
   provider. Docker's value is approximate, within 5 minutes.
3. ~~**A new `configure` scope, or reuse `steer` for settings?**~~ **Decided (2026-10-27):** a new `configure` scope.
4. ~~**What does Open in Terminal open?**~~ **Decided (2026-10-27):** a shell in the machine (`capcomd sandbox shell`);
   the TUI stays on the run drill-down.
5. ~~**Cost per machine.**~~ **Decided (2026-10-27):** no cost stats; show age and delete-by time. The `costs` cap
   and `cost` field are dropped from v1.
6. ~~**Should Delete on a working machine cancel the agent?**~~ **Decided (2026-10-27):** yes, as a cancel of that
   agent, with a confirmation that names it and says its work since the last checkpoint is lost.
