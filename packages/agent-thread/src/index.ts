// @capcomd/agent-thread: agent CLI streams → thread items with a sanitized blocks/1 tree. Pure functions: storing
// images and knowing the workspace are the caller's (injected through ThreadOptions / LinkContext).
export * from "./schema";
export { sanitize, oneLine, capBytes } from "./sanitize";
export { toBlocks, blockText, plainBlocks, ITEM_MAX_BYTES, PARSE_MAX_BYTES, CODE_MAX_LINES, TABLE_MAX_ROWS, TABLE_MAX_COLS, MAX_DEPTH, type Parsed } from "./markdown";
export { classifyLink, resolveMedia, workspacePath, webUrl, hostInText, mediaOfPath, type LinkContext } from "./links";
export { checkImage, sniffImage, imageSize, IMAGE_MAX_BYTES, IMAGE_TYPES, type StoredImage } from "./images";
export { claudeInputDiff, claudeResultDiff, lineDiff } from "./diff";
export { threadBuilder, ARGS_MAX_BYTES, OUTPUT_MAX_BYTES, type ThreadOptions, type ThreadBuilder, type Cli } from "./thread";
export { ACTIVITY_KINDS, commandKind, opKind, claudeToolKind, codexItemKind, fxToolKind, type ActivityKind } from "./kinds";
export { claudeSummary, codexSummary, fxSummary, shellCommand } from "./summary";
export { BOOKKEEPING_CALLS, BOOKKEEPING_SYSTEM, isBookkeepingCommand, isBookkeepingTool } from "./bookkeeping";
export { claudeNaming, codexNaming, fxNaming, isClaudeNamingCall, isCodexNamingCall, isFxNamingCall, namingCalls, namingCommand, shellWords } from "./naming";

import { classifyLink, mediaOfPath, resolveMedia, type LinkContext } from "./links";
import { plainBlocks, toBlocks } from "./markdown";
import { capBytes, oneLine, sanitize } from "./sanitize";
import { CHECK_RESULTS, FINDING_SEVERITIES, HANDBACK_STATUSES, THREAD_FORMAT, type BlockNode, type FindingT, type HandbackT, type ItemDraft, type ThreadQuestionT } from "./schema";

/**
 * A child agent handing back (agent.done / agent.failed): its summary as blocks, then its artifacts ({name, ref}) as
 * media blocks (images, video, audio it points at) and a list of links (files, attachments, web pages, agents).
 */
export function handoffDraft(o: { id: string; at: number; child: { agentId: string; status: string }; summary: string; verdict?: HandoffVerdict | null; handback?: unknown; artifacts?: Array<{ name: string; ref: string }>; link?: LinkContext }): ItemDraft {
	const findings = o.verdict?.findings ? cleanFindings(o.verdict.findings) : null;
	const v = o.verdict ? { passed: o.verdict.passed, reasons: o.verdict.reasons.map((r) => sanitize(r).trim()).filter(Boolean).slice(0, VERDICT_MAX_REASONS).map((r) => capBytes(r, VERDICT_REASON_MAX_BYTES)), ...(findings ? { findings } : {}) } : null;
	const handback = o.handback === undefined || o.handback === null ? null : cleanHandback(o.handback);
	// A reviewer's verdict leads, in words a client that doesn't read child.verdict still shows; then its summary, if it
	// wrote one, and its reasons as a list.
	const said = v ? (v.passed ? "Passed review" : "Didn't pass review") : null;
	const p = toBlocks([said ? `**${said}**` : "", o.summary, ...(v?.reasons.length ? [v.reasons.map((r) => `- ${oneLine(r, VERDICT_REASON_MAX_BYTES)}`).join("\n")] : [])].filter((x) => x.trim()).join("\n\n"), o.link);
	const media: BlockNode[] = [], links: BlockNode[] = [];
	for (const a of o.artifacts ?? []) {
		// Media only when it evidently is (a media file name, or an attachment the daemon knows is one): else a link chip.
		const l = classifyLink(a.ref, a.name || a.ref, o.link);
		const known = l.target === "artifact" ? o.link?.attachment?.(l.id!) : null;
		const looksMedia = !!mediaOfPath(a.ref) || !!(known && /^(image|video|audio)\//.test(known.mime));
		const m = looksMedia ? resolveMedia(a.ref, a.name, o.link) : null;
		if (m?.t === "media" && m.kind !== "file") media.push(m);
		else links.push({ t: "paragraph", children: [classifyLink(a.ref, a.name || a.ref, o.link)] });
	}
	const extra: BlockNode[] = [...media, ...(links.length ? [{ t: "list", ordered: false, start: null, items: links.map((b) => ({ checked: null, blocks: [b] })) } as BlockNode] : [])];
	return {
		id: o.id, rev: 1, kind: "handoff", status: "done", at: new Date(o.at).toISOString(), durationMs: null, text: p.text, blocks: [...p.blocks, ...extra], format: THREAD_FORMAT,
		redacted: false, tool: null, error: null, truncated: p.truncated, child: { ...o.child, ...(v ? { verdict: v } : {}), ...(handback ? { handback } : {}) },
	};
}

const text = (x: unknown, max: number): string => capBytes(sanitize(typeof x === "string" ? x : "").trim(), max);
const textOrNull = (x: unknown, max: number): string | null => { const t = text(x, max); return t ? t : null; };
const listOf = (x: unknown, max: number): unknown[] => (Array.isArray(x) ? x.slice(0, max) : []);
const oneOf = <T extends string>(x: unknown, all: readonly T[]): T | null => (all.includes(x as T) ? (x as T) : null);

/**
 * A typed hand-back (handback@1, validated by the daemon's registry when the child sent it) in the thread item's shape:
 * every field present (absent lists empty, absent notes null), strings sanitized and capped. null when it isn't one.
 */
export function cleanHandback(h: unknown): HandbackT | null {
	const o = h && typeof h === "object" ? (h as Record<string, unknown>) : null;
	const status = oneOf(o?.status, HANDBACK_STATUSES), outcome = text(o?.outcome, 1000);
	if (!o || !status || !outcome) return null;
	return {
		status, outcome,
		changed: listOf(o.changed, 50).flatMap((c: any) => { const path = text(c?.path, 1000); return path ? [{ path, what: textOrNull(c?.what, 1000) }] : []; }),
		checked: listOf(o.checked, 20).flatMap((c: any) => { const check = text(c?.check, 1000), result = oneOf(c?.result, CHECK_RESULTS); return check && result ? [{ check, result, note: textOrNull(c?.note, 1000) }] : []; }),
		risks: listOf(o.risks, 10).map((r) => text(r, 1000)).filter(Boolean),
		decide: listOf(o.decide, 10).map((r) => text(r, 1000)).filter(Boolean),
	};
}

/** review-verdict@1's findings in the thread item's shape (VERDICT_MAX_REASONS at most). */
export function cleanFindings(fs: unknown): FindingT[] {
	return listOf(fs, VERDICT_MAX_REASONS).flatMap((f: any) => {
		const t = text(typeof f === "string" ? f : f?.text, VERDICT_REASON_MAX_BYTES);
		if (!t) return [];
		const line = Number(f?.line);
		return [{ text: t, severity: oneOf(f?.severity, FINDING_SEVERITIES), file: textOrNull(f?.file, 1000), line: Number.isInteger(line) && line > 0 ? line : null }];
	});
}

/**
 * A quiet daemon-written line in an agent's thread (kind `note`, ADR-026): "model → opus · effort high", "Picked up from
 * the thread: the earlier session couldn't be resumed." Plain text the daemon wrote (trusted), one line; a client shows
 * it as a muted divider, and one that doesn't know the kind as a plain line.
 */
export function threadNote(o: { id: string; at: number; text: string; internal?: boolean }): ItemDraft {
	const text = oneLine(o.text, 500);
	// `internal`: a line about the daemon's own bookkeeping (src/bookkeeping.ts): recorded, hidden by default.
	return { id: o.id, rev: 1, kind: "note", status: "done", at: new Date(o.at).toISOString(), durationMs: null, text, blocks: plainBlocks(text), format: THREAD_FORMAT,
		redacted: false, tool: null, error: null, truncated: null, child: null, ...(o.internal ? { internal: true } : {}) } as ItemDraft;
}

/**
 * A question and what became of it (kind `question`, capability agents.ask, ADR-026 §4): the thread's record of it, so
 * a client rebuilds its card (open) or its one-line record (answered, withdrawn) from the thread alone, and a
 * conversation rebuilt from the thread keeps the decision. `text` says it in one line for clients that don't read
 * `question` ("Asked: … · answered: … (not the recommendation) · note: …"). Its strings are someone's words, cleaned.
 */
export function questionDraft(o: { id: string; rev: number; at: number; question: ThreadQuestionT }): ItemDraft {
	const q = o.question, c = (x: string | null, max: number) => (x == null ? null : oneLine(x, max) || null);
	const question: ThreadQuestionT = {
		...q, question: oneLine(q.question, 500), options: q.options.map((x) => ({ label: oneLine(x.label, 200), recommended: x.recommended })),
		why: c(q.why, 600), holds: c(q.holds, 300), answer: c(q.answer, 2000), note: c(q.note, 2000),
	};
	const rec = question.options.find((x) => x.recommended)?.label;
	const outcome = question.state === "answered"
		? `answered: ${question.answer ?? ""}${question.recommended === false ? " (not the recommendation)" : ""}${question.note ? ` · note: ${question.note}` : ""}`
		: question.state === "withdrawn" ? "withdrawn: its agent was cancelled" : rec ? `recommended: ${rec}` : "";
	const text = oneLine([`Asked: ${question.question}`, outcome].filter(Boolean).join(" · "), 4000);
	return { id: o.id, rev: o.rev, kind: "question", status: "done", at: new Date(o.at).toISOString(), durationMs: null, text, blocks: plainBlocks(text), format: THREAD_FORMAT,
		redacted: false, tool: null, error: null, truncated: null, child: null, question };
}

/** A reviewer's verdict on a hand-back: `{"passed", "reasons"}`, as the review contract has the reviewer answer. */
export type HandoffVerdict = { passed: boolean; reasons: string[]; findings?: unknown[] };
/** As the reviewer gate keeps them (src/plugins/gate-reviewer/review.ts): at most 20 reasons of about 500 characters. */
export const VERDICT_MAX_REASONS = 20, VERDICT_REASON_MAX_BYTES = 2000;
