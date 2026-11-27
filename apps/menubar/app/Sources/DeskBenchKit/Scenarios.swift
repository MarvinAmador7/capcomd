import Foundation
import PerfLoopProbe

/// The scenarios the bench drives, each tied to one SPEC §1 budget: what `describe` lists (BenchCatalog.swift) and the
/// bench's drivers (CapcomdDeskBench/Drive*.swift) run.
public struct ScenarioSpec: Codable, Sendable, Hashable {
  public enum Kind: String, Codable, Sendable { case latency, smooth, isolation }
  public var name: String
  public var summary: String
  /// Which SPEC §1 row this measures.
  public var budget: String
  /// The pass rule in words.
  public var rule: String
  public var kind: Kind
  /// For latency scenarios: the median must be at or under this.
  public var latencyBudgetMs: Double?
  /// Parameters the scenario takes (`--set key=value`), with defaults.
  public var params: [String: String]
  /// The fixture it runs on when nobody names one (nil: `Scenarios.defaultFixture`). The manifest's `scenarios[].fixture`:
  /// perfloop always passes `--fixture`, this one unless told otherwise; `deskbench run` without `--fixture` uses it too.
  public var fixture: String? = nil
}

public enum Scenarios {
  public static let all: [ScenarioSpec] = [
    ScenarioSpec(name: "open", summary: "Show the window on a filled store and wait for the first frame that has columns in it.",
                 budget: "Open the window: first frame ≤ 100 ms", rule: "median latency from makeKeyAndOrderFront to the first committed frame ≤ 100 ms; no stretch over 250 ms",
                 kind: .latency, latencyBudgetMs: 100, params: [:]),
    ScenarioSpec(name: "switch", summary: "Switch between the two largest projects (as ⌘1/⌘2 do), back and forth.",
                 budget: "Switch project: first frame ≤ 50 ms", rule: "median latency from open(project:) to the frame that shows the new columns ≤ 50 ms",
                 kind: .latency, latencyBudgetMs: 50, params: ["switches": "6"]),
    ScenarioSpec(name: "step", summary: "Click through the reel one screen at a time, to the end and back (animated, as a crew tab does).",
                 budget: "Reel scroll: no dropped frames at 120 Hz with 17 agents", rule: "no late frame while the reel moves; no stretch over 16.7 ms during a step",
                 kind: .smooth, latencyBudgetMs: nil, params: ["steps": "8"]),
    ScenarioSpec(name: "jump", summary: "First column ↔ last column: the longest jump there is, repeatedly.",
                 budget: "Reel scroll: no dropped frames at 120 Hz with 17 agents", rule: "no late frame while the reel moves; no stretch over 16.7 ms during a jump",
                 kind: .smooth, latencyBudgetMs: nil, params: ["jumps": "6"]),
    ScenarioSpec(name: "fling", summary: "A synthetic trackpad swipe with momentum, delivered to the reel's NSScrollView (see DESKBENCH.md for its fidelity).",
                 budget: "Reel scroll: no dropped frames at 120 Hz with 17 agents", rule: "no late frame while the reel moves; it lands on a column edge",
                 kind: .smooth, latencyBudgetMs: nil, params: ["flings": "6", "velocity": "2400"]),
    ScenarioSpec(name: "swipe", summary: "A recorded trackpad gesture (perfloop.gesture/1, --gesture FILE) replayed into the reel's NSScrollView at its recorded times, in-process; how closely the content followed the fingers.",
                 budget: "Reel scroll: no dropped frames at 120 Hz with 17 agents", rule: "no late frame while the reel moves; the content within 1 pt of the fingers (p95) with no stall; it lands on a column edge",
                 kind: .smooth, latencyBudgetMs: nil, params: ["gesture": "synthetic:flick-forward", "swipes": "4", "from": "middle", "timestamps": "recorded", "deliver": "window"]),
    ScenarioSpec(name: "burst", summary: "Thread items arrive for one on-screen agent at a steady rate while the reel stands still, then again while it steps.",
                 budget: "A thread item arrives: re-renders its own column only", rule: "no Column, ColumnHead, CrewTab, TitleBar or other column's thread body during the burst; no late frame",
                 kind: .isolation, latencyBudgetMs: nil, params: ["itemsPerSecond": "20", "seconds": "3"]),
    ScenarioSpec(name: "typing", summary: "Type into an on-screen column's composer with key events sent to the window.",
                 budget: "Typing in a composer: no work outside the composer", rule: "only ColumnComposer bodies while typing; no late frame",
                 kind: .isolation, latencyBudgetMs: nil, params: ["text": "Please normalize the emails before the join and rerun the tests."]),
    ScenarioSpec(name: "resize", summary: "Resize the window across the 3 → 2 → 1 → 3 column steps.",
                 budget: "(no §1 row; general: nothing hangs)", rule: "no stretch over 100 ms per resize; the column count follows the width",
                 kind: .smooth, latencyBudgetMs: nil, params: [:]),
    ScenarioSpec(name: "follow", summary: "An ask arrives for a far-off agent with Follow on: the reel must go there.",
                 budget: "Follow (SPEC §3): 0.35 s spring to the asking column", rule: "the reel starts moving within 50 ms of the ask and lands on it; no late frame on the way",
                 kind: .latency, latencyBudgetMs: 50, params: ["asks": "4"]),
    // The folding rail and the Rex-style sidebar (design/desktop/rex; SPEC §1 "Fold or open the sidebar").
    ScenarioSpec(name: "sidebar-toggle", summary: "Open and fold the sidebar as ⌃⌘S does (animated=1: as its button does), with the reel kept underneath.",
                 budget: "Fold or open the sidebar: first frame ≤ 50 ms, the reel untouched", rule: "median latency from the toggle to the frame that shows it ≤ 50 ms; no reel body; the reel's frame unchanged; sidebar and pane drawn",
                 kind: .latency, latencyBudgetMs: 50, params: ["toggles": "8", "animated": "0"]),
    ScenarioSpec(name: "sidebar-select", summary: "With the sidebar open, click rows (events handed to the window) and walk it with ↓ and Return; each pick shows in the pane.",
                 budget: "Switch agent from the sidebar: first frame ≤ 50 ms", rule: "median latency from the click or Return to the frame that shows the agent ≤ 50 ms; every pick shown",
                 kind: .latency, latencyBudgetMs: 50, params: ["clicks": "6", "keys": "4"]),
    ScenarioSpec(name: "sidebar-burst", summary: "With the sidebar open, thread items for the pane's agent and another agent at a steady rate.",
                 budget: "A thread item arrives: re-renders its own column only (the sidebar never)", rule: "no sidebar body and no sidebar slice assignment during the burst; the pane's thread renders; no late frame",
                 kind: .isolation, latencyBudgetMs: nil, params: ["itemsPerSecond": "20", "seconds": "3"]),
    ScenarioSpec(name: "sidebar-scroll", summary: "A long sidebar (every project unfolded) scrolled down and back with replayed trackpad gestures.",
                 budget: "Sidebar scroll: no dropped frames, no pane work", rule: "no late frame while it moves; no stretch over 16.7 ms; no pane body",
                 kind: .smooth, latencyBudgetMs: nil, params: ["scrolls": "4", "gesture": "synthetic:scroll-down", "gestureBack": "synthetic:scroll-up"]),
    ScenarioSpec(name: "palette-first", summary: "The first Search ⌘K after the window opens (fixture `search`): the window shown and at rest, then ⌘K once, to the frame that shows the palette and its results.",
                 budget: "Search ⌘K opens: first frame ≤ 50 ms", rule: "latency from the first ⌘K to the first frame with the palette and its results ≤ 50 ms; checks: warmed-ahead, shown, items, empty-search",
                 kind: .latency, latencyBudgetMs: 50, params: [:], fixture: "search"),
    ScenarioSpec(name: "palette-open", summary: "Search ⌘K on the empty search, then Esc, repeatedly (fixture `search`: 250+ items): ⌘K to the frame that shows the panel and its results.",
                 budget: "Search ⌘K opens: first frame ≤ 50 ms", rule: "median latency from ⌘K to the first frame with the panel and its results ≤ 50 ms; checks: items, empty-search, panel-drawn, esc-closes",
                 kind: .latency, latencyBudgetMs: 50, params: ["opens": "6"], fixture: "search"),
    ScenarioSpec(name: "palette-type", summary: "Type a query into Search ⌘K a character at a time (key events to its field): each keystroke to the frame that shows its results.",
                 budget: "Search ⌘K: a keystroke's results within a frame", rule: "median latency from a key to the frame that shows its results ≤ 16.7 ms; checks: typed, ranking, panel-drawn",
                 kind: .latency, latencyBudgetMs: 16.7, params: ["query": "matchkey"], fixture: "search"),
    ScenarioSpec(name: "palette-keys", summary: "Search ⌘K's keys: type a query, ↓ ↓ ↑, ↩ opens the selection, ⌘↩ opens the first (folded: as ↩ does), Esc closes.",
                 budget: "Search ⌘K: keys and opening a result ≤ 50 ms", rule: "median latency from a key to the frame that shows what it did ≤ 50 ms; checks: selection, return-opens, split-falls-back, esc-closes, panel-drawn",
                 kind: .latency, latencyBudgetMs: 50, params: ["query": "shard"], fixture: "search"),
    // Splits and expand in the opened window (design/desktop/rex RexSplit, RexExpanded; SPEC §2.1). Each rep starts from
    // one pane and ends with its panes on screen.
    ScenarioSpec(name: "split-open", summary: "With the sidebar open, ⌘D (split right), ⇧⌘D (split down), then ⌘W twice, as key events to the app; each shows the panes.",
                 budget: "Split or close a pane: first frame ≤ 50 ms", rule: "median latency from the key to the frame that shows the panes ≤ 50 ms; the new pane is the next agent in tree order, focused; ⌘W closes the focused split",
                 kind: .latency, latencyBudgetMs: 50, params: ["cycles": "2"]),
    ScenarioSpec(name: "split-focus", summary: "Three panes: ⌃← ⌃→ and clicks move the focus between them.",
                 budget: "Move the focus between panes: first frame ≤ 50 ms, no thread renders", rule: "median latency from the key or click to the frame that shows the focus ≤ 50 ms; no PaneThread or PaneEntryRow body; the pane views kept",
                 kind: .latency, latencyBudgetMs: 50, params: ["clicks": "2"]),
    ScenarioSpec(name: "split-burst", summary: "Three panes: thread items for the middle pane's agent at a steady rate.",
                 budget: "A thread item arrives: re-renders its own column only (in a split: its own pane)", rule: "no other pane's body, no sidebar body or slice assignment during the burst; the target pane's thread renders; no late frame",
                 kind: .isolation, latencyBudgetMs: nil, params: ["itemsPerSecond": "20", "seconds": "3"]),
    ScenarioSpec(name: "pane-expand", summary: "Two panes, the focused thread scrolled up, the keyboard in the sidebar: ⇧⌘↩ expands it to the window, Esc brings back the same panes with the keyboard still in the pane.",
                 budget: "Expand or collapse a pane: first frame ≤ 50 ms, no thread rebuilt", rule: "median latency from the key to the frame that shows it ≤ 50 ms; expanded fills the window; back: same panes, frames, scroll position and views; the keyboard in the pane, expanded and back",
                 kind: .latency, latencyBudgetMs: 50, params: ["toggles": "4"]),
    ScenarioSpec(name: "expand-switch", summary: "A pane expanded: other agents picked as the palette's ↩ picks them, then ⌘K over it and Esc, then Esc collapses it and ⇧⌘↩ expands it again.",
                 budget: "Switch agent: first frame ≤ 50 ms (expanded stays expanded)", rule: "median latency from the pick to the frame that shows the agent ≤ 50 ms; still expanded, full window, every pick shown; Esc after ⌘K gives the keyboard back to the pane (focus palette-esc), and it stays there when Esc collapses the pane (focus collapse); expanded again, its thread shows rows (re-expanded, ink)",
                 kind: .latency, latencyBudgetMs: 50, params: ["switches": "4"]),
    // The Needs you reel (SPEC, Needs you reel), on `needs5` (their own fixture) or `needs20` (asks across projects).
    ScenarioSpec(name: "needs-open", summary: "Open the Needs you reel (the hand): every ask across projects as a column, oldest first.",
                 budget: "Open the Needs you reel: first frame ≤ 50 ms", rule: "median latency from openNeedsReel() to the frame that shows its columns ≤ 50 ms; the columns are the asks oldest first; no stretch over 100 ms",
                 kind: .latency, latencyBudgetMs: 50, params: [:], fixture: "needs5"),
    ScenarioSpec(name: "needs-answer", summary: "Answer the focused ask, again and again: its column slides out (≤ 300 ms, transform and opacity) and the next takes its place.",
                 budget: "Answer an ask: the column slides out with no dropped frame", rule: "no late frame while the columns close up; no stretch over 16.7 ms; the answered column left, the rest kept their order, the next one leads and has the focus",
                 kind: .smooth, latencyBudgetMs: nil, params: ["answers": "3"], fixture: "needs5"),
    ScenarioSpec(name: "needs-arrive", summary: "A new ask arrives while the reel is open, with the reel scrolled to a middle column: it joins at the end.",
                 budget: "A new ask: joins at the end, nothing moves", rule: "the new column is last, the leading column and its place in the window are unchanged; no late frame",
                 kind: .isolation, latencyBudgetMs: nil, params: ["arrivals": "3"], fixture: "needs5"),
    ScenarioSpec(name: "needs-step", summary: "⌘J through the asks: in the reel it focuses the next column; outside it opens each ask's agent in its project, oldest first, round again.",
                 budget: "⌘J: first frame ≤ 50 ms", rule: "median latency from nextAsk() to the next frame ≤ 50 ms; the asks come oldest first, one at a time",
                 kind: .latency, latencyBudgetMs: 50, params: [:], fixture: "needs5"),
    ScenarioSpec(name: "needs-empty", summary: "Answer every ask until \"Nothing needs you.\", then Esc back to where the reel was opened from.",
                 budget: "Answer an ask: the column slides out with no dropped frame", rule: "no late frame; the end state shows \"Nothing needs you.\"; Esc (a key event to the window) closes the reel and gives the focus back",
                 kind: .smooth, latencyBudgetMs: nil, params: [:], fixture: "needs5"),
    ScenarioSpec(name: "needs-swipe", summary: "A recorded (or synthetic) trackpad gesture replayed into the Needs you reel's scroll view, as `swipe` does for the project reel.",
                 budget: "Reel scroll: no dropped frames at 120 Hz", rule: "no late frame while the reel moves; the content within 1 pt of the fingers (p95) with no stall; it lands on a column edge",
                 kind: .smooth, latencyBudgetMs: nil, params: ["gesture": "synthetic:flick-forward", "swipes": "4", "from": "0", "timestamps": "recorded", "deliver": "window"], fixture: "needs5"),
    // Team (design/desktop/team; SPEC §2.2), on the `team` fixture's profile routes.
    ScenarioSpec(name: "team-open", summary: "With the sidebar open, click the Team button in its foot (a real click) and back, repeatedly: the roster by project and the first profile's pane, then the agents again.",
                 budget: "Open Team: first frame ≤ 50 ms", rule: "median latency from the click to the frame with the roster and the profile's pane header ≤ 50 ms; checks: opened, roster, closed",
                 kind: .latency, latencyBudgetMs: 50, params: ["opens": "4"], fixture: "team"),
    ScenarioSpec(name: "team-switch", summary: "With Team open, click roster rows (real clicks) across projects and All projects: each profile in the pane.",
                 budget: "Switch profile: first frame ≤ 50 ms", rule: "median latency from the click to the frame with that profile's header ≤ 50 ms; no reel or agent pane body; checks: switched, isolation",
                 kind: .latency, latencyBudgetMs: 50, params: ["clicks": "6"], fixture: "team"),
    ScenarioSpec(name: "team-settings", summary: "With Team open on an installed profile, open and close its settings row in place, then step a number (− / +) that is written to its file.",
                 budget: "Expand the settings row: first frame ≤ 50 ms", rule: "median latency from the toggle to the frame with (or without) its rows ≤ 50 ms; checks: summary, rows, written",
                 kind: .latency, latencyBudgetMs: 50, params: ["toggles": "6"], fixture: "team"),
    ScenarioSpec(name: "settings-open", summary: "Open the Settings window (as ⌘, does) on the Settings fixture's daemon and wait for the first frame with the sidebar and General.",
                 budget: "Open Settings: first frame ≤ 100 ms", rule: "median latency from the window's creation to the frame with General ≤ 100 ms; checks: opened, status, needs-you",
                 kind: .latency, latencyBudgetMs: 100, params: [:]),
    ScenarioSpec(name: "settings-switch-page", summary: "In Settings, click every page's row in the sidebar (real clicks), then the Cloud place's row on Runs (its page pushed) and Back.",
                 budget: "Switch Settings page: first frame ≤ 50 ms", rule: "median latency from the click to the frame with that page ≤ 50 ms; checks: switched, place-pushed, back",
                 kind: .latency, latencyBudgetMs: 50, params: ["rounds": "1", "end": ""]),
  ]
  public static func spec(_ name: String) -> ScenarioSpec? { all.first { $0.name == name } }
  /// The scenarios `suite` runs, in order.
  public static let suite = ["open", "switch", "step", "jump", "fling", "burst", "typing", "resize", "follow", "palette-open", "palette-type", "palette-keys"]
  /// The fixture every scenario without one of its own runs on (the manifest's `defaultFixture`).
  public static let defaultFixture = "crew17"
  /// The fixture `scenario` runs on unless told otherwise: its own (Search ⌘K's need hundreds of searchable items, the
  /// Needs you reel's need asks across projects), else the default.
  public static func fixture(for scenario: String) -> String { spec(scenario)?.fixture ?? defaultFixture }
}
