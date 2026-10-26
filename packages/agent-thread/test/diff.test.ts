// tool.diff: a file-editing call's change as a bounded line diff, from the CLI's own events (never the disk).
import { describe, expect, test } from "bun:test";
import { DIFF_LINE_MAX_CHARS, DIFF_MAX_LINES, lineDiff, threadBuilder, ThreadItem, type ItemDraft } from "../src/index";

const ROOT = "/w/repo";
const run = (cli: "claude" | "codex", events: unknown[]) => {
	const b = threadBuilder({ cli, idPrefix: "itm-d", now: () => 0, link: { root: ROOT } });
	const updates: ItemDraft[] = [];
	for (const e of events) updates.push(...b.event(e));
	updates.push(...b.finish());
	for (const u of updates) {
		const r = ThreadItem.safeParse({ ...u, seq: 1, order: 1, agentId: "agt-d" });
		if (!r.success) throw new Error(r.error.message);
	}
	const final = new Map<string, ItemDraft>();
	for (const u of updates) final.set(u.id, u);
	return { updates, items: [...final.values()] };
};
const use = (id: string, name: string, input: unknown) => ({ type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, tool_use_result?: unknown, o: { is_error?: boolean; content?: string } = {}) =>
	({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: o.content ?? "ok", ...(o.is_error ? { is_error: true } : {}) }] }, ...(tool_use_result !== undefined ? { tool_use_result } : {}) });
const one = (events: unknown[]) => run("claude", events).items[0]!.tool!.diff;

describe("lineDiff", () => {
	test("shared ends are context, the middle is matched line by line", () => {
		expect(lineDiff(["a", "b", "c", "d"], ["a", "B", "c", "x", "d"])).toEqual([
			{ op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "B" }, { op: " ", text: "c" }, { op: "+", text: "x" }, { op: " ", text: "d" },
		]);
		expect(lineDiff([], ["n"])).toEqual([{ op: "+", text: "n" }]);
		expect(lineDiff(["same"], ["same"])).toEqual([{ op: " ", text: "same" }]);
	});
});

describe("claude", () => {
	test("Edit: old_string → new_string while it runs, then the result's structuredPatch (with its context)", () => {
		const input = { file_path: `${ROOT}/src/join.ts`, old_string: "function join() {\n  return a.email;\n}", new_string: "function join() {\n  return lower(a.email);\n}" };
		const { updates } = run("claude", [
			use("e", "Edit", input),
			result("e", {
				filePath: `${ROOT}/src/join.ts`, oldString: input.old_string, newString: input.new_string, originalFile: "import x;\nfunction join() {\n  return a.email;\n}\n",
				structuredPatch: [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [" import x;", " function join() {", "-  return a.email;", "+  return lower(a.email);", " }"] }],
				userModified: false, replaceAll: false,
			}),
		]);
		expect(updates.map((u) => [u.status, u.tool!.diff])).toEqual([
			["open", { path: "src/join.ts", added: 1, removed: 1, truncatedLines: null, lines: [
				{ op: " ", text: "function join() {" }, { op: "-", text: "  return a.email;" }, { op: "+", text: "  return lower(a.email);" }, { op: " ", text: "}" },
			] }],
			["done", { path: "src/join.ts", added: 1, removed: 1, truncatedLines: null, lines: [
				{ op: " ", text: "import x;" }, { op: " ", text: "function join() {" }, { op: "-", text: "  return a.email;" }, { op: "+", text: "  return lower(a.email);" }, { op: " ", text: "}" },
			] }],
		]);
		// originalFile is file contents: it never reaches the item.
		expect(JSON.stringify(updates)).not.toContain("import x;\\nfunction");
	});

	test("several hunks (replace_all) are separated by an @ line carrying the next hunk's header", () => {
		const d = one([
			use("e", "Edit", { file_path: `${ROOT}/a.ts`, old_string: "x", new_string: "y", replace_all: true }),
			result("e", { filePath: `${ROOT}/a.ts`, structuredPatch: [
				{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-x", "+y"] },
				{ oldStart: 40, oldLines: 2, newStart: 40, newLines: 2, lines: ["-x", "+y", " b", "\\ No newline at end of file"] },
			], replaceAll: true }),
		]);
		expect(d).toEqual({ path: "a.ts", added: 2, removed: 2, truncatedLines: null, lines: [
			{ op: " ", text: "a" }, { op: "-", text: "x" }, { op: "+", text: "y" }, { op: "@", text: "@@ -40,2 +40,2 @@" }, { op: "-", text: "x" }, { op: "+", text: "y" }, { op: " ", text: "b" },
		] });
	});

	test("MultiEdit: each edit a hunk; Write: the content as added lines, then what the result says", () => {
		expect(one([use("m", "MultiEdit", { file_path: `${ROOT}/m.ts`, edits: [{ old_string: "a", new_string: "b" }, { old_string: "c\nd", new_string: "c" }] })])).toEqual({
			path: "m.ts", added: 1, removed: 2, truncatedLines: null,
			lines: [{ op: "-", text: "a" }, { op: "+", text: "b" }, { op: "@", text: "" }, { op: " ", text: "c" }, { op: "-", text: "d" }],
		});
		const content = "export const a = 1;\nexport const b = 2;\n";
		const created = run("claude", [use("w", "Write", { file_path: `${ROOT}/n.ts`, content }), result("w", { type: "create", filePath: `${ROOT}/n.ts`, content, structuredPatch: [], originalFile: null })]);
		expect(created.updates.map((u) => u.tool!.diff)).toEqual([0, 1].map(() => ({ path: "n.ts", added: 2, removed: 0, truncatedLines: null, lines: [{ op: "+", text: "export const a = 1;" }, { op: "+", text: "export const b = 2;" }] })));
		// A Write over an existing file: the result's patch is the real change.
		expect(one([use("w", "Write", { file_path: `${ROOT}/n.ts`, content: "a\nB\n" }), result("w", { type: "update", filePath: `${ROOT}/n.ts`, content: "a\nB\n", structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-b", "+B"] }], originalFile: "a\nb\n" })]))
			.toEqual({ path: "n.ts", added: 1, removed: 1, truncatedLines: null, lines: [{ op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "B" }] });
		// Rewritten with what it already held: no change.
		expect(one([use("w", "Write", { file_path: `${ROOT}/n.ts`, content: "a\n" }), result("w", { type: "update", filePath: `${ROOT}/n.ts`, content: "a\n", structuredPatch: [], originalFile: "a\n" })])).toBeNull();
	});

	test("NotebookEdit: an inserted cell is added lines; a replace (old source unknown) has no diff", () => {
		expect(one([use("n", "NotebookEdit", { notebook_path: `${ROOT}/a.ipynb`, new_source: "x = 1\ny = 2", edit_mode: "insert", cell_type: "code" })]))
			.toEqual({ path: "a.ipynb", added: 2, removed: 0, truncatedLines: null, lines: [{ op: "+", text: "x = 1" }, { op: "+", text: "y = 2" }] });
		expect(one([use("n", "NotebookEdit", { notebook_path: `${ROOT}/a.ipynb`, new_source: "x = 1", edit_mode: "replace", cell_id: "c1" })])).toBeNull();
	});

	test("a failed edit keeps the change it proposed; other tools, no-op edits and unknown shapes have none", () => {
		const failed = run("claude", [use("e", "Edit", { file_path: `${ROOT}/a.ts`, old_string: "a", new_string: "b" }), result("e", undefined, { is_error: true, content: "String to replace not found in file." })]).items[0]!;
		expect(failed.tool).toMatchObject({ isError: true, diff: { added: 1, removed: 1 } });
		expect(one([use("b", "Bash", { command: "ls" }), result("b", { stdout: "", structuredPatch: [{ lines: ["+x"] }] })])).toBeNull();
		expect(one([use("e", "Edit", { file_path: `${ROOT}/a.ts`, old_string: "a", new_string: "a" })])).toBeNull();
		expect(one([use("e", "Edit", { file_path: 5, old_string: ["x"], new_string: { y: 1 } })])).toBeNull();
		// With several results in one event, tool_use_result can't be matched to one: the input's diff stays.
		const two = run("claude", [
			{ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "a", name: "Edit", input: { file_path: "a.ts", old_string: "1", new_string: "2" } }, { type: "tool_use", id: "b", name: "Edit", input: { file_path: "b.ts", old_string: "3", new_string: "4" } }] } },
			{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }, { type: "tool_result", tool_use_id: "b", content: "ok" }] }, tool_use_result: { filePath: "b.ts", structuredPatch: [{ lines: ["+zzz"] }] } },
		]);
		expect(two.items.map((i) => i.tool!.diff!.lines.map((l) => l.text))).toEqual([["1", "2"], ["3", "4"]]);
	});

	test("caps: at most 40 lines, each cut to 240 characters, counts over the whole change", () => {
		const content = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
		const big = one([use("w", "Write", { file_path: `${ROOT}/big.txt`, content })])!;
		expect(big).toMatchObject({ added: 1000, removed: 0, truncatedLines: 960 });
		expect(big.lines.length).toBe(DIFF_MAX_LINES);
		expect(big.lines.at(-1)).toEqual({ op: "+", text: "line 39" });
		// Large on both sides (beyond line matching): all removed, then all added; still counted in full.
		const a = Array.from({ length: 900 }, (_, i) => `old ${i}`).join("\n"), b = Array.from({ length: 700 }, (_, i) => `new ${i}`).join("\n");
		expect(one([use("e", "Edit", { file_path: `${ROOT}/x.ts`, old_string: a, new_string: b })])).toMatchObject({ added: 700, removed: 900, truncatedLines: 1560 });
		// Long lines and control characters.
		const long = one([use("w", "Write", { file_path: `${ROOT}/l.txt`, content: `\u001b[31m${"é".repeat(300)}\u001b[0m\n${"a".repeat(DIFF_LINE_MAX_CHARS - 2)}😀😀` })])!;
		expect(long.lines[0]!.text).toBe(`${"é".repeat(DIFF_LINE_MAX_CHARS - 1)}…`);
		expect(long.lines[1]!.text).toBe(`${"a".repeat(DIFF_LINE_MAX_CHARS - 2)}…`); // never half an emoji
		expect(JSON.stringify(long)).not.toMatch(/\u001b/);
		// A huge MultiEdit: separators stop with the lines, and never end the list.
		const many = one([use("m", "MultiEdit", { file_path: `${ROOT}/m.ts`, edits: Array.from({ length: 30 }, (_, i) => ({ old_string: `a${i}`, new_string: `b${i}` })) })])!;
		expect(many).toMatchObject({ added: 30, removed: 30 });
		expect(many.lines.length).toBeLessThanOrEqual(DIFF_MAX_LINES);
		expect(many.lines.at(-1)!.op).not.toBe("@");
		expect(many.truncatedLines).toBe(60 - many.lines.filter((l) => l.op !== "@").length);
	});

	test("path: relative to the workspace and normalized like file links; null outside it (the diff still shows)", () => {
		const path = (p: string) => one([use("w", "Write", { file_path: p, content: "x" })])?.path;
		expect(path(`${ROOT}/src/./a/../b.ts`)).toBe("src/b.ts");
		expect(path("src/c.ts")).toBe("src/c.ts");
		expect(path("../../etc/passwd")).toBeNull();
		expect(path("/etc/passwd")).toBeNull();
		expect(path(`${ROOT}/../other/secret`)).toBeNull();
		expect(path(`${ROOT}2/x`)).toBeNull();
		expect(path(`${ROOT}/.git/config`)).toBeNull();
		expect(path("~/.ssh/config")).toBeNull();
		// The result's filePath wins over the input's, and is checked the same way.
		expect(one([use("w", "Write", { file_path: `${ROOT}/ok.ts`, content: "x" }), result("w", { type: "create", filePath: "/etc/passwd", content: "x", structuredPatch: [] })])!.path).toBeNull();
	});
});

describe("codex", () => {
	test("file_change reports paths and kinds, not lines: no diff, the files are links", () => {
		const { items } = run("codex", [
			{ type: "item.completed", item: { id: "c", type: "file_change", changes: [{ path: `${ROOT}/src/a.ts`, kind: "update" }, { path: "../../etc/passwd", kind: "add" }], status: "completed" } },
			{ type: "item.started", item: { id: "x", type: "command_execution", command: "bash -lc 'ls'", aggregated_output: "", exit_code: null, status: "in_progress" } },
			{ type: "item.completed", item: { id: "x", type: "command_execution", command: "bash -lc 'ls'", aggregated_output: "a\n", exit_code: 0, status: "completed" } },
		]);
		expect(items.map((i) => [i.tool!.name, i.tool!.diff, i.tool!.files.map((f) => f.path)])).toEqual([["file_change", null, ["src/a.ts"]], ["command_execution", null, []]]);
	});
});
