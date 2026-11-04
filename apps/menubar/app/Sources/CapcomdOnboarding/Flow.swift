import Foundation

// The onboarding's flow (design/onboarding/onboarding.dc.html, Component): which screen shows, what its primary button
// says and does, the boot steps' rows and the bot's comments, and when the onboarding shows at all. Pure: the window
// (CapcomdApp/Onboarding*.swift) does the work each step names and reports back.

public enum Step: Int, CaseIterable, Sendable, Comparable {
  case welcome, boot, crew, project, goal, launch, allSet
  public static func < (a: Step, b: Step) -> Bool { a.rawValue < b.rawValue }

  /// The five dots (welcome to goal); launch and all set have none.
  public var showsDots: Bool { self < .launch }
  public var dotsLabel: String { "Step \(rawValue + 1) of 5" }
  /// Back and the primary button along the bottom: boot to goal.
  public var showsFooter: Bool { self >= .boot && self <= .goal }
  /// Skip for now: only on the goal.
  public var canSkip: Bool { self == .goal }
  public var next: Step? { Step(rawValue: rawValue + 1) }
  public var previous: Step? { self == .allSet ? .goal : Step(rawValue: rawValue - 1) }
}

public enum Dot: Sendable, Equatable { case off, on, done }
public func dots(_ step: Step) -> [Dot] { (0..<5).map { $0 == step.rawValue ? .on : $0 < step.rawValue ? .done : .off } }

// MARK: Boot

/// Find capcomd, start it, pair this Mac: 0 before anything, 1–3 while that step runs, 4 when all are done.
public struct Boot: Equatable, Sendable {
  public enum Row: Equatable, Sendable { case waiting, running, done, failed(String) }
  public var stage = 0
  /// The CLI wasn't found (the brew command and Check again show instead of the rows).
  public var cliMissing = false
  /// Start capcomd when I log in.
  public var atLogin = true
  /// What was found: "0.9.0" and its path ("~/…" for one under the home folder).
  public var version: String?
  public var path: String?
  /// The step that failed, and why, in the daemon's or the CLI's words.
  public var failure: (stage: Int, message: String)?
  public init() {}

  public static func == (a: Boot, b: Boot) -> Bool {
    a.stage == b.stage && a.cliMissing == b.cliMissing && a.atLogin == b.atLogin && a.version == b.version && a.path == b.path
      && a.failure?.stage == b.failure?.stage && a.failure?.message == b.failure?.message
  }

  public var done: Bool { stage >= 4 }
  public var running: Bool { stage > 0 && stage < 4 && failure == nil }

  public mutating func begin() { stage = 1; failure = nil }
  /// The step running now finished: on to the next.
  public mutating func advance() { if stage > 0 && stage < 4 { stage += 1 } }
  public mutating func fail(_ message: String) { failure = (stage, message) }
  /// Try again: from the step that failed (the ones before it stay done).
  public mutating func retry() { failure = nil }

  public static let running = ["Looking for capcomd…", "Starting capcomd…", "Pairing this Mac…"]
  public static let done = ["Found capcomd", "capcomd is running", "This Mac is paired"]
  public static let waiting = ["Find capcomd", "Start capcomd", "Pair this Mac"]
  public static let bubbles = ["Ready when you are.", "Looking around…", "Warming up the engine…", "Shaking hands…", "All systems go!"]
  public static let missingBubble = "Hmm, I can't find capcomd."
  public static let failedBubble = "That didn't work. Let's try again."

  public func row(_ i: Int) -> Row {
    if let f = failure, f.stage - 1 == i { return .failed(f.message) }
    if stage >= 4 || i < stage - 1 { return .done }
    if i == stage - 1 { return .running }
    return .waiting
  }
  public func label(_ i: Int) -> String {
    switch row(i) {
    case .done: return Self.done[i]
    case .running: return Self.running[i]
    case .waiting, .failed: return Self.waiting[i]
    }
  }
  /// The line under a finished row (or the reason under a failed one).
  public func detail(_ i: Int) -> String? {
    switch row(i) {
    case .failed(let m): return m
    case .done:
      switch i {
      case 0: return [version, path].compactMap { $0 }.joined(separator: " · ")
      case 1: return atLogin ? "in the background, and whenever you log in" : "in the background, until you quit it"
      default: return "its key is kept in your Keychain"
      }
    case .waiting, .running: return nil
    }
  }
  public var bubble: String {
    if cliMissing { return Self.missingBubble }
    if failure != nil { return Self.failedBubble }
    return Self.bubbles[min(4, max(0, stage))]
  }
  /// The green part of the circuit line, in points (of 120): a step's worth per finished step.
  public var fill: Double { Double(min(120, max(0, stage - 1) * 60)) }
  /// The switch can change until capcomd has been started.
  public var switchEnabled: Bool { stage <= 1 || (failure?.stage == 2) }
}

// MARK: The primary button

public enum Primary: Equatable, Sendable {
  case getStarted, boot, booting, retry, next, launch, openCapcomd
  public var label: String {
    switch self {
    case .getStarted: return "Get started"
    case .boot: return "Boot capcomd"
    case .booting: return "Booting…"
    case .retry: return "Try again"
    case .next: return "Continue"
    case .launch: return "Launch crew"
    case .openCapcomd: return "Open capcomd"
    }
  }
}

/// Everything the screens show and the buttons decide on.
public struct Flow: Equatable, Sendable {
  public var step: Step
  public var boot = Boot()
  /// Where agents work: "docker" or "boxd".
  public var place = "docker"
  /// The project picked (a checkout's path), and whether its setup is done (it can take a run).
  public var project: String?
  public var projectReady = false
  public var goal = ""
  /// The run Launch crew started.
  public var runId: String?
  public var launchFailure: String?

  public init(step: Step = .welcome) { self.step = step }

  public var primary: Primary? {
    switch step {
    case .welcome: return .getStarted
    case .boot:
      if boot.failure != nil { return .retry }
      if boot.done { return .next }
      return boot.running ? .booting : .boot
    case .crew, .project: return .next
    case .goal: return .launch
    case .launch: return runId != nil ? .openCapcomd : nil
    case .allSet: return .openCapcomd
    }
  }
  public var primaryEnabled: Bool {
    switch step {
    case .boot: return !boot.cliMissing && !boot.running
    case .project: return project != nil && projectReady
    case .goal: return !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && project != nil && projectReady
    default: return true
    }
  }
  /// Back is off while capcomd boots (as in the prototype) and while a launch is on its way.
  public var backEnabled: Bool { step.showsFooter && !boot.running }

  /// Moving between screens. Going back to the welcome screen starts the boot over, as the prototype does; the steps
  /// after boot need it done, so a jump past it is refused.
  @discardableResult
  public mutating func go(_ to: Step) -> Bool {
    if to > .boot && to != .allSet && !boot.done { return false }
    if to == .allSet && !boot.done { return false }
    if to == .welcome && !boot.running && !boot.done { boot = Boot() }
    step = to
    return true
  }
  public mutating func back() { if let p = step.previous, backEnabled || step == .allSet { _ = go(p) } }
  /// Skip for now (the goal): the all set screen.
  public mutating func skip() { if step.canSkip { _ = go(.allSet) } }
}

// MARK: When the onboarding shows

/// What was stored about the onboarding (UserDefaults under `capcomd.onboarding.*`).
public struct Record: Equatable, Sendable {
  /// It has shown at least once (the intro played, or was skipped for Reduce Motion).
  public var seen = false
  /// Finished (Open capcomd) or skipped (the all set screen).
  public var finished = false
  public init(seen: Bool = false, finished: Bool = false) { self.seen = seen; self.finished = finished }

  public static let seenKey = "capcomd.onboarding.seen", finishedKey = "capcomd.onboarding.finished"
  public init(_ read: (String) -> Bool) { seen = read(Self.seenKey); finished = read(Self.finishedKey) }
  public func write(_ set: (String, Bool) -> Void) { set(Self.seenKey, seen); set(Self.finishedKey, finished) }
}

/// How the app's connection stands: not known yet (reading the Keychain, pairing), connected, or needing what the boot
/// screen does (no CLI, pairing failed or refused, the daemon not answering).
public enum Link: Equatable, Sendable { case unknown, connected, needsSetup }

public enum Gate {
  /// The onboarding shows on the first launch, and whenever the app can't reach or pair with capcomd until it has been
  /// finished. Finished, it never shows by itself again (the connect screens in the window take over).
  /// Closed without finishing, it stays closed until the next launch (`dismissed`).
  public static func shows(_ r: Record, link: Link, dismissed: Bool = false) -> Bool {
    if r.finished || dismissed { return false }
    if !r.seen { return true }
    return link == .needsSetup
  }
  /// The first launch starts at the welcome screen; a later one that can't connect, at boot.
  public static func firstStep(_ r: Record) -> Step { r.seen ? .boot : .welcome }
  /// The intro plays the first time only, or when asked for (Settings › Show onboarding again), never with Reduce Motion.
  public static func playsIntro(_ r: Record, asked: Bool, reduceMotion: Bool) -> Bool { !reduceMotion && (asked || !r.seen) }
  /// The main window waits while the onboarding is up at launch.
  public static func holdsMainWindow(_ r: Record) -> Bool { !r.finished && !r.seen }
}

// MARK: Launch

/// The launch screen's choreography (launch() in the prototype): the planner drops in at 0.25 s, the circuit grows at
/// 1 s, workers land at 1.6, 1.85 and 2.1 s (the packets run from 2.1 s), "Your crew is on it." at 3.2 s. A worker
/// lands no earlier than its time and only once the run has it: real agents, as they arrive.
public enum Launch {
  public static let times: [(ms: Int, stage: Int)] = [(250, 1), (1000, 2), (1600, 3), (1850, 4), (2100, 5), (3200, 6)]
  public static func stage(atMs t: Int) -> Int { times.last { t >= $0.ms }?.stage ?? 0 }
  /// The three places along the circuit (centres, in the window).
  public static let slots: [Double] = [330, 600, 870]
  public static func showsPlanner(atMs t: Int) -> Bool { stage(atMs: t) >= 1 }
  public static func showsCircuit(atMs t: Int) -> Bool { stage(atMs: t) >= 2 }
  public static func showsPackets(atMs t: Int) -> Bool { stage(atMs: t) >= 5 }
  public static func showsDone(atMs t: Int) -> Bool { stage(atMs: t) >= 6 }
  /// Slot `i` holds a worker: its time has come and the run has an i-th worker.
  public static func showsWorker(_ i: Int, atMs t: Int, workers: Int) -> Bool { i < min(3, workers) && stage(atMs: t) >= 3 + i }
  public static let suggestions = ["Add a --json flag to every command", "Write tests for the parser", "Fix the flaky CI job"]
  /// The colours of the three slots' names and nodes (purple, orange, purple).
  public static let slotColorways: [Sprite.Colorway] = [.purple, .orange, .purple]

  // The layout, top-down (no bots on this screen: each member is a 16 pt pixel node on the circuit, hollow until its
  // agent arrives, then filled in its colour).
  /// The planner's node, centred where the planner bot's centre was (148), and its name and status under it.
  public static let plannerNodeTop = 140.0, plannerLabelTop = 168.0
  /// The trace down from the planner to the bus, the bus, and the drops to the slots.
  public static let traceTop = 222.0, busTop = 320.0, dropHeight = 44.0
  public static var traceHeight: Double { busTop - traceTop }
  /// The workers' nodes at the drops' ends, their names and statuses under them.
  public static var nodeTop: Double { busTop + dropHeight }
  public static let workerLabelTop = 392.0
  /// "Your crew is on it."
  public static let doneTop = 500.0
  public static let nodeSide = 16.0
  /// A node fills in this long (expo out; no bounce), from when its agent is there and its time has come.
  public static let fillMs = 400
  /// Fill progress 0…1 of a node whose agent landed at `from` ms.
  public static func fill(atMs t: Int, from: Int) -> Double { Curve.expo.apply(Double(t - from) / Double(fillMs)) }
}
