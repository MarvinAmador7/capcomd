// ADR-021 §3 against a real engine: the machine owners the resources route joins with a provider's list come from
// capcomd's own records (a live agent's worker actor holding a VM), and the daemon's routes serve them over
// rivetSource. The daemon runs the in-memory fake; Docker is a stub CLI (it lists one container left behind and
// answers nothing else) and boxd has no key, so nothing real is listed, created or called.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { machineOwners, rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { newRun, waitAll, world, type World } from "./harness";

const stubs = mkdtempSync(join(tmpdir(), "capcomd-sbxres-"));
const docker = join(stubs, "docker");
writeFileSync(docker, `#!/bin/sh\nif [ "$1" = ps ]; then printf 'relay-aaaaaaaaaaaaaaaa\\trunning\\t2026-10-27 09:12:03 +0000 UTC\\n'; exit 0; fi\necho "stub docker: no daemon" >&2; exit 1\n`);
chmodSync(docker, 0o755);

let w: World;
beforeAll(async () => { w = await world("sbxres", { CAPCOMD_DOCKER_BIN: docker, BOXD_API_KEY: "" }); }, 120_000);
afterAll(async () => { await w?.stop(); });

test("a live agent's machine is owned (run, agent, role, task's first line); it's gone from the owners once the agent ends", async () => {
	const run = await newRun(w);
	const flag = join(w.dir, "go");
	const hold = w.script("sbx-hold", `while [ ! -f ${JSON.stringify(flag)} ]; do sleep 0.2; done\ncapcomd result --summary ok >/dev/null`);
	const r = await w.cj(["spawn", run, "--profile", "worker", "--task", "Add an abs(a) function\nwith tests", "--key", "sbx-1", "--contract", JSON.stringify({ script: hold })]);
	expect(r.code).toBe(0);
	const agentId = r.j.agentId as string;
	let mine: Awaited<ReturnType<typeof machineOwners>>[number] | undefined;
	for (let i = 0; i < 300 && !mine; i++) {
		mine = (await machineOwners()).find((o) => o.agentId === agentId);
		if (!mine) await Bun.sleep(200);
	}
	expect(mine).toMatchObject({ sandbox: "fake", runId: run, agentId, role: "worker", task: "Add an abs(a) function" });
	expect(mine!.vmId).toBeTruthy();
	expect(mine!.descendants).toBe(0);   // no agents of its own: its Delete question names only it
	expect(mine!.name).toMatch(/^relay-[0-9a-f]{16}$/);
	expect(["idle", "busy", "provisioning"]).toContain(mine!.workerState);

	// The routes over the real source: docker's stub lists one container no agent holds (orphaned); boxd has no key.
	const clients = join(w.dir, "sbx-clients.json");
	const { token } = addClient("sbx", ["read"], clients);
	const app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), state: harnessState(null) });
	const get = async (p: string) => { const res = await app.request(p, { headers: { authorization: `Bearer ${token}` } }); return { status: res.status, body: (await res.json()) as any }; };
	const list = await get("/v1/sandboxes");
	expect(list.status).toBe(200);
	expect(list.body.sandboxes.map((s: any) => [s.name, s.available, s.default])).toEqual([["docker", false, false], ["boxd", false, false]]);
	expect((await get("/v1/sandboxes/boxd")).body.settings[0]).toMatchObject({ id: "idleLifetime", value: "3600", display: "1 hour" });
	const dock = await get("/v1/sandboxes/docker/resources");
	expect(dock).toEqual({ status: 200, body: { resources: [{ id: "relay-aaaaaaaaaaaaaaaa", kind: "machine", state: "orphaned", owner: null, createdAt: "2026-10-27T09:12:03.000Z", deleteAfter: null, actions: ["open_terminal", "delete"], destructive: true, confirm: "Delete this machine? No agent is using it." }], asOf: expect.any(String), stale: false, error: null, next: null } });
	expect((await get("/v1/sandboxes/docker/resources/relay-aaaaaaaaaaaaaaaa")).body.terminalCommand).toBe("capcomd sandbox shell --sandbox docker --machine relay-aaaaaaaaaaaaaaaa");
	expect((await get("/v1/sandboxes/boxd/resources")).body).toMatchObject({ resources: [], asOf: null, stale: true, error: "boxd isn't set up or isn't reachable (run capcomd setup check)" });

	writeFileSync(flag, "");
	expect((await waitAll(w, run, [agentId])).agents[0].status).toBe("done");
	expect(existsSync(flag)).toBe(true);
	expect((await machineOwners()).some((o) => o.agentId === agentId)).toBe(false);
}, 180_000);
