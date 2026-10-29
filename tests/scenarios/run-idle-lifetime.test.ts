// ADR-021 §2 against a real engine: `run new` records the provider's idle machine lifetime with the run (`_sandbox`
// `{name?, settings: {idleLifetime}}`), and the run's workers use it (the worker's lease, ttlMs, and the VM's
// delete-after), whatever the daemon's setting is by then; a run with nothing recorded uses the daemon's current
// setting. The daemon (engine) runs with CAPCOMD_SANDBOX_IDLE_SECONDS=1800; runs are started with other values.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { RUN_SANDBOX_KV } from "../../src/providers/run-sandbox";
import { capcomd } from "../helpers/engine";
import { waitAll, world, type World } from "./harness";

let w: World;
beforeAll(async () => { w = await world("runlife", { CAPCOMD_SANDBOX_IDLE_SECONDS: "1800" }); }, 120_000);
afterAll(async () => { await w?.stop(); });

const workerOf = async (run: string, id: string): Promise<any> => {
	const { client } = await import("../../src/core/relay");
	return client().worker.getOrCreate([run, id]).getWorker({ workerId: id });
};

test("each run's workers get the idle lifetime recorded when it started; a run without one gets the daemon's", async () => {
	const { runNew } = await import("../../src/primitives/ops");
	const { kvWrite } = await import("../../src/primitives/state");
	// A run on its own place, started while the setting was 4 hours (in-process `run new`).
	process.env.CAPCOMD_SANDBOX_IDLE_SECONDS = "14400";
	let own: string;
	try { own = (await runNew({ budget: {}, label: "own place", sandbox: "fake-host", key: `life-own-${Date.now()}` })).runId as string; } finally { process.env.CAPCOMD_SANDBOX_IDLE_SECONDS = "1800"; }
	expect((await w.cj(["kv", "get", own, RUN_SANDBOX_KV])).j.value).toEqual({ name: "fake-host", settings: { idleLifetime: 14400 } });
	// A run on the daemon's place, started from the CLI while the setting was 15 minutes: only settings, no name.
	const r = await capcomd(["run", "new", "--budget", "usd=10,turns=400", "--key", `life-plain-${Date.now()}`, "--json"], { ...w.env, PWD: w.dir, CAPCOMD_SANDBOX_IDLE_SECONDS: "900" });
	expect(r.code).toBe(0);
	const plain = JSON.parse(r.stdout.trim().split("\n").pop()!).runId as string;
	expect((await w.cj(["kv", "get", plain, RUN_SANDBOX_KV])).j.value).toEqual({ settings: { idleLifetime: 900 } });
	// `run new` again (idempotent): the run keeps what it started with, even though the setting changed since.
	const again = await capcomd(["run", "new", "--budget", "usd=10,turns=400", "--run-id", plain, "--json"], { ...w.env, PWD: w.dir, CAPCOMD_SANDBOX_IDLE_SECONDS: "43200" });
	expect(again.code).toBe(0);
	expect((await w.cj(["kv", "get", plain, RUN_SANDBOX_KV])).j.value).toEqual({ settings: { idleLifetime: 900 } });
	// A run from before settings (nothing recorded): the daemon's current setting when its worker starts.
	const legacy = (await runNew({ budget: {}, label: "legacy", key: `life-legacy-${Date.now()}` })).runId as string;
	await kvWrite(legacy, { k: RUN_SANDBOX_KV, value: null, del: true, writer: "operator" });

	const done = w.script("life-done", `capcomd result --summary ok >/dev/null`);
	const spawn = async (run: string) => (await w.cj(["spawn", run, "--profile", "worker", "--task", "t", "--key", "w", "--contract", JSON.stringify({ script: done })])).j.agentId as string;
	const [a, b, c] = [await spawn(own), await spawn(plain), await spawn(legacy)];
	for (const [run, id] of [[own, a], [plain, b], [legacy, c]] as const) expect((await waitAll(w, run, [id])).agents[0].status).toBe("done");
	expect((await workerOf(own, a!))?.context).toMatchObject({ sandbox: "fake-host", ttlMs: 14_400_000 });
	expect((await workerOf(plain, b!))?.context?.ttlMs).toBe(900_000);
	expect((await workerOf(legacy, c!))?.context?.ttlMs).toBe(1_800_000);
}, 180_000);
