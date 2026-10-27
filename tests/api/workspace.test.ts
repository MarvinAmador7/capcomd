// Agent.workspace / agent.spawned.workspace: where an agent works, with a label the menu bar shows verbatim.
import { describe, expect, test } from "bun:test";
import { Agent, EventData } from "../../src/api/contract";
import { strictEventData } from "../../src/api/legacy-events";
import { repoLabel, workspaceOf } from "../../src/api/workspace";
import spec from "../../openapi/capcomd.json";

describe("workspaceOf", () => {
	test("labels a repository by its base name, for paths and remote URLs", () => {
		for (const [repo, label] of [
			["/Users/me/src/matchkey", "matchkey"],
			["/Users/me/src/matchkey/", "matchkey"],
			["/srv/git/origin.git", "origin"],
			["https://github.com/acme/matchkey.git", "matchkey"],
			["https://github.com/acme/matchkey", "matchkey"],
			["git@github.com:acme/addriva.git", "addriva"],
			["git@host:relay.git", "relay"],
			["ssh://git@host:2222/acme/relay", "relay"],
		]) expect(repoLabel(repo!)).toBe(label!);
	});
	test("the whole repository: path null, label the repo's base name", () => {
		expect(workspaceOf("/Users/me/src/matchkey")).toEqual({ repo: "/Users/me/src/matchkey", path: null, label: "matchkey" });
	});
	test("a sub-folder: label is the path", () => {
		expect(workspaceOf("/Users/me/src/matchkey", "ids/v1")).toEqual({ repo: "/Users/me/src/matchkey", path: "ids/v1", label: "ids/v1" });
		expect(workspaceOf("/r/matchkey", "./ids/v1/")).toMatchObject({ path: "ids/v1", label: "ids/v1" });
		expect(workspaceOf("/r/matchkey", "/")).toMatchObject({ path: null, label: "matchkey" });
	});
	test("no repository: null", () => {
		expect(workspaceOf(null)).toBeNull();
		expect(workspaceOf("")).toBeNull();
		expect(workspaceOf(undefined)).toBeNull();
	});
	test("credentials in a repository URL are never published", () => {
		const w = workspaceOf("https://x-access-token:ghs_secret@github.com/acme/matchkey.git")!;
		expect(w).toEqual({ repo: "https://github.com/acme/matchkey.git", path: null, label: "matchkey" });
		expect(JSON.stringify(w)).not.toContain("ghs_secret");
	});
});

describe("contract", () => {
	const agent = { id: "agt-1", runId: "run-1", parent: null, depth: 0, profile: "planner", status: "running", text: "Running.", activity: null, task: "t", taskAttachment: null, result: null, provider: "claude", model: null, effort: null, updatedAt: null };
	test("Agent.workspace is required and nullable", () => {
		expect(Agent.parse({ ...agent, workspace: workspaceOf("/r/matchkey") }).workspace).toEqual({ repo: "/r/matchkey", path: null, label: "matchkey" });
		expect(Agent.parse({ ...agent, workspace: null }).workspace).toBeNull();
		expect(Agent.safeParse(agent).success).toBe(false);
		expect(Agent.safeParse({ ...agent, workspace: { repo: "/r/m", path: null, label: "" } }).success).toBe(false);
	});
	test("agent.spawned carries workspace; events from older daemons without it still decode", () => {
		const base = { parent: null, depth: 0, profile: "worker", budget: {}, limits: {}, agent: null, task: "t", key: null, operator: false };
		const ws = workspaceOf("/r/matchkey", "ids/v1");
		expect(strictEventData("agent.spawned", { ...base, workspace: ws }).ok).toBe(true);
		expect(strictEventData("agent.spawned", { ...base, workspace: null }).ok).toBe(true);
		expect(strictEventData("agent.spawned", { ...base, workspace: { repo: "/r" } }).ok).toBe(false);
		expect(EventData["agent.spawned"].parse(base).workspace).toBeUndefined();
		expect(EventData["agent.spawned"].parse({ ...base, workspace: ws }).workspace).toEqual(ws);
	});
	test("published: Agent and AgentSpawnedData have workspace as [object, null] with repo, path, label", () => {
		const agentSchema = (spec as any).paths["/v1/runs/{runId}/agents"].get.responses["200"].content["application/json"].schema.items;
		const spawned = (spec as any).components.schemas.AgentSpawnedData;
		expect(agentSchema.required).toContain("workspace");
		expect(spawned.required ?? []).not.toContain("workspace");
		for (const w of [agentSchema.properties.workspace, spawned.properties.workspace]) {
			expect(w.type).toEqual(["object", "null"]);
			expect(w.required).toEqual(["repo", "path", "label"]);
			expect(w.properties.path.type).toEqual(["string", "null"]);
		}
	});
});
