// A run that can't start must say so and end, never sit "started" with no agent:
// - `capcomd run` (and POST /v1/runs, which runs `capcomd run --detach`) makes its planner's spawn checks before it
//   creates or detaches the run, so a planner with no env snapshot on the run's sandbox is refused (422 / config);
// - a planner spawn that fails after run.started anyway ends the run failed, with the error as its reason;
// - Stop on a run that never ran an agent cancels it (run.cancelled), instead of answering "nothing to cancel".
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addClient, loadClients } from "../../src/api/clients";
import { lifecycleEvents } from "../../src/api/lifecycle";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { capcomd } from "../helpers/engine";
import { world, type World } from "./harness";

let w: World;
let app: ReturnType<typeof harnessApp>;
let token = "";
const home = mkdtempSync(join(tmpdir(), "capcomd-runfail-home-"));

beforeAll(async () => {
	// A Docker that answers `docker version` (nothing here starts a container), no env snapshot ledger, and agents that
	// would run their real CLI (not scripts): a claude planner on Docker can't start without `capcomd env build`.
	const bin = join(home, "docker-stub");
	writeFileSync(bin, "#!/bin/sh\necho 27.0.0\n");
	chmodSync(bin, 0o755);
	w = await world("runfail", { CAPCOMD_HOME: home, CAPCOMD_DOCKER_BIN: bin, CAPCOMD_ENV_LEDGER: join(home, "no-such-envs.json"), CAPCOMD_SPAWN_EXEC: "" });
	const clients = join(home, "harness-clients.json");
	token = addClient("menubar", ["read", "steer"], clients).token;
	app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), state: harnessState(null), pollMs: 100 });
}, 120_000);

afterAll(async () => { await w?.stop(); }, 60_000);

const auth = () => ({ authorization: `Bearer ${token}` });
const req = (path: string, init: { method?: string; body?: unknown; key?: string } = {}) => app.request(path, {
	method: init.method ?? "GET",
	headers: { ...auth(), ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.key ? { "idempotency-key": init.key } : {}) },
	...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
});
const runOf = async (id: string) => (await (await req(`/v1/runs/${id}`)).json()) as any;
const lifecycleOf = async (id: string) => lifecycleEvents(id, await rivetSource().events(id, 0)).filter((e) => e.type.startsWith("run."));

test("POST /v1/runs on Docker with no env snapshot is refused with the reason, and starts no run", async () => {
	const { recentRuns } = await import("../../src/primitives/ops");
	const before = recentRuns(500).length;
	const r = await req("/v1/runs", { method: "POST", body: { goal: "fix the flaky test", sandbox: "docker" }, key: `rf-${Date.now()}` });
	const body = (await r.json()) as any;
	expect(r.status).toBe(422);
	expect(body.code).toBe("invalid");
	expect(body.message).toContain("no capcomd env snapshot");
	expect(body.message).toContain("capcomd env build");
	// Nothing was started: no run in the index the daemon lists (none left "started" there).
	expect(recentRuns(500).length).toBe(before);
}, 60_000);

test("capcomd run --detach refuses in the foreground: config error, no run, no background log", async () => {
	const runId = `run-rf-cli-${Date.now()}`;
	const x = await w.cj(["run", "--detach", "--run-id", runId, "--sandbox", "docker", "fix the flaky test"]);
	expect(x.code).toBe(2);
	expect(x.j).toMatchObject({ ok: false, error: { code: "config" } });
	expect(x.j.error.message).toContain("no capcomd env snapshot");
	expect(existsSync(join(home, "state", "runs", `${runId}.ndjson`))).toBe(false);
	const { recentRuns } = await import("../../src/primitives/ops");
	expect(recentRuns(500).some((r) => r.runId === runId)).toBe(false);
}, 60_000);

test("a planner spawn that fails after run.started ends the run failed, with the error as its reason", async () => {
	const { runWithPlanner } = await import("../../src/recipes/planner-agent");
	const runId = `run-rf-late-${Date.now()}`;
	const lines: Array<Record<string, any>> = [];
	// The run is recorded on Docker while this process's own sandbox is the fake one: only the spawn, which reads the
	// run's recorded sandbox, finds the missing snapshot (a check that fails only after the run started).
	const r = await runWithPlanner({ goal: "fix the flaky test", runId, profile: "planner", sandbox: "docker", emit: (type, data) => { lines.push({ type, ...data }); } });
	expect(r).toMatchObject({ runId, ok: false, state: "failed" });
	expect(lines.map((l) => l.type)).toEqual(["run.started", "run.failed"]);
	expect(lines[1]).toMatchObject({ state: "failed", kind: "config", retryable: false });
	expect(lines[1]!.reason).toContain("no capcomd env snapshot");

	// The run's own record says failed: GET /v1/runs, its lifecycle feed, `capcomd status`.
	expect((await runOf(runId)).state).toBe("failed");
	const life = await lifecycleOf(runId);
	expect(life.map((e) => e.type)).toEqual(["run.created", "run.failed"]);
	expect(life[1]!.data).toMatchObject({ cause: "error" });
	expect(String(life[1]!.data.reason)).toContain("no capcomd env snapshot");
	expect((await w.cj(["status", runId])).j.run.state).toBe("failed");
	// It has ended: Stop has nothing to do, and no agent can join it.
	expect((await req(`/v1/runs/${runId}/cancel`, { method: "POST", key: `rf-c-${runId}` })).status).toBe(409);
	// (CAPCOMD_ENV=image: past the snapshot check, to the scope's own refusal.)
	const late = await capcomd(["spawn", runId, "--profile", "worker", "--task", "late", "--no-start", "--json"], { ...w.env, CAPCOMD_ENV: "image" });
	expect(late.code).not.toBe(0);
	expect(late.stdout).toContain("has ended (failed)");
}, 60_000);

test("Stop on a run with no agents cancels it; a second Stop is the noop", async () => {
	const runId = (await w.cj(["run", "new", "--key", `rf-empty-${Date.now()}`])).j.runId as string;
	expect((await runOf(runId)).state).toBe("new");
	const r = await req(`/v1/runs/${runId}/cancel`, { method: "POST", key: `rf-c1-${runId}` });
	expect(r.status).toBe(200);
	expect(await r.json()).toMatchObject({ runId, action: "cancel", changed: [] });
	expect((await runOf(runId)).state).toBe("cancelled");
	const life = await lifecycleOf(runId);
	expect(life.map((e) => e.type)).toEqual(["run.created", "run.cancelled"]);
	expect(life[1]!.data).toMatchObject({ cause: "cancelled", by: expect.stringMatching(/^client:/) });
	const again = await req(`/v1/runs/${runId}/cancel`, { method: "POST", key: `rf-c2-${runId}` });
	expect(again.status).toBe(409);
	expect(((await again.json()) as any).message).toContain("has ended");
}, 60_000);

test("capcomd cancel ends a run whose only agent never ran", async () => {
	const runId = (await w.cj(["run", "new", "--key", `rf-pending-${Date.now()}`])).j.runId as string;
	const agentId = (await w.cj(["spawn", runId, "--profile", "worker", "--task", "never runs", "--no-start"])).j.agentId as string;
	const c = await w.cj(["cancel", runId]);
	expect(c.code).toBe(0);
	expect(c.j).toMatchObject({ cancelled: [agentId], runEnded: true });
	expect((await runOf(runId)).state).toBe("cancelled");
	expect((await lifecycleOf(runId)).map((e) => e.type)).toEqual(["run.created", "run.cancelled"]);
	// Ended: a second cancel changes nothing.
	const again = await w.cj(["cancel", runId]);
	expect(again.j).toMatchObject({ cancelled: [] });
	expect(again.j.runEnded).toBeUndefined();
}, 60_000);

test("a run stopped before its planner was spawned stays cancelled: the late planner is refused, not started", async () => {
	const { runWithPlanner } = await import("../../src/recipes/planner-agent");
	const { runNew } = await import("../../src/primitives/ops");
	const runId = `run-rf-stop-${Date.now()}`;
	const goal = "fix the flaky test";
	await runNew({ runId, budget: {}, label: goal, goal }); // what runWithPlanner records first
	expect((await req(`/v1/runs/${runId}/cancel`, { method: "POST", key: `rf-s-${runId}` })).status).toBe(200);
	const lines: Array<Record<string, any>> = [];
	const r = await runWithPlanner({ goal, runId, profile: "planner", emit: (type, data) => { lines.push({ type, ...data }); } });
	expect(r).toMatchObject({ runId, ok: false, state: "cancelled" });
	expect(lines.map((l) => l.type)).toEqual(["run.started", "run.resumed", "run.cancelled"]);
	expect((await runOf(runId)).state).toBe("cancelled");
	expect((await rivetSource().agents(runId))?.length).toBe(0);
}, 60_000);
