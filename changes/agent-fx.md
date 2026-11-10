# CHANGELOG

- New: agents can run on [fx](https://fx.sh), Vercel Labs' coding agent, as a third provider beside Claude Code and
  Codex: a profile with `provider: fx`, `auth: apikey` and `AI_GATEWAY_API_KEY` set (`capcomd profiles add gw
  --provider fx --auth apikey --model anthropic/claude-sonnet-5`). capcomd installs fx's pinned release (0.0.16),
  checked against its sha256, in the agent's environment (`capcomd env build` bakes it in), and runs it with capcomd's
  tools, messages (`capcomd send` reaches it while it works), turn and budget limits, usage-limit pauses and
  orchestrate mode for a planner or lead. fx's own plan logins aren't supported yet; see docs/agents.md → fx.
- `capcomd doctor` checks fx only when `AI_GATEWAY_API_KEY` is set, so `doctor --strict` and `capcomd setup` don't
  fail for a provider you don't use.
- `CAPCOMD_<PROVIDER>_USD_PER_MTOK_IN` and `_OUT` set a provider's token prices for its budget estimate
  (`CAPCOMD_FX_USD_PER_MTOK_IN`/`_OUT` for fx; codex keeps `CAPCOMD_CODEX_USD_PER_MTOK_IN`/`_OUT`).

# Spec

The fx agent provider (§7.3, §16.1): a third built-in agent seam, `agent-fx` (fx 0.0.16), which runs `fx acp` behind a bridge (`src/plugins/fx-bridge.mjs`) that prints its ACP session as JSON lines; messages sent while it works become steering prompts or the next turn; an AI Gateway key only. `describe()` gains `install` (additive; release archives per architecture with their sha256, installed as `<agent home>/bin/<bin>` and checked before they are unpacked; `npmPackage` becomes optional, exactly one of the two) and `subscription` (additive; false refuses `auth: subscription` at validation). `AgentConfig.usdPerMtok` is a provider's own rates when set (`CAPCOMD_<PROVIDER>_USD_PER_MTOK_IN`, `_OUT`), else codex's as before. §16.1: fx's orchestrate lists are `denyCommands`, written as fx permission rules with fx in ask mode and every ask refused; an orchestrate agent's fx settings keep only `providers` and `models` from a file already there, so a `workspaces` entry can't outrank the rules. harness.v1: `Agent.provider` and `agent.spawned` `agent.provider` gain `fx` and `agent.kind` gains `fx` (additive); `driver`, `DriverOption.provider` and `Login.provider` stay `claude` or `codex`. `capcomd env build`'s VM reaches the archive hosts of the active providers; `capcomd doctor` checks a provider other than Claude Code and Codex only when its key is set or it is logged in.
