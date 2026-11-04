import Foundation
import CapcomdClient
import CapcomdStore
import CapcomdUI
import DeskBenchKit

/// `deskbench fixture capture` (CAPABILITIES.md C8): reads runs from a daemon the way the app does (the run's durable
/// events from `GET /v1/events?scope=`, its agents, every agent's thread pages), anonymises them (DeskBenchKit/
/// Anonymise.swift) and writes a `deskbench.fixture/1` the bench runs on as `--fixture file:PATH`. Read-only on the
/// daemon (a `read` token is enough); attachments' bytes are never fetched. The file goes outside the repo: an
/// `--out` inside a git checkout is refused unless `--allow-in-repo`.
@MainActor enum Capture {
  static let usage = """
  usage: deskbench fixture capture --from SOCKET|http://HOST:PORT --run RUN_ID [--run …] [--out FILE] [--name NAME]
                                   [--token-file FILE | --keychain] [--raw] [--allow-in-repo] [--json]
    --from        the daemon's harness socket (~/.capcomd/harness.sock for the owner's), or an http endpoint serving harness.v1
    --token-file  a file holding a token with the read scope (capcomd clients add NAME --scopes read); else
                  $CAPCOMD_TOKEN; --keychain reads the capcomd app's own token from the login Keychain
    --out         default: \(CapturedFixture.defaultDirectory.path)/NAME.json (never inside a git checkout)
    --raw         keep the real text (not anonymised): only for a file that never leaves this Mac
  """

  /// GET a path, status and body.
  protocol Source { func get(_ path: String) async throws -> (Int, Data); func close() async }
  final class SocketSource: Source {
    let t: UnixSocketTransport
    init(_ socket: String, token: String) { t = UnixSocketTransport(socketPath: socket, token: token) }
    func get(_ path: String) async throws -> (Int, Data) { try await t.get(path, maxBytes: 64 << 20) }
    func close() async { try? await t.shutdown() }
  }
  final class HTTPSource: Source {
    let base: URL, token: String
    init(_ base: URL, token: String) { self.base = base; self.token = token }
    func get(_ path: String) async throws -> (Int, Data) {
      guard let u = URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else { throw URLError(.badURL) }
      var r = URLRequest(url: u); r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization"); r.timeoutInterval = 30
      let (d, resp) = try await URLSession.shared.data(for: r)
      return ((resp as? HTTPURLResponse)?.statusCode ?? 0, d)
    }
    func close() async {}
  }

  struct Failure: Error, CustomStringConvertible { var description: String; var code = ExitCode.harness }

  static func run(_ args: Args) async -> Int32 {
    guard let from = args.one("from"), !args.all("run").isEmpty else { err(usage); return Int32(ExitCode.usage) }
    do {
      let token = try readToken(args)
      let name = args.one("name") ?? "capture-" + String(ISO8601DateFormatter().string(from: Date()).prefix(10))
      let dest = URL(fileURLWithPath: args.one("out") ?? CapturedFixture.defaultDirectory.appendingPathComponent(name + ".json").path).standardizedFileURL
      if let repo = checkout(containing: dest), !args.has("allow-in-repo") {
        throw Failure(description: "\(dest.path) is inside the git checkout \(repo.path): a captured run stays out of the repo (--out elsewhere, or --allow-in-repo if the owner says so)", code: ExitCode.refused)
      }
      let src: Source = from.hasPrefix("http://") || from.hasPrefix("https://") ? HTTPSource(URL(string: from)!, token: token) : SocketSource(from, token: token)
      var raws: [CapturedFixture.RawRun] = []
      do {
        for id in args.all("run") { raws.append(try await read(run: id, from: src)) }
      } catch { await src.close(); throw error }
      await src.close()
      let anonymise = !args.has("raw")
      if !anonymise { err("deskbench: --raw: \(dest.lastPathComponent) holds the runs' real text; keep it on this Mac") }
      let f = CapturedFixture.build(name: name, runs: raws, anonymise: anonymise)
      try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
      let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
      try enc.encode(f).write(to: dest, options: .atomic)
      try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: dest.path)
      struct Summary: Codable {
        var schema = "deskbench.capture/1"; var path: String; var anonymised: Bool; var runs: Int; var agents: Int; var items: Int; var events: Int; var attachments: Int; var fixture: String
      }
      let s = Summary(path: dest.path, anonymised: anonymise, runs: f.runs.count, agents: f.runs.map(\.agents.count).reduce(0, +), items: f.runs.flatMap(\.threads.values).map(\.count).reduce(0, +),
                      events: f.runs.map(\.events.count).reduce(0, +), attachments: f.attachments.count, fixture: CapturedFixture.prefix + dest.path)
      if args.has("json") { out(JSONOut.encode(s)) } else {
        out("captured \(s.runs) run(s): \(s.agents) agents, \(s.items) thread items, \(s.events) events, \(s.attachments) attachment(s) (shape only)\(anonymise ? ", anonymised" : ", NOT anonymised")")
        out("written: \(dest.path)")
        out("run the bench on it: deskbench run step --fixture \(s.fixture)")
      }
      return 0
    } catch let f as Failure { err("deskbench: \(f.description)"); return Int32(f.code) }
    catch { err("deskbench: \(error)"); return Int32(ExitCode.harness) }
  }

  /// One run as the app reads it: its events (the run scope's durable log), its agents in tree order, every
  /// agent's thread, page by page.
  static func read(run id: String, from src: Source) async throws -> CapturedFixture.RawRun {
    func json(_ path: String) async throws -> JSONValue {
      let (s, d) = try await src.get(path)
      switch s {
      case 200: return try JSONDecoder().decode(JSONValue.self, from: d)
      case 401: throw Failure(description: "the daemon refused the token (401): pass a token with the read scope")
      case 404: throw Failure(description: "\(path): not found (404); is \(id) a run on this daemon?", code: ExitCode.usage)
      default: throw Failure(description: "\(path): HTTP \(s)")
      }
    }
    let seg = { (s: String) in s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s }
    let scope = id.hasPrefix("run-") ? id : "run-\(id)"
    _ = try await json("/v1/runs/\(seg(id))")
    let events = try await json("/v1/events?scope=\(seg(scope))&after=0").array ?? []
    var agents: [String] = []
    if let tree = try? await json("/v1/runs/\(seg(id))/agents").array { agents = tree.compactMap { $0["agentId"]?.string ?? $0["id"]?.string } }
    for e in events where e["type"]?.string == "agent.spawned" { if let a = e["agentId"]?.string, !agents.contains(a) { agents.append(a) } }
    var threads: [String: [JSONValue]] = [:]
    for a in agents {
      var after = 0, items: [JSONValue] = []
      for _ in 0..<10_000 {
        let page = try await json("/v1/runs/\(seg(id))/agents/\(seg(a))/thread?after=\(after)&limit=100")
        items += page["items"]?.array ?? []
        guard let next = page["next"]?.int, next > after else { break }
        after = next
      }
      threads[a] = items
    }
    return CapturedFixture.RawRun(runId: id, scope: scope, agents: agents, events: events, threads: threads)
  }

  /// The token: --token-file (warned about when others can read it), $CAPCOMD_TOKEN, or the app's Keychain item.
  static func readToken(_ args: Args) throws -> String {
    if let f = args.one("token-file") {
      guard let t = try? String(contentsOfFile: f, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { throw Failure(description: "no token in \(f)", code: ExitCode.usage) }
      if let mode = (try? FileManager.default.attributesOfItem(atPath: f))?[.posixPermissions] as? Int, mode & 0o077 != 0 {
        err("deskbench: \(f) is readable by others (mode \(String(mode, radix: 8))): chmod 600 it")
      }
      return t
    }
    if let t = ProcessInfo.processInfo.environment["CAPCOMD_TOKEN"], !t.isEmpty { return t }
    if args.has("keychain") {
      #if canImport(SwiftUI) && os(macOS)
      if let t = Keychain.token() { return t }
      #endif
      throw Failure(description: "no capcomd token in the login Keychain", code: ExitCode.usage)
    }
    throw Failure(description: "a token with the read scope: --token-file FILE (capcomd clients add deskbench-capture --scopes read), $CAPCOMD_TOKEN, or --keychain", code: ExitCode.usage)
  }

  /// The git checkout a path would land in, if any.
  static func checkout(containing u: URL) -> URL? {
    var d = u.deletingLastPathComponent()
    while d.path != "/" && !d.path.isEmpty {
      if FileManager.default.fileExists(atPath: d.appendingPathComponent(".git").path) { return d }
      d = d.deletingLastPathComponent()
    }
    return nil
  }
}
