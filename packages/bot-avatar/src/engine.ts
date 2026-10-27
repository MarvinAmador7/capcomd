// The generator: seed + role → traits (which part fills each slot) → a pixel grid at one detail level → SVG.
//
// Determinism. Every pick is weighted rendezvous hashing: candidate c with integer weight w scores
// max(h32(seed␟slot␟c.id␟k) for k in 0..<w), and the highest score wins (ties: the earlier candidate). A part wins
// with probability w/Σw, and adding a part to a slot changes only the bots that the new part wins, so the catalog can
// grow append-only without reshuffling existing agents. Shading and layout are integer math. Same seed, same role,
// same catalog version → the same grid, in any language.
import { CATALOG } from "./catalog";
import { hkey } from "./hash";
import { ROLES, SLOTS, type Art, type BotGrid, type BotTraits, type Catalog, type DitherStyle, type Part, type Pt, type Role, type Size, type Slot } from "./types";

export function normalizeRole(role?: string | null): Role {
	const r = (role ?? "").trim().toLowerCase();
	return (ROLES as readonly string[]).includes(r) ? (r as Role) : "other";
}

export function weightOf(part: Part, role: Role): number {
	return part.roles?.[role] ?? part.weight ?? 4;
}

type Chosen = Array<[Slot, Part]>;

/** Whether `cand` (for `slot`) combines with the parts already chosen. Checks both directions. */
export function compatible(cand: Part, slot: Slot, chosen: Chosen): boolean {
	for (const [s, p] of chosen) {
		if (p.excludes?.[slot]?.includes(cand.id)) return false;
		if (cand.excludes?.[s]?.includes(p.id)) return false;
		const pr = p.requires?.[slot];
		if (pr && !pr.includes(cand.id)) return false;
		const cr = cand.requires?.[s];
		if (cr && !cr.includes(p.id)) return false;
		if (cand.occupies && p.occupies && cand.occupies.some((z) => p.occupies!.includes(z))) return false;
	}
	return true;
}

/** Weighted rendezvous pick. Returns the index into `cands`. */
export function rendezvous(seed: string, slot: string, cands: Array<{ id: string; w: number }>): number {
	let best = -1, bestScore = -1;
	cands.forEach((c, i) => {
		let s = -1;
		for (let k = 0; k < c.w; k++) s = Math.max(s, hkey(seed, slot, c.id, k));
		if (s > bestScore) { bestScore = s; best = i; }
	});
	return best;
}

export function candidates(slot: Exclude<Slot, "name">, role: Role, chosen: Chosen, catalog: Catalog = CATALOG): Part[] {
	return catalog.slots[slot].filter((p) => weightOf(p, role) > 0 && compatible(p, slot, chosen));
}

export function botName(seed: string, catalog: Catalog = CATALOG): string {
	return catalog.names[rendezvous(seed, "name", catalog.names.map((n) => ({ id: n, w: 1 })))]!;
}

/** Which part fills each slot for this seed and role. */
export function botTraits(seed: string, role?: string | null, catalog: Catalog = CATALOG): BotTraits {
	const r = normalizeRole(role);
	const chosen: Chosen = [];
	const out: Record<string, string> = {};
	for (const slot of SLOTS) {
		if (slot === "name") continue;
		const cands = candidates(slot, r, chosen, catalog);
		if (!cands.length) throw new Error(`bot-avatar: no ${slot} fits ${JSON.stringify(out)} (${r})`);
		const p = cands[rendezvous(seed, slot, cands.map((c) => ({ id: c.id, w: weightOf(c, r) })))]!;
		chosen.push([slot, p]);
		out[slot] = p.id;
	}
	return { format: "bot/1", seed, role: r, name: botName(seed, catalog), ...out } as BotTraits;
}

/** Slots whose parts constrain or are constrained by another slot; the rest combine freely. */
export function constrainedSlots(catalog: Catalog = CATALOG): Array<Exclude<Slot, "name">> {
	const slots = SLOTS.filter((s): s is Exclude<Slot, "name"> => s !== "name");
	const named = new Set<string>();
	for (const s of slots) for (const p of catalog.slots[s]) {
		if (p.occupies?.length) named.add(s);
		for (const rel of [p.requires, p.excludes]) if (rel) { named.add(s); for (const k of Object.keys(rel)) named.add(k); }
	}
	return slots.filter((s) => named.has(s));
}

/**
 * How many different bots a role can get: every combination of parts (weight > 0 for the role) that passes the
 * exclusion rules. Enumerates the constrained slots, multiplies by the free ones.
 */
export function countCombinations(role: Role, catalog: Catalog = CATALOG): number {
	const slots = SLOTS.filter((s): s is Exclude<Slot, "name"> => s !== "name");
	const cons = constrainedSlots(catalog);
	const free = slots.filter((s) => !cons.includes(s)).reduce((n, s) => n * catalog.slots[s].filter((p) => weightOf(p, role) > 0).length, 1);
	const walk = (i: number, chosen: Chosen): number => {
		if (i === cons.length) return 1;
		let n = 0;
		for (const p of catalog.slots[cons[i]!]) if (weightOf(p, role) > 0 && compatible(p, cons[i]!, chosen)) n += walk(i + 1, [...chosen, [cons[i]!, p]]);
		return n;
	};
	return walk(0, []) * free;
}

// Overrides for identity moments ------------------------------------------------------------------------------------

/** Expressions a moment can ask for. They replace eyes and mouth; status is still shown by the status marks. */
export const MOODS = {
	happy: { eyes: "happy", mouth: "grin" },
	sleepy: { eyes: "sleepy", mouth: "flat" },
	oops: { eyes: "squint", mouth: "o" },
	love: { eyes: "hearts", mouth: "smile" },
} as const;
export type Mood = keyof typeof MOODS;

export interface Overrides {
	mood?: Mood;
	pose?: string;
	/** e.g. "party" for a run's finish; ignored where it clashes (a planner keeps its crown). */
	accessory?: string;
}

const part = (slot: Exclude<Slot, "name">, id: string, catalog: Catalog) => {
	const p = catalog.slots[slot].find((x) => x.id === id);
	if (!p) throw new Error(`bot-avatar: unknown ${slot} "${id}"`);
	return p;
};
const chosenOf = (t: BotTraits, catalog: Catalog): Chosen =>
	SLOTS.filter((s): s is Exclude<Slot, "name"> => s !== "name").map((s) => [s, part(s, (t as unknown as Record<string, string>)[s]!, catalog)]);

/** Apply a moment's overrides, keeping the bot valid: an accessory that no longer fits is dropped, one that clashes is skipped. */
export function withOverrides(t: BotTraits, o: Overrides = {}, catalog: Catalog = CATALOG): BotTraits {
	let n: BotTraits = { ...t };
	if (o.mood) n = { ...n, ...MOODS[o.mood] };
	if (o.pose) { part("pose", o.pose, catalog); n.pose = o.pose; }
	const rest = (slot: Slot) => chosenOf(n, catalog).filter(([s]) => s !== slot);
	if (o.accessory && o.accessory !== n.accessory) {
		const acc = part("accessory", o.accessory, catalog);
		// A requested hat may take the place of an ordinary antenna, never of a kept trait (crown, flag).
		const bare: BotTraits = { ...n, antenna: "none" };
		if (compatible(acc, "accessory", rest("accessory"))) n.accessory = o.accessory;
		else if (!part("antenna", n.antenna, catalog).keep && compatible(acc, "accessory", chosenOf(bare, catalog).filter(([s]) => s !== "accessory"))) n = { ...bare, accessory: o.accessory };
	}
	if (!compatible(part("accessory", n.accessory, catalog), "accessory", rest("accessory"))) n.accessory = "none";
	return n;
}

/**
 * `t` with one part swapped in; any other part that no longer fits gives way to the first one in catalog order that
 * does (catalog sheets, previews). Role weights are ignored: it shows what a part looks like, not what gets picked.
 */
export function withPart(t: BotTraits, slot: Exclude<Slot, "name">, id: string, catalog: Catalog = CATALOG): BotTraits {
	part(slot, id, catalog);
	const n = { ...t, [slot]: id } as BotTraits;
	const rec = n as unknown as Record<string, string>;
	for (const s of SLOTS) {
		if (s === "name" || s === slot) continue;
		const others = () => chosenOf(n, catalog).filter(([x]) => x !== s);
		if (!compatible(part(s, rec[s]!, catalog), s, others())) rec[s] = catalog.slots[s].find((p) => compatible(p, s, others()))?.id ?? rec[s]!;
	}
	return n;
}

// Rendering ---------------------------------------------------------------------------------------------------------

/** Light comes from the top left. Integer math only: returns 0 (highlight), 1 (base) or 2 (shade). */
export function tone(lx: number, ly: number, w: number, h: number, x: number, y: number, style: DitherStyle, bayer: number[][]): 0 | 1 | 2 {
	const ny = h > 1 ? Math.floor((ly * 16) / (h - 1)) : 8;
	const nx = w > 1 ? Math.floor((lx * 16) / (w - 1)) : 8;
	const L = 2 * ny + nx; // 0 (top left) .. 48 (bottom right)
	const t = bayer[y & 3]![x & 3]!;
	const even = ((x + y) & 1) === 0;
	let hi: boolean, sh: boolean;
	switch (style) {
		case "flat": hi = L <= 5; sh = L >= 40; break;
		case "checker": hi = L <= 4 || (L <= 9 && even); sh = L >= 42 || (L >= 34 && even); break;
		case "bayer": hi = L < 11 && (11 - L) * 16 > t * 11; sh = L > 31 && (L - 31) * 16 > t * 13; break;
		case "scan": hi = L <= 6 && (y & 1) === 0; sh = L >= 44 || (L >= 35 && (y & 1) === 1); break;
	}
	return hi ? 0 : sh ? 2 : 1;
}

/** The drawing a part uses at a size, if any. */
export function artFor(p: Part, size: Size, catalog: Catalog = CATALOG): Art | undefined {
	for (const k of catalog.frames[size].uses) { const a = p.art?.[k]; if (a) return a; }
	return undefined;
}

export interface Rendered extends BotGrid {
	/** Cells that fell outside the canvas (always 0 for catalog parts; tests check). */
	clipped: number;
	/** Face cells (eyes, mouth, blush) that missed the visor (always 0; tests check). */
	offVisor: number;
}

const FACE_KEYS = new Set(["E", "e", "M", "K"]);

export function botGrid(traits: BotTraits, size: Size, catalog: Catalog = CATALOG): Rendered {
	const fr = catalog.frames[size];
	const W = fr.w, H = fr.h;
	const px = new Array<number>(W * H).fill(-1);
	const kind = new Uint8Array(W * H); // 0 empty, 1 bot, 2 ground shadow
	const palette: string[] = [];
	const idx = (hex: string) => { let i = palette.indexOf(hex); if (i < 0) { i = palette.length; palette.push(hex); } return i; };
	const ch = chosenOf(traits, catalog);
	const get = (s: Slot) => ch.find(([x]) => x === s)![1];
	const pal = get("palette").colors!, k = catalog.constants;
	const scr = { ...get("screen").colors!, ...(size === "xs" ? get("screen").colorsXs : undefined) };
	const style: DitherStyle = fr.shading === "flat" ? "flat" : get("dither").style!;
	let clipped = 0, offVisor = 0;
	const onVisor = new Uint8Array(W * H);

	const color = (c: string, lx: number, ly: number, w: number, h: number, x: number, y: number): string => {
		const tn = () => tone(lx, ly, w, h, x, y, style, catalog.bayer4);
		switch (c) {
			case "B": return pal[`body${tn()}`]!;
			case "b": return pal.body2!;
			case "H": return pal.body0!;
			case "A": return pal[`accent${tn()}`]!;
			case "a": return pal.accent2!;
			case "T": return pal.trim0!;
			case "t": return pal.trim1!;
			case "P": return pal.deep!;
			case "L": return pal.plateInk!;
			case "G": return k[`metal${tn()}`]!;
			case "g": return k.metal2!;
			case "W": return k.white!;
			case "I": return k.ink!;
			case "F": return k.flame!;
			case "S": return k.shadow!;
			default: {
				const v = scr[c];
				if (!v) throw new Error(`bot-avatar: unknown pixel key "${c}"`);
				return v;
			}
		}
	};

	/** Draw `a` with its anchor on `at` (mirrored: flipped left-right, anchor flipped too). Returns its origin. */
	const draw = (a: Art | undefined, at: Pt, mirror = false, face = false): Pt => {
		if (!a || !a.rows.length) return at;
		const w = a.rows[0]!.length, h = a.rows.length;
		const an = a.anchor ?? [0, 0];
		const ox = at[0] - (mirror ? w - an[0] : an[0]), oy = at[1] - an[1];
		for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
			const key = a.rows[r]![mirror ? w - 1 - c : c]!;
			if (key === ".") continue;
			const x = ox + c, y = oy + r;
			if (x < 0 || y < 0 || x >= W || y >= H) { clipped++; continue; }
			const i = y * W + x;
			if (face && FACE_KEYS.has(key) && !onVisor[i]) offVisor++;
			onVisor[i] = key === "V" || (face && onVisor[i]) ? 1 : 0;
			// A screen with a rim colour draws the visor's border cells in it (a bezel) on small and full, so light
			// screens still read as screens.
			const sc = mirror ? w - 1 - c : c;
			const rim = key === "V" && scr.v && fr.outline && [[sc - 1, r], [sc + 1, r], [sc, r - 1], [sc, r + 1]].some(([q, s]) => a.rows[s!]?.[q!] !== "V");
			px[i] = idx(rim ? scr.v! : color(key, c, r, w, h, x, y));
			kind[i] = key === "S" ? 2 : 1;
		}
		return [ox, oy];
	};
	const add = (o: Pt, p: Pt): Pt => [o[0] + p[0], o[1] + p[1]];

	// Ground shadow, legs, torso (and its plate), arms; then the head and what hangs on it.
	const head = artFor(get("head"), size, catalog)!;
	const ho = fr.head, ha = head.anchors!;
	if (fr.shadow && catalog.ground) draw(catalog.ground, [W >> 1, H]);
	const torsoArt = artFor(get("torso"), size, catalog);
	if (torsoArt) {
		const to = draw(torsoArt, add(ho, ha.neck!));
		const ta = torsoArt.anchors!;
		if (ta.hip) draw(artFor(get("legs"), size, catalog), add(to, ta.hip));
		const plate = get("plate");
		const po = draw(artFor(plate, size, catalog), add(to, ta.plate!));
		if (plate.id === "letter" && size === "full") {
			const g = catalog.glyphs[traits.name[0]!.toUpperCase()];
			if (g) draw({ rows: g.map((r) => r.replaceAll("#", "L")), anchor: [0, 0] }, add(po, [2, 0]));
		}
		const arms = get("pose").arms;
		if (arms && ta.armL && ta.armR) { draw(arms[0], add(to, ta.armL), true); draw(arms[1], add(to, ta.armR)); }
	}
	draw(head, ho);
	const ear = artFor(get("ears"), size, catalog);
	draw(ear, add(ho, ha.earL!));
	draw(ear, add(ho, ha.earR!), true);
	const vo = add(ho, ha.visor!);
	for (const s of ["blush", "eyes", "mouth"] as const) draw(artFor(get(s), size, catalog), vo, false, true);
	draw(artFor(get("antenna"), size, catalog), add(ho, ha.top!));
	const acc = get("accessory");
	draw(artFor(acc, size, catalog), add(ho, ha[acc.attach ?? "top"]!));

	if (fr.outline) {
		const ink = idx(k.ink!);
		const edge: number[] = [];
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (kind[i] === 1) continue;
			if ((x > 0 && kind[i - 1] === 1) || (x < W - 1 && kind[i + 1] === 1) || (y > 0 && kind[i - W] === 1) || (y < H - 1 && kind[i + W] === 1)) edge.push(i);
		}
		for (const i of edge) px[i] = ink;
	}
	// Compact the palette to the colours still present, in first-use order (raster order), so output is canonical.
	const used: number[] = [];
	for (const v of px) if (v >= 0 && !used.includes(v)) used.push(v);
	const remap = new Map(used.map((v, i) => [v, i]));
	return { w: W, h: H, palette: used.map((v) => palette[v]!), px: px.map((v) => (v < 0 ? -1 : remap.get(v)!)), clipped, offVisor };
}

/** Rows of characters: "." empty, then 0-9a-z indexing the palette (golden files and debugging). */
export function gridRows(g: BotGrid): string[] {
	const rows: string[] = [];
	for (let y = 0; y < g.h; y++) {
		let r = "";
		for (let x = 0; x < g.w; x++) { const v = g.px[y * g.w + x]!; r += v < 0 ? "." : v.toString(36); }
		rows.push(r);
	}
	return rows;
}

// SVG ----------------------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface SvgOptions {
	/** CSS px (macOS points) per cell; an integer ≥ 1 so cells stay crisp. Default 1 (xs 14, small 24, full 32). */
	scale?: number;
	/** Accessible name; default "<Name>, <role>". Ignored when decorative. */
	label?: string;
	/** Next to text that already names the agent: aria-hidden, no role. */
	decorative?: boolean;
}

/**
 * The rectangles of each colour: horizontal runs, each merged with the identical run (same x and width) on the rows
 * below. Sorted by top row, then x.
 */
export function gridRects(g: BotGrid): Array<Array<[x: number, y: number, w: number, h: number]>> {
	const out = g.palette.map(() => [] as Array<[number, number, number, number]>);
	const open = new Map<string, [number, number, number, number]>(); // `${v},${x},${n}` → rect still growing
	for (let y = 0; y < g.h; y++) {
		let x = 0;
		while (x < g.w) {
			const v = g.px[y * g.w + x]!;
			let n = 1;
			while (x + n < g.w && g.px[y * g.w + x + n] === v) n++;
			if (v >= 0) {
				const key = `${v},${x},${n}`, r = open.get(key);
				if (r && r[1] + r[3] === y) r[3]++;
				else { const nr: [number, number, number, number] = [x, y, n, 1]; out[v]!.push(nr); open.set(key, nr); }
			}
			x += n;
		}
	}
	for (const rs of out) rs.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
	return out;
}

/**
 * One path per colour (palette order), one subpath per rectangle: "M x y h w v h h -w z" for the first, then each next
 * one moves relative to the previous one's corner ("m dx dy …"). Crisp edges; no scripts, no external references.
 */
export function gridSvg(g: BotGrid, o: SvgOptions & { label: string }): string {
	const scale = o.scale ?? 1;
	if (!Number.isInteger(scale) || scale < 1 || scale > 16) throw new Error("bot-avatar: scale must be an integer 1–16");
	const d = gridRects(g).map((rs) => {
		let s = "", px = 0, py = 0;
		rs.forEach(([x, y, w, h], i) => {
			s += `${i ? `m${x - px} ${y - py}` : `M${x} ${y}`}h${w}v${h}h-${w}z`;
			px = x; py = y;
		});
		return s;
	});
	const a11y = o.decorative ? `aria-hidden="true"` : `role="img" aria-label="${esc(o.label)}"`;
	const paths = g.palette.map((hex, i) => {
		const fill = hex.length === 9 ? `fill="${hex.slice(0, 7)}" fill-opacity="${(parseInt(hex.slice(7), 16) / 255).toFixed(2)}"` : `fill="${hex}"`;
		return `<path ${fill} d="${d[i]}"/>`;
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${g.w} ${g.h}" width="${g.w * scale}" height="${g.h * scale}" shape-rendering="crispEdges" ${a11y}>${paths.join("")}</svg>`;
}

export interface AvatarInput extends SvgOptions, Overrides {
	seed: string;
	role?: string | null;
	size: Size;
	/** Traits from botTeam(), when siblings were made distinct; else derived from seed and role. */
	traits?: BotTraits;
}

/** seed + role + size → SVG string. */
export function botSvg(i: AvatarInput, catalog: Catalog = CATALOG): string {
	const t = withOverrides(i.traits ?? botTraits(i.seed, i.role, catalog), i, catalog);
	return gridSvg(botGrid(t, i.size, catalog), { ...i, label: i.label ?? `${t.name}, ${t.role}` });
}

// Teams ---------------------------------------------------------------------------------------------------------------

/** Two bots read as different at a glance: different colour and one more difference, or three differences, and different names. */
export function distinct(a: BotTraits, b: BotTraits): boolean {
	if (a.name === b.name) return false;
	const diffs = [a.head !== b.head, a.eyes !== b.eyes, a.antenna !== b.antenna || a.accessory !== b.accessory, a.screen !== b.screen, a.ears !== b.ears].filter(Boolean).length;
	return a.palette !== b.palette ? diffs >= 1 : diffs >= 3;
}

export const TEAM_TRIES = 16;

/**
 * Traits for agents shown together (siblings, a tree), in spawn order. Each keeps its own bot unless it looks like one
 * earlier in the list; then it takes the first variant seed `${seed}#k` (k = 1…15) that doesn't. Earlier agents never
 * change, so pass agents in creation order and a new sibling never repaints an old one.
 */
export function botTeam(members: Array<{ seed: string; role?: string | null }>, catalog: Catalog = CATALOG): BotTraits[] {
	const out: BotTraits[] = [];
	for (const m of members) {
		let pick: BotTraits | null = null;
		for (let k = 0; k < TEAM_TRIES && !pick; k++) {
			const t = botTraits(k ? `${m.seed}#${k}` : m.seed, m.role, catalog);
			if (out.every((o) => distinct(o, t))) pick = { ...t, seed: m.seed };
		}
		out.push(pick ?? botTraits(m.seed, m.role, catalog));
	}
	return out;
}
