import Foundation

/// The Bun that runs the mock daemons (client/mock): BUN_BIN, else `bun` on the PATH, else ~/.bun/bin/bun (the
/// installer's default). Symlinks are resolved so the process is Bun itself, not a shell shim that would leave Bun
/// running when the test terminates it.
enum BunPath {
  static let url: URL = {
    let env = ProcessInfo.processInfo.environment
    let fm = FileManager.default
    var candidates: [String] = []
    if let b = env["BUN_BIN"], !b.isEmpty { candidates.append(b) }
    candidates += (env["PATH"] ?? "").split(separator: ":").map { "\($0)/bun" }
    candidates.append(fm.homeDirectoryForCurrentUser.appendingPathComponent(".bun/bin/bun").path)
    let found = candidates.first { fm.isExecutableFile(atPath: $0) } ?? "bun"
    return URL(fileURLWithPath: found).resolvingSymlinksInPath()
  }()
}
