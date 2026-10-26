// runs.create against a real engine: POST /v1/runs starts the run through `capcomd run --detach` (the CLI's own path),
// and the run then shows on the daemon stream (run.created) and in GET /v1/runs like a run started from the CLI.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addClient, loadClients } from "../../src/api/clients";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { projectIdOf } from "../../src/api/source";
import { harnessState } from "../../src/api/state";
import { sleep } from "../helpers/engine";
import { world, type World } from "./harness";

let w: World;
let app: ReturnType<typeof harnessApp>;
let token = "";
const started: string[] = [];
// Its own CAPCOMD_HOME: the runs index the daemon lists is this test's alone.
const home = mkdtempSync(join(tmpdir(), "capcomd-createrun-home-"));

beforeAll(async () => {
	w = await world("createrun", { CAPCOMD_HOME: home });
	const clients = join(home, "harness-clients.json");
	token = addClient("menubar", ["read", "steer"], clients).token;
	app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), state: harnessState(null), pollMs: 100 });
}, 120_000);

afterAll(async () => {
	// Let the background runs finish (fake agents: seconds), else cancel them, before the engine goes.
	for (const id of started) {
		let state = "";
		for (let i = 0; i < 90 && !["completed", "failed", "cancelled"].includes(state); i++) {
			const s = await w.cj(["status", id]);
			state = s.j?.run?.state ?? "";
			if (!["completed", "failed", "cancelled"].includes(state)) await sleep(1000);
		}
		if (!["completed", "failed", "cancelled"].includes(state)) await w.cj(["cancel", id]);
	}
	await w?.stop();
}, 180_000);

const auth = () => ({ authorization: `Bearer ${token}` });
const post = (body: unknown, key: string) => app.request("/v1/runs", { method: "POST", headers: { ...auth(), "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });

/** Read SSE text until `until` matches or `ms` passes. */
async function readUntil(res: Response, until: (t: string) => boolean, ms = 30_000) {
	const r = res.body!.getReader(); const dec = new TextDecoder(); let t = "";
	const end = Date.now() + ms;
	let pending: Promise<any> | null = null;
	while (!until(t) && Date.now() < end) {
		pending ??= r.read();
		const x = await Promise.race([pending, sleep(100).then(() => null)]);
		if (!x) continue;
		pending = null;
		if (x.value) t += dec.decode(x.value);
		if (x.done) break;
	}
	r.cancel().catch(() => {});
	return t;
}
const framesOf = (t: string) => t.split("\n\n").filter((f) => f.includes("data: ")).map((f) => ({ event: /event: (.*)/.exec(f)?.[1], data: JSON.parse(/data: (.*)/.exec(f)![1]!) }));

test("POST /v1/runs starts a detached run that the daemon stream announces like a CLI run", async () => {
	const stream = await app.request("/v1/streams/daemon/events", { headers: auth() });
	expect(stream.status).toBe(200);
	const r = await post({ goal: "  write the release notes  " }, `cr-${Date.now()}`);
	const run = (await r.json()) as any;
	if (r.status !== 201) console.log(run);
	expect(r.status).toBe(201);
	started.push(run.id);
	// No repo: the daemon's own repository settings.
	expect(run.id).toMatch(/^run-/);
	expect(run).toMatchObject({ state: "starting", goal: "write the release notes", repo: w.env.CAPCOMD_REPO, projectId: projectIdOf(w.env.CAPCOMD_REPO!) });

	const t = await readUntil(stream, (x) => x.includes(`"runId":"${run.id}"`));
	const created = framesOf(t).find((f) => f.data.runId === run.id);
	expect(created).toMatchObject({ event: "run.created", data: { type: "run.created", runId: run.id, projectId: run.projectId, data: { goal: "write the release notes" } } });

	const got = (await (await app.request(`/v1/runs/${run.id}`, { headers: auth() })).json()) as any;
	expect(got).toMatchObject({ id: run.id, projectId: run.projectId, repo: run.repo, goal: "write the release notes" });
	const projects = (await (await app.request("/v1/projects", { headers: auth() })).json()) as any[];
	expect(projects.find((p) => p.id === run.projectId)?.runIds).toContain(run.id);
}, 120_000);

test("repo: the run starts in that project checkout, with its settings instead of the daemon's", async () => {
	const dir = mkdtempSync(join(tmpdir(), "capcomd-createrun-prj-"));
	mkdirSync(join(dir, ".capcomd"));
	// The project's settings: the same bare repository, marked so the run's recorded settings show whose they are.
	writeFileSync(join(dir, ".capcomd", "config.json"), JSON.stringify({ env: { ...w.repo.env, CAPCOMD_MERGE_TARGET: "trunk", CAPCOMD_GITHUB_REPO: "acme/from-project" } }));
	const key = `cr-prj-${Date.now()}`;
	const r = await post({ goal: "tidy the docs", repo: dir }, key);
	const run = (await r.json()) as any;
	if (r.status !== 201) console.log(run);
	expect(r.status).toBe(201);
	started.push(run.id);
	expect(run).toMatchObject({ repo: w.repo.env.CAPCOMD_REPO, projectId: projectIdOf(w.repo.env.CAPCOMD_REPO!) });
	// a retry with the same key gets the same run, not a second one
	const again = await post({ goal: "tidy the docs", repo: dir }, key);
	expect(again.headers.get("idempotent-replayed")).toBe("true");
	expect(((await again.json()) as any).id).toBe(run.id);

	const { recentRuns } = await import("../../src/primitives/ops");
	let rec: any;
	for (let i = 0; i < 100 && !rec; i++) { rec = recentRuns(50).find((x) => x.runId === run.id); if (!rec) await sleep(200); }
	expect(rec).toMatchObject({ repo: w.repo.env.CAPCOMD_REPO, cwd: realpathSync(dir) });
	expect(recentRuns(50).filter((x) => x.runId === run.id).length).toBe(1);
	const recorded = (await w.cj(["kv", "get", run.id, "_repo"])).j.value;
	expect(recorded).toMatchObject({ CAPCOMD_REPO: w.repo.env.CAPCOMD_REPO, CAPCOMD_GITHUB_REPO: "acme/from-project" });
}, 120_000);

test("a run capcomd run refuses is a 422 with its reason", async () => {
	const r = await post({ goal: "anything", profile: "no-such-profile" }, `cr-bad-${Date.now()}`);
	const body = (await r.json()) as any;
	expect(r.status).toBe(422);
	expect(body.code).toBe("invalid");
	expect(body.message).toContain("no-such-profile");
}, 60_000);
