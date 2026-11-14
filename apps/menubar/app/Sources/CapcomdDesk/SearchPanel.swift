#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdUI

// Search ⌘K's window: a real NSPanel, as Spotlight's, floating over the desk window as its child (it moves with it and
// never covers other apps). Non-activating and key-capable: it takes the keyboard for its field while the desk window
// stays the main window. Its ground is the system's vibrancy (NSVisualEffectView, behind-window blending) cut to 18 pt
// corners, with the system window shadow. The SwiftUI content (SearchView) is hosted in it on the same DeskModel.
//
// Keys the field mustn't see are taken in `sendEvent`, before the field editor: ↑ ↓ (and ⌃P ⌃N) move, ↩ opens, ⌘↩ opens
// in a split, Esc closes. The panel closes when it loses the keyboard (a click outside, another app).

/// Where the desk's overlays put the palette: a zero-size view that knows the desk window, and shows or hides the panel
/// as `open` changes.
struct SearchPanelHost: NSViewRepresentable {
  @Environment(DeskModel.self) private var model
  let open: Bool
  func makeCoordinator() -> SearchPanelController { SearchPanelController() }
  func makeNSView(context: Context) -> NSView { NSView(frame: .zero) }
  func updateNSView(_ v: NSView, context: Context) {
    let c = context.coordinator
    c.attach(model)
    // The view may not be in its window yet on the first update: show once it is.
    if open { DispatchQueue.main.async { [weak v] in if let w = v?.window, c.model?.paletteOpen == true { c.show(over: w) } } }
    else { c.hide() }
  }
  static func dismantleNSView(_ v: NSView, coordinator: SearchPanelController) { coordinator.hide() }
}

@MainActor package final class SearchPanelController {
  private(set) weak var model: DeskModel?
  private var panel: SearchPanel?
  private weak var parent: NSWindow?
  private var height: CGFloat = 0
  /// The controller of each model's window, so closing the palette from the model hides the panel at once (the
  /// keyboard goes back to the desk window before the result's action runs).
  private static var byModel: [ObjectIdentifier: WeakBox] = [:]
  private final class WeakBox { weak var c: SearchPanelController?; init(_ c: SearchPanelController) { self.c = c } }
  /// The panel showing now (the bench and the debug snapshot read it).
  package static weak var shown: SearchPanel?

  func attach(_ m: DeskModel) {
    guard model !== m else { return }
    model = m
    Self.byModel[ObjectIdentifier(m)] = WeakBox(self)
  }
  static func hide(for m: DeskModel) { byModel[ObjectIdentifier(m)]?.c?.hide() }

  /// The panel: 640 pt wide (narrower in a narrow window), centred on the window, 92 pt from its top (CommandK).
  func show(over w: NSWindow) {
    guard let model else { return }
    let p = panel ?? make(model)
    let reopen = p.isVisible && parent === w
    parent = w
    if !reopen {
      p.alphaValue = 1
      place(p, height: max(height, SearchMetrics.minHeight))
      if p.parent !== w { p.parent?.removeChildWindow(p); w.addChildWindow(p, ordered: .above) }
      // Opened with a key (⌘K) it shows at once; from a click it fades in, ease-out under 300 ms (SPEC §5); Reduce
      // Motion: a short crossfade.
      let byKey = NSApp.currentEvent?.type == .keyDown
      let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
      if !byKey {
        p.alphaValue = 0
        NSAnimationContext.runAnimationGroup { ctx in
          ctx.duration = reduce ? 0.15 : 0.18
          ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
          p.animator().alphaValue = 1
        }
      }
      p.orderFront(nil)
      p.makeKey()
      Self.shown = p
    }
    focusField(p)
  }

  /// The query field takes the keyboard (SwiftUI's focus doesn't reach a field in a panel that just became key).
  private func focusField(_ p: NSPanel, again: Bool = true) {
    guard let root = p.contentView else { return }
    if let editor = p.firstResponder as? NSTextView, editor.isFieldEditor { return }
    root.layoutSubtreeIfNeeded()
    func find(_ v: NSView) -> NSTextField? { (v as? NSTextField).flatMap { $0.isEditable ? $0 : nil } ?? v.subviews.lazy.compactMap(find).first }
    if let field = find(root) { p.makeFirstResponder(field) }
    else if again { DispatchQueue.main.async { [weak self, weak p] in if let p, p.isVisible { self?.focusField(p, again: false) } } }
  }

  func hide() {
    guard let p = panel, p.isVisible else { return }
    let wasKey = p.isKeyWindow
    p.parent?.removeChildWindow(p)
    p.orderOut(nil)
    if Self.shown === p { Self.shown = nil }
    if wasKey, let w = parent, w.isVisible { w.makeKey() }
  }

  /// The content's height changed (the results): the panel keeps its top edge.
  func resize(_ h: CGFloat) {
    height = h
    guard let p = panel, p.isVisible else { return }
    place(p, height: h)
  }

  private func place(_ p: NSPanel, height h: CGFloat) {
    guard let w = parent else { return }
    let width = SearchMetrics.width(for: w.frame.width)
    let top = w.frame.maxY - SearchMetrics.top
    let f = NSRect(x: (w.frame.midX - width / 2).rounded(), y: (top - h).rounded(), width: width, height: h.rounded(.up))
    if p.frame != f { p.setFrame(f, display: true, animate: false); p.invalidateShadow() }
  }

  private func make(_ model: DeskModel) -> SearchPanel {
    let p = SearchPanel()
    let glass = NSVisualEffectView()
    // The darkest of the system's translucent materials over the desk (measured: hudWindow, menu, popover and
    // fullScreenUI all land at 75–105 grey there); SearchColors.tint takes it to the board's ground.
    glass.material = .sheet
    glass.appearance = NSAppearance(named: .darkAqua)
    glass.blendingMode = .behindWindow
    glass.state = .active
    glass.maskImage = SearchPanel.mask(radius: SearchMetrics.radius)
    let host = NSHostingView(rootView: SearchView(onHeight: { [weak self] h in self?.resize(h) }).environment(model))
    host.sizingOptions = []
    host.autoresizingMask = [.width, .height]
    glass.addSubview(host)
    p.contentView = glass
    host.frame = glass.bounds
    p.keys = { [weak model] k in
      guard let model else { return }
      switch k {
      case .up: model.movePaletteSelection(-1)
      case .down: model.movePaletteSelection(1)
      case .open(let split): model.runPaletteSelection(split: split)
      case .close: model.closePalette()
      }
    }
    p.resigned = { [weak model] in model?.closePalette() }
    panel = p
    return p
  }
}

/// The palette's window. Borderless, so it says it can take the keyboard itself.
package final class SearchPanel: NSPanel {
  enum Key { case up, down, open(split: Bool), close }
  var keys: ((Key) -> Void)?
  var resigned: (() -> Void)?

  init() {
    super.init(contentRect: NSRect(x: 0, y: 0, width: SearchMetrics.maxWidth, height: SearchMetrics.minHeight),
               styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    isFloatingPanel = false   // a child of the desk window: above it, not above other apps
    hidesOnDeactivate = false
    becomesKeyOnlyIfNeeded = false
    isReleasedWhenClosed = false
    isOpaque = false
    backgroundColor = .clear
    hasShadow = true
    animationBehavior = .none
    appearance = NSAppearance(named: .darkAqua)
    collectionBehavior = [.fullScreenAuxiliary, .ignoresCycle]
    setAccessibilitySubrole(.dialog)
    setAccessibilityLabel("Search")
  }
  package override var canBecomeKey: Bool { true }
  package override var canBecomeMain: Bool { false }

  package override func resignKey() {
    super.resignKey()
    resigned?()
  }

  package override func sendEvent(_ e: NSEvent) {
    if e.type == .keyDown, let k = Self.key(e, composing: (firstResponder as? NSTextView)?.hasMarkedText() == true) {
      keys?(k)
      return
    }
    super.sendEvent(e)
  }

  /// The keys the panel takes from the field: never while an input method is composing.
  static func key(_ e: NSEvent, composing: Bool) -> Key? {
    guard !composing else { return nil }
    let mods = e.modifierFlags.intersection([.command, .control, .option, .shift])
    switch e.keyCode {
    case 126: return .up
    case 125: return .down
    case 36, 76: return mods == .command ? .open(split: true) : mods.isEmpty ? .open(split: false) : nil
    case 53: return .close
    default: break
    }
    if mods == .control, let c = e.charactersIgnoringModifiers {
      if c == "p" { return .up }
      if c == "n" { return .down }
    }
    return nil
  }

  /// The ground's shape: a stretchable rounded rectangle, so the vibrancy and the window shadow both follow the corners.
  static func mask(radius r: CGFloat) -> NSImage {
    let side = r * 2 + 1
    let img = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
      NSColor.black.setFill()
      NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).fill()
      return true
    }
    img.capInsets = NSEdgeInsets(top: r, left: r, bottom: r, right: r)
    img.resizingMode = .stretch
    return img
  }
}
#endif
