// Thread text size (decided Oct 25, 2026): clients show no limit; the daemon keeps at most 64 KB of text inline.
// Longer text is stored in full as an attachment and the event carries a pointer to it.
import { createHash } from "node:crypto";
import { z } from "zod";

export const INLINE_TEXT_MAX_BYTES = 64 * 1024;

export const AttachmentRef = z.looseObject({
	id: z.string().regex(/^att-[0-9a-f]+$/),
	bytes: z.number().int().nonnegative(),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	mediaType: z.string(),
}).describe("Full text stored by the daemon; fetch it with attachments.get");
export type AttachmentRef = z.infer<typeof AttachmentRef>;

export type Inlined = { text: string; attachment: null } | { text: null; attachment: AttachmentRef; body: string };

export const textBytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Text up to 64 KB (UTF-8 bytes) stays inline; anything longer becomes an attachment (content-addressed id). */
export function inlineOrAttach(text: string, mediaType = "text/plain; charset=utf-8"): Inlined {
	const bytes = textBytes(text);
	if (bytes <= INLINE_TEXT_MAX_BYTES) return { text, attachment: null };
	const sha256 = createHash("sha256").update(text).digest("hex");
	return { text: null, attachment: { id: `att-${sha256.slice(0, 24)}`, bytes, sha256, mediaType }, body: text };
}
