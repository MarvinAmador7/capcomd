// The daemon/project stream must stay cheap for the engine (2026-10-27: a menubar on the daemon stream, with a state
// file holding ~420 runs the daemon's ledger didn't list, read every one of their logs every 500ms with overlapping
// ticks; the engine saturated, stopped answering, and serve's watchdog took it down).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { memorySource } from "../../src/api/source";

const dir = mkdtempSync(join(tmpdir(), "harness-load-"));
const cpath = join(dir, "clients.json");
const tok = addClient("load", ["read"], cpath).token;
const run = (id: string, createdAt = "2026-10-25T07:00:00.000Z") => ({ id, projectId: null, label: id, state: "running", goal: null, repo: "/r", createdAt });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stream(app: ReturnType<typeof harnessApp>, path: string, ms: number) {
	const res = await app.request(path, { headers: { authorization: `Bearer ${tok}` } });
	const r = res.body!.getReader(); let txt = ""; const end = Date.now() + ms;
	while (Date.now() < end) { const x: any = await Promise.race([r.read(), sleep(20).then(() => null)]); if (x?.value) txt += new TextDecoder().decode(x.value); }
	await r.cancel().catch(() => {});
	return txt;
}

function counted(listed: ReturnType<typeof run>[], runsDelayMs = 0) {
	const src = memorySource({ runs: listed });
	const reads = new Map<string, number>();
	let inRuns = 0, maxInRuns = 0;
	const events = src.events, runs = src.runs;
	src.events = async (id, after) => { reads.set(id, (reads.get(id) ?? 0) + 1); return events(id, after); };
	src.runs = async () => { inRuns++; maxInRuns = Math.max(maxInRuns, inRuns); try { await sleep(runsDelayMs); return await runs(); } finally { inRuns--; } };
	return { src, reads, maxInRuns: () => maxInRuns };
}

test("runs the state knows but the list doesn't are checked for run.deleted once, not on every tick", async () => {
	const state = harnessState(null);
	state.seqs(Array.from({ length: 50 }, (_, i) => run(`run-ghost-${i}`)));
	const { src, reads } = counted([run("run-live")]);
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state, pollMs: 10 });
	const txt = await stream(app, "/v1/streams/daemon/events", 300);
	expect(txt).toContain('"runId":"run-live"');
	expect(reads.size).toBe(50);
	expect(Math.max(...reads.values())).toBe(1);
	// A reconnect (the menubar re-subscribes) doesn't read them again either.
	await stream(app, "/v1/streams/daemon/events", 150);
	expect(Math.max(...reads.values())).toBe(1);
	expect(state.knownRuns()).toHaveLength(51); // never dropped without a confirmed run.deleted
});

test("a run that leaves the list is checked once, and its seq dropped on run.deleted", async () => {
	const state = harnessState(null);
	const { src, reads } = counted([run("run-a"), run("run-b")]);
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state, pollMs: 10 });
	await stream(app, "/v1/streams/daemon/events", 100);
	expect(reads.size).toBe(0);
	src.push("run-a", { type: "run.deleted", agentId: null, data: {}, at: Date.now() });
	(await src.runs()).splice(0, 1);
	await stream(app, "/v1/streams/daemon/events", 150);
	expect(reads.get("run-a")).toBe(1);
	expect(state.knownRuns()).toEqual(["run-b"]);
});

test("a slow source never gets overlapping daemon-stream ticks", async () => {
	const { src, maxInRuns } = counted([run("run-1")], 80);
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null), pollMs: 5 });
	await stream(app, "/v1/streams/daemon/events", 400);
	expect(maxInRuns()).toBe(1);
});
