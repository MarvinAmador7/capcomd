# Agent profiles

Named harness agents (a capcomd primitive, see ADR-016) in `.capcomd/agents.json` (override with `CAPCOMD_AGENTS_FILE`). Schema: `capcomd agents schema` (JSON Schema, id `capcomd.agents/v1`). Design: ADR-015 §5–7.

```bash
capcomd agents add rev --provider claude --auth subscription --max-turns 20 --append-system-prompt "Be terse." --default
capcomd agents add cx  --provider codex  --auth apikey --sandbox workspace-write --egress github.com
capcomd agents set rev --model claude-sonnet-4-5 ; capcomd agents set rev --unset model
capcomd agents list --json ; capcomd agents show rev --json   # spec + effective config + readiness
capcomd agents validate ; capcomd agents rm cx
capcomd run --profile rev --set maxTurns=10 --set children.maxDepth=1 "goal"   # narrowing only
capcomd run --profile rev --overrides '{"maxTurns":50}' --operator "goal"       # widening needs --operator
```

For Hermes or another orchestrator: define profiles with `agents add NAME --spec '<json>' --json`, read them with `agents list --json`, and select one per goal with `--profile`, or a per-task directive `[agent:NAME] …` in the goal text.

Auth is exactly one of `apikey` (the provider's API key, from local env or a boxd secret) or `subscription` (from `capcomd auth login claude|codex`). Giving both or neither is an error. `CAPCOMD_AGENT` still works as an override, set to a kind or a profile name.

`children` (policy only for now): `{allowSpawn, maxDepth, maxChildren, maxTotalDescendants, allowedChildProfiles, budgetShare}`. Children may only narrow their parent.
