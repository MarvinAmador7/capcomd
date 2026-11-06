// Capability profiles.edit (ADR-024 §3, §7 step 6): GET /v1/profiles/{name}, one profile as rows a client edits, and
// PUT /v1/profiles/{name}, a change in the profile's own file with the configure scope, an Idempotency-Key and the rev it
// was read at, audited as profile.changed on the daemon stream. Engine-free: the memory source over scratch files.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { CAPABILITY_NAMES, EventData, ProfileDetail, ProfileWritten } from "../../src/api/contract";
import { HarnessEvent } from "../../src/api/envelope";
import { profileFor, updateProfileFor } from "../../src/api/profiles";
import { harnessApp } from "../../src/api/server";
import { memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";
import spec from "../../openapi/capcomd.json";

const dir = mkdtempSync(join(tmpdir(), "harness-profiles-edit-"));
const cpath = join(dir, "clients.json");
const configurer = addClient("menubar", ["read", "steer", "approve", "configure"], cpath);
const steerer = addClient("old-menubar", ["read", "steer", "approve"], cpath);
const other = addClient("hermes", ["read", "configure"], cpath);

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
	const src = { ...memorySource(), profile: (n: string, repo?: string) => profileFor(n, repo, env), updateProfile: (n: string, repo: string | undefined, b: { values: Record<string, string | null>; rev: string }) => updateProfileFor(n, repo, b, env) };
	const app = harnessApp({ source: src, clients: () => loadClients(cpath), state, pollMs: 20 });
	const q = `?repo=${encodeURIComponent(join(root, "repo"))}`;
	const req = async (method: string, p: string, o: { body?: unknown; token?: string; key?: string | null } = {}) => {
		const headers: Record<string, string> = { authorization: `Bearer ${o.token ?? configurer.token}`, "content-type": "application/json" };
		if (o.key !== null && method !== "GET") headers["idempotency-key"] = o.key ?? `key-${Math.random().toString(36).slice(2)}`;
		const r = await app.request(p, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
		return { status: r.status, body: (await r.json()) as any };
	};
	const get = (name: string, token?: string) => req("GET", `/v1/profiles/${name}${q}`, { token });
	const put = (name: string, body: unknown, o: { token?: string; key?: string | null } = {}) => req("PUT", `/v1/profiles/${name}${q}`, { body, ...o });
	return { at, state, get, put, req, q, read: (rel: string) => readFileSync(at(rel), "utf8") };
}
const LEAD = "name: lead\nextends: worker\n# the lead's own turns\nlimits:\n  maxTurns: 40\nchildren: { allowSpawn: true, allowedChildProfiles: [worker] }\n";
const worker = { provider: "claude", auth: "subscription", model: "sonnet", maxTurns: 20, appendSystemPrompt: "Keep it short." };

describe("GET /v1/profiles/{name} (capability profiles.edit)", () => {
	test("advertised and published: the read scope for GET, the configure scope and an Idempotency-Key for PUT", () => {
		expect(CAPABILITY_NAMES).toContain("profiles.edit");
		const p = (spec as any).paths["/v1/profiles/{name}"];
		expect(Object.keys(p).sort()).toEqual(["get", "put"]);
		expect(Object.keys(p.put.responses)).toEqual(expect.arrayContaining(["200", "403", "404", "409", "422"]));
		expect(p.put.parameters.map((x: any) => [x.name, x.in, !!x.required])).toEqual(expect.arrayContaining([["name", "path", true], ["repo", "query", false], ["idempotency-key", "header", true]]));
		expect(Object.keys(EventData)).toContain("profile.changed");
		expect((spec as any).components.schemas.ProfileChangedData["x-event-type"]).toBe("profile.changed");
	});

	test("the profile as GET /v1/profiles lists it, its rows with the file that sets each, its rev and the file a PUT writes", async () => {
		const w = world({ "P/lead.yaml": LEAD }, { worker });
		const r = await w.get("lead");
		expect(r.status).toBe(200);
		expect(ProfileDetail.parse(r.body)).toEqual(r.body);
		expect(r.body.profile).toMatchObject({ name: "lead", version: 1, source: "project", format: "v2" });
		expect(r.body).toMatchObject({ writesTo: w.at("P/lead.yaml"), rev: expect.stringMatching(/^[0-9a-f]{16}$/), warnings: [] });
		const row = (id: string) => r.body.fields.find((f: any) => f.id === id);
		expect(row("limits.maxTurns")).toMatchObject({ value: "40", display: "40 turns", source: "profile", from: 1, editable: true });
		expect(row("harness.model")).toMatchObject({ value: "sonnet", source: "inherited", from: 0, editable: true });
		expect(row("prompt.append")).toMatchObject({ value: null, display: "Set (14 characters)", source: "inherited", editable: false });
		// Never a prompt's text.
		expect(JSON.stringify(r.body)).not.toContain("Keep it short");
		expect(await w.get("nobody")).toEqual({ status: 404, body: { code: "not_found", message: 'profile "nobody" not found' } });
	});

	test("profiles that can't be read: 422 saying why; a repo that isn't a project: 422", async () => {
		const w = world({ "P/lead.yaml": "name: lead\nextends: nobody\n" });
		const r = await w.get("lead");
		expect(r.status).toBe(422);
		expect(r.body.message).toContain('extends "nobody", which isn\'t a profile here');
		const plain = mkdtempSync(join(dir, "plain-"));
		expect((await w.req("GET", `/v1/profiles/lead?repo=${encodeURIComponent(plain)}`)).status).toBe(422);
	});
});

describe("PUT /v1/profiles/{name}", () => {
	test("changes the profile's own file, bumps its version, answers like GET with the changes; one profile.changed event", async () => {
		const w = world({ "P/lead.yaml": LEAD }, { worker });
		const before = (await w.get("lead")).body;
		const r = await w.put("lead", { values: { "limits.maxTurns": "60", "harness.effort": "high", tags: '["lead","review"]', description: "Leads a part." }, rev: before.rev });
		expect(r.status).toBe(200);
		expect(ProfileWritten.parse(r.body)).toEqual(r.body);
		expect(r.body).toMatchObject({ changed: true, profile: { version: 2, tags: ["lead", "review"], effort: "high" } });
		expect(r.body.changes).toEqual([
			{ path: "description", from: null, to: "Leads a part." },
			{ path: "tags", from: null, to: '["lead","review"]' },
			{ path: "harness.effort", from: null, to: "high" },
			{ path: "limits.maxTurns", from: "40", to: "60" },
		]);
		expect(r.body.rev).not.toBe(before.rev);
		const { changed: _, changes: _c, ...detail } = r.body;
		expect((await w.get("lead")).body).toEqual(detail);
		expect(w.read("P/lead.yaml")).toContain("# the lead's own turns\nlimits:\n  maxTurns: 60\n");
		const evs = w.state.daemonEvents();
		expect(evs).toHaveLength(1);
		expect(evs[0]).toMatchObject({
			type: "profile.changed", entity: "profile:lead", entitySeq: 1,
			// The text names each value; free text (a description) only as changed.
			text: "Profile lead changed: description changed, tags unset → [lead, review], harness.effort unset → high, limits.maxTurns 40 → 60.",
			data: { name: "lead", version: 2, previousVersion: 1, layer: "project", path: w.at("P/lead.yaml"), changes: r.body.changes, clientId: configurer.client.id },
		});
		expect(EventData["profile.changed"].parse(evs[0]!.data)).toBeTruthy();
		// The daemon stream's replay has it, in the one envelope.
		const replay = await w.req("GET", "/v1/events?scope=daemon");
		expect(replay.body.map((e: any) => [e.type, e.entity, e.text])).toEqual([["profile.changed", "profile:lead", evs[0]!.text]]);
		expect(HarnessEvent.parse(replay.body[0])).toBeTruthy();
		// Values set to what they are: 200, nothing written, no event.
		const same = await w.put("lead", { values: { "limits.maxTurns": "60" }, rev: r.body.rev });
		expect(same.status).toBe(200);
		expect(same.body).toMatchObject({ changed: false, changes: [], rev: r.body.rev, profile: { version: 2 } });
		expect(w.state.daemonEvents()).toHaveLength(1);
		// null removes the profile's own value: the inherited one shows again.
		const unset = await w.put("lead", { values: { "limits.maxTurns": null }, rev: r.body.rev });
		expect(unset.body.fields.find((f: any) => f.id === "limits.maxTurns")).toMatchObject({ value: "20", source: "inherited" });
		expect(unset.body.profile.version).toBe(3);
	});

	test("an agents.json entry: its v1 fields change in place, its version stays 1", async () => {
		const w = world({}, { worker });
		const rev = (await w.get("worker")).body.rev;
		const r = await w.put("worker", { values: { "limits.maxBudgetUsd": "2.5" }, rev });
		expect(r.body).toMatchObject({ changed: true, profile: { version: 1, format: "v1" }, changes: [{ path: "limits.maxBudgetUsd", from: null, to: "2.5" }] });
		expect(JSON.parse(readFileSync(join(dirname(w.at("P/x")), "..", "agents.json"), "utf8")).agents.worker.maxBudgetUsd).toBe(2.5);
		expect(w.state.daemonEvents()[0]).toMatchObject({ text: "Profile worker changed: limits.maxBudgetUsd unset → 2.5.", data: { version: 1, previousVersion: 1 } });
		const tags = await w.put("worker", { values: { tags: '["x"]' }, rev: r.body.rev });
		expect(tags).toMatchObject({ status: 422, body: { code: "invalid", field: "tags" } });
	});

	test("Idempotency-Key: required; the same key and request replays the first 200 and writes once; another request is 409", async () => {
		const w = world({ "P/lead.yaml": LEAD }, { worker });
		const rev = (await w.get("lead")).body.rev;
		const body = { values: { "limits.maxTurns": "50" }, rev };
		expect(await w.put("lead", body, { key: null })).toEqual({ status: 422, body: { code: "invalid", message: "Idempotency-Key header (8-200 chars) is required" } });
		const first = await w.put("lead", body, { key: "put-lead-1" });
		expect(first.status).toBe(200);
		const text = w.read("P/lead.yaml");
		// A retry (its response lost): the same answer, though `rev` is stale by now; nothing written again, one event.
		expect(await w.put("lead", body, { key: "put-lead-1" })).toEqual(first);
		expect(w.read("P/lead.yaml")).toBe(text);
		expect(w.state.daemonEvents()).toHaveLength(1);
		expect(await w.put("lead", { ...body, values: { "limits.maxTurns": "55" } }, { key: "put-lead-1" })).toEqual({ status: 409, body: { code: "idempotency_conflict", message: "Idempotency-Key reused with a different request" } });
		// Keys are the client's: another client's same key is its own request (here a stale rev).
		expect((await w.put("lead", body, { key: "put-lead-1", token: other.token })).body.code).toBe("conflict");
		// Concurrent duplicates share one write.
		const rev2 = (await w.get("lead")).body.rev;
		const both = await Promise.all([1, 2].map(() => w.put("lead", { values: { "limits.maxTurns": "45" }, rev: rev2 }, { key: "put-lead-2" })));
		expect(both[0]).toEqual(both[1]);
		expect(both[0]!.status).toBe(200);
		expect(w.state.daemonEvents()).toHaveLength(2);
	});

	test("a token without the configure scope: 403 forbidden, nothing written; GET needs only read", async () => {
		const w = world({ "P/lead.yaml": LEAD }, { worker });
		const r = await w.get("lead", steerer.token);
		expect(r.status).toBe(200);
		const text = w.read("P/lead.yaml");
		expect(await w.put("lead", { values: { "limits.maxTurns": "1" }, rev: r.body.rev }, { token: steerer.token })).toEqual({ status: 403, body: { code: "forbidden", message: "token lacks the configure scope" } });
		expect(await w.req("DELETE", `/v1/profiles/lead${w.q}`, { token: steerer.token })).toMatchObject({ status: 403 });
		expect(w.read("P/lead.yaml")).toBe(text);
		expect(w.state.daemonEvents()).toEqual([]);
		expect((await w.req("PUT", `/v1/profiles/lead${w.q}`, { token: "nope", body: {} })).status).toBe(401);
	});

	test("refused with nothing written: a stale rev (409 with the current one), a field it lacks or can't change, a bad value, profiles left unreadable, an unknown name", async () => {
		const w = world({ "P/lead.yaml": LEAD, "P/lead/override.yaml": "harness: { effort: low }\n" }, { worker });
		const rev = (await w.get("lead")).body.rev;
		expect((await w.put("lead", { values: { "limits.maxTurns": "30" }, rev })).status).toBe(200);
		const text = w.read("P/lead.yaml");
		const stale = await w.put("lead", { values: { "limits.maxTurns": "31" }, rev });
		expect(stale.status).toBe(409);
		expect(stale.body).toMatchObject({ code: "conflict", message: 'profile "lead" changed since it was read: read it again, then retry', rev: (await w.get("lead")).body.rev });
		const now = stale.body.rev;
		expect(await w.put("lead", { values: { bogus: "1" }, rev: now })).toEqual({ status: 422, body: { code: "invalid", field: "bogus", message: "bogus: not a field of this profile (GET /v1/profiles/{name} lists them)" } });
		expect((await w.put("lead", { values: { "harness.effort": "high" }, rev: now })).body).toMatchObject({ code: "invalid", field: "harness.effort", message: expect.stringContaining("sets it after the profile's own file") });
		expect((await w.put("lead", { values: { "prompt.append": "x" }, rev: now })).body).toMatchObject({ code: "invalid", field: "prompt.append" });
		expect((await w.put("lead", { values: { "limits.maxTurns": "lots" }, rev: now })).body).toEqual({ code: "invalid", field: "limits.maxTurns", message: "limits.maxTurns: must be a number" });
		const unreadable = await w.put("lead", { values: { "limits.maxTurns": "0" }, rev: now });
		expect(unreadable).toMatchObject({ status: 422, body: { code: "invalid", message: expect.stringMatching(/^the change would leave the profiles unreadable, so nothing was changed: profiles\.lead: limits\.maxTurns/) } });
		expect((await w.put("lead", { values: {} }, {})).body).toMatchObject({ code: "invalid", field: "rev" });
		expect((await w.put("nobody", { values: { "limits.maxTurns": "1" }, rev: now })).status).toBe(404);
		expect((await w.req("PUT", `/v1/profiles/lead?repo=relative`, { body: { values: {}, rev: now } })).body).toMatchObject({ code: "invalid", field: "repo" });
		expect(w.read("P/lead.yaml")).toBe(text);
		expect(w.state.daemonEvents()).toHaveLength(1);
	});

	test("the memory source has no profiles: 404", async () => {
		const app = harnessApp({ source: memorySource(), clients: () => loadClients(cpath), state: harnessState(null) });
		const r = await app.request("/v1/profiles/worker", { headers: { authorization: `Bearer ${configurer.token}` } });
		expect(r.status).toBe(404);
	});
});
