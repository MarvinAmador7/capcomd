// The bot body-parts catalog. Plain data: every part is pixel rows on a shared grid with anchor points, so any
// combination composes cleanly. `bun scripts/golden.ts` exports it, expanded, to fixtures/catalog.json for other
// languages (the Swift renderer reads that file; it never needs this one).
//
// Pixel keys (one character per cell; "." is empty):
//   B body (shaded)   b body shade   H body highlight   P plate (body deep)   L plate ink
//   A accent (shaded) a accent shade
//   T trim            t trim shade   (the contrasting brand colour: crowns, flags, hats)
//   G metal (shaded)  g metal shade  W white   I ink   F cyan glow
//   V visor screen    E eye          e eye glint   M mouth   K blush   (screen colours)
//
// Grids. xs is 14×14 (head only, lands on the 14 pt icon grid at 1 cell = 1 pt). small is 24×24 (head and shoulders,
// 1 cell = 1 pt at 24 pt). full is 32×32 (whole body, 1 cell = 2 pt at 64 pt or 3 pt at 96 pt). Heads are 18×15 on
// small/full and 12×10 on xs, and every head puts its visor at the same rect (3,5 12×7; xs 2,3 8×5), so every face
// fits every head.
import type { Art, Catalog, Part, Pt } from "./types";

/** Mirror left halves into full rows (even widths). */
function sym(half: string[]): string[] {
	return half.map((r) => r + [...r].reverse().join(""));
}
function art(rows: string[], anchor?: Pt, anchors?: Record<string, Pt>): Art {
	return { rows, ...(anchor ? { anchor } : {}), ...(anchors ? { anchors } : {}) };
}
const blank = (w: number) => ".".repeat(w);
/** A 12×7 visor overlay from rows by index (others blank). */
function face(rows: Record<number, string>, h = 7, w = 12): Art {
	return art(Array.from({ length: h }, (_, i) => rows[i] ?? blank(w)), [0, 0]);
}
const xsFace = (rows: Record<number, string>) => face(rows, 5, 8);

// Heads ------------------------------------------------------------------------------------------------------------

const HEAD_STD = (topY: number, ear: number, extra: Record<string, Pt> = {}): Record<string, Pt> => ({
	top: [9, topY], side: [14, topY + 1], earL: [ear, 8], earR: [18 - ear, 8], neck: [9, 15], visor: [3, 5], ...extra,
});
const HEAD_XS = (topY: number, ear: number): Record<string, Pt> => ({
	top: [6, topY], side: [9, topY + 1], earL: [ear, 5], earR: [12 - ear, 5], visor: [2, 3],
});

const heads: Part[] = [
	{
		id: "dome", label: "Dome", weight: 6, roles: { planner: 8, lead: 6 },
		art: {
			std: art(sym([
				".......BB", ".....BBBB", "...BBBBBB", "..BBBBBBB", ".BBBBBBBB",
				".BBBVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", ".BBBVVVVV",
				"BBBBBBBBB", ".BBBBBBBB", "..BBBBBBB",
			]), undefined, HEAD_STD(0, 0)),
			xs: art(sym(["....BB", "..BBBB", ".BBBBB", ".BBVVV", "BBVVVV", "BBVVVV", "BBVVVV", ".BBVVV", "BBBBBB", ".BBBBB"]), undefined, HEAD_XS(0, 0)),
		},
	},
	{
		id: "round", label: "Round", weight: 5,
		art: {
			std: art(sym([
				"......BBB", "....BBBBB", "..BBBBBBB", ".BBBBBBBB", ".BBBBBBBB",
				"BBBBVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBBVVVVV",
				".BBBBBBBB", "..BBBBBBB", "....BBBBB",
			]), undefined, HEAD_STD(0, 0, { side: [13, 1] })),
			xs: art(sym(["...BBB", ".BBBBB", "BBBBBB", "BBBVVV", "BBVVVV", "BBVVVV", "BBVVVV", "BBBVVV", ".BBBBB", "...BBB"]), undefined, HEAD_XS(0, 0)),
		},
	},
	{
		id: "square", label: "Square", weight: 4, roles: { critic: 6 },
		art: {
			std: art(sym([
				".........", ".BBBBBBBB", "BGBBBBBBB", "BBBBBBBBB", "BBBBBBBBB",
				"BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV",
				"BBBBBBBBB", "BBBBBBBBB", ".BBBBBBBB",
			]), undefined, HEAD_STD(1, 0, { side: [15, 1] })),
			xs: art(sym([".BBBBB", "BGBBBB", "BBBBBB", "BBVVVV", "BBVVVV", "BBVVVV", "BBVVVV", "BBVVVV", "BBBBBB", ".BBBBB"]), undefined, HEAD_XS(0, 0)),
		},
	},
	{
		id: "octagon", label: "Octagon", weight: 4,
		art: {
			std: art(sym([
				"....BBBBB", "...BBBBBB", "..BBBBBBT", ".BBBBBBBB", "BBBBBBBBB",
				"BBBBVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBBVVVVV",
				".BBBBBBBB", "..BBBBBBB", "...BBBBBB",
			]), undefined, HEAD_STD(0, 0, { side: [14, 1] })),
			xs: art(sym(["..BBBB", ".BBBBB", "BBBBBT", "BBBVVV", "BBVVVV", "BBVVVV", "BBVVVV", "BBBVVV", ".BBBBB", "..BBBB"]), undefined, HEAD_XS(0, 0)),
		},
	},
	{
		id: "capsule", label: "Capsule", weight: 4,
		art: {
			std: art(sym([
				"......BBB", "....BBBBB", "...BBBBBB", "..BBBBBBB", ".BBBBBBBB",
				".BBBVVVVV", ".BBVVVVVV", ".BBVVVVVV", ".BBVVVVVV", ".BBVVVVVV", ".BBVVVVVV", ".BBBVVVVV",
				".BBBBBBBB", "..BBBBBBB", "....BBBBB",
			]), undefined, HEAD_STD(0, 1, { side: [13, 1] })),
			xs: art(sym(["...BBB", "..BBBB", ".BBBBB", ".BBVVV", ".BVVVV", ".BVVVV", ".BVVVV", ".BBVVV", ".BBBBB", "..BBBB"]), undefined, HEAD_XS(0, 1)),
		},
	},
	{
		id: "helm", label: "Helm (crest)", weight: 3,
		excludes: { antenna: ["ball", "bolt", "dish"] },
		art: {
			std: art(sym([
				"......TTT", ".....BTTT", "...BBBBBB", "..BBBBBBB", ".BBBBBBBB",
				".BBBVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", "BBBVVVVVV", ".BBBVVVVV",
				"BBBBBBBBB", ".BBBBBBBB", "..BBBBBBB",
			]), undefined, HEAD_STD(0, 0)),
			xs: art(sym(["....TT", "..BBTT", ".BBBBB", ".BBVVV", "BBVVVV", "BBVVVV", "BBVVVV", ".BBVVV", "BBBBBB", ".BBBBB"]), undefined, HEAD_XS(0, 0)),
		},
	},
];

// Screens (visor colours) --------------------------------------------------------------------------------------------

const screens: Part[] = [
	// Measured from the brand full-body sheet: near-black visor, cyan eyes and smile, white glint, magenta blush.
	{ id: "night", label: "Night (cyan eyes)", weight: 8, colors: { V: "#07101A", E: "#36D6DE", e: "#ECFFFE", M: "#5DE2DF", K: "#C065D0" } },
	// The brand xs bots: deep purple visor, white eyes.
	{ id: "plum", label: "Plum (white eyes)", weight: 4, colors: { V: "#2A0D52", E: "#FFFFFF", e: "#FFFFFF", M: "#E9DDFB", K: "#E07ACD" } },
	// The brand small bots: purple screen, ink eyes with a white glint. Not on purple bodies (it would vanish).
	{ id: "lilac", label: "Lilac (ink eyes)", weight: 4, excludes: { palette: ["purple", "purple-orange", "lavender"] }, colors: { V: "#9457DC", v: "#2B0E57", E: "#0B0614", e: "#FFFFFF", M: "#0B0614", K: "#F7A3DA" },
		// At xs there is no bezel, so the screen darkens (3.3:1 on orange) and the eyes turn white.
		colorsXs: { V: "#5E2BA8", E: "#FFFFFF", e: "#FFFFFF", M: "#FFFFFF" } },
];

// Eyes (12×7 visor overlays; xs 8×5) -------------------------------------------------------------------------------

const eyes: Part[] = [
	{ id: "ovals", label: "Ovals", weight: 8, art: { std: face({ 1: "..eE....eE..", 2: "..EE....EE..", 3: "..EE....EE.." }), xs: xsFace({ 1: ".eE..eE.", 2: ".EE..EE." }) } },
	{ id: "dots", label: "Dots", weight: 5, art: { std: face({ 2: "..EE....EE..", 3: "..EE....EE.." }), xs: xsFace({ 1: "..E..E..", 2: "..E..E.." }) } },
	{ id: "wide", label: "Wide", weight: 4, art: { std: face({ 1: ".eEE....eEE.", 2: ".EEE....EEE.", 3: ".EEE....EEE." }), xs: xsFace({ 1: ".eE..eE.", 2: ".EE..EE.", 3: ".EE..EE." }) } },
	{ id: "happy", label: "Happy arcs", weight: 5, art: { std: face({ 2: "..EE....EE..", 3: ".E..E..E..E." }), xs: xsFace({ 1: ".E....E.", 2: "E.E..E.E" }) } },
	{ id: "wink", label: "Wink", weight: 3, art: { std: face({ 1: "..eE........", 2: "..EE....EE..", 3: "..EE...E..E." }), xs: xsFace({ 1: ".eE...E.", 2: ".EE..E.E" }) } },
	{ id: "sleepy", label: "Sleepy", weight: 2, roles: { critic: 1 }, art: { std: face({ 3: ".EEEE..EEEE." }), xs: xsFace({ 2: "EEE..EEE" }) } },
	{ id: "squint", label: "Squint ><", weight: 2, art: { std: face({ 1: ".EE......EE.", 2: "...EE..EE...", 3: ".EE......EE." }), xs: xsFace({ 1: "E......E", 2: ".E....E.", 3: "E......E" }) } },
	{ id: "bar", label: "Scanner bar", weight: 2, roles: { critic: 4 }, art: { std: face({ 2: "..eEEEEEEE..", 3: "...EEEEEE..." }), xs: xsFace({ 2: ".EEEEEE." }) } },
	{ id: "hearts", label: "Hearts", weight: 1, art: { std: face({ 1: ".K.K....K.K.", 2: ".KKK....KKK.", 3: "..K......K.." }), xs: xsFace({ 1: "K.K..K.K", 2: "KKK..KKK", 3: ".K....K." }) } },
];

const mouths: Part[] = [
	{ id: "smile", label: "Smile", weight: 8, art: { std: face({ 5: "...M....M...", 6: "....MMMM...." }), xs: xsFace({ 4: "..MMMM.." }) } },
	{ id: "small", label: "Small smile", weight: 5, art: { std: face({ 5: "....M..M....", 6: ".....MM....." }), xs: xsFace({ 4: "...MM..." }) } },
	{ id: "grin", label: "Grin", weight: 3, art: { std: face({ 5: "...MMMMMM...", 6: "....MMMM...." }), xs: xsFace({ 3: "..MMMM..", 4: "...MM..." }) } },
	{ id: "cat", label: "Cat ω", weight: 3, art: { std: face({ 5: "...M.MM.M...", 6: "....M..M...." }), xs: xsFace({ 4: "..M..M.." }) } },
	{ id: "flat", label: "Flat", weight: 2, roles: { critic: 4 }, art: { std: face({ 6: "....MMMM...." }), xs: xsFace({ 4: "..MMMM.." }) } },
	{ id: "o", label: "O", weight: 2, art: { std: face({ 5: ".....MM.....", 6: ".....MM....." }), xs: xsFace({ 4: "...MM..." }) } },
	{ id: "none", label: "None", weight: 1, art: { std: face({}), xs: xsFace({}) } },
];

const blushes: Part[] = [
	{ id: "on", label: "Blush", weight: 6, roles: { critic: 3 }, art: { std: face({ 4: "KK........KK" }), xs: xsFace({ 3: "K......K" }) } },
	{ id: "none", label: "No blush", weight: 4, art: { std: face({}), xs: xsFace({}) } },
];

// Ears (left; the right ear is the left one mirrored) ----------------------------------------------------------------

const ears: Part[] = [
	{ id: "disc", label: "Metal disc", weight: 7, occupies: ["ears"], art: { std: art([".G", "GG", "GG", "GG", ".G"], [2, 2]), xs: art(["G", "G", "G"], [1, 1]) } },
	{ id: "pod", label: "Pod", weight: 5, occupies: ["ears"], art: { std: art([".A", "AA", "AA", "AA", ".A"], [2, 2]), xs: art(["A", "A", "A"], [1, 1]) } },
	{ id: "bolt", label: "Bolt", weight: 3, occupies: ["ears"], art: { std: art(["GG", "GG", "GG"], [2, 1]), xs: art(["G", "G"], [1, 1]) } },
	{ id: "none", label: "None", weight: 1, art: {} },
];

// Antennas (anchor = the cell just under the stem's centre) -----------------------------------------------------------

const antennas: Part[] = [
	{ id: "ball", label: "Ball", weight: 8, occupies: ["top"], roles: { planner: 0, lead: 0 }, art: { std: art([".AA.", "AAAA", ".AA.", ".GG."], [2, 4]), xs: art(["AA", "GG"], [1, 2]) } },
	{ id: "dual", label: "Dual", weight: 4, occupies: ["top"], roles: { planner: 0, lead: 0 }, art: { std: art(["AA....AA", ".G....G.", "..G..G.."], [4, 3]), xs: art(["A....A", ".G..G."], [3, 2]) } },
	{ id: "bolt", label: "Bolt", weight: 3, occupies: ["top"], roles: { planner: 0, lead: 0, worker: 4 }, art: { std: art(["..TT", ".TT.", "TTTT", ".TT."], [2, 4]), xs: art([".T", "TT", "T."], [1, 3]) } },
	{ id: "tab", label: "Tab", weight: 3, occupies: ["top"], roles: { planner: 0, lead: 0 }, art: { std: art([".AAAA.", "AAAAAA"], [3, 2]), xs: art(["AAAA"], [2, 1]) } },
	{ id: "dish", label: "Dish", weight: 2, occupies: ["top"], roles: { planner: 0, lead: 0, critic: 6 }, art: { std: art(["G....G", "GG..GG", ".GGGG.", "..GG.."], [3, 4]), xs: art(["G..G", ".GG."], [2, 2]) } },
	{ id: "none", label: "None", weight: 3, roles: { planner: 0, lead: 0 }, art: {} },
	// Orchestrator traits: only planners wear the crown and only leads carry the flag (lead's SF Symbol is a flag).
	{ id: "crown", label: "Crown (planner)", weight: 0, keep: true, occupies: ["top"], roles: { planner: 1 }, art: { std: art(["T..TT..T", "TT.TT.TT", "TTTEETTT", "TTTTTTTT"], [4, 3]), xs: art(["T.TT.T", "TTTTTT"], [3, 2]) } },
	{ id: "flag", label: "Flag (lead)", weight: 0, keep: true, occupies: ["top"], roles: { lead: 1 }, art: { std: art(["...GTTTT", "...GTTT.", "...GTTTT", "...G...."], [4, 4]), xs: art(["GTT", "GT.", "G.."], [1, 3]) } },
];

// Accessories -------------------------------------------------------------------------------------------------------

const ROUND_TOPS = ["dome", "round", "capsule", "octagon"];
const accessories: Part[] = [
	{ id: "none", label: "None", weight: 10, art: {} },
	{
		id: "cap", label: "Cap", weight: 2, roles: { worker: 3, planner: 0, lead: 0 }, occupies: ["top"], requires: { head: ROUND_TOPS },
		art: {
			std: art(["......TTTTTT........", "....TTTTTTTTTT......", "...TTTTTTTTTTTT.....", "..TTTTTTTTTTTTTT....", ".TTTTTTTTTTTTTTTTTTT", "..tttttttttttttt...."], [9, 2]),
			xs: art(["....TTTT.....", "..TTTTTTTT...", ".TTTTTTTTTTTT"], [6, 1]),
		},
	},
	{
		id: "hardhat", label: "Hard hat", weight: 1, roles: { worker: 3, planner: 0, lead: 0, critic: 0 }, occupies: ["top"],
		art: {
			std: art(["......TTTTTT......", "....TTTTTTTTTT....", "...TTTTTTTTTTTT...", "..TTTTTTTTTTTTTT..", "..TTTTTTTTTTTTTT..", "tttttttttttttttttt"], [9, 2]),
			xs: art(["...TTTTTT...", "..TTTTTTTT..", "tttttttttttt"], [6, 2]),
		},
	},
	{
		id: "headlamp", label: "Headlamp", weight: 2, roles: { worker: 3, planner: 0, lead: 0 }, occupies: ["top"],
		art: { std: art([".GGGG.", "GGWWGG", "GWFFWG", "GGWWGG", ".GGGG."], [3, 3]), xs: art([".GG.", "GWWG", ".GG."], [2, 2]) },
	},
	{
		id: "party", label: "Party hat", weight: 1, roles: { planner: 0, lead: 0 }, occupies: ["top"],
		art: { std: art(["...WW...", "...TT...", "..AAAA..", "..TTTT..", ".TTTTTT."], [4, 4]), xs: art([".WW.", ".TT.", "TTTT"], [2, 3]) },
	},
	{
		id: "bow", label: "Bow", weight: 2, roles: { critic: 1 }, occupies: ["side"], attach: "side",
		art: { std: art(["TT...TT", "TTTtTTT", "TTTtTTT", "TT...TT"], [3, 2]), xs: art(["T.T", "TtT", "T.T"], [1, 1]) },
	},
	{
		id: "monocle", label: "Monocle", weight: 0, roles: { critic: 6, other: 1 }, occupies: ["eyeR"], attach: "visor", requires: { eyes: ["ovals", "dots"] },
		art: {
			std: art([".......GGGG.", ".......G..G.", ".......G..G.", ".......G..G.", ".......GGGG.", "..........G.", "..........G."], [0, 0]),
			xs: art(["....GGGG", "....G..G", "....G..G", "....GGGG"], [0, 0]),
		},
	},
	{
		id: "headphones", label: "Headphones", weight: 1, roles: { critic: 2, planner: 0, lead: 0 }, occupies: ["top", "ears"],
		art: {
			std: art([
				"......GGGGGGGGGG......", "....GG..........GG....", "...G..............G...", "..G................G..", "..G................G..",
				".G..................G.", ".G..................G.", "AAA................AAA", "AAA................AAA", "AAA................AAA",
				"AAA................AAA", "AAA................AAA", ".A..................A.",
			], [11, 2]),
			xs: art(["....GGGGGG....", "..GG......GG..", ".G..........G.", ".G..........G.", "AA..........AA", "AA..........AA", "AA..........AA"], [7, 2]),
		},
	},
];

// Torsos, chest plates, poses, legs -------------------------------------------------------------------------------

// Hands float: no shoulders or arms join them to the body. Between a body and a hand there are three cells, the
// body's ink outline, one clear cell and the hand's outline, so the gap reads at small and full. On small the hands
// are part of the bust drawing (22 wide, centred under the head; the left one floats a cell higher); on full they
// come from the pose. torso.armL / armR are the body's side edges the pose's hands keep their distance from.
const torsos: Part[] = [
	{
		id: "round", label: "Round", weight: 5,
		art: {
			small: art(["......BBBBBBBBBB......", "AA...BBBBBBBBBBBB.....", "AA...BBBBBBBBBBBB...AA", "AA...BBBBBBBBBBBB...AA"], [11, 0], { neck: [11, 0], plate: [7, 1] }),
			full: art(sym(["..BBBBB", ".BBBBBB", "BBBBBBB", "BBBBBBB", "BBBBBBB", ".BBBBBB", "..BBBBB"]), [7, 0], { neck: [7, 0], plate: [3, 1], armL: [0, 1], armR: [14, 1], hip: [7, 7] }),
		},
	},
	{
		id: "box", label: "Box", weight: 4,
		art: {
			small: art([".....BBBBBBBBBBBB.....", "AA...BBBBBBBBBBBB.....", "AA...BBBBBBBBBBBB...AA", "AA...BBBBBBBBBBBB...AA"], [11, 0], { neck: [11, 0], plate: [7, 1] }),
			full: art(sym([".BBBBBB", "BBBBBBB", "BBBBBBB", "BBBBBBB", "BBBBBBB", "bbbbbbb", ".BBBBBB"]), [7, 0], { neck: [7, 0], plate: [3, 1], armL: [0, 1], armR: [14, 1], hip: [7, 7] }),
		},
	},
	{
		id: "slim", label: "Slim", weight: 3,
		art: {
			small: art([".......BBBBBBBB.......", "AA.....BBBBBBBB.......", "AA.....BBBBBBBB.....AA", "AA.....BBBBBBBB.....AA"], [11, 0], { neck: [11, 0], plate: [7, 1] }),
			// Slim's edges sit a cell out so its floating hands land where the wider torsos' do (clear of every head).
			full: art(sym([".BBBBB", "BBBBBB", "BBBBBB", "BBBBBB", "BBBBBB", "BBBBBB", ".BBBBB"]), [6, 0], { neck: [6, 0], plate: [2, 1], armL: [-1, 1], armR: [13, 1], hip: [6, 7] }),
		},
	},
];

const plates: Part[] = [
	{ id: "heart", label: "Heart", weight: 5, art: { small: art(["PLLPPLLP", "PLLLLLLP", "PPPLLPPP"], [0, 0]), full: art(["PLLPPLLP", "PLLLLLLP", "PLLLLLLP", "PPLLLLPP", "PPPLLPPP"], [0, 0]) } },
	{ id: "logo", label: "capcomd mark", weight: 4, roles: { planner: 8, lead: 6 }, art: { small: art(["PPLLLLPP", "PLPLLPLP", "PPLLLLPP"], [0, 0]), full: art(["PPLLLLPP", "PLPPPPLP", "PLPLLPLP", "PLPPPPLP", "PPLLLLPP"], [0, 0]) } },
	// The letter plate draws the bot's name initial (glyphs below) at full size; small shows a name tag.
	{ id: "letter", label: "Letter block", weight: 4, art: { small: art(["PPPPPPPP", "PPLLLLPP", "PPPPPPPP"], [0, 0]), full: art(["PPPPPPPP", "PPPPPPPP", "PPPPPPPP", "PPPPPPPP", "PPPPPPPP"], [0, 0]) } },
	{ id: "screen", label: "Pulse screen", weight: 3, art: { small: art(["PPPFPPPP", "FFFPFPFF", "PPPPPFPP"], [0, 0]), full: art(["PPPPPPPP", "PPPFPPPP", "FFFPFPFF", "PPPPPFPP", "PPPPPPPP"], [0, 0]) } },
	{ id: "vent", label: "Vent", weight: 3, art: { small: art(["PLLLLLLP", "PPPPPPPP", "PLLLLLLP"], [0, 0]), full: art(["PPPPPPPP", "PLLLLLLP", "PPPPPPPP", "PLLLLLLP", "PPPPPPPP"], [0, 0]) } },
	{ id: "none", label: "None", weight: 2, art: {} },
];

// Floating hands (full body). Each is drawn as the viewer's right hand; its anchor is the torso side edge it floats
// off (torso.armR, canvas x 23 on a 14-wide torso), so anchors sit outside the sprite: [-3, …] leaves the three-cell
// gap. The left hand is the same sprite mirrored about torso.armL. Mechanical forms only: a round mitt, a tilted mitt
// held up, a mitt with a cyan spark above it. No shoulders, elbows, fingers or thumbs.
const MITT = [".AA.", "AAAA", "AAAA", ".AA."];
const HAND_SIDE = art(MITT, [-3, -1]); // beside the torso, one row down
const HAND_SIDE_HI = art(MITT, [-3, 0]); // the other side floats a row higher (a static bob)
const HAND_UP = art(["AA.", "AAA", "AAA", ".AA"], [-5, 15]); // raised beside the head, above the ear
const HAND_SPARK = art([".F.", "FWF", ".F.", "...", "AAA", "AAA", ".A."], [-5, 18]); // holding a ✦ spark up
/** Poses (full body only): [left hand, right hand]. "cheer" is for celebrations (a pose override), never picked. */
const poses: Part[] = [
	{ id: "float", label: "Float", weight: 8, arms: [HAND_SIDE_HI, HAND_SIDE] },
	{ id: "wave", label: "Wave", weight: 3, arms: [HAND_SIDE_HI, HAND_UP] },
	{ id: "spark", label: "Spark", weight: 2, roles: { critic: 4 }, arms: [HAND_SIDE_HI, HAND_SPARK] },
	{ id: "cheer", label: "Cheer", weight: 0, arms: [HAND_UP, HAND_UP] },
];

const legs: Part[] = [
	{ id: "boots", label: "Boots", weight: 8, art: { full: art(["..BB....BB..", "..BB....BB..", ".AAAA..AAAA.", "AAAAA..AAAAA"], [6, 0]) } },
	{ id: "hover", label: "Hover jet", weight: 2, art: { full: art(["...GGGGGG...", "....FFFF....", ".....FF....."], [6, 0]) } },
	{ id: "treads", label: "Treads", weight: 2, roles: { worker: 3 }, art: { full: art([".GGGGGGGGGG.", "GgGgGgGgGgGG", ".GGGGGGGGGG."], [6, 0]) } },
];

const palettes: Part[] = [
	// Sampled from the brand sheets (wordmark #FF6E00–#FF7000, bots #FA6A0C–#F9881E; purple #732EBD–#9C5ED6), lifted
	// a step so purples hold up on the dark HUD instead of pure black.
	{ id: "orange", label: "Orange (primary)", weight: 1, roles: { planner: 6, lead: 3 }, colors: { body0: "#FFB566", body1: "#FF7410", body2: "#C8530E", accent0: "#FFB566", accent1: "#E8650C", accent2: "#A8420A", trim0: "#9457DC", trim1: "#5E2BA8", deep: "#4A1A06", plateInk: "#FF9A40" } },
	{ id: "purple", label: "Purple", weight: 3, roles: { planner: 0, lead: 1, critic: 4 }, colors: { body0: "#CDAAF5", body1: "#9457DC", body2: "#5E2BA8", accent0: "#CDAAF5", accent1: "#8247CC", accent2: "#4E2390", trim0: "#FF7410", trim1: "#C8530E", deep: "#2B0E57", plateInk: "#C59BF5" } },
	// The brand mixes: one colour's body dithers into the other in its shadows.
	{ id: "orange-purple", label: "Orange / purple", weight: 3, roles: { planner: 2, lead: 3 }, colors: { body0: "#FFB566", body1: "#FF7410", body2: "#8F4FD6", accent0: "#CDAAF5", accent1: "#9457DC", accent2: "#5E2BA8", trim0: "#9457DC", trim1: "#5E2BA8", deep: "#2B0E57", plateInk: "#FF9A40" } },
	{ id: "purple-orange", label: "Purple / orange", weight: 3, roles: { planner: 0, lead: 2 }, colors: { body0: "#CDAAF5", body1: "#9457DC", body2: "#D2601A", accent0: "#FFB566", accent1: "#FF7410", accent2: "#C8530E", trim0: "#FF7410", trim1: "#C8530E", deep: "#2B0E57", plateInk: "#FF9A40" } },
	// Extras that stay on brand: they keep orange or purple as the accent.
	{ id: "lavender", label: "Lavender", weight: 2, roles: { planner: 0, lead: 1, critic: 3 }, colors: { body0: "#F1E8FF", body1: "#BFA3F5", body2: "#8A6AD6", accent0: "#FFB566", accent1: "#FF7410", accent2: "#C8530E", trim0: "#FF7410", trim1: "#C8530E", deep: "#3A2470", plateInk: "#FFFFFF" } },
	{ id: "steel", label: "Steel", weight: 2, roles: { planner: 0, lead: 1 }, colors: { body0: "#DADDE8", body1: "#9EA3B7", body2: "#62677C", accent0: "#FFB566", accent1: "#FF7410", accent2: "#C8530E", trim0: "#FF7410", trim1: "#C8530E", deep: "#262938", plateInk: "#36D6DE" } },
	{ id: "ivory", label: "Ivory", weight: 2, roles: { planner: 0, lead: 1 }, colors: { body0: "#FFFFFF", body1: "#ECE6F5", body2: "#B4A9CB", accent0: "#CDAAF5", accent1: "#9457DC", accent2: "#5E2BA8", trim0: "#9457DC", trim1: "#5E2BA8", deep: "#3B2A5C", plateInk: "#C59BF5" } },
];

const dithers: Part[] = [
	{ id: "checker", label: "Checker", weight: 5, style: "checker" },
	{ id: "bayer", label: "Bayer 4×4", weight: 4, style: "bayer" },
	{ id: "scan", label: "Scanline", weight: 2, style: "scan" },
	{ id: "flat", label: "Flat (two-tone)", weight: 2, style: "flat" },
];

// Names: short, friendly, no products or people. Picked by rendezvous hashing like parts; append only.
const NAMES = [
	"Bolt", "Pixel", "Widget", "Sprocket", "Nova", "Byte", "Chip", "Gizmo", "Ziggy", "Dot", "Echo", "Fuse", "Glint", "Jolt", "Kilo", "Lumen",
	"Mote", "Nib", "Orbit", "Piston", "Quark", "Servo", "Tock", "Volt", "Watt", "Zap", "Cog", "Diode", "Ember", "Flux", "Gear", "Hex",
	"Ion", "Joule", "Knob", "Lever", "Mica", "Nano", "Ohm", "Probe", "Rotor", "Spark", "Vector", "Wren", "Yoyo", "Axel", "Blip", "Cosmo",
	"Dynamo", "Ferro", "Gadget", "Hopper", "Jinx", "Kit", "Loop", "Moxie", "Nugget", "Pip", "Radar", "Socket", "Tinker", "Ultra", "Vim", "Zed",
];

const GLYPHS: Record<string, string[]> = {
	A: [".##.", "#..#", "####", "#..#", "#..#"], B: ["###.", "#..#", "###.", "#..#", "###."], C: [".###", "#...", "#...", "#...", ".###"],
	D: ["###.", "#..#", "#..#", "#..#", "###."], E: ["####", "#...", "###.", "#...", "####"], F: ["####", "#...", "###.", "#...", "#..."],
	G: [".###", "#...", "#.##", "#..#", ".###"], H: ["#..#", "#..#", "####", "#..#", "#..#"], I: ["####", ".##.", ".##.", ".##.", "####"],
	J: ["..##", "...#", "...#", "#..#", ".##."], K: ["#..#", "#.#.", "##..", "#.#.", "#..#"], L: ["#...", "#...", "#...", "#...", "####"],
	M: ["#..#", "####", "####", "#..#", "#..#"], N: ["#..#", "##.#", "#.##", "#..#", "#..#"], O: [".##.", "#..#", "#..#", "#..#", ".##."],
	P: ["###.", "#..#", "###.", "#...", "#..."], Q: [".##.", "#..#", "#..#", "#.##", ".###"], R: ["###.", "#..#", "###.", "#.#.", "#..#"],
	S: [".###", "#...", ".##.", "...#", "###."], T: ["####", ".##.", ".##.", ".##.", ".##."], U: ["#..#", "#..#", "#..#", "#..#", ".##."],
	V: ["#..#", "#..#", "#..#", ".##.", ".##."], W: ["#..#", "#..#", "####", "####", "#..#"], X: ["#..#", "#..#", ".##.", "#..#", "#..#"],
	Y: ["#..#", "#..#", ".##.", ".##.", ".##."], Z: ["####", "...#", ".##.", "#...", "####"],
};

export const CATALOG: Catalog = {
	format: "bot-catalog/1",
	frames: {
		xs: { w: 14, h: 14, head: [1, 4], outline: false, shadow: false, uses: ["xs"], shading: "flat" },
		small: { w: 24, h: 24, head: [3, 5], outline: true, shadow: false, uses: ["small", "std"], shading: "auto" },
		full: { w: 32, h: 32, head: [7, 5], outline: true, shadow: true, uses: ["full", "std"], shading: "auto" },
	},
	constants: { metal0: "#BDB7BC", metal1: "#857D81", metal2: "#4F494C", ink: "#0E0818", flame: "#36D6DE", white: "#FFFFFF", shadow: "#00000059" },
	slots: { palette: palettes, antenna: antennas, accessory: accessories, head: heads, ears, screen: screens, eyes, mouth: mouths, blush: blushes, torso: torsos, plate: plates, pose: poses, legs, dither: dithers },
	names: NAMES,
	glyphs: GLYPHS,
	// The brand's checkerboard floor shadow: an ellipse of every other cell (parity matches the canvas, origin 5,29).
	ground: art([[4, 17], [1, 20], [3, 18]].map(([a, b], r) => Array.from({ length: 22 }, (_, c) => (c >= a! && c <= b! && (c + r) % 2 === 0 ? "S" : ".")).join("")), [11, 3]),
	bayer4: [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]],
};
