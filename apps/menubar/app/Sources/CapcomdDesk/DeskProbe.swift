#if canImport(SwiftUI) && os(macOS)
import Foundation

/// Where the window reports what it does, for the bench (CapcomdDeskBench) and nothing else. Each view's `body`
/// starts with `DeskProbe.body("Name")`; the reel reports its position and phase with `event`. With no sink attached
/// (the app), a call is one load of a nil and a branch, so release behaviour is as before. The bench attaches a sink
/// before it shows the window and reads counts per view type: "which views re-rendered when X happened".
@MainActor package protocol DeskProbeSink: AnyObject {
  func body(_ view: StaticString)
  /// The same, for a view that belongs to one agent (`id` is the agent id).
  func body(_ view: StaticString, id: String)
  func event(_ name: StaticString, _ value: Int)
}

@MainActor package enum DeskProbe {
  package static var sink: (any DeskProbeSink)?
  @inline(__always) package static func body(_ view: StaticString) { if let s = sink { s.body(view) } }
  @inline(__always) package static func body(_ view: StaticString, id: String) { if let s = sink { s.body(view, id: id) } }
  @inline(__always) package static func event(_ name: StaticString, _ value: Int) { if let s = sink { s.event(name, value) } }
}
#endif
