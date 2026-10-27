// The only randomness in the engine, specified so another language reproduces it bit for bit. All arithmetic is
// unsigned 32-bit with wrap-around (Swift: UInt32 with &+ / &*; JS: Math.imul and >>> 0).
//
//   fnv1a32(bytes): h = 0x811C9DC5; for each byte b: h = (h XOR b) * 0x01000193
//   fmix32(h):      h ^= h >> 16; h *= 0x85EBCA6B; h ^= h >> 13; h *= 0xC2B2AE35; h ^= h >> 16   (MurmurHash3 finalizer)
//   h32(s)        = fmix32(fnv1a32(UTF-8 bytes of s))
//
// Keys are joined with U+001F (unit separator), e.g. h32("agt-1f3a\u001Fhead\u001Fdome\u001F0").

const encoder = new TextEncoder();

export function fnv1a32(bytes: Uint8Array): number {
	let h = 0x811c9dc5;
	for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
	return h >>> 0;
}

export function fmix32(x: number): number {
	let h = x >>> 0;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b) >>> 0;
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35) >>> 0;
	h ^= h >>> 16;
	return h >>> 0;
}

export const SEP = "\u001f";

/** Stable 32-bit hash of a string (its UTF-8 bytes). */
export function h32(s: string): number {
	return fmix32(fnv1a32(encoder.encode(s)));
}

/** h32 of the parts joined with U+001F. */
export function hkey(...parts: Array<string | number>): number {
	return h32(parts.join(SEP));
}

/**
 * mulberry32, seeded with a u32. Each call returns the next u32:
 *   state += 0x6D2B79F5; t = state; t = (t ^ t >> 15) * (t | 1); t ^= t + (t ^ t >> 7) * (t | 61); return t ^ t >> 14
 * Used for decorative layouts (confetti, sparkles), never for picking parts: picks use rendezvous hashing so that adding
 * a part to the catalog leaves every other bot alone.
 */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
		t = (t ^ (t + (Math.imul(t ^ (t >>> 7), t | 61) >>> 0))) >>> 0;
		return (t ^ (t >>> 14)) >>> 0;
	};
}

/** A PRNG for one named stream of one seed: mulberry32(hkey(seed, stream)). */
export function rng(seed: string, stream: string): () => number {
	return mulberry32(hkey(seed, stream));
}
