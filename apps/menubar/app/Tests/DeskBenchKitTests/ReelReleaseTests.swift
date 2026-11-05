import AppKit
import QuartzCore
import XCTest
@testable import CapcomdDesk

/// The reel's landing after a swipe (Reel.swift, ReelRelease): when the fingers lift, AppKit begins a deceleration of
/// its own, and the reel ends it with a momentum-ended event so it rests on the column it chose. Windowless: a scroll
/// view in a window that is never shown, and AppKit's live-scroll notifications to tell whether its scroll is over.
@MainActor final class ReelReleaseTests: XCTestCase {
  /// A scroll view that, like the reel's, overrides scrollWheel (AppKit's single-threaded scrolling, not responsive).
  final class Scroll: NSScrollView { override func scrollWheel(with e: NSEvent) { super.scrollWheel(with: e) } }

  private func event(dx: Int32, phase: CGScrollPhase?, momentum: CGMomentumScrollPhase = .none, at t: Double) -> NSEvent {
    let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: 0, wheel2: dx, wheel3: 0)!
    cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: Double(dx))
    cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: Double(dx))
    cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase?.rawValue ?? 0))
    cg.setIntegerValueField(.scrollWheelEventMomentumPhase, value: Int64(momentum.rawValue))
    cg.timestamp = CGEventTimestamp(t * 1e9)
    return NSEvent(cgEvent: cg)!
  }

  func testTheMomentumEndedEventCarriesNoMovement() {
    let release = event(dx: -12, phase: .ended, at: 100)
    let end = ReelRelease.momentumEnded(after: release)!
    XCTAssertEqual(end.type, .scrollWheel)
    XCTAssertEqual(end.phase, [])
    XCTAssertEqual(end.momentumPhase, .ended)
    XCTAssertEqual(end.scrollingDeltaX, 0)
    XCTAssertEqual(end.scrollingDeltaY, 0)
    XCTAssertTrue(end.hasPreciseScrollingDeltas)
    XCTAssertEqual(end.timestamp, release.timestamp, accuracy: 1e-6)
    XCTAssertNil(ReelRelease.momentumEnded(after: NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0,
                                                                        windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0)!))
  }

  /// A swipe with real timestamps, fingers lifted: AppKit's live scroll goes on (its own deceleration) until the
  /// momentum-ended event, which ends it at once.
  func testTheMomentumEndedEventEndsAppKitsDeceleration() {
    _ = NSApplication.shared
    func swipe(endingWith end: Bool) -> Bool {
      let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 800, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      let sv = Scroll(frame: NSRect(x: 0, y: 0, width: 800, height: 400))
      sv.documentView = NSView(frame: NSRect(x: 0, y: 0, width: 8000, height: 400))
      sv.verticalScrollElasticity = .none
      window.contentView = sv
      sv.contentView.setBoundsOrigin(NSPoint(x: 3000, y: 0))
      var ended = false
      let o = NotificationCenter.default.addObserver(forName: NSScrollView.didEndLiveScrollNotification, object: sv, queue: nil) { _ in ended = true }
      defer { NotificationCenter.default.removeObserver(o); window.close() }
      var t = CACurrentMediaTime()
      sv.scrollWheel(with: event(dx: -1, phase: .began, at: t))
      for _ in 0..<6 { t += 0.008; sv.scrollWheel(with: event(dx: -20, phase: .changed, at: t)) }   // 2500 pt/s
      let release = event(dx: 0, phase: .ended, at: t + 0.0001)
      sv.scrollWheel(with: release)
      if end, let e = ReelRelease.momentumEnded(after: release) { sv.scrollWheel(with: e) }
      RunLoop.main.run(until: Date().addingTimeInterval(0.05))
      return ended
    }
    XCTAssertFalse(swipe(endingWith: false), "AppKit no longer keeps a released swipe's scroll going: ReelRelease may have nothing left to end")
    XCTAssertTrue(swipe(endingWith: true), "the momentum-ended event didn't end AppKit's scroll: the reel would be carried off its column")
  }
}
