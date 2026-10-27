// Agent.provider / Agent.model and the typed agent.spawned `agent` (the end-to-end run is tests/scenarios/agent-provider).
import { describe, expect, test } from "bun:test";
import { agentModel } from "../../src/agents/config";
import { Agent, EventData } from "../../src/api/contract";
import { strictEventData } from "../../src/api/legacy-events";
import { agentRuntime } from "../../src/api/rivet-source";
import spec from "../../openapi/capcomd.json";

describe("agentRuntime (from the spec recorded at spawn)", () => {
	test("a profile's provider and model", () => {
		expect(agentRuntime({ provider: "claude", auth: "subscription", kind: "claude-code", model: "claude-sonnet-4-5" })).toEqual({ provider: "claude", model: "claude-sonnet-4-5" });
		expect(agentRuntime({ provider: "codex", auth: "apikey", kind: "codex", model: "gpt-5-codex" })).toEqual({ provider: "codex", model: "gpt-5-codex" });
		expect(agentRuntime({ provider: "claude", auth: "subscription", kind: "claude-code" })).toEqual({ provider: "claude", model: null });
	});
	test("CAPCOMD_AGENT without a profile: the runner kind names the provider", () => {
		expect(agentRuntime({ kind: "claude-code" })).toEqual({ provider: "claude", model: null });
		expect(agentRuntime({ kind: "codex", model: "gpt-5-mini" })).toEqual({ provider: "codex", model: "gpt-5-mini" });
	});
	test("a fake agent, and agents with no recorded spec, report null", () => {
		expect(agentRuntime({ kind: "fake", model: "x" })).toEqual({ provider: null, model: null });
		expect(agentRuntime({ provider: "claude", kind: "fake" })).toEqual({ provider: null, model: null });
		expect(agentRuntime(null)).toEqual({ provider: null, model: null });
		expect(agentRuntime(undefined)).toEqual({ provider: null, model: null });
		expect(agentRuntime({ kind: "other", model: "x" })).toEqual({ provider: null, model: null });
	});
});

test("agentModel: CAPCOMD_AGENT_MODEL wins over the profile's model", () => {
	expect(agentModel({ model: "p" }, {})).toBe("p");
	expect(agentModel({ model: "p" }, { CAPCOMD_AGENT_MODEL: "e" })).toBe("e");
	expect(agentModel(undefined, { CAPCOMD_AGENT_MODEL: "e" })).toBe("e");
	expect(agentModel(undefined, {})).toBeUndefined();
});

describe("contract", () => {
	const agent = { id: "agt-1", runId: "run-1", parent: null, depth: 0, profile: "worker", status: "running", text: "Running.", activity: null, task: "t", taskAttachment: null, result: null, workspace: null, updatedAt: null };
	test("Agent.provider and Agent.model are required and nullable", () => {
		expect(Agent.parse({ ...agent, provider: "claude", model: "claude-sonnet-4-5" })).toMatchObject({ provider: "claude", model: "claude-sonnet-4-5" });
		expect(Agent.parse({ ...agent, provider: "codex", model: null })).toMatchObject({ provider: "codex", model: null });
		expect(Agent.parse({ ...agent, provider: null, model: null })).toMatchObject({ provider: null, model: null });
		expect(Agent.safeParse({ ...agent, model: null }).success).toBe(false);
		expect(Agent.safeParse({ ...agent, provider: "gemini", model: null }).success).toBe(false);
	});
	test("agent.spawned `agent` is typed (kind, provider, model) and open to the profile's other fields", () => {
		const base = { parent: null, depth: 0, profile: "worker", budget: {}, limits: {}, task: "t", key: null, operator: false, workspace: null };
		for (const a of [
			{ provider: "claude", auth: "subscription", maxTurns: 20, kind: "claude-code", model: "claude-sonnet-4-5" },
			{ provider: "codex", auth: "apikey", kind: "codex" },
			{ kind: "codex", model: "gpt-5-mini" },
			{ kind: "fake" },
			null,
		]) expect(strictEventData("agent.spawned", { ...base, agent: a })).toEqual({ ok: true });
		expect(strictEventData("agent.spawned", { ...base, agent: { provider: "gemini" } }).ok).toBe(false);
		expect(strictEventData("agent.spawned", { ...base, agent: { kind: "claude" } }).ok).toBe(false);
		expect(strictEventData("agent.spawned", { ...base, agent: { model: 3 } }).ok).toBe(false);
		expect(EventData["agent.spawned"].parse({ ...base, agent: { kind: "codex", sandbox: "read-only" } }).agent).toEqual({ kind: "codex", sandbox: "read-only" });
	});
	test("published: Agent has provider and model as nullable required fields; AgentSpawnedData.agent is a nullable open object", () => {
		const agentSchema = (spec as any).paths["/v1/runs/{runId}/agents"].get.responses["200"].content["application/json"].schema.items;
		expect(agentSchema.required).toEqual(expect.arrayContaining(["provider", "model"]));
		expect(agentSchema.properties.provider.type).toEqual(["string", "null"]);
		expect(agentSchema.properties.provider.enum).toEqual(["claude", "codex", null]);
		expect(agentSchema.properties.model.type).toEqual(["string", "null"]);
		const a = (spec as any).components.schemas.AgentSpawnedData.properties.agent;
		expect(a.type).toEqual(["object", "null"]);
		expect(a.additionalProperties).toEqual({});
		expect(a.properties.kind.enum).toEqual(["fake", "claude-code", "codex"]);
		expect(a.properties.provider.enum).toEqual(["claude", "codex"]);
		expect(a.properties.model.type).toEqual(["string", "null"]);
	});
});
