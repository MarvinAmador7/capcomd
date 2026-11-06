// Capability profiles: GET /v1/profiles (ADR-024 §5, §7 step 2), read-only: every agent profile a run of the daemon or
// of a project can use, where each was found and the files laid together to make it, and whether its login is there.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { Profiles } from "../../src/api/contract";
import { profilesFor, profilesOf } from "../../src/api/profiles";
import { harnessApp } from "../../src/api/server";
import { CreateRunError, memorySource } from "../../src/api/source";
import { harnessState } from "../../src/api/state";

const dir = mkdtempSync(join(tmpdir(), "harness-profiles-"));
const cpath = join(dir, "clients.json");
const reader = addClient("reader", ["read"], cpath).token;

/** A project checkout (repo/.capcomd/: config.json, agents.json, profiles/) and a CAPCOMD_HOME (home/), with these files;
 *  `P/` is the project's profiles, `U/` the user's. Logged in to Claude only. */
function world(files: Record<string, string>, agents?: Record<string, unknown>, def?: string) {
	const root = mkdtempSync(join(dir, "w-"));
	const cap = join(root, "repo", ".capcomd");
	mkdirSync(cap, { recursive: true });
	writeFileSync(join(cap, "config.json"), JSON.stringify({ env: { CAPCOMD_REPO: "/srv/git/app.git" } }));
	if (agents) writeFileSync(join(cap, "agents.json"), JSON.stringify({ schema: "capcomd.agents/v1", ...(def ? { default: def } : {}), agents }));
	const at = (rel: string) => join(root, rel.replace(/^P\//, "repo/.capcomd/profiles/").replace(/^U\//, "home/profiles/"));
	for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(at(rel)), { recursive: true }); writeFileSync(at(rel), body); }
	mkdirSync(join(root, "home"), { recursive: true });
	writeFileSync(join(root, "auths.json"), JSON.stringify({ "claude-code": { agent: "claude-code", store: "snapshot", snapshot: "capcomd-auth-claude-x", method: "setup-token", env: "x", createdAt: "2026-10-01T00:00:00Z" } }));
	const env = { CAPCOMD_HOME: join(root, "home"), CAPCOMD_AUTH_LEDGER: join(root, "auths.json"), CAPCOMD_NO_CONFIG: "1", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", PATH: process.env.PATH ?? "" } as Record<string, string>;
	return { root, at, repo: join(root, "repo"), agentsFile: join(cap, "agents.json"), env, project: { ...env, CAPCOMD_AGENTS_FILE: join(cap, "agents.json") } };
}
const worker = { provider: "claude", auth: "subscription", model: "sonnet", maxTurns: 20 };
const LEAD = ["name: lead", "extends: worker", "version: 2", "description: Leads a part.", "tags: [lead, review]",
	"limits: { maxTurns: 40 }", "tools: { mode: orchestrate }", "children: { allowSpawn: true, allowedChildProfiles: [worker], maxChildren: 3, maxDepth: 1 }"].join("\n");

describe("GET /v1/profiles (capability profiles)", () => {
	test("each profile: where it was found, the files laid together, what it does, whether its login is there", () => {
		const w = world({ "P/lead/profile.yaml": LEAD, "P/lead/override.yaml": "limits: { maxTurns: 30 }\n", "U/critic.yaml": "name: critic\nharness: { provider: codex, auth: subscription }\n" }, { worker }, "worker");
		const o = profilesOf(w.project);
		expect(Profiles.parse(o)).toEqual(o);
		expect(o).toMatchObject({ file: w.agentsFile, default: "worker", warnings: [], error: null, layers: [{ layer: "project", dir: join(w.repo, ".capcomd", "profiles") }, { layer: "user", dir: join(w.root, "home", "profiles") }] });
		expect(o.profiles.map((p) => [p.name, p.source, p.format, p.version, p.default, p.ready])).toEqual([
			["worker", "project", "v1", 1, true, true], ["lead", "project", "v2", 2, false, true], ["critic", "user", "v2", 1, false, false],
		]);
		const lead = o.profiles[1]!;
		expect(lead).toEqual({
			name: "lead", version: 2, source: "project", format: "v2", path: w.at("P/lead/profile.yaml"), default: false, description: "Leads a part.", tags: ["lead", "review"],
			provider: "claude", auth: "subscription", model: "sonnet", effort: null, toolMode: "orchestrate", canSpawn: true, canLead: "up to 3 worker helpers, one level",
			does: expect.stringMatching(/^leads a part: spawns up to 3 worker helpers, one level/), ready: true, readiness: "logged in (capcomd-auth-claude-x)",
			applied: [
				{ as: "extends", name: "worker", layer: "project", path: w.agentsFile },
				{ as: "profile", name: "lead", layer: "project", path: w.at("P/lead/profile.yaml") },
				{ as: "override", name: "lead", layer: "project", path: w.at("P/lead/override.yaml") },
			],
		});
		expect(o.profiles[2]).toMatchObject({ provider: "codex", path: w.at("U/critic.yaml"), description: null, tags: [], ready: false, readiness: "not logged in: capcomd auth login codex" });
		// What it is never carries: a prompt or a credential.
		expect(JSON.stringify(o)).not.toContain("appendSystemPrompt");
	});

	test("profiles that can't be read: a 200 with `error`, naming the file, and no profiles", () => {
		const w = world({ "P/lead/profile.yaml": "name: lead\nextends: nobody\n" });
		const o = profilesOf(w.project);
		expect(o.profiles).toEqual([]);
		expect(o.error).toBe(`${w.at("P/lead/profile.yaml")}: extends "nobody", which isn't a profile here (this project's, your own or a bundled one; a profile never extends another project's)`);
	});

	test("an agents.json that isn't JSON: the error says where, never what is there (it may be a link to a token file)", async () => {
		const w = world({ "P/solo.yaml": "name: solo\nharness: { provider: claude, auth: subscription }\n" });
		writeFileSync(w.agentsFile, "ghp_SECRETTOKEN123\n");
		const o = profilesOf(w.project);
		expect(o.error).toBe(`${w.agentsFile}: invalid JSON (JSON Parse error: Unexpected identifier)`);
		// Over HTTP it is a 200 with that error, and the body holds nothing of the file.
		const app = harnessApp({ source: { ...memorySource(), profiles: (repo?: string) => profilesFor(repo, w.env) }, clients: () => loadClients(cpath), state: harnessState(null) });
		const r = await app.request(`/v1/profiles?repo=${encodeURIComponent(w.repo)}`, { headers: { authorization: `Bearer ${reader}` } });
		expect(r.status).toBe(200);
		const text = await r.text();
		expect(Profiles.parse(JSON.parse(text))).toMatchObject({ profiles: [], error: o.error });
		expect(text).not.toContain("SECRETTOKEN");
	});

	test("repo: that project's profiles, as POST /v1/runs resolves them; not a project is CreateRunError", async () => {
		const w = world({ "P/solo.yaml": "name: solo\nharness: { provider: claude, auth: subscription }\n" });
		const o = await profilesFor(w.repo, w.env);
		expect(o.profiles.map((p) => [p.name, p.source])).toEqual([["solo", "project"]]);
		expect((await profilesFor(undefined, w.env)).profiles).toEqual([]); // the daemon's own: its home has none
		const plain = mkdtempSync(join(dir, "plain-"));
		await expect(profilesFor(plain, w.env)).rejects.toThrow(new CreateRunError(`${plain} is not a capcomd project (no .capcomd/config.json in it or above it). Run \`capcomd setup project\` in it first.`));
	});

	test("over HTTP: the read scope; the source's answer; 422 invalid for a repo that isn't a project or a relative path", async () => {
		const w = world({ "P/solo.yaml": "name: solo\nharness: { provider: claude, auth: subscription }\n" });
		const app = harnessApp({ source: { ...memorySource(), profiles: (repo?: string) => profilesFor(repo, w.env) }, clients: () => loadClients(cpath), state: harnessState(null) });
		const get = (q: string, auth = true) => app.request(`/v1/profiles${q}`, auth ? { headers: { authorization: `Bearer ${reader}` } } : {});
		expect((await get("", false)).status).toBe(401);
		const ok = await get(`?repo=${encodeURIComponent(w.repo)}`);
		expect(ok.status).toBe(200);
		expect(Profiles.parse(await ok.json()).profiles.map((p) => p.name)).toEqual(["solo"]);
		const plain = mkdtempSync(join(dir, "plain-"));
		const bad = await get(`?repo=${encodeURIComponent(plain)}`);
		expect(bad.status).toBe(422);
		expect(await bad.json()).toEqual({ code: "invalid", message: `${plain} is not a capcomd project (no .capcomd/config.json in it or above it). Run \`capcomd setup project\` in it first.` });
		expect(((await (await get("?repo=relative/path")).json()) as any).code).toBe("invalid");
		// The memory source's default: no profiles.
		const empty = harnessApp({ source: memorySource(), clients: () => loadClients(cpath), state: harnessState(null) });
		expect(Profiles.parse(await (await empty.request("/v1/profiles", { headers: { authorization: `Bearer ${reader}` } })).json()).profiles).toEqual([]);
		expect(((await (await app.request("/v1/health")).json()) as any).capabilities).toContain("profiles");
	});
});
