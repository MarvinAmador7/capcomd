# ADR-018: capcomd as a plugin for your agent (MCP + skills, Claude and OpenAI)

Status: accepted (2026-10-22); phase 1 built (`capcomd mcp`), phase 2 built except the live run. Builds on ADR-016 (primitives) and ADR-017 (sub-agents in VMs).

## Context

capcomd is meant to be driven by the user's own agent, not typed by hand: the user installs capcomd into their
agent and asks for an outcome ("fix the failing tests, one worker per file, each verified and reviewed"); their
agent becomes the orchestrator and runs a swarm through capcomd's primitives.

What exists today:

- **Skill + CLI.** `skills/capcomd-orchestration/SKILL.md` teaches the primitives and patterns; an agent with a
  shell runs `capcomd … --json`. This is how the live end-to-end test runs. `capcomd setup` copies the skill into
  `~/.claude/skills` (Claude Code only).
- **Host MCP server** (`capcomd mcp`, `src/mcp/server.ts`): six tools (`capcomd_run`, `_status`, `_cancel`,
  `_events`, `_trace`, `_approve`). `capcomd_run` starts the `capcomd run` recipe, whose planner and judge are still
  a fake model (ROADMAP §2). An agent without a shell can't spawn, await, verify or merge.
- **In-VM MCP** (`src/subagents/vm-cli.mjs`): the full primitive set for agents inside VMs (`capcomd_spawn`,
  `_await`, `_wait_any`, `_verify`, `_merge`, `_task`, `_kv`, …), scoped by a capability token. Good shape to reuse.

Agent platforms now install **plugins** that bundle MCP servers and skills in one step:

| Surface | Plugin format | Local (stdio) MCP server | Skills | Distribution |
|---|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json`, `.mcp.json`, `skills/` | Yes (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`) | Yes | A git repo with `.claude-plugin/marketplace.json`; `claude plugin marketplace add owner/repo`; Anthropic's directory |
| Claude Desktop, claude.ai, Cowork | Same plugin format (org sync, claude.ai marketplaces) | Desktop: yes (also `.mcpb` bundles); web: remote only (to verify) | Yes | Same; plugins with a top-level `bin/` aren't installed there |
| Codex CLI and desktop | OpenAI plugin: `plugin.json` (portable schema) or `.codex-plugin/plugin.json`, `.mcp.json`, `skills/` | Yes (command servers, `tool_timeout_sec`) | Yes | `.agents/plugins/marketplace.json` (or the legacy `.claude-plugin/marketplace.json`); `codex plugin marketplace add owner/repo` |
| ChatGPT web, desktop, mobile | Same OpenAI plugin | **No: remote HTTPS only** | Yes | OpenAI's plugin directory (remote HTTPS endpoint, no lifecycle hooks) |

`userConfig` in a Claude plugin prompts for values on enable and keeps `sensitive` ones in the OS credential
store, substituting them into the MCP server's `env` as `${user_config.KEY}`. OpenAI plugins take credentials
through a connection setup flow (OAuth or API key) and keep them out of the manifest.

## Decision

### 1. One plugin, two manifests, the repository as the marketplace

```
plugins/capcomd/
  .claude-plugin/plugin.json      # Claude Code / Desktop: metadata and the MCP server (inline)
  .codex-plugin/plugin.json       # Codex (interface: displayName, defaultPrompt, …); skills and .codex-mcp.json
  .codex-mcp.json                 # the MCP server in Codex's format (cwd = the plugin root)
  mcp/launch.sh, mcp/launch.mjs   # the launcher (§2), dependency-free
  skills/capcomd-orchestration/SKILL.md   # the primitives and patterns
  skills/capcomd-setup/SKILL.md           # onboarding: install, provider, logins, gates, engine
.claude-plugin/marketplace.json   # repo root: lists plugins/capcomd (Codex reads it as the legacy path)
.agents/plugins/marketplace.json  # repo root: OpenAI's path
```

The Codex server config isn't named `.mcp.json` because Claude Code also loads a plugin's `.mcp.json`, and the two
formats differ (Claude: `${CLAUDE_PLUGIN_ROOT}` in `args`; Codex: paths relative to `cwd`, `env_vars`).

Install: `/plugin install capcomd --marketplace MarvinAmador7/capcomd` in Claude Code (adds the marketplace and
installs in one step); `codex plugin marketplace add MarvinAmador7/capcomd`, then `/plugins`, in Codex.
`capcomd setup`'s agent step does this for each agent CLI it finds, and removes the skill copy older setups put in
`~/.claude/skills`. With neither CLI, it installs the orchestration skill for Claude Code and prints the line that
registers the MCP server.

The skills stay plain `SKILL.md` files so agents without plugins (any agent with a shell) can be pointed at them.

Versions: the plugin's `version` is the package version; `scripts/release-notes.ts --check` also checks both
manifests agree with `package.json`, and CI runs `claude plugin validate --strict plugins/capcomd`.

### 2. The MCP server: launched from the plugin, backed by the installed CLI, engine kept alive

The server is a small launcher shipped in the plugin (`sh mcp/launch.sh`, which runs `mcp/launch.mjs` with Bun, or
Node). Agent apps often start servers with a short `PATH`, so it also looks in `~/.bun/bin`, `/opt/homebrew/bin`
and `/usr/local/bin`. It finds an installed `capcomd` at least as new as the plugin (same major.minor or newer) and
runs `capcomd mcp` in the user's project (Claude Code passes `CAPCOMD_PROJECT_DIR=${CLAUDE_PROJECT_DIR}`; under
Codex it's the session's `PWD`). Otherwise it serves a dependency-free MCP server with one tool, `capcomd_setup`,
that says what's missing and the exact install commands, so the agent can fix it (the setup skill says how). We don't run `bunx capcomd`
from the plugin: a cold install takes minutes, longer than any client's server startup timeout.

`capcomd mcp` starts the engine when none answers on the endpoint (`capcomd serve` detached, state in
`~/.capcomd`, or the installed service), and never stops it on exit: runs outlive the agent session that started
them (durability), and any later session can pick them up.

### 3. Tools: the operator's primitives, for a "driver" agent

The host server exposes the primitives with the same names and shapes as the in-VM tools where they overlap
(`src/subagents/vm-cli.mjs`), so one skill teaches both. All return the `relay.v1` JSON contract; every write takes
`key` for idempotency; errors carry `reason` and `hint` (what to do next).

| Group | Tools | Notes |
|---|---|---|
| Discover | `capcomd_setup` (setup check: engine, provider, logins, project gates, profiles), `capcomd_profiles` | Read-only |
| Runs | `capcomd_run_new`, `capcomd_runs`, `capcomd_tree`, `capcomd_inspect`, `capcomd_events`, `capcomd_trace` | `run_new` takes gates from the project (§4) |
| Agents | `capcomd_spawn`, `capcomd_await` (`mode: all\|any`), `capcomd_send`, `capcomd_cancel` | `cancel` propagates |
| Gates | `capcomd_verify`, `capcomd_merge`, `capcomd_approve` | `merge` needs `require: vfy-…`; approve: §4 |
| Shared state | `capcomd_task` (`action: add\|list\|claim\|renew\|release\|done`), `capcomd_kv` (`get\|put\|cas\|del\|list`), `capcomd_budget` | Same as in-VM |

Eighteen tools, kept small by grouping board and kv operations behind `action` as the in-VM server does. Each tool
declares MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), so clients prompt before
`merge`, `cancel` and `approve` and can auto-allow reads.

**Waiting never blocks past the client.** `capcomd_await` and `capcomd_verify` take `timeoutMs` (default 25s,
max 55s, under Codex's default 60s tool timeout) and return `{ done: [...], pending: [...], next }` when time runs
out, with progress notifications while waiting where the client supports them; the agent calls again. Nothing is
lost between calls: the run is durable and the agents keep working.

The old `capcomd_run` (the recipe with the fake planner) is removed from the tool list until the recipe plans
with a real agent (ROADMAP §2); the driver agent is the planner.

### 4. Trust: the driver is the user's delegate; gates stay the human's

A new principal, **driver**, sits between the operator (the human) and agents in VMs:

- **Can:** create runs, spawn, await, send, cancel, use the board and kv, verify, and merge into non-protected
  targets, within the run's budget.
- **Can't:** set or change the gates. `capcomd_run_new` takes the checks, reviewer, target and protected branches
  from the project's `.capcomd/config.json` (written by the human through `capcomd setup`); a driver may only pick
  a staging target or a smaller budget, and per-run caps (`maxRunBudget`) come from config. No `--operator`
  widening.
- **Approvals for protected branches stay human by default** (`approvals: "human"`): `capcomd_approve` answers
  with how to approve (`capcomd approve …` in a terminal, the TUI, or, later, a link). A project can set
  `approvals: "elicit"` to let the tool ask the person itself (MCP elicitation, capcomd's own prompt; only an accept
  approves; docs/integration-agents.md), or the older `approvals: "client-confirmed"` to let the tool approve after
  the client's own per-call confirmation.

Enforcement lives in the primitives (`ops.ts`, `policy.ts`) keyed on the caller (`operator | driver | agent`), not
in the MCP layer. On a machine where the driver agent also has a shell, these are guardrails against mistakes,
not a boundary (it can run `capcomd` as the operator); the remote mode (§5) is where the driver has only the MCP
and they become a boundary.

### 5. Remote mode, for ChatGPT and claude.ai: not now

capcomd is for developers, whose agents (Claude Code, Codex) run the local plugin, so ChatGPT and other
remote-only clients are out of scope. If remote access is ever needed, it will be (b) below, mainly because it
also keeps runs progressing with the laptop closed; (a) only as a way to test the HTTP server.

ChatGPT connects only to remote HTTPS MCP servers. `capcomd mcp --http` serves Streamable HTTP with OAuth, and
the engine runs somewhere reachable:

- **(a) Your machine, through a tunnel** (OpenAI's Secure MCP Tunnel, Cloudflare Tunnel): no hosting, but the
  laptop must stay awake for the endpoint, and for the run: each agent's driver (`agent-drive`) is a process on
  the engine's host, so while it sleeps the agents' VMs keep running but nothing relays their requests, pushes
  their branches or records their results; the run resumes when it wakes (durability), it doesn't progress.
- **(b) A hosted engine in a provider VM** (boxd gives `https://<name>.boxd.sh` and persistent disk): always on,
  the same durable state, VM backups; it needs the user's provider key and agent logins to live there, so it is
  its own design (credentials, OAuth, multi-user) before it ships.

The OpenAI plugin declares the remote server (`"type": "streamable-http"`, `url`, `auth` with OAuth DCR); the
same plugin works in Codex locally (§2) and in ChatGPT remotely. Public directory listings (Anthropic's, OpenAI's)
need the remote endpoint, a privacy policy and terms; they come after (b).

### 6. Phases and what "done" means

1. **MCP tools** (§3, §4) behind `capcomd mcp`, with the engine auto-start. Done when an MCP client with no shell
   tool runs the README's fan-out example end to end on the fake provider in CI, and on boxd in the live e2e.
2. **Plugins for Claude Code and Codex** (§1, §2), installed by `capcomd setup` or from the marketplace. Done when
   a clean machine goes from `claude plugin install` (and `codex plugin …`) through the setup skill to a merged,
   verified change, without the user typing a capcomd command.
3. **Anthropic's plugin directory** (Claude Code local plugins), once 1 and 2 are stable. Remote mode and
   ChatGPT are not planned (§5).

## Testing

- **Tool contract tests:** an in-memory MCP client against `buildServer()` on the fake provider: every tool's
  schema, annotations, `relay.v1` output, idempotent retries with `key`, bounded waits returning `pending`.
- **Driver policy tests** (`tests/primitives/`): a driver can't set checks, widen limits or approve by default;
  project config gates apply to `run_new`.
- **Scenario:** an MCP-only fan-out (scripted driver: run_new → 3 spawns → await any → verify → merge each), with
  a chaos killpoint between `verify` and `merge` (the driver reconnects and finishes; merges happen once).
- **Plugin packaging:** `claude plugin validate --strict` in CI; the release smoke installs the plugin from the
  packed tree and lists the MCP tools through it.
- **Live:** a variant of `scripts/mac-subagents-e2e.sh` where the planner is a Claude Code session using only the
  plugin's MCP tools.

## Consequences and open questions

- The skill becomes the main product surface alongside the tools: it has to teach patterns, budgets and when to
  stop, and it's versioned with the tools.
- `capcomd setup` changes from "copy a skill" to "install the plugin"; agents that aren't plugin hosts keep the
  skill-plus-CLI path.
- Cold `bun add -g capcomd` takes minutes; worth trimming (ROADMAP) since onboarding now starts in a chat.

Decided (2026-10-22): approvals over MCP are human-only by default (§4); the launcher requires the installed CLI
(§2); the plugin is `capcomd` and tools keep the `capcomd_` prefix; no remote mode or ChatGPT for now (§5).

Open: whether claude.ai and Cowork run a plugin's local stdio server (if not, they're out of scope with ChatGPT).
