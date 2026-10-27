---
title: capcomd menu bar — design spec
subtitle: Build handoff · SwiftUI MenuBarExtra + NSPanel · relay/apps/macos
date: 2026-10-24
---

# 1. Scope

A macOS menu bar app that shows capcomd runs ("projects") and lets you approve, steer, drill into runs and read agent threads. It renders data from `capcomd inspect <runId> --json --follow` and only acts through existing CLI verbs. All mockups are static 2x PNGs in `/workspace/capcomd-menubar/`; the HTML generators (`gen*.py`) are the source of truth for exact values.

**Shell.** `MenuBarExtra` (`.window` style) hosts the 380 pt panel. The panel is as tall as the screen it shows: the list, a run view or a thread sizes the window to its content (top edge pinned under the menu bar), between 200 pt and 640 pt and never taller than the screen's visible frame minus 48 pt; past that, the content scrolls. The approved panels measure 535.5–576 pt (list), 295.5–439.5 pt (run view) and 624.5 pt (thread). Thread "Open in window" and long readers use a detached `NSPanel` (620 pt wide, resizable, non-activating until focused).

# 2. Principles

- **HIG glass, variant A.** Dark vibrant material (`.popover`/`.hudWindow` style), 16 pt panel radius, hairline separators, grouping by space before borders.
- **One accent.** System blue `#0A84FF` marks the current/running thing, focus, primary buttons and send. Nothing else is blue.
- **Amber only for approvals.** `#FFB020` hand.raised; a card waiting for approval gets a faint amber tint (fill `.08`, 0.5 pt stroke `.35`). Never a solid tile.
- **Red only for failures/retries.** `#FF6961`.
- **No counts, no progress text.** No "3/7", no "42%", no status tallies. Allowed numbers: the approval badge on the menu bar icon (pending approvals), durations ("Done in 4m"), and the plain counts the approved designs use: a finished row's folders ("· 3 repos") and an activity line's targets ("Reading 4 files").
- **Finished steps show no status icon.** Status icons exist only for running, failed, queued and waiting.
- **Plain-language step text**, sentence case, past tense for done ("Read the ids/v1 schema"), progressive for now ("Writing parquet shards to R2").
- **No gradient text, no rainbow colors.** Icon tint is secondary grey unless state demands otherwise.
- **Profile, not role.** Agents are named by their capcomd profile, lowercase as capcomd sends it (`planner`, `lead`, `worker`, `critic`); the mockups' sentence case is superseded.

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
| Live activity | `Agent.activity {text, kind, at}` in snapshot.agents; live `agent.activity_changed` (ephemeral) on the lifecycle feed with `?activity=1` | the line under a running agent's row |
| Approval | `status.pendingApprovals[] {taskId, kind:"merge", targetBranch, since}` | mapped to the tree node whose `taskId` matches, then bubbled to ancestors |
| Activity / Log | events (`AGENT_SPAWNED, AGENT_STARTED, AGENT_DONE, AGENT_FAILED, KV_PUT, …`) | grouped into phases client-side |
| Trace | `trace` spans: `agent.run` (`agent.profile, agent.status, agent.cost_usd, agent.turns`), `agent.claude_code`/`agent.codex` (`stop_reason, error_kind`) | Trace view only |
| Child handoff card | `AGENT_DONE.event.result` = `ChildResult {summary, artifacts[{name,ref}], data?, truncated?}` | `artifacts` become chips |
| Thread text | adapter `AgentEvent {type, subtype?, tool?, text?}`; `text` truncated to 500 chars | see gap G3 |
| Steer | `capcomd send <agt\|parent> <text>` (op `send {to, body}`) | sent bubble appears optimistically, confirmed by event |
| Approve / deny | existing merge-approval CLI verb | button actions only |
| Agent display name | `profile`, lowercase as sent (`lead`); none → `agent` | siblings sharing a profile get a tertiary mono suffix: their folder when each has a distinct one, else the short task id (last 4 of `key`), else the last 4 of `agentId` |
| Agent folder | `Agent.workspace.label` (snapshot.agents, agent.spawned `data.workspace`) | the row's folder chip and the card's scope chips; shown verbatim |

**Gaps — proposals, not capcomd features:**

- **G1 Project grouping.** capcomd has runs, not projects; it has no repo/folder list per run. *Proposal:* project = one run; repo chips derived from task/worktree metadata if/when capcomd exposes it. Until then show `goal` only and omit chips.
- **G2 Skills registry.** Only `skills/capcomd-orchestration/SKILL.md` exists (frontmatter `name`, `description`), auto-appended via `appendSystemPrompt` for agents with `children.allowSpawn`. No list, per-profile field or attach flag. *Proposal:* `{name, description, source}` from SKILL.md frontmatter plus repo; `/` picker attaches to a send.
- **G3 Full transcripts.** Declined: no transcript changes. Threads use truncated `text` (500 chars), `tool` names and results. Thinking, tool args/results and diffs render only when present; otherwise the item collapses to its one-line summary. Long text shows "…" with "Open in terminal".

# 4. Screens and states

## 4.1 Main panel and project cards — `v5-a-final.png`, `tree-card-v3.png`

- Top: "Start a project…" field (`.in`: 36 pt, radius 9, white 7 %, `+` and placeholder at white 45/40 %, `⌘K` hint in a 0.5 pt outlined tag). The panel opens with nothing focused; ⌘K or a click focuses it (white 10 % fill, 0.5 pt white 18 % stroke, 3.5 pt blue 28 % ring). Return starts a run on the goal (`POST /v1/runs`, Idempotency-Key per goal, reused when retrying after a network failure); a daemon without a default repository gets one folder pick (remembered). Esc clears, then leaves the field. A quiet line under it says "Started…" or the daemon's refusal. Section label "Active".
- **Project card:** title (`goal`, 14 pt semibold), folder chips (the distinct folders its agents work in, up to 3 then `+n`; G1), a hairline, then each run's agent tree (§4.4). Runs are grouped by project id. Run ids never appear on the card. Running cards first, by most recent event.
- **Active means work in progress.** A run is active while the daemon says `running`, `paused` or `starting`, or any of its agents hasn't ended. A run that never spawned an agent (`new`) counts for its first 5 minutes. Lifecycle `completed`/`failed`/`cancelled` win; a snapshot `idle` run is judged by its agents (any failed → failed, any cancelled → stopped, else done). A card nests only its active runs: finished and failed runs leave it.
- **Finished projects** (no active run) leave the Active cards and collapse to one line under them, newest first, at most three (`.done`): title (13 pt, white 70 %, indented 8 pt past the cards' text, tail-truncated) and how its latest run ended, right-aligned (12 pt, white 40 %): "Done in 4m · 3 repos", "Failed after 12m", "Stopped after 30s". The duration runs from the run's creation to its terminal transition (else its agents' last change); the folder count is omitted when unknown. Click opens that run. With nothing active, "Nothing running" sits under the section label.
- No footer: the panel ends with its last card or Recent row.
- Menu bar icon: capcomd mark; amber dot + number when approvals are pending.
- **Cards are goals.** The daemon's `projectId` is a hash of the repository, so runs group by repository *and* goal: each goal started from the composer (or by the CLI, or another agent) is its own card, reruns of a goal share one, and a run whose goal hasn't arrived joins its repository's newest card.
- **Live, always.** Every feed reconnects from its cursor after a clean close, a 5xx or a transport error (backoff to 5 s), ending only on 401/404; up to 16 run feeds are followed, active runs first. While the daemon feed can't connect, a quiet line under the composer says "Can't reach capcomd. Reconnecting…" (a spinner, the hint colour, never red), and what's below is the last state the daemon sent. At launch the token is read off the main thread (macOS may be asking for Keychain access: the panel says "Waiting for Keychain access…"); `CAPCOMD_TOKEN` in the environment wins, for development.

## 4.2 Approval card — `v5-a-final.png`, `tree-card-v3.png`

- Lives inline under the waiting node (`.apx`, 2 pt right of its name column, 2 pt above / 8 pt below). An approval whose agent isn't in the tree sits under the run's tree.
- Order: **question first** ("Merge backfill into main?", 12 pt medium, white), then the branch/command line in 12 pt mono at 60 % (`fix/backfill → main`), then **Deny** (white 10 % fill) / **Approve** (`#0A84FF` fill) full-width pair: 27 pt high, radius 7, 12.5 pt medium, 8 pt apart. Fixed fills, so Approve stays blue when the app isn't active. Once decided the buttons give way to "Approved by …".
- No timer, no footer, no "since". Waiting node shows amber hand.raised in its status column.

## 4.3 Run drill-down — `view-activity.png`, `view-trace.png`, `activity-collapse.png`, `drill-collapsed.png`, `long-follow-iconsA.png`, `long-scrolled-iconsA.png`, `drill-a2-log-iconsA.png`, `drill-a2-files-iconsA.png`

- Header (`.hdr`): back chevron in a 24 pt circle (white 7 %; glass on macOS 26+), breadcrumb (project, 11.5 white 45 %), title (current step, 15 semibold; once the run has ended, how it ended: "Done in 7s", "Stopped after 32s", "Failed after 2m"), switch **Activity · Trace** (11.5 medium, selected white, other `rgba(235,235,245,.3)`; choice remembered globally; ⌘1/⌘2), elapsed mono timer (13, white 85 %; frozen once the run ended). Under it a step bar: one 3 pt segment per step, gap 3: done blue, current blue 45 %, upcoming white 12 %, failed red, waiting amber.
- **Activity** (default): 172 pt scroll region, rows 18 pt (icon · text · relative time "now"/"6m ago" in 10.5 mono), phase labels Plan/Build/Ship (10.5 pt semibold `rgba(235,235,245,.3)`). Current row white 500 + blue running icon; upcoming rows `.32` with the clock; failed red 80 % with ✕. Finished rows carry no status icon. An agent's row reads as its activity line (`Agent.activity`, "Read 4 files") with the activity kind's icon; before it reports one, its task's first line and its profile icon.
- **Collapsible strip:** chevron at the trailing edge of the region (up when expanded, down as the strip's last cell). Collapsed = one 30 pt row of 24 pt icon cells; phases separated by 1×12 pt dividers; current cell blue on a faint blue tile; approval amber hand.raised; finished muted; overflow scrolls horizontally, pinned to the current step, left edge fade. Hover → tooltip (step text + mono time). Click → expand and scroll to that row. State remembered per user.
- **Trace** (advanced, `GET /v1/runs/{runId}/trace`): span tree with timing lanes, folded phases (▸/▾), retry rows red. Only spans a person reads are kept, re-parented past dropped ones: model calls (`agent.claude_code`, `agent.codex`, `model.generate` → "model call"), `sandbox.ensure` ("sandbox up") / `waitReady`, `git.*` ("push fix/x"), `merge.*`, verify, `agent.run` (profile); actor RPCs and transitions are dropped. Spans are written when they end, so running and queued agents follow as rows of their own (ringed blue lane to now; dashed lane and "–" when queued). Rows 22 pt: icon · name (132) · lane (6 pt, white 28 %) · duration (mono 11). Lanes span the run's first start to now while anything runs. Long runs follow live; scrolling away shows a blue **"↓ Jump to now"** pill (bottom 6, 22 pt).
- Below: segmented **Log | Files** (150 pt, one at a time, remembered). **Log** tails the transcript of the agent the run is following (the one running now, else the last to change): mono 11 `HH:mm:ss` + first line, last line white 85 %, older lines fade out at the top of the 94 pt pane; refreshed every 2 s from its cursor, keeping 200 lines. **Files** (`GET /v1/runs/{runId}/files`): status glyph · path (mono, middle-truncated) · `+n` green · `−n` red; binary files say so; "No changes yet"; an older daemon gets "This capcomd doesn't report changed files yet".
- **Activity rows of an agent open its thread** (§4.5): once a run has ended its card is gone, and this is the way back to each agent's words. Pushed views are clear, so only the top one of the navigation stack is drawn (a run view under a thread, a thread under a child's), and only it sizes the panel. When several agents changed files, each **Files** row carries the changing agent's bot (xs; its name on hover).
- Footer (`.acts`, bar material under a hairline): **Pause** (Resume once paused; holds Resume while running agents are still stopping) · **Stop**, which asks once inline ("Stop run?" on a red tint for 4 s) because it can't be undone · **Open in terminal** (runs `capcomd tui <runId>` in Terminal). Controls call `POST /v1/runs/{runId}/{pause|resume|cancel}`; a refusal or an older daemon shows one red line above the footer.

## 4.4 Agent tree — `tree-card-v3.png`, `tree-detail-v2.png`, `tree-alt.png`

- Outline tree with hairline guides, 26 pt rows: chevron · profile icon · name · suffix · folder chip · status icon. Geometry: 16 pt per level, 12 pt chevron column, 16 pt icon with 2/6 margins. Guides (`.gd`, 0.5 pt white 18 %) are a line through each ancestor that has more children below, a tee into a row with later siblings and an elbow into a last child (arm 7 pt at y 13); they carry on beside a row's approval or activity line.
- Row text 12.5 pt: white 78 %; running white medium; pending `rgba(235,235,245,.42)`. Suffix mono 10.5 at `.32`, 6 pt after the name. Folder chip (`.rc`: folder glyph + 11 pt at `.5`) right-aligned before the status column, shown only when the run's agents work in more than one folder (otherwise the card's scope chip says it) and when it isn't already the suffix. Profile glyphs are sized per symbol so each lands on the 14 pt grid (planner 12, lead 11.5, worker 9, critic 10.5, other 11 pt).
- **Live activity:** a running agent shows one line under its row at the name column (`Agent.activity.text`, 11.5 pt, `rgba(235,235,245,.5)`, one line, tail-truncated), e.g. "Reading 4 files". A waiting agent shows its approval there instead; other states show nothing. The daemon's status sentence (`Agent.text`) is never shown.
- Names = profile, lowercase (`planner`, `lead`, `worker`, `critic`); duplicate siblings add a mono tertiary suffix (`d3ce`). VoiceOver: "worker d3ce, ids/v1, running, level 3".
- Approvals bubble up: a collapsed ancestor shows the amber hand when any descendant waits.
- Selecting a node opens the agent thread (§4.5). Lanes view (`tree-alt.png`) is not used in cards; timing lives in Trace.

## 4.5 Agent thread — `thread-panel-v2.png`, `thread-window.png`, `thread-states.png`

- Header: back, the bot (24 pt), the bot's name (15 semibold) over one quiet line "role · project" (11.5, white 45 %, tail-truncated), and the status mark at the trailing edge. The bot's name leads; there is no breadcrumb and no suffix. The thread softens into the header through a 14 pt fade instead of cutting off. (A **Thread · Trace** switch is not built.)
- Content: markdown prose 13 pt; headings 13 pt semibold; bullets; inline code; fenced code (mono 11.5, restrained highlighting); tables with hairlines; tool calls as one line (icon · summary · mono duration · chevron), expanding to mono Arguments/Result; thinking folded ("Thought for 8s"); diff card (path, green `+` / red `−`); user steers as right-aligned quiet bubbles; child **handoff card** (profile icon, name + suffix, "handed back", `summary`, artifact chips, › opens the child's thread).
- Bottom fade above the input. "Open in window" → 620 pt `NSPanel` reader with the same content and wider code/tables.
- Source: the daemon's thread items (`GET …/agents/{agentId}/thread`, format `blocks/1`; live `agent.thread_item_changed` with `?thread=1` on the run's lifecycle feed while a thread is open, re-read from the cursor every 15 s). Highest `rev` of an id wins, items sort by `order`; your steers interleave by time. A daemon without the route keeps the event-built lines. Decoding, merge and presentation live in the `CapcomdThread` target, tested against `packages/agent-thread/fixtures/golden`.
- Links act only on the daemon's `target`: web (http/https only) opens in the browser and always shows its host, or the full URL when `mismatch`; agent and run links navigate; file and artifact links are mono text; `none` is plain text. "Thought for Ns" uses the item's duration, else the gap to the next item. A handoff's trailing list of links becomes `.art` chips. A tool call with `tool.diff` (Claude Code edits; Codex reports paths only) is a `.df` card instead of a row: pencil · path · `+n −n`, its first lines (removed red, added green, `@` gaps as a faint hunk header), "n more lines"; a click on the header shows Arguments / Result; a failed edit is dimmed and says it didn't apply.
- Media: attachment and workspace images load through the daemon (png, jpeg, gif, webp, checked by magic bytes), never larger than their own size, at most 180 pt tall. Remote images are a chip until clicked (ephemeral session, 5 MB, raster only); video, audio and files stay chips. Unknown kinds and block types render their `text`.

## 4.6 Inputs — `input-idle.png`, `input-focused.png`, `input-mention.png`, `input-sent.png`, `input-steer.png`, `thread-input.png`, `skills-picker.png`, `input-with-skill.png`

| State | Look |
|---|---|
| Idle | thread input `.ib`: 10 pt radius, white 7 %, padding 7/6/6/8; `+` (22 pt) · 13 pt text, placeholder "Tell lead…" at white 38 % (lowercase profile) · 22 pt send circle at white 10 % |
| Focused | white 10 % fill, 0.5 pt white 18 % stroke, blue focus ring (3.5 pt, 28 % blue); grows to 6 lines then scrolls; hint row "↩ send   ⇧↩ newline" (10.5 pt, right), shortened to "↩ send" or hidden when the tool row is tight (the pills never truncate) |
| Has text | send = blue circle with arrow.up |
| `@` mention | popover above (`.mpop`), floating over the thread (opaque) rather than pushing it up: the agents under this one, filtered by what follows `@`; 28 pt rows bot · bot name · role and mono suffix · status (Running/Done/Failed/Queued); highlighted row blue; typing filters on the handle or the bot name. Picking puts an inline pill in the text where the caret is (18 pt capsule, white 12 %, 0.5 pt white 16 % stroke: the bot at 14 pt and its name, 13 pt medium), one unit for the caret and Delete; paste is plain text. The agent gets `@worker-4423` in its place and the sent text ends with "(@worker-4423 is agent agt-…)" so it can act on it (`SteerMentions`); your sent bubble hides that line and draws the pills again |
| `/` skills | popover "Skills" (`GET /v1/skills`): book icon · mono name (typed part blue) · source · one-line description; footer "↑↓ move · ↩ pick · esc close"; empty "No matching skills". Offered only when the daemon advertises `steer.skills` in `/v1/health` `capabilities`; picked skills ride on the steer as `skills: [name]` |
| Skill picked | removable chip above the text (20 pt, blue 16 %, `#8CC4FF` 11 pt mono, 14 pt × circle) |
| Streaming | while the agent runs: "••• lead is writing…" above (11 pt; three 3 pt blue dots at 90/55/30 %). "Esc to stop" and the white stop circle appear only when the daemon advertises `agent.pause` |
| Sent | field clears; the steer shows at once as a right-aligned bubble (`.me`: white 10 %, radius 13/13/4/13, 13 pt, max 76 % wide), dimmed while sending, replaced by the daemon's `message.sent` (matched by its seq). A failure keeps the bubble with the reason, Retry (same Idempotency-Key) and Discard |

`+` menu: Mention agent…, Add skill… (when skills can be attached). Add file… waits for a daemon route. Keyboard: Return sends (or picks when a list is open), ⇧Return newline, ↑↓ move in lists, Esc closes list → clears → blurs (→ stops streaming when empty), Backspace after a chip removes it.

# 4.9 Bots (brand direction B, `design/brand/`)

Every agent has a bot from the `CapcomdBot` engine (a Swift port of `packages/bot-avatar`, checked against its golden files): seed = the agent id, role = its profile. A run's bots are one `botTeam` in spawn order, so siblings differ and a newcomer never changes an earlier bot. Sizes: xs 14 pt (tree rows, mentions, Activity and Trace rows), small 24 pt (thread header, handoff card), full 64 pt (moments). Bots are content: always opaque, drawn at whole points per cell with no interpolation, never on glass, never outlined. They replace the profile SF Symbols wherever an agent is named; status keeps the status marks. Provider marks (owner's decision): each agent shows which AI it runs on (`Agent.provider`, else agent.spawned `agent.provider`/`agent.kind`; `model` as the tooltip) with the provider's own mark, unaltered and one colour: Claude's spark (simple-icons path, CC0) and OpenAI's mark for Codex (official file pending; a neutral glyph until then). Tree rows: 11 pt, white 45 %, just before the status column, which every row now reserves so chips and marks line up. Bots at 24 pt and up (thread header, handoff card, meet the team) carry it as a badge on the bottom-right corner (12 pt disc, 18 pt at 64 pt; surface fill, 0.5 pt hairline; Claude coral, Codex white): the one exception to nothing on the bots. The thread header's quiet line names it: "lead · Claude · project". Inside a thread the bot's name ("Bolt") leads and the role is context: the header (§4.5), a handoff card ("Bolt" then "worker · handed back"), the mention popover ("Bolt" then the role and suffix; typing either finds it, the inserted handle stays `@worker-4423`), and the composer (recipient chip, "Tell Bolt…", "Bolt is writing…"). The agent tree keeps roles, with the bot's name as the avatar's tooltip (also on Activity rows) and read by VoiceOver after the role.

Polish (approved on the canvas Polish board): tree guides are 1 pt dotted circuit traces with a 3×3 node where a branch splits; a running agent's bot has a still glow behind its visor (centred on the visor's own pixels, tinted by its eye colour); hovering a row blinks its bot once (a 120 ms sprite swap, never with Reduce Motion); the footer hairlines are a 1 pt orange ordered dither; there is no hairline between a card's chips and its tree; the agent waiting for approval waves (small and full sizes) in addition to the amber mark; the empty panel is headed by the pixel CAPCOMD wordmark drawn from the bot catalog's glyphs; a run that just finished gets one ✦ beside its row that fades out within 300 ms (opacity only, none under Reduce Motion).

Apple craft (canvas Craft and Materials boards): Liquid Glass on macOS 26+ for the control layer only (Start field, composer, back buttons, footer bars, Deny as regular glass, Approve as the one tinted glass), via `ControlSurface`; macOS 14–15 keep the flat fills and materials. Content (panel material, cards, tree, thread) never uses glass, nor do the bots. Corners are continuous. Status marks render hierarchically; the finish sparkle gets one system bounce. A mouse click on Approve or Deny plays one trackpad level-change haptic (never for the keyboard). Approval notifications carry the waiting agent's bot (small, 4× PNG) and Approve / Deny actions (Approve asks for authentication). Increase Contrast: cards get a 1 pt light border and the dithered hairline goes solid; the bots are unchanged (no outline). Reduce Transparency: the panel material becomes a solid surface and the macOS 14–15 control fills go solid; the system makes glass opaque.

Moments (`design/brand/moments.png`), seen live only and once per run: **Meet your team**, for a run's first 6 s after it starts while the app is watching. The card shows the planner at 64 pt waving, with its role and bot name, dotted orange traces to up to four children (32 pt, role and bot name), each fading in and rising 4 pt, 40 ms apart, 0.2 s each (Reduce Motion: one 150 ms crossfade), and the planner's status line; then the agent tree. **Run finished**, for 2.2 s after a live `run.completed`: the project stays up as a card with its title and duration, its team (orchestrators first, up to five at 64 pt) in the cheer pose with happy faces, party hats on non-orchestrators, static confetti laid out by mulberry32 seeded by the run id, and "✓ Finished · n repos"; then it drops to its finished row. Never on failure or cancel.

Composer and container v2 (canvas board, after the owner's reference): the panel is our own container, a 26 pt continuous rounded shape with its material and a 0.5 pt hairline, on a clear MenuBarExtra window whose own square backdrop is hidden. Both composers are a 20 pt card (glass on macOS 26+), with a chip row, large text and a tool row ending in a white round send (always white; with nothing to send its arrow is black 30 %). The panel is 380 pt wide, or wider when the project composer's tool row needs it (measured on a hidden copy; never past the screen): pills and chips never truncate. **Project composer:** a folder chip (the remembered checkout, × forgets it; "Default project" otherwise, click to choose) and the ⌘K keycap on top; in the tool row: +, a **Local | VM** switch (the reference's segmented group, icons only: laptop = Local, Docker on this Mac; cloud = VM, boxd; the name is the tooltip and the VoiceOver label; 36 pt segments, the picked one a raised capsule, white 12 % with a 0.5 pt white 18 % stroke; one the daemon can't use now dimmed to 40 % with its reason as the tooltip), then on the right by the send a driver chip (the provider mark, "Claude Code" or "Codex", a chevron: a menu with a check on the current one and the model after the name; unavailable drivers listed disabled with the daemon's reason). When the driver lists `efforts`, its reasoning effort shows on the chip as signal bars (`cellularbars`, variable value: the highest level fills all four, each level below one bar fewer, never fewer than one; 11 pt semibold, white 75 %) and the menu adds an Effort section (each level with its bars, a check on the current one; "Auto" first when the driver has no default `effort`, as Claude Code, which sends nothing and shows no bars; five levels share four bars, the top two full); level names are title-cased, `xhigh` as "Extra high"; the pick is remembered per driver and sent as `effort`. Both come from `GET /v1/run-options` (`runs.options` capability; hidden without it), are chosen per run, remembered as the last pick, and sent as `driver` and `sandbox` on `POST /v1/runs`; 17 pt "Describe a project for your agents…" (1–4 lines), + (Choose Project Folder…, Use the Default Project), send. **Thread composer:** the recipient as a chip with its bot, picked skills as blue chips, 15 pt text, then +, an "@ Mention / / Skill" pill group, the send hint while focused, and the white send (the stop square while the agent works). **Recent** replaces the finished rows: the planner's bot on a tile in its own palette, the goal, how it ended in words, ⌘1–⌘3 to open. The panel has no footer. There is no global summon key yet: MenuBarExtra can't be opened programmatically (a custom status item is needed).

The menu bar mark is the dome bot head without an antenna (16×16, 1-bit template image, tinted by macOS) with three faces: idle (sleepy eyes), working (eyes open, any agent running) and approval (a raised mitt, with the amber dot and count). No animation.

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
| paused | `pause.circle` | tertiary |
| stopped (cancelled: not a failure) | `stop.circle` | tertiary; grey step-bar segment |
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

**Sizes & spacing.** Vertical margins between siblings in the mockups collapse (CSS): the larger one applies, not their sum (the step bar's 4 and the Activity region's 14 leave 14). Panel 380 pt wide, 200–640 pt tall (follows content), radius 16; content inset 16 (project list 10); cards radius 11, padding 12 (bottom 6), gap 8, no border unless tinted; card hairline above the tree bleeds 4 past the content; tree row 26; activity row 18; Activity region 172 (collapsed strip 30, cells 24, dividers 1×12); input radius 10, send 22–24; thread window 620; code radius 8; chips radius 5–6. 4 pt grid throughout.

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
