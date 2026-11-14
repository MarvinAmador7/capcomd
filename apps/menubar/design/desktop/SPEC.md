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
| A thread item arrives | re-renders its own column only | Keyed change notifications (§6), not the menu bar's global `revision`. The sidebar reads no thread: a thread item recomputes its run's rows, finds them equal and assigns nothing (`sidebar-burst`). |
| Fold or open the sidebar | first frame ≤ 50 ms; the reel is never reflowed | Opened, the sidebar and the pane are drawn over the reel, which keeps its size and its columns; the pane is laid out once, at its final frame, and only the sidebar's transform and the pane's opacity move (`sidebar-toggle`). |
| Switch agent from the sidebar (click, Return, ⌘J) | first frame ≤ 50 ms | The pane is one AppKit column (the reel's `NativeColumnView`, pane style) reconfigured with the agent; another project opens as a project switch does (`sidebar-select`). |
| Sidebar scroll | no dropped frames; no pane work | Its own scroll view of fixed-height lines (28 pt rows and headings, 24 pt labels), Equatable per line (`sidebar-scroll`). |
| Typing in a composer | no work outside the composer | The draft is local `@State`; nothing in the store changes until Send. |
| Network | one stream per open run, whatever the column count | The run stream with `?thread=1` already carries every agent's thread items; no per-column connections (AsyncHTTPClient caps at 8). |
| Memory | one 100-item page per column until you scroll up | Older items load on demand, as the menu bar's thread does. |
| Bots | drawn once per agent and size | `BotImages` cache (CapcomdBot); never re-rendered on state changes. |
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
  - **Actions ⌘K** (the ⌘ button): a small palette over the window, the menu's surface: type to filter (every word
    typed starts a word of the entry; entries that start with it come first), ↑ ↓ move, Return runs, Esc or a click
    outside closes. Entries: the open project's menu items, New project, Follow on/off, switch to each other project
    (⌘1–9 shown), focus each agent by its title (⌃1–9 shown), Home (⌘0).
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
  - An agent is in **Needs you** when an approval waits on it (merges wait on the agent merging them), when it waits at
    a usage limit, or when it failed in a run that is still active: the decisions, never as a badge on a row. The rest
    stay in tree order under their project in Running (an active run) or Finished.
  - A **project** is a quiet label (24 pt, 11.5 pt semibold, tertiary) with its place icon (`laptopcomputer` This Mac,
    `cloud` boxd), once per section it appears in.
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
  the pane's controls: room for split (⌘D / ⇧⌘D) and expand (⇧⌘↩), not built yet, and ••• (the row's menu). Under it
  the thread (the reel's renderer, a 720 pt reading column, 24 pt sides) and the message box, or the ask bar (the
  reel's decision) while it waits on you. Home (+, ⌘0) shows in the pane's place.
- **Which agent**: the open project's focused agent (the reel's focus, so folding shows the same column), else its
  first. A click on a row of another project opens that project (a project switch); nothing animates. Follow never
  moves the opened pane: an ask shows in Needs you instead.
- **Needs you reel**: the hand and the Needs you heading call `DeskModel.openNeedsReel()` (`rex/RexNeedsReel`, built
  separately); until it lands they show the oldest ask, as ⌘J does.
- **Keyboard** in the list (it takes the keyboard when the sidebar opens, or on a click): ↑ ↓ move the cursor (the
  system focus ring) over rows, folded projects and Finished; Return shows the agent (or unfolds); → unfolds, ← folds
  the project (or Finished).

# 3. Follow, overview, zoom

`ReelStates`. Follow (on by default) moves the reel only for an ask or a failure in the open project, 0.35 s spring
without bounce; scrolling yourself turns it off. Overview (every agent as a card; not built yet: ⌘0 is Home now, the
overview gets its key when it's built); ⇧⌘↩ zoom one column.

# 4. Keyboard

⌘0 Home (again: back to the project) · ⌘1–9 projects · ⌃1–9 agents · ⌃← ⌃→ focus the neighbour column (the reel scrolls
only when the focused column would leave the window, 180 ms ease-out) · ⇧⌘↩ zoom · ⌘K actions · ⇧⌘N Home with the
composer focused · ⌘L message the planner · ⌥⌘P pause / resume the project · ⌘W fold the project into the title bar (a
finished one: remove it; Home: back to the open project; the window's own Close is replaced) · ⇧⌘F Follow · ⌃⌘S (and ⌘\) fold or open the sidebar · ⌘J the next agent that needs you, one at a time (Go › Next
Ask). ⌘T (Trace) is bound once the desktop has a trace
view. Each is in the app's menus (File, View, Project, Go). Return approves while an ask has focus and nothing else takes
Return: never while a text field has the keyboard (a column's message box, a rename field, the new project column's
composer, the palette), nor while the menu or the Stop question is up; on Home it approves only the focused card's ask.
Esc never denies; it closes the palette, the menu and the model menu, cancels a folder's setup, and leaves Home for the
open project while nothing is typed. Keyboard actions never animate otherwise.

# 5. Motion

Transform and opacity only, ≤ 300 ms, interruptible springs without bounce, Reduce Motion → 150 ms crossfades. Deck
fan-out spring 0.3 s, names fade in over the last 120 ms. Home comes in and goes with a 0.3 s spring (opacity, 8 pt
rise); a Running card arrives with a 0.35 s spring (opacity, from 6 pt above); the model menu pops in 0.14 s (opacity,
3 pt); the composer's focus ring fades in 0.18 s. Reduce Motion: crossfades only.
The menu and the palette: 0.2 s spring, opacity with a 0.98 scale from the top. The sidebar slides in and out by transform (0.25 s spring, no bounce) while the pane fades, laid out once at its final
frame; from the keyboard it doesn't animate; Reduce Motion: a crossfade. A sidebar row moves only when the daemon moves
it (an ask arrives: it leaves Running for Needs you), 0.2 s opacity and a 6 pt slide, and never under the pointer (the
move waits until the pointer leaves the sidebar); ••• fades in over 120 ms. Running rows have no spinners.
Menu bar → window: one shape grows from the menu bar icon,
300 ms (0.32, 0.72, 0, 1), pointer only (`Expand`). Bots: no loops; the menu bar's approved moments only.

# 6. Store work this needs

- **Keyed changes.** `CapcomdStore.onChange` stays for the menu bar; `onChanges(Set<ChangeKey>)` names `.run(id)`,
  `.agent(id)`, `.thread(agentId)`, `.selection`, or `.all` (approvals and projects come as `.all`). The desktop model
  keeps one small `@Observable` per column and updates only the ones named. The sidebar keeps one slice
  (`SidebarSlice`: its content and the Needs you count) rebuilt only for the runs named (every run on `.all`), memoised
  per run, and assigned only when it differs.
- **Many threads at once.** `openThread` tracks one agent; the reel needs the open run's agents. The stream side is
  already there (`thread=1` covers the run); the store keeps items for every agent of `threadStreamRun` and pages each
  column in on first show.

# 7. Phases

1. The window in the `CapcomdApp` app (a regular Dock app with the menu bar item; the shared pieces live in the `CapcomdUI` library), title bar with
   projects and crew tabs, the reel with real threads, message boxes and decisions, Follow, keyboard. Keyed changes
   and many threads in the store.
2. New project column (now Home), project menu and ⌘K actions (built), then overview and zoom.
3. Swarm folding and the strip, menu bar → window motion, voice input of the app's own (Home's mic dictates for now).
4. Navigation, C Rex-style (`rex/`): the folding rail and the opened sidebar with one agent's pane (built); then the
   Needs you reel, splits (⌘D / ⇧⌘D) and expand (⇧⌘↩) in the pane header's slots, the project label's ••• (the project
   menu), a lead's swarm folded to a stack in the list, and the Search palette in place of Actions.
