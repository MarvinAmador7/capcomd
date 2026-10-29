import XCTest
import Foundation
@testable import CapcomdStore

/// Deleting a machine from a place's Details (ADR-021 phase 3, capability `sandboxes.actions`): Delete… only where the
/// daemon offers it and has the capability, the daemon's question, a fresh Idempotency-Key per Delete, and the daemon's
/// sentence under the row when it says no.
@MainActor
final class MachineDeleteTests: XCTestCase {
  let worker = SandboxResource(id: "relay-3f9c2a1b7e5d4c60", state: "running", owner: .init(kind: "agent", runId: "run-8kq2", agentId: "agt-41", role: "worker", task: "Add an abs(a) function"),
                               actions: ["open_terminal", "delete"], destructive: true,
                               confirm: "Delete worker's machine? This stops the worker on “Add an abs(a) function”. Work since its last checkpoint is lost.")
  let orphan = SandboxResource(id: "relay-0c11d5e2a9b74f08", state: "orphaned", actions: ["open_terminal", "delete"], destructive: true, confirm: "Delete this machine? No agent is using it.")
  let check = SandboxResource(id: "relay-check", state: "running", owner: .init(kind: "check", runId: "run-8kq2", role: "checks", label: "Checks for run-8kq2"), actions: ["delete"])

  func daemon(actions: Bool = true, _ d: FakeSandboxDaemon = FakeSandboxDaemon()) -> FakeSandboxDaemon {
    if actions { d.caps.insert(Capability.sandboxesActions) }
    d.details["boxd"] = SandboxDetail(descriptor: d.list[0])
    d.pages["boxd"] = ResourcePage(resources: [worker, orphan, check])
    return d
  }

  func testDecodesDestructiveConfirmAndTheActionResult() throws {
    let page = try SandboxWire.resources(Data(#"""
      {"resources":[
        {"id":"relay-1","kind":"machine","state":"orphaned","owner":null,"actions":["open_terminal","delete"],"destructive":true,"confirm":"Delete this machine? No agent is using it."},
        {"id":"relay-2","kind":"machine","state":"running","owner":{"kind":"agent","runId":"run-1","agentId":"agt-1"},"actions":["open_terminal"]}
      ],"asOf":null,"stale":false,"error":null,"next":null}
      """#.utf8))
    XCTAssertEqual(page.resources.map(\.destructive), [true, false])
    XCTAssertEqual(page.resources.map(\.confirm), ["Delete this machine? No agent is using it.", nil])
    let done = try SandboxWire.actionResult(Data(#"{"resource":{"id":"relay-1","kind":"machine","state":"stopping","owner":null,"actions":[]},"changed":true}"#.utf8))
    XCTAssertTrue(done.changed)
    XCTAssertEqual(done.resource?.state, "stopping")
    let gone = try SandboxWire.actionResult(Data(#"{"resource":null,"changed":false}"#.utf8))
    XCTAssertEqual(gone, ResourceActionResult(resource: nil, changed: false))
  }

  func testTheQuestionIsTheDaemonsTextSplitIntoATitleAndAMessage() {
    XCTAssertEqual(DeleteQuestion.from(worker.confirm),
                   DeleteQuestion(title: "Delete worker's machine?", message: "This stops the worker on “Add an abs(a) function”. Work since its last checkpoint is lost.", button: "Delete"))
    XCTAssertEqual(DeleteQuestion.from(orphan.confirm), DeleteQuestion(title: "Delete this machine?", message: "No agent is using it.", button: "Delete"))
    XCTAssertEqual(DeleteQuestion.from(nil), DeleteQuestion(title: "Delete this machine?", message: nil, button: "Delete"))
    XCTAssertEqual(DeleteQuestion.from("It can't be undone."), DeleteQuestion(title: "Delete this machine?", message: "It can't be undone.", button: "Delete"))
  }

  func testWithoutSandboxesActionsThereIsNoDelete() async {
    let d = daemon(actions: false)
    let s = CapcomdStore(daemonInfo: d)
    await s.refreshSettings(); await s.refreshSandbox("boxd")
    XCTAssertFalse(s.actionsSupported)
    // The rows say delete (an older daemon's list may), but the app offers it only with the capability.
    XCTAssertTrue(s.machineRows("boxd").allSatisfy { !$0.canDelete })
    XCTAssertEqual(s.machineRows("boxd").filter(\.canOpenTerminal).count, 2)
    await s.deleteMachine(sandbox: "boxd", id: orphan.id)
    XCTAssertTrue(d.actions.isEmpty)
  }

  func testDeleteOnAgentsAndLeftBehindMachinesNeverOnCapcomdsOwn() async {
    let s = CapcomdStore(daemonInfo: daemon())
    await s.refreshSettings(); await s.refreshSandbox("boxd")
    XCTAssertTrue(s.actionsSupported)
    let rows = Dictionary(uniqueKeysWithValues: s.machineRows("boxd").map { ($0.id, $0) })
    XCTAssertEqual(rows[worker.id]?.canDelete, true)
    XCTAssertEqual(rows[orphan.id]?.canDelete, true)
    XCTAssertEqual(rows["relay-check"]?.canDelete, false)
    XCTAssertEqual(rows[worker.id]?.confirm, worker.confirm)
    XCTAssertEqual(rows[worker.id]?.canOpenTerminal, true)
  }

  func testAConfirmedDeleteSendsAFreshKeyAndReadsThePlaceAgain() async {
    let d = daemon()
    let s = CapcomdStore(daemonInfo: d)
    await s.refreshSettings(); await s.refreshSandbox("boxd")
    let reads = d.resourceCalls
    await s.deleteMachine(sandbox: "boxd", id: orphan.id)
    XCTAssertEqual(d.actions.map(\.id), [orphan.id])
    XCTAssertEqual(d.actions.map(\.action), ["delete"])
    XCTAssertGreaterThanOrEqual(d.actions[0].key.count, 8)
    XCTAssertGreaterThan(d.resourceCalls, reads)
    XCTAssertNil(s.machineDeletion(sandbox: "boxd", id: orphan.id))
    XCTAssertFalse(s.machineRows("boxd").map(\.id).contains(orphan.id))
    await s.deleteMachine(sandbox: "boxd", id: worker.id)
    XCTAssertEqual(d.actions.count, 2)
    XCTAssertNotEqual(d.actions[0].key, d.actions[1].key)
  }

  func testARefusalShowsTheDaemonsSentenceUnderTheRow() async {
    let d = daemon()
    let changed = "This machine changed since you looked: the worker agt-77 is using it now. Look again before deleting it."
    let down = "boxd didn't answer within 10 seconds, so nothing was deleted. Try again in a moment."
    d.actionAnswers = [ActionRefused(changed, status: 409), ActionRefused(down, status: 503), DetailUnavailable.failed("HTTP 500"), nil]
    let s = CapcomdStore(daemonInfo: d)
    await s.refreshSettings(); await s.refreshSandbox("boxd")
    await s.deleteMachine(sandbox: "boxd", id: orphan.id)
    XCTAssertEqual(s.machineDeletion(sandbox: "boxd", id: orphan.id), MachineDeletion(deleting: false, error: changed))
    XCTAssertTrue(s.machineRows("boxd").contains { $0.id == orphan.id })
    await s.deleteMachine(sandbox: "boxd", id: orphan.id)
    XCTAssertEqual(s.machineDeletion(sandbox: "boxd", id: orphan.id)?.error, down)
    await s.deleteMachine(sandbox: "boxd", id: orphan.id)
    XCTAssertEqual(s.machineDeletion(sandbox: "boxd", id: orphan.id)?.error, "Couldn't delete it just now. Try again.")
    // A Delete that goes through clears the sentence.
    await s.deleteMachine(sandbox: "boxd", id: orphan.id)
    XCTAssertNil(s.machineDeletion(sandbox: "boxd", id: orphan.id))
    XCTAssertEqual(d.actions.count, 4)
    XCTAssertEqual(Set(d.actions.map(\.key)).count, 4)
  }

  func testATokenThatIsRejectedSaysSo() async {
    let d = daemon()
    d.actionAnswers = [Unauthorized()]
    let s = CapcomdStore(daemonInfo: d)
    await s.refreshSettings(); await s.refreshSandbox("boxd")
    await s.deleteMachine(sandbox: "boxd", id: orphan.id)
    XCTAssertTrue(s.unauthorized)
    XCTAssertEqual(s.machineDeletion(sandbox: "boxd", id: orphan.id)?.error, "capcomd rejected this app's token.")
  }

  func testOneDeleteAtATimePerMachine() async {
    let d = daemon(GatedActionDaemon()) as! GatedActionDaemon
    let s = CapcomdStore(daemonInfo: d)
    await s.refreshSettings(); await s.refreshSandbox("boxd")
    let first = Task { await s.deleteMachine(sandbox: "boxd", id: orphan.id) }
    while d.waiting == nil { await Task.yield() }
    XCTAssertEqual(s.machineDeletion(sandbox: "boxd", id: orphan.id)?.deleting, true)
    await s.deleteMachine(sandbox: "boxd", id: orphan.id)   // tapped again while it runs: nothing sent
    XCTAssertEqual(d.calls, 1)
    d.waiting?.resume(); d.waiting = nil
    await first.value
    XCTAssertNil(s.machineDeletion(sandbox: "boxd", id: orphan.id))
  }
}

/// A daemon whose delete waits until the test lets it answer.
final class GatedActionDaemon: FakeSandboxDaemon {
  var waiting: CheckedContinuation<Void, Never>?
  var calls = 0
  override func resourceAction(sandbox: String, id: String, action: String, idempotencyKey: String) async throws -> ResourceActionResult {
    calls += 1
    await withCheckedContinuation { waiting = $0 }
    return try await super.resourceAction(sandbox: sandbox, id: id, action: action, idempotencyKey: idempotencyKey)
  }
}
