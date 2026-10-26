// A file-editing tool call's change as a small line diff (tool.diff), built only from what the CLI event carries:
// Claude Code's Edit / MultiEdit / Write / NotebookEdit input when the call starts, then the result's structuredPatch
// (real context lines and line numbers) when it returns. Nothing is read from disk, and no file contents are invented:
// context lines are only lines the event itself contains. Codex `exec --json` file_change items carry paths and kinds,
// no lines, so they get no diff (their files are in tool.files).
import { workspacePath } from "./links";
import { sanitize } from "./sanitize";
import { DIFF_LINE_MAX_CHARS, DIFF_MAX_LINES, type DiffLine, type ToolDiffT } from "./schema";
/** Above this many lines on either side, a change is shown as all removed then all added (no line matching). */
const LCS_MAX_LINES = 400;

const str = (x: unknown) => (typeof x === "string" ? x : "");

/** Text → its lines, without the empty one a trailing newline leaves. */
export function linesOf(s: string): string[] {
	if (!s) return [];
	const l = s.replace(/\r\n?/g, "\n").split("\n");
	if (l[l.length - 1] === "") l.pop();
	return l;
}

/** Line diff of a → b: shared leading / trailing lines as context, the middle matched by LCS when it is small. */
export function lineDiff(a: string[], b: string[]): DiffLine[] {
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf);
	const mid: DiffLine[] = [];
	if (am.length && bm.length && am.length <= LCS_MAX_LINES && bm.length <= LCS_MAX_LINES) {
		// dp[i][j]: LCS length of am[i..], bm[j..].
		const w = bm.length + 1;
		const dp = new Uint16Array((am.length + 1) * w);
		for (let i = am.length - 1; i >= 0; i--) for (let j = bm.length - 1; j >= 0; j--)
			dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
		let i = 0, j = 0;
		while (i < am.length && j < bm.length) {
			if (am[i] === bm[j]) { mid.push({ op: " ", text: am[i]! }); i++; j++; }
			else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) mid.push({ op: "-", text: am[i++]! });
			else mid.push({ op: "+", text: bm[j++]! });
		}
		while (i < am.length) mid.push({ op: "-", text: am[i++]! });
		while (j < bm.length) mid.push({ op: "+", text: bm[j++]! });
	} else {
		for (const t of am) mid.push({ op: "-", text: t });
		for (const t of bm) mid.push({ op: "+", text: t });
	}
	return [...a.slice(0, pre).map((text) => ({ op: " " as const, text })), ...mid, ...b.slice(b.length - suf).map((text) => ({ op: " " as const, text }))];
}

const cut = (s: string) => {
	const t = sanitize(s);
	if (t.length <= DIFF_LINE_MAX_CHARS) return t;
	let end = DIFF_LINE_MAX_CHARS - 1;
	const c = t.charCodeAt(end - 1);
	if (c >= 0xd800 && c <= 0xdbff) end--; // never split a surrogate pair
	return `${t.slice(0, end)}…`;
};

/**
 * Hunks (each a run of lines; a separator goes between them) → the bounded diff: `added` / `removed` over every line,
 * at most DIFF_MAX_LINES lines kept, each cut to DIFF_LINE_MAX_CHARS. null when nothing changed.
 */
export function boundedDiff(rawPath: unknown, hunks: Array<{ header: string | null; lines: DiffLine[] }>, root?: string | null): ToolDiffT | null {
	let added = 0, removed = 0, total = 0;
	const lines: DiffLine[] = [];
	for (const [k, h] of hunks.entries()) {
		if (!h.lines.length) continue;
		if (k > 0 && lines.length && lines.length < DIFF_MAX_LINES) lines.push({ op: "@", text: h.header ? cut(h.header) : "" });
		for (const l of h.lines) {
			if (l.op === "+") added++; else if (l.op === "-") removed++;
			total++;
			if (lines.length < DIFF_MAX_LINES) lines.push({ op: l.op, text: cut(l.text) });
		}
	}
	if (!added && !removed) return null;
	// A separator with nothing after it says nothing.
	while (lines.length && lines[lines.length - 1]!.op === "@") lines.pop();
	const shown = lines.filter((l) => l.op !== "@").length;
	const p = str(rawPath);
	return { path: p ? workspacePath(p, root) : null, added, removed, lines, truncatedLines: total > shown ? total - shown : null };
}

/** old_string → new_string as one hunk (context: the lines the two share at their ends). */
const editHunk = (e: any) => ({ header: null, lines: lineDiff(linesOf(str(e?.old_string)), linesOf(str(e?.new_string))) });

/** The diff a Claude Code tool call's input describes, before it runs; null for other tools. */
export function claudeInputDiff(name: string, input: Record<string, any>, root?: string | null): ToolDiffT | null {
	switch (name) {
		case "Edit": return boundedDiff(input.file_path, [editHunk(input)], root);
		case "MultiEdit": return Array.isArray(input.edits) ? boundedDiff(input.file_path, input.edits.map(editHunk), root) : null;
		// Before the result we don't know whether it replaced a file: the content as added lines (the result corrects it).
		case "Write": return boundedDiff(input.file_path, [{ header: null, lines: linesOf(str(input.content)).map((text) => ({ op: "+" as const, text })) }], root);
		// Only an inserted cell is knowable from the input (a replace doesn't carry the old source).
		case "NotebookEdit": return input.edit_mode === "insert"
			? boundedDiff(input.notebook_path, [{ header: null, lines: linesOf(str(input.new_source)).map((text) => ({ op: "+" as const, text })) }], root)
			: null;
	}
	return null;
}

/**
 * The diff a Claude Code tool result reports (`tool_use_result`): its structuredPatch hunks (lines prefixed " ", "+",
 * "-"; "\ No newline" markers skipped), or a created file's content. undefined when it reports none (keep the input's).
 */
export function claudeResultDiff(r: any, fallbackPath: unknown, root?: string | null): ToolDiffT | null | undefined {
	if (!r || typeof r !== "object") return undefined;
	const path = str(r.filePath) || fallbackPath;
	if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) {
		const hunks = r.structuredPatch.map((h: any) => ({
			header: [h?.oldStart, h?.oldLines, h?.newStart, h?.newLines].every((x) => Number.isInteger(x)) ? `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` : null,
			lines: (Array.isArray(h?.lines) ? h.lines : []).flatMap((l: unknown): DiffLine[] => {
				const s = str(l), op = s[0];
				return op === " " || op === "+" || op === "-" ? [{ op, text: s.slice(1) }] : [];
			}),
		}));
		return boundedDiff(path, hunks, root);
	}
	if (r.type === "create" && typeof r.content === "string")
		return boundedDiff(path, [{ header: null, lines: linesOf(r.content).map((text) => ({ op: "+" as const, text })) }], root);
	// A file rewritten with what it already held: an empty patch, no change.
	if (r.type === "update" && Array.isArray(r.structuredPatch)) return null;
	return undefined;
}
