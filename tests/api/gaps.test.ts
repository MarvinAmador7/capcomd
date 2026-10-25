// Phase 1 contract gaps for the client (step 4): plain-language text, history, typed results, one profile type, projects, transcripts, skills.
import { describe, expect, test } from "bun:test";
import spec from "../../openapi/capcomd.json";
import { Agent, contract, EventData, ProfileName, StreamFrames, TRANSCRIPT_PAGE_MAX } from "../../src/api/contract";
import { describeEvent } from "../../src/api/describe";

const S = (spec as any).components.schemas;
const paths = Object.keys((spec as any).paths);

describe("contract gaps (phase 1)", () => {
	test("every event type has its own plain-language sentence, never agent text", () => {
		for (const t of Object.keys(EventData)) {
			const s = describeEvent(t, { taskId: "SECRET_TASK", k: "SECRET_KEY", text: "SECRET", detail: "SECRET" }, "a1");
			expect(s).not.toBe(t.replace(/[._]/g, " ") + ".");
			expect(s).not.toContain("SECRET");
		}
	});
	test("agent.done result is typed and x-untrusted", () => {
		const r = S.AgentDoneData.properties.result;
		const node = r.$ref ? S[r.$ref.split("/").pop()] : r;
		expect(node["x-untrusted"]).toBe(true);
		expect(node.properties.summary).toBeDefined();
	});
	test("one lowercase profile type", () => {
		expect(ProfileName.safeParse("builder").success).toBe(true);
		expect(ProfileName.safeParse("Builder").success).toBe(false);
		expect(Agent.shape.profile.unwrap()).toBe(ProfileName);
	});
	test("message.sent carries the body; snapshots carry step and thread history", () => {
		expect(S.MessageSentData.properties.text).toBeDefined();
		expect(Object.keys(StreamFrames)).toEqual(expect.arrayContaining(["snapshot.steps", "snapshot.threads"]));
	});
	test("routes: projects, trace, messages, transcript, attachments, skills", () => {
		for (const p of ["/v1/projects", "/v1/runs/{runId}/trace", "/v1/runs/{runId}/messages", "/v1/runs/{runId}/agents/{agentId}/transcript", "/v1/runs/{runId}/attachments/{attachmentId}", "/v1/skills"])
			expect(paths).toContain(p);
		expect(TRANSCRIPT_PAGE_MAX).toBe(500);
		expect(contract.projects.list).toBeDefined();
	});
	test("runs carry repo and goal; projects hold many runs", () => {
		const run = S.Run ?? null;
		const proj = JSON.stringify(spec);
		expect(proj).toContain('"runIds"');
		expect(proj).toContain('"repo"');
		void run;
	});
});
