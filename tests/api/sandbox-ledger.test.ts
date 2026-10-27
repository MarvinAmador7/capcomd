// ADR-021 §3, §5, decision 8: the resources route lists, and Delete touches, only machines this capcomd made. A boxd
// org lists every member's machines and a second capcomd on the same Mac sees the same Docker containers, all with
// capcomd's prefix; so a machine without a live owner is listed only when it's in this capcomd's machines ledger
// (src/providers/machines.ts), and only then is it left behind (orphaned, deletable). Engine-free: the real ledger in
// temporary directories, machineOwners with no recent runs to scan and the record's own agent check injected, and one
// in-memory provider two "daemons" share. Nothing here reaches a real daemon or provider.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineOwners } from "../../src/api/rivet-source";
import { resourceCatalog, type MachineOwner } from "../../src/api/sandboxes";
import { forgetMachine, liveJobMachines, machineNameFor, machinesDir, readMachineLedger, recordAgentMachine, type AgentMachine } from "../../src/providers/machines";
import { resetMachineAudit } from "../../src/providers/machine-audit";
import type { VmInfo } from "../../src/providers/sandbox";

const saved = { ...process.env };
const root = mkdtempSync(join(tmpdir(), "capcomd-ledger-api-"));
// recentRuns reads this process's state: a scratch home with no runs (and no engine: a dead endpoint).
beforeAll(() => { process.env.CAPCOMD_HOME = join(root, "self"); process.env.CAPCOMD_ENDPOINT = "http://127.0.0.1:9"; delete process.env.CAPCOMD_MACHINES_LEDGER; delete process.env.CAPCOMD_SANDBOX; });
afterAll(() => { resetMachineAudit(); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

/** One provider's machines, as Docker on one Mac (or one boxd org) shows them to every capcomd that asks. */
class SharedProvider {
	machines = new Map<string, VmInfo>();
	destroyed: string[] = [];
	ensure(idemKey: string): VmInfo { const name = machineNameFor(idemKey); const m = { id: `c_${name.slice(-6)}`, name, state: "running" }; this.machines.set(name, m); return m; }
	async list(): Promise<VmInfo[]> { return [...this.machines.values()]; }
	async destroy(id: string) { this.destroyed.push(id); for (const [k, v] of this.machines) if (v.id === id) this.machines.delete(k); }
}

/**
 * One capcomd: its own home (so its own ledger), the agents it knows are live (what asking an agent directly answers),
 * and its resources catalog over the shared provider. `make` records the machine the way a worker does, then makes it.
 */
function daemon(name: string, provider: SharedProvider, o: { check?: (rec: AgentMachine) => Promise<MachineOwner | null> } = {}) {
	const env = { CAPCOMD_HOME: join(root, name) };
	const live = new Map<string, MachineOwner>();
	const cancelled: string[] = [];
	const asked: string[] = [];
	const check = o.check ?? (async (rec: AgentMachine) => { asked.push(rec.agentId); return live.get(rec.agentId) ?? null; });
	const cat = resourceCatalog({
		ttlMs: 0,
		list: async () => provider.list(),
		owners: () => machineOwners(0, env, { recordedOwner: check }),
		destroy: async (_n, id) => provider.destroy(id),
		forget: (_n, m) => forgetMachine(m, env),
		cancelAgent: async (_r, agentId) => { cancelled.push(agentId); return { changed: true }; },
	});
	const make = (idemKey: string, runId: string, agentId: string) => {
		expect(recordAgentMachine({ idemKey, sandbox: "docker", runId, agentId, workerKey: [runId, agentId], ttlSeconds: 3600 }, env)).toBe(true);
		return provider.ensure(idemKey);
	};
	const owner = (m: VmInfo, runId: string, agentId: string): MachineOwner => ({ sandbox: "docker", vmId: m.id, name: m.name, runId, agentId, role: "worker", task: "Add an abs(a) function", workerState: "busy", createdAt: null, descendants: 0 });
	const ids = async () => (await cat.page("docker"))!.resources.map((r) => [r.id, r.state, r.owner?.agentId ?? null, r.actions]);
	return { env, live, cancelled, asked, cat, make, owner, ids };
}

describe("only this capcomd's machines", () => {
	test("a machine with capcomd's prefix that isn't in this ledger isn't listed, and its Delete is 404 with no provider call", async () => {
		const p = new SharedProvider();
		const me = daemon("a1", p);
		p.ensure("someone-elses-run-agt-9"); // another capcomd's (or from before the ledger): only the prefix
		const mine = me.make("relay-run-1-agt-1-e1", "run-1", "agt-1");
		expect(await me.ids()).toEqual([[mine.name, "orphaned", null, ["open_terminal", "delete"]]]);
		const theirs = machineNameFor("someone-elses-run-agt-9");
		expect(await me.cat.get("docker", theirs)).toBeNull();
		expect(await me.cat.act("docker", theirs, "delete", "client:t")).toEqual({ ok: false, status: 404, code: "not_found", message: `machine ${theirs} isn't one of capcomd's machines on Local` });
		expect(p.destroyed).toEqual([]);
		expect(p.machines.has(theirs)).toBe(true);
	});

	test("a recorded machine whose agent is live (outside the recent runs) is owned: no orphan Delete; Delete cancels that agent", async () => {
		const p = new SharedProvider();
		const me = daemon("a2", p);
		const m = me.make("relay-run-old-agt-7-e1", "run-old", "agt-7");
		me.live.set("agt-7", me.owner(m, "run-old", "agt-7"));
		const [r] = (await me.cat.page("docker"))!.resources;
		expect(me.asked).toEqual(["agt-7"]); // the record's own agent, asked directly: no recent run named it
		expect(r).toMatchObject({ id: m.name, state: "running", owner: { kind: "agent", runId: "run-old", agentId: "agt-7" }, actions: ["open_terminal", "delete"],
			confirm: "Delete worker's machine? This stops the worker on “Add an abs(a) function”. Work since its last checkpoint is lost." });
		expect(await me.cat.act("docker", m.name, "delete", "client:t")).toMatchObject({ ok: true, changed: true, owner: { agentId: "agt-7" } });
		expect(me.cancelled).toEqual(["agt-7"]);
		expect(p.destroyed).toEqual([]); // the agent's own lifecycle destroys it, never the provider from here
		// A worker still provisioning (no VM id yet, though the provider lists it already) is owned too: starting.
		const q = me.make("relay-run-old-agt-8-e1", "run-old", "agt-8");
		me.live.set("agt-8", { ...me.owner(q, "run-old", "agt-8"), vmId: null, workerState: "provisioning" });
		expect((await me.cat.page("docker"))!.resources.find((x) => x.id === q.name)).toMatchObject({ state: "starting", actions: [] });
	});

	test("a recorded machine with no live owner is left behind: Delete destroys it at the provider and drops its record", async () => {
		const p = new SharedProvider();
		const me = daemon("a3", p);
		const m = me.make("relay-run-2-agt-2-e1", "run-2", "agt-2");
		expect(readdirSync(machinesDir(me.env))).toEqual([`${m.name}.json`]);
		expect(await me.ids()).toEqual([[m.name, "orphaned", null, ["open_terminal", "delete"]]]);
		expect(await me.cat.act("docker", m.name, "delete", "client:t")).toMatchObject({ ok: true, changed: true, owner: null });
		expect(p.destroyed).toEqual([m.id]);
		expect(readdirSync(machinesDir(me.env))).toEqual([]);
		expect(await me.ids()).toEqual([]);
	});

	test("a record that can't be read, a ledger that can't be read, or an agent that can't be asked: unknown, never deletable", async () => {
		const p = new SharedProvider();
		const me = daemon("a4", p);
		const a = me.make("relay-run-3-agt-3-e1", "run-3", "agt-3");
		const b = me.make("relay-run-3-agt-4-e1", "run-3", "agt-4");
		writeFileSync(join(machinesDir(me.env), `${a.name}.json`), "{ not json");
		expect(readMachineLedger(me.env)).toEqual(expect.arrayContaining([{ name: a.name, record: null }]));
		expect(await me.ids()).toEqual([[a.name, "unknown", null, ["open_terminal"]], [b.name, "orphaned", null, ["open_terminal", "delete"]]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
		const r = await me.cat.act("docker", a.name, "delete", "client:t");
		expect(r).toMatchObject({ ok: false, status: 409 });
		expect(p.destroyed).toEqual([]);
		// The whole ledger unreadable: nobody can say which machines are capcomd's, so nothing is deletable.
		const dir = machinesDir(me.env);
		chmodSync(dir, 0o000);
		try {
			expect(readMachineLedger(me.env)).toBeNull();
			const page = (await me.cat.page("docker"))!.resources;
			expect(page.map((x) => [x.state, x.actions.includes("delete")])).toEqual([["unknown", false], ["unknown", false]]);
			expect((await me.cat.act("docker", b.name, "delete", "client:t")).ok).toBe(false);
			expect(p.destroyed).toEqual([]);
		} finally { chmodSync(dir, 0o700); }
		// The record's agent can't be asked (the engine didn't answer): unknown.
		const blind = daemon("a4", p, { check: async () => { throw new Error("engine down"); } });
		expect((await blind.cat.page("docker"))!.resources.find((x) => x.id === b.name)).toMatchObject({ state: "unknown", actions: ["open_terminal"] });
		expect((await blind.cat.act("docker", b.name, "delete", "client:t")).ok).toBe(false);
		expect(p.destroyed).toEqual([]);
		// A missing ledger is an empty one (nothing recorded, so nothing listed), not an unreadable one.
		expect(readMachineLedger({ CAPCOMD_MACHINES_LEDGER: join(root, "never-made") })).toEqual([]);
	});

	test("two capcomds with their own homes sharing one provider never see each other's machines", async () => {
		const p = new SharedProvider();
		const a = daemon("two-a", p);
		const b = daemon("two-b", p);
		const ma = a.make("relay-run-a-agt-1-e1", "run-a", "agt-1");
		const mb = b.make("relay-run-b-agt-1-e1", "run-b", "agt-1");
		b.live.set("agt-1", b.owner(mb, "run-b", "agt-1")); // b's agent is working; a's left its machine behind
		expect(await a.ids()).toEqual([[ma.name, "orphaned", null, ["open_terminal", "delete"]]]);
		expect(await b.ids()).toEqual([[mb.name, "running", "agt-1", ["open_terminal", "delete"]]]);
		expect((await a.cat.act("docker", mb.name, "delete", "client:a")).ok).toBe(false);
		expect((await b.cat.act("docker", ma.name, "delete", "client:b")).ok).toBe(false);
		expect([p.destroyed, a.cancelled, b.cancelled]).toEqual([[], [], []]);
		expect(await a.cat.act("docker", ma.name, "delete", "client:a")).toMatchObject({ ok: true, changed: true });
		expect(p.destroyed).toEqual([ma.id]);
		expect([...p.machines.keys()]).toEqual([mb.name]);
		expect(await b.ids()).toEqual([[mb.name, "running", "agt-1", ["open_terminal", "delete"]]]);
	});
});

describe("agent records in the ledger", () => {
	test("written atomically with mode 0600, kept whatever the writing process, never counted as a job, removed by forget", () => {
		const env = { CAPCOMD_MACHINES_LEDGER: mkdtempSync(join(root, "rec-")) };
		expect(recordAgentMachine({ idemKey: "relay-run-9-agt-9-e2", sandbox: "boxd", runId: "run-9", agentId: "agt-9", workerKey: ["run-9", "agt-9", "e2"], ttlSeconds: 900 }, env)).toBe(true);
		const name = machineNameFor("relay-run-9-agt-9-e2");
		const file = join(env.CAPCOMD_MACHINES_LEDGER, `${name}.json`);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readdirSync(env.CAPCOMD_MACHINES_LEDGER)).toEqual([`${name}.json`]); // no temporary file left over
		expect(readMachineLedger(env)).toEqual([{ name, record: expect.objectContaining({ name, sandbox: "boxd", kind: "agent", runId: "run-9", agentId: "agt-9", workerKey: ["run-9", "agt-9", "e2"] }) }]);
		expect(liveJobMachines(env)).toEqual([]);
		forgetMachine(name, env);
		forgetMachine(name, env); // twice: fine
		expect(existsSync(file)).toBe(false);
		forgetMachine("../../etc/passwd", env); // not a machine name: nothing touched
	});
	test("a ledger that can't be written never throws: the machine just isn't recorded", () => {
		const notDir = join(root, "a-file");
		writeFileSync(notDir, "x");
		expect(recordAgentMachine({ idemKey: "k", sandbox: "docker", runId: "r", agentId: "a", workerKey: ["r", "a"], ttlSeconds: 60 }, { CAPCOMD_MACHINES_LEDGER: notDir })).toBe(false);
		expect(readMachineLedger({ CAPCOMD_MACHINES_LEDGER: notDir })).toBeNull();
	});
});
