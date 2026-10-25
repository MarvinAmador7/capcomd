import { expect, test } from "bun:test";
import { INLINE_TEXT_MAX_BYTES, inlineOrAttach } from "../../src/api/inline-cap";
import { strictEventData } from "../../src/api/legacy-events";
import spec from "../../openapi/capcomd.json";

test("text up to 64 KB stays inline", () => {
	const t = "a".repeat(INLINE_TEXT_MAX_BYTES);
	expect(inlineOrAttach(t)).toEqual({ text: t, attachment: null });
});

test("text over 64 KB (UTF-8 bytes, not chars) becomes an attachment pointer with the full body", () => {
	const t = "é".repeat(INLINE_TEXT_MAX_BYTES / 2 + 1); // 2 bytes each → 64 KB + 2
	const r = inlineOrAttach(t);
	expect(r.text).toBeNull();
	if (!r.attachment) throw new Error("expected attachment");
	expect(r.attachment.bytes).toBe(INLINE_TEXT_MAX_BYTES + 2);
	expect(r.attachment.id).toMatch(/^att-[0-9a-f]{24}$/);
	expect((r as any).body).toBe(t);
	expect(inlineOrAttach(t).attachment!.id).toBe(r.attachment.id);
});

test("message.sent carries the body inline or a pointer, both valid against the daemon's strict schema", () => {
	expect(strictEventData("message.sent", { to: "agt-1", seq: 1, bytes: 2, text: "hi", attachment: null })).toEqual({ ok: true });
	const big = inlineOrAttach("x".repeat(INLINE_TEXT_MAX_BYTES + 1));
	expect(strictEventData("message.sent", { to: "agt-1", seq: 2, bytes: INLINE_TEXT_MAX_BYTES + 1, text: null, attachment: big.attachment })).toEqual({ ok: true });
	const pub = (spec as any).components.schemas.MessageSentData;
	expect(pub.properties.text["x-untrusted"]).toBe(true);
	expect(pub.properties.attachment.properties.sha256).toBeDefined();
});
