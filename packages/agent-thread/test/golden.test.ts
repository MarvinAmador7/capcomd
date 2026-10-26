// The golden contract: fixtures/sessions/*.jsonl → fixtures/golden/*.items.json, checked in for other languages'
// decoders. Stale files fail here (refresh: bun packages/agent-thread/scripts/golden.ts), every item is a valid
// ThreadItem, and the set stays representative: every block and inline type, media source and link target.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Block, LINK_TARGETS, ThreadItem, threadItemJsonSchema, type BlockNode, type InlineNode } from "../src/index";
import { goldenOf } from "./golden-lib";

const dir = join(import.meta.dir, "..", "fixtures");
const sessions = readdirSync(join(dir, "sessions")).filter((f) => f.endsWith(".jsonl")).sort();
const goldens = sessions.map((f) => ({ f, want: readFileSync(join(dir, "golden", f.replace(/\.jsonl$/, ".items.json")), "utf8"), got: goldenOf(f, readFileSync(join(dir, "sessions", f), "utf8")) }));

describe("golden items", () => {
	test("every session has an up-to-date golden file", () => {
		expect(sessions.length).toBeGreaterThanOrEqual(4);
		for (const g of goldens) expect([g.f, `${JSON.stringify(g.got, null, 2)}\n`]).toEqual([g.f, g.want]);
	});

	test("every item revision is a valid ThreadItem once stored", () => {
		for (const g of goldens) for (const u of g.got.updates) {
			const r = ThreadItem.safeParse({ ...u, seq: 1, order: 1, agentId: "agt-golden" });
			if (!r.success) throw new Error(`${g.f} ${u.id} rev ${u.rev}: ${r.error.message}`);
		}
	});

	test("they cover every block and inline type, media source, link target, and open → done tools", () => {
		const blocks = new Set<string>(), inlines = new Set<string>(), sources = new Set<string>(), targets = new Set<string>(), kinds = new Set<string>();
		const il = (x: InlineNode) => { inlines.add(x.t); if (x.t === "link") targets.add(x.target); if ("children" in x) x.children.forEach(il); };
		const bl = (b: BlockNode) => {
			blocks.add(b.t);
			if (b.t === "paragraph" || b.t === "heading") b.children.forEach(il);
			if (b.t === "list") b.items.forEach((i) => i.blocks.forEach(bl));
			if (b.t === "quote") b.blocks.forEach(bl);
			if (b.t === "table") [b.header, ...b.rows].forEach((r) => r.forEach((c) => c.forEach(il)));
			if (b.t === "media") sources.add(b.source.type);
		};
		let open = 0, doneAfterOpen = 0;
		for (const g of goldens) for (const u of g.got.updates) {
			kinds.add(u.kind); u.blocks.forEach(bl); u.tool?.files.forEach(il);
			if (u.kind === "tool" && u.status === "open") open++;
			if (u.kind === "tool" && u.status === "done" && u.rev > 1) doneAfterOpen++;
		}
		expect([...blocks].sort()).toEqual(["code", "heading", "list", "media", "paragraph", "quote", "rule", "table"]);
		expect([...inlines].sort()).toEqual(["break", "code", "em", "link", "strike", "strong", "text"]);
		expect([...sources].sort()).toEqual(["attachment", "inline", "remote", "workspace"]);
		expect([...targets].sort()).toEqual([...LINK_TARGETS].sort());
		for (const k of ["say", "thinking", "tool", "error", "result", "plan", "other"]) expect(kinds).toContain(k);
		expect(open).toBeGreaterThan(0);
		expect(doneAfterOpen).toBeGreaterThan(0);
		// tool.diff: an edit (context, removed and added lines) and a created file, and tools without one.
		const ops = new Set<string>(), diffs = goldens.flatMap((g) => g.got.updates.flatMap((u) => (u.tool?.diff ? [u.tool.diff] : [])));
		diffs.forEach((d) => d.lines.forEach((l) => ops.add(l.op)));
		expect([...ops].sort()).toEqual([" ", "+", "-"]);
		expect(diffs.some((d) => d.removed === 0 && d.added > 0)).toBe(true);
		expect(goldens.some((g) => g.got.updates.some((u) => u.tool && u.tool.diff === null))).toBe(true);
	});

	test("the JSON Schema is exported and names blocks/1", () => {
		const s = JSON.stringify(threadItemJsonSchema());
		expect(s).toContain("blocks/1");
		expect(s).toContain("x-untrusted");
		expect(Block.safeParse({ t: "open", text: "partial" }).success).toBe(true);
	});
});
