# capcomd roadmap

**Updated:** 2026-10-23. What works today is in [STATUS.md](STATUS.md); this file is what's left: gaps, limits on
orchestration patterns, risks and debt, with a proposed approach for each. Sizes are rough: **S** (hours),
**M** (a day or two), **L** (several days).

## 1. Built, waiting for a live run

These pass their tests on fakes but aren't in `scripts/mac-subagents-e2e.sh` yet (S each): add a reporting
child, a protected-target merge approved by the operator, a staging target, and an interface-first goal
(contract, then provider and consumer in parallel).

Also built and tested on fakes, not yet run live with real agents: quota pauses and the wake at the reset (the
CLIs' usage-limit output was read from their code, not captured), spinning and failing notices, and `grant`
(ADR-019).

Verified live on 2026-10-24 (`CAPCOMD_E2E_VIA=run scripts/mac-subagents-e2e.sh`, `E2E PASS`, 186s): `capcomd run
--planner planner` from a goal in plain words, with the run's gates from the project config: the planner had 2
Claude and 1 Codex workers verified, reviewed and merged, and the command showed each agent's status as it changed.

Verified live on 2026-10-23 (`scripts/mac-agent-ops-e2e.sh`, `E2E PASS`, 159s, three Claude agents): an `idle`
notice that `await --notices` returned while the agent ran a long command; a message sent to it then, delivered
mid-run and acted on (its branch has what the message asked for); an agent stopped at its timeout, continued with
`spawn --continue` to a branch holding both its work and the rest.

Verified live on 2026-10-23 (`E2E PASS`, 185s): the no-restrictions defaults (ADR-019 §7: `capcomd setup`'s
planner profile with no limits, no run budget, workers with every tool and open egress), and checkpoints pushed to
`refs/capcomd/checkpoints/*` on GitHub and deleted when the work merged.

Verified live on 2026-10-21 (`E2E PASS`, 228s): the **reviewer** (3 real reviewers on a read-only profile, ~16s
each, every verify needing both its check and the verdict; the planner's verifies polled to completion) and
**checks in a VM** (6 boxd checks VMs, one per verify and merge, `bun test` inside, all destroyed).

## 2. Next, in order

1. **The plugin in Codex** (S; ADR-018). The MCP tools, the plugin and `capcomd setup` installing it are built and
   verified live from Claude Code (`scripts/mac-plugin-e2e.sh`). Left: run the plugin in Codex (built to OpenAI's
   format: `.codex-plugin/plugin.json`, `.codex-mcp.json`, `.agents/plugins/marketplace.json`) and fix what differs,
   for example whether Codex passes the session's `PWD` to the server.
2. **Sandbox providers as a documented contract** (M). VMs already come through `SandboxProvider`
   (`src/providers/sandbox.ts`), with boxd and a local fake behind it, but boxd is wired in: the provider list is
   hard-coded (`src/dependencies.ts`), checks run in a VM only when `CAPCOMD_SANDBOX === "boxd"`, `env build` and
   secrets assume boxd snapshots, and `capcomd setup` only offers boxd. Approach: a provider registry selected by
   name, capabilities a provider declares (snapshots, host-bound secrets, checkpoints, egress control) in place of
   the boxd checks, a conformance suite every provider must pass, a "Writing a provider" guide, and a provider
   choice in setup. Then a second provider (a local one, e.g. containers or microVMs, so capcomd runs with no
   cloud account) proves the contract.

Done on 2026-10-23/24: `capcomd run` with a planner agent, agent logs (`logs --follow`), one checks run for verify and
merge (a pass is reused for the same tree), host checks without credentials, the ADR-019 leftovers (spinning without
workspace changes, opt-in; `send` saying when a Codex or finished agent won't read a message, since `codex exec`
reads no input once started and runs `--ephemeral`; "confirm before acting on silence" and stuck-window presets
decided against, see ADR-019 §2). Dropped: a reviewer budget reserve
(a reviewer is paid from its caller's budget, which only binds when a budget is set; `grant` the caller more).

## 3. Orchestration patterns that aren't possible yet

| Pattern | Why not | Approach | Size |
|---|---|---|---|
| Stacked or dependent work in parallel (B builds on A's unmerged branch) | children always branch from the target; verify is "merged with the latest target" | in tiers, see "Stacked work" below; tier 1 (interface first) is done | L |
| Changes split across children that only pass together; atomic landing of several branches | `verify` and `merge` take one ref | a `verify --refs a,b,c` over their combined merge, and `merge --require` landing them as one commit | L |
| Lead → team branch → main hierarchies | one target per run (operator-set); agents can't choose another | an operator allowlist of targets per run (`--targets team/*,main`), so a lead lands on its team branch and the planner verifies and lands the whole | M |
| Comparing candidates (best-of-n) | verify judges one ref; there is no compare op | a `compare --refs …` op: a judge agent ranks the passing refs and returns the winner and reasons | M |
| Several reviewers, or a reviewer per kind of change | one reviewer profile per run | per-run reviewer routing chosen by the operator (by path or label), and an optional quorum | M |
| Changes across repositories in one run | each run has one repository (recorded at `run new`; one engine serves runs on different repositories) | a repository per agent within a run | M |
| An agent landing its own work | verify and merge exclude the caller | keep: a parent or the operator lands it (see constraints) | – |

### Stacked work

Three tiers, modelled on stacked diffs (Gerrit, Sapling, Jujutsu, Graphite), speculative merge queues (Zuul,
GitHub merge queue, Bors) and interface-first splitting (branch by abstraction). Do tier 1 first; build tier 2
only when real runs show work that can't be split by interface.

1. **Interface first** (done 2026-10-21). The planner splits dependent work into a small contract change
   (interface, types, a stub behind a flag) that lands first, then the provider and consumers in parallel
   against the target, landed in dependency order with an integration check on the consumer. Guidance:
   pattern 7 in `plugins/capcomd/skills/capcomd-orchestration/SKILL.md` and the in-VM skill. Proof:
   `tests/scenarios/interface-first.test.ts`. Left: a live e2e with real agents (S).
2. **Speculative stacks** (L). `spawn --base <agt>` branches B from A's latest verified commit. Each change
   carries a stable `Capcomd-Change` trailer across rebases. B is verified against target + A + B, and the vfy
   record pins the parent commit. If A is reworked or its verify fails, B's verification goes stale: capcomd
   restacks B onto A's new commit (clean rebase: re-verify; conflict: a rework agent with the conflicting
   files, never a silent fix-up). The stack lands bottom-up as one fast-forward, so the target never sees half
   a stack. Keep stacks shallow (about 3).
3. **Merge queue** (L). All children enter a queue that tests predicted states (target + everything ahead) in
   parallel and drops failures, instead of racing to merge. Worth it only at high fan-out on a busy target.

Rules for any tier: a verification binds to a tree (an exact commit, as `expectSha` already does), never a
branch name; a change lands only after every change below it; restacking is automatic, and a conflict is
rework.

## 4. Limits on patterns that work

| Limit | Impact | Approach | Size |
|---|---|---|---|
| Gates are fixed at `run new` | a planner that discovers sub-tasks mid-run can only pin existing named checks (or fall back to the default suite, which fails on a red repo). The operator can rewrite kv `_checks` mid-run, but that's undocumented and unvalidated | `capcomd checks add <runId> name='cmd'` (operator), validated like `--checks-set` | S |
| Leaf agents can't coordinate | real agents get the in-VM CLI (task board, kv, inbox, heartbeat, result) only when they may spawn; a leaf only hears from its parent (`send`, Claude only); siblings can read each other but messages go through the parent | a `--tools coordinate` grant that gives a leaf the CLI without spawn rights; sibling messaging within one parent | M |
| Rework rounds start fresh | `spawn --continue` starts the next round from the last one's branch, but in a new VM, clone, install and session | resume the agent's session (`claude --resume`) in a kept VM for k rounds | M |
| Repeated verify without `--key` | a planner whose verify is cut off by its tool's timeout and re-runs it without `--key` starts a second review | the skill text says to pass `--key`; add a per-ref "in progress" lookup so a keyless re-run joins the running one | S |
| Budgets on subscription billing | USD budgets do nothing (cost is $0); only turns and wall time bind | budget on notional cost as an opt-in unit | S |
| Carve shrinkage | with a `budgetShare` set, each later child gets that share of what's left, so the n-th child gets much less unless budgets are explicit (no share is set by default) | an "equal split" spawn option for fan-out | S |

## 5. Operations, deployment, CI

- **Binary signing** (S): the single executables (scripts/build-binary.ts) are ad-hoc signed only; macOS doesn't
  quarantine a `curl` download, but a browser download needs `xattr -d com.apple.quarantine`. Sign and notarize them.
- **Binary size** (S): each binary is 210–240 MB, most of it rivet-engine; the engine could be fetched on first
  `serve` instead, for a smaller download.
- **Single local engine** (L): Rivet Cloud is deferred (ADR-009); no backup/restore of engine data.
- **Engine data for test ports** (S): the live e2e scripts now keep the engine's data in their work dir, but
  engines started on other ports (by hand, `serve --port N`) still keep `~/.capcomd/engine/<port>`, which nothing
  removes.
- **VM-ledger reconciliation** (S): no reaper reconciles `.relay/boxd.sqlite` rows whose VMs are gone (stale
  `created` rows were found on 2026-10-21; their VMs no longer existed).
- **CI coverage** (M): CI runs the typecheck, `tests/machines`, the scenario suite, the killpoint tests (with
  `|| true`, so they can't fail the build) and `chaos:fast` (strict), sharded into four parallel jobs (killpoints,
  recipe, primitives, seeds): one round on every push to main, all three rounds nightly and on manual dispatch.
  It doesn't run the live e2e, `tests/agents`, `tests/env`, `tests/merge` or `tests/cli`. Make the killpoint step
  strict and add those suites.

## 6. Known issues and test debt

- Test files interfere when run in one `bun test` process (for example `serve --port N binds N…`); run them per
  file until they're isolated.
- Tests that read the checkout's real `.relay/` ledgers: three were found and fixed (2026-10-21); audit the rest
  so a saved login can't change test outcomes.
- `tests/env` probes the host as if it were a fresh image, so it fails where `codex` is installed (boxd VMs).
- Every file in `tests/merge`, `tests/cli` and `tests/env` passes on its own (checked 2026-10-23 on macOS without
  `codex`), but CI doesn't run them yet (§5, CI coverage).
- `docs/open-questions.md` is a low-confidence reconstruction and needs re-research.

## 7. Deliberate constraints

Not planned to change, because loosening them lets an agent choose its own gate:

- **Test commands come only from the operator.** Agents pick a named check (pinned at spawn) but never write
  one; in-VM `--checks` is refused.
- **The reviewer is chosen by the operator.** Agents can't pick a lenient one or skip review.
- **Agents can't verify or merge themselves**, and protected targets need an operator's decision.
- **Agent text is data.** Results, logs and messages from other agents arrive fenced and can't grant permissions.
