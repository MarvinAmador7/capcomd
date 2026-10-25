import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvents } from "../src/adapters/events";
import { HarnessEvent } from "../../../src/api/envelope";
import { EventData } from "../../../src/api/contract";

const text = readFileSync(join(import.meta.dir, "../fixtures/harness-v1/events.ndjson"), "utf8");

test("the harness-v1 fixture validates against the contract", () => {
	for (const line of text.trim().split("\n")) {
		const ev = HarnessEvent.parse(JSON.parse(line));
		expect(ev.type in EventData).toBe(true);
		EventData[ev.type as keyof typeof EventData].parse(ev.data);
	}
});

test("the TUI's inspect adapter parses harness.v1 envelopes", () => {
	const evs = parseEvents(text);
	expect(evs.map((e) => e.type)).toEqual(["run.created", "agent.spawned", "agent.started", "approval.requested", "approval.decided"]);
	expect(evs[0]!.at).toBe(1792900500000);
	expect(evs[3]!.data).toMatchObject({ approvalId: "apr-k1", kind: "merge" });
	expect(evs[1]!.seq).toBe(2);
});
