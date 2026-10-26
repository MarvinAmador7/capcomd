---
title: capcomd menu bar — design spec
subtitle: Build handoff · SwiftUI MenuBarExtra + NSPanel · relay/apps/macos
date: 2026-10-24
---

# 1. Scope

A macOS menu bar app that shows capcomd runs ("projects") and lets you approve, steer, drill into runs and read agent threads. It renders data from `capcomd inspect <runId> --json --follow` and only acts through existing CLI verbs. All mockups are static 2x PNGs in `/workspace/capcomd-menubar/`; the HTML generators (`gen*.py`) are the source of truth for exact values.

**Shell.** `MenuBarExtra` (`.window` style) hosts the 380 pt panel. Thread "Open in window" and long readers use a detached `NSPanel` (620 pt wide, resizable, non-activating until focused).

# 2. Principles

- **HIG glass, variant A.** Dark vibrant material (`.popover`/`.hudWindow` style), 16 pt panel radius, hairline separators, grouping by space before borders.
- **One accent.** System blue `#0A84FF` marks the current/running thing, focus, primary buttons and send. Nothing else is blue.
- **Amber only for approvals.** `#FFB020` hand.raised; a card waiting for approval gets a faint amber tint (fill `.08`, 0.5 pt stroke `.35`). Never a solid tile.
- **Red only for failures/retries.** `#FF6961`.
- **No counts, no progress text.** No "3/7", no "42%", no status tallies. The approval badge on the menu bar icon is the one allowed number (pending approvals).
- **Finished steps show no status icon.** Status icons exist only for running, failed, queued and waiting.
- **Plain-language step text**, sentence case, past tense for done ("Read the ids/v1 schema"), progressive for now ("Writing parquet shards to R2").
- **No gradient text, no rainbow colors.** Icon tint is secondary grey unless state demands otherwise.
- **Profile, not role.** Agents are named by their capcomd profile.

# 3. Information model

Source: `capcomd inspect <runId> --json --follow` (see relay `docs/output-contract.md`). Lines:

| Line `type` | Fields used | Drives |
|---|---|---|
| `inspect.snapshot` | `runId, seq, status, tree, totals, trace, events` | initial state |
| `event` | `runId, seq, ts, epochMs, agentId, event{type,…}` | Activity, Log, thread items |
| `inspect.tree` | `seq, tree, totals` | agent tree (after each `AGENT_*`) |
| `inspect.end` | `end` | run finished, stop following |

Resume after reconnect with `--since-seq <last seq>`.

| UI concept | capcomd source | Notes |
|---|---|---|
| Project (title) | `status.goal` | the card title |
| Project state | `status.state`, `status.scope.state` | running / done / failed |
| Elapsed | `status.startedAtMs` | the drill-down `6:15` timer (mono) |
| Agent node | tree node `agentId, parent, profile, depth, status, children[], createdAt, startedAt, endedAt, taskId, spanId, stuck?` | `status ∈ pending\|running\|done\|failed\|cancelled` |
| Approval | `status.pendingApprovals[] {taskId, kind:"merge", targetBranch, since}` | mapped to the tree node whose `taskId` matches, then bubbled to ancestors |
| Activity / Log | events (`AGENT_SPAWNED, AGENT_STARTED, AGENT_DONE, AGENT_FAILED, KV_PUT, …`) | grouped into phases client-side |
| Trace | `trace` spans: `agent.run` (`agent.profile, agent.status, agent.cost_usd, agent.turns`), `agent.claude_code`/`agent.codex` (`stop_reason, error_kind`) | Trace view only |
| Child handoff card | `AGENT_DONE.event.result` = `ChildResult {summary, artifacts[{name,ref}], data?, truncated?}` | `artifacts` become chips |
| Thread text | adapter `AgentEvent {type, subtype?, tool?, text?}`; `text` truncated to 500 chars | see gap G3 |
| Steer | `capcomd send <agt\|parent> <text>` (op `send {to, body}`) | sent bubble appears optimistically, confirmed by event |
| Approve / deny | existing merge-approval CLI verb | button actions only |
| Agent display name | `profile`, sentence-cased (`lead` → Lead) | duplicates get a tertiary mono suffix: last 4 chars of `agentId` |

**Gaps — proposals, not capcomd features:**

- **G1 Project grouping.** capcomd has runs, not projects; it has no repo/folder list per run. *Proposal:* project = one run; repo chips derived from task/worktree metadata if/when capcomd exposes it. Until then show `goal` only and omit chips.
- **G2 Skills registry.** Only `skills/capcomd-orchestration/SKILL.md` exists (frontmatter `name`, `description`), auto-appended via `appendSystemPrompt` for agents with `children.allowSpawn`. No list, per-profile field or attach flag. *Proposal:* `{name, description, source}` from SKILL.md frontmatter plus repo; `/` picker attaches to a send.
- **G3 Full transcripts.** Declined: no transcript changes. Threads use truncated `text` (500 chars), `tool` names and results. Thinking, tool args/results and diffs render only when present; otherwise the item collapses to its one-line summary. Long text shows "…" with "Open in terminal".

# 4. Screens and states

## 4.1 Main panel and project cards — `v5-a-final.png`, `tree-card-v3.png`

- Top: "Start a project…" field with `⌘K` hint. Section label "Active".
- **Project card:** title (`goal`, 14 pt semibold), folder chips (the distinct folders its agents work in, up to 3 then `+n`; G1), a hairline, then each run's agent tree (§4.4). Runs are grouped by project id. Run ids never appear on the card. Running cards first, by most recent event.
- Finished projects collapse to one line: title + "Done in 4m" (tertiary, right). No counts.
- Footer: "Open capcomd" · "Summon ⌥Space".
- Menu bar icon: capcomd mark; amber dot + number when approvals are pending.

## 4.2 Approval card — `v5-a-final.png`, `tree-card-v3.png`

- Lives inline under the waiting node (`.apx`, indented to the name column).
- Order: **question first** ("Merge backfill into main?", 13 pt medium), then the branch/command line in mono (`fix/backfill → main`), then **Deny** (grey) / **Approve** (blue) full-width pair.
- No timer, no footer, no "since". Waiting node shows amber hand.raised in its status column.

## 4.3 Run drill-down — `view-activity.png`, `view-trace.png`, `activity-collapse.png`, `drill-collapsed.png`, `long-follow-iconsA.png`, `long-scrolled-iconsA.png`, `drill-a2-log-iconsA.png`, `drill-a2-files-iconsA.png`

- Header: back chevron, breadcrumb (project), title (current step), switch **Activity · Trace** (text only, selected white, other tertiary; choice remembered globally), elapsed mono timer.
- **Activity** (default): 172 pt scroll region, rows 18 pt (icon · text · relative time), phase labels Plan/Build/Ship (10.5 pt tertiary). Current row white + blue running icon; upcoming rows tertiary with queued icon; failed red.
- **Collapsible strip:** chevron at the trailing edge of the region (up when expanded, down as the strip's last cell). Collapsed = one 30 pt row of 24 pt icon cells; phases separated by 1×12 pt dividers; current cell blue on a faint blue tile; approval amber hand.raised; finished muted; overflow scrolls horizontally, pinned to the current step, left edge fade. Hover → tooltip (step text + mono time). Click → expand and scroll to that row. State remembered per user.
- **Trace** (advanced): span tree with timing lanes, folded phases, retry rows red. Long runs follow live; scrolling away shows a blue **"↓ Jump to now"** pill.
- Below: segmented **Log | Files** (log = mono timestamped lines; files = path + `+n −n`).
- Footer: Pause · Stop · Open in terminal.

## 4.4 Agent tree — `tree-card-v3.png`, `tree-detail-v2.png`, `tree-alt.png`

- Outline tree with hairline guides, 26 pt rows: chevron · profile icon · name · repo chip · status icon.
- Names = profile (Planner, Lead, Worker, Critic); duplicate siblings add a mono tertiary ID suffix (`d3ce`).
- Approvals bubble up: a collapsed ancestor shows the amber hand when any descendant waits.
- Selecting a node opens the agent thread (§4.5). Lanes view (`tree-alt.png`) is not used in cards; timing lives in Trace.

## 4.5 Agent thread — `thread-panel-v2.png`, `thread-window.png`, `thread-states.png`

- Header: back, breadcrumb "Project / Lead", profile icon + name + status, switch **Thread · Trace** (Thread replaces Activity at agent level: a collapsed tool row *is* an activity line).
- Content: markdown prose 13 pt; headings 13 pt semibold; bullets; inline code; fenced code (mono 11.5, restrained highlighting); tables with hairlines; tool calls as one line (icon · summary · mono duration · chevron), expanding to mono Arguments/Result; thinking folded ("Thought for 8s"); diff card (path, green `+` / red `−`); user steers as right-aligned quiet bubbles; child **handoff card** (profile icon, name + suffix, "handed back", `summary`, artifact chips, › opens the child's thread).
- Bottom fade above the input. "Open in window" → 620 pt `NSPanel` reader with the same content and wider code/tables.

## 4.6 Inputs — `input-idle.png`, `input-focused.png`, `input-mention.png`, `input-sent.png`, `input-steer.png`, `thread-input.png`, `skills-picker.png`, `input-with-skill.png`

| State | Look |
|---|---|
| Idle | 10 pt radius field, `+` left, placeholder "Tell Lead…", grey send circle |
| Focused | blue focus ring (3.5 pt, 28 % blue), grows to multi-line, hint row "↩ send · ⇧↩ newline" |
| Has text | send = blue circle with arrow.up |
| `@` mention | popover above: profile icon · name · suffix · status; highlighted row blue |
| `/` skills (G2) | popover "Skills": book icon · mono name · source · one-line description; footer "↑↓ move · ↩ pick · esc close"; empty "No matching skills" |
| Skill picked | removable blue chip (icon · name · ×) inline before the text |
| Streaming | send becomes white circle with black stop square; "Lead is writing…" + "Esc to stop" above |
| Sent | message appears as steer bubble / Activity row; field clears |

`+` menu: Add file…, Add skill…, Mention agent…. Keyboard: Return sends (or picks when a list is open), ⇧Return newline, ↑↓ move in lists, Esc closes list → clears → blurs (→ stops streaming when empty), Backspace after a chip removes it.

# 5. Icons — `icons-sheet.png`, `icons-in-trace.png`, `agent-icons.png`

Outline, 1.5 pt stroke, round caps, 14 pt grid; secondary grey by default, blue for current, red for errors. Use SF Symbols in the app.

| Step type | SF Symbol |
|---|---|
| plan | `list.bullet` |
| file read | `doc.text` |
| file write | `square.and.pencil` |
| tool call | `wrench` |
| shell | `apple.terminal` |
| sandbox | `shippingbox` |
| model call | `sparkles` |
| network | `globe` |
| git | `arrow.triangle.branch` |
| retry | `arrow.clockwise` |
| approval | `hand.raised` (amber) |

| Status | SF Symbol | Color |
|---|---|---|
| running | `smallcircle.filled.circle` | blue |
| failed | `xmark.circle` | red |
| queued | `clock` | tertiary |
| waiting (approval) | `hand.raised` | amber |
| done | — (none) | — |

| Profile | Pick | Alternate |
|---|---|---|
| planner | `point.3.connected.trianglepath.dotted` | `map` |
| lead | `flag` | `arrow.triangle.branch` |
| worker | `hammer` | `gearshape` |
| critic | `checkmark.seal` | `eye` |
| other (sup, cx, coder…) | `hexagon` (+ centre dot) | `circle.hexagongrid` |

Skill: `book.closed`. Add: `plus`. Send: `arrow.up`. Stop: `stop.fill`. Collapse: `chevron.up/down`.

# 6. Tokens

**Type.** SF Pro (mockups: Inter), SF Mono (mockups: JetBrains Mono) for numbers, times, IDs, paths, code.

| Role | Size / weight |
|---|---|
| Panel title / card title | 15 / semibold; 14 / semibold |
| Body, thread prose | 13 / regular, line 19 |
| Tree rows | 12.5 |
| Activity rows | 12 |
| Breadcrumb; scope chips | 11; 11.5 |
| Phase labels, captions | 10.5 / semibold, tertiary |
| Mono code / times | 11.5 code; 10.5 times |

**Color** (dark).

| Token | Value |
|---|---|
| accent | `#0A84FF` (tint `rgba(10,132,255,.16)`, focus ring `.28`) |
| amber | `#FFB020` |
| red | `#FF6961` |
| green (diff +) | `#30D158` |
| label primary | `#FFFFFF` / `.86–.92` for prose |
| secondary | `rgba(235,235,245,.60)` |
| tertiary | `rgba(235,235,245,.30–.38)` |
| card fill | `rgba(255,255,255,.06)`; field `.07`, focused `.10` |
| hairline | `rgba(255,255,255,.08–.14)`, 0.5 pt |

**Sizes & spacing.** Panel 380 pt wide, radius 16; content inset 16 (project list 10); cards radius 11, padding 12 (bottom 6), gap 8, no border unless tinted; card hairline above the tree bleeds 4 past the content; tree row 26; activity row 18; Activity region 172 (collapsed strip 30, cells 24, dividers 1×12); input radius 10, send 22–24; thread window 620; code radius 8; chips radius 5–6. 4 pt grid throughout.

# 7. Motion

UI motion animates **transform and opacity only**, eases out, and finishes **under 300 ms**. Layout changes (height, width) snap while the content crossfades. Pressed controls scale to **0.97**. Nothing animates when the action came from the keyboard. Respect **Reduce Motion** → 150 ms crossfade, no translation or scale (presses dim instead).

| Interaction | Motion |
|---|---|
| Panel open | fade + 4 pt drop, 0.2 s |
| Press (cards, rows, buttons) | scale 0.97, 0.12 s; Reduce Motion: dim to 75 % |
| Drill-down / thread push | slide 100 % horizontal, 0.25 s; back reverses |
| Activity ⇄ Trace, Log ⇄ Files | crossfade 0.15 s; height snaps |
| Timeline collapse | 0.25 s: rows fade out, icons slide into the strip (12 ms stagger, capped so the move ends under 300 ms); height snaps |
| Approval appears / card tint | fade + 4 pt rise 0.2 s; card tint crossfades 0.2 s; one gentle amber icon fade-in (no pulse loop) |
| Tool / thinking expand | content fades in 0.15 s, chevron rotates 90° in 0.15 s |
| Streaming text | per-block fade-in 0.12 s, no typewriter |
| Follow / Jump to now | scroll 0.25 s; pill fades 0.15 s |
| Steer send | text moves from field to bubble, 0.22 s |
| Open in window | content scales into the window, 0.25 s |
| Running icon | no spin; static ring |

# 8. Accessibility

- **VoiceOver:** every icon has a label from its plain-language step text + state ("Writing parquet shards to R2, running"). Tree rows: "Worker d3ce, ids/v1, running, level 3". Approval: "Merge backfill into main? fix/backfill to main. Approve, Deny". Strip cells announce the same as their rows.
- **Keyboard:** ⌥Space summons; Tab/arrows move through cards and rows; Return opens; ⌘[ back; ⌘1/⌘2 switch Activity/Trace (Thread/Trace); ⌘\\ collapses timeline; Esc closes popovers then panel.
- **Contrast:** primary and secondary text meet 4.5:1 on the glass; tertiary used only for non-essential labels. Increase Contrast → solid backgrounds, hairlines at 0.25. State is never color-only (icon shape differs per status).
- Dynamic Type: honor the macOS text-size setting where possible; layouts allow two-line titles.

# 9. Open questions

1. **Profile casing for unknown profiles** (`sup`, `cx`, `coder`): sentence-case (`Sup`, `Cx`) or show raw lowercase mono? And should known profiles map to friendly names at all, or come from `AgentSpec.description`?
2. **Skills in capcomd** (G2): will capcomd add a skills registry and a way to attach a skill to a send/spawn? If not, the `/` picker ships hidden.
3. **Project grouping** (G1): is a project one run, or several runs grouped by goal? Where do repo/folder chips come from?
4. Approve/deny verb and auth from a GUI process (subscription vs API key) — confirm the CLI command to call.
5. Thread fidelity with the 500-char `text` cap: acceptable for v1?

## Design fidelity

- `design/` holds the approved mockups (see `design/README.md` for the screen → mockup → Swift view index). UI changes must match the mockup in `design/`.
- PRs that touch the UI must include a side-by-side screenshot: mockup next to the running app, for each screen changed.
- If the design needs to change, update the mockup (generator + PNG) in the same PR first, then the app.
