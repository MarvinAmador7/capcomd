// The catalog is well formed: every drawing is rectangular and uses known keys, every part has the drawings and
// anchors its slot needs, faces fit the shared visor, and no role can ever run out of candidates for a slot.
import { describe, expect, test } from "bun:test";
import { CATALOG, ROLES, SLOTS, candidates, constrainedSlots, countCombinations, weightOf, type Art, type Part, type Slot } from "../src/index";

const KEYS = new Set("BbHAaTtGgWIFVEeMKPLS".split(""));
const PART_SLOTS = SLOTS.filter((s): s is Exclude<Slot, "name"> => s !== "name");
const arts = (p: Part): Array<[string, Art]> => [...Object.entries(p.art ?? {}), ...(p.arms ?? []).map((a, i) => [`arm${i}`, a] as [string, Art])];

describe("catalog", () => {
	test("ids are unique per slot and weights are integers", () => {
		for (const s of PART_SLOTS) {
			const ids = CATALOG.slots[s].map((p) => p.id);
			expect(new Set(ids).size).toBe(ids.length);
			for (const p of CATALOG.slots[s]) for (const r of ROLES) expect(Number.isInteger(weightOf(p, r)) && weightOf(p, r) >= 0).toBe(true);
		}
		expect(new Set(CATALOG.names).size).toBe(CATALOG.names.length);
	});

	test("every drawing is rectangular, uses known pixel keys, and its anchor is inside or on its edge", () => {
		const all: Array<[string, Art]> = PART_SLOTS.flatMap((s) => CATALOG.slots[s].flatMap((p) => arts(p).map(([l, a]) => [`${s}/${p.id}/${l}`, a] as [string, Art])));
		all.push(["ground", CATALOG.ground!]);
		for (const [name, a] of all) {
			if (!a.rows.length) continue;
			const w = a.rows[0]!.length;
			for (const r of a.rows) { expect([name, r.length]).toEqual([name, w]); for (const c of r) if (c !== ".") expect([name, KEYS.has(c)]).toEqual([name, true]); }
			// Floating hands anchor off the body (outside the sprite), and torsos' side edges may sit a cell out.
			const slack = name.startsWith("pose/") || name.startsWith("torso/") ? 20 : 0;
			for (const [x, y] of [a.anchor ?? [0, 0], ...Object.values(a.anchors ?? {})]) {
				expect([name, x >= -slack && x <= w + slack && y >= -slack && y <= a.rows.length + slack]).toEqual([name, true]);
			}
		}
		for (const [c, g] of Object.entries(CATALOG.glyphs)) { expect(g.length).toBe(5); for (const r of g) expect([c, r.length, /^[#.]+$/.test(r)]).toEqual([c, 4, true]); }
		expect(Object.keys(CATALOG.glyphs).sort().join("")).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
	});

	test("every part has the drawings its slot needs", () => {
		const need: Partial<Record<Slot, string[]>> = { head: ["xs", "std"], eyes: ["xs", "std"], mouth: ["xs", "std"], blush: ["xs", "std"], ears: ["xs", "std"], antenna: ["xs", "std"], accessory: ["xs", "std"], torso: ["small", "full"], plate: ["small", "full"], legs: ["full"] };
		for (const [s, lv] of Object.entries(need)) for (const p of CATALOG.slots[s as Exclude<Slot, "name">]) {
			if (p.id === "none") continue;
			for (const l of lv!) expect([s, p.id, l, !!p.art?.[l as "xs"]?.rows.length]).toEqual([s, p.id, l, true]);
		}
		for (const p of CATALOG.slots.pose) expect([p.id, p.arms?.length]).toEqual([p.id, 2]);
		for (const p of CATALOG.slots.palette) for (const k of ["body0", "body1", "body2", "accent0", "accent1", "accent2", "trim0", "trim1", "deep", "plateInk"]) expect([p.id, k, /^#[0-9A-F]{6}$/.test(p.colors?.[k] ?? "")]).toEqual([p.id, k, true]);
		for (const p of CATALOG.slots.screen) for (const k of ["V", "E", "e", "M", "K"]) expect([p.id, k, /^#[0-9A-F]{6}$/.test(p.colors?.[k] ?? "")]).toEqual([p.id, k, true]);
		for (const p of CATALOG.slots.dither) expect(["flat", "checker", "bayer", "scan"]).toContain(p.style!);
	});

	test("heads share one visor rect and the anchors parts attach to; faces are visor-sized", () => {
		for (const p of CATALOG.slots.head) {
			for (const [lv, [vx, vy, vw, vh]] of [["std", [3, 5, 12, 7]], ["xs", [2, 3, 8, 5]]] as const) {
				const a = p.art![lv]!;
				for (const k of ["top", "side", "earL", "earR", "visor", ...(lv === "std" ? ["neck"] : [])]) expect([p.id, lv, k, !!a.anchors?.[k]]).toEqual([p.id, lv, k, true]);
				expect(a.anchors!.visor).toEqual([vx, vy]);
				// The visor interior (corners may be rounded off) is screen, and nothing outside the rect is.
				for (let y = 0; y < a.rows.length; y++) for (let x = 0; x < a.rows[0]!.length; x++) {
					const inside = x >= vx && x < vx + vw && y >= vy && y < vy + vh;
					const corner = inside && (x === vx || x === vx + vw - 1) && (y === vy || y === vy + vh - 1);
					const v = a.rows[y]![x] === "V";
					if (!inside) expect([p.id, lv, x, y, v]).toEqual([p.id, lv, x, y, false]);
					else if (!corner) expect([p.id, lv, x, y, v]).toEqual([p.id, lv, x, y, true]);
				}
			}
		}
		for (const s of ["eyes", "mouth", "blush"] as const) for (const p of CATALOG.slots[s]) {
			expect([s, p.id, p.art!.std!.rows.length, p.art!.std!.rows[0]!.length]).toEqual([s, p.id, 7, 12]);
			expect([s, p.id, p.art!.xs!.rows.length, p.art!.xs!.rows[0]!.length]).toEqual([s, p.id, 5, 8]);
		}
		for (const p of CATALOG.slots.torso) for (const k of ["neck", "plate"]) { expect(p.art!.small!.anchors![k]).toBeDefined(); expect(p.art!.full!.anchors![k]).toBeDefined(); }
	});

	test("no role ever runs out of candidates, whatever was picked before (exhaustive over the constrained slots)", () => {
		const cons = new Set(constrainedSlots());
		for (const role of ROLES) {
			// Free slots: just non-empty.
			for (const s of PART_SLOTS) if (!cons.has(s)) expect([role, s, candidates(s, role, []).length > 0]).toEqual([role, s, true]);
			const order = PART_SLOTS.filter((s) => cons.has(s));
			let leaves = 0;
			const walk = (i: number, chosen: Array<[Slot, Part]>) => {
				if (i === order.length) { leaves++; return; }
				const c = candidates(order[i]!, role, chosen);
				if (!c.length) throw new Error(`${role}: no ${order[i]} after ${chosen.map(([s, p]) => `${s}=${p.id}`).join(" ")}`);
				for (const p of c) walk(i + 1, [...chosen, [order[i]!, p]]);
			};
			walk(0, []);
			expect(leaves).toBeGreaterThan(0);
		}
	});

	test("orchestrator traits: planners always wear the crown, leads always carry the flag, nobody else gets either", () => {
		for (const role of ROLES) {
			const ant = candidates("antenna", role, []).map((p) => p.id);
			if (role === "planner") expect(ant).toEqual(["crown"]);
			else if (role === "lead") expect(ant).toEqual(["flag"]);
			else { expect(ant).not.toContain("crown"); expect(ant).not.toContain("flag"); }
		}
	});

	test("there are millions of bots per role", () => {
		for (const role of ROLES) expect(countCombinations(role)).toBeGreaterThan(1_000_000);
	});
});
