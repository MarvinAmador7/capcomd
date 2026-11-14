---
title: capcomd desktop window: spec
subtitle: The capcomd app's window ("Reel"). One app with the menu bar item, sharing its session, transport and thread renderer.
date: 2026-10-30
---

# 0. Priorities

The owner's order: **performance, speed, design.** A change that makes the window slower is not done, however good it
looks. Every PR that touches this window says how it meets §1.

The boards in this folder are the visual source of truth (`*.dc.html`, rendered `*.png`; the canvas is
`canvas.json`). Where this file and a board disagree on a measurement, the board wins and this file is fixed in the
same PR. Behaviour conflicts go to the owner.

# 1. Performance and speed budgets

| What | Budget | How |
|---|---|---|
| Open the window | first frame ≤ 100 ms after launch | Nothing is fetched to show the window: it opens on Home, and the store fills it (the Running cards, the model menu) as frames arrive. Data that isn't there yet shows as an empty column, never a spinner over the window. |
| Switch project (click or ⌘1–9) | first frame ≤ 50 ms | The decks are already in memory; the reel shows headers at once, thread pages fill in. Keyboard switches don't animate. |
| Reel scroll | no dropped frames at 120 Hz with 17 agents | The reel is an AppKit scroll view with one hosting view per column, so a scroll frame moves a layer and runs no SwiftUI (in a SwiftUI ScrollView every frame dirtied all 16 columns' views). Columns stay built while the run is open (a lazy stack rebuilt every column it scrolled past). Threads are built ahead of time, nearest first while the reel stands still, at most 32 kept. A swipe lands on the column edge nearest where its momentum would stop, at most a screen away; the leading column is reported once per column crossed. A jump of more than a screen cuts to one column short and slides the last. |
| Open the Needs you reel | first frame ≤ 50 ms with 20 asks | Its columns are the reel's own (`ReelView`, one hosting view per column); the first frame builds the leading column alone and the rest follow one a frame, nearest first; every column opens with its head and ask bar and its thread warms after, one a frame. The list is the store's (`needsAsks()`), sorted once on open. Not met yet on a loaded machine (see the PR's numbers). |
| Answer an ask in it | the column out in ≤ 300 ms, no dropped frame | The leaving column fades and the rest close up in the render server (transform and opacity on layers; nothing re-laid out per frame). |
| A thread item arrives | re-renders its own column only | Keyed change notifications (§6), not the menu bar's global `revision`. The sidebar reads no thread: a thread item recomputes its run's rows, finds them equal and assigns nothing (`sidebar-burst`). |
| Fold or open the sidebar | first frame ≤ 50 ms; the reel is never reflowed | Opened, the sidebar and the pane are drawn over the reel, which keeps its size and its columns; the pane is laid out once, at its final frame, and only the sidebar's transform and the pane's opacity move (`sidebar-toggle`). |
| Switch agent from the sidebar (click, Return, ⌘J) | first frame ≤ 50 ms | The pane is one AppKit column (the reel's `NativeColumnView`, pane style) reconfigured with the agent; another project opens as a project switch does (`sidebar-select`). |
| Sidebar scroll | no dropped frames; no pane work | Its own scroll view of fixed-height lines (28 pt rows and headings, 24 pt labels), Equatable per line (`sidebar-scroll`). |
| Typing in a composer | no work outside the composer | The draft is local `@State`; nothing in the store changes until Send. |
| Network | one stream per open run, whatever the column count | The run stream with `?thread=1` already carries every agent's thread items; no per-column connections (AsyncHTTPClient caps at 8). |
| Memory | one 100-item page per column until you scroll up | Older items load on demand, as the menu bar's thread does. |
| Bots | drawn once per agent and size | `BotImages` cache (CapcomdBot); never re-rendered on state changes. |
| Split or close a pane (⌘D, ⇧⌘D, ⌘W) | first frame ≤ 50 ms | Each pane is the reel's AppKit column (`NativeColumnView`, pane style) laid out by frame in `PaneDeckView`; a split adds one column view (a closed one is kept for the next), the others are only re-framed; the new pane opens on its thread's foot (`split-open`). |
| Move the focus between panes (⌃← ⌃→, a click) | first frame ≤ 50 ms; no thread renders | Focus, "one of several" and "expanded" are a small observable per pane (`PaneState`): a focus change re-renders the two headers and strokes it touches (`split-focus`). A thread item re-renders its own pane only (`split-burst`). |
| Expand or collapse a pane (⇧⌘↩, Esc) | first frame ≤ 50 ms; no thread rebuilt | The expanded pane is the same view re-framed to the window, the others hidden, the sidebar hidden; laid out once at the final frames, and each pane keeps its thread's distance from the foot across any resize (`pane-expand`, `expand-switch`). Not met yet on a loaded machine: re-laying a long thread at the new width costs about as much as building it (see the PR's numbers). |
| Search ⌘K | open: first frame ≤ 50 ms; a keystroke's results within a frame (16.7 ms) with 250+ items | Titles only, folded once per source change; a keystroke compares integer arrays and narrows from the last query; at most 24 rows a group in a lazy list. Bench: `palette-open`, `palette-type`, `palette-keys` on the `search` fixture. |
| Markdown | no parsing on the main thread | The daemon's `blocks/1` tree is already parsed; views only lay it out. |

Measure with Instruments (SwiftUI + Animation Hitches) on a 17-agent fake-host run (live-app-testing recipe) before a
PR is called done, and put the numbers in the PR. The bench (`apps/menubar/app/DESKBENCH.md`) has a scenario per row.

# 2. Structure

One window, folded (the default) or opened (§2.1). Folded, it has three parts: the rail, the title bar and the reel.

- **Rail** (C folded: `leftnav/NavC`, `rex/RexStates` "Folded"; 60 pt wide, under the title bar): the **Needs you** hand
  (SF `hand.raised`; the normal icon colour with an amber count badge while anything needs you, grey with none at
  zero; a click opens the Needs you reel, §2.1), **Home** (the prototype's house; pressed while Home shows; ⌘0), **Crew**
  and **History** (no screens yet: shown, disabled), and **Settings** at its foot (the app's Settings window). 34 pt
  buttons, 9 pt corners, 6 pt apart.
- **Title bar** (52 pt: the unified toolbar's height, so the traffic lights centre on it; full-size content): traffic lights, then the **sidebar button**
  (SF `sidebar.left`, 30 pt, at x 84 pt: where the opened sidebar has it too, so it never moves; ⌃⌘S), then the **projects**, then on the right **Follow**, **Actions ⌘K**, **+**. Boards:
  `ReelStack`, `ReelTabs`, `Home`, `rex/RexStates`. (Home moved to the rail.)
  - The **open project** is one group: Local/Cloud glyph (`laptopcomputer` / `cloud`), name (no clock or
    status line), then its crew tabs in tree order, with a bracket around the tabs whose columns are on screen. A tab
    is the agent's bot and its title (`Agent.title`, capability `agents.title`; 1–4 lowercase words the agent, its
    parent or the user gave it, else the daemon's from its task), cut with "…" at 150 pt so the strip doesn't move
    as titles change. An older daemon's tab shows the sibling suffix, else the profile. Double-click renames it in
    place: Return saves, Esc or a click elsewhere cancels, an empty name clears yours (the agent's shows again); the
    user's name sticks over the agent's later renames. While a rename field is open, Return never approves.
  - Every **other project** is a deck: glyph, name (no clock or status line), then its crew's heads stacked (overlap 15 pt).
    A folded project that asks has an amber ring and says who asks.
  - Too many to fit: decks drop their names, then the rest go into a "+n" deck (its menu lists them). An asking
    project is never in the overflow.
  - The open project's name (with a chevron) opens the project menu (`ReelMenu`; 360 pt, #232326, 13 pt corners, 30 pt
    rows), dropped under its group over a dimmed reel: the whole goal, its repos as chips, and its place ("Cloud ·
    boxd · 6 agents · started 21:30"); then Message the planner… (⌘L: the planner's column comes on screen and its
    message box takes the focus; while the run is active), Changes +A −R · N files (the goal branch against its base on
    GitHub, with the goal view's counts; hidden for a run without a goal branch on GitHub, since the desktop has no
    diff view yet); Pause project / Resume project (⌥⌘P) and Stop project… (red; asks first, it cancels every agent),
    both with `run.controls` on a run that hasn't ended; Fold into the title bar (⌘W: back into its deck, it keeps
    running, and no project is open until one is picked), or for a finished project Remove from the title bar (hidden,
    also after a relaunch, until it has news: a new run, an ask, work again); Copy run ID (shows the short id, copies the whole). Only actions
    the daemon and the app have: Trace and Browse the workspace are hidden until the desktop has views for them, and
    rename, duplicate, archive and export are out on purpose.
  - **Search ⌘K** (`rex/CommandK.dc.html`; the owner's "Search ⌘K" in RexNotes): one palette for what needs you, the
    agents, the projects and the commands, ranked in that order, over what the app already holds (no network search).
    Native, as Spotlight in macOS 26: the system's vibrancy (NSVisualEffectView) under a tint that keeps the board's
    ground (#262628 measured), 18 pt corners, the board's shadow (0 24 70 .55, 0 4 14 .3) and hairlines; 640 pt wide
    (the window less 16 pt each side when narrower), centred, 92 pt from the window's top, over the reel's dim. It is
    drawn inside the window (knob `search.host=overlay`, the default), not in a panel of its own: a key NSPanel
    (`search.host=panel`, kept as a knob) makes the window resign key on every ⌘K and Esc, and every column then
    re-resolves its key-state styling: 282 ms of main thread a step in a Time Profiler run with 40 columns, and slower
    than the overlay in every interleaved pair (245–456 ms against 82–220 ms on a busy Mac). Inside the window a local
    key monitor takes ↑ ↓ ↩ ⌘↩ Esc before anything else, and a character typed before the field has the keyboard
    goes to the field. A 56 pt query row: the magnifying glass, then
    a 22 pt field with no box ("Search…"). Groups under 11 pt semibold sentence-case headers (28 pt, text at the
    bottom): Needs you, Agents, Projects, Commands. 32 pt rows, 8 pt corners, one 20 pt icon column (an agent's bot, a
    project's place, a command's symbol), the title (what matched in semibold; it keeps up to 68 % of the row) then the
    subtitle (the project and profile, or the place and crew; it truncates first), then the status word, the ask in
    amber with the hand, or the shortcut as plain glyphs. The selection is the system accent, darkened only as far as
    white (and 88 % white) text needs for 4.5:1, full width; the selected agent or project shows "↩ Open ⌘↩ Open in
    split". Stop… is system red. One quiet 32 pt legend: "↑↓ to move · ↩ to open · ⌘↩ to open in a split · esc to
    close". The list is at most 480 pt and scrolls; at most 24 rows a group once something is typed.
    - Matching: every word typed must match the title or the subtitle (titles count double): the whole title starting
      with it, then a word starting with it, then anywhere, then its letters in order from a word start (fuzzy);
      case and diacritics fold. Only titles and names are indexed, once per change of a source (one run's agents on
      `.run(id)`, everything on an unnarrowed change; nothing while the palette is closed but marking what's stale),
      and a longer query looks only at the shorter one's matches.
    - Needs you: each pending approval on the agent whose column shows it ("asks"), then each agent stopped by a usage
      limit ("usage limit"); an agent that needs you isn't repeated under Agents. Agents: every shown project's, by
      their own titles. Projects: the decks. Commands: only what the daemon and the app do now, each with its shortcut,
      named with the open project ("Pause migrate matchkey" ⌥⌘P, "Message the planner of …" ⌘L, Changes with its
      counts, Stop… in red, Fold / Remove ⌘W, Copy the run ID), Approve the focused ask (↩), New project (⇧⌘N), Home
      (⌘0), Follow (⇧⌘F), Settings (⌘,); opened: Split right (⌘D), Split down (⇧⌘D), Close this split (⌘W, with two or
      more), Expand the pane (⇧⌘↩) or, expanded, Collapse the pane (esc), and Show / Fold the sidebar (⌃⌘S).
    - Before anything is typed: Needs you, then Recent (what you looked at before, newest first, topped up with other
      projects; three), then the common commands (six).
    - ↑ ↓ (⌃P ⌃N) move; ↩ opens (an agent: its project opens at its column; a project: at its ask); ⌘↩ opens in a
      split beside the focused pane (§2.1 Splits; folded, it opens as ↩ does; `DeskModel.openInSplit`); Esc, a click outside or the window
      losing the keyboard closes. ⌘K works wherever the window is: Home, a project, any later sidebar or reel.
- **Reel**: the open project's agents as full-height columns in tree order (`Reel`). Three columns at 1440 pt, two at
  1100, one under 760; the neighbours peek 44 pt at both edges. A column is header (bot, then "profile · title · state"
  (a double-click on the title renames it, as the tab does; the bot's name isn't repeated), place, elapsed) · thread (the menu bar's thread renderer) · its own message box. An agent that asks docks the
  decision at its column's foot (View diff · Deny · Approve ↩) instead of the box.
- **Swarms** (`ReelSwarm`): leads' subtrees fold into stacks in the title bar; only the subtree on screen is fanned
  out. An asking agent always steps out of its stack. A strip at the foot shows one cell per agent, grouped by lead.
- **Home** (`Home.dc.html`, the owner's approved clickable prototype; it replaced the new project column).
  It shows when the window opens with no project focused, whenever no project is open (the last one folded or
  removed), from the title bar's Home (⌘0), and from + (⇧⌘N), which means "Home, with the composer focused". While it
  shows, Home stays pressed and every project is a deck; the reel stays built underneath, so leaving Home (Home again,
  ⌘W, Esc with nothing typed, or any deck, card, ⌘1–9) shows the project at once, and a goal that didn't start is kept
  for next time. With no project open, Home is the window's screen: Home, ⌘W and Esc leave it up. Home opens with
  nothing focused (no blue ring): Home itself holds the keyboard, and a character typed there starts the goal and
  hands the goal field the keyboard (caret at the end); + / ⇧⌘N and a click on the composer focus the goal.
  - Centred, 680 pt wide, 96 pt from the top: the mark (the onboarding bot's head, rows 0–11 of its 16 × 16 sprite,
    in greys, 6 pt cells, 84 × 72 pt, a 1-pixel checker dither, 42 % opacity), "What are we building?" (SF Pro
    Display 30 pt semibold, tracking −0.022 em), and under it, tertiary 14 pt, "Describe it once. The planner splits
    it up and brings in a crew."
  - The composer (#1B1B1F, 16 pt corners, a .5 pt ring, a soft drop shadow, the blue 3 pt ring while the goal has the
    keyboard): the folder chip (the remembered project checkout, × back to the default project; Default project
    chooses a folder), then with `runs.goal_branch` and a project folder the base menu beside it (the repository's
    branches, the daemon's `suggestedBase` preselected; never a guessed main: with no suggestion nothing is picked,
    Start waits and "Pick the branch this work starts from" shows), and on a line of its own under them the goal
    branch's name (the daemon's suggestion for the goal until edited), with the daemon's sentences under it. Older
    daemons: no branch row. Then the goal (15 pt), then one tool row: + (Choose Project Folder…, Use the Default
    Project), Local / Cloud, the **model** button (the model's name and the effort as three bars), the mic (macOS
    dictation into the goal until the app has voice input), Start (white, 30 pt; 30 % while there's nothing to start).
    Return starts.
  - The model menu (260 pt, #1F1F23, 10 pt corners, 28 pt rows): "Claude Code" and its models, "Codex" and its, each
    with its note (`GET /v1/run-options` `drivers[].models`, capability `runs.options.models`; an older daemon lists
    each driver once, on its profile's model), a check on the one new runs get, then Effort as a segmented control
    (Auto for a driver without a fixed default, then the driver's levels). A harness that can't run where the run would
    go stays listed, its models dimmed, with the daemon's reason under its name (the #110 rule: always a menu). ↑ ↓
    move, Return picks, ← → change the effort, Esc or a click outside closes it. The pick is remembered per driver and
    goes with Start as `model`.
  - A folder that isn't set up swaps the tool row for the menu bar's inline setup (the same views, on
    `ProjectSetupFlow`); Esc cancels it, Return presses Set Up (and Start).
  - Start is the menu bar's start (`POST /v1/runs` with the store's run choice: project, driver, model, place, effort,
    base and goal branch). Started, the composer waits; once the feed lists the run with its planner, its project opens
    in the reel on the planner's column. A refused start keeps Home and shows the daemon's sentence under the field it
    names (the base, the goal branch, else the goal).
  - **Running** (56 pt under the composer; absent with nothing running): "Running" and the count, then one 48 pt card
    per project with an active run, in the store's live order (the menu bar's): the Local or Cloud icon, the title in
    semibold, " · " and a few words on what the crew is doing (the menu bar's direction-B sentence without who, cut at
    its first clause and after six words: never other words), the crew's heads stacked (the catalog bots, as on the
    decks) and the elapsed time (mono, tertiary). A card that asks has the 1 pt amber ring and a second line: the
    question (the menu bar card's words), the files with their +/− ("3 files, +73 −5", else the branch line), Deny and
    Approve ↩ (the approval card's path; Return approves while the card has focus, Esc never denies). A click (or Space,
    or Return on one that doesn't ask) opens the project in the reel. The cards follow `.run` changes only while Home
    shows (`HomeSlice`).
- **Needs you reel** (`rex/RexNeedsReel.dc.html`; RexStates' "Needs you reel"; RexNotes' "The Needs you hand"). One
  place to answer every agent that waits on you, across all projects. The Needs you hand (SF `hand.raised`; the amber
  count beside it while anything asks, grey with no count at zero; on the rail while folded, in the sidebar's header
  while opened) and the sidebar's "Needs you" heading open it, and View › Needs You. It takes the main area (opened:
  the pane's place; a row then opens just that agent and the reel closes) (the project reel stays built, hidden, underneath; Home, if it showed, goes and comes back on Back).
  - One column per asking agent, oldest first (when it asked, then the daemon's order): every undecided approval's
    waiting agent (a merge's asker; its oldest approval), and one per run a usage limit paused (its first paused agent).
    The columns are the approved Reel's (header, thread, ask bar at the foot) with two differences: no amber ring
    (every column asks; the warm ask bar carries it) and a context line under the header, tertiary 11.5 pt, the place
    icon and "project · profile". The ask bar is the decision bar (a merge also says "3 files, +73 −5"; a question is
    its text with Deny and Approve ↩, since the daemon's approvals carry no choices), or for a usage limit "Usage limit
    reached. It resumes at 21:40.", "Claude Code · 2 agents are paused" and Resume now ↩ (`POST …/resume`, the menu
    bar card's Resume now). A failed agent has no daemon decision to make, so it is not an ask here.
  - Above the columns a 36 pt strip, then 4 pt: "Needs you" (13 pt semibold, amber), " · 3" (secondary), "oldest first"
    (12 pt tertiary, 12 pt after), and at the right Back (13 pt medium, secondary) and "esc" (12 pt tertiary). Aligned
    with the columns (the reel's peek and gap in from each side).
  - Answering slides its column out: it fades and lifts 6 pt (0.18 s, ease-out) while the columns after it close up by
    one pitch (0.24 s, the reel's curve, no bounce), together under 300 ms, transform and opacity only. The next column
    takes its place and its focus, so Return answers it next. Answered from the keyboard (Return), nothing slides: the
    reel is laid out anew. Reduce Motion: the column fades out in 0.15 s and the rest stand in their places at once.
  - A new ask joins at the end, never under the pointer, and the leading column keeps its place (an ask answered
    elsewhere before it doesn't move it either).
  - With none left: the strip says "Needs you · 0" (secondary, then tertiary, no amber) and the area is one empty
    column (#151518, 11 pt corners, .5 pt ring) with "Nothing needs you." (13 pt tertiary) and, 12 pt under it,
    "Back to fix email join" (an outlined 30 pt button, 13 pt medium, 7 pt corners) and "esc".
  - Esc (or Back) leaves at any time, back to what the window showed (the agent and project, or Home), unless the
    palette, the menu, a rename field or the Stop question takes Esc. Opening a project (a deck, ⌘1–9), a crew tab or
    Home leaves it for that. ⌃←/⌃→ and ⌃1–9 move among its columns; Return answers the focused column only; Esc never
    denies.
  - Each run with a column follows its live thread items while the reel is open (`thread=1`, one stream per run). A
    column of the open project shares its agent's slice; the others have their own, refreshed by the store's keyed
    changes (an unnarrowed change re-reads the list; `.agent(id)` and `.thread(id)` touch only their column).
  - Not built yet: View diff (no diff view), a question's choices, an error's decision, Not now and Stop project… on a
    usage limit, and the Rex pane chrome (44 pt headers, 30 pt ask-bar buttons): the reel uses the approved Reel's
    columns and decision bar as they are.

## 2.1 Opened: the Rex-style sidebar

Boards: `rex/RexMain` (the window), `rex/RexStates` (every state), `rex/AttentionIcon` (the hand), `rex/RexNotes` (the
decisions; its open choices took the proposed options). ⌃⌘S (⌘\ too), the sidebar button or View › Toggle Sidebar
opens and folds it; the state is kept across launches. Opened, the title bar goes (its decks and crew tabs with it):
the window is the sidebar and one agent's pane, on the reel's dark ground (#0E0E10 window, #151518 pane).

- **Sidebar** (248 pt, 8 pt sides): the header (52 pt): the traffic lights' room, the sidebar button (pressed), then
  the **Needs you** hand (normal colour with the amber count beside it, 12 pt bold; grey and no count at zero; opens the
  Needs you reel), **Search** (magnifying glass: the ⌘K palette) and **+** (Home with the composer focused). 28 pt
  buttons, 7 pt corners.
- **Sections by attention**: **Needs you** (amber, its count; pinned above the scroll so an ask never scrolls out of
  sight; at zero a grey heading and "Nothing needs you."), **Running** (a count), **Finished** (muted, a count, folded
  until opened). Headings 28 pt, 12 pt semibold, 16 pt above. Counts are agents.
  - **Needs you** lists the Needs you reel's asks (`needsAsks()`): each agent an approval waits on (merges wait on the
    agent merging them) and, per run a usage limit paused, its first paused agent: the decisions, never as a badge on a
    row. A failure has no daemon decision, so it keeps its place in the tree with its red word (RexStates drew it in
    Needs you; the Needs you reel's rule wins so the hand's count and the section agree). The rest stay in tree order
    under their project in Running (an active run) or Finished.
  - A **project** is a quiet label (24 pt, 11.5 pt semibold, tertiary) with its place icon (`laptopcomputer` This Mac,
    `cloud` boxd; a run that names no place shows the daemon's default place, and none when the daemon names none), once
    per section it appears in.
  - An **agent** is one 28 pt line (8 pt corners, indented 14 pt per tree level, at most two): its catalog head (14 pt
    in an 18 pt box) with the provider's mark on a 10 pt badge at its corner, its own title (13 pt; an older daemon's
    tab label), and a word at the end only when it matters: asks / question / usage limit (amber), failed (red),
    queued / paused (dim, the head at 55 %), done / stopped / handed back (grey). Running says nothing.
  - Selected (the pane's agent): the pill (white 10 %); hover: white 5 % and •••. ••• is a native menu of what the
    daemon does for one agent: Message <title>… (focuses the pane's message box), Pause or Resume (`agent.pause`), Copy
    Agent ID. No Stop (the daemon refuses to stop one agent), no Changes or Trace (no views yet). Approve and Deny stay
    in the pane. A double-click on a row opens its title for renaming in the pane's header.
  - Once the list outgrows the window, projects you aren't looking at fold to one 28 pt line (chevron, place, name, up
    to three heads); the selected one and anything in Needs you never fold; a click (or → / Return) unfolds one and it
    stays unfolded.
  - The footer (40 pt): Home on the left; History (disabled: no screen yet) and Settings on the right.
- **Pane** (8 pt from the window's top, right and bottom; 11 pt corners; .5 pt white 9 % ring, the 1 pt amber ring
  while it asks): the reel's AppKit column in its pane style. Its 44 pt header: the head (24 pt), the title (13 pt
  semibold; a double-click renames it), the profile (lowercase), the short ID (the last 4 of the agent's id, mono 11.5
  pt), "· status" (amber "waiting on you"), then on the right "project · This Mac|boxd · elapsed" (mono 11.5 pt), then
  the pane's controls (26 pt, 7 pt corners, #7D7D85, the hover wash): split right (⌘D, SF `rectangle.split.2x1`),
  split down (⇧⌘D, `rectangle.split.1x2`), ••• (the row's menu) and expand (⇧⌘↩, arrows-out). Under it the thread
  (the reel's renderer, a 720 pt reading column, 24 pt sides) and the message box, or the ask bar (the reel's decision)
  while it waits on you. Home (+, ⌘0) shows in the pane's place.
- **Splits** (`rex/RexSplit`, RexStates "Splits"): the reel's columns come back as panes beside the sidebar. ⌘D (View ›
  Split Right) adds a pane right of the focused pane's column, ⇧⌘D (Split Down) one under it; the new pane shows the
  next agent in tree order that no pane shows, and takes the focus. ⌘-click on a row, or ⌘↩ on an agent (a project:
  its asking agent, else its planner) in Search ⌘K, opens that agent beside the focused pane (`openInSplit`; already in
  a pane: that pane takes the focus; another project's opens that project). Columns share the width and a column's
  panes its height, 8 pt apart; a split that would make a pane narrower than 340 pt (three across at 1440 pt with the
  sidebar, two at 1100) or shorter than 220 pt isn't made (the system beep; ⌘↩ and ⌘-click then try under it). The
  focused pane has the blue 1 pt focus ring (amber while it asks) and the split buttons; another pane's controls are
  × (close this split) and expand, and its right side is the elapsed time alone; a split's thread has 18 pt sides. A
  click in a pane, ⌃← / ⌃→ (reading order) or a row of an agent a pane shows focuses that pane; a row of another agent
  shows in the focused pane. The sidebar tints the rows the other panes show (white 4.5 %, `.row.vis`). ⌘W or × closes
  a split and its neighbour (the pane before it) takes the focus; with one pane left ⌘W folds the project, as approved.
  Each project keeps its own splits (while its run is the same) for as long as the app runs. Folded, nothing changes.
- **Expand** (`rex/RexExpanded`; RexNotes "Expand a pane (owner)"): arrows-out or ⇧⌘↩ gives the focused pane the whole
  window: the sidebar hides, the header is 52 pt in the title bar's band (the head 84 pt in, clear of the traffic
  lights), its right side "project · place · elapsed", the Needs you hand and arrows-in (pressed); the thread is a
  centred 800 pt reading column with code, tables, diffs and tool results 1060 pt (12 pt top, 32 pt sides, 20 pt foot);
  the ask bar is 800 pt, #1D1B17, 12 pt corners, the 1 pt amber ring, 20 pt above the foot (the pane itself has no
  ring), and the message box is 800 pt too. Esc or arrows-in (or ⌃⌘S) brings back exactly the panes it came from; each
  pane's thread keeps its distance from the foot. Picking another agent while expanded (⌘K, ⌘J, ⌃1–9) keeps it
  expanded: the agent shows in the expanded pane, or the pane that shows it is the one expanded. ⌘K and ⌘J work while
  expanded; the hand, Home (+, ⌘0), the Needs you reel and folding the sidebar end it. Expansion isn't kept across
  launches.
- **Which agent**: the open project's focused agent (the reel's focus, so folding shows the same column), else its
  first. A click on a row of another project opens that project (a project switch); nothing animates. Follow never
  moves the opened pane: an ask shows in Needs you instead.
- **Needs you reel**: the hand and the Needs you heading call `DeskModel.openNeedsReel()` (the Needs you reel, above);
  the hand's count is `needs.count`. ⌘J is View › Next Ask (`nextAsk()`).
- **Keyboard** in the list (it takes the keyboard when the sidebar opens, or on a click): ↑ ↓ move the cursor (the
  system focus ring) over rows, folded projects and Finished; Return shows the agent (or unfolds); → unfolds, ← folds
  the project (or Finished).

# 3. Follow, overview, zoom

`ReelStates`. Follow (on by default) moves the reel only for an ask or a failure in the open project, 0.35 s spring
without bounce; scrolling yourself turns it off. Overview (every agent as a card; not built yet: ⌘0 is Home now, the
overview gets its key when it's built); ⇧⌘↩ is the zoom key: opened, it expands the focused pane (§2.1); folded it
does nothing yet (zooming a reel column isn't built).

# 4. Keyboard

⌘0 Home (again: back to the project) · ⌘J the next ask, oldest first, one at a time (from anywhere: it opens that agent in
its project; in the Needs you reel it focuses the next column; after the newest, the oldest again) · ⌘1–9 projects · ⌃1–9 agents · ⌃← ⌃→ focus the neighbour column (the reel scrolls
only when the focused column would leave the window, 180 ms ease-out; opened with splits: the neighbouring pane) · ⇧⌘↩
expand the focused pane (opened; Esc back) · ⌘D / ⇧⌘D split right / down (opened) · ⌘K search · ⇧⌘N Home with the
composer focused · ⌘L message the planner · ⌥⌘P pause / resume the project · ⌘W fold the project into the title bar (a
finished one: remove it; Home: back to the open project; opened with splits: close the focused pane; the window's own
Close is replaced) · ⇧⌘F Follow · ⌃⌘S (and ⌘\) fold or open the sidebar · ⌘J the next agent that needs you, one at a time (Next Ask). ⌘T (Trace) is bound once the desktop has a trace
view. Each is in the app's menus (File, Project, View, Go). Return approves while an ask has focus and nothing else takes
Return: never while a text field has the keyboard (a column's message box, a rename field, the new project column's
composer, Search ⌘K), nor while the menu or the Stop question is up; on Home it approves only the focused card's ask.
Esc never denies; it closes Search ⌘K, the menu and the model menu, cancels a folder's setup, leaves Home for the
open project while nothing is typed, leaves the Needs you reel, and collapses an expanded pane. Keyboard actions never
animate otherwise.

# 5. Motion

Transform and opacity only, ≤ 300 ms, interruptible springs without bounce, Reduce Motion → 150 ms crossfades. The Needs you reel: an answered column fades and lifts 6 pt (0.18 s) while the rest
close up (0.24 s); from the keyboard nothing slides; Reduce Motion: a 0.15 s fade. Deck
fan-out spring 0.3 s, names fade in over the last 120 ms. Home comes in and goes with a 0.3 s spring (opacity, 8 pt
rise); a Running card arrives with a 0.35 s spring (opacity, from 6 pt above); the model menu pops in 0.14 s (opacity,
3 pt); the composer's focus ring fades in 0.18 s. Reduce Motion: crossfades only.
The menu: 0.2 s spring, opacity with a 0.98 scale from the top. Search ⌘K: at once from the keyboard (⌘K); from a
click, a 0.18 s ease-out fade (Reduce Motion: 0.15 s crossfade); it closes the same way (Esc at once), and its keys (moving
the selection, typing) never animate. The sidebar slides in and out by transform (0.25 s spring, no bounce) while the pane fades, laid out once at its final
frame; from the keyboard it doesn't animate; Reduce Motion: a crossfade. A sidebar row moves only when the daemon moves
it (an ask arrives: it leaves Running for Needs you), 0.2 s opacity and a 6 pt slide, and never under the pointer (the
move waits until the pointer leaves the sidebar); ••• fades in over 120 ms. Running rows have no spinners. Panes: a
split, a close and the focus moving lay the panes out at once (no motion); a click's expand brings the pane up from a
0.98 scale with a fade (0.22 s, ease-out), a click's collapse fades the panes and the sidebar back in (0.2 s); from the
keyboard (⇧⌘↩, Esc) nothing animates; Reduce Motion: a 0.15 s fade.
Menu bar → window: one shape grows from the menu bar icon,
300 ms (0.32, 0.72, 0, 1), pointer only (`Expand`). Bots: no loops; the menu bar's approved moments only.

# 6. Store work this needs

- **Keyed changes.** `CapcomdStore.onChange` stays for the menu bar; add `onChanges(Set<ChangeKey>)` with
  `.run(id)`, `.agent(id)`, `.thread(agentId)`, `.approvals`, `.projects`. (Built: `.run`, `.agent`, `.thread`,
  `.selection`; approvals and pauses arrive unnarrowed, as `.all`, which is when the Needs you list is read again.) The desktop model keeps one small
  `@Observable` per column and updates only the ones named. The sidebar keeps one slice
  (`SidebarSlice`: its content and the Needs you count) rebuilt only for the runs named (every run on `.all`), memoised
  per run, and assigned only when it differs.
- **Many threads at once.** `openThread` tracks one agent; the reel needs the open run's agents. The stream side is
  already there (`thread=1` covers the run); the store keeps items for every agent of `threadStreamRun` and pages each
  column in on first show.

# 7. Phases

1. The window in the `CapcomdApp` app (a regular Dock app with the menu bar item; the shared pieces live in the `CapcomdUI` library), title bar with
   projects and crew tabs, the reel with real threads, message boxes and decisions, Follow, keyboard. Keyed changes
   and many threads in the store.
2. New project column (now Home), project menu and Search ⌘K (built), then overview and zoom.
3. Swarm folding and the strip, menu bar → window motion, voice input of the app's own (Home's mic dictates for now).
4. Navigation, C Rex-style (`rex/`): the folding rail and the opened sidebar with one agent's pane (built); then the
   Needs you reel, splits (⌘D / ⇧⌘D) and expand (⇧⌘↩) (built), the project label's ••• (the project menu), a lead's
   swarm folded to a stack in the list, and the Search palette in place of Actions.
