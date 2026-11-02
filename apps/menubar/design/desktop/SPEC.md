---
title: capcomd desktop window: spec
subtitle: The capcomd desktop app ("Reel"). Its own app (installable without the menu bar one), sharing the store, transport and thread renderer with it.
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
| Open the window | first frame ≤ 100 ms after launch | Nothing is fetched to show the window; the store fills it as frames arrive. Data that isn't there yet shows as an empty column, never a spinner over the window. |
| Switch project (click or ⌘1–9) | first frame ≤ 50 ms | The decks are already in memory; the reel shows headers at once, thread pages fill in. Keyboard switches don't animate. |
| Reel scroll | no dropped frames at 120 Hz with 17 agents | The reel is an AppKit scroll view with one hosting view per column, so a scroll frame moves a layer and runs no SwiftUI (in a SwiftUI ScrollView every frame dirtied all 16 columns' views). Columns stay built while the run is open (a lazy stack rebuilt every column it scrolled past). Threads are built ahead of time, nearest first while the reel stands still, at most 32 kept. A swipe lands on the column edge nearest where its momentum would stop, at most a screen away; the leading column is reported once per column crossed. A jump of more than a screen cuts to one column short and slides the last. |
| A thread item arrives | re-renders its own column only | Keyed change notifications (§6), not the menu bar's global `revision`. |
| Typing in a composer | no work outside the composer | The draft is local `@State`; nothing in the store changes until Send. |
| Network | one stream per open run, whatever the column count | The run stream with `?thread=1` already carries every agent's thread items; no per-column connections (AsyncHTTPClient caps at 8). |
| Memory | one 100-item page per column until you scroll up | Older items load on demand, as the menu bar's thread does. |
| Bots | drawn once per agent and size | `BotImages` cache (CapcomdBot); never re-rendered on state changes. |
| Markdown | no parsing on the main thread | The daemon's `blocks/1` tree is already parsed; views only lay it out. |

Measure with Instruments (SwiftUI + Animation Hitches) on a 17-agent fake-host run (live-app-testing recipe) before a
PR is called done, and put the numbers in the PR.

# 2. Structure

One window, two parts.

- **Title bar** (52 pt: the unified toolbar's height, so the traffic lights centre on it; full-size content): traffic lights, then the **projects**, then on the
  right **Follow**, **Actions ⌘K**, **+**. Boards: `ReelStack`, `ReelTabs`.
  - The **open project** is one group: Local/Cloud glyph (`laptopcomputer` / `cloud`), name (no clock or
    status line), then its crew tabs in tree order, with a bracket around the tabs whose columns are on screen.
  - Every **other project** is a deck: glyph, name (no clock or status line), then its crew's heads stacked (overlap 15 pt).
    A folded project that asks has an amber ring and says who asks.
  - Too many to fit: decks drop their names, then the rest go into a "+n" deck (its menu lists them). An asking
    project is never in the overflow.
  - The project name opens the project menu (`ReelMenu`): goal, repos, place; Message the planner (⌘L), Changes,
    Trace (⌘T), Browse the workspace, Pause/Resume (⌥⌘P), Stop… (asks first), Fold into the title bar, Copy run ID.
    Only actions the daemon has.
- **Reel**: the open project's agents as full-height columns in tree order (`Reel`). Three columns at 1440 pt, two at
  1100, one under 760; the neighbours peek 44 pt at both edges. A column is header (bot, profile, bot name, state,
  place, elapsed) · thread (the menu bar's thread renderer) · its own message box. An agent that asks docks the
  decision at its column's foot (View diff · Deny · Approve ↩) instead of the box.
- **Swarms** (`ReelSwarm`): leads' subtrees fold into stacks in the title bar; only the subtree on screen is fanned
  out. An asking agent always steps out of its stack. A strip at the foot shows one cell per agent, grouped by lead.
- **New project** (`ReelNew`): + (⇧⌘N) opens one plain column, no agent header, with the composer card (folder and
  branch chips, goal, + · Local/Cloud · model with effort bars · mic · Start). The planner-to-be bot waits sleepy,
  smiles once you type (one change, no loop), and on Start becomes the column's header.

# 3. Follow, overview, zoom

`ReelStates`. Follow (on by default) moves the reel only for an ask or a failure in the open project, 0.35 s spring
without bounce; scrolling yourself turns it off. ⌘0 overview (every agent as a card); ⇧⌘↩ zoom one column.

# 4. Keyboard

⌘1–9 projects · ⌃1–9 agents · ⌃← ⌃→ focus the neighbour column (the reel scrolls only when the focused column would
leave the window, 180 ms ease-out) · ⌘0 overview · ⇧⌘↩ zoom · ⌘K actions · ⇧⌘N new project · Return approves while
an ask has focus; Esc never denies. Keyboard actions never animate otherwise.

# 5. Motion

Transform and opacity only, ≤ 300 ms, interruptible springs without bounce, Reduce Motion → 150 ms crossfades. Deck
fan-out spring 0.3 s, names fade in over the last 120 ms. Menu bar → window: one shape grows from the menu bar icon,
300 ms (0.32, 0.72, 0, 1), pointer only (`Expand`). Bots: no loops; the menu bar's approved moments only.

# 6. Store work this needs

- **Keyed changes.** `CapcomdStore.onChange` stays for the menu bar; add `onChanges(Set<ChangeKey>)` with
  `.run(id)`, `.agent(id)`, `.thread(agentId)`, `.approvals`, `.projects`. The desktop model keeps one small
  `@Observable` per column and updates only the ones named.
- **Many threads at once.** `openThread` tracks one agent; the reel needs the open run's agents. The stream side is
  already there (`thread=1` covers the run); the store keeps items for every agent of `threadStreamRun` and pages each
  column in on first show.

# 7. Phases

1. The `CapcomdDesktop` app (a regular Dock app; the shared pieces live in the `CapcomdUI` library), title bar with
   projects and crew tabs, the reel with real threads, message boxes and decisions, Follow, keyboard. Keyed changes
   and many threads in the store.
2. New project column, project menu, overview and zoom.
3. Swarm folding and the strip, menu bar → window motion, voice input.
