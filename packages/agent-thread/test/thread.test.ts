// Adapter behaviour beyond the golden sessions: dedupe, pairing, durations, suppression, unknown events, garbage.
import { describe, expect, test } from "bun:test";
import { handoffDraft, threadBuilder, ThreadItem, type ItemDraft } from "../src/index";

const run = (cli: "claude" | "codex", events: unknown[], o: { onImage?: (x: any) => void } = {}) => {
	const b = threadBuilder({ cli, idPrefix: "itm-t", now: () => 0, link: { root: "/w/repo" }, ...o });
	const updates: ItemDraft[] = [];
	for (const e of events) updates.push(...b.event(e));
	updates.push(...b.finish());
	const final = new Map<string, ItemDraft>();
	for (const u of updates) final.set(u.id, u);
	return { updates, items: [...final.values()] };
};
const asst = (id: string, ...content: unknown[]) => ({ type: "assistant", message: { id, content } });
const results = (...rs: unknown[]) => ({ type: "user", message: { content: rs } });

describe("claude", () => {
	test("parallel tool calls pair by tool_use_id, in any order; durations only when the CLI reports one", () => {
		const { items } = run("claude", [
			asst("m1", { type: "tool_use", id: "a", name: "Glob", input: { pattern: "**/*.ts" } }),
			asst("m1", { type: "tool_use", id: "b", name: "WebSearch", input: { query: "q" } }),
			results({ type: "tool_result", tool_use_id: "b", content: "r" }),
			{ ...results({ type: "tool_result", tool_use_id: "a", content: "x.ts" }), tool_use_result: { durationMs: 41 } },
		]);
		expect(items.map((i) => [i.tool?.callId, i.status, i.durationMs])).toEqual([["a", "done", 41], ["b", "done", null]]);
		expect(items.map((i) => i.tool!.summary)).toEqual(["Find **/*.ts", "Search the web for q"]);
	});
	test("durationSeconds (WebSearch) and totalDurationMs (Task) count", () => {
		const { items } = run("claude", [
			asst("m", { type: "tool_use", id: "w", name: "WebSearch", input: { query: "q" } }, { type: "tool_use", id: "t", name: "Task", input: { description: "dig" } }),
			{ ...results({ type: "tool_result", tool_use_id: "w", content: "" }), tool_use_result: { durationSeconds: 1.25 } },
			{ ...results({ type: "tool_result", tool_use_id: "t", content: "" }), tool_use_result: { totalDurationMs: 9000 } },
		]);
		expect(items.map((i) => i.durationMs)).toEqual([1250, 9000]);
	});
	test("a repeated block (same message id) is one item", () => {
		const t = { type: "text", text: "hello" };
		expect(run("claude", [asst("m", t), asst("m", t), asst("m2", t)]).items.length).toBe(2);
	});
	test("a result that repeats the last message is not shown again", () => {
		const { items } = run("claude", [asst("m", { type: "text", text: "Done: fixed it." }), { type: "result", subtype: "success", result: "Done: fixed it." }]);
		expect(items.map((i) => i.kind)).toEqual(["say"]);
	});
	test("background-task notices are bookkeeping, not items; other system events still show", () => {
		const { items } = run("claude", [
			{ type: "system", subtype: "task_started", task_id: "b1", description: "capcomd await" },
			{ type: "system", subtype: "task_notification", task_id: "b1", status: "completed" },
			{ type: "system", subtype: "something_new" },
		]);
		expect(items.map((i) => i.text)).toEqual(["System: something_new"]);
	});
	test("an error result with new text is an error item with the CLI's code", () => {
		const { items } = run("claude", [{ type: "result", subtype: "error_max_turns", is_error: true }]);
		expect(items).toMatchObject([{ kind: "error", text: "error_max_turns", error: { code: "error_max_turns" } }]);
	});
	test("empty thinking is redacted; a tool result for an unknown call is an other item", () => {
		const { items } = run("claude", [asst("m", { type: "thinking", thinking: "  " }), results({ type: "tool_result", tool_use_id: "zz", content: "?" })]);
		expect(items.map((i) => [i.kind, i.redacted])).toEqual([["thinking", true], ["other", false]]);
	});
	test("tool output is sanitized and keeps its end", () => {
		const big = `${"a".repeat(20_000)}\u001b[31mEND`;
		const { items } = run("claude", [asst("m", { type: "tool_use", id: "x", name: "Bash", input: { command: "ls" } }), results({ type: "tool_result", tool_use_id: "x", content: big })]);
		expect(items[0]!.tool!.output!.endsWith("aEND")).toBe(true);
		expect(items[0]!.tool!.output!.length).toBeLessThanOrEqual(16 * 1024);
	});
	test("images without an attachment store are text, never base64", () => {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		const ev = [asst("m", { type: "tool_use", id: "x", name: "mcp__b__shot", input: {} }), results({ type: "tool_result", tool_use_id: "x", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] })];
		expect(JSON.stringify(run("claude", ev).items)).not.toContain(png.slice(0, 20));
		const stored: any[] = [];
		const withStore = run("claude", ev, { onImage: (i) => stored.push(i) });
		expect(stored.map((s) => s.id)).toEqual([expect.stringMatching(/^att-[0-9a-f]{24}$/)]);
		expect(withStore.items[0]!.blocks).toEqual([{ t: "media", kind: "image", source: { type: "inline", attachmentId: stored[0].id }, alt: "Image from the tool", mime: "image/png", bytes: 70, width: 1, height: 1 }]);
		expect(JSON.stringify(withStore.items)).not.toContain(png.slice(0, 20));
	});
});

describe("codex", () => {
	test("reconnect notices are other items, real errors are errors", () => {
		const { items } = run("codex", [{ type: "error", message: "Reconnecting... 2/5" }, { type: "error", message: "unexpected status 401" }]);
		expect(items.map((i) => i.kind)).toEqual(["other", "error"]);
	});
	test("a tool step still running when the turn completes is closed unfinished... only at finish", () => {
		const { updates } = run("codex", [{ type: "item.started", item: { id: "i", type: "command_execution", command: "sleep 9" } }, { type: "turn.completed" }]);
		expect(updates.map((u) => [u.rev, u.status, u.error?.code ?? null])).toEqual([[1, "open", null], [2, "done", "unfinished"]]);
	});
});

describe("hand-back", () => {
	test("a child's artifacts become media (images, video) and classified links (files, attachments, web, none)", () => {
		const d = handoffDraft({
			id: "itm-p-handoff-c", at: 0, child: { agentId: "agt-c", status: "done" }, summary: "Wrote shards **1-118**.",
			artifacts: [{ name: "chart", ref: "charts/rows.png" }, { name: "report.md", ref: "report.md" }, { name: "log", ref: "att-0123456789abcdef" }, { name: "dash", ref: "https://grafana.example.com/d/1" }, { name: "bucket", ref: "r2://matchkey/v3.2/" }],
		});
		expect(ThreadItem.safeParse({ ...d, seq: 1, order: 1, agentId: "agt-p" }).success).toBe(true);
		expect(d).toMatchObject({ kind: "handoff", child: { agentId: "agt-c", status: "done" }, text: "Wrote shards **1-118**." });
		expect(d.blocks.map((b) => b.t)).toEqual(["paragraph", "media", "list"]);
		expect(d.blocks[1]).toMatchObject({ kind: "image", source: { type: "workspace", path: "charts/rows.png" }, alt: "chart" });
		const links = (d.blocks[2] as any).items.map((i: any) => i.blocks[0].children[0]);
		expect(links.map((l: any) => [l.text, l.target])).toEqual([["report.md", "file"], ["log", "artifact"], ["dash", "web"], ["bucket", "none"]]);
	});
});

describe("robustness", () => {
	test("garbage never throws and unknown things are never dropped", () => {
		const junk: unknown[] = [null, 1, "x", [], {}, { type: 5 }, { type: "assistant", message: { content: "str" } }, { type: "assistant", message: { content: [null, 1, { type: "tool_use" }, { type: "server_tool_use", name: "x" }] } },
			{ type: "user", message: { content: [{ type: "tool_result" }] } }, { type: "item.completed", item: { type: "mystery" } }, { type: "item.completed", item: null }];
		for (const cli of ["claude", "codex"] as const) {
			const { items } = run(cli, junk);
			for (const i of items) expect(ThreadItem.safeParse({ ...i, seq: 0, order: 0, agentId: "a" }).success).toBe(true);
			expect(items.some((i) => i.kind === "other")).toBe(true);
		}
	});
});
