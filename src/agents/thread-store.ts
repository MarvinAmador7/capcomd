// The runner's thread items (packages/agent-thread) on their way to the scope actor (scope.putItems). Writes go out
// in order, one at a time (a tool call's done rev never overtakes its open rev), in calls kept under CALL_MAX_BYTES;
// an image goes in a call of its own. Best effort, like the log: a failed write is dropped, the agent keeps working.
import type { ItemDraft } from "../../packages/agent-thread/src/index";
import type { ThreadAttachment } from "../actors/scope";

/** Each scope.putItems call stays under this (JSON), well below the engine's message limits. */
export const CALL_MAX_BYTES = 256 * 1024;

type Scope = { putItems(p: { agentId: string; items: ItemDraft[]; attachments?: ThreadAttachment[] }): Promise<unknown> };

/** Split a batch into calls under the cap, in order; images (≤ 5 MB) one per call. */
export function itemCalls(items: ItemDraft[], attachments: ThreadAttachment[], max = CALL_MAX_BYTES): Array<{ items: ItemDraft[]; attachments: ThreadAttachment[] }> {
	const calls: Array<{ items: ItemDraft[]; attachments: ThreadAttachment[] }> = attachments.map((a) => ({ items: [], attachments: [a] }));
	let cur: ItemDraft[] = [], size = 0;
	for (const it of items) {
		const n = Buffer.byteLength(JSON.stringify(it));
		if (cur.length && size + n > max) { calls.push({ items: cur, attachments: [] }); cur = []; size = 0; }
		cur.push(it); size += n;
	}
	if (cur.length) calls.push({ items: cur, attachments: [] });
	return calls;
}

/** The runner's onItems for one agent. */
export function itemWriter(scope: Scope, agentId: string) {
	let chain: Promise<unknown> = Promise.resolve();
	const write = (items: ItemDraft[], attachments: ThreadAttachment[]) => {
		for (const call of itemCalls(items, attachments)) chain = chain.then(() => scope.putItems({ agentId, ...call })).catch(() => {});
	};
	/** Resolves once every write so far has been tried (await it before reporting the agent finished). */
	return Object.assign(write, { flush: () => chain });
}
