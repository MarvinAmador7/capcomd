# Site content: sources and samples

Every claim on the page comes from the repository. When a source changes, update the page. Paths are relative to
the repo root.

## Where the claims come from

| Section | Claims | Source |
|---|---|---|
| Hero | durable orchestration for swarms of coding agents; Claude Code and Codex agents in parallel, one VM and branch each; only the exact commit that passed checks and a reviewer merges, once; MIT; one executable for macOS and Linux, arm64 and x64; the Homebrew install | README intro, "Quickstart", "Each release has the binaries…"; LICENSE; package.json (version, shown as 0.6) |
| Spawn, await, verify, merge | the five calls; who the orchestrator is; primitives, not a workflow; agents keep working after the driver's session ends | README "What you get", "Core concepts"; plugins/capcomd/skills/capcomd-orchestration/SKILL.md |
| Pull the plug (its own band after Run) | every step written down before it counts; a run of three workers and a fuse box of four failures the visitor causes, each ending what a test checks: **Pull the plug** (capcomd restarts: everyone carries on, a step cut in half runs again, nothing already on main is merged twice), **Crash a worker** (its lease runs out, the task goes back on the board, a fresh worker takes it over and finishes it, a late reply from the crashed one is turned away), **Cloud outage, under 10 minutes** (the agents keep working, capcomd waits; past ten minutes the agent stops and names the provider, said under the box), **Out of quota** (the crew sleeps to the reset and carries on with nobody watching); "0 tasks lost" with the visitor's count of failures | Pull the plug: tests/subagents/restart.test.ts, tests/subagents/workflow.test.ts (restart mid-agent, mid-step, mid-watch), tests/merge/direct.test.ts and pr.test.ts (SIGKILL at six merge kill points, exactly once). Crash a worker: tests/scenarios/coordination.test.ts ("lease takeover from a crashed worker, fenced epochs"). Cloud outage: tests/agents/outage.test.ts, src/providers/resilient.ts (`CAPCOMD_SANDBOX_OUTAGE_MS`, 10 minutes by default). Out of quota: workflow.test.ts ("quota wake"). The page doesn't name Rivet or SQLite: they're how the record is kept, not a feature (owner, 2026-11-03). The chaos suite (`tests/chaos`) was removed on 2026-11-02, so the page doesn't mention it. The worker names, progress speeds and the goal are the page's own crew and the goal typed in the Ask stage |
| The five stages | `run new` takes its gates from the project, and the driver picks check names, never commands; `spawn --key`; `verify` on the branch merged with the latest target, in a throwaway VM with no credentials; a contract from a VM can't carry checks; a read-only reviewer that never pushes, where no verdict is a fail; `merge --require` lands the verified commit by compare-and-swap; a protected target parks the merge for approval (CLI, menu bar app, or the driver's client where the project allows it) | README "Verification you control", "Review by another agent", "Safety model"; STATUS.md table (verify/merge, reviewer, checks in a VM, protected targets); SKILL.md (MCP section); docs/durability.md (merge CAS) |
| Every agent gets its own computer | and its own copy of the code; four promises numbered on the picture: walled off (a VM in the cloud or a container on your machine; it can't see your files or the other agents), its own copy (its own branch), checked before it joins (checks in a fresh, throwaway machine on the branch merged with the latest main; only what passes merges), saved as it goes (pushed every 10 minutes and after every commit; a new agent *can* pick up from the last save); where they run: boxd (a whole VM, a boxd account, an API key never visible to the agent, sites limited per role) vs Docker (a container, no account, an API key visible to the agent but not a plan login, no site limit); credentials, checkpoint ref, `spawn --continue` and unrestricted-by-default behind "For engineers" | README "Isolation", "VMs come from a sandbox provider", "Safety model"; docs/providers.md (Docker: the agent can't see your files; an `apikey` is readable, plan logins unaffected; a profile that sets `egress` is refused); STATUS.md (supervisor, checkpoints); docs/agents.md. The picture's "saved 2 min ago" and the three states are illustrative |
| Roles are profiles | profile fields and `children`; narrow-only; `agents schema`, `agents validate`; what `capcomd setup project` writes (worker per provider, read-only reviewer with its tool list plus the check, planner that may spawn only the workers, `default` set to the first profile, no limits); the reviewer is spawned by the caller's `verify`, so it sits under the planner in the tree | docs/agents.md; src/agents/profiles.ts (schema); src/config/project-setup.ts (`planProject`) |
| How they talk | `send` (Claude reads at its next step; Codex can't while it runs); `handoff`, `result`; task board with leases, epochs and ordering; kv with compare-and-swap; events; fencing and capability tokens; **not yet**: leaves get the board, kv and inbox only when they may spawn, and sibling messaging within one parent is planned | SKILL.md; README "Agents that delegate, safely"; ROADMAP.md §3 ("Leaf agents can't coordinate") |
| What breaks at scale | the seven problem/mechanism pairs | README "Why" and "What you get"; docs/agents.md (stuck notices, pauses); STATUS.md (live spend); README "A real run" (13 VMs, all cleaned up) |
| Seven patterns | the seven patterns and when to use each; no built-in compare yet; stacked branches not supported; report agents | SKILL.md §1–7; README "Core concepts" (Report) |
| Every run has a flight recorder (after Patterns) | `capcomd tui` shows a run live (agents, spend, time); every span and event is recorded and a finished run can be replayed; the six views and the question each answers; the four commands (`tui [runId]`, `trace <runId>`, `events <runId> --follow` with `--json`, `inspect <runId> --json`); cost is an API-price estimate, $0 billed on a subscription | apps/tui/README.md (views, keys, live via `inspect --follow`, spans written as they end); `capcomd --help`; README "See everything". The terminal is the real TUI: its own Ink components rendered with the shots script's ANSI-to-HTML from the owner's run `run-kb23b6ca66fb560bf` (Build tinycalc, 3 Nov 2026), cut at the end of its work (28m 19s): read-only spans recorded hours later by inspecting it were dropped. `lib/flight-recorder.json` holds the five views and 20 Replay frames; the raw trace is not committed. The page doesn't say OpenTelemetry: OTLP export isn't connected (docs/adr-010-tracing.md) |
| A live run | 2026-10-21; three broken functions, one failing test each; 2 Claude workers + 1 Codex worker; 3 of 3 merged, suite green; 7 agents; 13 VMs; 228 s; $0 billed, about $0.37 at API prices | README "A real run" |
| Drive it from your agent | the integrations table and each row's status; `relay.v1`, stable exit codes; `tui`, `logs --follow`, `tree`; the menu bar app is macOS only and built from source; the install commands; the early-release line | README "Connecting your agent", "Integrations", "Quickstart"; apps/menubar/README.md; STATUS.md |

## The bot playground (/bots/)

Everything on it comes from the avatar engine (packages/bot-avatar) and its catalog. Every part, mood, size, pose and
the role weights are the engine's own. The odds and the "possible bots" counts are computed by the engine's rules
(`candidates`, `weightOf`, `countCombinations`). "Cheer" applies the app's run-finished moment (Moments.swift): cheer
pose, happy face, a party hat for anyone without a crown or flag, and confetti placed by `rng(seed, "confetti")`.
Copy sources: apps/menubar/design/brand/README.md ("Every agent gets a generated pixel bot: same agent id, same bot,
forever"; the role weights).

## Sample content to confirm or replace

The pictures of the app are rebuilt in HTML from the approved mockups (`apps/menubar/design/`). They're
illustrations, not captures, and they show the menu bar app as it is on `main` (its Active card redesign is under
`## Unreleased` in CHANGELOG.md). The page says so in a note above the stages. These details in them are samples:

- The project chip "my-app", the menu bar date and time ("Wed 28 Oct", "9:41"), and the elapsed times on the cards
  (0:12, 2:05, 2:58, 3:41, "asked 18s ago").
- "Add rate limiting to the API · Merged into main" in Recent. The goal comes from the README, but that finished run is
  illustrative.
- The approval card's files and counts: `src/parser.ts +11 −2`, `src/parser.test.ts +6 −0`.
- The agents' short suffixes ("worker 3f1a"), derived from the run id the way the app suffixes sibling agents. They change with every crew.
- In the roles section, `lead` and `triage` are example profiles. The file says so in its title bar and in the note
  under it.
- The tree's `bun test` check in the example `agents.json` reviewer tools: it's what setup adds for a project whose
  check is `bun test`.

## Open decisions (defaults used)

- The domain: decided. The site is https://capcomd.vercel.app (`SITE_URL` in `lib/site.ts`).
- Hosting: decided. Vercel, with Root Directory `site` (see README.md). It's still a static export.
- Brand notice (the owner's wording): "The capcomd name, bots and brand are © 2026 Marvin Amador Campos. capcomd's code is
  MIT-licensed." It appears in the footer and on /bots next to download and share. Usage terms for downloaded bots
  are still the owner's to decide.
- Not built yet: per-bot share previews (would mean leaving the static export) and a "random role" pull.
- Footage: none recorded. The rebuilt panels are the product imagery.
- The name: the site doesn't explain what CAPCOM means.
- Bot names: not used. Agents are named by role, plus a short suffix in the panels, as in the app's tree.

## The desktop page (/desktop/)

capcomd Desktop is in development (branch feat/desktop-shell, not on main yet), so the page says so in the hero and
in the close, and its action is "Watch on GitHub".

The page is six beats, one idea per screen (2026-11-03, the owner's "refined, minimalist, Apple-like" pass): what the app
is (the window), the engine at scale (the swarm shot), three tiles (one column, the keys, the title bar), three figures
(native, fast, measured) with the perf log one click away, the window today, and the close. The measurements, budgets
and the layer-by-layer stack live on /desktop/perf/.
Every ask on the page is the goal-finish decision of the goal-branch flow: reviewed work lands on the goal branch with
no human step, and the planner asks whether to open the pull request. No sample shows a per-merge approval.

| Section | Claims | Source |
|---|---|---|
| Hero, the reel | the Mac app for capcomd's orchestration engine; agents as full-height columns in tree order; the engine reviews and merges; crew tabs with a bracket on the columns on screen; the planner's ask to open the pull request docks at its column's foot (View diff · Deny · Approve ↩) | apps/menubar/design/desktop/SPEC.md §2; Reel.png; the goal-branch flow (in-between merges need no approval, the PR is the user's choice) |
| Swarms, made human | One shot in the desktop window, title bar included, on a plum stage. Lumen, the planner, is docked at the left and the crew's columns slide in under it. Its composer types the goal and sends it; Lumen reads the repo, writes a three-step plan and spawns a lead per step, and each lead spawns four workers and a critic (19 agents, in tree order) while the camera follows to the last column (motion blur from the camera's speed). Then workers finish, critics approve their diffs, leads merge their steps into the goal branch, and Lumen's thread logs each spawn, approval and merge before asking the one decision: open the pull request (Approve or Deny). The title bar folds subtrees off screen into stacks. The plan, file count, names, ids, diff sizes and branch name are sample content | SPEC.md §2; ReelNew.png, ReelSwarm; the goal-branch flow |
| Tiles | one column per agent with its whole thread and the question docked at its foot; ⌘1 opens a project, ⌃→ the next agent, ↩ approves; moves never wait on an animation; one project open, the rest folded into decks that say when one needs you | SPEC.md §2, §4; Reel.png, ReelStack; the goal-branch flow |
| Native. Fast. Measured. | 0 web views (Swift from the first pixel to the socket: 81 Swift files, no other sources in the app); 120 Hz slides drawn by Core Animation on ProMotion; ⅔ less main-thread work (10.1 → 3.6 s main-thread CPU on DeskBench, 3a6b5b7 → 9bcd41a) | apps/menubar/app on feat/desktop-shell (Package.swift, Reel.swift); the perf log of 30 Oct 2026 |
| The window today | a capture of the real window | `CapcomdDeskBench snapshot --fixture crew17 --at 0` on feat/desktop-shell 9bcd41a (generated data) |

Pictures:

- `public/desktop/real-window.jpg`: the real window, drawn by DeskBench from the `crew17` fixture. Its text is
  generated, and some of it repeats. Retake it when the app has a demo run.
- The bots are the engine's own. Their seeds (`dk-*`) were picked so the names match the boards (Lumen, Nugget,
  Tinker, Volt, Mica, Loop, Radar).

Samples to confirm: the matchkey run at its finish, its agents' text, times and counts (adapted from Reel.png); the goal
branch `migrate-matchkey-v3.2`, the base `dev` and the pull request's size (9 files, +318 −41); "Fix proration" (ready,
its planner asks), "Migrate matchkey" and "addriva" (pull request open) as decks in the title bar tile; "Opus 5.5" in the composer; `my-app` / `dev` on the new
project's chips.

## The perf log (/desktop/perf/)

"Benching the Reel", the log an agent wrote on 30 Oct 2026 while it tuned the reel, rebuilt as a page of the site. Its
words, numbers and terminal excerpts are `lib/perf.ts`, taken from the log as written (help text trimmed to fit, ✓
marks dropped). Its data was extracted from the log's own embedded data, not re-measured:

- `lib/perf-reel.json`: the main-thread strips of `step` and `switch`, before and after (run-length coded, 9 s each).
- `lib/perf-log.json`: the compositor's hitches, the burst lengths and the A/B medians and ranges. Drawn at build time.
- `public/desktop/perf-trees.json` (520 KB, about 54 KB gzipped): the Time Profiler call trees of four recordings,
  fetched by the flame graphs when they mount.
- `public/desktop/bench-at0.jpg`, `bench-at5.jpg`, `bench-at10.jpg`: `CapcomdDeskBench snapshot --fixture crew17
  --at 0|5|10`, taken 31 Oct 2026 from the release build on feat/desktop-shell (generated data).

The page names the machine (MacBook Pro, MacBookPro18,3, macOS 27.0.1) and the build hashes, as the log did. Retake
it when the switch work lands: the "Still slow" section says the next targets.

## PerfLoop (/perfloop/)

What PerfLoop unlocks for agents (see, feel, improve, again), not how it works. Every number is from
`design/perf-loop/JOURNEY.md` and `apps/menubar/app/LAYOUT.md` on main; JOURNEY §7 ("what not to claim") holds: no
speed-up from the loop itself (none beat the champion), no trusted dedicated-hardware numbers, no hand-recorded
gesture, not a standalone product. Linked from the Desktop page's "Native. Fast. Measured." (not in the main nav).

| Section | Claims | Source |
|---|---|---|
| Hero, a night of the loop | the twelve ledger entries (the bench against itself; `reel.slide=clip`; `build.perFrame=4`; the planted cheat; `desk.layout=frames`; `frames-hide`; `desk.column=native` needs review; `park`; `reuse`; `bitmap`; the swipe with real timestamps; the 4 → 64 sweep) and the next idea queued (native Core Text rows); 0 kept | JOURNEY §4, §5.2, §5.3, §5.5; LAYOUT.md "What it measured", exp 0008–0010, "What's next". The clock times and the single night are staging, said in the caption: the runs were spread over 30–31 Oct; `ssh://mini` is the runner's form, not a claim the night ran there |
| It sees why | in-process sampler in every long stretch; re-renders charged to the state change (C1, C7); the two-window bench bug, ~180 → ~120 ms for a 17-agent step | JOURNEY §3, §5.4; commit 7db3144 |
| It feels the swipe | replay scored on following the fingers; the overshoot (~200 pt past the column edge, no snap) found by the replay with real timestamps; 48/48 synthetic replays at 0 pt p95 (bar 1 pt); a realistic swipe ~2× the CPU of the synthetic fling | JOURNEY §5.3, §5.6. The curves are a diagram; only the 200 pt is measured |
| Only better survives | the cheat (67 vs 114 ms, built-within failed both reps, snapshot 1.9 % vs a 0.5 % limit, honest pair 0.13 %); `frames-hide`'s −27 % from blank columns; same-build in band; untrusted runs decide nothing; tolerances only the owner sets, refused inside `exp`; behaviour changes wait for the owner; bugs reported, not fixed | JOURNEY §5.1–5.3; tools/perfloop `main.swift` (`--guard-tolerance` refusal), `Explain.swift` (behaviour change) |
| Every night | idle gate (two minutes, a rep redone on input, never on a locked screen); the ssh runner; results keyed by machine; the append-only ledger as memory across sessions; `explain.txt` enough to decide the next step | JOURNEY §5.7; `Ledger.swift`, `Explain.swift`; `perfloop help` |
| It told us what not to build | the profile split at 4 and 40 agents; ~1,100 views; slopes 3.28 / 2.96 / 2.40 ms per agent (50 → 261, 46 → 237, 43 → 212 ms) | LAYOUT.md "Profile split", "Sweep"; JOURNEY §5.5 |
| Agents built it, too | phases 0–4 planned at 7–8 weeks, built in ~1.5 days in parallel worktrees; ~65 commits; ~8,000 lines, 120 tests, plus 77 adapter tests | JOURNEY §3 |
| For engineers | C1–C10 as built; four commands; not done: hand-recorded gesture, trusted mini numbers, a speed-up of its own, the VM runner | JOURNEY §3, §7; `perfloop help` |
