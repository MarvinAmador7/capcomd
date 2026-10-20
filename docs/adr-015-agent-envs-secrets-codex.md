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

## 5. Opt-in subscription auth profiles (design only, not built)

Goal: let a user run workers on a Claude Pro/Max or ChatGPT plan login instead of API keys.
Strictly opt-in (`CAPCOMD_AUTH_PROFILE=<name>`); API keys stay the default.

- **Login VM.** `capcomd auth login <profile> --agent claude-code|codex` boots a dedicated VM from
  the env snapshot with egress limited to the vendor's auth + API hosts, runs the CLI's own login
  (`claude /login`, `codex login --device-auth`) and relays the device-code URL to the user's
  terminal. The user completes it in their own browser; capcomd never sees the password.
- **Capture.** After login, read the credential file only (`~/.claude/.credentials.json`,
  `~/.codex/auth.json`), store it encrypted at rest (local keychain or a boxd private secret
  holding the blob), record profile metadata (agent, account email hash, created, expiry), and
  destroy the login VM. Never put it in a snapshot; env build's scrub check would reject it.
- **Per-worker inject.** Upload the blob to the worker VM's agent HOME with 0600 right before
  start, delete it in the same exec chain after the agent exits (and on cancel/timeout kill);
  the VM `deleteAfter` TTL is the backstop. It never appears in env, argv, trace or logs; the
  Redactor learns the token values.
- **Concurrency cap.** Subscriptions are per-person and rate-limited: a profile carries
  `maxConcurrent` (default 1, hard max small); the run actor holds a profile semaphore so excess
  tasks queue rather than fan out, and a 429/usage-limit result marks the profile cooling-down
  until its reset time instead of retrying hot.
- **Refresh-token risk.** The file holds a long-lived refresh token, so each worker VM holds a
  credential that can mint access tokens beyond the task's life. Mitigations: one profile = one
  worker at a time; egress allowlist limits where it can be sent; agents can't read it via the
  disallowed tools (best effort, not a guarantee); delete after the run; detect refresh (file
  changed) and write back the newest blob serialized under the semaphore so parallel refreshes
  don't invalidate each other; `capcomd auth revoke` = delete blob + instruct the vendor-side
  logout. Residual risk: a compromised agent run could exfiltrate the refresh token to an allowed
  host; that is why it stays opt-in and why vendor terms for automated use must be checked
  before enabling it for anything beyond personal use.
