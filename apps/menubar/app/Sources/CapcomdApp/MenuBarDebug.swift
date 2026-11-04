#if canImport(SwiftUI) && os(macOS) && DEBUG
import SwiftUI
import AppKit
import CapcomdStore

/// Development only: with CAPCOMD_MENUBAR_CONTROL=<dir>, the panel is also hosted in a borderless window far off screen
/// (it never shows, takes no focus and needs no click), driven by the lines of <dir>/cmd each half second (then deleted):
/// `goal <text>` (the composer's goal), `branch <name>` / `base <name>` (its goal branch row), `start` (Return in the
/// composer), `card <runId> open|confirm|cancel|keep` (its Ready bar's buttons), `run <runId> [agentId]` (a row: the window opens there), `tree <N>` (the Nth card's tree, as its chevron shows it), `snap <name>` (the panel into
/// <dir>/<name>.png). <dir>/state.txt says what the panel shows. For checks against the mock (client/mock).
@MainActor enum MenuBarDebug {
  static let goal = Notification.Name("capcomd.debug.goal"), start = Notification.Name("capcomd.debug.start")
  private static var window: NSWindow?

  static func start(_ model: AppModel) {
    guard let dir = ProcessInfo.processInfo.environment["CAPCOMD_MENUBAR_CONTROL"], !dir.isEmpty else { return }
    let w = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 460, height: 760), styleMask: .borderless, backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.backgroundColor = NSColor(white: 0.12, alpha: 1)
    w.appearance = NSAppearance(named: .darkAqua)
    w.contentView = NSHostingView(rootView: PanelView().environment(model).frame(width: 460))
    w.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    w.orderBack(nil)
    window = w
    let d = URL(fileURLWithPath: dir)
    Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in MainActor.assumeIsolated { control(model, d) } }
  }

  static func control(_ model: AppModel, _ dir: URL) {
    let cmd = dir.appendingPathComponent("cmd")
    if let text = try? String(contentsOf: cmd, encoding: .utf8) {
      try? FileManager.default.removeItem(at: cmd)
      for line in text.split(separator: "\n") {
        let w = line.split(separator: " ", maxSplits: 1).map(String.init)
        switch w.first {
        case "goal": NotificationCenter.default.post(name: goal, object: w.count > 1 ? w[1] : "")
        case "branch": model.goalSetup.typeBranch(w.count > 1 ? w[1] : "")
        case "base": if w.count > 1 { model.goalSetup.pickBase(w[1]) }
        case "start": NotificationCenter.default.post(name: start, object: nil)
        case "card":   // card <runId> open|confirm|cancel|keep: the Ready bar's buttons
          let a = w.count > 1 ? w[1].split(separator: " ").map(String.init) : []
          guard a.count == 2, let c = model.goalCard(a[0]) else { break }
          switch a[1] { case "open": model.openPullRequest(c); case "confirm": model.confirmPullRequest(a[0]); case "cancel": model.cancelGoalAction(a[0]); case "keep": model.keepBranch(a[0]); default: break }
        case "run":   // run <runId> [agentId]: a row click, the window opened there
          let a = w.count > 1 ? w[1].split(separator: " ").map(String.init) : []
          if let r = a.first { model.open(run: r, agent: a.count > 1 ? a[1] : nil) }
        case "tree": if let n = w.dropFirst().first.flatMap(Int.init), model.projects.indices.contains(n - 1) { model.treeShown.insert(model.projects[n - 1].id) }   // its card's chevron
        case "snap": if w.count > 1 { snap(dir.appendingPathComponent("\(w[1]).png")) }
        default: break
        }
      }
    }
    var out = ["selection \(model.selection.map { "\($0.runId) \($0.agentId ?? "-")" } ?? "-") startRepo \(model.startRepo ?? "-") offered \(model.goalBranchesOffered) start \(model.startState) refused \(model.startRefusedField ?? "-")"]
    let s = model.goalSetup
    out.append("setup path \(s.path ?? "-") base \(s.base ?? "-") branch \(s.goalBranch) canStart \(s.canStart) note \(s.note?.text ?? "-")")
    for p in model.projects { for r in p.runs { if let g = model.goalCard(r.id) { out.append("goal \(r.id) \(g.title) \(g.phase) docks \(g.docks) outcome \(g.outcome.map { "\($0)" } ?? "-")") } } }
    try? (out.joined(separator: "\n") + "\n").write(to: dir.appendingPathComponent("state.txt"), atomically: true, encoding: .utf8)
  }

  static func snap(_ url: URL) {
    guard let v = window?.contentView else { return }
    let size = v.fittingSize
    window?.setContentSize(NSSize(width: 460, height: max(200, min(size.height, 1400))))
    v.layoutSubtreeIfNeeded()
    guard let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return }
    v.cacheDisplay(in: v.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: url)
  }
}
#endif
