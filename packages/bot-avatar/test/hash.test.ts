// The hash and PRNG are the port contract: checked against an independent BigInt implementation and known vectors.
import { describe, expect, test } from "bun:test";
import { fmix32, fnv1a32, h32, hkey, mulberry32, rng } from "../src/index";

const M = 0xffffffffn;
const big = {
	fnv(bytes: Uint8Array) { let h = 0x811c9dc5n; for (const b of bytes) h = ((h ^ BigInt(b)) * 0x01000193n) & M; return Number(h); },
	fmix(x: number) { let h = BigInt(x); h ^= h >> 16n; h = (h * 0x85ebca6bn) & M; h ^= h >> 13n; h = (h * 0xc2b2ae35n) & M; h ^= h >> 16n; return Number(h); },
	mulberry(seed: number) {
		let s = BigInt(seed);
		return () => {
			s = (s + 0x6d2b79f5n) & M;
			let t = s;
			t = ((t ^ (t >> 15n)) * (t | 1n)) & M;
			t = (t ^ ((t + (((t ^ (t >> 7n)) * (t | 61n)) & M)) & M)) & M;
			return Number((t ^ (t >> 14n)) & M);
		};
	},
};
const enc = new TextEncoder();

describe("hash", () => {
	test("FNV-1a 32 matches the published vectors", () => {
		expect(fnv1a32(enc.encode(""))).toBe(0x811c9dc5);
		expect(fnv1a32(enc.encode("a"))).toBe(0xe40c292c);
		expect(fnv1a32(enc.encode("foobar"))).toBe(0xbf9cf968);
	});

	test("fnv1a32, fmix32 and h32 agree with a BigInt reference on many inputs, UTF-8 included", () => {
		for (let i = 0; i < 2000; i++) {
			const s = `agt-${i.toString(36)}${i % 7 === 0 ? "✓é" : ""}\u001f${i}`;
			const b = enc.encode(s);
			expect(fnv1a32(b)).toBe(big.fnv(b));
			expect(fmix32(fnv1a32(b))).toBe(big.fmix(big.fnv(b)));
			expect(h32(s)).toBe(big.fmix(big.fnv(b)));
		}
		expect(fmix32(0)).toBe(0);
	});

	test("hkey joins with U+001F", () => {
		expect(hkey("agt-1", "head", "dome", 0)).toBe(h32("agt-1\u001fhead\u001fdome\u001f0"));
	});

	test("mulberry32 matches the BigInt reference and is deterministic", () => {
		for (const seed of [0, 1, 0xdeadbeef, h32("agt-pl01")]) {
			const a = mulberry32(seed), b = big.mulberry(seed), c = mulberry32(seed);
			for (let i = 0; i < 500; i++) { const x = a(); expect(x).toBe(b()); expect(x).toBe(c()); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(2 ** 32); }
		}
		expect(rng("s", "confetti")()).toBe(mulberry32(hkey("s", "confetti"))());
	});
});
