// Thread items and the blocks/1 tree: the shape a client renders, without parsing markdown or guessing. Every string
// inside is agent-written plain text (marked x-untrusted); the structure (block and inline types, link targets, media
// sources) is the daemon's. Additive changes keep "blocks/1"; anything a blocks/1 client would misread bumps it.
import { z } from "zod";

export const THREAD_FORMAT = "blocks/1" as const;

/** Agent-written plain text. The description prefix is what the daemon's OpenAPI generator keys x-untrusted on. */
const agentText = (what: string) => z.string().meta({ "x-untrusted": true, description: `Agent-written text: ${what}. Plain text: never markdown, HTML, or a link to follow` });

export const LINK_TARGETS = ["web", "artifact", "file", "agent", "run", "none"] as const;
export const MEDIA_KINDS = ["image", "video", "audio", "file"] as const;

/** Inline nodes. A client renders a `t` it doesn't know as its `text` (or nothing). */
export const Inline: z.ZodType<InlineNode> = z.lazy(() => z.union([
	z.object({ t: z.literal("text"), text: agentText("text run") }),
	z.object({ t: z.literal("code"), text: agentText("inline code") }),
	z.object({ t: z.enum(["strong", "em", "strike"]), children: z.array(Inline) }),
	Link,
	z.object({ t: z.literal("break") }).describe("Hard line break"),
]));
export const Link = z.object({
	t: z.literal("link"),
	text: agentText("the link's text"),
	href: agentText("where it points, for display (credentials removed); null for target none").nullable(),
	target: z.enum(LINK_TARGETS).describe("Classified by the daemon. web: http(s) only; artifact: an attachment the daemon holds (id); file: a path in the agent's workspace (path); agent / run: a capcomd id (id); none: anything else (javascript:, data:, mailto:, custom schemes, paths outside the workspace): show `text` as plain text"),
	host: agentText("web: the URL's host, show it next to the text").nullable(),
	id: z.string().nullable().describe("artifact: attachment id (att-…); agent: agt-…; run: run-…"),
	path: agentText("file: relative to the workspace root, '/'-separated, normalized (never ..)").nullable(),
	mismatch: z.boolean().describe("The text looks like a URL or host other than where the link goes: show the real destination (host, or the full URL)"),
});
export type LinkTarget = (typeof LINK_TARGETS)[number];
export type LinkNode = { t: "link"; text: string; href: string | null; target: LinkTarget; host: string | null; id: string | null; path: string | null; mismatch: boolean };
export type InlineNode =
	| { t: "text"; text: string }
	| { t: "code"; text: string }
	| { t: "strong" | "em" | "strike"; children: InlineNode[] }
	| LinkNode
	| { t: "break" };

export const MediaSource = z.union([
	z.object({ type: z.literal("attachment"), id: z.string().describe("att-…: GET /v1/runs/{runId}/attachments/{id}/content") }),
	z.object({ type: z.literal("workspace"), path: agentText("file in the agent's workspace, relative and normalized: GET /v1/runs/{runId}/agents/{agentId}/workspace?path=") }),
	z.object({ type: z.literal("inline"), attachmentId: z.string().describe("att-…: an image a tool returned, stored by the daemon (png, jpeg, gif, webp only)") }),
	z.object({ type: z.literal("remote"), url: agentText("http(s) URL, credentials removed. The daemon never fetches it; load it only on an explicit click"), host: agentText("the URL's host") }),
]);
export type MediaSourceT = z.infer<typeof MediaSource>;

export const ListItem: z.ZodType<ListItemNode> = z.lazy(() => z.object({ checked: z.boolean().nullable().describe("Task list item: done or not; null for a plain item"), blocks: z.array(Block) }));
export type ListItemNode = { checked: boolean | null; blocks: BlockNode[] };
export const Align = z.enum(["left", "center", "right"]).nullable();

/** Blocks. A client renders a `t` it doesn't know from its `text` field if it has one, else skips it. */
export const Block: z.ZodType<BlockNode> = z.lazy(() => z.union([
	z.object({ t: z.literal("paragraph"), children: z.array(Inline) }),
	z.object({ t: z.literal("heading"), level: z.union([z.literal(1), z.literal(2), z.literal(3)]).describe("Deeper markdown headings are 3"), children: z.array(Inline) }),
	z.object({ t: z.literal("list"), ordered: z.boolean(), start: z.number().int().nullable(), items: z.array(ListItem) }),
	z.object({ t: z.literal("code"), lang: agentText("the fence's info word").nullable(), text: agentText("code, newlines kept"), truncatedLines: z.number().int().positive().nullable().describe("Lines dropped from the end") }),
	z.object({
		t: z.literal("table"), align: z.array(Align), header: z.array(z.array(Inline)), rows: z.array(z.array(z.array(Inline))),
		truncatedRows: z.number().int().positive().nullable(), truncatedCols: z.number().int().positive().nullable(),
	}),
	z.object({ t: z.literal("quote"), blocks: z.array(Block) }),
	z.object({ t: z.literal("rule") }),
	z.object({
		t: z.literal("media"), kind: z.enum(MEDIA_KINDS), source: MediaSource, alt: agentText("alt text"),
		mime: z.string().nullable(), bytes: z.number().int().nonnegative().nullable(), width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(),
	}).describe("Remote media never loads by itself; attachment, inline and workspace media load through the daemon only"),
	z.object({ t: z.literal("open"), text: agentText("the trailing block still being written") }).describe("Reserved for token streaming: the last block of an open say/thinking item, as plain text. Not emitted yet"),
]));
export type MediaBlock = { t: "media"; kind: (typeof MEDIA_KINDS)[number]; source: MediaSourceT; alt: string; mime: string | null; bytes: number | null; width: number | null; height: number | null };
export type BlockNode =
	| { t: "paragraph"; children: InlineNode[] }
	| { t: "heading"; level: 1 | 2 | 3; children: InlineNode[] }
	| { t: "list"; ordered: boolean; start: number | null; items: ListItemNode[] }
	| { t: "code"; lang: string | null; text: string; truncatedLines: number | null }
	| { t: "table"; align: Array<"left" | "center" | "right" | null>; header: InlineNode[][]; rows: InlineNode[][][]; truncatedRows: number | null; truncatedCols: number | null }
	| { t: "quote"; blocks: BlockNode[] }
	| { t: "rule" }
	| MediaBlock
	| { t: "open"; text: string };

export const ITEM_KINDS = ["say", "thinking", "tool", "error", "result", "plan", "handoff", "other"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const DIFF_OPS = [" ", "+", "-", "@"] as const;
/** Lines kept per tool diff (hunk separators included); `added` / `removed` still count the whole change. */
export const DIFF_MAX_LINES = 40;
/** Characters kept per diff line (an ellipsis when cut). */
export const DIFF_LINE_MAX_CHARS = 240;
export const DiffLine = z.object({
	op: z.enum(DIFF_OPS).describe("\" \": context, \"+\": added, \"-\": removed, \"@\": a gap between two hunks (lines in between not shown; `text` is the next hunk's `@@ -a,b +c,d @@` header when the CLI reported line numbers, else empty). Render an unknown op as context"),
	text: agentText(`the line, without its newline, at most ${DIFF_LINE_MAX_CHARS} characters (an ellipsis when cut); indentation kept`),
});
export type DiffLine = z.infer<typeof DiffLine>;
export const ToolDiff = z.object({
	path: agentText("the file, relative to the workspace root, '/'-separated, normalized like file links (never ..); null when it is outside the workspace").nullable(),
	added: z.number().int().nonnegative().describe("Lines added by the whole change (not only the lines shown)"),
	removed: z.number().int().nonnegative().describe("Lines removed by the whole change (not only the lines shown)"),
	lines: z.array(DiffLine).describe(`The change's first lines, at most ${DIFF_MAX_LINES} (separators included). Context lines are only lines the CLI's event contained: no file is read`),
	truncatedLines: z.number().int().positive().nullable().describe("Context, added and removed lines not shown"),
}).describe("A file-editing call's change (Claude Code Edit, MultiEdit, Write, NotebookEdit insert): from the call's input while it runs, replaced by the result's own patch (with context) when it returns. isError: the change was proposed but not applied");
export type ToolDiffT = z.infer<typeof ToolDiff>;

export const ToolInfo = z.object({
	callId: z.string().describe("The CLI's call id (Claude tool_use id, Codex item id)"),
	name: agentText("the tool's name as the CLI reported it (Read, Bash, command_execution, capcomd.capcomd_spawn)"),
	kind: z.string().describe("Icon hint, Agent.activity's kinds (read, edit, run, test, …); treat an unknown one as tool"),
	summary: agentText("one line built by the daemon from the call's fields, e.g. \"Read ids/v1/schema.json\", \"Run bun test\""),
	isError: z.boolean(),
	args: agentText("the call's input as JSON, at most 4 KB").nullable(),
	output: agentText("the result's text, at most 16 KB (the end kept); null while open").nullable(),
	files: z.array(Link).describe("Files the call wrote or changed, as file links"),
	diff: ToolDiff.nullable().describe("The call's change to one file, as a short line diff; null for calls that don't edit a file, and when the CLI's events don't carry the change's lines (Codex file_change reports paths only: see files)"),
});
export type ToolInfoT = z.infer<typeof ToolInfo>;

export const ThreadItem = z.object({
	id: z.string().describe("Stable: an update has the same id and a higher rev"),
	rev: z.number().int().positive(),
	seq: z.number().int().nonnegative().describe("Run-wide cursor, advanced by every write (create or update): ?after=<seq> returns items created or changed since"),
	order: z.number().int().nonnegative().describe("Position in the thread: sort by this (it never changes)"),
	agentId: z.string(),
	kind: z.string().describe(`${ITEM_KINDS.join(", ")}. More may be added: render an unknown kind as a plain line of \`text\``),
	status: z.enum(["open", "done"]).describe("open: a tool call still running (or, later, a message still streaming); done: final"),
	at: z.string().describe("When it started (ISO 8601 UTC, ms precision)"),
	durationMs: z.number().int().nonnegative().nullable().describe("tool: as the CLI reported it (Glob, Grep, WebFetch, WebSearch, Task); null otherwise"),
	text: agentText("the item as plain text, for copy, search and kinds a client doesn't know: the message (cut at a block boundary like blocks), the tool summary, the error, or a one-line summary"),
	blocks: z.array(Block),
	format: z.literal(THREAD_FORMAT),
	redacted: z.boolean().describe("thinking: the CLI withheld the text (redacted or empty)"),
	tool: ToolInfo.nullable(),
	error: z.object({ message: agentText("what failed"), code: z.string().nullable().describe("The CLI's code when it gave one (error_max_turns, rate_limit, turn_failed)") }).nullable(),
	truncated: z.object({ blocks: z.number().int().nonnegative().describe("Trailing blocks dropped"), bytes: z.number().int().nonnegative().describe("Size of the original text") }).nullable()
		.describe("Over the per-item cap: whole trailing blocks were dropped (never cut inside a code block or table)"),
	child: z.object({ agentId: z.string(), status: z.string() }).nullable().describe("handoff: the child agent that handed back (its summary is the blocks; artifacts are links and media)"),
});
export type ThreadItemT = z.infer<typeof ThreadItem>;
/** What an adapter produces: everything but the storage cursor fields (seq, order) and agentId, which the daemon sets. */
export type ItemDraft = Omit<ThreadItemT, "seq" | "order" | "agentId">;

/** JSON Schema (draft 2020-12) of one thread item, with blocks/1 in $defs. For other languages' decoders and fixtures. */
export function threadItemJsonSchema(): Record<string, unknown> {
	return z.toJSONSchema(ThreadItem, { unrepresentable: "any", cycles: "ref" }) as Record<string, unknown>;
}
