import CapcomdClient
import CapcomdStore
import Foundation

/// The profile routes (capabilities profiles, profiles.edit, profiles.work, profiles.persona), on the daemon adapter so
/// the store's Team screen picks them up from it. A 404 that doesn't name the profile means the route is missing.
extension LiveDaemonInfo: ProfilesPort {
  static func query(_ repo: String?, _ extra: [String] = []) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~/"))
    let parts = (repo.map { ["repo=\($0.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0)"] } ?? []) + extra
    return parts.isEmpty ? "" : "?" + parts.joined(separator: "&")
  }
  static func profilePath(_ name: String, _ tail: String = "") -> String { "/v1/profiles/\(LiveDetail.seg(name))\(tail)" }

  private func profileGet<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
    let (status, data) = try await transport.get(path)
    guard status == 200 else { throw profileRefusal(status, data) }
    do { return try JSONDecoder().decode(T.self, from: data) } catch { throw DetailUnavailable.failed("unexpected response") }
  }
  private func profileRefusal(_ status: Int, _ data: Data) -> Error {
    let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    switch status {
    case 401: return Unauthorized()
    case 403: return ProfileRefused.forbidden
    case 409: return ProfileRefused.conflict(rev: obj?["rev"] as? String)
    // A profile the daemon doesn't have says so ("profile \"x\" not found"); any other 404 is a route it doesn't have.
    case 404 where Self.code(data) == "not_found" && Self.message(data).hasPrefix("profile"): return ProfileRefused.invalid(Self.message(data))
    case 404: return DetailUnavailable.unsupported
    case 422: return ProfileRefused.invalid(Self.message(data))
    default: return DetailUnavailable.failed("HTTP \(status)")
    }
  }

  public func profiles(repo: String?) async throws -> ProfileList {
    try await profileGet("/v1/profiles" + Self.query(repo), as: ProfileList.self)
  }
  public func profile(_ name: String, repo: String?) async throws -> ProfileDetail {
    try await profileGet(Self.profilePath(name) + Self.query(repo), as: ProfileDetail.self)
  }
  /// `PUT /v1/profiles/{name}` (the configure scope, an Idempotency-Key): 200 is the profile as GET answers it now.
  public func updateProfile(_ name: String, repo: String?, values: [String: String?], rev: String, idempotencyKey: String) async throws -> ProfileDetail {
    let (status, data) = try await transport.put(Self.profilePath(name) + Self.query(repo), headers: [("Idempotency-Key", idempotencyKey)],
                                                 json: try ProfileWire.update(values: values, rev: rev))
    guard status == 200 else { throw profileRefusal(status, data) }
    do { return try JSONDecoder().decode(ProfileDetail.self, from: data) } catch { throw DetailUnavailable.failed("unexpected response") }
  }
  /// `GET /v1/profiles/{name}/work?repo=&limit=` (capability profiles.work).
  public func profileWork(_ name: String, repo: String?, limit: Int) async throws -> [ProfileWorkItem] {
    let (status, data) = try await transport.get(Self.profilePath(name, "/work") + Self.query(repo, ["limit=\(limit)"]))
    guard status == 200 else { throw profileRefusal(status, data) }
    do { return try ProfileWire.work(data) } catch { throw DetailUnavailable.failed("unexpected response") }
  }
  /// `GET /v1/profiles/{name}/persona` (capability profiles.persona).
  public func persona(_ name: String, repo: String?) async throws -> ProfilePersona {
    try await profileGet(Self.profilePath(name, "/persona") + Self.query(repo), as: ProfilePersona.self)
  }
  /// `PUT /v1/profiles/{name}/persona` `{text, rev}`: 200 is the persona as GET answers it now.
  public func updatePersona(_ name: String, repo: String?, text: String, rev: String) async throws -> ProfilePersona {
    let (status, data) = try await transport.put(Self.profilePath(name, "/persona") + Self.query(repo), headers: [("Idempotency-Key", UUID().uuidString.lowercased())],
                                                 json: try ProfileWire.persona(text: text, rev: rev))
    guard status == 200 else { throw profileRefusal(status, data) }
    do { return try JSONDecoder().decode(ProfilePersona.self, from: data) } catch { throw DetailUnavailable.failed("unexpected response") }
  }
}
