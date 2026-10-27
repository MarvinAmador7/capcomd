// The golden contract for other languages' renderers: fixtures/catalog.json and fixtures/golden/bots.json are up to
// date (refresh: bun packages/bot-avatar/scripts/golden.ts), and they cover every role and size.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG, ROLES, SIZES } from "../src/index";
import { catalogJson, golden, goldenJson } from "./golden-lib";

const dir = join(import.meta.dir, "..", "fixtures");

describe("golden", () => {
	test("catalog.json is the catalog", () => {
		expect(readFileSync(join(dir, "catalog.json"), "utf8")).toBe(catalogJson());
		expect(JSON.parse(catalogJson())).toEqual(JSON.parse(JSON.stringify(CATALOG)));
	});

	test("bots.json is up to date", () => {
		expect(readFileSync(join(dir, "golden", "bots.json"), "utf8")).toBe(goldenJson());
	});

	test("it covers every role at every size, the hash, the PRNG and SVG output", () => {
		const g = golden();
		expect(new Set(g.cases.map((c) => c.role))).toEqual(new Set(ROLES));
		for (const c of g.cases) expect(Object.keys(c.sizes).sort()).toEqual([...SIZES].sort());
		expect(g.hash.length).toBeGreaterThan(4);
		expect(g.mulberry32.first.length).toBe(8);
		expect(g.svg.length).toBe(3);
	});
});
