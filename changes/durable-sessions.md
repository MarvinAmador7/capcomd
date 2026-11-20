# CHANGELOG

- An agent's Claude Code or Codex conversation now outlives its machine. capcomd picks the session id when the agent
  starts (Codex no longer runs `--ephemeral`), copies the CLI's session file out of the machine as it grows (secrets
  redacted, compressed, readable only by you) into `~/.capcomd/state/sessions/<run>/<agent>/`, and keeps it as long as
  the run. A woken agent on a fresh machine continues the same conversation instead of starting over (the waking
  itself comes with idle agents, ADR-026 phase 2).
- Optional iCloud Drive copy: set `"sessions": {"replica": "icloud-drive"}` in `~/.capcomd/config.json` (or
  `CAPCOMD_SESSIONS_REPLICA=icloud-drive`) and every saved session is also written to
  `iCloud Drive/capcomd/sessions/`, encrypted on your Mac first (AES-256-GCM). The key is
  `~/.capcomd/state/session-replica.key`: copy it to another Mac to read the copy there. Off by default; your Mac's own
  copy always comes first.

# Spec

Durable CLI sessions (ADR-026 §2): the agent seam's optional `session` (`firstRunArgs`, `resumeArgs`, `detectMissing`, `locate`, `place`), `AgentCommandCtx.session` `{id, resume}` and `AgentRunState.sessionId`, all additive; the session store seam `SessionStore` (`put`, `get`, `list`, `delete`) with the built-in `host` store and the `icloud-drive` replica (`sessions.replica`); Codex runs without `--ephemeral`.
