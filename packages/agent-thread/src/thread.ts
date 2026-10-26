// Agent CLI events → thread items. Feed each decoded JSON line of the CLI's stream (Claude Code `--output-format
// stream-json --verbose`, Codex `exec --json`) to `event`; it returns the items it created or changed, each with its
// current rev. Nothing is dropped and nothing throws: an event this doesn't know becomes an `other` item.
//
// Claude: every content block arrives whole as its own `assistant` event (several share a message id); a tool_use opens
// a tool item that the user event carrying the matching tool_result (by tool_use_id) closes. Codex: items start,
// update and complete under one id; tool steps are command_execution, file_change, mcp_tool_call and web_search.
import { claudeToolKind, codexItemKind } from "./kinds";
import { classifyLink, workspacePath, type LinkContext } from "./links";
import { plainBlocks, toBlocks } from "./markdown";
import { claudeInputDiff, claudeResultDiff } from "./diff";
import { checkImage, type StoredImage } from "./images";
import { capBytes, oneLine, sanitize, tailBytes } from "./sanitize";
import { claudeSummary, codexSummary } from "./summary";
import { THREAD_FORMAT, type BlockNode, type ItemDraft, type LinkNode, type ToolDiffT, type ToolInfoT } from "./schema";

const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
export const ARGS_MAX_BYTES = 4 * 1024;
export const OUTPUT_MAX_BYTES = 16 * 1024;
const ERROR_MAX_BYTES = 8 * 1024;

export type Cli = "claude" | "codex";
export interface ThreadOptions {
	cli: Cli;
	/** Item ids are `${idPrefix}-${n}`: the daemon makes the prefix unique per agent and per run of it. */
	idPrefix: string;
	/** When an event was seen (ms). Default Date.now. */
	now?: () => number;
	/** Link classification context: the workspace root, attachment lookups. */
	link?: LinkContext;
	/** Store an image a tool returned (the daemon writes it as an attachment). Without it, such images become text. */
	onImage?: (img: StoredImage) => void;
}

const str = (x: unknown) => (typeof x === "string" ? x : "");
const json = (x: unknown) => { try { return JSON.stringify(x ?? null); } catch { return "null"; } };
/** Reconnect / retry notices from codex are progress, not failures. */
const RETRYING = /^\s*(re-?connecting|retrying|stream disconnected|reconnect)/i;
/** A duration the CLI itself reported for a tool (claude's tool_use_result). */
function reportedMs(r: any): number | null {
	if (!r || typeof r !== "object") return null;
	for (const k of ["durationMs", "totalDurationMs", "duration_ms"]) { const v = r[k]; if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v); }
	if (typeof r.durationSeconds === "number" && Number.isFinite(r.durationSeconds) && r.durationSeconds >= 0) return Math.round(r.durationSeconds * 1000);
	return null;
}

export function threadBuilder(o: ThreadOptions) {
	const now = o.now ?? Date.now;
	const ctx = o.link ?? {};
	const items = new Map<string, ItemDraft>();
	const tools = new Map<string, string>(); // CLI call id → item id
	const plans = new Map<string, string>(); // codex todo_list item id → item id
	const ignoredCalls = new Set<string>(); // calls shown as something else (TodoWrite → plan)
	const seenBlocks = new Set<string>();
	const editPaths = new Map<string, unknown>(); // claude file-editing call id → its input's path
	let n = 0, lastText: string | null = null;
	const rel = (p: unknown) => { const s = str(p); return workspacePath(s, ctx.root) ?? s; };

	const create = (d: Omit<ItemDraft, "id" | "rev" | "at" | "format" | "durationMs" | "redacted" | "tool" | "error" | "truncated" | "child" | "blocks" | "status"> & Partial<ItemDraft>): ItemDraft => {
		const item: ItemDraft = {
			id: `${o.idPrefix}-${++n}`, rev: 1, kind: d.kind, status: d.status ?? "done", at: new Date(now()).toISOString(), durationMs: d.durationMs ?? null,
			text: d.text, blocks: d.blocks ?? [], format: THREAD_FORMAT, redacted: d.redacted ?? false, tool: d.tool ?? null, error: d.error ?? null,
			truncated: d.truncated ?? null, child: d.child ?? null,
		};
		items.set(item.id, item);
		if (item.kind === "say" || item.kind === "result" || item.kind === "error") lastText = item.text.trim();
		return item;
	};
	const update = (id: string, patch: Partial<ItemDraft>): ItemDraft => {
		const prev = items.get(id)!;
		const next: ItemDraft = { ...prev, ...patch, rev: prev.rev + 1 };
		items.set(id, next);
		return next;
	};
	const markdownItem = (kind: "say" | "result", text: string): ItemDraft => {
		const p = toBlocks(text, ctx);
		return create({ kind, text: p.text, blocks: p.blocks, truncated: p.truncated });
	};
	const errorItem = (message: string, code: string | null): ItemDraft => {
		const m = capBytes(sanitize(message), ERROR_MAX_BYTES);
		return create({ kind: "error", text: m, blocks: plainBlocks(m), error: { message: m, code } });
	};
	const other = (summary: string): ItemDraft => create({ kind: "other", text: oneLine(summary) || "Event" });
	const thinking = (text: string, redacted: boolean): ItemDraft => {
		if (redacted || !text.trim()) return create({ kind: "thinking", text: "", redacted: true });
		const p = toBlocks(text, ctx);
		return create({ kind: "thinking", text: p.text, blocks: p.blocks, truncated: p.truncated });
	};
	const fileLinks = (paths: unknown[]): LinkNode[] =>
		paths.flatMap((p) => { const s = str(p); if (!s) return []; const l = classifyLink(s, workspacePath(s, ctx.root) ?? s, ctx); return l.target === "file" ? [l] : []; });
	const openTool = (callId: string, t: Omit<ToolInfoT, "callId" | "isError" | "output">): ItemDraft => {
		const tool: ToolInfoT = { callId, name: oneLine(t.name, 200), kind: t.kind, summary: t.summary, isError: false, args: t.args, output: null, files: t.files, diff: t.diff };
		const item = create({ kind: "tool", status: "open", text: tool.summary, tool });
		tools.set(callId, item.id);
		return item;
	};
	const closeTool = (callId: string, r: { isError: boolean; output: string | null; durationMs: number | null; blocks?: BlockNode[]; error?: string | null; code?: string | null; diff?: ToolDiffT | null }): ItemDraft | null => {
		const id = tools.get(callId);
		if (!id) return null;
		tools.delete(callId);
		const prev = items.get(id)!;
		const output = r.output === null ? null : tailBytes(sanitize(r.output), OUTPUT_MAX_BYTES);
		const errorText = r.isError ? capBytes(sanitize(r.error ?? r.output ?? "failed"), ERROR_MAX_BYTES) : null;
		return update(id, {
			status: "done", durationMs: r.durationMs, blocks: r.blocks ?? prev.blocks,
			tool: { ...prev.tool!, isError: r.isError, output, diff: r.diff === undefined ? prev.tool!.diff : r.diff }, error: errorText !== null ? { message: errorText, code: r.code ?? null } : null,
		});
	};
	/** Calls still open when the turn or the agent ended. */
	const closeAll = (why: string): ItemDraft[] =>
		[...tools.keys()].flatMap((c) => closeTool(c, { isError: true, output: null, durationMs: null, error: why, code: "unfinished" }) ?? []);
	const planItem = (todos: Array<{ text: string; done: boolean }>, status: "open" | "done", existing?: string): ItemDraft => {
		const list: BlockNode = { t: "list", ordered: false, start: null, items: todos.map((t) => ({ checked: t.done, blocks: plainBlocks(oneLine(t.text, 500)) })) };
		const text = todos.map((t) => `- [${t.done ? "x" : " "}] ${oneLine(t.text, 500)}`).join("\n");
		return existing ? update(existing, { status, text, blocks: todos.length ? [list] : [] }) : create({ kind: "plan", status, text, blocks: todos.length ? [list] : [] });
	};

	/** Claude tool_result content → output text and media blocks (images stored through onImage). */
	const claudeResult = (content: unknown): { text: string; blocks: BlockNode[] } => {
		if (typeof content === "string") return { text: content, blocks: [] };
		if (!Array.isArray(content)) return { text: "", blocks: [] };
		const texts: string[] = [], blocks: BlockNode[] = [];
		for (const c of content as any[]) {
			if (c?.type === "text" && typeof c.text === "string") texts.push(c.text);
			else if (c?.type === "image") {
				const data = c.source?.type === "base64" ? str(c.source.data) : "";
				const img = data && o.onImage ? checkImage(data) : null;
				if (img && "id" in img) {
					o.onImage!(img);
					blocks.push({ t: "media", kind: "image", source: { type: "inline", attachmentId: img.id }, alt: "Image from the tool", mime: img.mime, bytes: img.bytes, width: img.width, height: img.height });
				} else blocks.push({ t: "paragraph", children: [{ t: "link", text: `Image not shown${img && "rejected" in img ? ` (${img.rejected})` : ""}`, href: null, target: "none", host: null, id: null, path: null, mismatch: false }] });
			}
		}
		return { text: texts.join("\n"), blocks };
	};

	const claude = (raw: any): ItemDraft[] => {
		const out: ItemDraft[] = [];
		const type = str(raw?.type);
		const content = raw?.message?.content;
		if (type === "assistant" && Array.isArray(content)) {
			const mid = str(raw.message?.id);
			for (const c of content) {
				// A block the CLI repeats (same message id, same block) is one item.
				const key = mid ? `${mid}:${json(c)}` : null;
				if (key) { if (seenBlocks.has(key)) continue; seenBlocks.add(key); }
				const bt = str(c?.type);
				if (bt === "text") {
					const t = str(c.text);
					if (!t.trim()) continue;
					out.push(raw.error ? errorItem(t, str(raw.error) || null) : markdownItem("say", t));
				} else if (bt === "thinking") out.push(thinking(str(c.thinking), false));
				else if (bt === "redacted_thinking") out.push(thinking("", true));
				else if (bt === "tool_use") {
					const name = str(c.name), input = c.input && typeof c.input === "object" ? c.input : {};
					const callId = str(c.id) || `anon-${n + 1}`;
					if (name === "TodoWrite" && Array.isArray(input.todos)) {
						ignoredCalls.add(callId);
						out.push(planItem(input.todos.map((t: any) => ({ text: str(t?.content) || str(t?.activeForm), done: t?.status === "completed" })), "done"));
						continue;
					}
					const edits = EDIT_TOOLS.includes(name);
					if (edits) editPaths.set(callId, input.file_path ?? input.notebook_path);
					out.push(openTool(callId, {
						name, kind: claudeToolKind(name, input), summary: claudeSummary(name, input, rel), args: capBytes(json(input), ARGS_MAX_BYTES),
						files: edits ? fileLinks([input.file_path ?? input.notebook_path]) : [],
						diff: edits ? claudeInputDiff(name, input, ctx.root) : null,
					}));
				} else out.push(other(`Assistant ${bt || "block"}`));
			}
		} else if (type === "user" && Array.isArray(content)) {
			const results = content.filter((c: any) => c?.type === "tool_result");
			for (const r of results) {
				const callId = str(r.tool_use_id);
				if (ignoredCalls.delete(callId)) continue;
				const res = claudeResult(r.content);
				// tool_use_result describes the event's only result; with several, it can't be matched to one.
				const one = results.length === 1 ? raw.tool_use_result : undefined;
				// The applied change, with context, replaces the input's; a failed call keeps what it proposed.
				const diff = editPaths.has(callId) && !r.is_error ? claudeResultDiff(one, editPaths.get(callId), ctx.root) : undefined;
				editPaths.delete(callId);
				const closed = closeTool(callId, { isError: !!r.is_error, output: res.text, durationMs: one !== undefined ? reportedMs(one) : null, blocks: res.blocks, error: r.is_error ? res.text : null, diff });
				out.push(closed ?? other("A tool result for a call this thread didn't see"));
			}
		} else if (type === "result") {
			out.push(...closeAll("The agent finished before this call returned"));
			const text = str(raw.result).trim();
			if (raw.is_error) { if (!text || text !== lastText) out.push(errorItem(text || str(raw.subtype) || "error", str(raw.subtype) || null)); }
			else if (text && text !== lastText) out.push(markdownItem("result", str(raw.result)));
		} else if (type === "system") {
			if (raw.subtype === "compact_boundary") out.push(other("Compacted the conversation"));
			else if (raw.subtype !== "init" && raw.subtype !== "status" && !String(raw.subtype ?? "").startsWith("hook_")) out.push(other(`System: ${str(raw.subtype) || "event"}`));
		} else if (type === "rate_limit_event") {
			if (raw.rate_limit_info?.status === "rejected") out.push(other("Usage limit reached"));
		} else if (["stream_event", "tool_progress", "tool_use_summary", "auth_status", "keep_alive", "user", "assistant"].includes(type)) {
			// Known and not shown: partial-message deltas (token streaming is a follow-up), progress ticks, echoed input.
		} else out.push(other(`Unknown event: ${type || "?"}`));
		return out;
	};

	const codex = (raw: any): ItemDraft[] => {
		const out: ItemDraft[] = [];
		const type = str(raw?.type);
		const item = raw?.item;
		if ((type === "item.started" || type === "item.updated" || type === "item.completed") && item && typeof item === "object") {
			const id = str(item.id) || `anon-${n + 1}`;
			const done = type === "item.completed";
			switch (item.type) {
				case "command_execution": case "file_change": case "mcp_tool_call": case "web_search": {
					const fresh = !tools.has(id);
					if (fresh) {
						const name = item.type === "mcp_tool_call" ? `${str(item.server)}.${str(item.tool)}` : str(item.type);
						const args = item.type === "command_execution" ? str(item.command) : item.type === "mcp_tool_call" ? json(item.arguments) : item.type === "file_change" ? json(item.changes) : str(item.query);
						const files = item.type === "file_change" && Array.isArray(item.changes) ? fileLinks(item.changes.filter((ch: any) => ch?.kind !== "delete").map((ch: any) => ch?.path)) : [];
						// file_change carries paths and kinds, not lines: no diff (the files are links).
						out.push(openTool(id, { name, kind: codexItemKind(item) ?? "tool", summary: codexSummary(item, rel), args: capBytes(args, ARGS_MAX_BYTES), files, diff: null }));
					}
					if (done) {
						const failed = item.status === "failed" || (item.type === "command_execution" && item.exit_code != null && Number(item.exit_code) !== 0);
						const output = item.type === "command_execution" ? str(item.aggregated_output)
							: item.type === "mcp_tool_call" ? (Array.isArray(item.result?.content) ? item.result.content.map((x: any) => str(x?.text)).join("\n") : item.result != null ? json(item.result) : "")
							: "";
						const error = failed ? str(item.error?.message) || output || `exit ${item.exit_code ?? "failed"}` : null;
						let d = closeTool(id, { isError: failed, output: output || null, durationMs: null, error });
						// Reported only once, done (file_change, web_search): one revision, not open-then-done.
						if (d && fresh) { d = { ...d, rev: 1 }; items.set(d.id, d); }
						if (d) { const i = out.findIndex((x) => x.id === d!.id); if (i >= 0) out[i] = d; else out.push(d); }
					}
					break;
				}
				case "agent_message": if (done && str(item.text).trim()) out.push(markdownItem("say", str(item.text))); break;
				case "reasoning": if (done) out.push(thinking(str(item.text), false)); break;
				case "todo_list": {
					const todos = (Array.isArray(item.items) ? item.items : []).map((t: any) => ({ text: str(t?.text), done: !!t?.completed }));
					const d = planItem(todos, done ? "done" : "open", plans.get(id));
					plans.set(id, d.id);
					out.push(d);
					break;
				}
				case "error": if (done || type === "item.started") { const m = str(item.message); out.push(RETRYING.test(m) ? other(m) : errorItem(m || "error", null)); } break;
				default: if (done) out.push(other(`Codex ${str(item.type) || "item"}`));
			}
		} else if (type === "turn.failed") {
			out.push(...closeAll("The turn failed before this call returned"));
			out.push(errorItem(str(raw.error?.message) || "The turn failed", "turn_failed"));
		} else if (type === "error") {
			const m = str(raw.message) || str(raw.error?.message);
			out.push(RETRYING.test(m) ? other(m) : errorItem(m || "error", null));
		} else if (["thread.started", "turn.started", "turn.completed"].includes(type)) {
			// Known and not shown.
		} else out.push(other(`Unknown event: ${type || "?"}`));
		return out;
	};

	return {
		/** One decoded line of the CLI's stream. Returns the items it created or changed (latest rev of each). */
		event(raw: unknown): ItemDraft[] {
			if (!raw || typeof raw !== "object") return [];
			let out: ItemDraft[];
			try { out = o.cli === "codex" ? codex(raw) : claude(raw); } catch (e) { out = [other(`Event not shown (${(e as Error)?.message ?? "error"})`)]; }
			// One entry per item: its latest rev.
			const latest = new Map<string, ItemDraft>();
			for (const d of out) latest.set(d.id, items.get(d.id) ?? d);
			return [...latest.values()];
		},
		/** The agent stopped: calls still open are closed (unfinished). */
		finish(): ItemDraft[] { return closeAll("The agent stopped before this call returned"); },
		/** Every item so far, in order. */
		all(): ItemDraft[] { return [...items.values()]; },
	};
}
export type ThreadBuilder = ReturnType<typeof threadBuilder>;
