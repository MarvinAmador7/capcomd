# CHANGELOG

- Your plugins now judge what you do from the CLI and from `capcomd mcp`, not only what agents do. `capcomd verify`,
  `capcomd merge`, `capcomd approve <runId> <mrg-…>` and the `capcomd_verify`, `capcomd_merge` and `capcomd_approve`
  tools run in the daemon when one is running for that engine, so a plugin you installed (in `~/.capcomd/plugins`, or a
  project's you trusted) is asked at `verify.judging`, `merge.landing` and `approval.deciding` as it is for an agent's
  work. Nothing changes in how you call them or in what they print.
- With no daemon running, `capcomd verify`, `merge` and `approve <runId> <mrg-…>` (and their `capcomd mcp` tools)
  still run in the command itself, but a plugin of yours that judges them can't be asked there, so the command is now
  refused with a config error (reason `plugins_unconsulted`) naming the plugin: start the daemon (`capcomd serve`) and
  run it again, or turn the plugin off (`plugins.<name>.enabled: false`). A plugin that only watches is named on stderr
  instead (`capcomd mcp`: `pluginsNotConsulted` in the answer).
- `capcomd run new`, `capcomd spawn` and `capcomd run <goal>` (and `capcomd_run_new`, `capcomd_spawn`) still run where
  you type them: a plugin that declares `failure: closed` on `run.creating`, `profile.resolved` or `agent.spawning`
  now refuses them (reason `plugins_unconsulted`), and any other plugin listening there is named as not asked.
- For apps and scripts: capability `ops.front_door` lists the daemon's routes for this
  (`POST /v1/runs/{runId}/verifications`, `/merges`, `/merges/{mergeId}/decision`); they take only the CLI's and
  `capcomd mcp`'s own one-call tokens.

# Spec

A front door's gated operations go through the daemon (§6.1, §9.2; the owner's decision of 2026-11-08, ADR-023 §9 decision 8, replacing the C8/C9 deviation that a CLI or `capcomd mcp` operation ran its gates where it was served): `capcomd verify`, `merge`, `approve <runId> <mrg-…>` and `capcomd_verify`, `capcomd_merge`, `capcomd_approve` run in the daemon that hosts their engine, so an out-of-process plugin's `verify.*`, `merge.*` and `approval.*` gates judge them. Capability `ops.front_door`: `POST /v1/runs/{runId}/verifications`, `/merges` and `/merges/{mergeId}/decision`, only for a front door's one-call token (`frontDoor`), a bounded wait (202 with the id), the operation's own refusal as `ApiError.relay`, a merge's `protectedBranches` (the front door's own patterns, which only add protection) and a decision's `key` (a poll after it ended gets its record, never a second decision) (additive). The daemon's listing (`state/plugins.json`) names the engine it hosts (`endpoint`, additive). With no daemon for its engine a front door runs them itself, refusing one a gate (or a `failure: closed` listener) only the daemon runs must judge (`plugins_unconsulted`) and naming the other listeners it skipped; `run new`, `spawn` and `run <goal>` (not sent through the daemon in this version) apply the same rule with or without a daemon.
