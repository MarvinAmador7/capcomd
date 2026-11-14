#if canImport(SwiftUI) && os(macOS)
import PerfLoopProbe

/// The desktop window's runtime knobs (design/perf-loop CAPABILITIES.md C4): decisions the bench can measure again
/// without a rebuild, `PERFLOOP_KNOBS=reel.slide=clip` (deskbench: `--knob reel.slide=clip`). Without the variable
/// every knob reads its default, which is the window's behaviour as it is. A knob is read once (the reel keeps its
/// value), never per frame. A knob the loop promotes becomes the code's only behaviour and is deleted from here.
package enum DeskKnobs {
  package enum Slide: String, KnobValue, CaseIterable {
    /// The scroll offset moves once and the document layer slides in the render server (ReelView.slide).
    case ca
    /// The clip view is scrolled frame by frame (NSClipView's animator), as before e6d3625: every column's hosting
    /// view updates on every frame of a slide.
    case clip
  }

  /// How a crew tab, a shortcut or Follow slides the reel.
  package static let reelSlide = Knob("reel.slide", default: Slide.ca, choices: Slide.allCases,
                                      summary: "how an animated reel move slides: ca = the render server moves the document layer, clip = the clip view scrolls frame by frame",
                                      since: "0.7")

  /// How many off-screen columns the reel builds per turn of the run loop while it stands still, after opening a project.
  package static let buildPerFrame = Knob("build.perFrame", default: 1, range: 1...8,
                                          summary: "off-screen columns built per frame after a project opens (heads-first open), nearest first",
                                          since: "0.7")

  package enum Layout: String, KnobValue, CaseIterable {
    /// The reel's columns at the fractional width the window divides into (today's reel).
    case auto
    /// The frame engine (ReelLayout.swift): column width and pitch snapped to device pixels, frames placed once per
    /// geometry change. A column then sits on a pixel at every scroll offset, so a step no longer makes each column's
    /// SwiftUI scroll view re-snap its origin (and update its graph).
    case frames
    /// `frames`, and the columns away from the screen are hidden while the reel rests: AppKit's per-frame passes
    /// (tracking areas, display) skip hidden subtrees. A move shows the columns it will pass first.
    case framesHide = "frames-hide"
  }

  /// How the reel lays out its columns (design note: apps/menubar/app/LAYOUT.md).
  package static let deskLayout = Knob("desk.layout", default: Layout.auto, choices: Layout.allCases,
                                       summary: "how the reel places its columns: auto = fractional widths (today), frames = pixel-snapped frames placed once per geometry change, frames-hide = frames + far columns hidden at rest",
                                       since: "0.7")

  package enum ColumnKind: String, KnobValue, CaseIterable {
    /// One SwiftUI hosting view per column: `Column` (head, thread, box, frame and stroke).
    case swiftui
    /// An AppKit column (NativeColumn.swift): the frame, fill, corner and stroke are its layer's, the head and the body
    /// (thread and box) are two hosting views it places by frame. A focus or ask change sets a layer border instead of
    /// re-rendering and re-laying out the column's SwiftUI tree.
    case native
  }

  /// What a column is made of.
  package static let deskColumn = Knob("desk.column", default: ColumnKind.swiftui, choices: ColumnKind.allCases,
                                       summary: "what a column is: swiftui = one hosting view of Column, native = an AppKit column (layer frame and stroke) placing a head and a body hosting view",
                                       since: "0.7")

  package enum Columns: String, KnobValue, CaseIterable {
    /// One view per column in the reel's document, built once and kept while its agent is in the run.
    case keep
    /// The same views, but only the columns on screen and one each side are in the scrolling document while the reel
    /// rests; the rest wait in a hidden container that never moves, with a blank stand-in in their place. A scroll
    /// moves (and SwiftUI re-places) five hosting views instead of every column's.
    case park
    /// Virtualised: a fixed set of AppKit column slots (two screens and one each side) stays in the document for good,
    /// placed by frame; as the reel moves, a slot that leaves is configured in place with the agent coming into view,
    /// before the move starts, and spare slots prefetch the next screen while the reel rests. Nothing is added,
    /// removed or re-parented; the columns without a slot are a replicated placeholder layer. Always AppKit columns
    /// (`desk.column` is ignored): a slot is a native column.
    case reuse
  }

  /// What the reel's scrolling document holds.
  package static let reelColumns = Knob("reel.columns", default: Columns.keep, choices: Columns.allCases,
                                        summary: "keep = every built column in the scrolling document; park = only those near the screen, the rest in a still, hidden container; reuse = a fixed set of native column slots configured in place as the reel moves",
                                        since: "0.7")

  package enum Cache: String, KnobValue, CaseIterable {
    /// The live columns move with the reel (today).
    case off
    /// A slide moves bitmaps: the columns it shows are drawn once into layer contents (kept until the column's
    /// content changes or you touch it), those layers slide in an overlay, and the reel's offset moves under them once
    /// the slide ends; then the live columns show again.
    case bitmap
  }

  /// What moves during a slide.
  package static let reelCache = Knob("reel.cache", default: Cache.off, choices: Cache.allCases,
                                      summary: "off = the live columns slide (today); bitmap = cached bitmaps of the columns slide in an overlay, the live reel moves once at rest",
                                      since: "0.7")

  package enum Release: String, KnobValue, CaseIterable {
    /// The reel lands on the column it chose, and AppKit's own deceleration ends when the fingers lift (ReelRelease).
    case land
    /// AppKit's deceleration is left running, as before 2026-11-04: it carries the reel past the column it chose
    /// (a slow drag rested 25–31 pt off a column edge).
    case appkit
  }

  /// What happens to AppKit's own deceleration when a swipe's fingers lift.
  package static let reelRelease = Knob("reel.release", default: Release.land, choices: Release.allCases,
                                        summary: "land = the reel ends AppKit's own deceleration when the fingers lift, so it rests on the column it chose; appkit = left running (before 2026-11-04: it carried the reel off the column edge)",
                                        since: "0.10")

  package enum SearchHost: String, KnobValue, CaseIterable {
    /// Its own NSPanel, a child of the window that takes the keyboard (Spotlight's way): opening and closing it change
    /// the key window, and every column re-resolves its key-state styling.
    case panel
    /// A layer over the reel inside the window, the same view on the system's vibrancy: the window keeps the keyboard.
    case overlay
  }

  /// What hosts Search ⌘K (SearchPanel.swift, SearchView.swift).
  package static let searchHost = Knob("search.host", default: SearchHost.overlay, choices: SearchHost.allCases,
                                       summary: "panel = Search ⌘K in its own key panel over the window; overlay = the same view inside the window, which keeps the keyboard",
                                       since: "0.12")

  /// Every knob of the window. A new knob goes here too, or `describe` won't list it.
  package static var knobs: [any AnyKnob] { [reelSlide, buildPerFrame, deskLayout, deskColumn, reelColumns, reelCache, reelRelease, searchHost] }
  /// What `describe` lists, by name.
  package static var all: [KnobInfo] { knobs.map(\.info).sorted { $0.name < $1.name } }
  /// The full knob vector this process runs with, defaults included (a result's `knobs`).
  package static var vector: [String: String] { Dictionary(uniqueKeysWithValues: knobs.map { ($0.info.name, $0.valueText) }) }
  /// What is wrong with PERFLOOP_KNOBS: a name no knob has, a value a knob refused (it then runs with its default).
  package static var problems: [String] { _ = knobs; return Knobs.problems }
}
#endif
