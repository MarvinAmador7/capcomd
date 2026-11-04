import Foundation

// "Pick a first project": the Git repositories on this Mac. capcomd's own projects first (GET /v1/projects/known, and
// the app's current project), then a bounded look through the usual code folders (~/Developer, ~/Code, ~/Projects,
// ~/src, two levels down). It never opens a folder macOS guards with a privacy prompt (Desktop, Documents, Downloads,
// iCloud Drive, removable volumes…), not even through a symlink, and never descends into a repository it found.

public struct FoundRepo: Hashable, Sendable {
  public var path: String
  public var name: String
  /// The checked-out branch (nil when it can't be read, or for a project inside a protected folder: reading it would
  /// ask the user).
  public var branch: String?
  /// capcomd knows it (one of its projects).
  public var known: Bool
  /// When it last changed (its HEAD), for the order.
  public var modified: Date?
  public init(path: String, name: String, branch: String?, known: Bool, modified: Date?) {
    self.path = path; self.name = name; self.branch = branch; self.known = known; self.modified = modified
  }
}

public enum RepoScan {
  /// The folders looked through, under the home folder.
  public static let roots = ["Developer", "Code", "Projects", "src"]
  public static let maxDepth = 2
  /// At most this many folders are looked at, and this many repositories kept.
  public static let maxVisited = 3000
  public static let maxFound = 60
  /// Home folders macOS asks about before an app reads them (TCC), and the rest of ~/Library.
  public static let protectedInHome = ["Desktop", "Documents", "Downloads", "Library", "Pictures", "Movies", "Music", "Public"]
  /// Folders never worth descending into.
  static let skipped: Set<String> = ["node_modules", "Pods", "DerivedData", "vendor", "build", "dist", "target"]

  /// A folder the scan must not open: a protected home folder or anything in one, iCloud Drive, another volume, or a
  /// network share. `path` is resolved (symlinks) by the caller when it can be.
  public static func isProtected(_ path: String, home: String) -> Bool {
    let p = standard(path), h = standard(home)
    for name in protectedInHome where p == "\(h)/\(name)" || p.hasPrefix("\(h)/\(name)/") { return true }
    if p.hasPrefix("/Volumes/") || p == "/Volumes" || p.hasPrefix("/Network/") { return true }
    return false
  }

  /// "~/Developer/app" for a path under `home`.
  public static func display(_ path: String, home: String) -> String {
    let p = standard(path), h = standard(home)
    if p == h { return "~" }
    return p.hasPrefix(h + "/") ? "~" + p.dropFirst(h.count) : p
  }

  /// The branch a checkout is on: HEAD's ref (`ref: refs/heads/main` → main), a short commit when detached. A worktree's
  /// or submodule's `.git` file points at its git folder.
  public static func branch(of repo: String, fm: FileManager = .default) -> String? {
    guard let git = gitDir(repo, fm: fm), let head = try? String(contentsOfFile: git + "/HEAD", encoding: .utf8) else { return nil }
    let h = head.trimmingCharacters(in: .whitespacesAndNewlines)
    if h.hasPrefix("ref: refs/heads/") { return String(h.dropFirst("ref: refs/heads/".count)) }
    if h.count >= 7, h.allSatisfy(\.isHexDigit) { return String(h.prefix(7)) }
    return nil
  }

  static func gitDir(_ repo: String, fm: FileManager) -> String? {
    let dot = repo + "/.git"
    var isDir: ObjCBool = false
    guard fm.fileExists(atPath: dot, isDirectory: &isDir) else { return nil }
    if isDir.boolValue { return dot }
    guard let s = try? String(contentsOfFile: dot, encoding: .utf8), let line = s.split(whereSeparator: \.isNewline).first,
          line.hasPrefix("gitdir: ") else { return nil }
    let target = String(line.dropFirst("gitdir: ".count)).trimmingCharacters(in: .whitespaces)
    return target.hasPrefix("/") ? target : standard(repo + "/" + target)
  }

  public static func isRepo(_ path: String, fm: FileManager = .default) -> Bool { fm.fileExists(atPath: path + "/.git") }

  /// The repositories in the usual code folders, newest first. Bounded (depth, folders looked at, repositories kept).
  public static func scan(home: String, fm: FileManager = .default) -> [FoundRepo] {
    var found: [FoundRepo] = [], visited = 0
    var seen = Set<String>()
    func walk(_ dir: String, depth: Int) {
      guard found.count < maxFound, visited < maxVisited else { return }
      visited += 1
      guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return }
      for name in names.sorted() {
        guard found.count < maxFound, visited < maxVisited else { return }
        if name.hasPrefix(".") || skipped.contains(name) { continue }
        let child = dir + "/" + name
        // Symlinks are never followed below a root: they may lead anywhere, protected folders included.
        guard let a = try? fm.attributesOfItem(atPath: child), a[.type] as? FileAttributeType == .typeDirectory else { continue }
        if isProtected(child, home: home) { continue }
        if isRepo(child, fm: fm) {
          if seen.insert(child).inserted { found.append(repo(child, known: false, fm: fm)) }
          continue
        }
        if depth < maxDepth { walk(child, depth: depth + 1) }
      }
    }
    for r in roots {
      let root = standard(home) + "/" + r
      // A root may be a symlink (~/Developer → somewhere): followed only when it doesn't lead into a protected folder.
      let real = (try? fm.destinationOfSymbolicLink(atPath: root)).map { $0.hasPrefix("/") ? $0 : standard(home) + "/" + $0 } ?? root
      var isDir: ObjCBool = false
      guard !isProtected(real, home: home), fm.fileExists(atPath: real, isDirectory: &isDir), isDir.boolValue else { continue }
      if isRepo(real, fm: fm) { if seen.insert(real).inserted { found.append(repo(real, known: false, fm: fm)) }; continue }
      walk(real, depth: 1)
    }
    return found.sorted { ($0.modified ?? .distantPast) > ($1.modified ?? .distantPast) }
  }

  /// capcomd's projects first (in its order, those still there), then the scan's, without repeats.
  public static func merge(known: [String], scanned: [FoundRepo], home: String, fm: FileManager = .default) -> [FoundRepo] {
    var out: [FoundRepo] = [], seen = Set<String>()
    for k in known {
      let p = standard(k)
      guard seen.insert(p).inserted else { continue }
      if isProtected(p, home: home) {
        // Listed without being opened: no branch, no check that it's still there.
        out.append(FoundRepo(path: p, name: (p as NSString).lastPathComponent, branch: nil, known: true, modified: nil))
      } else if isRepo(p, fm: fm) {
        out.append(repo(p, known: true, fm: fm))
      }
    }
    for s in scanned where seen.insert(standard(s.path)).inserted { out.append(s) }
    return out
  }

  static func repo(_ path: String, known: Bool, fm: FileManager) -> FoundRepo {
    let head = gitDir(path, fm: fm).map { $0 + "/HEAD" }
    let modified = head.flatMap { try? fm.attributesOfItem(atPath: $0)[.modificationDate] as? Date }
    return FoundRepo(path: path, name: (path as NSString).lastPathComponent, branch: branch(of: path, fm: fm), known: known, modified: modified)
  }

  static func standard(_ p: String) -> String {
    var s = (p as NSString).standardizingPath
    while s.count > 1 && s.hasSuffix("/") { s.removeLast() }
    return s
  }
}
