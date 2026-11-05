import AppKit
import ObjectiveC
import QuartzCore

/// `DESKBENCH_APPKIT_TRACE=1` (swipe, record-gesture): one stderr line each time AppKit's private scrolling animator
/// begins a deceleration of its own (`beginMomentumWithVelocity`, with the velocity it read and where it means to stop)
/// or stops one. This is how the bench saw that AppKit decelerates from the release velocity whatever the reel does with
/// the system's momentum events (DESKBENCH.md, Recorded gestures). It swaps two private methods of AppKit for logging
/// wrappers, in this process, only when asked; where they don't exist (another macOS) it says so and does nothing.
@MainActor enum AppKitScrollTrace {
  private static var installed = false

  static func installIfAsked() {
    guard !installed, ProcessInfo.processInfo.environment["DESKBENCH_APPKIT_TRACE"] != nil else { return }
    installed = true
    func line(_ s: String) { FileHandle.standardError.write(Data("appkit \(String(format: "%.4f", CACurrentMediaTime())) \(s)\n".utf8)) }
    let begin = NSSelectorFromString("scrollingAnimator:beginMomentumWithVelocity:target:")
    if let c = NSClassFromString("NSScrollingBehaviorSingleThreadedVBL"), let m = class_getInstanceMethod(c, begin),
       method_getTypeEncoding(m).map({ String(cString: $0) }) == "{CGPoint=dd}56@0:8@16{CGPoint=dd}24{CGPoint=dd}40" {
      typealias F = @convention(c) (AnyObject, Selector, AnyObject, CGPoint, CGPoint) -> CGPoint
      let original = unsafeBitCast(method_getImplementation(m), to: F.self)
      let wrapper: @convention(block) (AnyObject, AnyObject, CGPoint, CGPoint) -> CGPoint = { me, animator, v, target in
        let r = original(me, begin, animator, v, target)
        line("deceleration: velocity \(Int(v.x.rounded())),\(Int(v.y.rounded())) pt/s, to x \(Int(r.x.rounded()))")
        return r
      }
      method_setImplementation(m, imp_implementationWithBlock(wrapper))
    } else { line("trace: no beginMomentumWithVelocity on this macOS; nothing traced") }
    let stop = NSSelectorFromString("_stopAnimating")
    if let c = NSClassFromString("NSScrollingAnimator"), let m = class_getInstanceMethod(c, stop),
       method_getTypeEncoding(m).map({ String(cString: $0) }) == "v16@0:8" {
      typealias F = @convention(c) (AnyObject, Selector) -> Void
      let original = unsafeBitCast(method_getImplementation(m), to: F.self)
      let wrapper: @convention(block) (AnyObject) -> Void = { me in line("deceleration stopped"); original(me, stop) }
      method_setImplementation(m, imp_implementationWithBlock(wrapper))
    }
  }
}
