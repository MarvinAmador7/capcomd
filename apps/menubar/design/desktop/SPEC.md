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
| A thread item arrives | re-renders its own column only | Keyed change notifications (§6), not the menu bar's global `revision`. |
| Typing in a composer | no work outside the composer | The draft is local `@State`; nothing in the store changes until Send. |
| Network | one stream per open run, whatever the column count | The run stream with `?thread=1` already carries every agent's thread items; no per-column connections (AsyncHTTPClient caps at 8). |
| Memory | one 100-item page per column until you scroll up | Older items load on demand, as the menu bar's thread does. |
| Bots | drawn once per agent and size | `BotImages` cache (CapcomdBot); never re-rendered on state changes. |
| Search ⌘K | open: first frame ≤ 50 ms; a keystroke's results within a frame (16.7 ms) with 250+ items | Titles only, folded once per source change; a keystroke compares integer arrays and narrows from the last query; at most 24 rows a group in a lazy list. Bench: `palette-open`, `palette-type`, `palette-keys` on the `search` fixture. |
| Markdown | no parsing on the main thread | The daemon's `blocks/1` tree is already parsed; views only lay it out. |

Measure with Instruments (SwiftUI + Animation Hitches) on a 17-agent fake-host run (live-app-testing recipe) before a
PR is called done, and put the numbers in the PR.

# 2. Structure

One window, two parts.

- **Title bar** (52 pt: the unified toolbar's height, so the traffic lights centre on it; full-size content): traffic lights, then **Home** (a 30 pt
  icon button, the prototype's house; pressed while Home shows; ⌘0), then the **projects**, then on the right **Follow**, **Actions ⌘K**, **+**. Boards:
  `ReelStack`, `ReelTabs`, `Home`.
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
      (⌘0), Follow (⇧⌘F), Settings (⌘,).
    - Before anything is typed: Needs you, then Recent (what you looked at before, newest first, topped up with other
      projects; three), then the common commands (six).
    - ↑ ↓ (⌃P ⌃N) move; ↩ opens (an agent: its project opens at its column; a project: at its ask); ⌘↩ opens in a
      split, and until splits exist it opens as ↩ does (`DeskModel.openInSplit`); Esc, a click outside or the window
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

# 3. Follow, overview, zoom

`ReelStates`. Follow (on by default) moves the reel only for an ask or a failure in the open project, 0.35 s spring
without bounce; scrolling yourself turns it off. Overview (every agent as a card; not built yet: ⌘0 is Home now, the
overview gets its key when it's built); ⇧⌘↩ zoom one column.

# 4. Keyboard

⌘0 Home (again: back to the project) · ⌘1–9 projects · ⌃1–9 agents · ⌃← ⌃→ focus the neighbour column (the reel scrolls
only when the focused column would leave the window, 180 ms ease-out) · ⇧⌘↩ zoom · ⌘K search · ⇧⌘N Home with the
composer focused · ⌘L message the planner · ⌥⌘P pause / resume the project · ⌘W fold the project into the title bar (a
finished one: remove it; Home: back to the open project; the window's own Close is replaced) · ⇧⌘F Follow. ⌘T (Trace) is bound once the desktop has a trace
view. Each is in the app's menus (File, Project, Go). Return approves while an ask has focus and nothing else takes
Return: never while a text field has the keyboard (a column's message box, a rename field, the new project column's
composer, Search ⌘K), nor while the menu or the Stop question is up; on Home it approves only the focused card's ask.
Esc never denies; it closes Search ⌘K, the menu and the model menu, cancels a folder's setup, and leaves Home for the
open project while nothing is typed. Keyboard actions never animate otherwise.

# 5. Motion

Transform and opacity only, ≤ 300 ms, interruptible springs without bounce, Reduce Motion → 150 ms crossfades. Deck
fan-out spring 0.3 s, names fade in over the last 120 ms. Home comes in and goes with a 0.3 s spring (opacity, 8 pt
rise); a Running card arrives with a 0.35 s spring (opacity, from 6 pt above); the model menu pops in 0.14 s (opacity,
3 pt); the composer's focus ring fades in 0.18 s. Reduce Motion: crossfades only.
The menu: 0.2 s spring, opacity with a 0.98 scale from the top. Search ⌘K: at once from the keyboard (⌘K); from a
click, a 0.18 s ease-out fade (Reduce Motion: 0.15 s crossfade); it closes the same way (Esc at once), and its keys (moving
the selection, typing) never animate. Menu bar → window: one shape grows from the menu bar icon,
300 ms (0.32, 0.72, 0, 1), pointer only (`Expand`). Bots: no loops; the menu bar's approved moments only.

# 6. Store work this needs

- **Keyed changes.** `CapcomdStore.onChange` stays for the menu bar; add `onChanges(Set<ChangeKey>)` with
  `.run(id)`, `.agent(id)`, `.thread(agentId)`, `.approvals`, `.projects`. The desktop model keeps one small
  `@Observable` per column and updates only the ones named.
- **Many threads at once.** `openThread` tracks one agent; the reel needs the open run's agents. The stream side is
  already there (`thread=1` covers the run); the store keeps items for every agent of `threadStreamRun` and pages each
  column in on first show.

# 7. Phases

1. The window in the `CapcomdApp` app (a regular Dock app with the menu bar item; the shared pieces live in the `CapcomdUI` library), title bar with
   projects and crew tabs, the reel with real threads, message boxes and decisions, Follow, keyboard. Keyed changes
   and many threads in the store.
2. New project column (now Home), project menu and Search ⌘K (built), then overview and zoom.
3. Swarm folding and the strip, menu bar → window motion, voice input of the app's own (Home's mic dictates for now).
