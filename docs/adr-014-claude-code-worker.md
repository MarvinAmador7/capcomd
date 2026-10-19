# ADR-014: Claude Code is the first real worker

Status: accepted (2026-10-19)

## Context
capcomd had no real model or agent. `FakeModelClient` was the only `ModelClient`, and `fakeWork` produced the
task commits on the orchestrator host. Marvin picked Claude Code as the first real worker.

## Decision
`CAPCOMD_AGENT=claude-code` selects the adapter `src/agents/claude-code.ts`. The default stays `fake`, so the chaos gate, the tests and dry
mode are unchanged. The adapter runs inside the worker actor's `pushBranch`, in the task's sandbox VM:

1. **Clone**: `git ls-remote`, then `git clone --branch <target>`, then checkout the task branch `capcomd/<run>/<task>`. It reuses the
   pushed branch, or after a merge conflict (rework) it starts from the latest target. Git auth comes from the provider's
   `GitCredentialHook` (`src/agents/credentials.ts`). The GitHub token goes into the env of that one `git` exec only, through an inline
   `credential.helper`. It is never written to disk, never put in the remote URL, and the agent process never sees it.
2. **Install (pinned)**: Node `22.23.3` from nodejs.org and `@anthropic-ai/claude-code@2.1.303` from npm, installed into
   `$workdir/home`. Both are skipped if the pinned versions are already present.
3. **Run headless**: `claude -p <prompt> --output-format stream-json --verbose --max-turns N --max-budget-usd B
   --allowedTools <list> --disallowedTools <list>` runs in the background under `timeout`, in its own session (setsid).
   The defaults are 30 turns and $2, and all of them are set through `CAPCOMD_AGENT_*`. The allowed tools are file edits plus test, install and read-only git commands. Disallowed:
   `git push`, `git remote`, curl/wget, WebFetch/WebSearch.
4. **Stream**: the orchestrator tails `claude.jsonl` every `CAPCOMD_AGENT_POLL_MS`. Each event becomes a redacted span
   event on `agent.claude_code` (tool name, short text). The result sets cost, turns and stop reason, and the cost is charged to
   the run budget.
5. **Guards**: `--max-turns` and `--max-budget-usd` are enforced by the CLI. The `timeout` wrapper is backed by an orchestrator deadline.
   For cancel, a cancelled run kills the agent's process group (`kill -TERM -pgid`, then `-KILL`).
6. **Commit and push**: `git add -A`, then a commit with `Capcomd-Task: <run>/<task>`, `Capcomd-Epoch: N` and
   `Capcomd-Agent: claude-code@<v>`, then `git push --force-with-lease`. It is idempotent: if the same epoch already pushed a commit
   with those trailers, it is reused without rerunning the agent. Then comes the usual verifier step and the real merge (ADR-013).

**Secrets**: `ANTHROPIC_API_KEY` is passed only in the env of the one exec that starts claude. It is never in argv, the
prompt, logs or traces. `Redactor` masks the known secret values plus token shapes (`sk-ant-…`, `gh?_…`, `github_pat_…`,
`x-access-token:…@`) in every event, error and commit message. Tests cover the case where a deliberately leaking fake agent tries to expose the key.

**Egress**: claude-code VMs are limited to `github.com`, `api.anthropic.com`, `registry.npmjs.org` and `nodejs.org`.
Non-essential Claude Code traffic is disabled with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. `tests/agents/egress.live.test.ts`
checks that example.com and pypi.org are blocked. It runs live against boxd only from Marvin's Mac.

**Planner**: in claude-code mode, one goal becomes one task (`task-1`, goal = the run goal), with no model call. Claude Code does its own
decomposition. A real planner can come later behind `ModelClient`.

**Timeouts**: the worker and verifier actors set `actionTimeout` to 60 min (the rivetkit default is 60s), because
install, agent and PR merge waits are long-running actions.

## Testing
- `tests/agents/claude-code.test.ts`: a fake `claude` (`tests/agents/fake-claude.sh`) runs in `FakeProvider({hostExec:true})`. It covers
  flags, streaming, trailers, push, the leaking-agent redaction case, idempotency, timeout, cancel, no-change and error.
- `tests/agents/run-e2e.test.ts`: the full `capcomd run` through actors (`CAPCOMD_SANDBOX=fake-host`): one task, the agent commit,
  verify, approval, real merge into a bare repo. It also checks that the key never appears in the trace.
- `scripts/mac-e2e.sh`: the real thing (boxd, Claude Code, a GitHub PR) against a throwaway private repo.
