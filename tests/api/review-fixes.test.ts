// Regression tests for Axiom's review of #38: decision race, socket mode at creation, stable stream seq, idempotency across restart.
import { expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { harnessApp } from "../../src/api/server";
import { serveHarnessSocket } from "../../src/api/socket";
import { harnessState } from "../../src/api/state";
import { memorySource } from "../../src/api/source";

const dir = mkdtempSync(join(tmpdir(), "harness-rf-"));
const cpath = join(dir, "clients.json");
const tok = addClient("ive", ["read", "approve"], cpath).token;
const apr = { approvalId: "apr-1", kind: "merge" as const, status: "pending" as const, question: "merge?", requestedBy: { agentId: "a1", runId: "run-1" }, subject: { target: "main" }, expiresAt: null };
const run = (id: string, createdAt: string) => ({ id, projectId: null, label: id, state: "running", goal: null, title: null, titleSource: null, repo: "/r", createdAt });

function slowSource() {
	const src = memorySource({ runs: [run("run-1", "2026-10-25T07:00:00.000Z")], approvals: { "run-1": [apr] } });
	const decide = src.decide;
	src.decide = async (...a) => { await new Promise((r) => setTimeout(r, 30)); return decide(...a); };
	return src;
}
const post = (app: ReturnType<typeof harnessApp>, key: string, decision = "approve") => app.request("/v1/approvals/apr-1/decision", { method: "POST", headers: { authorization: `Bearer ${tok}`, "idempotency-key": key, "content-type": "application/json" }, body: JSON.stringify({ decision }) });

test("concurrent decisions with different keys: exactly one decides, the other gets 409 already_decided", async () => {
	const src = slowSource();
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null) });
	const [a, b] = await Promise.all([post(app, "key-aaaaaaaa"), post(app, "key-bbbbbbbb", "deny")]);
	expect([a.status, b.status].sort()).toEqual([200, 409]);
	expect(((await (a.status === 409 ? a : b).json()) as any).code).toBe("already_decided");
	expect(src.decided.length).toBe(1);
});

test("concurrent decisions with the same key+body: one decide, both 200 with the same result", async () => {
	const src = slowSource();
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null) });
	const [a, b] = await Promise.all([post(app, "key-same0001"), post(app, "key-same0001")]);
	expect([a.status, b.status]).toEqual([200, 200]);
	expect(await a.json()).toEqual(await b.json());
	expect(src.decided.length).toBe(1);
});

test("idempotent replay survives a daemon restart", async () => {
	const sp = join(dir, "state-restart.json");
	const src = memorySource({ runs: [run("run-1", "2026-10-25T07:00:00.000Z")], approvals: { "run-1": [apr] } });
	const r1 = await post(harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(sp) }), "key-restart1");
	expect(r1.status).toBe(200);
	expect(statSync(sp).mode & 0o777).toBe(0o600);
	const app2 = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(sp) }); // "restarted"
	const r2 = await post(app2, "key-restart1");
	expect(r2.status).toBe(200);
	expect(await r2.json()).toEqual(await r1.json());
	expect(src.decided.length).toBe(1);
	expect((await post(app2, "key-restart1", "deny")).status).toBe(409);
	expect(((await (await post(app2, "key-other001")).json()) as any).code).toBe("already_decided");
});

test("socket is created under umask 0177 (0600 at creation) and umask is restored", async () => {
	const orig = Bun.serve;
	let umaskAtServe = -1;
	(Bun as any).serve = (o: any) => { umaskAtServe = process.umask(); process.umask(umaskAtServe); return orig(o); };
	const before = process.umask();
	const sock = join(mkdtempSync(join(tmpdir(), "hs-um-")), "d", "h.sock");
	try {
		const s = await serveHarnessSocket(sock, () => new Response("ok"));
		expect(umaskAtServe).toBe(0o177);
		expect(process.umask()).toBe(before);
		expect(statSync(sock).mode & 0o777).toBe(0o600);
		expect(statSync(join(sock, "..")).mode & 0o777).toBe(0o700);
		s.close();
	} finally { (Bun as any).serve = orig; }
});

test("daemon stream seq is stable across deleted runs and equal createdAt", () => {
	const sp = join(dir, "state-seq.json");
	const t = "2026-10-25T07:00:00.000Z";
	const st = harnessState(sp);
	const s1 = st.seqs([run("run-b", t), run("run-a", t), run("run-c", "2026-10-25T08:00:00.000Z")]);
	expect([s1.get("run-a"), s1.get("run-b"), s1.get("run-c")]).toEqual([1, 2, 3]);
	// run-a deleted, run-d added with a tied timestamp; after restart, existing seqs unchanged and no reuse
	const s2 = harnessState(sp).seqs([run("run-c", "2026-10-25T08:00:00.000Z"), run("run-d", t), run("run-b", t)]);
	expect([s2.get("run-b"), s2.get("run-c"), s2.get("run-d")]).toEqual([2, 3, 4]);
});

test("Last-Event-ID resume on the daemon stream after a delete does not skip a new run", async () => {
	const t = "2026-10-25T07:00:00.000Z";
	const src = memorySource({ runs: [run("run-a", t), run("run-b", t)] });
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null), pollMs: 20 });
	const read = async (last: string) => {
		const res = await app.request("/v1/streams/daemon/events", { headers: { authorization: `Bearer ${tok}`, "last-event-id": last } });
		const r = res.body!.getReader(); let txt = ""; const end = Date.now() + 300;
		while (Date.now() < end) { const x: any = await Promise.race([r.read(), new Promise((ok) => setTimeout(() => ok(null), 50))]); if (x?.value) txt += new TextDecoder().decode(x.value); }
		r.cancel().catch(() => {}); return txt;
	};
	await read("0");
	(await src.runs()).splice(0, 1); // delete run-a
	(await src.runs()).push(run("run-c", t));
	const txt = await read("2");
	expect(txt).toContain("id: 3\nevent: run.created");
	expect(txt).toContain('"runId":"run-c"');
});
