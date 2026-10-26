// Property tests: random and truncated markdown, cut at random points, always gives a valid blocks/1 tree within the
// caps, and never throws. Seeded, so a failure reproduces (the seed is in the message).
import { expect, test } from "bun:test";
import { Block, CODE_MAX_LINES, ITEM_MAX_BYTES, MAX_DEPTH, TABLE_MAX_COLS, TABLE_MAX_ROWS, toBlocks, threadBuilder, ThreadItem, type BlockNode } from "../src/index";

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

const PIECES = [
	"# ", "## ", "###### ", "- ", "* ", "1. ", "  - ", "    ", "> ", ">> ", "- [ ] ", "- [x] ", "```", "```ts", "~~~", "`", "**", "_", "~~", "\\", "|", "| a | b |\n|---|:-:|\n", "---", "***",
	"[", "]", "(", ")", "![", "<", ">", "<b>", "</b>", "<script>", "&amp;", "&#0;", "https://u:p@x.example/a.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "../../etc/passwd", "att-0123456789abcdef",
	"agt-1", "[^1]", "[^1]: n", "[ref]: https://r.example", "\n", "\n\n", "\r\n", "\t", "  \n", "\u001b[31m", "\u001b]8;;x\u0007", "\u202e", "\u0000", "e\u0301", "😀", "word", "x".repeat(300),
];

function randomMarkdown(r: () => number): string {
	const n = Math.floor(r() * 400);
	let s = "";
	for (let i = 0; i < n; i++) s += PIECES[Math.floor(r() * PIECES.length)];
	return s;
}

function check(blocks: BlockNode[], seed: number) {
	const r = Block.array().safeParse(blocks);
	if (!r.success) throw new Error(`seed ${seed}: invalid tree: ${r.error.message.slice(0, 500)}`);
	expect(JSON.stringify(blocks).length).toBeLessThanOrEqual(ITEM_MAX_BYTES);
	const walk = (bs: BlockNode[], depth: number) => {
		for (const b of bs) {
			if (b.t === "list" || b.t === "quote") expect(depth).toBeLessThan(MAX_DEPTH + 1);
			if (b.t === "code") expect(b.text.split("\n").length).toBeLessThanOrEqual(CODE_MAX_LINES);
			if (b.t === "table") { expect(b.rows.length).toBeLessThanOrEqual(TABLE_MAX_ROWS); expect(b.header.length).toBeLessThanOrEqual(TABLE_MAX_COLS); }
			if (b.t === "list") b.items.forEach((i) => walk(i.blocks, depth + 1));
			if (b.t === "quote") walk(b.blocks, depth + 1);
		}
	};
	walk(blocks, 0);
	const s = JSON.stringify(blocks);
	expect(s).not.toMatch(/[\u0000-\u0008\u001b\u202e]/);
	expect(s).not.toContain("u:p@");
	expect(s).not.toContain('"href":"javascript');
}

test("random markdown → a valid tree within caps", () => {
	for (let seed = 1; seed <= 400; seed++) {
		const r = rng(seed);
		const md = randomMarkdown(r);
		check(toBlocks(md, { root: "/w/repo" }).blocks, seed);
	}
});

test("truncated at random cut points (mid-fence, mid-table, mid-link, mid-character) → still valid", () => {
	const base = "## T\n\n| a | b |\n|---|---|\n| 1 | [x](https://x.example) |\n\n```js\nconst s = '```';\n```\n\n- [ ] item **bold _em\n\n> quote ![i](a.png) 😀 done";
	for (let cut = 0; cut <= base.length; cut++) check(toBlocks(base.slice(0, cut)).blocks, cut);
	const r = rng(7);
	for (let i = 0; i < 100; i++) { const md = randomMarkdown(r); const cut = Math.floor(r() * md.length); check(toBlocks(md.slice(0, cut)).blocks, 10_000 + i); }
});

test("huge input is bounded (parse cap) and still valid", () => {
	const md = Array.from({ length: 20_000 }, (_, i) => `- item ${i} with **bold** and \`code\``).join("\n");
	const t0 = performance.now();
	const p = toBlocks(md);
	expect(performance.now() - t0).toBeLessThan(5000);
	check(p.blocks, -1);
	expect(p.truncated).not.toBeNull();
});

test("random event streams → valid items, never a throw", () => {
	for (let seed = 1; seed <= 100; seed++) {
		const r = rng(seed);
		const b = threadBuilder({ cli: r() < 0.5 ? "claude" : "codex", idPrefix: "itm-f", now: () => 0 });
		const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
		for (let i = 0; i < 40; i++) {
			const id = `c${Math.floor(r() * 5)}`;
			const ev = pick<unknown>([
				{ type: "assistant", message: { id: `m${i}`, content: [{ type: pick(["text", "thinking", "tool_use", "redacted_thinking", "weird"]), text: randomMarkdown(r), thinking: randomMarkdown(r), id, name: pick(["Read", "Bash", "TodoWrite", "mcp__x__y"]), input: { file_path: "../x", command: randomMarkdown(r), todos: pick([[], [{ content: "a" }], "bad"]) } }] } },
				{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: r() < 0.3, content: pick([randomMarkdown(r), [{ type: "image", source: { type: "base64", data: "AAAA" } }], null]) }] } },
				{ type: "result", is_error: r() < 0.5, result: randomMarkdown(r) },
				{ type: pick(["item.started", "item.updated", "item.completed"]), item: { id, type: pick(["command_execution", "file_change", "agent_message", "reasoning", "todo_list", "error", "zzz"]), text: randomMarkdown(r), command: "x", items: pick([[{ text: "a", completed: true }], "bad"]), changes: pick([[{ path: "/w/repo/a", kind: "add" }], 7]) } },
				{ type: pick(["turn.failed", "error", "nope"]), message: randomMarkdown(r) },
			]);
			for (const d of b.event(ev)) {
				const v = ThreadItem.safeParse({ ...d, seq: 0, order: 0, agentId: "a" });
				if (!v.success) throw new Error(`seed ${seed}: ${v.error.message.slice(0, 400)}`);
			}
		}
	}
});
