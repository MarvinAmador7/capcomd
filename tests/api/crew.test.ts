// The app's Crew screen (a profile's page): its recent work (capability profiles.work), its persona's text read and
// written (profiles.persona), one bot face per profile (profiles.avatar) and a run started with a chosen planner
// (runs.planner). Engine-free: the memory source over scratch files; tests/scenarios/profile-work.test.ts reads the
// scopes' profileWork on a real engine.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { addClient, loadClients } from "../../src/api/clients";
import { Agent, CAPABILITY_NAMES, CreateRunBody, EventData, ProfilePersona, ProfilePersonaWritten, Profiles, ProfileWork } from "../../src/api/contract";
import { startDetachedRun } from "../../src/api/create-run";
import { LegacyEventData } from "../../src/api/legacy-events";
import { personaFor, profileFor, profilesFor, updatePersonaFor, updateProfileFor } from "../../src/api/profiles";
import { projectRuns, workOutcome, workResult } from "../../src/api/profile-work";
import { harnessApp } from "../../src/api/server";
import { CreateRunError, memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";
import { readProfiles, resolveAgent, trustProfile } from "../../src/profiles";
import spec from "../../openapi/capcomd.json";

const dir = mkdtempSync(join(tmpdir(), "harness-crew-"));
const cpath = join(dir, "clients.json");
const configurer = addClient("menubar", ["read", "steer", "approve", "configure"], cpath);
const steerer = addClient("old-menubar", ["read", "steer", "approve"], cpath);
const sha = (t: string) => `sha256:${createHash("sha256").update(t).digest("hex")}`;

/** A project checkout (repo/.capcomd/: config.json, agents.json, profiles/) and a CAPCOMD_HOME (home/). */
function world(files: Record<string, string>, agents?: Record<string, unknown>) {
	const root = mkdtempSync(join(dir, "w-"));
	const cap = join(root, "repo", ".capcomd");
	mkdirSync(cap, { recursive: true });
	writeFileSync(join(cap, "config.json"), JSON.stringify({ env: { CAPCOMD_REPO: "/srv/git/app.git" } }));
	if (agents) writeFileSync(join(cap, "agents.json"), JSON.stringify({ schema: "capcomd.agents/v1", agents }));
	const at = (rel: string) => join(root, rel.replace(/^P\//, "repo/.capcomd/profiles/").replace(/^U\//, "home/profiles/"));
	for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(at(rel)), { recursive: true }); writeFileSync(at(rel), body); }
	mkdirSync(join(root, "home"), { recursive: true });
	const env = { CAPCOMD_HOME: join(root, "home"), CAPCOMD_AUTH_LEDGER: join(root, "auths.json"), CAPCOMD_NO_CONFIG: "1", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", PATH: process.env.PATH ?? "" } as Record<string, string>;
	const state = harnessState(null);
	const src = {
		...memorySource(),
		profiles: (repo?: string) => profilesFor(repo, env),
		profile: (n: string, repo?: string) => profileFor(n, repo, env),
		updateProfile: (n: string, repo: string | undefined, b: { values: Record<string, string | null>; rev: string }) => updateProfileFor(n, repo, b, env),
		persona: (n: string, repo?: string) => personaFor(n, repo, env),
		updatePersona: (n: string, repo: string | undefined, b: { text: string; rev: string }) => updatePersonaFor(n, repo, b, env),
	};
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state, pollMs: 20 });
	const repo = join(root, "repo");
	const q = `?repo=${encodeURIComponent(repo)}`;
	const req = async (method: string, p: string, o: { body?: unknown; token?: string; key?: string | null } = {}) => {
		const headers: Record<string, string> = { authorization: `Bearer ${o.token ?? configurer.token}`, "content-type": "application/json" };
		if (o.key !== null && method !== "GET") headers["idempotency-key"] = o.key ?? `key-${Math.random().toString(36).slice(2)}`;
		const r = await app.request(p, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
		return { status: r.status, body: (await r.json()) as any };
	};
	const persona = (name: string) => req("GET", `/v1/profiles/${name}/persona${q}`);
	const putPersona = (name: string, body: unknown, o: { token?: string; key?: string | null } = {}) => req("PUT", `/v1/profiles/${name}/persona${q}`, { body, ...o });
	const sourceEnv = { ...env, CAPCOMD_AGENTS_FILE: join(cap, "agents.json") };
	return { at, env, sourceEnv, state, repo, req, q, persona, putPersona, read: (rel: string) => readFileSync(at(rel), "utf8") };
}
const SOUL = "You are the reviewer. You read carefully and say what you found.\n";

describe("published: capabilities and routes", () => {
	test("the four capabilities, the work and persona routes, avatarSeed on profile rows, Agent and agent.spawned, planner on POST /v1/runs", () => {
		expect(CAPABILITY_NAMES).toEqual(expect.arrayContaining(["profiles.work", "profiles.persona", "profiles.avatar", "runs.planner"]));
		const paths = (spec as any).paths;
		expect(Object.keys(paths["/v1/profiles/{name}/work"])).toEqual(["get"]);
		expect(paths["/v1/profiles/{name}/work"].get.parameters.map((x: any) => [x.name, x.in, !!x.required])).toEqual([["name", "path", true], ["repo", "query", false], ["limit", "query", false]]);
		expect(Object.keys(paths["/v1/profiles/{name}/persona"]).sort()).toEqual(["get", "put"]);
		const put = paths["/v1/profiles/{name}/persona"].put;
		expect(put.parameters.map((x: any) => [x.name, x.in, !!x.required])).toEqual(expect.arrayContaining([["name", "path", true], ["repo", "query", false], ["idempotency-key", "header", true]]));
		const item = paths["/v1/profiles/{name}/work"].get.responses["200"].content["application/json"].schema.properties.items.items;
		expect(item.required).toEqual(["agentId", "runId", "title", "project", "outcome", "endedAt", "updatedAt"]);
		expect(item.properties.outcome.enum).toEqual(["running", "idle", "merged", "passed", "found_issues", "failed", "cancelled"]);
		expect(item.properties.title["x-untrusted"]).toBe(true);
		const body = paths["/v1/profiles/{name}/persona"].get.responses["200"].content["application/json"].schema;
		expect(body.required).toEqual(["file", "text", "hash", "layer", "editable", "why", "trusted"]);
		expect(body.properties.text).toMatchObject({ "x-untrusted": true, type: ["string", "null"] });
		const row = paths["/v1/profiles"].get.responses["200"].content["application/json"].schema.properties.profiles.items;
		expect(row.properties.avatarSeed.type).toEqual(["string", "null"]);
		expect(row.required).not.toContain("avatarSeed");
		expect(Agent.shape).toHaveProperty("avatarSeed");
		expect(LegacyEventData["agent.spawned"].shape).toHaveProperty("avatarSeed");
		expect(CreateRunBody.shape).toHaveProperty("planner");
		expect(EventData["profile.changed"].shape).toHaveProperty("persona");
	});
});

describe("GET /v1/profiles/{name}/work (capability profiles.work)", () => {
	test("the outcome, from the agent's state and its verify, review and merge results", () => {
		const o = (status: string, result: unknown = null) => workOutcome({ status, ...workResult(result) });
		expect(o("running")).toBe("running");
		expect(o("pending")).toBe("running");
		expect(o("paused")).toBe("running");
		expect(o("cancelled", { merge: { state: "merged" } })).toBe("cancelled");
		expect(o("failed")).toBe("failed");
		expect(o("done")).toBe("idle");
		expect(o("done", { summary: "done it" })).toBe("idle");
		expect(o("done", { merge: { state: "merged" }, verification: { pass: true } })).toBe("merged");
		expect(o("done", { verification: { pass: true } })).toBe("passed");
		expect(o("done", { verification: { pass: false } })).toBe("found_issues");
		expect(o("done", { verification: { pass: true }, merge: { state: "failed" } })).toBe("failed");
		expect(o("done", { verification: { pass: true }, merge: { state: "denied" } })).toBe("passed");
		// A reviewer's verdict.
		expect(o("done", { verdict: { passed: false, reasons: ["no tests"] } })).toBe("found_issues");
		expect(o("done", { verdict: { passed: true, reasons: [] } })).toBe("passed");
		expect(o("handed-off")).toBe("idle");
		// Unreadable results say nothing.
		expect(workResult("x")).toEqual({ verdict: null, verification: null, merge: null });
	});

	test("a project's runs: started in its checkout (or below), or on its repository", () => {
		const runs = [{ runId: "a", repo: "/srv/git/app.git", cwd: "/elsewhere" }, { runId: "b", repo: "/other.git", cwd: "/w/app" }, { runId: "c", repo: "/other.git", cwd: "/w/app/sub" }, { runId: "d", repo: "/other.git", cwd: "/w/apple" }, { runId: "e", repo: null, cwd: "/x" }];
		expect(projectRuns(runs, "/w/app", "/srv/git/app.git").map((r) => r.runId)).toEqual(["a", "b", "c"]);
		expect(projectRuns(runs, "/w/app", null).map((r) => r.runId)).toEqual(["b", "c"]);
	});

	test("its newest agents across runs, newest first, with title, project and outcome; limit and repo", async () => {
		const ag = (id: string, runId: string, profile: string | null, status: string, updatedAt: string, result: unknown = null, title: string | null = null): any =>
			({ id, runId, parent: null, depth: 0, profile, status, text: "", activity: null, task: `Task of ${id}`, taskAttachment: null, result, workspace: null, provider: "claude", model: null, effort: null, updatedAt, title });
		const run = (id: string, repo: string | null) => ({ id, projectId: null, label: null, state: "idle", goal: null, repo, createdAt: "2026-11-20T00:00:00.000Z" });
		const src = memorySource({
			runs: [run("run-a", "/srv/git/app.git"), run("run-b", "/srv/git/other.git")],
			agents: {
				"run-a": [
					ag("agt-1", "run-a", "reviewer", "done", "2026-11-20T10:00:00.000Z", { verdict: { passed: false, reasons: ["x"] } }, "review login"),
					ag("agt-2", "run-a", "worker", "done", "2026-11-20T11:00:00.000Z", { merge: { state: "merged" } }),
					ag("agt-3", "run-a", "reviewer", "running", "2026-11-20T12:00:00.000Z"),
				],
				"run-b": [ag("agt-4", "run-b", "reviewer", "done", "2026-11-20T09:00:00.000Z", { verdict: { passed: true } }, "review sum")],
			},
		});
		const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null), pollMs: 20 });
		const get = async (p: string, token = steerer.token) => { const r = await app.request(p, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, body: (await r.json()) as any }; };
		const r = await get("/v1/profiles/reviewer/work");
		expect(r.status).toBe(200);
		expect(ProfileWork.parse(r.body)).toEqual(r.body);
		expect(r.body.items).toEqual([
			{ agentId: "agt-3", runId: "run-a", title: null, project: "app.git", outcome: "running", endedAt: null, updatedAt: Date.parse("2026-11-20T12:00:00.000Z") },
			{ agentId: "agt-1", runId: "run-a", title: "review login", project: "app.git", outcome: "found_issues", endedAt: Date.parse("2026-11-20T10:00:00.000Z"), updatedAt: Date.parse("2026-11-20T10:00:00.000Z") },
			{ agentId: "agt-4", runId: "run-b", title: "review sum", project: "other.git", outcome: "passed", endedAt: Date.parse("2026-11-20T09:00:00.000Z"), updatedAt: Date.parse("2026-11-20T09:00:00.000Z") },
		]);
		expect((await get("/v1/profiles/reviewer/work?limit=1")).body.items.map((i: any) => i.agentId)).toEqual(["agt-3"]);
		expect((await get("/v1/profiles/worker/work")).body.items.map((i: any) => [i.agentId, i.outcome])).toEqual([["agt-2", "merged"]]);
		expect((await get("/v1/profiles/nobody/work")).body).toEqual({ items: [] });
		// Never a task's text.
		expect(JSON.stringify(r.body)).not.toContain("Task of");
		for (const bad of ["0", "51", "x"]) expect((await get(`/v1/profiles/reviewer/work?limit=${bad}`)).status).toBe(422);
		expect((await get("/v1/profiles/reviewer/work?repo=relative")).status).toBe(422);
		expect((await app.request("/v1/profiles/reviewer/work")).status).toBe(401);
	});
});

describe("GET and PUT /v1/profiles/{name}/persona (capability profiles.persona)", () => {
	test("a profile's persona: its text (this route only), hash, layer, whether it can be edited here, and its trust", async () => {
		const w = world({ "P/reviewer/profile.yaml": "name: reviewer\nidentity: { persona: SOUL.md }\nharness: { provider: claude, auth: subscription }\n", "P/reviewer/SOUL.md": SOUL, "P/worker.yaml": "name: worker\nharness: { provider: claude, auth: subscription }\n" });
		const r = await w.persona("reviewer");
		expect(r.status).toBe(200);
		expect(ProfilePersona.parse(r.body)).toEqual(r.body);
		expect(r.body).toEqual({ file: "SOUL.md", text: SOUL, hash: sha(SOUL), layer: "project", editable: true, why: null, trusted: false });
		// Trusted, it says so.
		const set = readProfiles(w.sourceEnv.CAPCOMD_AGENTS_FILE, w.sourceEnv);
		trustProfile(set.profiles.reviewer!.skills, set.profiles.reviewer!.persona, { env: w.sourceEnv });
		expect((await w.persona("reviewer")).body.trusted).toBe(true);
		// None: null text, the empty string's hash, the layer a PUT would write it in.
		expect((await w.persona("worker")).body).toEqual({ file: null, text: null, hash: sha(""), layer: "project", editable: true, why: null, trusted: true });
		expect((await w.persona("nobody")).status).toBe(404);
		// No other route carries the text.
		for (const p of [`/v1/profiles${w.q}`, `/v1/profiles/reviewer${w.q}`]) expect(JSON.stringify((await w.req("GET", p)).body)).not.toContain("read carefully");
	});

	test("PUT rewrites its own persona file, bumps its version, needs trust again, audits without the text", async () => {
		const w = world({ "P/reviewer/profile.yaml": "name: reviewer\nversion: 3\n# who it is\nidentity: { persona: SOUL.md }\nharness: { provider: claude, auth: subscription }\n", "P/reviewer/SOUL.md": SOUL });
		const set = readProfiles(w.sourceEnv.CAPCOMD_AGENTS_FILE, w.sourceEnv);
		trustProfile(set.profiles.reviewer!.skills, set.profiles.reviewer!.persona, { env: w.sourceEnv });
		const text = "You are the reviewer. Be brief.\n";
		const r = await w.putPersona("reviewer", { text, rev: sha(SOUL) }, { key: "persona-key-1" });
		expect(r.status).toBe(200);
		expect(ProfilePersonaWritten.parse(r.body)).toEqual(r.body);
		expect(r.body).toEqual({ file: "SOUL.md", text, hash: sha(text), layer: "project", editable: true, why: null, trusted: false, changed: true });
		expect(w.read("P/reviewer/SOUL.md")).toBe(text);
		expect(w.read("P/reviewer/profile.yaml")).toContain("version: 4\n# who it is\n");
		const evs = w.state.daemonEvents();
		expect(evs).toHaveLength(1);
		expect(evs[0]).toMatchObject({
			type: "profile.changed", entity: "profile:reviewer",
			text: "Profile reviewer's persona changed (SOUL.md); its agents get it once it is trusted (capcomd profiles trust reviewer).",
			data: { name: "reviewer", version: 4, previousVersion: 3, layer: "project", path: w.at("P/reviewer/SOUL.md"), changes: [{ path: "identity.persona", from: null, to: null }], persona: { file: "SOUL.md", hash: sha(text), created: false }, clientId: configurer.client.id },
		});
		expect(EventData["profile.changed"].parse(evs[0]!.data)).toBeTruthy();
		expect(JSON.stringify(evs)).not.toContain("Be brief");
		// The same key and request replays; the same text again writes nothing.
		expect(await w.putPersona("reviewer", { text, rev: sha(SOUL) }, { key: "persona-key-1" })).toEqual(r);
		expect((await w.putPersona("reviewer", { text: "other", rev: sha(SOUL) }, { key: "persona-key-1" })).body.code).toBe("idempotency_conflict");
		const same = await w.putPersona("reviewer", { text, rev: sha(text) });
		expect(same.body.changed).toBe(false);
		expect(w.state.daemonEvents()).toHaveLength(1);
		// A stale rev: 409 with the current hash; a blank or oversized text: 422 field text.
		expect(await w.putPersona("reviewer", { text: "x", rev: sha(SOUL) })).toEqual({ status: 409, body: { code: "conflict", message: expect.stringContaining("changed since it was read"), rev: sha(text) } });
		expect((await w.putPersona("reviewer", { text: "  \n", rev: sha(text) })).body).toMatchObject({ code: "invalid", field: "text" });
		expect((await w.putPersona("reviewer", { text: "x".repeat(32 * 1024 + 1), rev: sha(text) })).body).toMatchObject({ code: "invalid", field: "text" });
		// The configure scope and an Idempotency-Key.
		expect((await w.putPersona("reviewer", { text: "y", rev: sha(text) }, { token: steerer.token })).status).toBe(403);
		expect((await w.putPersona("reviewer", { text: "y", rev: sha(text) }, { key: null })).status).toBe(422);
		expect((await w.putPersona("nobody", { text: "y", rev: sha("") })).status).toBe(404);
		expect(w.read("P/reviewer/SOUL.md")).toBe(text);
	});

	test("PUT gives a profile without one a SOUL.md: a single file becomes a package; the spawn then pins it", async () => {
		const w = world({ "P/worker.yaml": "name: worker\n# keep me\nharness: { provider: claude, auth: subscription }\n" });
		const text = "You are a careful worker.\n";
		const r = await w.putPersona("worker", { text, rev: sha("") });
		expect(r.status).toBe(200);
		expect(r.body).toMatchObject({ file: "SOUL.md", text, layer: "project", editable: true, trusted: false, changed: true });
		expect(existsSync(w.at("P/worker.yaml"))).toBe(false);
		expect(w.read("P/worker/SOUL.md")).toBe(text);
		const manifest = w.read("P/worker/profile.yaml");
		expect(manifest).toContain("# keep me");
		expect(manifest).toContain("persona: SOUL.md");
		expect(manifest).toContain("version: 2");
		expect(w.state.daemonEvents()[0]).toMatchObject({ text: "Profile worker has a persona of its own now (SOUL.md); its agents get it once it is trusted (capcomd profiles trust worker).", data: { path: w.at("P/worker/SOUL.md"), persona: { created: true } } });
		const resolved = resolveAgent("worker", w.sourceEnv);
		expect(resolved.persona).toMatchObject({ file: "SOUL.md", source: "project", text });
		expect((await w.req("GET", `/v1/profiles${w.q}`)).body.profiles.find((p: any) => p.name === "worker")).toMatchObject({ version: 2, path: w.at("P/worker/profile.yaml"), untrustedPersona: "SOUL.md" });
	});

	test("an inherited persona is its parent's; PUT gives the child one of its own, the parent's stays", async () => {
		const w = world({
			"U/base/profile.yaml": "name: base\nidentity: { persona: SOUL.md }\nharness: { provider: claude, auth: subscription }\n", "U/base/SOUL.md": SOUL,
			"P/critic/profile.yaml": "name: critic\nextends: base\n",
		});
		const r = await w.persona("critic");
		expect(r.body).toEqual({ file: "SOUL.md", text: SOUL, hash: sha(SOUL), layer: "user", editable: true, why: null, trusted: true });
		const text = "You are the critic.\n";
		expect((await w.putPersona("critic", { text, rev: sha(SOUL) })).body).toMatchObject({ text, layer: "project", changed: true });
		expect(w.read("P/critic/SOUL.md")).toBe(text);
		expect(w.read("U/base/SOUL.md")).toBe(SOUL);
		expect((await w.persona("base")).body.text).toBe(SOUL);
	});

	test("read-only here: an agents.json entry, an installed package, an override that sets it", async () => {
		const lock = JSON.stringify({ schema: "capcomd.lock/v1", kind: "profile", name: "pkg", version: null, source: "o/r", remote: "x", ref: null, commit: "0".repeat(40), hash: "h", files: {}, installedAt: "2026-11-01T00:00:00Z" });
		const w = world({
			"U/pkg/profile.yaml": "name: pkg\nidentity: { persona: SOUL.md }\nharness: { provider: claude, auth: subscription }\n", "U/pkg/SOUL.md": SOUL, "U/pkg/LOCK": lock,
			"U/over/profile.yaml": "name: over\nharness: { provider: claude, auth: subscription }\n",
			"P/over/override.yaml": "identity: { persona: SOUL.md }\n", "P/over/SOUL.md": SOUL,
		}, { legacy: { provider: "claude", auth: "subscription" } });
		const legacy = await w.persona("legacy");
		expect(legacy.body).toMatchObject({ file: null, text: null, editable: false, why: expect.stringContaining("agents.json, which can't name a persona") });
		const pkg = await w.persona("pkg");
		expect(pkg.body).toMatchObject({ file: "SOUL.md", text: SOUL, layer: "user", editable: false, why: expect.stringContaining("installed package") });
		const over = await w.persona("over");
		expect(over.body).toMatchObject({ file: "SOUL.md", layer: "project", editable: false, why: expect.stringContaining("override.yaml (an override of over) sets it after the profile's own file") });
		for (const n of ["legacy", "pkg", "over"]) {
			const r = await w.putPersona(n, { text: "new", rev: (await w.persona(n)).body.hash });
			expect(r.status).toBe(422);
			expect(r.body.code).toBe("invalid");
		}
		expect(w.read("U/pkg/SOUL.md")).toBe(SOUL);
		expect(w.state.daemonEvents()).toEqual([]);
	});
});

describe("one face per profile (capability profiles.avatar)", () => {
	test("GET /v1/profiles rows carry avatarSeed; PUT sets and removes it (identity.avatar.seed); not inherited; resolved for the spawn", async () => {
		const w = world({ "P/lead.yaml": "name: lead\nidentity: { avatar: { seed: captain } }\nharness: { provider: claude, auth: subscription }\n", "P/helper.yaml": "name: helper\nextends: lead\n" }, { old: { provider: "claude", auth: "subscription" } });
		const list = (await w.req("GET", `/v1/profiles${w.q}`)).body;
		expect(Profiles.parse(list)).toEqual(list);
		expect(list.profiles.map((p: any) => [p.name, p.avatarSeed])).toEqual([["old", null], ["helper", null], ["lead", "captain"]]);
		expect(resolveAgent("lead", w.sourceEnv).avatarSeed).toBe("captain");
		expect(resolveAgent("helper", w.sourceEnv).avatarSeed).toBeUndefined();
		const d = (await w.req("GET", `/v1/profiles/helper${w.q}`)).body;
		const row = d.fields.find((f: any) => f.id === "identity.avatar.seed");
		expect(row).toMatchObject({ type: "text", value: null, source: "unset", editable: true, untrusted: true });
		expect(d.fields.some((f: any) => f.id === "identity.avatar")).toBe(false);
		const r = await w.req("PUT", `/v1/profiles/helper${w.q}`, { body: { values: { "identity.avatar.seed": "bolt" }, rev: d.rev } });
		expect(r.status).toBe(200);
		expect(r.body.profile.avatarSeed).toBe("bolt");
		expect(r.body.changes).toEqual([{ path: "identity.avatar.seed", from: null, to: "bolt" }]);
		expect(w.read("P/helper.yaml")).toContain("avatar:");
		expect(w.state.daemonEvents()[0]!.text).toBe("Profile helper changed: identity.avatar.seed changed.");
		const gone = await w.req("PUT", `/v1/profiles/helper${w.q}`, { body: { values: { "identity.avatar.seed": null }, rev: r.body.rev } });
		expect(gone.body.profile.avatarSeed).toBeNull();
		expect(w.read("P/helper.yaml")).not.toContain("avatar");
		expect((await w.req("PUT", `/v1/profiles/lead${w.q}`, { body: { values: { "identity.avatar.seed": " " }, rev: (await w.req("GET", `/v1/profiles/lead${w.q}`)).body.rev } })).body).toMatchObject({ code: "invalid", field: "identity.avatar.seed" });
		// An agents.json entry can't hold it.
		const old = (await w.req("GET", `/v1/profiles/old${w.q}`)).body.fields.find((f: any) => f.id === "identity.avatar.seed");
		expect(old.editable).toBe(false);
	});
});

describe("POST /v1/runs planner (capability runs.planner)", () => {
	const options = async () => {
		const o = await memorySource().runOptions();
		const planner = (name: string, provider: string, def = false) => ({ name, title: null, provider, model: null, default: def, available: true, reason: null });
		return { ...o, planners: [planner("planner", "claude", true), planner("codex-lead", "codex")] };
	};
	const post = async (body: unknown, src: ReturnType<typeof memorySource>) => {
		const app = harnessApp({ source: src, clients: () => loadClients(cpath), state: harnessState(null), pollMs: 20 });
		const r = await app.request("/v1/runs", { method: "POST", headers: { authorization: `Bearer ${steerer.token}`, "content-type": "application/json", "idempotency-key": `key-${Math.random().toString(36).slice(2)}` }, body: JSON.stringify(body) });
		return { status: r.status, body: (await r.json()) as any };
	};

	test("a planner from run-options' planners starts the run; not with profile; one that can't plan is 422 field planner", async () => {
		const src = memorySource({ runOptions: await options() });
		expect((await post({ goal: "go", planner: "codex-lead" }, src)).status).toBe(201);
		expect(src.created.at(-1)).toMatchObject({ goal: "go", planner: "codex-lead" });
		expect(await post({ goal: "go", planner: "worker" }, src)).toEqual({ status: 422, body: { code: "invalid", message: expect.stringContaining("planner worker isn't a profile that can plan"), field: "planner" } });
		expect((await post({ goal: "go", planner: "planner", profile: "worker" }, src)).body).toMatchObject({ code: "invalid", field: "planner" });
		expect((await post({ goal: "go", planner: "Bad Name" }, src)).body).toMatchObject({ code: "invalid", field: "planner" });
		// effort and model are checked against the chosen planner's provider (codex here), not the default driver's.
		expect((await post({ goal: "go", planner: "codex-lead", effort: "minimal" }, src)).status).toBe(201);
		expect((await post({ goal: "go", planner: "codex-lead", effort: "max" }, src)).body.message).toContain("isn't a Codex level");
		expect(src.created).toHaveLength(2);
	});

	test("it reaches `capcomd run` as --planner; profile with planner never starts; the CLI's refusal names the field", async () => {
		const calls: string[][] = [];
		const fake = (reply: (a: string[]) => Record<string, unknown>) => ((_cmd: string, args: string[]) => {
			calls.push(args);
			const child: any = new EventEmitter();
			child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
			setTimeout(() => { child.stdout.write(JSON.stringify(reply(args)) + "\n"); child.stdout.end(); child.stderr.end(); child.emit("exit", 0); }, 5);
			return child;
		}) as any;
		const ok = fake((a) => ({ ok: true, runId: a[a.indexOf("--run-id") + 1], detached: true, log: null }));
		await startDetachedRun({ goal: "go", runId: "run-p1", planner: "codex-lead" }, { env: { CAPCOMD_REPO: "/r" }, cwd: dir, spawn: ok });
		expect(calls[0]).toContain("--planner=codex-lead");
		await expect(startDetachedRun({ goal: "go", runId: "run-p2", planner: "codex-lead", profile: "worker" }, { env: { CAPCOMD_REPO: "/r" }, cwd: dir, spawn: ok })).rejects.toMatchObject({ field: "planner" });
		expect(calls).toHaveLength(1);
		const no = fake(() => ({ ok: false, error: { code: "config", message: "profile codex-lead can't plan: it doesn't exist or may not spawn agents (children.allowSpawn)", hint: "Run `capcomd setup`." } }));
		const e = await startDetachedRun({ goal: "go", runId: "run-p3", planner: "codex-lead" }, { env: { CAPCOMD_REPO: "/r" }, cwd: dir, spawn: no }).catch((x) => x);
		expect(e).toBeInstanceOf(CreateRunError);
		expect(e.field).toBe("planner");
	});
});
