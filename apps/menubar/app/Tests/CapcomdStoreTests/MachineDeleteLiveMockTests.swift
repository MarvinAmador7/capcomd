import XCTest
import Foundation
@testable import CapcomdStore
@testable import CapcomdLive

/// Deleting machines through the live adapter against the Bun mock (client/mock/settings.ts, ADR-021 phase 3): the
/// route, its refusals as the daemon words them, and a phase 2 daemon that offers no Delete.
extension SettingsLiveMockTests {
  func testDeletingAMachineThroughTheMock() async throws {
    let info = LiveDaemonInfo(transport: try await start("mixed"))
    let s = CapcomdStore(daemonInfo: info)
    await s.refreshSettings(); await s.refreshSandbox("boxd")
    XCTAssertTrue(s.capabilities.contains(Capability.sandboxesActions))
    let rows = s.machineRows("boxd")
    XCTAssertEqual(rows.map(\.canDelete), [true, true, true])
    let left = try XCTUnwrap(rows.first { $0.orphaned })
    XCTAssertEqual(DeleteQuestion.from(left.confirm), DeleteQuestion(title: "Delete this machine?", message: "No agent is using it.", button: "Delete"))
    let worker = try XCTUnwrap(rows.first { $0.id == "relay-3f9c2a1b7e5d4c60" })
    XCTAssertEqual(worker.confirm, "Delete worker's machine? This stops the worker on “Add an abs(a) function to math.ts”. Work since its last checkpoint is lost.")
    await s.deleteMachine(sandbox: "boxd", id: left.id)
    XCTAssertNil(s.machineDeletion(sandbox: "boxd", id: left.id))
    XCTAssertEqual(s.machineRows("boxd").map(\.id), ["relay-77ab0e94c2d81f35", "relay-3f9c2a1b7e5d4c60"])
    // The same key again answers the same; an id the place doesn't list is 404 with the daemon's sentence.
    let first = try await info.resourceAction(sandbox: "boxd", id: worker.id, action: "delete", idempotencyKey: "key-same-0001")
    XCTAssertTrue(first.changed)
    XCTAssertEqual(first.resource?.state, "stopping")
    let replay = try await info.resourceAction(sandbox: "boxd", id: worker.id, action: "delete", idempotencyKey: "key-same-0001")
    XCTAssertEqual(replay, first)
    do { _ = try await info.resourceAction(sandbox: "boxd", id: "relay-nope", action: "delete", idempotencyKey: "key-nope-0001"); XCTFail("expected 404") }
    catch let r as ActionRefused { XCTAssertEqual(r.status, 404); XCTAssertEqual(r.message, "machine relay-nope isn't one of capcomd's machines on Cloud") }
  }

  func testCapcomdsOwnMachinesCantBeDeleted() async throws {
    let info = LiveDaemonInfo(transport: try await start("mixed", sandboxes: "owners"))
    let s = CapcomdStore(daemonInfo: info)
    await s.refreshSettings(); await s.refreshSandbox("boxd")
    XCTAssertEqual(s.machineRows("boxd").filter(\.capcomdJob).map(\.canDelete), [false, false, false])
    do { _ = try await info.resourceAction(sandbox: "boxd", id: "relay-check-5d2e81a0", action: "delete", idempotencyKey: "key-check-001"); XCTFail("expected 409") }
    catch let r as ActionRefused { XCTAssertEqual(r.status, 409); XCTAssertEqual(r.message, "capcomd is using this machine itself (Checks for run-8kq2) and deletes it when that's done.") }
  }

  func testADeleteThatFindsTheMachineChangedShowsWhy() async throws {
    let s = CapcomdStore(daemonInfo: LiveDaemonInfo(transport: try await start("mixed", sandboxes: "changed")))
    await s.refreshSettings(); await s.refreshSandbox("boxd")
    await s.deleteMachine(sandbox: "boxd", id: "relay-0c11d5e2a9b74f08")
    XCTAssertEqual(s.machineDeletion(sandbox: "boxd", id: "relay-0c11d5e2a9b74f08")?.error,
                   "This machine changed since you looked: the worker agt-77 is using it now. Look again before deleting it.")
    XCTAssertEqual(s.machineRows("boxd").count, 3)
  }

  func testADeleteTheProviderDoesntAnswerShowsWhy() async throws {
    let s = CapcomdStore(daemonInfo: LiveDaemonInfo(transport: try await start("mixed", sandboxes: "unavailable")))
    await s.refreshSettings(); await s.refreshSandbox("docker")
    let id = try XCTUnwrap(s.machineRows("docker").first?.id)
    await s.deleteMachine(sandbox: "docker", id: id)
    XCTAssertEqual(s.machineDeletion(sandbox: "docker", id: id)?.error, "Docker didn't answer within 10 seconds, so nothing was deleted. Try again in a moment.")
    XCTAssertEqual(s.machineRows("docker").map(\.id), [id])
  }

  func testAPhaseTwoDaemonOffersNoDelete() async throws {
    let s = CapcomdStore(daemonInfo: LiveDaemonInfo(transport: try await start("mixed", sandboxes: "noactions")))
    await s.refreshSettings(); await s.refreshSandbox("boxd")
    XCTAssertTrue(s.capabilities.contains(Capability.sandboxesSettings))
    XCTAssertFalse(s.capabilities.contains(Capability.sandboxesActions))
    XCTAssertTrue(s.machineRows("boxd").allSatisfy { !$0.canDelete })
    XCTAssertTrue(s.machineRows("boxd").allSatisfy(\.canOpenTerminal))
  }
}
