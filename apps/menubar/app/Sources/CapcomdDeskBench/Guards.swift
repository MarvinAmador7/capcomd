import AppKit
import Foundation
import CapcomdDesk
import DeskBenchKit
import PerfLoopHost
import PerfLoopKit

/// `built-within` (DeskBenchKit/Guards.swift, C6), judged by PerfLoopHost after each rep with the window still up, off
/// the rep's clock: every on-screen column of the reel (the Needs you reel while it is open) built from the probe's
/// bodies, warm, and a hosting view with something in it, by `built-within.ms` after the window came to rest.
@MainActor enum BuiltWithinGuard {
  static func judge(_ run: HostRun, _ params: [String: Double]) async -> GuardResult {
    guard let d = Desk.current, d.run === run, run.window != nil else {
      return GuardResult(name: Guards.builtWithin, pass: false, detail: "the scenario showed no desk window: nothing to judge")
    }
    // Settle: the main thread quiet for 300 ms (a project opens heads first and warms its threads after, over a second
    // or more, and that is the window, not a cheat), then the limit.
    let quiet = await run.settle(quietMs: 300, timeoutMs: 8000)
    let settleAt = run.now - (quiet ? 300 : 0)
    let limit = params["built-within.ms"] ?? Guards.defaults["built-within.ms"] ?? 300
    await run.sleep(ms: limit + 50)
    _ = await d.nextCommit()
    let cols = onScreen(d)
    let bodies = d.bodies.filter { $0.t >= d.columnsSince }.map { BuiltWithin.Body(t: $0.t, view: $0.view, id: $0.id) }
    var g = BuiltWithin.evaluate(columns: cols.filter { !$0.partial }.map(\.column), bodies: bodies, since: d.columnsSince, settleAt: settleAt, limitMs: limit)
    g.detail += quiet ? "" : " [never quiet within 8 s]"
    return g
  }

  struct Shown { var column: BuiltWithin.Column; var partial = false }

  /// The columns the reel shows: its document's views, left to right, those in the visible part (`partial` when less
  /// than half of one shows), mapped to the model's columns by position (one view per column: a hosting view, an
  /// AppKit column holding hosting views, or the blank before it is built).
  static func onScreen(_ d: Desk) -> [Shown] {
    // The Needs you reel, while it is open, is the reel on screen (the project reel stays built, hidden, under it).
    let needs = d.model.needs.isOpen
    let ids = needs ? d.model.needs.columns : d.model.columns
    func col(_ id: String, view: String?) -> BuiltWithin.Column {
      BuiltWithin.Column(id: id, expectsRows: !(d.world.threads[id] ?? []).isEmpty, warm: d.model.agent(id)?.warm, view: view)
    }
    let reel = d.reel(needs ? .needs : .project)
    guard let sv = reel?.reelScrollView ?? d.reelScrollView(), let doc = sv.documentView else {
      return ids.filter(d.model.onScreen.contains).map { Shown(column: col($0, view: "missing")) }
    }
    let views: [NSView?]
    if let reel, reel.columnCount == ids.count {
      views = ids.indices.map { reel.columnView(at: $0) }
    } else {
      let byX = doc.subviews.sorted { $0.frame.minX < $1.frame.minX }
      guard byX.count == ids.count else { return ids.filter(d.model.onScreen.contains).map { Shown(column: col($0, view: nil)) } }
      views = byX
    }
    let visible = sv.documentVisibleRect
    var out: [Shown] = []
    for (i, (view, id)) in zip(views, ids).enumerated() {
      guard let v = view else {
        // No view shows this column: the reel's placeholder, if it is in view.
        let f = reel?.columnFrame(at: i) ?? .null, part = f.intersection(visible)
        if !part.isNull, part.width >= 1 { out.append(Shown(column: col(id, view: "placeholder"), partial: part.width < f.width / 2)) }
        continue
      }
      let part = v.frame.intersection(visible)
      guard !part.isNull, part.width >= 1 else { continue }
      // Its content: the view itself when it is a hosting view (a SwiftUI column), else the hosting views inside it (an
      // AppKit column, desk.column=native). The reel's blank placeholder has none; a hidden view shows nothing.
      var hosting: [NSView] = []
      d.walk(v) { x in if String(describing: type(of: x)).contains("HostingView") { hosting.append(x) } }
      let kind: String
      if hosting.isEmpty { kind = "placeholder" }
      else if v.isHidden || v.alphaValue == 0 { kind = "hidden" }
      else { kind = hosting.allSatisfy { $0.subviews.isEmpty && ($0.layer?.sublayers ?? []).isEmpty } ? "empty" : "hosting" }
      out.append(Shown(column: col(id, view: kind), partial: part.width < v.frame.width / 2))
    }
    return out
  }
}
