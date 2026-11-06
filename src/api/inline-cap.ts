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

/** The id of the attachment whose text has this sha256 (hex): content-addressed, so the same text is stored once. */
export const attachmentId = (sha256: string) => `att-${sha256.slice(0, 24)}`;

/** Text stored in full as an attachment, whatever its size (a profile's skill, pinned with the agent at spawn). */
export function attach(text: string, mediaType = "text/plain; charset=utf-8"): AttachmentRef {
	const sha256 = createHash("sha256").update(text).digest("hex");
	return { id: attachmentId(sha256), bytes: textBytes(text), sha256, mediaType };
}

/** Text up to 64 KB (UTF-8 bytes) stays inline; anything longer becomes an attachment (content-addressed id). */
export function inlineOrAttach(text: string, mediaType = "text/plain; charset=utf-8"): Inlined {
	if (textBytes(text) <= INLINE_TEXT_MAX_BYTES) return { text, attachment: null };
	return { text: null, attachment: attach(text, mediaType), body: text };
}
