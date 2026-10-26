// @capcomd/agent-thread: agent CLI streams → thread items with a sanitized blocks/1 tree. Pure functions: storing
// images and knowing the workspace are the caller's (injected through ThreadOptions / LinkContext).
export * from "./schema";
export { sanitize, oneLine, capBytes } from "./sanitize";
export { toBlocks, blockText, plainBlocks, ITEM_MAX_BYTES, PARSE_MAX_BYTES, CODE_MAX_LINES, TABLE_MAX_ROWS, TABLE_MAX_COLS, MAX_DEPTH, type Parsed } from "./markdown";
export { classifyLink, resolveMedia, workspacePath, webUrl, hostInText, mediaOfPath, type LinkContext } from "./links";
export { checkImage, sniffImage, imageSize, IMAGE_MAX_BYTES, IMAGE_TYPES, type StoredImage } from "./images";
export { claudeInputDiff, claudeResultDiff, lineDiff } from "./diff";
export { threadBuilder, ARGS_MAX_BYTES, OUTPUT_MAX_BYTES, type ThreadOptions, type ThreadBuilder, type Cli } from "./thread";
export { ACTIVITY_KINDS, commandKind, opKind, claudeToolKind, codexItemKind, type ActivityKind } from "./kinds";
export { claudeSummary, codexSummary, shellCommand } from "./summary";

import { classifyLink, mediaOfPath, resolveMedia, type LinkContext } from "./links";
import { toBlocks } from "./markdown";
import { THREAD_FORMAT, type BlockNode, type ItemDraft } from "./schema";

/**
 * A child agent handing back (agent.done / agent.failed): its summary as blocks, then its artifacts ({name, ref}) as
 * media blocks (images, video, audio it points at) and a list of links (files, attachments, web pages, agents).
 */
export function handoffDraft(o: { id: string; at: number; child: { agentId: string; status: string }; summary: string; artifacts?: Array<{ name: string; ref: string }>; link?: LinkContext }): ItemDraft {
	const p = toBlocks(o.summary, o.link);
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
		redacted: false, tool: null, error: null, truncated: p.truncated, child: o.child,
	};
}
