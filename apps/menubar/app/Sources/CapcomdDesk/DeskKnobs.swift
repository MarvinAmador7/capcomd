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
  }

  /// What the reel's scrolling document holds.
  package static let reelColumns = Knob("reel.columns", default: Columns.keep, choices: Columns.allCases,
                                        summary: "keep = every built column in the scrolling document; park = only those near the screen, the rest in a still, hidden container",
                                        since: "0.7")

  /// Every knob of the window. A new knob goes here too, or `describe` won't list it.
  package static var knobs: [any AnyKnob] { [reelSlide, buildPerFrame, deskLayout, deskColumn, reelColumns] }
  /// What `describe` lists, by name.
  package static var all: [KnobInfo] { knobs.map(\.info).sorted { $0.name < $1.name } }
  /// The full knob vector this process runs with, defaults included (a result's `knobs`).
  package static var vector: [String: String] { Dictionary(uniqueKeysWithValues: knobs.map { ($0.info.name, $0.valueText) }) }
  /// What is wrong with PERFLOOP_KNOBS: a name no knob has, a value a knob refused (it then runs with its default).
  package static var problems: [String] { _ = knobs; return Knobs.problems }
}
#endif
