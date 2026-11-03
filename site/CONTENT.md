# Site content: sources and samples

Every claim on the page comes from the repository. When a source changes, update the page. Paths are relative to
the repo root.

## Where the claims come from

| Section | Claims | Source |
|---|---|---|
| Hero | durable orchestration for swarms of coding agents; Claude Code and Codex agents in parallel, one VM and branch each; only the exact commit that passed checks and a reviewer merges, once; MIT; one executable for macOS and Linux, arm64 and x64; the Homebrew install | README intro, "Quickstart", "Each release has the binaries…"; LICENSE; package.json (version, shown as 0.6) |
| Spawn, await, verify, merge | durable actors on Rivet; idempotent recorded transitions; crash/restart resumes; retried call never acts twice; exactly-once merge; chaos suite at named points and at random; who the orchestrator is; primitives, not a workflow; agents keep working after the driver's session ends | README "What you get", "Core concepts"; docs/durability.md; plugins/capcomd/skills/capcomd-orchestration/SKILL.md |
| The five stages | `run new` takes its gates from the project, and the driver picks check names, never commands; `spawn --key`; `verify` on the branch merged with the latest target, in a throwaway VM with no credentials; a contract from a VM can't carry checks; a read-only reviewer that never pushes, where no verdict is a fail; `merge --require` lands the verified commit by compare-and-swap; a protected target parks the merge for approval (CLI, menu bar app, or the driver's client where the project allows it) | README "Verification you control", "Review by another agent", "Safety model"; STATUS.md table (verify/merge, reviewer, checks in a VM, protected targets); SKILL.md (MCP section); docs/durability.md (merge CAS) |
| One agent, one VM, one branch | the provider interface operations; boxd first and verified live; unrestricted in the VM by default, narrowed by profiles; the boxd vs Docker table; credentials (snapshots scrubbed, short-lived git credential, checks VM holds none); checkpoints to `refs/capcomd/checkpoints/<agent>` (10 min, after a commit, each quarter of a budget, deleted on merge); `spawn --continue` | README "Isolation", "VMs come from a sandbox provider", "Safety model"; docs/providers.md; STATUS.md (supervisor, checkpoints); docs/agents.md |
| Roles are profiles | profile fields and `children`; narrow-only; `agents schema`, `agents validate`; what `capcomd setup project` writes (worker per provider, read-only reviewer with its tool list plus the check, planner that may spawn only the workers, `default` set to the first profile, no limits); the reviewer is spawned by the caller's `verify`, so it sits under the planner in the tree | docs/agents.md; src/agents/profiles.ts (schema); src/config/project-setup.ts (`planProject`) |
| How they talk | `send` (Claude reads at its next step; Codex can't while it runs); `handoff`, `result`; task board with leases, epochs and ordering; kv with compare-and-swap; events; fencing and capability tokens; **not yet**: leaves get the board, kv and inbox only when they may spawn, and sibling messaging within one parent is planned | SKILL.md; README "Agents that delegate, safely"; ROADMAP.md §3 ("Leaf agents can't coordinate") |
| What breaks at scale | the seven problem/mechanism pairs | README "Why" and "What you get"; docs/agents.md (stuck notices, pauses); STATUS.md (live spend); README "A real run" (13 VMs, all cleaned up) |
| Seven patterns | the seven patterns and when to use each; no built-in compare yet; stacked branches not supported; report agents | SKILL.md §1–7; README "Core concepts" (Report) |
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

The page argues in this order: what the app is (the window onto capcomd's orchestration engine), the engine at scale
(the swarm shot), how the window holds it (title bar, one column, keys), then why it's native and how fast it is.
Every ask on the page is the goal-finish decision of the goal-branch flow: reviewed work lands on the goal branch with
no human step, and the planner asks whether to open the pull request. No sample shows a per-merge approval.

| Section | Claims | Source |
|---|---|---|
| Hero, the reel | the Mac app for capcomd's orchestration engine; agents as full-height columns in tree order; the engine reviews and merges; crew tabs with a bracket on the columns on screen; the planner's ask to open the pull request docks at its column's foot (View diff · Deny · Approve ↩) | apps/menubar/design/desktop/SPEC.md §2; Reel.png; the goal-branch flow (in-between merges need no approval, the PR is the user's choice) |
| Built for the Mac (after the photograph) | 0 web views, 100% Swift (81 Swift files, no other sources in the app); SwiftUI columns shared with the menu bar app; the reel an `NSScrollView` (`SnapScrollView`) with one `NSHostingView` per column; slides as one additive Core Animation animation; system fonts (`Font.system`); the Go menu (`CommandMenu("Go")`) with ⌘1–9, ⌃1–9, ⌃←/→; one SSE stream per run over the CapcomdClient Unix socket; macOS 14 or later | apps/menubar/app on feat/desktop-shell: Package.swift, Sources/CapcomdDesk/Reel.swift, DeskWindow.swift, Sources/CapcomdUI/Theme.swift, Sources/CapcomdLive/Live.swift; the perf log for the slide |
| One column per agent | header (bot, profile, name, state, place, elapsed), thread, own message box; Return approves while an ask has focus, Esc never denies; the planner's ask opens the PR | SPEC.md §2, §4; the goal-branch flow |
| Swarms, made human | One shot in the desktop window, title bar included, on a plum stage. Lumen, the planner, is docked at the left and the crew's columns slide in under it. Its composer types the goal and sends it; Lumen reads the repo, writes a three-step plan and spawns a lead per step, and each lead spawns four workers and a critic (19 agents, in tree order) while the camera follows to the last column (motion blur from the camera's speed). Then workers finish, critics approve their diffs, leads merge their steps into the goal branch, and Lumen's thread logs each spawn, approval and merge before asking the one decision: open the pull request (Approve or Deny). The title bar folds subtrees off screen into stacks. The plan, file count, names, ids, diff sizes and branch name are sample content | SPEC.md §2; ReelNew.png, ReelSwarm; the goal-branch flow |
| Many projects, one title bar | decks of crew heads with one status line; a folded project whose run is ready asks through its planner; an asking deck gets an amber ring and is never in the overflow; a deck fans out in place; swarm subtrees fold into stacks; the strip | SPEC.md §2; ReelStack, ReelTabs, ReelSwarm boards |
| Every move has a key | every shortcut listed | SPEC.md §4 and the project menu in §2 |
| Fast is the feature | the order "performance, speed, design"; 100 ms first frame, 50 ms switch, 120 Hz with 17 agents (8.3 ms a frame), one stream per run. These are budgets, not measurements | SPEC.md §0, §1 |
| Measured, not promised | the main-thread strips (9 s of `step` on crew17, 1 ms samples; `lib/perf-reel.json`); 257 → 52 hitches, 10.1 → 3.6 s main-thread CPU, frame p95 68 → 12.6 ms, project switch 544 → 170 ms; the four kept fixes and three dropped hypotheses; 170 ms against the 50 ms switch budget | "Benching the Reel", the perf log of 30 Oct 2026 (now the page /desktop/perf/): its xctrace exports and DeskBench A/B runs, 3a6b5b7 → 9bcd41a |
| The window today | a capture of the real window | `CapcomdDeskBench snapshot --fixture crew17 --at 0` on feat/desktop-shell 9bcd41a (generated data) |

Pictures:

- `public/desktop/real-window.jpg`, `real-tb.jpg`, `real-ask.jpg`: the real window, drawn by DeskBench from the
  `crew17` fixture and cropped. Its text is generated, and some of it repeats. Retake them when the app has a demo
  run.
- `public/desktop/mcc-consoles.jpg`: "Apollo Mission Control Consoles" by Mike Renlund, CC BY 2.0, from Wikimedia
  Commons and credited in the footer.
- The bots are the engine's own. Their seeds (`dk-*`) were picked so the names match the boards (Lumen, Nugget,
  Tinker, Volt, Mica, Loop, Radar).

Samples to confirm: the matchkey run at its finish, its agents' text, times and counts (adapted from Reel.png); the goal
branch `migrate-matchkey-v3.2`, the base `dev` and the pull request's size (9 files, +318 −41); "Fix proration" (ready,
its planner asks) and "addriva" (pull request open) as other projects; "Opus 5.5" in the composer; `my-app` / `dev` on the new
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
