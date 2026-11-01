# The reel's layout: frames, AppKit columns, windowing (design note)

The native performance path for the desktop window (owner's direction, 2026-10-31: take AppKit, Core Animation and
Core Text as far as they go before considering a GPUI-style engine; the PerfLoop bench decides). This note says what
the reel's layout is today, what the first round of the native path built, what it measured, and what comes next.
Everything here is behind runtime knobs (DeskKnobs.swift); with no knob set the window runs the code it ran before.

## Where a step's time goes (crew17, release, one window)

Measured with `profile step --template time`, `diff` of time profiles and in-process counters (2026-10-31). A step (a
crew tab click: the reel slides one screen) costs ~120–160 ms of main-thread CPU and ~400 M instructions. Split by
the first framework frame that owns the time:

| ms/step | what | why it runs on a step |
|---:|---|---|
| ~25 | AppKit `_findAnySubviewNeedingAutoLayoutEngine` | every layout pass of the window walks every NSView (~1,100 with 17 columns) |
| ~20–26 | AppKit tracking-area update | the reel's clip view moving marks every column's subtree dirty |
| ~20–30 | column `NSHostingView.layout` | every column moves in window space, SwiftUI invalidates its transform and re-places it |
| ~14 | the window's root `NSHostingView.layout` | the title bar: crew tabs, the bracket, the strip's position |
| ~20 | SwiftUI transactions | the model's sets (focus, `onScreen`, `reelRequest`) and `updateNSView` → the slide |
| ~12 | `NSScrollAnimationHelper` on the display link | the title bar's tab strip scrolling to keep the bracket in view, frame by frame |
| ~10 | Core Animation commit | |

From 4 to 40 agents a step grows by ~176 ms: +39 the auto-layout walk, +32 tracking areas, +44 column hosting views'
layout, +36 SwiftUI transactions (lazy stack placements in the threads, the title bar's `ForEach` of tabs), +14 the
tab strip. The cost per agent is spread over AppKit walks proportional to the NSView count, SwiftUI re-placing every
column that moved, and the title bar; not over the column's own chrome. Each warm column holds ~60–120 NSViews, most
of them made by SwiftUI for the thread: a `SelectionTextField` overlay per selectable text, `CGDrawingView`s.

The first finding was the bench's: its scene host made a second, hand-made window in front of the scene's own, so
every scene-hosted run measured two reels on one model ("every body evaluated twice per update"). Fixed in the bench
(Harness.sceneWindowReady); every number above and below is one window.

## The layout model

**Measure / place.** `ReelGeometry` (ReelLayout.swift) is measured from the reel's inputs (bounds, column count,
backing scale): columns across, column width, pitch, document width, the range of columns near a leading one. Placing
is `frame(of:)`: a column's frame in the document. With `desk.layout=frames` the reel places its columns only when the
geometry changes; a layout pass with the same inputs moves nothing. Nothing in the reel is measured through SwiftUI or
Auto Layout (the representable already answered `sizeThatFits` itself; hosting views have no sizing options).

**Pixel snapping.** The frame engine rounds the column width down to the device pixel grid, so the pitch and every
scroll offset are whole pixels (437.33 → 437 pt at 1440 pt; the leading edge is unchanged, the trailing peek takes
the rest). With fractional columns each column's thread scroll view re-snapped its origin by 1/6 pt whenever its
column moved, as an animated scroll (`HostingScrollView.scrollViewDidScroll` → a graph update), one column after
another: 138 such scrolls over two steps and their setup, 24 with snapping (all of them the threads anchoring at the
bottom as they build). Those happen while columns build, not inside a step's own stretches.

**Caching and invalidation.** The geometry is a value compared with the last one: invalidated by a width, a column
count or a backing scale, nothing else. The AppKit column (below) places its head and body only when its size changes,
and its stroke only when `approval` or `focused` changes.

**AppKit columns (`desk.column=native`, NativeColumn.swift).** The column is an AppKit view whose layer is its frame:
fill, continuous corner, clip. Its stroke is a shape layer with SwiftUI's `strokeBorder` geometry (a layer border
antialiased the corners differently). Inside it, by frame, two hosting views: the head (`ColumnHead`, 40 pt) and the
body (thread, then the message box or the decision). The stroke follows focus and asks through observation
(`withObservationTracking`, applied on the run loop once the change has landed), so a step's focus change sets a
layer property instead of re-rendering `Column` and re-laying out its SwiftUI tree. What moved off SwiftUI: the
column's frame, fill, clip, stroke and the placement of head and body. What stays SwiftUI: the head's content, the
thread's rows, the box, the decision; so text selection and VoiceOver are what they were (the head is still one
combined accessibility element; the rows keep their selectable text and labels). Clicking anywhere focuses the column,
as before (a tap gesture on the head and on the body).

**Windowing (`desk.layout=frames-hide`, `reel.columns=park`).** While the reel rests, only the columns on screen and
one each side stay in view: the rest are hidden (`frames-hide`) or parked in a hidden container that never scrolls,
with a blank stand-in in the document (`park`). A move brings back the columns it will show first (the slide's
target, the leading column as a swipe crosses it). A hosting view doesn't render while hidden, so a column shown again
is laid out at once.

## The knobs

| Knob | Values (default first) | What it switches |
|---|---|---|
| `desk.layout` | `auto`, `frames`, `frames-hide` | fractional frames (today) · the frame engine with pixel snapping · plus far columns hidden at rest |
| `desk.column` | `swiftui`, `native` | one hosting view of `Column` (today) · an AppKit column with a head and a body hosting view |
| `reel.columns` | `keep`, `park` | every built column in the scrolling document (today) · only those near the screen |

```sh
$B ab step --a-knobs desk.layout=auto --b-knobs desk.column=native --reps 5 --objective instructions
perfloop exp new "<hypothesis>" --knobs desk.column=native
```

## What it measured (2026-10-31, crew17, release, `ab` 5 + 5 interleaved, one binary)

| Setting | step: instructions/step | step: CPU ms/step | switch: latency | open: latency |
|---|---|---|---|---|
| `desk.column=native` | −13.3 % (411 → 369 M, B better in 5/5, p = 0.008, band ±14 %) | −6 % (in band) | same (+9.6 %, in band) | same (+1 %) |
| `desk.layout=frames` | +10 % (unsure, p = 0.095); longest stretch +40 % | +5.5 % (in band) | same | same |
| `desk.layout=frames-hide` | same (+14 %, in a ±22 % band); late frame time +61 % (worse) | same | | |
| `reel.columns=park` | +16 % (worse, p = 0.008) | +16 % | | |
| `native` + `frames-hide` | −9 % (in band) | | | |
| `native` + `frames` | | | −7.7 % (in band; instructions −6 %, p = 0.03) | |

Sweep `step --set desk.column=swiftui,native --set agents=4..64/12 --reps 2` (instructions, 11 of 12 points on a
busy machine): 17.2 M instructions per agent with SwiftUI columns, 16.0 M with AppKit columns; both bend the same way
past the warm cap. The AppKit column trims a constant, not the slope.

So: the column's chrome is not where a step's time is, and moving columns around in AppKit (hiding them, parking
them) costs more than it saves, because SwiftUI's hosting views pay to come back (re-render on unhide, re-attach on a
new superview). The win available is in the number of NSViews SwiftUI makes for threads and in the work every moved
hosting view does, which only native rows remove.

## What's next

1. **Native rows** (`desk.column=native` extended, or a new value): the thread as one layer-backed AppKit view per
   column, rows measured with Core Text once per (content version, width) and cached, drawn into layers, laid out by
   the same engine (a row's height from its cached frame; placement is a running sum). One view per thread instead of
   one `SelectionTextField` per selectable text: the AppKit walks lose most of their views, a moved column re-places
   nothing in SwiftUI, and text selection becomes the column's own (a selection model over the cached Core Text lines,
   with copy), with VoiceOver through an `NSAccessibilityElement` per row. This is where the
   per-agent slope is.
2. **Column reuse** pays only once a column is cheap to configure: with SwiftUI threads a recycled column rebuilds
   its rows (~55 ms each), and parking (moving a hosting view between superviews) measured slower than keeping. With
   native rows and cached measurements, a pool of `across + 2` columns configured with an agent's cached rows is the
   next stage (`reel.columns=reuse`).
3. **The title bar's tab strip** animates its scroll frame by frame on the main thread on every step (~12 ms plus the
   layout passes it causes); moving that scroll to the render server, as the reel's slide already is, is a separate,
   small experiment.
4. Re-measure `frames` on a quiet machine: it removes the threads' sub-pixel re-snapping while columns build, which
   should show in `open` and `switch` settle time rather than in a step.
