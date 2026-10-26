// Agent markdown → blocks/1, parsed once (at write time) with micromark's CommonMark + GFM parser (mdast). The result
// is a small, closed tree: no HTML (raw HTML is literal text), no link a client follows without the daemon's say-so
// (links.ts), images as media blocks or plain links. Caps apply at block boundaries only: a code block keeps its first
// lines, a table its first rows and columns, and an item over budget drops whole trailing blocks.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { BlockNode, InlineNode, LinkNode, MediaBlock } from "./schema";
import { classifyLink, mediaOfPath, resolveMedia, type LinkContext } from "./links";
import { capBytes, sanitize, utf8Bytes } from "./sanitize";

/** Per-item budget for blocks (as JSON) and for the raw text: 64 KB, the daemon's inline text cap. */
export const ITEM_MAX_BYTES = 64 * 1024;
/** Text past this is not parsed at all (an item keeps at most ITEM_MAX_BYTES of it anyway). */
export const PARSE_MAX_BYTES = 256 * 1024;
export const CODE_MAX_LINES = 400;
export const TABLE_MAX_ROWS = 50;
export const TABLE_MAX_COLS = 8;
/** Lists and quotes nested deeper than this become their plain text. */
export const MAX_DEPTH = 8;

export type Parsed = { blocks: BlockNode[]; text: string; truncated: { blocks: number; bytes: number } | null };

type Node = { type: string; children?: Node[]; value?: string; url?: string; alt?: string | null; depth?: number; ordered?: boolean | null; start?: number | null;
	checked?: boolean | null; lang?: string | null; align?: Array<string | null> | null; identifier?: string; label?: string | null; position?: { start: { offset?: number }; end: { offset?: number } } };

/** The plain text of any node (unknown types included). */
function plain(n: Node): string {
	if (n.type === "image") return n.alt ?? "";
	if (n.type === "break") return "\n";
	if (typeof n.value === "string") return n.value;
	return (n.children ?? []).map(plain).join(n.type === "paragraph" || n.type === "root" || n.type === "listItem" ? "\n" : "");
}

const textNode = (text: string): InlineNode => ({ t: "text", text });
/** Adjacent text runs merged; empty ones dropped. */
function tidy(xs: InlineNode[]): InlineNode[] {
	const out: InlineNode[] = [];
	for (const x of xs) {
		const prev = out.at(-1);
		if (x.t === "text") { if (!x.text) continue; if (prev?.t === "text") { prev.text += x.text; continue; } }
		out.push(x);
	}
	return out;
}

export function toBlocks(markdown: string, ctx: LinkContext = {}): Parsed {
	const originalBytes = utf8Bytes(markdown);
	const src = sanitize(originalBytes > PARSE_MAX_BYTES ? capBytes(markdown, PARSE_MAX_BYTES) : markdown);
	let tree: Node;
	try { tree = fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as Node; }
	catch { tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: src }] }] }; }

	// Reference-style links and images resolve through their definitions.
	const defs = new Map<string, string>();
	const collect = (n: Node) => { if (n.type === "definition" && n.identifier && typeof n.url === "string" && !defs.has(n.identifier)) defs.set(n.identifier, n.url); n.children?.forEach(collect); };
	collect(tree);
	const urlOf = (n: Node) => (n.type === "link" || n.type === "image" ? n.url ?? "" : defs.get(n.identifier ?? "") ?? null);

	const inline = (n: Node, depth: number): InlineNode[] => {
		switch (n.type) {
			case "text": return [textNode(n.value ?? "")];
			case "inlineCode": return [{ t: "code", text: n.value ?? "" }];
			case "break": return [{ t: "break" }];
			case "html": return [textNode(n.value ?? "")];
			case "strong": case "emphasis": case "delete": {
				const kids = inlines(n.children ?? [], depth + 1);
				if (depth >= MAX_DEPTH) return kids;
				return [{ t: n.type === "strong" ? "strong" : n.type === "emphasis" ? "em" : "strike", children: kids }];
			}
			case "link": case "linkReference": {
				const url = urlOf(n);
				const text = plain(n);
				if (url === null) return [textNode(text)];
				return [classifyLink(url, text, ctx)];
			}
			case "image": case "imageReference": {
				// Not at a paragraph's top level (in a link, a heading, a table cell): a link, never inline media.
				const url = urlOf(n);
				const alt = n.alt ?? "";
				if (url === null) return [textNode(alt)];
				const m = resolveMedia(url, alt, ctx);
				return [m.t === "media" ? classifyLink(url, alt || url, ctx) : m];
			}
			case "footnoteReference": return [textNode(`[${n.label ?? n.identifier ?? ""}]`)];
			default: return [textNode(plain(n))];
		}
	};
	const inlines = (ns: Node[], depth: number) => tidy(ns.flatMap((n) => inline(n, depth)));

	/** A paragraph, split around its top-level images (media blocks); a paragraph that is only a media link is media. */
	const paragraph = (n: Node): BlockNode[] => {
		const kids = n.children ?? [];
		const meaningful = kids.filter((k) => !(k.type === "text" && !(k.value ?? "").trim()));
		if (meaningful.length === 1 && (meaningful[0]!.type === "link" || meaningful[0]!.type === "linkReference")) {
			const url = urlOf(meaningful[0]!);
			if (url && mediaOfPath(url)) {
				const m = resolveMedia(url, plain(meaningful[0]!), ctx);
				if (m.t === "media") return [m];
			}
		}
		const out: BlockNode[] = [];
		let run: Node[] = [];
		const flush = () => {
			const c = inlines(run, 0);
			run = [];
			// Split around media: the pieces lose the spaces that separated them from it.
			const first = c[0], last = c.at(-1);
			if (first?.t === "text") first.text = first.text.trimStart();
			if (last?.t === "text") last.text = last.text.trimEnd();
			const kept = c.filter((x) => x.t !== "text" || x.text);
			if (kept.length) out.push({ t: "paragraph", children: kept });
		};
		for (const k of kids) {
			if (k.type === "image" || k.type === "imageReference") {
				const url = urlOf(k);
				const m = url === null ? null : resolveMedia(url, k.alt ?? "", ctx);
				if (m?.t === "media") { flush(); out.push(m); continue; }
			}
			run.push(k);
		}
		flush();
		return out;
	};

	const asText = (n: Node): BlockNode[] => { const t = plain(n).trim(); return t ? [{ t: "paragraph", children: [textNode(t)] }] : []; };

	const block = (n: Node, depth: number): BlockNode[] => {
		switch (n.type) {
			case "paragraph": return paragraph(n);
			case "heading": return [{ t: "heading", level: Math.min(3, Math.max(1, n.depth ?? 1)) as 1 | 2 | 3, children: inlines(n.children ?? [], 0) }];
			case "thematicBreak": return [{ t: "rule" }];
			case "code": {
				const lines = (n.value ?? "").split("\n");
				const cut = lines.length > CODE_MAX_LINES ? lines.length - CODE_MAX_LINES : 0;
				const lang = (n.lang ?? "").trim().split(/\s/)[0]?.slice(0, 40) || null;
				return [{ t: "code", lang, text: (cut ? lines.slice(0, CODE_MAX_LINES) : lines).join("\n"), truncatedLines: cut || null }];
			}
			case "blockquote":
				if (depth >= MAX_DEPTH) return asText(n);
				return [{ t: "quote", blocks: blocks(n.children ?? [], depth + 1) }];
			case "list":
				if (depth >= MAX_DEPTH) return asText(n);
				return [{
					t: "list", ordered: !!n.ordered, start: n.ordered ? (n.start ?? 1) : null,
					items: (n.children ?? []).map((li) => ({ checked: typeof li.checked === "boolean" ? li.checked : null, blocks: blocks(li.children ?? [], depth + 1) })),
				}];
			case "table": {
				const rows = (n.children ?? []).map((r) => (r.children ?? []).map((c) => inlines(c.children ?? [], 0)));
				const header = rows[0] ?? [];
				const body = rows.slice(1);
				const cols = Math.max(header.length, ...body.map((r) => r.length), 0);
				const keepCols = Math.min(cols, TABLE_MAX_COLS);
				const fit = (r: InlineNode[][]) => Array.from({ length: keepCols }, (_, i) => r[i] ?? []);
				return [{
					t: "table", align: Array.from({ length: keepCols }, (_, i) => { const a = n.align?.[i]; return a === "left" || a === "center" || a === "right" ? a : null; }),
					header: fit(header), rows: body.slice(0, TABLE_MAX_ROWS).map(fit),
					truncatedRows: body.length > TABLE_MAX_ROWS ? body.length - TABLE_MAX_ROWS : null, truncatedCols: cols > TABLE_MAX_COLS ? cols - TABLE_MAX_COLS : null,
				}];
			}
			case "html": { const t = (n.value ?? "").trim(); return t ? [{ t: "paragraph", children: [textNode(t)] }] : []; }
			case "definition": return [];
			case "footnoteDefinition": return [{ t: "paragraph", children: [textNode(`[${n.label ?? n.identifier ?? ""}]`)] }, ...blocks(n.children ?? [], depth + 1)];
			default: return asText(n);
		}
	};
	const blocks = (ns: Node[], depth: number): BlockNode[] => ns.flatMap((n) => block(n, depth));

	// Top-level blocks, each with the end of its source (for the raw text kept at the same boundary).
	const top = (tree.children ?? []).flatMap((n) => block(n, 0).map((b) => ({ b, end: n.position?.end.offset ?? src.length })));
	const kept: BlockNode[] = [];
	let used = 2, end = 0;
	for (const { b, end: e } of top) {
		const size = utf8Bytes(JSON.stringify(b)) + 1;
		if (used + size > ITEM_MAX_BYTES) {
			if (!kept.length) { const s = shrink(b, ITEM_MAX_BYTES - used); if (s) { kept.push(s); end = e; } }
			break;
		}
		kept.push(b); used += size; end = e;
	}
	const dropped = top.length - kept.length;
	const cutSource = originalBytes > PARSE_MAX_BYTES;
	const raw = dropped ? src.slice(0, end) : src;
	const text = capBytes(raw, ITEM_MAX_BYTES);
	const truncated = dropped || cutSource || text.length < raw.length ? { blocks: dropped, bytes: originalBytes } : null;
	return { blocks: kept, text, truncated };
}

/** The first block alone is over budget: a code block keeps fewer lines, a table fewer rows, anything else its plain text. */
function shrink(b: BlockNode, max: number): BlockNode | null {
	const fits = (x: BlockNode) => utf8Bytes(JSON.stringify(x)) <= max;
	if (b.t === "code") {
		const lines = b.text.split("\n");
		let n = lines.length;
		while (n > 1) {
			n = Math.floor(n / 2);
			const c: BlockNode = { ...b, text: lines.slice(0, n).join("\n"), truncatedLines: (b.truncatedLines ?? 0) + lines.length - n };
			if (fits(c)) return c;
		}
	}
	if (b.t === "table") {
		for (let n = Math.floor(b.rows.length / 2); n >= 1; n = Math.floor(n / 2)) {
			const c: BlockNode = { ...b, rows: b.rows.slice(0, n), truncatedRows: (b.truncatedRows ?? 0) + b.rows.length - n };
			if (fits(c)) return c;
		}
	}
	const text = capBytes(blockText(b), Math.max(0, max - 64));
	const p: BlockNode = { t: "paragraph", children: [{ t: "text", text }] };
	return text && fits(p) ? p : null;
}

/** A block's plain text. */
export function blockText(b: BlockNode): string {
	const il = (xs: InlineNode[]): string => xs.map((x) => (x.t === "break" ? "\n" : "children" in x ? il(x.children) : x.text)).join("");
	switch (b.t) {
		case "paragraph": case "heading": return il(b.children);
		case "code": case "open": return b.text;
		case "list": return b.items.map((i) => i.blocks.map(blockText).join("\n")).join("\n");
		case "quote": return b.blocks.map(blockText).join("\n");
		case "table": return [b.header, ...b.rows].map((r) => r.map(il).join(" | ")).join("\n");
		case "media": return b.alt;
		case "rule": return "";
	}
}

/** A plain-text paragraph (no markdown parsing): for errors, summaries, tool output. */
export const plainBlocks = (text: string): BlockNode[] => (text.trim() ? [{ t: "paragraph", children: [{ t: "text", text }] }] : []);
export type { LinkNode, MediaBlock };
