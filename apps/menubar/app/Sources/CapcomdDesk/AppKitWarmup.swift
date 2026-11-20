#if canImport(SwiftUI) && os(macOS)
import AppKit

/// AppKit's one-time work, done ahead so the first shortcut doesn't pay for it (knob `desk.prewarm`). Two costs land on
/// the first ⌘K in a process, on top of the palette itself (built ahead by `PaletteWarmer`), measured on DeskBench's
/// `palette-first` (its stacks):
/// - the menu bar's first key equivalent, ~10 ms: AppKit fills the menus before it looks for the item, and the first
///   time it makes the Window menu's tiling and Sidecar items (their symbol images, a fetch of the Sidecar devices);
///   later key equivalents fill them again in ~2 ms;
/// - the first text field to take the keyboard, ~8–10 ms: its text input context is activated for the first time
///   (the text cursor's controller makes its window, the input mode is read).
///
/// `start` runs each on a main-queue turn of its own after the palette's, so a key or a click in between goes first.
/// Neither shows anything or moves the keyboard: the key equivalent matches no item, and the field is a transparent
/// one-point field that has the keyboard only inside one turn, given back to the window before anything draws.
@MainActor enum AppKitWarmup {
  private static var menuDone = false
  private static var fieldDone = false

  /// Once the window has drawn and the palette is built (`PaletteWarmer`): `host` is a view in the window.
  static func start(in host: NSView) {
    let k = DeskKnobs.prewarm.value
    guard k != .none else { return }
    DispatchQueue.main.async {
      if k.menu { warmMenu() }
      DispatchQueue.main.async { [weak host] in if k.field, let host { warmField(in: host) } }
    }
  }

  /// A key equivalent no item has, through the menu bar: AppKit fills the menus as it does for any key equivalent (the
  /// first time is the dear one: the Window menu's tiling and Sidecar items, their symbol images, a fetch of the Sidecar
  /// devices), finds no item, and fires nothing, so no menu title flashes. The key is ⌃⌥⇧⌘F20: no Mac keyboard has F20,
  /// and when an item has F20 anyway (a service a user bound to it) nothing is pressed. AppKit fills the menus only for
  /// a key a menu item could have: a character no key types skips the pass and warms nothing.
  static func warmMenu() {
    guard !menuDone, let menu = NSApp.mainMenu else { return }
    menuDone = true
    guard let cg = CGEvent(keyboardEventSource: CGEventSource(stateID: .privateState), virtualKey: 0x5A, keyDown: true) else { return }
    cg.flags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]
    guard let e = NSEvent(cgEvent: cg), let key = e.charactersIgnoringModifiers?.lowercased(), !key.isEmpty else { DeskProbe.event("warm.menu.skipped", 1); return }
    func bound(_ m: NSMenu) -> Bool { m.items.contains { $0.keyEquivalent.lowercased() == key || $0.submenu.map(bound) == true } }
    guard !bound(menu) else { DeskProbe.event("warm.menu.skipped", 2); return }
    let t = DispatchTime.now().uptimeNanoseconds
    let fired = menu.performKeyEquivalent(with: e)
    DeskProbe.event("warm.menu.us", Int((DispatchTime.now().uptimeNanoseconds - t) / 1000))
    if fired { DeskProbe.event("warm.menu.fired", 1) }
  }

  /// A transparent one-point field takes the keyboard and gives it straight back to the window, in one turn. Only when
  /// nothing has the keyboard (the window itself is the first responder), the window is key, and no assistive app
  /// follows the focus (VoiceOver, Switch Control): otherwise the first field pays as before.
  static func warmField(in host: NSView) {
    guard !fieldDone, let w = host.window, w.isKeyWindow, w.firstResponder === w, w.attachedSheet == nil,
          !NSWorkspace.shared.isVoiceOverEnabled, !NSWorkspace.shared.isSwitchControlEnabled else { return }
    fieldDone = true
    let f = NSTextField(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    f.alphaValue = 0
    f.isBordered = false
    f.drawsBackground = false
    f.setAccessibilityElement(false)
    host.addSubview(f)
    let t = DispatchTime.now().uptimeNanoseconds
    let took = w.makeFirstResponder(f)
    w.makeFirstResponder(nil)
    DeskProbe.event("warm.field.us", Int((DispatchTime.now().uptimeNanoseconds - t) / 1000))
    f.removeFromSuperview()
    if !took { DeskProbe.event("warm.field.refused", 1) }
  }
}
#endif
