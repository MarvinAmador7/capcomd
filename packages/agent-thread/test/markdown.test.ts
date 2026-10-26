// Markdown → blocks/1 golden cases, the sanitizer, and the caps (always at block boundaries).
import { describe, expect, test } from "bun:test";
import { CODE_MAX_LINES, ITEM_MAX_BYTES, MAX_DEPTH, sanitize, TABLE_MAX_COLS, TABLE_MAX_ROWS, toBlocks, type BlockNode } from "../src/index";

const b = (md: string): any[] => toBlocks(md, { root: "/w/repo" }).blocks;
const p = (...children: unknown[]): any => ({ t: "paragraph", children });
const tx = (text: string): any => ({ t: "text", text });

describe("blocks", () => {
	test("headings 1-3; deeper ones are 3", () => {
		expect(b("# a\n\n### c\n\n###### f")).toEqual([{ t: "heading", level: 1, children: [tx("a")] }, { t: "heading", level: 3, children: [tx("c")] }, { t: "heading", level: 3, children: [tx("f")] }]);
	});

	test("nested lists, ordered with a start, task items", () => {
		expect(b("3. one\n4. two\n   - inner\n     - deeper\n- [x] done\n- [ ] todo")).toEqual([
			{ t: "list", ordered: true, start: 3, items: [
				{ checked: null, blocks: [p(tx("one"))] },
				{ checked: null, blocks: [p(tx("two")), { t: "list", ordered: false, start: null, items: [{ checked: null, blocks: [p(tx("inner")), { t: "list", ordered: false, start: null, items: [{ checked: null, blocks: [p(tx("deeper"))] }] }] }] }] },
			] },
			{ t: "list", ordered: false, start: null, items: [{ checked: true, blocks: [p(tx("done"))] }, { checked: false, blocks: [p(tx("todo"))] }] },
		]);
	});

	test("fenced code keeps backticks inside, the language word, and newlines", () => {
		expect(b("````md\n```js\nx\n```\n````\n\n~~~\na\n\n  b\n~~~")).toEqual([
			{ t: "code", lang: "md", text: "```js\nx\n```", truncatedLines: null },
			{ t: "code", lang: null, text: "a\n\n  b", truncatedLines: null },
		]);
	});

	test("an unclosed fence runs to the end and is still one code block", () => {
		expect(b("text\n\n```py\nprint(1)\n")).toEqual([p(tx("text")), { t: "code", lang: "py", text: "print(1)", truncatedLines: null }]);
	});

	test("tables: header, rows, alignment, inline content", () => {
		expect(b("| a | `b` |\n|:-:|--|\n| **1** | |")).toEqual([{ t: "table", align: ["center", null], header: [[tx("a")], [{ t: "code", text: "b" }]], rows: [[[{ t: "strong", children: [tx("1")] }], []]], truncatedRows: null, truncatedCols: null }]);
	});

	test("inline: code, strong, em, strike, hard break; quote and rule", () => {
		expect(b("> **a** _b_ ~~c~~ `d`  \n> e\n\n***")).toEqual([
			{ t: "quote", blocks: [p({ t: "strong", children: [tx("a")] }, tx(" "), { t: "em", children: [tx("b")] }, tx(" "), { t: "strike", children: [tx("c")] }, tx(" "), { t: "code", text: "d" }, { t: "break" }, tx("e"))] },
			{ t: "rule" },
		]);
	});

	test("raw HTML is literal text, never markup", () => {
		expect(b("<div onclick=x>hi</div>\n\na <b>b</b> <img src=x onerror=alert(1)>")).toEqual([
			p(tx("<div onclick=x>hi</div>")),
			p(tx("a <b>b</b> <img src=x onerror=alert(1)>")),
		]);
	});

	test("reference links resolve through their definitions; unknown ones stay text", () => {
		expect(b("[docs][d] and [nope][x]\n\n[d]: https://docs.example.com")).toEqual([p(
			{ t: "link", text: "docs", href: "https://docs.example.com/", target: "web", host: "docs.example.com", id: null, path: null, mismatch: false },
			tx(" and [nope][x]"),
		)]);
	});

	test("images in a heading or a link become links, never inline media", () => {
		const [h] = b("# ![logo](https://x.example/l.png) Title");
		expect(h).toEqual({ t: "heading", level: 1, children: [{ t: "link", text: "logo", href: "https://x.example/l.png", target: "web", host: "x.example", id: null, path: null, mismatch: false }, tx(" Title")] });
	});

	test("unknown or exotic nodes become their plain text (footnotes)", () => {
		expect(b("a[^1]\n\n[^1]: the note")).toEqual([p(tx("a[1]")), p(tx("[1]")), p(tx("the note"))]);
	});
});

describe("sanitizer", () => {
	test("ANSI escapes, control and bidi characters out; CRLF to LF; NFC", () => {
		expect(sanitize("\u001b[31mred\u001b[0m\r\nnext\rline\u0007\u202egnp.exe\u0000 cafe\u0301")).toBe("red\nnext\nlinegnp.exe caf\u00e9");
		expect(b("\u001b]8;;https://evil\u0007click\u001b]8;;\u0007")).toEqual([p(tx("click"))]);
	});
	test("credentials in URLs are removed everywhere, code included", () => {
		expect(b("```\ngit clone https://x:ghs_secret@github.com/o/r\n```")).toEqual([{ t: "code", lang: null, text: "git clone https://github.com/o/r", truncatedLines: null }]);
	});
});

describe("caps", () => {
	test(`code over ${CODE_MAX_LINES} lines keeps the head and says how many were dropped`, () => {
		const lines = Array.from({ length: CODE_MAX_LINES + 25 }, (_, i) => `line ${i}`);
		const [c] = b(`\`\`\`\n${lines.join("\n")}\n\`\`\``) as any;
		expect(c.text.split("\n")).toEqual(lines.slice(0, CODE_MAX_LINES));
		expect(c.truncatedLines).toBe(25);
	});

	test(`tables over ${TABLE_MAX_ROWS} rows or ${TABLE_MAX_COLS} columns are cut with counts`, () => {
		const cols = TABLE_MAX_COLS + 2;
		const row = (i: number) => `| ${Array.from({ length: cols }, (_, j) => `${i}.${j}`).join(" | ")} |`;
		const md = [row(0), `|${" --- |".repeat(cols)}`, ...Array.from({ length: TABLE_MAX_ROWS + 7 }, (_, i) => row(i + 1))].join("\n");
		const [t] = b(md) as any;
		expect(t.header.length).toBe(TABLE_MAX_COLS);
		expect(t.align.length).toBe(TABLE_MAX_COLS);
		expect(t.rows.length).toBe(TABLE_MAX_ROWS);
		expect(t.rows.every((r: unknown[]) => r.length === TABLE_MAX_COLS)).toBe(true);
		expect([t.truncatedRows, t.truncatedCols]).toEqual([7, 2]);
	});

	test("over the item budget, whole trailing blocks are dropped: never a cut inside a fence", () => {
		const para = "x".repeat(1000);
		const md = Array.from({ length: 120 }, (_, i) => (i % 10 === 5 ? `\`\`\`\nfence ${i}\n${para}\n\`\`\`` : `${i} ${para}`)).join("\n\n");
		const r = toBlocks(md);
		expect(JSON.stringify(r.blocks).length).toBeLessThanOrEqual(ITEM_MAX_BYTES);
		expect(r.truncated!.blocks).toBe(120 - r.blocks.length);
		expect(r.truncated!.bytes).toBe(md.length);
		for (const c of r.blocks.filter((x) => x.t === "code") as any[]) expect(c.text).toMatch(/^fence \d+\nx{1000}$/);
		// The raw text stops at the same boundary.
		const lastKept = r.blocks.at(-1) as any;
		expect(r.text.endsWith(lastKept.t === "code" ? "```" : "x")).toBe(true);
		expect(r.text.length).toBeLessThan(md.length);
	});

	test("a single block over budget keeps what fits (code: whole lines)", () => {
		const r = toBlocks(`\`\`\`\n${Array.from({ length: 300 }, () => "y".repeat(400)).join("\n")}\n\`\`\``);
		const c = r.blocks[0] as any;
		expect(c.t).toBe("code");
		expect(c.text.split("\n").every((l: string) => l === "y".repeat(400))).toBe(true);
		expect(c.truncatedLines).toBeGreaterThan(0);
		expect(JSON.stringify(r.blocks).length).toBeLessThanOrEqual(ITEM_MAX_BYTES);
	});

	test(`lists nested deeper than ${MAX_DEPTH} become plain text`, () => {
		const md = Array.from({ length: MAX_DEPTH + 4 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n");
		let depth = 0;
		const walk = (bs: BlockNode[], d: number) => { for (const x of bs) if (x.t === "list") { depth = Math.max(depth, d + 1); x.items.forEach((i) => walk(i.blocks, d + 1)); } };
		walk(b(md), 0);
		expect(depth).toBeLessThanOrEqual(MAX_DEPTH);
		expect(JSON.stringify(b(md))).toContain(`level ${MAX_DEPTH + 3}`);
	});
});
