# ADR-015: Agent envs (snapshots), host-bound secrets, generic agent adapter

Status: accepted (sections 1–4), design only (section 5). Date: 2026-10-19. Builds on ADR-014.

## 1. Generic agent adapter

`CAPCOMD_AGENT=claude-code|codex` (default `fake`). `src/agents/types.ts` defines `AgentAdapter`:
binary + npm package + pin, `secretName` / `apiHost`, `credentialEnv`, `command` (headless),
`parse` (JSON event line → event + run state: turns, tokens, cost, result), `guard`, `outcome`.
`src/agents/runner.ts` does everything shared: clone, idempotent reuse of an already-pushed epoch,
dep reuse from the env template, detect-or-install the CLI, credential resolution, background
start under `setsid` + `timeout`, tail/parse/trace, guard/cancel/timeout → kill the process group,
commit with `Capcomd-Task/Epoch/Agent` trailers, `--force-with-lease` push. `runClaudeCode` is a wrapper.

**Codex** runs `codex exec --json --color never --ephemeral --sandbox <mode> -C <repo> [-m model]
-o <W>/last-message.txt "<prompt>"`, auth via `CODEX_API_KEY` set on that one process.
Sources (checked 2026-10-19): https://developers.openai.com/codex/noninteractive (JSONL events
`thread.started`, `turn.started`, `turn.completed{usage}`, `turn.failed`, `item.*`, `error`;
`CODEX_API_KEY` for automation) and the `codex exec` flag table at
https://learn.chatgpt.com/docs/developer-commands (`--json`, `--sandbox`, `-C`, `--color`,
`-o/--output-last-message`, `--ephemeral`; `--full-auto` is no longer supported). Pin `@openai/codex@0.163.0`.
Codex has no turn/budget flags, so capcomd enforces them: turns = completed tool items
(`command_execution`, `file_change`, `mcp_tool_call`, `web_search`) vs `CAPCOMD_AGENT_MAX_TURNS`;
cost = tokens × `CAPCOMD_CODEX_USD_PER_MTOK_IN/OUT` (default 1.25 / 10) vs `CAPCOMD_AGENT_MAX_BUDGET_USD`;
plus the wall-clock timeout. Default sandbox `workspace-write` (`CAPCOMD_CODEX_SANDBOX`); if Linux
sandboxing is unavailable inside the boxd VM, `danger-full-access` is acceptable because the VM
(egress allowlist, no secrets on disk) is the isolation boundary.

Egress per agent: `github.com`, the agent's API host (`api.anthropic.com` | `api.openai.com`),
`registry.npmjs.org`, `nodejs.org`.

## 2. Env snapshots: `capcomd env build|status|rm`

Build boots a VM from the default image and, in `/var/tmp/capcomd` (on disk, so it survives a snapshot):
1. clones `CAPCOMD_REPO` (optional) into `template/` and hashes its lockfile;
2. names the snapshot `capcomd-env-<sha256(schema, pins{claude,codex,node}, lockHash)[:16]>`; an
   existing `ready` snapshot of that name ends the build (`--force` rebuilds);
3. **detects** `claude`, `codex`, `node`; anything present is kept and its version recorded
   (`source: image`), only missing tools are installed at the pin (`source: installed`);
4. sets git identity/defaults; installs repo deps (`npm ci`/`bun install --frozen-lockfile`/…)
   and writes `template/.capcomd-lockhash`;
5. **scrub check**: refuses to snapshot if env, git config or written files contain key-shaped
   strings (`sk-ant-`, `sk-proj-`, `gh?_`, `github_pat_`, `bxd_`) or any local API key value
   (matched in-VM via a probe env var, never printed);
6. `snapshots.create(vm, name)`, polls `snapshots.get` until `ready`, destroys the VM, records the
   build in `.relay/envs.json` (versions, manifest, build time).

Workers with a real agent call `machines.create({fromSnapshot})` when a snapshot resolves
(`CAPCOMD_ENV_SNAPSHOT`, else the ledger's current build) and fall back to the image otherwise or
with `CAPCOMD_ENV=image`. A restored VM starts with unrestricted egress; `ensure` always applies
the allowlist right after create (existing behaviour). When the task repo's lockfile hash matches
the template, the runner copies `template/node_modules` and excludes it from commits.
The repo is not part of the hash: any repo with the same lockfile shares the snapshot.

## 3. Host-bound secrets: `capcomd secrets sync`

`secrets.set("ANTHROPIC_API_KEY", v, {scope: "private", domains: ["api.anthropic.com"]})` and
`OPENAI_API_KEY` → `api.openai.com`, read from local env, never printed; verified with
`secrets.list()` (names/domains only). boxd puts a `bxds_…` placeholder in the VM env and substitutes
the real value only on requests to the bound host. The runner reads `printenv <NAME>` in the VM:
a `bxds_` value is passed to the agent as its credential (`credential_mode=secret`); otherwise it
falls back to injecting the local key into the agent's start exec only (`env`), unless
`CAPCOMD_CREDENTIALS=secret` (fail) or `=env` (skip detection). Preflight accepts a missing local
key in `secret` mode. Open point verified live by `capcomd doctor`: that exec env inherits the
machine's secret placeholders; if not, the runner falls back to env mode and doctor shows `absent`.

## 4. `capcomd doctor`

Boots a VM like a worker (snapshot or image, both API hosts allowed) and per agent reports CLI
path/version, whether the key in the VM is a `placeholder`, `plain` or `absent`, and `GET /v1/models`
from inside the VM through the substitution (HTTP status only). Destroys the VM.

## 5. Subscription auth profiles (built): `capcomd auth login|status|logout`

Workers can run Claude Code / Codex on Marvin's plan login with **no inference API key**.

- **Login.** `capcomd auth login claude|codex` boots a VM from the env snapshot (building it if
  missing) with egress = base + vendor login hosts and runs the CLI's own login over a boxd PTY
  (`machines.streamExec`, tty, 500 cols): `claude setup-token` (one-year OAuth token, Pro/Max/Team/
  Enterprise; docs: https://code.claude.com/docs/en/authentication) and `codex login --device-auth`
  with `cli_auth_credentials_store = "file"` (docs: https://developers.openai.com/codex/auth/ci-cd-auth/,
  https://learn.chatgpt.com/docs/auth; device-code login must be enabled in ChatGPT settings). The URL/code
  stream to the user's terminal; local stdin is relayed raw. A `TokenFilter` masks token-shaped
  output (`sk-ant-oat…`, JWTs) as `[token captured — hidden]`, holding partial lines so a token can
  never be printed split.
- **Store.** Claude: the captured token goes to a boxd private secret `CLAUDE_CODE_OAUTH_TOKEN` bound to
  `api.anthropic.com` when the boxd key allows `secrets.*`; org-scoped keys can't (member credential
  needed), so it falls back to `~/.capcomd-auth/claude.env` (0600) inside the auth snapshot.
  Codex: `$CODEX_HOME/auth.json` stays in the snapshot (shape-checked with booleans only).
  Then verify (`claude -p 'Reply with exactly the word ok' --max-turns 1`; `codex exec --json …`
  → `turn.completed`), delete shell histories only, snapshot as private
  `capcomd-auth-<agent>-<envhash>`, record it in `.relay/auths.json` (0600, no secrets), destroy the VM.
- **Run.** Subscription agents boot from that snapshot; the run script unsets
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` (they outrank the OAuth token) or `OPENAI_API_KEY`/
  `CODEX_API_KEY`, and no credential env is injected. Never `--bare` (it ignores the token). Cost is
  reported as `billing=subscription`, `costUsd=0`, with turns/time (`notionalCostUsd` when the CLI gives one);
  the USD budget guard is skipped for codex in this mode.
- **status/logout.** `auth status [agent] [--quick]` checks the snapshot and (non-quick) boots it and
  re-runs verify. `auth logout <agent>` deletes the snapshot and the secret.
- **Refresh risk (codex).** Codex refreshes after ~8 days and writes new tokens to auth.json; VMs
  booted from one snapshot share one refresh token, so a refresh in one VM can invalidate the
  others. Mitigations: run one codex subscription worker at a time; when `auth status` fails,
  log in again. Claude's setup-token doesn't refresh (it expires after a year). A compromised
  agent could still exfiltrate the token to an allowed host; that is why the egress is narrow.
- **secrets sync** is optional and never fatal: `unavailable` (with the member-credential reason)
  is reported and the CLI exits 0.

## 6. Agent profiles and strict per-agent auth

`.capcomd/agents.json` (`CAPCOMD_AGENTS_FILE`, schema `capcomd.agents/v1`, export with
`capcomd agents schema`) holds named profiles: `provider` (claude|codex), `auth` (apikey|subscription,
**exactly one**), `model`, `maxTurns`, `budgetUsd`, `timeoutMs`, `sandbox`, `egress`, `systemPrompt`,
`appendSystemPrompt`, `allowedTools`, `disallowedTools`, `description`, `children`. Unknown fields are
rejected. CLI: `capcomd agents list|show|add|set|rm|schema|validate`, all with `--json` (Hermes can
also pass `--spec '<json>'`). Selection order: `run --profile/--agent` (goal directive
`[agent:REF]`, carried planner → task → worker) → `CAPCOMD_AGENT` (kind or profile name; override)
→ file `default` → fake. Credentials are strict: auth comes from `CAPCOMD_CREDENTIALS` override,
then the profile, then `CAPCOMD_AUTH`. When none of those set it, it is inferred, and having both a
local key and a login, or neither, is a config error. There is no silent fallback. Preflight and
doctor check only that profile's one credential.

## 7. Children policy, overrides, effective-spec log

`children`: `allowSpawn` (default false), `maxDepth`, `maxChildren` (concurrent),
`maxTotalDescendants`, `allowedChildProfiles`, `budgetShare` ∈ (0,1]. Rules: `allowSpawn` requires
allowed profiles, `maxChildren ≤ maxTotalDescendants`, and child profiles must exist and be no wider than the
parent (`widenings()`: tools ⊆, egress ⊆, limits ≤, sandbox no looser, no spawning beyond). Child budget is
`budgetShare × parent remaining`, never more. Runtime spawning was built later; see ADR-017.
Overrides per run: `capcomd run --profile X --set children.maxDepth=2` (repeatable) or
`--overrides '<json>'`. They may only narrow the profile; a widening is a config error (exit 2)
unless `--operator`. The ref is encoded as `name;ov=<base64url json>[;op=1]`. The effective,
credential-free resolved spec is logged as the `agent.resolved` CLI event, in the run's
`PLAN_READY` event (`agents{taskId: spec}`), and on the worker's PROVISIONING/PUSHED events.

Framing (ADR-016): profiles, auth and `children` limits are primitives that any composition can use. They are not tied to the planner hierarchy; `children` caps whatever spawns an agent (a planner, a supervisor or Hermes).
