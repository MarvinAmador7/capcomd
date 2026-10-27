// ADR-021 §5: the engine's machine deletes reach the daemon's audit through the sink `capcomd serve` sets, with the
// cause; a client's Delete in flight keeps the engine's report from doubling the API's own event.
import { afterEach, expect, test } from "bun:test";
import { ACTION_CLAIM_MS, beginMachineAction, reportMachineDeleted, resetMachineAudit, resourceActionEvent, resourceDeletedEvent, setMachineAuditSink, type AuditRecord } from "../../src/providers/machine-audit";

afterEach(() => resetMachineAudit());
const recording = () => { const seen: AuditRecord[] = []; setMachineAuditSink((e) => { seen.push(e); }); return seen; };
const ID = "relay-3f9c2a1b7e5d4c60";

test("a worker's drain is recorded with its cause, for places clients see; without a sink nothing happens", () => {
	reportMachineDeleted("boxd", ID, "run_ended");   // no sink yet: dropped, no throw
	const seen = recording();
	reportMachineDeleted("boxd", ID, "run_ended");
	reportMachineDeleted("docker", "relay-0a0b0c0d0e0f1011", "idle_lifetime");
	reportMachineDeleted("fake", "relay-x", "run_ended");
	reportMachineDeleted(undefined, ID, "run_ended");
	reportMachineDeleted("boxd", null, "run_ended");
	expect(seen.map((e) => [e.type, e.entity, e.data])).toEqual([
		["sandbox.resource_deleted", "sandbox:boxd", { sandbox: "boxd", resourceId: ID, cause: "run_ended" }],
		["sandbox.resource_deleted", "sandbox:docker", { sandbox: "docker", resourceId: "relay-0a0b0c0d0e0f1011", cause: "idle_lifetime" }],
	]);
	expect(seen.map((e) => e.text)).toEqual([`Cloud: machine ${ID} was deleted when its agent ended.`, "Local: machine relay-0a0b0c0d0e0f1011 was deleted after its idle lifetime ran out."]);
});

test("while a client's Delete is in flight, and for a while after, the worker's report is the API's to make", () => {
	const seen = recording();
	const t = Date.now();
	const claim = beginMachineAction("boxd", ID, t);
	reportMachineDeleted("boxd", ID, "run_ended", t + 1);
	expect(seen).toEqual([]);
	claim.done(t + 2);
	reportMachineDeleted("boxd", ID, "run_ended", t + 3);
	expect(seen).toEqual([]);
	// Long after: a new delete of that name is its own.
	reportMachineDeleted("boxd", ID, "run_ended", t + 2 + ACTION_CLAIM_MS + 1);
	expect(seen.map((e) => e.data.cause)).toEqual(["run_ended"]);
	// Another machine is never affected.
	beginMachineAction("boxd", ID);
	reportMachineDeleted("boxd", "relay-0a0b0c0d0e0f1011", "run_ended");
	expect(seen).toHaveLength(2);
});

test("a Delete that gave up waiting: the worker's late report is recorded once, as the action's", () => {
	const seen = recording();
	const claim = beginMachineAction("boxd", ID);
	claim.gaveUp();
	reportMachineDeleted("boxd", ID, "run_ended");
	reportMachineDeleted("boxd", ID, "run_ended");
	expect(seen.map((e) => e.data)).toEqual([{ sandbox: "boxd", resourceId: ID, cause: "action" }]);
	// A Delete that never acted leaves nothing behind.
	const other = beginMachineAction("docker", "relay-0a0b0c0d0e0f1011");
	other.cancel();
	reportMachineDeleted("docker", "relay-0a0b0c0d0e0f1011", "idle_lifetime");
	expect(seen.at(-1)!.data.cause).toBe("idle_lifetime");
});

test("event texts are daemon-written; the action's owner keeps ids and the role, never the task", () => {
	expect(resourceDeletedEvent("boxd", ID, "action").text).toBe(`Cloud: machine ${ID} was deleted from capcomd.`);
	const e = resourceActionEvent("boxd", ID, "delete", { kind: "agent", runId: "run-8kq2", agentId: "agt-41", role: "worker", task: "Add sk-ant-oat01-SECRET" }, "cli-1");
	expect(e).toEqual({ type: "sandbox.resource_action", entity: "sandbox:boxd", text: `Cloud: Delete on machine ${ID}: cancelled worker agt-41 of run-8kq2.`,
		data: { sandbox: "boxd", resourceId: ID, action: "delete", owner: { kind: "agent", runId: "run-8kq2", agentId: "agt-41", role: "worker" }, clientId: "cli-1" } });
	expect(resourceActionEvent("docker", ID, "delete", null, "cli-1").text).toBe(`Local: Delete on machine ${ID}: no agent was using it.`);
});
