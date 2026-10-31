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

  /// Every knob, made (and so registered) first.
  package static var all: [KnobInfo] { register(); return Knobs.registered }
  /// The full knob vector this process runs with, defaults included.
  package static var vector: [String: String] { register(); return Knobs.vector }
  /// What is wrong with PERFLOOP_KNOBS: a name no knob has, a value a knob refused (it then runs with its default).
  package static var problems: [String] { register(); return Knobs.problems }

  private static func register() { _ = reelSlide; _ = buildPerFrame }
}
#endif
