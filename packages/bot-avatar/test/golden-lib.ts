// What the golden files hold. fixtures/catalog.json is the catalog, expanded, for other languages' renderers;
// fixtures/golden/bots.json pins the hash, the PRNG, a set of seeds × roles at every size (traits and pixel rows)
// and a few SVG strings, so a port (the Swift renderer) can check itself bit for bit.
import { CATALOG, MENU_BAR_MARK, ROLES, SIZES, botGrid, botSvg, botTeam, botTraits, gridRows, h32, mulberry32, withOverrides } from "../src/index";

export const HASH_VECTORS = ["", "a", "agt-pl01", "agt-mh2x4k1a9b3c7d", "agt-k3f9a0c1d2e4b5a6", "héllo wörld ✓", "agt-wk03\u001fhead\u001fdome\u001f0"];
export const SEEDS = ["agt-pl01", "agt-ld01", "agt-wk01", "agt-wk02", "agt-wk03", "agt-cr01", "agt-mh2x4k1a9b3c7d", "agt-k3f9a0c1d2e4b5a6", "sup-7", "x"];

export function catalogJson(): string {
	return `${JSON.stringify(CATALOG, null, 1)}\n`;
}

export function golden() {
	const cases = SEEDS.flatMap((seed, i) => [ROLES[i % ROLES.length]!, ...(i < 2 ? ROLES.filter((r) => r !== ROLES[i % ROLES.length]) : [])].map((role) => {
		const traits = botTraits(seed, role);
		return {
			seed, role, traits,
			sizes: Object.fromEntries(SIZES.map((z) => { const g = botGrid(traits, z); return [z, { palette: g.palette, rows: gridRows(g) }]; })),
		};
	}));
	const r = mulberry32(h32("agt-pl01"));
	const team = botTeam([{ seed: "agt-pl01", role: "planner" }, { seed: "agt-ld01", role: "lead" }, { seed: "agt-wk01", role: "worker" }, { seed: "agt-wk01", role: "worker" }, { seed: "agt-wk02", role: "worker" }]);
	const moment = withOverrides(botTraits("agt-wk02", "worker"), { mood: "happy", pose: "cheer", accessory: "party" });
	return {
		format: "bot-golden/1",
		catalog: CATALOG.format,
		hash: HASH_VECTORS.map((s) => ({ s, h32: h32(s) })),
		mulberry32: { seed: h32("agt-pl01"), first: Array.from({ length: 8 }, () => r()) },
		cases,
		team: team.map((t) => ({ seed: t.seed, name: t.name, palette: t.palette, head: t.head, eyes: t.eyes, antenna: t.antenna })),
		moment: { traits: moment, full: gridRows(botGrid(moment, "full")) },
		svg: [
			{ input: { seed: "agt-pl01", role: "planner", size: "xs" as const }, svg: botSvg({ seed: "agt-pl01", role: "planner", size: "xs" }) },
			{ input: { seed: "agt-wk03", role: "worker", size: "small" as const, scale: 2 }, svg: botSvg({ seed: "agt-wk03", role: "worker", size: "small", scale: 2 }) },
			{ input: { seed: "agt-cr01", role: "critic", size: "full" as const, scale: 2, decorative: true }, svg: botSvg({ seed: "agt-cr01", role: "critic", size: "full", scale: 2, decorative: true }) },
		],
		menuBarMark: MENU_BAR_MARK,
	};
}

export function goldenJson(): string {
	return `${JSON.stringify(golden(), null, 1)}\n`;
}
