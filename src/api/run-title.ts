// A run's title (harness.v1 Run.title): a short name for the work, so a list of runs reads as what each is about.
// The menu bar app ports these rules (apps/menubar/app/Sources/CapcomdStore/RunTitle.swift); both are checked against
// tests/fixtures/run-titles.json, so change the two together.

/** Titles aim to fit a list row: about a git subject line. Longer text is cut at a clause, else at a word, with "…". */
export const TITLE_MAX = 50;
/** A cut never leaves fewer characters than this (a clause boundary closer to the start is skipped); a cut at a comma
 *  or a conjunction keeps at least about half the room, or it drops too much ("In src/math.ts add"). */
const TITLE_MIN = 12, WEAK_MIN = 24;

/** Where the title came from, best first: the run's label (set by whoever started it, a person or a driving agent),
 *  the merged work's commit and pull request subject, the run's goal, its first agent's task. */
export const TITLE_SOURCES = ["label", "merge", "goal", "task"] as const;
export type TitleSource = (typeof TITLE_SOURCES)[number];

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const len = (s: string) => { let n = 0; for (const _ of graphemes.segment(s)) n++; return n; };
const take = (s: string, n: number) => { let out = ""; let i = 0; for (const g of graphemes.segment(s)) { if (i++ >= n) break; out += g.segment; } return out; };

// Clause boundaries, strongest first: a cut at a sentence end beats one at a dash, which beats one at a comma or "and".
// The first sentence is the title; within the weaker tiers, the longest clause that fits.
const TIERS: string[][] = [
	[". ", "! ", "? ", "; ", "。", "！", "？", "；"],
	[": ", " — ", " – ", " - ", "：", " ("],
	[", ", " and ", " then ", " so that ", " because ", " with ", " by ", " which ", "，", "、"],
];
const MARKER = /^(#{1,6}\s+|[-*+•]\s+|>\s*|[0-9]{1,3}[.)]\s+|\[[ x]\]\s+|\[agent:[^\]]*\]\s*)/i;
const POLITE = /^(please,?|pls,?|kindly|(can|could|would|will) you( please)?)\s+/i;
const TRAILING = /[\s.,;:!。、，；：]+$/;
const DANGLING = /\s+(a|an|the|and|or|to|of|for|with|in|on|at|by|from|into)$/i;

/** Brackets opened in `s` are all closed (a cut inside "multiply(a, b)" would leave half of it). */
function balanced(s: string): boolean {
	let depth = 0;
	for (const c of s) {
		if (c === "(" || c === "[" || c === "{") depth++;
		else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
	}
	return depth === 0;
}

/** One line of the text, cleaned: whitespace collapsed, list and heading markers, backticks, bold markers and a leading
 *  "please" / "can you" dropped, no trailing punctuation. */
function cleanLine(line: string): string {
	let s = line.replace(/\s+/g, " ").trim();
	for (let prev = ""; prev !== s;) { prev = s; s = s.replace(MARKER, "").trim(); }
	s = s.replaceAll("`", "").replaceAll("**", "").replace(/\s+/g, " ").trim();
	const polite = POLITE.exec(s);
	if (polite && polite[0].length < s.length) {
		s = s.slice(polite[0].length).replace(/\?+$/, "");
		s = s.charAt(0).toUpperCase() + s.slice(1);
	}
	return s.replace(TRAILING, "");
}

/**
 * A short title for a goal, label or task: its first line with text in it, cleaned, and when longer than TITLE_MAX
 * characters (graphemes) cut where a clause ends (no "…": the clause stands on its own), else at a word with "…",
 * else (text without spaces) at TITLE_MAX − 1 characters with "…". Null when there's no text.
 */
export function shortTitle(text: string | null | undefined): string | null {
	if (!text) return null;
	const s = text.split(/\r\n|[\n\v\f\r\u0085\u2028\u2029]/).map(cleanLine).find((l) => l.length > 0);
	if (!s) return null;
	if (len(s) <= TITLE_MAX) return s;
	for (const [i, tier] of TIERS.entries()) {
		let best: string | null = null;
		for (const sep of tier) {
			for (let at = s.indexOf(sep); at >= 0; at = s.indexOf(sep, at + 1)) {
				const head = s.slice(0, at).replace(TRAILING, "");
				const n = len(head);
				if (n > TITLE_MAX) break;
				if (n < (i === 2 ? WEAK_MIN : TITLE_MIN) || !balanced(head)) continue;
				if (best === null || (i === 0 ? n < len(best) : n > len(best))) best = head;
				if (i === 0) break;
			}
		}
		if (best) return best;
	}
	const cut = take(s, TITLE_MAX - 1);
	const space = cut.lastIndexOf(" ");
	if (space > 0 && len(cut.slice(0, space)) >= TITLE_MIN) {
		let head = cut.slice(0, space);
		for (let prev = ""; prev !== head;) { prev = head; head = head.replace(DANGLING, "").replace(/[\s,;:(\-—–]+$/, ""); }
		return `${head}…`;
	}
	return `${cut.trimEnd()}…`;
}

export interface TitleAgent { parent: string | null; task: string | null | undefined; result?: unknown }

/**
 * The run's title and where it came from (see TITLE_SOURCES). A label that only repeats the goal (`capcomd run <goal>`
 * labels the run with it) isn't a name of its own. The merged work names the run only when exactly one agent's work
 * merged: with several, any one of them names only part of it. `agents` in spawn order.
 */
export function runTitle(r: { label: string | null; goal: string | null; agents?: TitleAgent[] }): { title: string | null; titleSource: TitleSource | null } {
	const goal = shortTitle(r.goal);
	const label = shortTitle(r.label);
	if (label && label !== goal) return { title: label, titleSource: "label" };
	const merged = (r.agents ?? []).filter((a) => (a.result as { merge?: { state?: unknown } } | null | undefined)?.merge?.state === "merged");
	const subject = merged.length === 1 ? shortTitle(merged[0]!.task) : null;
	if (subject) return { title: subject, titleSource: "merge" };
	if (goal) return { title: goal, titleSource: "goal" };
	const task = shortTitle((r.agents ?? []).find((a) => a.parent === null)?.task);
	return task ? { title: task, titleSource: "task" } : { title: null, titleSource: null };
}
