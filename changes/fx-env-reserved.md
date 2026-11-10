# CHANGELOG

- Fixed: plugins can no longer set or read fx's variables, as was already true for Claude Code's and Codex's. A
  plugin's `agent.preparing` patch that adds `FX_HOME`, `AI_GATEWAY_*`, `VERCEL_*` or any other `FX_*` variable to an
  agent is refused, so no plugin can change which login or settings an fx agent uses. A plugin secret that references
  `env:AI_GATEWAY_API_KEY` (or another `AI_GATEWAY_*`, `VERCEL_*` or `FX_*` variable) now fails the plugin with
  `config_invalid`. Give the plugin a variable of its own instead. Checks run on your computer (fake sandboxes,
  `CAPCOMD_CHECKS=host`) no longer get these variables either.

# Spec

fx's variable families are the kernel's (§6.6.7, §10.3): `reservedEnvName` reserves `AI_GATEWAY_*`, `VERCEL_*` and `FX_*` beside `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*` and `CODEX_*`, so an `agent.preparing` `env` that names one (fx's `FX_HOME` is its login's and settings' folder) is `widening` and an attempt's spec drops it; `kernelVariable` gains the prefixes `AI_GATEWAY_`, `VERCEL_` and `FX_`, so a plugin's secret reference to one is `config_invalid` (and `forbidden` when resolved), except for a shipped built-in's. No hook, seam or contract shape changes.
