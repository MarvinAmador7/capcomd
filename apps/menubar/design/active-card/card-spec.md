# Active card (direction B, "The ask leads")

The approved redesign of the panel's Active card. Boards: `Main.dc.html` (`Main.png`: the five states in dark,
the ask in light) and `Motion.dc.html` (`Motion.png`). Where this file and the boards disagree on a measurement,
the board wins; fix this file in the same change.

Code: state and wording in `app/Sources/CapcomdStore/ActiveCard.swift` (`activeCard(_:)`, `outcome(_:)`, tested in
`ActiveCardTests`), layout in `app/Sources/MenuBarApp/ActiveCardView.swift`, tokens in `Theme.Ask`. Mock scenes:
`SCENARIO=card-running | card-ask | card-stopped | card-finished | card-long | cards bun client/mock/scenarios.ts`.

## States

A card is one project. It speaks for one run: the run that is asking, failing or paused, else the newest active one.
Priority, highest first: **ask › failed › paused › working**. Every state except working unfolds the card.

| State | When | Headline | Line under it | Evidence | Bar |
|---|---|---|---|---|---|
| Working (folded) | nothing below applies | (none: the goal is the title) | crew heads, then the sentence | none | none |
| Ask | an approval waits for the run | hand mark, the question | the asker's head, "worker asked 18s ago · planner and reviewer wait on it" | the files with +/−, or the branch line from an older daemon | View diff · Deny · Approve ↩ |
| Failed | an agent of an active run failed | ✕ mark, "worker's checks failed" or "worker failed" | the agent's head, "worker · its checks didn't pass" / "· stopped with an error" | the failing lines (mono box) | Hide · Open thread |
| Paused | agents stopped at a provider's usage limit (`result.limit == "quota"`) | pause mark, "Paused at Claude's usage limit" | their heads, "planner and reviewer pick up again at 15:40" (or "when the limit resets") | none | "Nothing to do unless it's urgent" · Resume now |
| Outcome | the newest finished project (top of Recent) | crew heads, "Merged into main" (or Done, Failed, Stopped), duration | the goal | ✓ 2 files +24 −0 · checks passed · $0.41, or ✕ and the failing line | none (⌘1 opens it) |

An ask can't be put away. Hide folds a failure back to the sentence until another reason unfolds the card (the
reason is remembered: `ask:<approvalId>`, `failed:<agentId>`, `paused:<runId>:<agentIds>`). The chevron shows or
hides the agent tree (24 pt rows; approvals stay in the card body, not under the row).

## Copy

- Sentence: the running agent whose activity changed last (the deeper one on a tie): "worker d3ce is editing
  keys.ts". A progressive activity line ("Editing keys.ts") reads after "is"; any other follows a colon
  ("planner: Read 4 files"). Nobody running: "<agent> is paused", "<agent> is queued", "Starting".
- Names are the tree's: the profile, plus the sibling suffix (folder, short task id or last 4 of the id).
- A merge's question is worded by the app from structured fields: "Merge <asker>'s work into <target>?". Other
  kinds show the approval's own question (agent-written: plain text).
- Who waits: the asker's live ancestors, then agents still queued outside its subtree. "planner", "planner and
  reviewer", "planner, lead and 2 others"; "waits" for one, "wait" for more.
- Files: up to 4 rows, biggest change first (the daemon's order), then "and n more files". Binary files show a dash.
- Failure line: a failed check's excerpt (the lines of the check output that name the failure), else how the checks
  failed, else the agent's error. At most 3 lines.
- Outcome: "Merged into <target>" when an agent's merge landed and the run completed; cost only when API spend was
  billed; files only when the run changed some.
- Times: elapsed and duration as a clock ("4:12", "1:02:09"); "asked 18s ago" with `shortDuration`; "at 15:40" in
  the user's locale.

## Measurements (points; Theme.Ask)

| Part | Value |
|---|---|
| Card | 12 padding all round, 11 corners (Theme.cardRadius), fill white 6 % (black 4.5 % light); ask: 1 pt amber ring at 60 % |
| Top row | goal 13/600 −0.1 tracking folded, 12 regular secondary unfolded; elapsed 11.5 mono tertiary; 10 between |
| Sentence row | 8 below the top row, 20 tall, 8 between heads, sentence and chevron; who 12.5/500, rest 12.5 secondary |
| Crew heads | 18 tiles, 5 corners, white 10 % fill, overlap 4, cut apart by a 1.5 ring; asker: 1 amber ring outside; at most 5, then "+n" 11 tertiary 5 after |
| Chevron | 22 × 22, 9/600 glyph, tertiary; turns 180° when the tree shows |
| Headline | 9 below the top row; 15/600, −0.25 tracking, 2 line spacing, up to 3 lines; mark 13, 7 before |
| Who line | 5 below; 11.5; asker name 500 primary, the rest secondary; 6 between |
| Files | 10 below; 20 rows; path 11.5 mono; counts 11.5 tabular, right-aligned in 36 columns; 0.5 rule between rows |
| Failure box | 10 below; 7 corners, sunk fill, 7 × 9 padding, 11 mono on 3 spacing, 3 lines |
| Bar | docked to the card's foot (full bleed), 12 above, 10 × 12 inside, 8 between, sunk fill (black 20 %, 5 % light) |
| Buttons | 28 tall, 7 corners, 12 padding, 12.5/500; Approve: inverted fill (#F2F2F7 / #1D1D1F), 12.5/600, at least 112 wide, a 15 pt ↩ key (4 corners, 10.5/600, grey 22 %); Deny: 0.5 outline (20 %); text actions 12/500 secondary |
| Outcome | the card's padding; heads + head 13/600 on a 20 row; goal 6 below at 12 secondary; stats 4 below at 11.5 |
| Tree | 10 below the content, 24 rows |

Colours (dark / light): text #F2F2F7 / #1D1D1F; secondary label 68 % / #3C3C43 86 %; tertiary 57 % / 80 %; amber
#FFB020 / #C77700; red #FF6961 / #C00013; green #30D158 / #1A6B32. All text holds 4.5:1 on the card.

## Motion (Motion.dc.html)

| What | Curve, timing | Interrupted | Reduce Motion |
|---|---|---|---|
| Unfold (ask, failure, pause) | height `spring(0.35, 1.0)`; content opacity + blur 2 → 0, 180 ms `(0.23, 1, 0.32, 1)` | the spring retargets from where it is | no spring, no blur: one 150 ms ease-out |
| Fold after deciding | `spring(0.28, 1.0)` | a refused decision unfolds again | 150 ms ease-out |
| Sentence ticker | 150 ms ease-out + 1.5 blur; at most once per 1.5 s; held while the pointer is on the card | latest wins | crossfade |
| A head joins | in from 6 right + fade, 200 ms `(0.23, 1, 0.32, 1)`, 40 ms apart (at most 4 steps); siblings `spring(0.30, 1.0)` | retargets | fade only |
| Tree shown / hidden | rows `spring(0.30, 1.0)` | retargets | 150 ms ease-out |
| Keyboard (Return, Tab, the chevron by keyboard) | none | | |
| Elapsed | none (tabular digits) | | |
| Press | scale 0.97, 120 ms ease-out; a click on Approve / Deny gets one trackpad tick | | opacity 0.75 |

The panel window still snaps to the new height (SPEC §7); the card's content animates inside it.

## Keyboard and VoiceOver

- The card takes focus on a click or with Tab. While it asks and has focus, Return approves; Esc never denies.
  Approve, Deny, View diff, Hide, Open thread, Resume now and the chevron are buttons in the key-view loop.
- The card is one container: its label says the goal, how long it has run, and the state ("Approval needed:
  Merge worker's work into main?. planner and reviewer wait on it. 2 files, 24 lines added, 0 removed"). Approve,
  Deny and View diff are also actions on the card itself. Heads and the elapsed clock are hidden (the label says
  them in words).

## Data

- `approval.requested` / `snapshot.approvals`: a merge's `subject.files` (path, status, added, removed; at most
  20), `filesTotal`, `added`, `removed`, read by the daemon when the merge was parked; `requestedAt` on snapshots.
- `Agent.result`: `costUsd`, `limit` / `resetAt` (a usage limit), `error`, `verification.checks.{reason, excerpt}`,
  `merge.{target, state}`. The live `agent.paused` adds `until`.
- The outcome's files: `GET /v1/runs/{runId}/files`, read once per finished run.

## Not built (yet)

- **Retry worker**: the API has no way to retry a failed agent. The failure card offers Open thread (steer the
  agent or its parent there) and Hide.
- **Switch to Codex** on a usage limit: no API moves agents to another provider. The pause card offers Resume now
  (`POST /v1/runs/{runId}/resume` clears the recorded limit).
- Raised-hand pose and bot moods (direction C): not part of B; heads use today's avatars.
- Tests passed as a count ("6 tests pass"): checks report passed or failed, not counts. The outcome says "checks
  passed".
