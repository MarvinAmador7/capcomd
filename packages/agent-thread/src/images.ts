// Images a tool returned (Claude tool_result image blocks): checked by their bytes, never by what they claim to be.
// Only png, jpeg, gif and webp pass (no svg: it is a document that can run script); at most IMAGE_MAX_BYTES.
import { createHash } from "node:crypto";

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** The image type from the bytes' signature, or null. */
export function sniffImage(b: Uint8Array): (typeof IMAGE_TYPES)[number] | null {
	const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
	if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return "image/gif";
	if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
	return null;
}

/** Width and height from the header, when it is readable. */
export function imageSize(b: Uint8Array, mime: string): { width: number; height: number } | null {
	const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!, u16le = (i: number) => b[i]! | (b[i + 1]! << 8);
	const u32be = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
	const ok = (w: number, h: number) => (w > 0 && h > 0 ? { width: w, height: h } : null);
	try {
		if (mime === "image/png" && b.length >= 24) return ok(u32be(16), u32be(20));
		if (mime === "image/gif" && b.length >= 10) return ok(u16le(6), u16le(8));
		if (mime === "image/webp" && b.length >= 30) {
			const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
			if (kind === "VP8X") return ok(1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)));
			if (kind === "VP8L") { const v = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24); return ok((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1); }
			if (kind === "VP8 ") return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
		}
		if (mime === "image/jpeg") {
			for (let i = 2; i + 9 < b.length;) {
				if (b[i] !== 0xff) return null;
				const marker = b[i + 1]!;
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(u16be(i + 7), u16be(i + 5));
				i += 2 + u16be(i + 2);
			}
		}
	} catch { /* unreadable header */ }
	return null;
}

/** An image a tool returned, ready to store: content-addressed id, checked type, size. */
export type StoredImage = { id: string; mime: (typeof IMAGE_TYPES)[number]; bytes: number; width: number | null; height: number | null; sha256: string; base64: string };

/** Decode, check and identify a base64 image; why not, when it isn't acceptable. */
export function checkImage(base64: string): StoredImage | { rejected: string } {
	const clean = base64.replace(/\s+/g, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return { rejected: "not base64" };
	if ((clean.length * 3) / 4 > IMAGE_MAX_BYTES + 3) return { rejected: `larger than ${IMAGE_MAX_BYTES / (1024 * 1024)} MB` };
	const b = new Uint8Array(Buffer.from(clean, "base64"));
	if (b.length > IMAGE_MAX_BYTES) return { rejected: `larger than ${IMAGE_MAX_BYTES / (1024 * 1024)} MB` };
	const mime = sniffImage(b);
	if (!mime) return { rejected: "not a png, jpeg, gif or webp image" };
	const sha256 = createHash("sha256").update(b).digest("hex");
	const size = imageSize(b, mime);
	return { id: `att-${sha256.slice(0, 24)}`, mime, bytes: b.length, width: size?.width ?? null, height: size?.height ?? null, sha256, base64: Buffer.from(b).toString("base64") };
}
