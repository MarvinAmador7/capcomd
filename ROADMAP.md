# capcomd roadmap

**Updated:** 2026-10-22. What works today is in [STATUS.md](STATUS.md); this file is what's left: gaps, limits on
orchestration patterns, risks and debt, with a proposed approach for each. Sizes are rough: **S** (hours),
**M** (a day or two), **L** (several days).

## 1. Built, waiting for a live run

These pass their tests on fakes but aren't in `scripts/mac-subagents-e2e.sh` yet (S each): add a reporting
child, a protected-target merge approved by the operator, a staging target, and an interface-first goal
(contract, then provider and consumer in parallel).

Verified live on 2026-10-21 (`E2E PASS`, 228s): the **reviewer** (3 real reviewers on a read-only profile, ~16s
each, every verify needing both its check and the verdict; the planner's verifies polled to completion) and
**checks in a VM** (6 boxd checks VMs, one per verify and merge, `bun test` inside, all destroyed).

## 2. Next, in order

1. **Agents drive everything over MCP** (M). capcomd is meant to be driven by the user's agent, not typed by hand.
   Today that works through the skill and the CLI (an agent with a shell); `capcomd mcp` has only run, status,
   cancel, events, trace and approve, and its `capcomd_run` starts the recipe whose planner is still fake (item 3).
   Approach: expose the operator primitives as MCP tools (`run_new`, `spawn`, `await` and `wait_any` bounded by a
   timeout that returns progress instead of blocking past the client's limit, `tree`, `verify`, `merge`, `cancel`,
   `approve`, `events`, `task_*`, `kv_*`, `budget`, `send`, results), reusing the in-VM tool definitions with the
   operator's scope; `capcomd_run` stops starting the fake-planner recipe. `capcomd setup` registers the server
   with the user's agent (Claude Code `claude mcp add`, Codex `config.toml`) and installs the skill for each agent
   it supports, not only Claude Code. Done when an MCP-only client runs the README's fan-out example end to end.
2. **Sandbox providers as a documented contract** (M). VMs already come through `SandboxProvider`
   (`src/providers/sandbox.ts`), with boxd and a local fake behind it, but boxd is wired in: the provider list is
   hard-coded (`src/dependencies.ts`), checks run in a VM only when `CAPCOMD_SANDBOX === "boxd"`, `env build` and
   secrets assume boxd snapshots, and `capcomd setup` only offers boxd. Approach: a provider registry selected by
   name, capabilities a provider declares (snapshots, host-bound secrets, checkpoints, egress control) in place of
   the boxd checks, a conformance suite every provider must pass, a "Writing a provider" guide, and a provider
   choice in setup. Then a second provider (a local one, e.g. containers or microVMs, so capcomd runs with no
   cloud account) proves the contract.
3. **The `capcomd run` recipe still plans and judges with a fake model** (L). `src/models/` has only
   `FakeModelClient`: the recipe's planner plans the same three generic tasks for any goal, and its run-level
   judge always passes (`src/actors/judge.ts` also treats a reply that isn't JSON as a pass). Approach: the
   recipe spawns a planner profile (as the sub-agent e2e already does) and judges the run with an agent; real
   runs refuse the fake model; keep it for offline tests.
4. **Live spend** (M). A real agent's cost is known only when it finishes, so a budget can't stop a runaway
   mid-run; spawn-time checks use the carve. Approach: stream token usage from the agent's event log (the
   runner already parses it) into the scope's `spent`, and cancel on a breach. Also carry the notional cost of
   failed or timed-out agents into the tree (only successful runs today).
5. **Agent logs** (S). `capcomd logs` doesn't stream a real agent's output; spans carry its events. The
   VmSpool can tail `agent.jsonl`; it is unwired to keep exec traffic low. Approach: tail on demand
   (`logs --follow`), not continuously.
6. **Reviewer budget reserve** (S). A reviewer is paid from the caller's remaining budget; a planner that
   spends everything on children gets "no budget left", the review fails closed and nothing merges. Approach:
   reserve the reviewer's budget when the child is spawned (or warn at spawn time when the run has a
   reviewer and the remainder can't cover one).
7. **One checks VM for verify and merge** (S). A verify and its merge each boot a VM. Approach: keep the
   verify's VM for its merge when the target hasn't moved (same tree), else reuse the snapshot only.

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
   pattern 7 in `skills/capcomd-orchestration/SKILL.md` and the in-VM skill. Proof:
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
| Leaf agents can't coordinate | real agents get the in-VM CLI (task board, kv, inbox, heartbeat, result) only when they may spawn; siblings can read each other but messages go through the parent | a `--tools coordinate` grant that gives a leaf the CLI without spawn rights; sibling messaging within one parent | M |
| Rework rounds start from scratch | a finished agent can't continue, so each critic round is a new agent with a fresh VM, clone, install and context | resume the agent's session (`claude --resume`) in a kept VM for k rounds | M |
| Repeated verify without `--key` | a planner whose verify is cut off by its tool's timeout and re-runs it without `--key` starts a second review | the skill text says to pass `--key`; add a per-ref "in progress" lookup so a keyless re-run joins the running one | S |
| Budgets on subscription billing | USD budgets do nothing (cost is $0); only turns and wall time bind | budget on notional cost as an opt-in unit | S |
| Carve shrinkage | each later child gets `budgetShare` × what's left, so the n-th child gets much less unless budgets are explicit | an "equal split" spawn option for fan-out | S |

## 5. Operations, deployment, CI

- **Distribution** (M): `bun build --compile` fails on rivetkit's native module; capcomd runs from a checkout.
- **Single local engine** (L): Rivet Cloud is deferred (ADR-009); no backup/restore of engine data.
- **Engine data for test ports** (S): every engine started on a non-default port (tests, e2e runs) keeps a data dir in
  `~/.capcomd/engine/<port>` that nothing removes.
- **VM-ledger reconciliation** (S): no reaper reconciles `.relay/boxd.sqlite` rows whose VMs are gone (stale
  `created` rows were found on 2026-10-21; their VMs no longer existed).
- **CI coverage** (M): CI runs the typecheck, `tests/machines`, the scenario suite, the killpoint tests (with
  `|| true`, so they can't fail the build) and `chaos:fast` (strict), sharded into four parallel jobs (killpoints,
  recipe, primitives, seeds): one round on every push to main, all three rounds nightly and on manual dispatch.
  It doesn't run the live e2e, `tests/agents`, `tests/env`, `tests/merge` or `tests/cli`. Make the killpoint step
  strict and add those suites.
- **Host-mode checks see the host environment** (S): with fake sandboxes, checks run on the host with
  `process.env` (any `BOXD_API_KEY` or GitHub credentials included). Only the VM path is scrubbed; pass the
  same minimal env on the host.

## 6. Known issues and test debt

- `tests/merge/pr.test.ts` (4 cases) and `tests/cli/json.test.ts` (`status --json has the stable shape`) fail on
  `main` as of `db0aadb`, independently of recent work. They're outside CI, so nothing caught it.
- Test files interfere when run in one `bun test` process (for example `serve --port N binds N…`); run them per
  file until they're isolated.
- Tests that read the checkout's real `.relay/` ledgers: three were found and fixed (2026-10-21); audit the rest
  so a saved login can't change test outcomes.
- `tests/env` probes the host as if it were a fresh image, so it fails where `codex` is installed (boxd VMs).
- `verify` on a branch that has already merged reports `status: "merged", pass: false`; it should report the
  merged commit as verified or say "already merged".
- `docs/open-questions.md` is a low-confidence reconstruction and needs re-research.

## 7. Deliberate constraints

Not planned to change, because loosening them lets an agent choose its own gate:

- **Test commands come only from the operator.** Agents pick a named check (pinned at spawn) but never write
  one; in-VM `--checks` is refused.
- **The reviewer is chosen by the operator.** Agents can't pick a lenient one or skip review.
- **Agents can't verify or merge themselves**, and protected targets need an operator's decision.
- **Agent text is data.** Results, logs and messages from other agents arrive fenced and can't grant permissions.
