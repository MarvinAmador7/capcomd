// ADR-021 §3 against a real engine: the machine owners the resources route joins with a provider's list come from
// capcomd's own records (a live agent's worker actor holding a VM), and the daemon's routes serve them over
// rivetSource. The daemon runs the in-memory fake; Docker is a stub CLI (it lists one container this capcomd left
// behind and one another capcomd made, logs what it's asked, and answers nothing else) and boxd has no key, so nothing
// real is listed, created or called. The worker records its VM in this capcomd's machines ledger and removes the
// record once it destroyed the machine.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { machineOwners, rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { stateDir } from "../../src/utils/home";
import { newRun, waitAll, world, type World } from "./harness";

const stubs = mkdtempSync(join(tmpdir(), "capcomd-sbxres-"));
const docker = join(stubs, "docker");
const dockerLog = join(stubs, "docker.log");
const ledger = join(stubs, "machines");
writeFileSync(docker, `#!/bin/sh\necho "$*" >> ${JSON.stringify(dockerLog)}\nif [ "$1" = ps ]; then printf 'relay-aaaaaaaaaaaaaaaa\\trunning\\t2026-10-27 09:12:03 +0000 UTC\\nrelay-bbbbbbbbbbbbbbbb\\trunning\\t2026-10-27 09:13:00 +0000 UTC\\n'; exit 0; fi\necho "stub docker: no daemon" >&2; exit 1\n`);
chmodSync(docker, 0o755);
// This capcomd made relay-aaaa… (a check whose process is gone: left behind); relay-bbbb… isn't in its ledger.
mkdirSync(ledger, { recursive: true });
writeFileSync(join(ledger, "relay-aaaaaaaaaaaaaaaa.json"), JSON.stringify({ name: "relay-aaaaaaaaaaaaaaaa", sandbox: "docker", kind: "check", purpose: "checks", runId: null, taskId: null, agent: null, pid: 2 ** 22 + 7, createdAt: Date.now(), ttlSeconds: 3600 }));
const records = () => readdirSync(ledger).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(ledger, f), "utf8")));

let w: World;
const flags: string[] = [];
const agents: string[] = [];
beforeAll(async () => { w = await world("sbxres", { CAPCOMD_DOCKER_BIN: docker, BOXD_API_KEY: "", CAPCOMD_MACHINES_LEDGER: ledger }); }, 120_000);
// A failed assertion must not leave the agent's script waiting on its flag forever: its detached driver
// (`capcomd agent-drive`) would outlive the engine. Release the script, then wait for the driver to exit (kill it if not).
afterAll(async () => {
	for (const f of flags) if (!existsSync(f)) writeFileSync(f, "");
	const pids = agents.map((a) => { try { return Number(readFileSync(join(stateDir(), "drivers", `${a}.pid`), "utf8")); } catch { return 0; } }).filter((p) => p > 0);
	const alive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
	for (let i = 0; i < 100 && pids.some(alive); i++) await Bun.sleep(200);
	for (const p of pids.filter(alive)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
	await w?.stop();
}, 60_000);

test("a live agent's machine is owned (run, agent, role, task's first line); it's gone from the owners once the agent ends", async () => {
	const run = await newRun(w);
	const flag = join(w.dir, "go");
	flags.push(flag);
	const hold = w.script("sbx-hold", `while [ ! -f ${JSON.stringify(flag)} ]; do sleep 0.2; done\ncapcomd result --summary ok >/dev/null`);
	const r = await w.cj(["spawn", run, "--profile", "worker", "--task", "Add an abs(a) function\nwith tests", "--key", "sbx-1", "--contract", JSON.stringify({ script: hold })]);
	expect(r.code).toBe(0);
	const agentId = r.j.agentId as string;
	agents.push(agentId);
	let mine: Awaited<ReturnType<typeof machineOwners>>["owners"][number] | undefined;
	for (let i = 0; i < 300 && !mine?.vmId; i++) {
		mine = (await machineOwners()).owners.find((o) => o.agentId === agentId);
		if (!mine?.vmId) await Bun.sleep(200);
	}
	expect(mine).toMatchObject({ sandbox: "fake", runId: run, agentId, role: "worker", task: "Add an abs(a) function" });
	expect(mine!.vmId).toBeTruthy();
	expect(mine!.descendants).toBe(0);   // no agents of its own: its Delete question names only it
	expect(mine!.name).toMatch(/^relay-[0-9a-f]{16}$/);
	expect(["idle", "busy", "provisioning"]).toContain(mine!.workerState);
	// The worker recorded its VM in this capcomd's ledger (before making it), by its own actor key.
	expect(records().filter((x) => x.kind === "agent")).toEqual([expect.objectContaining({ name: mine!.name, sandbox: "fake", kind: "agent", runId: run, agentId, workerKey: [run, agentId] })]);
	// An agent outside the recent runs (none scanned here) still owns its machine: its record's own agent is asked.
	expect((await machineOwners(0)).owners.find((o) => o.agentId === agentId)).toMatchObject({ sandbox: "fake", name: mine!.name, runId: run, role: "worker", task: "Add an abs(a) function" });

	// The routes over the real source: docker's stub lists one container no agent holds (orphaned); boxd has no key.
	const clients = join(w.dir, "sbx-clients.json");
	const { token } = addClient("sbx", ["read", "steer"], clients);
	const app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), state: harnessState(null) });
	const get = async (p: string) => { const res = await app.request(p, { headers: { authorization: `Bearer ${token}` } }); return { status: res.status, body: (await res.json()) as any }; };
	const post = async (p: string) => { const res = await app.request(p, { method: "POST", headers: { authorization: `Bearer ${token}`, "idempotency-key": `k-${Math.random()}` } }); return { status: res.status, body: (await res.json()) as any }; };
	const list = await get("/v1/sandboxes");
	expect(list.status).toBe(200);
	expect(list.body.sandboxes.map((s: any) => [s.name, s.available, s.default])).toEqual([["docker", false, false], ["boxd", false, false]]);
	expect((await get("/v1/sandboxes/boxd")).body.settings[0]).toMatchObject({ id: "idleLifetime", value: "3600", display: "1 hour" });
	const dock = await get("/v1/sandboxes/docker/resources");
	expect(dock).toEqual({ status: 200, body: { resources: [{ id: "relay-aaaaaaaaaaaaaaaa", kind: "machine", state: "orphaned", owner: null, createdAt: "2026-10-27T09:12:03.000Z", deleteAfter: null, actions: ["open_terminal", "delete"], destructive: true, confirm: "Delete this machine? No agent is using it." }], asOf: expect.any(String), stale: false, error: null, next: null } });
	expect((await get("/v1/sandboxes/docker/resources/relay-aaaaaaaaaaaaaaaa")).body.terminalCommand).toBe("capcomd sandbox shell --sandbox docker --machine relay-aaaaaaaaaaaaaaaa");
	// Another capcomd's container (not in this ledger): not listed, and Delete is 404 without asking Docker to remove it.
	expect((await get("/v1/sandboxes/docker/resources/relay-bbbbbbbbbbbbbbbb")).status).toBe(404);
	expect(await post("/v1/sandboxes/docker/resources/relay-bbbbbbbbbbbbbbbb/actions/delete")).toEqual({ status: 404, body: { code: "not_found", message: "machine relay-bbbbbbbbbbbbbbbb isn't one of capcomd's machines on Local" } });
	expect(readFileSync(dockerLog, "utf8").split("\n").filter((l) => l.startsWith("rm"))).toEqual([]);
	expect((await get("/v1/sandboxes/boxd/resources")).body).toMatchObject({ resources: [], asOf: null, stale: true, error: "boxd isn't set up or isn't reachable (run capcomd setup check)" });

	writeFileSync(flag, "");
	expect((await waitAll(w, run, [agentId])).agents[0].status).toBe("done");
	expect(existsSync(flag)).toBe(true);
	expect((await machineOwners()).owners.some((o) => o.agentId === agentId)).toBe(false);
	// Its worker destroyed the VM: the record is gone; the left-behind check's record stays.
	for (let i = 0; i < 150 && records().some((x) => x.kind === "agent"); i++) await Bun.sleep(200);
	expect(records().map((x) => x.name)).toEqual(["relay-aaaaaaaaaaaaaaaa"]);
}, 180_000);
