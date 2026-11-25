import Foundation

/// The gestures the bench replays come from PerfLoopProbe (`SyntheticGestures`: `synthetic:flick-forward`, …, and
/// `perfloop.gesture/1` files a hand recorded with `record-gesture`). These synthetic ones are also committed as files in
/// apps/menubar/app/Gestures (`deskbench gestures --write Gestures`), so a reader can see what a replay sends.
public enum Gestures {
  public static let committed = ["synthetic-flick-forward", "synthetic-flick-back", "synthetic-drag-forward"]
}
