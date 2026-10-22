---
name: capcomd-setup
description: Get capcomd ready for the user, in this repository: install the CLI, connect the sandbox provider (boxd), log in the coding agents, set the project's checks and target, start the engine. Use when the capcomd tools are missing or capcomd_setup reports something not ready, or when the user asks to set up capcomd.
---
# Setting up capcomd

capcomd runs swarms of coding agents in VMs; you (the user's agent) drive it through the `capcomd_*` MCP tools
(see the capcomd-orchestration skill). Setup has steps only the user can do (browser logins); everything else you
can run. Always start with what's already there: call `capcomd_setup` and fix only what it reports.

## 1. Read the state

Call `capcomd_setup`. Two shapes:

- **`problem` + `install`** (only the setup tool exists): capcomd or Bun isn't installed, or is older than this
  plugin. Go to step 2.
- **`ready`, `steps[]`, `gates`, `driver`**: capcomd is installed. Each step that isn't `ok` has a `hint`; go to the
  matching step below. When `ready` is true, you're done: use capcomd-orchestration.

Without the MCP tools (no plugin), run `capcomd setup check --json` in a shell instead; same steps and hints.

## 2. Install (you can run these, with the user's go-ahead)

```bash
curl -fsSL https://bun.sh/install | bash   # only if Bun is missing
bun add -g capcomd                          # or the version capcomd_setup names: capcomd@X.Y.Z
```

A first install downloads a few hundred MB of dependencies and can take several minutes. After installing, the
plugin's tools load in a new session: ask the user to restart it (or reload plugins), then call `capcomd_setup`.

## 3. The sandbox provider (boxd today)

capcomd's VMs come from a provider; boxd is the first. `capcomd setup accounts --yes` makes a boxd API key just
for capcomd with the user's logged-in boxd CLI and keeps it in the OS keychain (the key is never printed).

- boxd CLI not installed: `curl -fsSL https://boxd.sh/downloads/install.sh | sh`.
- Not logged in: **the user** runs `boxd auth login` (it opens a browser). Ask them to; don't try it yourself.
- Several boxd orgs and none active: ask which one, then pass `--org <name>`.

Then run `capcomd setup accounts --yes --agents claude` (or `codex`, or `claude,codex`). It also builds the agent
VM snapshot (a few minutes the first time) and checks each agent works from a VM.

## 4. Agent logins

Agents log in with the user's plan (Claude or ChatGPT) or an API key:

- **Plan**: **the user** runs `capcomd auth login claude` (or `codex`) in a terminal; it shows a browser link or a
  code. You can't complete it for them.
- **API key**: if `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is set in the environment, `capcomd setup accounts --yes
  --auth apikey` stores it as a boxd host-bound secret (agents never see the key itself).

## 5. The project's gates (the user decides these)

The checks, the reviewer and the target branch are the user's gates: agents (you included) can't change them
later. Propose, then let the user confirm:

```bash
capcomd setup project --yes --target main --mode pr --check "bun test"
```

`--mode pr` opens a pull request per merge; `direct` pushes to the target. Setup detects the repository and a
default check from `package.json`, and creates `worker`, `reviewer` and `planner` agent profiles, with no turn, time
or money limits. When an agent bills an API key, setup asks once for a spend cap per run (`--budget USD`, empty for
none) and saves it as `driver.maxRunBudget`. Settings land in
`.capcomd/config.json` (commit it, so the team shares the gates) and `~/.capcomd/config.json`.

Optional, in `.capcomd/config.json`: `"driver": {"maxRunBudget": "usd=20,turns=400"}` caps each run you start;
`"driver": {"approvals": "client-confirmed"}` lets you approve protected merges after the user confirms each
call (by default only the user approves, with `capcomd approve`).

## 6. The engine

The MCP server starts the engine when it isn't running. To keep it running across reboots:
`capcomd setup service --yes` (launchd on macOS, systemd on Linux).

## 7. Done

Call `capcomd_setup` again: `ready: true`. Tell the user what's set (provider, agents, gates) and try a small run
first (one worker, one check) before a big swarm.
