// Brand mockups for the bot avatars (proposal). Writes brand/*.html; render each with tools/render.sh.
// Run from apps/menubar/design:  bun tools/genbrand.ts && tools/render.sh brand/<name> <w> <h>
// The approved mockups are read as inputs (tree-card-v3, thread-panel-v2, thread-input) and never modified.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	CATALOG, MENU_BAR_MARK, ROLES, SLOTS, botGrid, botTeam, botTraits, countCombinations, gridSvg, markSvg, rng, withOverrides, withPart as swapPart,
	type BotTraits, type Mood, type Part, type Role, type Size, type Slot,
} from "../../../../packages/bot-avatar/src/index";

const DESIGN = join(import.meta.dir, "..");
const OUT = join(DESIGN, "brand");
mkdirSync(OUT, { recursive: true });
const read = (f: string) => readFileSync(join(DESIGN, f), "utf8");
const write = (f: string, html: string) => { writeFileSync(join(OUT, f), html); console.log(`brand/${f}`); };

// The type in these mockups is SF Pro / SF Mono (the app's), so they render true on a Mac; the approved HTML names
// Inter / JetBrains Mono, which aren't installed here. This override keeps every size and weight as approved.
const FONT_FIX = `<style>body{font-family:-apple-system,'SF Pro Text',Inter,sans-serif!important}
.mono,.sfx,.cc .n,.art,.d,pre,.icd,.ln2,.kbd2{font-family:ui-monospace,'SF Mono','JetBrains Mono',monospace!important}
.bot{display:block;flex:none}.bot svg{display:block}</style>`;

const MARK = (scale = 1, color = "#fff") => markSvg(MENU_BAR_MARK, { scale, color });
/** The menu bar item with the proposed pixel mark (replaces the ring mark inside .cc). */
const ccMark = `<span class=bot style="width:16px;height:16px">${MARK(1)}</span>`;

type AvOpts = { mood?: Mood; pose?: string; accessory?: string; dim?: boolean; decorative?: boolean };
/** An avatar, inline: exactly what botSvg() returns, in a span. */
const av = (t: BotTraits, size: Size, scale = 1, o: AvOpts = {}) => {
	const svg = gridSvg(botGrid(withOverrides(t, o), size), { scale, label: `${t.name}, ${t.role}`, decorative: o.decorative ?? true });
	return `<span class=bot${o.dim ? ` style="opacity:.45"` : ""}>${svg}</span>`;
};
// Sheets with hundreds of avatars define each drawing once as a <symbol> and <use> it at every scale (same pixels,
// a fraction of the HTML). defs() empties the collection into the page.
const symbols = new Map<string, string>();
const avs = (t: BotTraits, size: Size, scale = 1, o: AvOpts = {}) => {
	const key = JSON.stringify([withOverrides(t, o), size]);
	let id = symbols.get(key)?.match(/id="(\w+)"/)?.[1];
	const svg = gridSvg(botGrid(withOverrides(t, o), size), { scale: 1, label: "", decorative: true });
	const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/)!;
	if (!id) { id = `b${symbols.size}`; symbols.set(key, `<symbol id="${id}" viewBox="${vb[0].slice(9, -1)}">${svg.slice(svg.indexOf(">") + 1, -6)}</symbol>`); }
	return `<span class=bot${o.dim ? ` style="opacity:.45"` : ""}><svg width="${+vb[1]! * scale}" height="${+vb[2]! * scale}" shape-rendering="crispEdges" aria-hidden="true"><use href="#${id}"/></svg></span>`;
};
const defs = () => { const s = `<svg width="0" height="0" style="position:absolute"><defs>${[...symbols.values()].join("")}</defs></svg>`; symbols.clear(); return s; };

// One run's team, in spawn order, made distinct with botTeam (seeds are realistic capcomd agent ids).
const TEAM = botTeam([
	{ seed: "agt-mh2x4k1a9b3c7d", role: "planner" },
	{ seed: "agt-mh2x4m07qz1e2f", role: "worker" },
	{ seed: "agt-mh2x4m2kd8w3aa", role: "lead" },
	{ seed: "agt-mh2x5b8sd3ce41", role: "worker" },
	{ seed: "agt-mh2x5b9t44236c", role: "worker" },
	{ seed: "agt-mh2x5c01cr9k2m", role: "critic" },
]);
const [PLANNER, WORKER0, LEAD, WD3CE, W4423, CRITIC] = TEAM as [BotTraits, BotTraits, BotTraits, BotTraits, BotTraits, BotTraits];
const PLANNER2 = botTraits("agt-mh2y0p3r7f1b2c", "planner");
const WFF88 = botTeam([...[LEAD, WD3CE, W4423, CRITIC].map((t) => ({ seed: t.seed, role: t.role })), { seed: "agt-mh2x5b9vff8811", role: "worker" }])[4]!;

/** Replace the n-th match of `re` (global) in order with replacements[i]. */
function replaceSeq(s: string, re: RegExp, reps: string[]): string {
	let i = 0;
	return s.replace(re, (m) => (i < reps.length ? reps[i++]! : m));
}

// 1. Panel: project cards with an agent tree (tree-card-v3 with avatars) ------------------------------------------

function panelTree() {
	let s = read("tree-card-v3.html");
	// Row icons, in order: planner, worker, lead, worker d3ce, worker 4423, critic (queued: dimmed, asleep), planner.
	s = replaceSeq(s, /<span class=ic><svg[\s\S]*?<\/svg><\/span>/g, [
		av(PLANNER, "xs"), av(WORKER0, "xs"), av(LEAD, "xs"), av(WD3CE, "xs"), av(W4423, "xs"), av(CRITIC, "xs", 1, { mood: "sleepy", dim: true }), av(PLANNER2, "xs"),
	].map((a) => `<span class=ic>${a}</span>`));
	s = s.replace(/<span class=nm>(Planner|Worker|Lead|Critic)/g, (_, n: string) => `<span class=nm>${n.toLowerCase()}`);
	s = s.replace(/<div class=mark><\/div>/, ccMark);
	s = s.replace("body{width:760px;height:760px", "body{width:760px;height:820px");
	write("panel-tree.html", s.replace("</head>", `${FONT_FIX}</head>`));
}

// 2. Thread: header and handoff card with avatars (thread-panel-v2) -----------------------------------------------

function thread() {
	let s = read("thread-panel-v2.html");
	// Header: a 24 pt bust left of the breadcrumb and title, like a conversation header.
	s = s.replace(/<div class=hdr><div class=back>([\s\S]*?)<\/div><div><div class=crumb>Migrate matchkey to v3.2 \/ Lead<\/div><div class=ttl style="display:flex;align-items:center;gap:7px"><span style="display:flex"><svg[\s\S]*?<\/svg><\/span>Lead/,
		(_, back: string) => `<div class=hdr><div class=back>${back}</div>${av(LEAD, "small", 1, { decorative: false })}<div><div class=crumb>Migrate matchkey to v3.2 / lead</div><div class=ttl style="display:flex;align-items:center;gap:7px">lead<span class=nick>${LEAD.name}</span>`);
	// Handoff card: the child's bust, then name, suffix, "handed back".
	s = s.replace(/<div class=r1><svg[\s\S]*?<\/svg>Worker<span class=sfx>4423<\/span>/, `<div class=r1>${av(W4423, "small")}worker<span class=sfx>4423</span>`);
	// "Spawned three workers": the three new heads, overlapping, after the summary (no count text).
	s = s.replace("<span>Spawned three workers</span>", `<span style="display:flex;align-items:center;gap:8px">Spawned three workers<span class=stack>${[WD3CE, W4423, WFF88].map((t) => av(t, "xs")).join("")}</span></span>`);
	s = s.replace(/Tell Lead…/g, "Tell lead…").replace("Lead is writing…", "lead is writing…");
	s = s.replace(/<div class=mark><\/div>/, ccMark);
	const css = `<style>.hdr{gap:10px}.nick{font:500 11px -apple-system,sans-serif;color:rgba(235,235,245,.38);margin-left:-1px}
.ho .r1{gap:8px}.ho .r1 .bot{margin:-2px 0}.stack{display:flex}.stack .bot{margin-left:-3px;padding:1px;border-radius:4px;background:rgba(30,30,38,.9)}.stack .bot:first-child{margin-left:0}</style>`;
	write("thread.html", s.replace("</head>", `${FONT_FIX}${css}</head>`));
}

// 3. Mention popover (thread-input) --------------------------------------------------------------------------------

function mention() {
	let s = read("thread-input.html");
	const start = s.indexOf("<div class=mpop>"), end = s.indexOf("</div></div>", start) + 12;
	let pop = s.slice(start, end);
	pop = replaceSeq(pop, /<svg[\s\S]*?<\/svg>/g, [av(W4423, "xs", 1, { mood: "happy" }), av(WD3CE, "xs"), av(WFF88, "xs", 1, { mood: "oops" }), av(CRITIC, "xs", 1, { mood: "sleepy" })]);
	pop = pop.replace(/<span>(Worker|Critic) /g, (_, n: string) => `<span>${n.toLowerCase()} `);
	s = s.slice(0, start) + pop + s.slice(end);
	s = s.replace(/Tell Lead…/g, "Tell lead…").replace("Lead is writing…", "lead is writing…");
	write("mention.html", s.replace("</head>", `${FONT_FIX}<style>.mi .bot{width:14px;margin-left:1px}</style></head>`));
}

// Shared board chrome for the sheets that aren't transforms of an approved screen. --------------------------------

const BOARD_CSS = `<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'SF Pro Text',Inter,sans-serif;-webkit-font-smoothing:antialiased;color:#f2f2f7;background:#0b0d14;overflow:hidden}
.wall{position:fixed;inset:-40px;background:radial-gradient(600px 400px at 15% 70%,#2b3a6b 0,transparent 70%),radial-gradient(500px 500px at 85% 85%,#5a2e4a 0,transparent 70%),radial-gradient(500px 300px at 60% 20%,#1f4a55 0,transparent 70%),radial-gradient(400px 400px at 35% 35%,#4a3a24 0,transparent 70%),#0b0d14;filter:blur(30px)}
.sheet{position:relative;padding:22px}
.cell{border-radius:14px;background:rgba(30,34,44,.78);box-shadow:0 0 0 .5px rgba(255,255,255,.14);padding:12px 16px}
.cap{font-size:10.5px;font-weight:600;color:rgba(235,235,245,.4);margin-bottom:8px;letter-spacing:.02em}
.mono{font-family:ui-monospace,'SF Mono',monospace}
.h1{font-size:15px;font-weight:600;letter-spacing:-.01em}.sub{font-size:12px;color:rgba(235,235,245,.55);margin-top:3px;line-height:17px}
.note{font-size:11.5px;line-height:16px;color:rgba(235,235,245,.55)}.note b{color:rgba(255,255,255,.85);font-weight:500}
.bot{display:block;flex:none}.bot svg{display:block}
.px1 svg{width:auto}
</style>`;
const page = (w: number, h: number, body: string, css = "") => `<!doctype html><html><head><meta charset="utf-8">${BOARD_CSS}<style>body{width:${w}px;height:${h}px}${css}</style></head><body><div class=wall></div><div class=sheet>${body}</div>${defs()}</body></html>`;

// 4. Catalog sheet ---------------------------------------------------------------------------------------------------

const BASE: BotTraits = { format: "bot/1", seed: "catalog", role: "worker", name: "Pixel", palette: "orange-purple", antenna: "ball", accessory: "none", head: "dome", ears: "disc", screen: "night", eyes: "ovals", mouth: "smile", blush: "on", torso: "round", plate: "heart", pose: "float", legs: "boots", dither: "checker" };
const PARTS = SLOTS.filter((s): s is Exclude<Slot, "name"> => s !== "name");

/** The base bot with one part swapped in (other parts give way if they clash). */
const withPart = (slot: Exclude<Slot, "name">, id: string, base = BASE) => swapPart(base, slot, id);

function roleNote(p: Part): string {
	const r = p.roles ?? {};
	const only = ROLES.filter((x) => (r[x] ?? p.weight ?? 4) > 0);
	const bits: string[] = [];
	if (!only.length) bits.push("never picked: moments ask for it");
	else if (only.length < ROLES.length) bits.push(only.length === 1 ? `${only[0]} only` : `not ${ROLES.filter((x) => !only.includes(x)).join("/")}`);
	for (const [k, v] of Object.entries(r)) if (v && v > (p.weight ?? 4) && only.length > 1) bits.push(`${k} ×${v}`);
	if (p.requires) for (const [k, v] of Object.entries(p.requires)) bits.push(`${k}: ${v!.join(", ")}`);
	if (p.excludes) for (const [k, v] of Object.entries(p.excludes)) bits.push(`not ${v!.join("/")}`);
	if (p.occupies?.length) bits.push(`takes ${p.occupies.join("+")}`);
	return bits.join(" · ");
}

function catalogSheet() {
	const av = avs;
	const tile = (slot: Exclude<Slot, "name">, p: Part, sizes: Array<[Size, number]>) => {
		const t = withPart(slot, p.id);
		return `<div class="tile${sizes.some(([z]) => z === "full") ? " wide" : ""}"><div class=bots>${sizes.map(([z, sc]) => av(t, z, sc)).join("")}</div><div class=tl>${p.label}</div><div class="tid mono">${p.id}</div><div class=tn>${roleNote(p)}</div></div>`;
	};
	const sec = (title: string, slot: Exclude<Slot, "name">, sizes: Array<[Size, number]>, note = "") =>
		`<div class=sec><div class=st>${title}<span class=cnt>${CATALOG.slots[slot].length}</span></div>${note ? `<div class=sn>${note}</div>` : ""}<div class=tiles>${CATALOG.slots[slot].map((p) => tile(slot, p, sizes)).join("")}</div></div>`;
	const head: Array<[Size, number]> = [["xs", 2], ["small", 3]];
	const body: Array<[Size, number]> = [["small", 3], ["full", 3]];

	const swatch = (p: Part) => {
		const c = p.colors!;
		const keys = ["body0", "body1", "body2", "accent1", "trim0", "deep", "plateInk"];
		return `<div class="tile wide"><div class=bots>${av(withPart("palette", p.id), "small", 3)}${av(withPart("palette", p.id, { ...BASE, screen: "plum" }), "xs", 3)}</div><div class=sw>${keys.map((k) => `<i style="background:${c[k]}" title="${k}"></i>`).join("")}</div><div class=tl>${p.label}</div><div class="tid mono">${p.id}</div><div class=tn>${roleNote(p)}</div></div>`;
	};
	const k = CATALOG.constants;
	const consts = `<div class=tile style="width:236px"><div class=sw style="margin-top:2px">${["metal0", "metal1", "metal2", "ink", "flame", "white"].map((x) => `<i style="background:${k[x]}" title="${x}"></i>`).join("")}</div><div class=tl>Shared</div><div class=tn>metal (ears, stems), ink outline, cyan glow, white; the floor shadow is black at 35 %.</div></div>`;
	const dith = () => CATALOG.slots.dither.map((p) => `<div class="tile wide" style="width:220px"><div class=bots>${av(withPart("dither", p.id, { ...BASE, palette: "orange-purple" }), "full", 3)}${av(withPart("dither", p.id, { ...BASE, palette: "purple" }), "full", 3)}</div><div class=tl>${p.label}</div><div class="tid mono">${p.id}</div></div>`).join("");

	// Grid and anchors: the dome head at 8× with its anchor points.
	const anchorDemo = (() => {
		const sc = 8, head = CATALOG.slots.head[0]!.art!.std!, a = head.anchors!;
		const g = botGrid({ ...BASE, antenna: "none", ears: "none", eyes: "ovals", mouth: "smile", blush: "none" }, "small");
		const svg = gridSvg(g, { scale: sc, label: "", decorative: true });
		const ox = 3, oy = 5; // small frame head origin
		const pts = Object.entries(a).map(([n, [x, y]]) => `<div class=ap style="left:${(ox + x) * sc - 4}px;top:${(oy + y) * sc - 4}px"></div><div class=al style="left:${(ox + x) * sc + 6}px;top:${(oy + y) * sc - 7}px">${n}</div>`).join("");
		const vis = a.visor!;
		return `<div class=tile style="width:auto;padding:12px 14px"><div style="position:relative;width:${24 * sc}px;height:${24 * sc}px;background-image:linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);background-size:${sc}px ${sc}px">${svg}<div class=vr style="left:${(ox + vis[0]) * sc}px;top:${(oy + vis[1]) * sc}px;width:${12 * sc}px;height:${7 * sc}px"></div>${pts}</div>
<div class=tl style="margin-top:8px">small frame · 24×24 · head 18×15 at (3,5)</div><div class=tn style="max-width:${24 * sc}px">Every head puts its visor at (3,5) 12×7, so every face fits every head. Antennas and hats land on <span class=mono>top</span>, bows on <span class=mono>side</span>, ears on <span class=mono>earL/earR</span> (the right ear is the left one mirrored), the torso on <span class=mono>neck</span>.</div></div>`;
	})();
	const frames = `<div class=tile style="width:auto"><div class=bots style="align-items:flex-end;gap:18px">${(["xs", "small", "full"] as const).map((z) => {
		const f = CATALOG.frames[z], sc = z === "full" ? 4 : 6;
		return `<div><div style="position:relative;width:${f.w * sc}px;height:${f.h * sc}px;background-image:linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px);background-size:${sc}px ${sc}px;box-shadow:0 0 0 .5px rgba(255,255,255,.2)">${av(withPart("pose", "wave"), z, sc)}</div><div class="tid mono" style="margin-top:6px">${z} ${f.w}×${f.h}${f.outline ? " · outline" : ""}${f.shadow ? " · floor" : ""}</div></div>`;
	}).join("")}</div><div class=tl style="margin-top:8px">Three grids, three drawings</div><div class=tn style="max-width:520px">xs is its own 14×14 drawing (head only, no outline, flat two-tone shading) so it lands on the 14 pt icon grid at 1 cell = 1 pt. small is head and shoulders at 24 pt. full is the whole bot at 64 pt (2 pt cells) or 96 pt (3 pt). Cells only ever scale by whole numbers.</div></div>`;

	const glyphs = `<div class=tile style="width:auto"><div class=glyphs>${Object.entries(CATALOG.glyphs).map(([c, rows]) => `<span title="${c}">${markSvg(rows.map((r) => r), { scale: 3, color: "rgba(235,235,245,.75)" })}</span>`).join("")}</div><div class=tl>Letter plate glyphs (4×5)</div><div class=tn>The letter plate prints the bot's name initial on full-body bots.</div></div>`;
	const names = `<div class=tile style="width:auto;max-width:560px"><div class="tn mono" style="font-size:11px;line-height:17px;color:rgba(235,235,245,.7)">${CATALOG.names.join(" · ")}</div><div class=tl style="margin-top:6px">Names (${CATALOG.names.length})</div><div class=tn>Picked like parts, so a seed keeps its name; siblings never share one (botTeam).</div></div>`;

	const total = (r: Role) => countCombinations(r);
	const fmt = (n: number) => n.toLocaleString("en-US");
	const nParts = PARTS.reduce((n, s) => n + CATALOG.slots[s].length, 0);
	const html = `<div style="display:flex;align-items:flex-end;gap:16px;margin:2px 2px 16px"><div><div class=h1>Bot parts catalog <span class=mono style="font-size:12px;color:rgba(235,235,245,.45);font-weight:400">bot-catalog/1</span></div>
<div class=sub>${nParts} parts in ${PARTS.length} slots · ${CATALOG.names.length} names. Valid combinations per role: ${ROLES.map((r) => `${r} ${fmt(total(r))}`).join(" · ")}. Each tile is the same base bot with one part swapped in, at xs and small (3× for legibility); body parts at small and full.</div></div></div>
<div class=row>${anchorDemo}${frames}</div><div class=secs>
${sec("Heads", "head", head, "18×15 on small/full, 12×10 on xs.")}
${sec("Screens", "screen", head, "Visor colours, measured from the brand sheets: night (full body), plum (xs), lilac (small). Lilac gets an ink bezel at small and full.")}
${sec("Eyes", "eyes", head)}
${sec("Mouths", "mouth", head)}
${sec("Blush", "blush", head)}
${sec("Ears", "ears", head, "Drawn for the left; the right is mirrored.")}
${sec("Antennas", "antenna", head, "The crown and the flag are orchestrator traits: only planners and leads get them, and they always do.")}
${sec("Accessories", "accessory", head)}</div>`;
	const body2 = () => `<div class=h1 style="margin:2px 2px 4px">Bot parts catalog · body, palettes, shading</div><div class=sub style="margin:0 2px 14px">Same base bot, one part swapped in; small and full at 3×. Head parts are on the first sheet.</div><div class=secs>
${sec("Torsos", "torso", body, "Hands float free of the body (Rayman-style): a clear cell between outlines, no shoulders or elbows. small draws the bust with its two hands; full takes its hands from the pose.")}
${sec("Chest plates", "plate", body)}
${sec("Poses (full only)", "pose", [["full", 3]], "Floating mitts, the left a cell higher (a static bob). spark holds up a cyan ✦; cheer is never picked: it is for a run's finish.")}
${sec("Legs (full only)", "legs", [["full", 3]])}
<div class=sec><div class=st>Palettes<span class=cnt>${CATALOG.slots.palette.length}</span></div><div class=sn>Swatches: body highlight, base, shade · accent · trim · plate · plate ink.</div><div class=tiles>${CATALOG.slots.palette.map(swatch).join("")}${consts}</div></div>
<div class=sec><div class=st>Dither (shading)<span class=cnt>${CATALOG.slots.dither.length}</span></div><div class=sn>Light from the top left; xs is always flat.</div><div class=tiles>${dith()}</div></div>
</div><div class=row>${glyphs}${names}</div>`;
	const css = `
.row{display:flex;gap:12px;margin-bottom:12px;align-items:stretch}
.sec{margin-bottom:14px}.st{font-size:13px;font-weight:600;margin:0 2px 2px;display:flex;align-items:center;gap:7px}.cnt{font:500 10.5px ui-monospace,monospace;color:rgba(235,235,245,.4)}
.sn{font-size:11px;color:rgba(235,235,245,.45);margin:0 2px 7px}
.tiles{display:flex;flex-wrap:wrap;gap:8px}
.tile{width:182px;border-radius:12px;background:rgba(30,34,44,.78);box-shadow:0 0 0 .5px rgba(255,255,255,.12);padding:10px 11px}
.bots{display:flex;align-items:flex-end;gap:10px;min-height:72px}
.tl{font-size:12px;font-weight:500;margin-top:7px}.tid{font-size:10.5px;color:rgba(235,235,245,.4);margin-top:1px}.tn{font-size:10.5px;line-height:14px;color:rgba(235,235,245,.5);margin-top:3px}
.sw{display:flex;gap:3px;margin-top:8px}.sw i{width:18px;height:14px;border-radius:3px;box-shadow:inset 0 0 0 .5px rgba(255,255,255,.18)}
.ap{position:absolute;width:8px;height:8px;border-radius:50%;background:#0a84ff;box-shadow:0 0 0 1.5px #fff}
.al{position:absolute;font:600 9.5px ui-monospace,monospace;color:#fff;background:rgba(10,132,255,.85);border-radius:3px;padding:0 3px}
.vr{position:absolute;box-shadow:inset 0 0 0 1.5px rgba(10,132,255,.9);border-radius:2px}
.glyphs{display:grid;grid-template-columns:repeat(13,auto);gap:8px 10px;max-width:300px}
.secs{display:flex;flex-wrap:wrap;column-gap:22px}.tile{width:142px}.tile.wide{width:182px}`;
	write("catalog.html", page(1240, 1960, html, css));
	write("catalog-body.html", page(1240, 1720, body2(), css));
}

// 5. Contact sheet: 48 seeds at every size, at 1x and 2x ------------------------------------------------------------

function contactSheet() {
	const av = avs;
	// Roles in the proportions of a real tree: 1 planner, 2 leads, 6 workers, 2 critics, 1 other per 12.
	const mix: Role[] = ["planner", "lead", "worker", "worker", "worker", "critic", "lead", "worker", "worker", "worker", "critic", "other"];
	const seeds = Array.from({ length: 48 }, (_, i) => ({ seed: `agt-${(0x6d2b79f5 * (i + 1) >>> 0).toString(36).padStart(7, "0")}${i.toString(36)}`, role: mix[i % 12]! }));
	// Half-size CSS on this 2x render = 1 cell per device pixel: what a 1x display shows.
	const d1 = (a: string) => a.replace(/width="(\d+)" height="(\d+)"/, (_, w: string, h: string) => `width="${+w / 2}" height="${+h / 2}"`);
	const cell = (s: { seed: string; role: Role }) => {
		const t = botTraits(s.seed, s.role);
		return `<div class=cc2><div class=rw>${d1(av(t, "xs", 1))}${av(t, "xs", 1)}${av(t, "xs", 2)}${d1(av(t, "small", 1))}${av(t, "small", 1)}${av(t, "small", 2)}</div><div class=rw>${av(t, "full", 2)}${av(t, "full", 3)}</div><div class=lb><b>${t.name}</b> ${s.role}<span class=mono> ${s.seed.slice(-6)}</span></div></div>`;
	};
	// Same seeds, every role: what the role nudge does.
	const roleRow = (seed: string) => `<div class=rr><span class="mono sd">${seed}</span>${ROLES.map((r) => { const t = botTraits(seed, r); return `<div class=rc>${av(t, "small", 2)}<div class=lb>${r}</div></div>`; }).join("")}</div>`;
	const html = `<div style="margin:2px 2px 14px"><div class=h1>Generator contact sheet</div><div class=sub>48 seeds (roles in a real tree's proportions: 1 planner, 2 leads, 6 workers, 2 critics, 1 other per 12). Each tile: xs and small at 1 cell = 1 device pixel (a 1x display), at 1 pt and at 2 pt; full at 64 pt and 96 pt. Rendered by <span class=mono>botSvg()</span>, nothing hand-placed.</div></div>
<div class=grid>${seeds.map(cell).join("")}</div>
<div style="margin:18px 2px 8px"><div class=h1 style="font-size:13px">Same seed, every role</div><div class=sub>The role changes weights, not the seed's hashes: specialists of one seed come out the same or nearly, while orchestrators always get their trait (planner crown, lead flag) and lean orange, the brand's parent bot.</div></div>
<div class=roles>${["agt-mh2x4k1a9b3c7d", "agt-k3f9a0c1d2e4b5a6", "agt-mh31qq0v8n2b4c", "agt-mh2z9z7y6x5w4v"].map(roleRow).join("")}</div>`;
	write("contact-sheet.html", page(1240, 2080, html, `
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}
.cc2{border-radius:12px;background:rgba(30,34,44,.78);box-shadow:0 0 0 .5px rgba(255,255,255,.12);padding:9px 10px}
.rw{display:flex;align-items:flex-end;gap:7px;margin-bottom:6px}
.lb{font-size:11px;color:rgba(235,235,245,.55)}.lb b{color:#fff;font-weight:500}.lb .mono{font-size:10px;color:rgba(235,235,245,.35)}
.roles{display:flex;flex-direction:column;gap:8px}.rr{display:flex;align-items:flex-end;gap:16px;border-radius:12px;background:rgba(30,34,44,.78);box-shadow:0 0 0 .5px rgba(255,255,255,.12);padding:10px 14px}
.sd{font-size:10.5px;color:rgba(235,235,245,.4);width:150px;align-self:center}.rc{display:flex;flex-direction:column;align-items:center;gap:4px}`));
}

// Panel chrome for the moments: the approved panel's CSS (tree-card-v3), with the panel made static. --------------

const PANEL_CSS = [...read("tree-card-v3.html").matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
	.replace(/body\{[^}]*\}/, "").replace(/\.wall\{[^}]*\}/, "");
const pnl = (inner: string) => `<div class=panel style="position:relative;top:0;left:0">${inner}</div>`;
const chip = (t: string) => `<span class=chip><svg width="12" height="10" viewBox="0 0 12 10" fill="none" stroke="white" stroke-width="1.1"><path d="M1 2.2c0-.6.4-1 1-1h2.6l1.2 1.3H10c.6 0 1 .4 1 1V8c0 .6-.4 1-1 1H2c-.6 0-1-.4-1-1z"/></svg>${t}</span>`;
const FOOT = `<div class=ft><span>Open capcomd</span><span class=h>Summon <span class=mono>⌥Space</span></span></div>`;
const FIELD = `<div class=in><span>＋</span>Start a project…<span class=kbd>⌘K</span></div>`;
const RING = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" style="color:#0a84ff;flex:none"><circle cx="7" cy="7" r="5.6"/><circle cx="7" cy="7" r="2.4" fill="currentColor" stroke="none"/></svg>`;

/** The brand's primary bot (the board's "orange primary"): the mascot for moments that belong to no agent. */
const MASCOT: BotTraits = { format: "bot/1", seed: "capcomd", role: "other", name: "Capcomd", palette: "orange", antenna: "ball", accessory: "none", head: "dome", ears: "disc", screen: "night", eyes: "ovals", mouth: "smile", blush: "on", torso: "round", plate: "logo", pose: "float", legs: "boots", dither: "checker" };

/** Pixel "z" glyphs and confetti: small identity marks drawn on the same cell grid as the bots. */
const glyph = (c: string, scale: number, color: string) => markSvg(CATALOG.glyphs[c]!, { scale, color });
function confetti(seed: string, n: number, w: number, h: number, colors: string[]): string {
	const r = rng(seed, "confetti");
	return Array.from({ length: n }, () => {
		const x = r() % w, y = r() % h, c = colors[r() % colors.length]!, s = 2 + (r() % 2) * 2;
		return `<i style="left:${x}px;top:${y}px;width:${s}px;height:${s}px;background:${c}"></i>`;
	}).join("");
}

function moments() {
	const team = [LEAD, WD3CE, W4423, CRITIC];
	// 1 · Empty state: the mascot asleep on its floor, under "Nothing running".
	const empty = pnl(`${FIELD}<div class=sec>Active</div>
<div class=empty><div class=zz>${glyph("Z", 2, "rgba(205,170,245,.55)")}<span style="margin-top:-10px">${glyph("Z", 1, "rgba(205,170,245,.4)")}</span></div>${av(MASCOT, "full", 2, { mood: "sleepy", decorative: false })}
<div class=et>Nothing running</div><div class=es>Describe a goal above and a planner picks it up.</div></div>
<div class=done><span></span><span style="white-space:nowrap">Launch Addriva Verify docs</span><span class=mute style="margin-left:auto;font-size:12px;white-space:nowrap">Done in 4m · 3 repos</span></div>
<div class=done><span></span><span style="white-space:nowrap">Fix proration rounding</span><span class=mute style="margin-left:auto;font-size:12px;white-space:nowrap">Done in 9m</span></div>${FOOT}`);

	// 2 · Meet your team: the run's first moments, drawn like the brand's orchestration board (parent over children,
	// dotted pixel traces), then it gives way to the agent tree.
	const kids = team.map((t) => `<div class=kid>${av(t, "small", 1, { decorative: false })}<div class=kn>${t.role}</div><div class=kk>${t.name}</div></div>`).join("");
	const meet = pnl(`${FIELD}<div class=sec>Active</div><div class=card><div class=t>Migrate matchkey to v3.2</div><div class=chips>${chip("matchkey")}${chip("ids/v1")}${chip("addriva")}</div>
<div class=meet><div class=par>${av(PLANNER, "full", 2, { pose: "wave", decorative: false })}<div class=kn style="margin-top:2px">planner <span class=kk>${PLANNER.name}</span></div></div>
<div class=trace><i class=v></i><i class=hz></i>${[0, 1, 2, 3].map((i) => `<i class=dn style="left:${44 + i * 82}px"></i>`).join("")}</div><div class=kids>${kids}</div></div>
<div class=ml>${RING}<span>Planning: splitting the migration across three folders</span></div></div>${FOOT}`);

	// 3 · Run finished: the team cheers once, in party hats (the planner keeps its crown, the lead its flag).
	const party = [PLANNER, LEAD, WD3CE, W4423, CRITIC];
	const conf = confetti("run-mh2x4k", 40, 340, 70,["#FF7410", "#9457DC", "#36D6DE", "#CDAAF5", "#FFB566"]);
	const done = pnl(`${FIELD}<div class=sec>Active</div><div class=card style="padding-bottom:10px"><div style="display:flex;align-items:baseline"><div class=t>Migrate matchkey to v3.2</div><span class=mute style="margin-left:auto;font-size:12px">Done in 6m</span></div>
<div class=party><div class=conf>${conf}</div>${party.map((t) => av(t, "full", 2, { pose: "cheer", mood: "happy", accessory: "party" })).join("")}</div>
<div class=ml style="color:rgba(255,255,255,.8)"><svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="#30d158" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.4l2.6 2.6L11 4.4"/></svg><span>Merged into main · 3 repos</span></div></div>
<div class=done><span></span><span style="white-space:nowrap">Launch Addriva Verify docs</span><span class=mute style="margin-left:auto;font-size:12px;white-space:nowrap">Done in 4m · 3 repos</span></div>${FOOT}`);

	const col = (cap: string, panel: string, notes: string) => `<div class=col><div class=cap>${cap}</div>${panel}<div class="note nt">${notes}</div></div>`;
	const html = `<div class=cols>
${col("Empty state · nothing running", empty, "<b>Static.</b> The mascot (the brand's orange primary bot) sleeps on its dithered floor; full body at 64 pt (2 pt cells). Text is SF Pro and carries the meaning; the bot is decoration with an accessible name.")}
${col("Meet your team · a run's first seconds", meet, "<b>Once per run.</b> The planner (crown) waves over the agents it spawns, joined by dotted pixel traces from the brand's orchestration board. Each child fades and rises 4 pt, 40 ms apart, 0.2 s each (whole moment under 300 ms per item); Reduce Motion: one 150 ms crossfade. Then the card becomes the agent tree.")}
${col("Run finished · celebration", done, "<b>Once, for about 2 s</b>, then the card collapses to its finished line. Bots switch to the cheer pose and happy face, non-orchestrators put on party hats; confetti is static, laid out by mulberry32 seeded by the run id. Never on failure: a failed run shows its red mark, no party.")}
</div>`;
	write("moments.html", page(1240, 600, html,`${PANEL_CSS}
.cols{display:grid;grid-template-columns:repeat(3,380px);gap:28px;justify-content:center}.col .cap{margin:0 4px 8px}
.nt{margin:10px 6px 0}
.empty{display:flex;flex-direction:column;align-items:center;padding:18px 0 14px;position:relative}
.zz{position:absolute;left:214px;top:8px;display:flex;align-items:flex-start;gap:3px}
.et{font-size:13px;font-weight:600;margin-top:10px}.es{font-size:12px;color:rgba(235,235,245,.55);margin-top:3px}
.meet{position:relative;margin:10px -4px 2px;padding-top:8px;border-top:.5px solid rgba(255,255,255,.08);display:flex;flex-direction:column;align-items:center}
.par{display:flex;flex-direction:column;align-items:center}
.kn{font-size:11px;color:rgba(235,235,245,.6)}.kk{font-size:10.5px;color:rgba(235,235,245,.35)}
.trace{position:relative;width:332px;height:18px}
.trace i{position:absolute;background-image:linear-gradient(90deg,rgba(255,122,16,.7) 50%,transparent 50%);background-size:4px 2px}
.trace .v{left:165px;top:0;width:2px;height:8px;background-image:linear-gradient(rgba(255,122,16,.7) 50%,transparent 50%);background-size:2px 4px}
.trace .hz{left:45px;top:8px;width:248px;height:2px}
.trace .dn{top:8px;width:2px;height:10px;background-image:linear-gradient(rgba(255,122,16,.7) 50%,transparent 50%);background-size:2px 4px}
.kids{display:grid;grid-template-columns:repeat(4,82px);justify-items:center;width:332px}
.kid{display:flex;flex-direction:column;align-items:center;gap:1px}
.ml{display:flex;align-items:center;gap:7px;font-size:11.5px;color:rgba(235,235,245,.55);margin:10px 0 4px}
.party{position:relative;display:flex;justify-content:center;gap:6px;margin:6px -6px 0;padding-top:4px;overflow:hidden}
.conf{position:absolute;inset:0}.conf i{position:absolute;opacity:.85}
.party .bot{position:relative}`));
}

// 7. Menu bar icon -----------------------------------------------------------------------------------------------------

function menubar() {
	const bar = (light: boolean, mark: string, badge: string | null, hi = false) => `<div class="mbar${light ? " lt" : ""}"><div class="item${hi ? " hi" : ""}">${mark}${badge ? `<span class=n>${badge}</span><i class=dot></i>` : ""}</div><span class=ic>${light ? "◐" : "◑"}</span><span class=clk>Sat Oct 24&nbsp; 8:52 PM</span></div>`;
	const ring = (c: string) => `<span class=ring style="border-color:${c}"><i style="background:${c}"></i></span>`;
	const pm = (c: string, s = 1) => `<span class=bot>${MARK(s, c)}</span>`;
	const states = (light: boolean) => {
		const c = light ? "rgba(0,0,0,.85)" : "#fff";
		const st = (b: string, l: string) => `<div class=st2>${b}<span class=lbl>${l}</span></div>`;
		return `<div class=strip>${st(bar(light, ring(c), "3"), "today (ring mark)")}${st(bar(light, pm(c), null), "proposed · idle")}${st(bar(light, pm(c), "3"), "proposed · approvals waiting")}${st(bar(light, pm("#fff"), null, true), "proposed · menu open")}</div>`;
	};
	const sc = 14;
	const grid = `<div style="position:relative;width:${16 * sc}px;height:${16 * sc}px;background:#1c1c24;background-image:linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px);background-size:${sc}px ${sc}px;border-radius:6px">${MARK(sc, "#f2f2f7")}</div>`;
	const half = (s: string) => s.replace(/width="(\d+)" height="(\d+)"/, (_, w: string, h: string) => `width="${+w / 2}" height="${+h / 2}"`);
	const sizes = `<div style="display:flex;align-items:flex-end;gap:22px">${[["1x display", half(MARK(1, "#fff"))], ["2x display", MARK(1, "#fff")], ["18 pt (larger menu bar)", MARK(1, "#fff").replace(/width="16" height="16"/, 'width="18" height="18"')]].map(([l, s]) => `<div style="display:flex;flex-direction:column;align-items:center;gap:8px"><div style="padding:10px;background:#26262e;border-radius:8px">${s}</div><span class=lbl>${l}</span></div>`).join("")}</div>`;
	const html = `<div class=h1>Menu bar icon</div><div class=sub style="max-width:900px">The ring mark becomes the brand's bot head: 16×16 cells, 1-bit, a template image (macOS tints it for light and dark bars and the open state). The amber approval dot and count stay exactly as approved. No animation: running work is in the panel, not a blinking icon.</div>
<div class=cell style="margin-top:14px"><div class=cap>Dark menu bar</div>${states(false)}<div class=cap style="margin-top:14px">Light menu bar</div>${states(true)}</div>
<div style="display:flex;gap:16px;margin-top:16px"><div class=cell style="display:flex;gap:22px;align-items:center">${grid}<div class=note style="max-width:300px"><b>16×16, whole cells.</b> At 16 pt each cell is 1 pt: 1 px on a 1x display, 2 px on Retina. The visor is cut out, so the eyes and smile read as the bar's background shows through: it stays legible as a silhouette at a glance.<br><br><b>18 pt</b> (larger text in the menu bar) is not an integer multiple: draw the 16 pt mark centred in the 18 pt slot, never scaled.</div></div>
<div class=cell><div class=cap>Sizes</div>${sizes}</div></div>`;
	write("menubar.html", page(1240, 540, html, `
.strip{display:flex;align-items:flex-start;gap:18px}.st2{display:flex;flex-direction:column;gap:6px}.lbl{font-size:11px;color:rgba(235,235,245,.45);margin-left:4px}
.mbar{height:28px;display:flex;align-items:center;gap:14px;padding:0 12px;border-radius:7px;background:rgba(20,20,26,.6);box-shadow:0 0 0 .5px rgba(255,255,255,.1);font-size:13px;font-weight:500;color:rgba(255,255,255,.92)}
.mbar.lt{background:rgba(236,236,240,.85);color:rgba(0,0,0,.85)}
.item{position:relative;height:22px;padding:0 7px;border-radius:5px;display:flex;align-items:center;gap:5px}.item.hi{background:rgba(255,255,255,.18)}.mbar.lt .item.hi{background:rgba(0,0,0,.75)}
.item .n{font:600 12px ui-monospace,'SF Mono',monospace}
.item .dot{position:absolute;top:3px;left:16px;width:6px;height:6px;border-radius:50%;background:#ffb020;box-shadow:0 0 0 1.5px rgba(30,30,36,.9)}
.mbar.lt .item .dot{box-shadow:0 0 0 1.5px rgba(236,236,240,.95)}
.ring{width:14px;height:14px;border:1.6px solid;border-radius:50%;position:relative;display:block}.ring i{position:absolute;inset:3px;border-radius:50%}
.ic{font-size:13px;opacity:.8}.clk{font-size:13px}`));
}

// 8. Directions -----------------------------------------------------------------------------------------------------------

function directions() {
	const rows = (o: { faces: boolean }) => [[PLANNER, "planner", 0], [LEAD, "lead", 1], [WD3CE, "worker", 2], [W4423, "worker", 2]].map(([t, n, d]) =>
		`<div class=tr${d === 0 ? " style=\"font-weight:500;color:#fff\"" : ""}>${"<span class=gd></span>".repeat(d as number)}<span class=ic>${o.faces ? av(t as BotTraits, "xs") : `<span style="width:14px;height:14px;border:1.5px solid rgba(235,235,245,.6);border-radius:4px;display:block"></span>`}</span><span class=nm>${n}</span><span class=stt>${RING}</span></div>`).join("");
	const cardA = `<div class=card><div class=t>Migrate matchkey to v3.2</div><div class=tree>${rows({ faces: true })}</div></div>`;
	const cardB = `<div class=card><div class=t>Migrate matchkey to v3.2</div><div class=tree>${rows({ faces: true })}</div></div><div class=bm><div class=bmi>${av(LEAD, "small")}<span>Thread header</span></div><div class=bmi>${av(MASCOT, "full", 1, { mood: "sleepy" })}<span>Empty state</span></div><div class=bmi>${av(PLANNER, "full", 1, { pose: "cheer", mood: "happy" })}<span>Run finished</span></div><div class=bmi><span style="padding:4px;background:#26262e;border-radius:5px">${MARK(1)}</span><span>Menu bar</span></div></div>`;
	const cardC = `<div class="card arc"><div class=t2>MIGRATE MATCHKEY TO V3.2</div><div class=tree>${rows({ faces: true }).replace(/class=nm>(\w+)/g, (_, n: string) => `class=nm style="font:500 11px ui-monospace,monospace;letter-spacing:.08em">${n.toUpperCase()}`)}</div><div class=scan></div></div>`;
	const d = (k: string, name: string, one: string, card: string, pros: string[], cons: string[], rec = false) => `<div class="cell dir${rec ? " rec" : ""}"><div class=cap>${k}${rec ? ' · <span style="color:#0a84ff">recommended</span>' : ""}</div><div class=h1>${name}</div><div class=sub style="min-height:52px">${one}</div><div class=mock>${card}</div>
<div class=pc><div><b>For</b>${pros.map((p) => `<div>${p}</div>`).join("")}</div><div><b>Against</b>${cons.map((p) => `<div>${p}</div>`).join("")}</div></div></div>`;
	const html = `<div class=h1 style="margin:2px 2px 4px">Three directions: how fun meets macOS polish</div><div class=sub style="margin:0 2px 14px;max-width:980px">All three keep the approved panel, SF Pro, materials, spacing, status marks and motion rules. They differ in how far the pixel and dither language reaches.</div>
<div class=dirs>
${d("Direction A", "Badges", "Avatars replace the profile icons (tree rows, mentions, chips, thread header, handoffs). Nothing else changes.", cardA, ["Lowest risk; ships with the Swift renderer alone", "Every agent becomes recognisable at a glance"], ["The brand stays a sticker: no moment where it gets to be fun", "Empty and finished states stay generic"])}
${d("Direction B", "Identity moments", "A, plus a handful of moments where the bots and pixel language take the stage: empty state, meet the team, run finished, the menu bar mark. Pixel art never touches text, controls or chrome.", cardB, ["Fun where there is room for it, quiet where people work", "Moments are single, short and skippable (Reduce Motion, keyboard)", "A first step to a character the agents can grow into (moods, team)"], ["More to build than A: three moment views and a confetti layer", "Needs a rule people respect: no pixel UI creep"], true)}
${d("Direction C", "Arcade", "Pixel and dither everywhere: pixel headings, dithered card fills, CRT scanlines, stepped borders. The full retro-futurist skin.", cardC, ["Most distinctive; closest to a game-like bot persona"], ["Fights vibrancy, Dynamic Type, Increase Contrast and the HIG", "Pixel type is hard to read at 11–13 pt; tests worse in long sessions", "Every system control looks out of place next to it"])}
</div>`;
	write("directions.html", page(1240, 700, html, `${PANEL_CSS}
.dirs{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.dir{padding:14px 16px}.dir.rec{box-shadow:0 0 0 1.5px #0a84ff}
.mock{margin:12px -4px 12px;padding:10px;border-radius:14px;background:rgba(40,40,48,.52);box-shadow:0 0 0 .5px rgba(255,255,255,.14)}.mock .card{margin:0}
.pc{display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:11.5px;line-height:16px;color:rgba(235,235,245,.6)}.pc b{display:block;color:#fff;font-weight:600;font-size:11px;margin-bottom:3px}.pc div div{margin-bottom:4px}
.bm{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px}.bmi{display:flex;flex-direction:column;align-items:center;gap:5px;font-size:10.5px;color:rgba(235,235,245,.5);justify-content:flex-end}
.arc{position:relative;overflow:hidden;border-radius:2px;background-color:#14101f;background-image:repeating-conic-gradient(rgba(148,87,220,.22) 0 25%,transparent 0 50%);background-size:4px 4px;box-shadow:0 0 0 2px #9457dc,0 0 0 4px #14101f,0 0 0 6px #ff7410}
.t2{font:600 12px ui-monospace,monospace;letter-spacing:.12em;color:#ff9a40}
.scan{position:absolute;inset:0;background:repeating-linear-gradient(rgba(0,0,0,.25) 0 1px,transparent 1px 3px);pointer-events:none}`));
}

// main ----------------------------------------------------------------------------------------------------------------

const which = process.argv.slice(2);
const pages: Record<string, () => void> = { "panel-tree": panelTree, thread, mention, moments, menubar, directions, catalog: catalogSheet, "contact-sheet": contactSheet };
for (const [k, f] of Object.entries(pages)) if (!which.length || which.includes(k)) f();
