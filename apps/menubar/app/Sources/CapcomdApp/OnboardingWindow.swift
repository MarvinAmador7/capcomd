#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI
import CapcomdDesk
import CapcomdOnboarding

/// The onboarding's window: borderless and transparent, centred on the screen, so the bot comes on the air on the
/// desktop itself; the window grows out of him (IntroCanvasView) and is an ordinary window after that (its own close
/// and minimize buttons, its shadow once the backdrop has filled it).
final class OnboardingPanel: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
  override func performClose(_ sender: Any?) { close() }
  override func performMiniaturize(_ sender: Any?) { miniaturize(sender) }
}

/// When the onboarding shows (Gate), its window, and what happens when it ends.
@MainActor final class OnboardingController: NSObject, NSWindowDelegate {
  static var shared: OnboardingController?
  let session: AppSession, app: AppModel, desk: DeskModel
  private(set) var window: OnboardingPanel?
  private(set) var model: OnboardingModel?
  private var buttons: [NSButton] = []
  /// The main window waits while the onboarding is up at the first launch (MainWindowHold).
  static var holdsMainWindow = false
  private var watching: Timer?
  /// Closed without finishing: it doesn't come back by itself until the next launch.
  private var dismissed = false
  private var defaults: UserDefaults { .standard }

  init(session: AppSession, app: AppModel, desk: DeskModel) {
    self.session = session; self.app = app; self.desk = desk
    super.init()
    Self.holdsMainWindow = Gate.holdsMainWindow(record)
  }

  var record: Record { Record { UserDefaults.standard.bool(forKey: $0) } }

  /// At launch: the first time, the onboarding (with the intro); later, it waits to see whether the app can connect.
  func launched() {
    OnboardFonts.register()
    let r = record
    if Gate.shows(r, link: .unknown) {
      show(step: Gate.firstStep(r), intro: Gate.playsIntro(r, asked: false, reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion))
    }
    watch()
    OnboardingDebug.attach(self)   // development only: its control, whether or not the onboarding showed
  }

  /// Until it's finished, the onboarding comes back (at boot) whenever the app can't reach or pair with capcomd.
  private func watch() {
    watching?.invalidate()
    watching = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.window == nil, !self.dismissed else { return }
        let r = self.record
        if r.finished { self.watching?.invalidate(); return }
        if Gate.shows(r, link: self.link, dismissed: self.dismissed) { self.show(step: .boot, intro: false) }
      }
    }
  }

  private var link: OnboardLink {
    switch session.token {
    case .reading, .pairing: return .unknown
    case .needsCLI, .failed, .rejected: return .needsSetup
    case .ready: return desk.unreachable ? .needsSetup : session.store.daemonLoaded ? .connected : .unknown
    }
  }

  /// Settings › General › Show onboarding again: from the welcome screen, with the intro.
  func showAgain() {
    if let w = window { w.makeKeyAndOrderFront(nil); return }
    show(step: .welcome, intro: Gate.playsIntro(record, asked: true, reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion))
  }

  func show(step: OnboardStep, intro: Bool) {
    guard window == nil else { window?.makeKeyAndOrderFront(nil); return }
    OnboardFonts.register()
    let m = OnboardingModel(session: session, app: app, desk: desk, step: step, intro: intro)
    // Back at boot without the intro: the earlier steps were done once, so it opens on the step that's needed.
    let size = IntroCanvasView.size
    let w = OnboardingPanel(contentRect: CGRect(origin: .zero, size: size), styleMask: [.closable, .miniaturizable], backing: .buffered, defer: false)
    w.isOpaque = false
    w.backgroundColor = .clear
    w.hasShadow = !intro
    w.isMovableByWindowBackground = true
    w.isReleasedWhenClosed = false
    w.title = "Set up capcomd"
    w.identifier = NSUserInterfaceItemIdentifier("onboarding")
    w.delegate = self
    w.animationBehavior = .none
    let root = NSView(frame: CGRect(origin: .zero, size: size))
    root.wantsLayer = true
    let host = NSHostingView(rootView: OnboardingView(model: m))
    host.frame = root.bounds
    host.autoresizingMask = [.width, .height]
    root.addSubview(host)
    // The window's own buttons where the prototype draws its traffic lights (12 across, 8 apart, 16 in, centred on the
    // 40 pt title bar).
    buttons = []
    for (i, kind) in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].enumerated() {
      guard let b = NSWindow.standardWindowButton(kind, for: [.titled, .closable, .miniaturizable]) else { continue }
      let s = b.frame.size
      b.setFrameOrigin(CGPoint(x: 22 + Double(i) * 20 - s.width / 2, y: size.height - 20 - s.height / 2))
      if kind == .zoomButton { b.isEnabled = false }
      b.alphaValue = intro ? 0 : 1
      root.addSubview(b)
      buttons.append(b)
    }
    w.contentView = root
    w.center()
    m.windowOpened = { [weak w] in w?.hasShadow = true; w?.invalidateShadow() }
    m.onClose = { [weak self] finished, runId in self?.end(finished: finished, runId: runId) }
    if intro {
      DispatchQueue.main.asyncAfter(deadline: .now() + Intro.windowOpens + 0.35) { [weak self] in
        NSAnimationContext.runAnimationGroup { c in
          c.duration = 0.8
          for b in self?.buttons ?? [] { b.animator().alphaValue = 1 }
        }
      }
    }
    window = w; model = m
    AppPresence.windowOpening()
    w.makeKeyAndOrderFront(nil)
    OnboardingDebug.attach(self)
  }

  /// Open capcomd (finished) or the window's close button: the main window, on the run that was launched.
  private func end(finished: Bool, runId: String?) {
    Self.holdsMainWindow = false
    if !finished { dismissed = true }
    let w = window
    window = nil
    model?.stop(); model = nil
    w?.orderOut(nil)
    MainWindow.show()
    if let runId { Task { @MainActor in await self.open(run: runId) } }
    w?.close()
  }

  /// The window on the run, once the store lists it (a run that just started may take a moment).
  private func open(run runId: String) async {
    for _ in 0..<50 {
      if desk.decks.contains(where: { $0.runId == runId }) { desk.show(run: runId); return }
      try? await Task.sleep(for: .milliseconds(200))
    }
    desk.show(run: runId)
  }

  func windowWillClose(_ n: Notification) {
    guard window != nil else { return }   // closed by end()
    model?.closed()
    end(finished: false, runId: nil)
  }
}

/// The main window, held back while the first onboarding is up (shown again by MainWindow.show).
struct MainWindowHold: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView { Probe() }
  func updateNSView(_ v: NSView, context: Context) {}
  final class Probe: NSView {
    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      guard let w = window, OnboardingController.holdsMainWindow else { return }
      w.alphaValue = 0
      DispatchQueue.main.async {
        guard OnboardingController.holdsMainWindow else { w.alphaValue = 1; return }
        w.orderOut(nil)
        w.alphaValue = 1
        AppPresence.update()
      }
    }
  }
}
#endif
