// The engine: deterministic, every combination composes inside the canvas with faces on the visor, output is small,
// safe SVG, bots are distinct across seeds and within a team, and the catalog can grow without repainting agents.
import { describe, expect, test } from "bun:test";
import {
	CATALOG, ROLES, SIZES, botGrid, botName, botSvg, botTeam, botTraits, compatible, distinct, gridSvg, markSvg, MENU_BAR_MARK, normalizeRole, withOverrides, withPart,
	type BotTraits, type Catalog, type Part, type Size, type Slot,
} from "../src/index";

const BASE: BotTraits = { format: "bot/1", seed: "t", role: "worker", name: "Pixel", palette: "orange-purple", antenna: "ball", accessory: "none", head: "dome", ears: "disc", screen: "night", eyes: "ovals", mouth: "smile", blush: "on", torso: "round", plate: "letter", pose: "float", legs: "boots", dither: "checker" };
const seeds = (n: number, p = "agt-") => Array.from({ length: n }, (_, i) => `${p}${(Math.imul(i + 1, 0x9e3779b1) >>> 0).toString(36)}${i}`);
const CAPS: Record<Size, number> = { xs: 2048, small: 4096, full: 6144 };
const clean = (t: BotTraits, z: Size) => { const g = botGrid(t, z); return [g.clipped, g.offVisor]; };

describe("traits", () => {
	test("same seed and role → same traits and same SVG, every time", () => {
		for (const s of seeds(50)) for (const r of ROLES) {
			expect(botTraits(s, r)).toEqual(botTraits(s, r));
			for (const z of SIZES) expect(botSvg({ seed: s, role: r, size: z })).toBe(botSvg({ seed: s, role: r, size: z }));
		}
	});

	test("roles: profiles normalise (unknown → other) and the name depends on the seed alone", () => {
		expect(normalizeRole(" Planner ")).toBe("planner");
		expect(normalizeRole("sup")).toBe("other");
		expect(normalizeRole(undefined)).toBe("other");
		for (const s of seeds(20)) for (const r of ROLES) expect(botTraits(s, r).name).toBe(botName(s));
	});

	test("picked combinations are always valid", () => {
		const slots = Object.keys(CATALOG.slots) as Array<Exclude<Slot, "name">>;
		for (const s of seeds(600)) for (const r of ROLES) {
			const t = botTraits(s, r) as unknown as Record<string, string>;
			const chosen = slots.map((x) => [x, CATALOG.slots[x].find((p) => p.id === t[x])!] as [Slot, Part]);
			for (const [x, p] of chosen) expect([s, r, x, compatible(p, x, chosen.filter(([y]) => y !== x))]).toEqual([s, r, x, true]);
		}
	});
});

describe("composition", () => {
	test("every part, swapped into a base bot, draws inside the canvas with its face on the visor, at every size", () => {
		for (const slot of Object.keys(CATALOG.slots) as Array<Exclude<Slot, "name">>) for (const p of CATALOG.slots[slot]) for (const z of SIZES) {
			expect([slot, p.id, z, ...clean(withPart(BASE, slot, p.id), z)]).toEqual([slot, p.id, z, 0, 0]);
		}
	});

	test("every head with every antenna, accessory, ears and face part composes cleanly (pairwise, all sizes)", () => {
		const others: Array<Exclude<Slot, "name">> = ["antenna", "accessory", "ears", "eyes", "mouth", "blush", "screen"];
		for (const h of CATALOG.slots.head) for (const s of others) for (const p of CATALOG.slots[s]) {
			const t = withPart(withPart(BASE, "head", h.id), s, p.id);
			if (t.head !== h.id) continue; // the pair is excluded by the rules
			for (const z of SIZES) expect([h.id, s, p.id, z, ...clean(t, z)]).toEqual([h.id, s, p.id, z, 0, 0]);
		}
	});

	test("every torso with every pose, legs and plate composes cleanly", () => {
		for (const to of CATALOG.slots.torso) for (const s of ["pose", "legs", "plate"] as const) for (const p of CATALOG.slots[s]) for (const z of SIZES) {
			expect([to.id, s, p.id, z, ...clean(withPart(withPart(BASE, "torso", to.id), s, p.id), z)]).toEqual([to.id, s, p.id, z, 0, 0]);
		}
	});

	test("hands float: at small and full, every hand is its own piece, with a clear cell between its outline and the body's", () => {
		// Flood-fill the drawn cells (anything but empty) with 4-connectivity: ink outlines touch, so a hand that is
		// joined to the body, or whose outline runs into the body's, is one component with it.
		const pieces = (t: BotTraits, z: Size) => {
			const g = botGrid(t, z), seen = new Uint8Array(g.w * g.h);
			const shadow = g.palette.indexOf(CATALOG.constants.shadow!);
			let n = 0;
			for (let i = 0; i < g.px.length; i++) {
				if (seen[i] || g.px[i]! < 0 || g.px[i] === shadow) continue;
				n++;
				const st = [i];
				seen[i] = 1;
				while (st.length) {
					const j = st.pop()!, x = j % g.w, y = (j / g.w) | 0;
					for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
						const nx = x + dx, ny = y + dy, k = ny * g.w + nx;
						if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h || seen[k] || g.px[k]! < 0 || g.px[k] === shadow) continue;
						seen[k] = 1; st.push(k);
					}
				}
			}
			return n;
		};
		const heads = CATALOG.slots.head.map((h) => h.id);
		for (const head of heads) for (const torso of CATALOG.slots.torso) {
			const t = { ...BASE, head, torso: torso.id, ears: "none", antenna: "none", accessory: "none" };
			// small: the body plus two hands.
			expect([head, torso.id, "small", pieces(t, "small")]).toEqual([head, torso.id, "small", 3]);
			// full: body + two hands, in every pose (the spark is held, so it is part of its hand).
			for (const p of CATALOG.slots.pose) expect([head, torso.id, p.id, pieces({ ...t, pose: p.id }, "full")]).toEqual([head, torso.id, p.id, 3]);
		}
	});

	test("random bots: clean, within size caps, at every size and role", () => {
		for (const s of seeds(800)) for (const r of ROLES) {
			const t = botTraits(s, r);
			for (const z of SIZES) {
				const g = botGrid(t, z);
				expect([s, r, z, g.clipped, g.offVisor]).toEqual([s, r, z, 0, 0]);
				expect(g.palette.length).toBeLessThanOrEqual(36);
				const svg = gridSvg(g, { label: "x" });
				expect(svg.length).toBeLessThanOrEqual(CAPS[z]);
			}
		}
	});

	test("the frame sizes are the documented grids", () => {
		expect([CATALOG.frames.xs.w, CATALOG.frames.xs.h, CATALOG.frames.small.w, CATALOG.frames.small.h, CATALOG.frames.full.w, CATALOG.frames.full.h]).toEqual([14, 14, 24, 24, 32, 32]);
		const g = botGrid(botTraits("agt-pl01", "planner"), "xs");
		expect([g.w, g.h, g.px.length]).toEqual([14, 14, 196]);
	});
});

describe("svg", () => {
	test("valid, self-contained, crisp, labelled, and nothing but paths", () => {
		for (const s of seeds(60)) for (const z of SIZES) {
			const svg = botSvg({ seed: s, role: "worker", size: z, scale: 2 });
			expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 `)).toBe(true);
			expect(svg).toContain(`shape-rendering="crispEdges"`);
			expect(svg).toMatch(/role="img" aria-label="[A-Z][a-z]+, worker"/);
			expect(svg).not.toMatch(/<script|href|url\(|on\w+=|<image|<foreignObject|style=/i);
			const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
			expect(inner.replace(/<path fill="#[0-9A-F]{6}"( fill-opacity="[\d.]+")? d="[Mm0-9 hvz-]+"\/>/g, "")).toBe("");
			const f = CATALOG.frames[z];
			expect(svg).toContain(`width="${f.w * 2}" height="${f.h * 2}"`);
		}
	});

	test("paths cover exactly the grid's cells", () => {
		const t = botTraits("agt-wk03", "worker");
		for (const z of SIZES) {
			const g = botGrid(t, z), svg = gridSvg(g, { label: "x" });
			const cover = new Array<number>(g.w * g.h).fill(-1);
			[...svg.matchAll(/<path fill="(#[0-9A-F]{6})"(?: fill-opacity="([\d.]+)")? d="([^"]+)"\/>/g)].forEach((m, ci) => {
				let x = 0, y = 0;
				for (const sub of m[3]!.split("z").filter(Boolean)) {
					const mm = sub.match(/^([Mm])(-?\d+) (-?\d+)h(\d+)v(\d+)h-\d+$/)!;
					if (mm[1] === "M") { x = +mm[2]!; y = +mm[3]!; } else { x += +mm[2]!; y += +mm[3]!; }
					for (let yy = y; yy < y + +mm[5]!; yy++) for (let xx = x; xx < x + +mm[4]!; xx++) { expect(cover[yy * g.w + xx]).toBe(-1); cover[yy * g.w + xx] = ci; }
				}
			});
			expect(cover).toEqual(g.px);
		}
	});

	test("decorative avatars are hidden from assistive tech; labels are escaped; scale must be a whole number", () => {
		const d = botSvg({ seed: "a", size: "xs", decorative: true });
		expect(d).toContain(`aria-hidden="true"`);
		expect(d).not.toContain("role=");
		expect(botSvg({ seed: "a", size: "xs", label: `Bo"<lt>` })).toContain(`aria-label="Bo&quot;&lt;lt&gt;"`);
		expect(() => botSvg({ seed: "a", size: "xs", scale: 1.5 })).toThrow();
		expect(() => botSvg({ seed: "a", size: "xs", scale: 0 })).toThrow();
	});

	test("the menu bar mark is 16×16 and one path", () => {
		expect(MENU_BAR_MARK.length).toBe(16);
		for (const r of MENU_BAR_MARK) expect(r).toMatch(/^[#.]{16}$/);
		expect(markSvg(MENU_BAR_MARK).match(/<path/g)!.length).toBe(1);
	});
});

describe("distinctness", () => {
	test("across many seeds: nearly every bot is unique, and most differ at a glance", () => {
		const all = seeds(2000).map((s) => botTraits(s, "worker"));
		const full = new Set(all.map(({ seed: _s, name: _n, ...t }) => JSON.stringify(t)));
		const glance = new Set(all.map((t) => [t.palette, t.head, t.eyes, t.antenna, t.accessory].join()));
		expect(full.size / all.length).toBeGreaterThan(0.98);
		expect(glance.size / all.length).toBeGreaterThan(0.6);
		// Every palette, head and eyes style actually shows up.
		for (const s of ["palette", "head", "eyes", "antenna", "accessory"] as const) {
			const used = new Set(all.map((t) => t[s]));
			for (const p of CATALOG.slots[s]) if ((p.roles?.worker ?? p.weight ?? 4) > 0) expect([s, p.id, used.has(p.id)]).toEqual([s, p.id, true]);
		}
	});

	test("botTeam: siblings are pairwise distinct, and adding one never repaints the others", () => {
		const roles = ["planner", "lead", "worker", "worker", "worker", "critic", "worker", "worker"];
		for (let g = 0; g < 300; g++) {
			const members = seeds(roles.length, `agt-g${g}-`).map((seed, i) => ({ seed, role: roles[i]! }));
			const team = botTeam(members);
			for (let i = 0; i < team.length; i++) for (let j = 0; j < i; j++) expect([g, i, j, distinct(team[i]!, team[j]!)]).toEqual([g, i, j, true]);
			expect(botTeam(members.slice(0, 5))).toEqual(team.slice(0, 5));
			expect(team.map((t) => t.seed)).toEqual(members.map((m) => m.seed));
		}
		// The first member always keeps its own bot.
		expect(botTeam([{ seed: "agt-pl01", role: "planner" }])[0]).toEqual(botTraits("agt-pl01", "planner"));
	});
});

describe("stability", () => {
	test("appending a part to a slot repaints only the bots it wins, and no other slot", () => {
		const grown: Catalog = structuredClone(CATALOG);
		grown.slots.head.push({ ...structuredClone(CATALOG.slots.head[0]!), id: "dome2", weight: 4 });
		grown.slots.eyes.push({ ...structuredClone(CATALOG.slots.eyes[0]!), id: "ovals2", weight: 4 });
		const ss = seeds(1500);
		let sameHead = 0, sameEyes = 0;
		for (const s of ss) {
			const a = botTraits(s, "worker"), b = botTraits(s, "worker", grown);
			expect([a.palette, a.antenna, a.accessory, a.name]).toEqual([b.palette, b.antenna, b.accessory, b.name]);
			if (b.head === a.head) sameHead++; else expect(b.head).toBe("dome2");
			if (b.eyes === a.eyes) sameEyes++; else expect(b.eyes).toBe("ovals2");
		}
		expect(sameHead / ss.length).toBeGreaterThan(0.8);
		expect(sameEyes / ss.length).toBeGreaterThan(0.8);
	});
});

describe("contrast", () => {
	const lum = (hex: string) => {
		const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
		return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
	};
	const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
	const HUD = "#2E3B39"; // the lightest tree-row background measured in brand/panel-tree.png

	test("faces read: eyes on the screen ≥ 4.4:1, and the screen on every body it may sit on ≥ 3:1 at xs (bezel at small/full)", () => {
		for (const s of CATALOG.slots.screen) {
			for (const z of ["std", "xs"] as const) {
				const c = { ...s.colors!, ...(z === "xs" ? s.colorsXs : {}) };
				expect([s.id, z, ratio(c.E!, c.V!) >= 4.4]).toEqual([s.id, z, true]);
				for (const p of CATALOG.slots.palette) {
					if (s.excludes?.palette?.includes(p.id)) continue;
					const edge = z === "std" && c.v ? c.v : c.V!;
					expect([s.id, z, p.id, ratio(edge, p.colors!.body1!) >= 3]).toEqual([s.id, z, p.id, true]);
				}
			}
		}
	});

	test("silhouettes on the HUD: every body's highlight ≥ 4.5:1 and base ≥ 2.5:1 (small and full add an ink outline)", () => {
		for (const p of CATALOG.slots.palette) {
			expect([p.id, ratio(p.colors!.body0!, HUD) >= 4.5]).toEqual([p.id, true]);
			expect([p.id, ratio(p.colors!.body1!, HUD) >= 2.5]).toEqual([p.id, true]);
		}
	});
});

describe("moments", () => {
	test("moods change the face only; a party hat replaces an ordinary antenna but never the crown or the flag", () => {
		const w = { ...BASE };
		const happy = withOverrides(w, { mood: "happy" });
		expect([happy.eyes, happy.mouth]).toEqual(["happy", "grin"]);
		expect({ ...happy, eyes: w.eyes, mouth: w.mouth }).toEqual(w);
		const party = withOverrides(w, { accessory: "party", pose: "cheer" });
		expect([party.accessory, party.antenna, party.pose]).toEqual(["party", "none", "cheer"]);
		for (const s of seeds(40)) {
			const p = withOverrides(botTraits(s, "planner"), { accessory: "party" });
			expect([p.antenna, p.accessory]).toEqual(["crown", botTraits(s, "planner").accessory]);
			expect(withOverrides(botTraits(s, "lead"), { accessory: "party" }).antenna).toBe("flag");
		}
		// A mood that no longer fits the monocle drops it.
		const mono = { ...BASE, role: "critic" as const, accessory: "monocle", eyes: "ovals" };
		expect(withOverrides(mono, { mood: "oops" }).accessory).toBe("none");
		for (const z of SIZES) for (const m of ["happy", "sleepy", "oops", "love"] as const) expect(clean(withOverrides(botTraits("agt-cr01", "critic"), { mood: m, pose: "cheer", accessory: "party" }), z)).toEqual([0, 0]);
	});
});
