"use client";

// "How bots are drawn": one scroll-scrubbed scene. On the left, a C4 component diagram of packages/bot-avatar (the
// engine's real functions, the catalog, and the two things that call it); on the right, the bot on the stage in
// botGrid()'s layers. One progress value drives both: each step lights its component and draws the edges into it,
// and the bot answers: botTraits() lifts out the parts it picked, compatible() flashes a part the rules narrowed,
// withOverrides() the face, botGrid() stacks the layers in paint order, gridSvg() flattens them into the picture.
// Every value is the engine's output for that bot; lib/layers.ts mirrors botGrid() layer by layer and is checked
// against it cell for cell. Scroll drives transforms, opacity and stroke-dashoffset directly (no React render per
// frame). Without the pin (narrow screens, reduced motion, no JS) everything is drawn, lit and exploded at once.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CATALOG, MOODS, SLOTS, botGrid, candidates, gridSvg, hkey, weightOf, type BotTraits, type Part, type PartSlot, type Slot } from "@/lib/vendor/bot-avatar.js";
import { botLayers } from "@/lib/layers";
import { PART_SLOTS, partOf } from "@/lib/playground";

// The teardown drawing. Each layer is a sheet lying on a table, seen from the front and above (an oblique view: the
// sprite's x axis stays horizontal, its rows recede up and to the right). Sheets are drawn in grid units and placed by
// one matrix each, so the same sheets can also turn to face the reader at the end.
const C = 8;                 // a cell's width on screen
const K = 0.42;              // depth foreshortening of a row
const S = 3;                 // how far a row shifts right per cell of depth
const N = 32;                // the full-body frame, 32×32 cells
const GAP = 50;              // vertical distance between sheets when fully exploded
const CF = 11;               // a cell's size when the finished bot faces the reader
const STAGES = 6;            // hash, draw, keep it valid, team and mood, paint, write
/** Consecutive layers that share a sheet in the drawing (the face parts, and what sits on top of the head). */
const SHEET_OF: Record<string, string> = { Blush: "face", Eyes: "face", Mouth: "face", Antenna: "top", Accessory: "top" };
const hex = (n: number) => "0x" + (n >>> 0).toString(16).padStart(8, "0"); // taste-skill-ignore: a hash, written as hex
const label = (s: string, id: string) => { try { return partOf(s as PartSlot, id).label.replace(/ \(.*\)$/, ""); } catch { return id; } };
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, m: number) => a + (b - a) * m;

/** One layer's cells as SVG paths in grid units: same-colour runs in a row become one rectangle, one path per colour. */
function layerPaths(cells: Map<number, string>): Array<[string, string]> {
  const by = new Map<string, string>();
  for (let y = 0; y < N; y++) {
    let x = 0;
    while (x < N) {
      const c = cells.get(y * N + x);
      let n = 1;
      while (x + n < N && c !== undefined && cells.get(y * N + x + n) === c) n++;
      if (c !== undefined) by.set(c, (by.get(c) ?? "") + `M${x} ${y}h${n}v1h-${n}z`);
      x += n;
    }
  }
  return [...by.entries()];
}

// The diagram, on an 864 × 660 canvas (scaled to fit): three columns of components inside the package boundary, from
// the agent id coming in at the top to the SVG coming out at the bottom right. Every edge is orthogonal with 8px
// corners, one attach point per edge, labels clear of their lines.
const DW = 864, DH = 660, NW = 212, NH = 152, BY = 36;
const PARTS = Object.values(CATALOG.slots).reduce((n, a) => n + a.length, 0);
const COL = [48, 332, 616], ROW = [60, 268, 476];
type NodeKey = "h32" | "traits" | "valid" | "catalog" | "team" | "grid" | "svg" | "out";
const BOX: Record<NodeKey, [number, number, number, number]> = {
  traits: [COL[0]!, ROW[0]!, NW, NH], h32: [COL[1]!, ROW[0]!, NW, NH],
  team: [COL[0]!, ROW[1]!, NW, NH], valid: [COL[1]!, ROW[1]!, NW, NH], catalog: [COL[2]!, ROW[1]!, NW, NH],
  grid: [COL[0]!, ROW[2]!, NW, NH], svg: [COL[1]!, ROW[2]!, NW, NH], out: [COL[2]!, ROW[2]!, NW, NH],
};
/** The step that lights each component (the output lights with the last one). */
const STAGE_OF: Record<NodeKey, number> = { h32: 0, traits: 1, valid: 2, catalog: 2, team: 3, grid: 4, svg: 5, out: 5 };
type Pt = [number, number];
interface Edge { id: string; pts: Pt[]; text: string; at: Pt; anchor?: "start" | "middle"; stage: number; order: number }
const mid = (k: NodeKey, side: "t" | "b" | "l" | "r", f = 0.5): Pt => {
  const [x, y, w, h] = BOX[k];
  return side === "t" ? [x + w * f, y] : side === "b" ? [x + w * f, y + h] : side === "l" ? [x, y + h * f] : [x + w, y + h * f];
};
const EDGES: Edge[] = (() => {
  const [tx] = mid("traits", "b", 1 / 3), [tx2] = mid("traits", "b", 2 / 3), [vx, vy] = mid("valid", "t"), [ix] = mid("traits", "t");
  return [
    { id: "id", pts: [[ix, 0], mid("traits", "t")], text: "agent id, role", at: [ix + 10, 18], anchor: "start", stage: 1, order: 0 },
    { id: "u32", pts: [mid("h32", "l"), mid("traits", "r")], text: "scores", at: [COL[1]! - 36, ROW[0]! + NH / 2 - 12], stage: 1, order: 1 },
    { id: "picks", pts: [[tx2, ROW[0]! + NH], [tx2, ROW[0]! + NH + 28], [vx, ROW[0]! + NH + 28], [vx, vy]], text: "picks so far", at: [(tx2 + vx) / 2, ROW[0]! + NH + 44], stage: 2, order: 0 },
    { id: "parts", pts: [mid("catalog", "l"), mid("valid", "r")], text: `${PARTS} parts`, at: [COL[2]! - 36, ROW[1]! + NH / 2 - 12], stage: 2, order: 1 },
    { id: "traits", pts: [[tx, ROW[0]! + NH], [tx, ROW[1]!]], text: "traits", at: [tx + 10, ROW[0]! + NH + 14], anchor: "start", stage: 3, order: 0 },
    { id: "mood", pts: [mid("team", "b"), mid("grid", "t")], text: "traits + mood", at: [BOX.team[0] + NW / 2 + 10, ROW[1]! + NH + 28], anchor: "start", stage: 4, order: 0 },
    { id: "grid", pts: [mid("grid", "r"), mid("svg", "l")], text: "grid", at: [COL[1]! - 36, ROW[2]! + NH / 2 - 12], stage: 5, order: 0 },
    { id: "svg", pts: [mid("svg", "r"), mid("out", "l")], text: "SVG", at: [COL[2]! - 36, ROW[2]! + NH / 2 - 12], stage: 5, order: 1 },
  ];
})();
/** An orthogonal polyline with rounded corners, on half pixels so a 1px stroke stays crisp. */
function route(pts: Pt[], r = 8): string {
  const p = pts.map(([x, y]) => [Math.round(x) + 0.5, Math.round(y) + 0.5] as Pt);
  let d = `M${p[0]![0]} ${p[0]![1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [ax, ay] = p[i - 1]!, [bx, by] = p[i]!, [cx, cy] = p[i + 1]!;
    const ux = Math.sign(bx - ax), uy = Math.sign(by - ay), wx = Math.sign(cx - bx), wy = Math.sign(cy - by);
    d += `L${bx - ux * r} ${by - uy * r}Q${bx} ${by} ${bx + wx * r} ${by + wy * r}`;
  }
  const [lx, ly] = p[p.length - 1]!;
  return d + `L${lx} ${ly}`;
}
/** The arrowhead at an edge's end, pointing along its last segment. */
function head(pts: Pt[]): string {
  const [ax, ay] = pts[pts.length - 2]!, [bx, by] = pts[pts.length - 1]!;
  const ux = Math.sign(bx - ax), uy = Math.sign(by - ay), x = Math.round(bx) + 0.5, y = Math.round(by) + 0.5;
  const bx2 = x - ux * 7, by2 = y - uy * 7;
  return `M${x} ${y}L${bx2 - uy * 3.5} ${by2 - ux * 3.5}L${bx2 + uy * 3.5} ${by2 + ux * 3.5}Z`;
}

export function Exploded({ t, onPull }: { t: BotTraits; onPull: () => void }) {
  const { layers } = useMemo(() => botLayers(t, "full"), [t]);
  const L = layers.length;
  // Sheets: runs of layers drawn on one sheet, in paint order. `pick` is when botTraits() chose the sheet's part
  // (its earliest slot in SLOTS order); the ground shadow and the outline are botGrid()'s own passes (-1). taste-skill-ignore: the engine's ground-shadow layer, not a CSS shadow
  const sheets = useMemo(() => {
    const out: Array<{ key: string; idx: number[]; pick: number; paths: Array<[string, string]> }> = [];
    layers.forEach((l, i) => {
      const k = SHEET_OF[l.name] ?? l.name, last = out[out.length - 1];
      const pick = l.slot ? (SLOTS as readonly string[]).indexOf(l.slot) : -1;
      if (last && last.key === k) { last.idx.push(i); last.pick = Math.min(last.pick, pick); }
      else out.push({ key: k, idx: [i], pick, paths: [] });
    });
    for (const sh of out) sh.paths = sh.idx.flatMap((li) => layerPaths(layers[li]!.cells).map(([c, d]) => [c, d] as [string, string]));
    return out;
  }, [layers]);
  const SN = sheets.length;
  const [wide, setWide] = useState(false);            // the diagram layout (≥ 1101px): callouts carry names
  const [pinned, setPinned] = useState(false);        // wide and motion allowed: the scene scrubs
  const [stage, setStage] = useState(-1);             // the step the scroll is showing; -1: all (no pin)
  const [hl, setHl] = useState<number[] | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const diagram = useRef<HTMLDivElement>(null);
  const sheetEls = useRef<(SVGGElement | null)[]>([]);
  const callEls = useRef<(SVGGElement | null)[]>([]);
  const plateEls = useRef<(SVGPathElement | null)[]>([]);
  const edgeEls = useRef<(SVGGElement | null)[]>([]);

  // Geometry of the drawing.
  const ox = 8, top = 12;
  const baseY = top + (SN - 1) * GAP;                  // the first sheet's back edge when exploded
  const sheetW = N * C + N * S, sheetH = N * C * K;
  const callX = ox + sheetW + 24;
  const vbW = callX + (wide ? 196 : 56), vbH = baseY + sheetH + 12;
  const cY = baseY - ((SN - 1) / 2) * GAP;             // where the sheets meet when stacked
  const front = { e: ox + (sheetW - N * CF) / 2, f: (vbH - N * CF) / 2 };
  const exF = (si: number) => baseY - si * GAP;        // a sheet's back edge when exploded
  const matrix = (f: number, m = 0) => `matrix(${lerp(C, CF, m)},0,${lerp(-S, 0, m)},${lerp(C * K, CF, m)},${lerp(ox + N * S, front.e, m)},${lerp(f, front.f, m)})`;

  // Which layer the rules narrowed (step 3), and the face (step 4): the sheets that flash.
  const notes = useMemo(() => {
    const picked: Array<[Slot, Part]> = [];
    const draws = PART_SLOTS.map((s) => {
      const c = candidates(s, t.role, picked);
      const me = c.find((x) => x.id === t[s]);
      // A part set by hand in the editor (withPart()) may be one the role would never draw; the rest is still checked
      // against the parts the bot really has.
      picked.push([s, me ?? partOf(s, t[s])]);
      const allowed = CATALOG.slots[s].filter((p) => weightOf(p, t.role) > 0).length;
      return { s, w: me ? weightOf(me, t.role) : 0, total: c.reduce((n, x) => n + weightOf(x, t.role), 0), fit: c.length, allowed };
    });
    const hw = Math.max(1, draws.find((x) => x.s === "head")!.w);
    let best = 0, bestK = 0;
    for (let k = 0; k < hw; k++) { const h = hkey(t.seed, "head", t.head, k); if (h > best) { best = h; bestK = k; } }
    const grid = botGrid(t, "full");
    const svg = gridSvg(grid, { label: t.name });
    const pal = partOf("palette", t.palette).colors!;
    const clash = draws.find((x) => x.fit < x.allowed && layers.some((l) => l.slot === x.s)) ?? null;
    return {
      draws, best, bestK, clash, rects: (svg.match(/ d="[^"]*"/g) ?? []).join("").split("z").length - 1, kb: (new Blob([svg]).size / 1000).toFixed(1), colours: grid.palette.length,
      chips: ["body0", "body1", "body2", "accent1", "accent2", "trim0", "deep"].map((k) => pal[k]!),
      mood: (Object.keys(MOODS) as Array<keyof typeof MOODS>).find((m) => MOODS[m].eyes === t.eyes && MOODS[m].mouth === t.mouth),
      pic: svg.replace(/ role="img" aria-label="[^"]*"/, ' aria-hidden="true"'),
    };
  }, [t, layers]);
  const sheetOf = (pred: (name: string, slot: string | null) => boolean) => sheets.findIndex((sh) => sh.idx.some((i) => pred(layers[i]!.name, layers[i]!.slot)));
  const flash = pinned && stage === 2 && notes.clash ? sheetOf((_, s) => s === notes.clash!.s) : pinned && stage === 3 ? sheetOf((n) => n === "Eyes") : -1;

  // The scene's two layouts and the pin.
  useEffect(() => {
    const wq = matchMedia("(min-width: 1101px)"), mq = matchMedia("(min-width: 1101px) and (prefers-reduced-motion: no-preference)");
    const set = () => { setWide(wq.matches); setPinned(mq.matches); };
    set();
    wq.addEventListener("change", set); mq.addEventListener("change", set);
    return () => { wq.removeEventListener("change", set); mq.removeEventListener("change", set); };
  }, []);

  // The diagram scales to its column and to the viewport's height.
  useEffect(() => {
    const el = diagram.current;
    if (!el || !wide) return;
    const fit = () => el.style.setProperty("--k", String(Math.min(1, el.clientWidth / DW, (innerHeight - 48) / DH)));
    const ro = new ResizeObserver(fit);
    ro.observe(el); addEventListener("resize", fit); fit();
    return () => { ro.disconnect(); removeEventListener("resize", fit); el.style.removeProperty("--k"); };
  }, [wide]);

  // Scroll-scrubbed: progress through the tall scroller, 0 → 1, is six steps. Within a step its edges draw in, then the
  // bot moves. Everything per frame goes straight to the DOM.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const sheetsAt = sheets.map((sh) => sh.pick);
    const order = [...sheetsAt.keys()].filter((i) => sheetsAt[i]! >= 0).sort((a, b) => sheetsAt[a]! - sheetsAt[b]!);
    const rank = sheetsAt.map((_, i) => order.indexOf(i));
    const reset = () => {
      sheetEls.current.forEach((g) => { if (g) { g.style.transform = ""; g.style.opacity = ""; } });
      callEls.current.forEach((g) => { if (g) { g.style.transform = ""; g.style.opacity = ""; } });
      plateEls.current.forEach((p) => { if (p) p.style.opacity = ""; });
      edgeEls.current.forEach((g) => {
        if (!g) return;
        const [line, tip, tag] = g.children as unknown as [SVGPathElement, SVGPathElement, SVGGElement];
        line.style.strokeDasharray = ""; line.style.strokeDashoffset = ""; tip.style.opacity = ""; tag.style.opacity = "";
      });
    };
    if (!pinned) { reset(); setStage(-1); return; }
    let raf = 0;
    const apply = () => {
      raf = 0;
      const r = el.getBoundingClientRect(), span = r.height - innerHeight;
      const p = span > 0 ? clamp(-r.top / span) : 1;
      const sf = p * STAGES;                              // 0 … 6
      setStage(Math.min(STAGES - 1, Math.floor(sf)));
      EDGES.forEach((e, i) => {
        const g = edgeEls.current[i];
        if (!g) return;
        const d = clamp((sf - e.stage - 0.04 - e.order * 0.28) / 0.34);
        const [line, tip, tag] = g.children as unknown as [SVGPathElement, SVGPathElement, SVGGElement];
        line.style.strokeDasharray = "1 2"; line.style.strokeDashoffset = String(1 - d);
        tip.style.opacity = d > 0.97 ? "1" : "0"; tag.style.opacity = String(clamp((d - 0.4) / 0.4));
      });
      const morph = clamp((sf - 5.15) / 0.5);
      sheets.forEach((sh, si) => {
        const g = sheetEls.current[si], call = callEls.current[si], plate = plateEls.current[si];
        if (!g || !call || !plate) return;
        // Step 2 (botTraits): picked sheets arrive and lift, in pick order. Step 5 (botGrid): every sheet comes down
        // onto the stack in paint order; the shadow and outline passes appear as they're painted. taste-skill-ignore: engine layer names
        const stack = clamp((sf - 4.06 - (si / SN) * 0.62) / 0.16);
        const arrive = sh.pick >= 0 ? clamp((sf - 1.08 - (rank[si]! / order.length) * 0.6) / 0.16) : stack;
        const sep = sh.pick >= 0 ? arrive * (1 - stack) : 0;
        const f = cY + (exF(si) - cY) * sep;
        g.style.transform = matrix(f, morph);
        g.style.opacity = String(0.14 + 0.86 * arrive);
        plate.style.opacity = String(1 - morph);
        call.style.transform = `translateY(${f - exF(si)}px)`;
        call.style.opacity = String(sep);
      });
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(apply); };
    addEventListener("scroll", onScroll, { passive: true }); addEventListener("resize", onScroll);
    apply();
    return () => { removeEventListener("scroll", onScroll); removeEventListener("resize", onScroll); if (raf) cancelAnimationFrame(raf); reset(); };
  }, [pinned, sheets, SN, cY, front.e, front.f]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = (s: PartSlot) => notes.draws.find((x) => x.s === s)!;
  const lit = (k: NodeKey) => stage < 0 || stage >= STAGE_OF[k];
  const cls = (k: NodeKey, extra = "") => `c4n${extra}${lit(k) ? " is-lit" : ""}${stage === STAGE_OF[k] ? " is-on" : ""}`;
  const pos = (k: NodeKey) => ({ ["--x" as string]: `${BOX[k][0]}px`, ["--y" as string]: `${BOX[k][1]}px`, ["--w" as string]: `${BOX[k][2]}px`, ["--h" as string]: `${BOX[k][3]}px` } as CSSProperties);
  const sheetNames = (si: number) => sheets[si]!.idx.map((i) => layers[i]!.name).join(" · ");
  const clash = notes.clash;

  return (
    <section className="tear" aria-labelledby="tear-title">
      <div className="tear__head">
        <h2 className="big" id="tear-title" data-reveal><span>How bots</span> <span>are drawn.</span></h2>
        <p data-reveal style={{ ["--d" as string]: "80ms" } as CSSProperties}><b>{t.name}</b>, through the engine. <code>packages/bot-avatar</code> turns an agent id into 14 parts and paints them as {L} layers on a 32×32 grid. Every value here is its output for the bot on the stage{pinned ? "; scroll to run it" : ""}.</p>
      </div>

      <div className={`tear__scroll${pinned ? " is-pinned" : ""}`} ref={scroller}>
        <div className="tear__pin">
          <div className="tear__sheet">
            <div className="c4" ref={diagram} data-stage={stage}>
              <div className="c4__canvas">
                <svg className="c4__edges" viewBox={`0 0 ${DW} ${DH}`} aria-hidden="true">
                  <rect className="c4__bound" x={28.5} y={BY + 0.5} width={820} height={ROW[2]! + NH + 24 - BY} />
                  {EDGES.map((e, i) => {
                    const w = e.text.length * 6.6 + 10;
                    const x0 = e.anchor === "start" ? e.at[0] - 4 : e.at[0] - w / 2;
                    return (
                      <g key={e.id} ref={(el) => { edgeEls.current[i] = el; }} className="c4e">
                        <path className="c4e__line" d={route(e.pts)} pathLength={1} />
                        <path className="c4e__tip" d={head(e.pts)} />
                        <g className="c4e__tag">
                          <rect x={x0} y={e.at[1] - 10} width={w} height={16} />
                          <text x={e.at[0]} y={e.at[1] + 2} textAnchor={e.anchor ?? "middle"}>{e.text}</text>
                        </g>
                      </g>
                    );
                  })}
                </svg>

                <a className="c4__label" href="https://github.com/MarvinAmador7/capcomd/tree/main/packages/bot-avatar" target="_blank" rel="noopener" aria-label="packages/bot-avatar on GitHub">
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
                  <code>packages/bot-avatar</code>
                </a>

                <ol className="c4__steps" aria-label="packages/bot-avatar, in the order a bot goes through it">
                  <li className={cls("h32")} style={pos("h32")}>
                    <h3 className="c4n__title">Hash</h3>
                    <p className="c4n__name"><code>h32 · hkey</code> <span className="c4n__type">[Component: hash.ts]</span></p>
                    <p className="c4n__desc">FNV-1a, then fmix32: a u32 for every key.</p>
                    <p className="c4n__more">FNV-1a over the key&apos;s UTF-8 bytes, finished with MurmurHash3&apos;s <code>fmix32</code>; <code>hkey()</code> joins a key&apos;s parts with U+001F. All unsigned 32-bit math, so the Swift port gets the same numbers.</p>
                    <p className="c4n__in">In: keys of id, slot, part and <i>k</i>, from <code>botTraits()</code>.</p>
                    <p className="c4n__val"><span className="sr">The head part&apos;s best key: </span><code>{t.head}·{notes.bestK}</code> → <code>{hex(notes.best)}</code></p>
                  </li>
                  <li className={cls("traits")} style={pos("traits")}>
                    <h3 className="c4n__title">Draw 14 parts</h3>
                    <p className="c4n__name"><code>botTraits</code> <span className="c4n__type">[Component: engine.ts]</span></p>
                    <p className="c4n__desc">A weighted rendezvous pick, slot by slot.</p>
                    <p className="c4n__more">Slots go in a fixed order, palette first. In each, every allowed part scores its best <code>hkey(seed, slot, part, k)</code> for <i>k</i> below its weight, and the top score wins. The role sets the weights.</p>
                    <p className="c4n__in">In: an agent id and role from a caller, and u32 scores from <code>hkey()</code>.</p>
                    <p className="c4n__val"><span className="sr">{t.role}, head: </span>{label("head", t.head).toLowerCase()}{d("head").w ? `, weight ${d("head").w} of ${d("head").total}` : ", set by hand"}</p>
                  </li>
                  <li className={cls("valid")} style={pos("valid")}>
                    <h3 className="c4n__title">Keep it valid</h3>
                    <p className="c4n__name"><code>candidates · compatible</code> <span className="c4n__type">[Component: engine.ts]</span></p>
                    <p className="c4n__desc">Drops weight-0 parts, then any that clash.</p>
                    <p className="c4n__more">Before each pick, <code>candidates()</code> drops the parts the role never gets (weight 0) and <code>compatible()</code> drops those that clash with the parts already picked: a shared zone, an unmet <code>requires</code>, an <code>excludes</code>.</p>
                    <p className="c4n__in">In: the picks so far from <code>botTraits()</code>, and the parts from the catalog.</p>
                    <p className="c4n__val">{clash ? `${clash.s}: ${clash.allowed - clash.fit} ruled out, ${clash.fit} fit` : "no clashes for this bot"}</p>
                  </li>
                  <li className={cls("catalog")} style={pos("catalog")}>
                    <h3 className="c4n__title">Parts</h3>
                    <p className="c4n__name"><code>CATALOG</code> <span className="c4n__type">[Component: catalog.ts]</span></p>
                    <p className="c4n__desc">Pixel art, role weights and rules.</p>
                    <p className="c4n__more">Each part&apos;s pixel rows, its weight for each role, and the zones it takes and the parts it needs or rules out. <code>scripts/golden.ts</code> writes it out as <code>fixtures/catalog.json</code>.</p>
                    <p className="c4n__val">{PARTS} parts in 14 slots</p>
                  </li>
                  <li className={cls("team")} style={pos("team")}>
                    <h3 className="c4n__title">Team and mood</h3>
                    <p className="c4n__name"><code>botTeam · withOverrides</code> <span className="c4n__type">[Component: engine.ts]</span></p>
                    <p className="c4n__desc">Siblings stay distinct; a mood swaps the face.</p>
                    <p className="c4n__more"><code>botTeam()</code> keeps the bots of one run apart: one that looks like an earlier sibling is redrawn from <code>seed#1</code> to <code>#15</code>. <code>withOverrides()</code> swaps in a mood&apos;s eyes and mouth, a pose, or a hat it keeps only if it fits.</p>
                    <p className="c4n__in">In: traits from <code>botTraits()</code>.</p>
                    <p className="c4n__val">{notes.mood ? `reads as ${notes.mood}: ${MOODS[notes.mood].eyes} eyes, ${MOODS[notes.mood].mouth}` : "its own eyes and mouth"}</p>
                  </li>
                  <li className={cls("grid")} style={pos("grid")}>
                    <h3 className="c4n__title">Paint {L} layers</h3>
                    <p className="c4n__name"><code>tone · botGrid</code> <span className="c4n__type">[Component: engine.ts]</span></p>
                    <p className="c4n__desc">Shades by the dither, paints bottom to top.</p>
                    <p className="c4n__more">On a 32×32 grid, each part&apos;s pixel rows land on its anchor; <code>tone()</code> makes each shaded cell (body, accent, metal) highlight, base or shade from its place in the part and the {label("dither", t.dither).toLowerCase()} pattern. Layers, first to last: {layers.map((l) => l.name).join(", ")}.</p>
                    <p className="c4n__in">In: traits, with any mood.</p>
                    <p className="c4n__val c4n__chips"><span className="sr">{label("palette", t.palette)} palette: {notes.chips.join(", ")}. </span>{notes.chips.map((c, i) => <span key={i} style={{ background: c }} aria-hidden="true" />)}<span>{notes.colours} colours</span></p>
                  </li>
                  <li className={cls("svg")} style={pos("svg")}>
                    <h3 className="c4n__title">Write the SVG</h3>
                    <p className="c4n__name"><code>gridSvg</code> <span className="c4n__type">[Component: engine.ts]</span></p>
                    <p className="c4n__desc">Same-colour runs merge into rectangles.</p>
                    <p className="c4n__more">One path per colour, crisp at any whole-number scale. <code>botSvg()</code> runs <code>withOverrides()</code>, <code>botGrid()</code> and this in one call.</p>
                    <p className="c4n__in">In: the 32×32 grid and its palette.</p>
                    <p className="c4n__val">{notes.rects} rectangles</p>
                  </li>
                  <li className={cls("out", " c4n--out")} style={pos("out")}>
                    <div className="c4n__head"><h3 className="c4n__title">The SVG</h3><p className="c4n__type">[Output]</p></div>
                    <span className="c4n__pic" role="img" aria-label={`${t.name}, as the engine draws it`} dangerouslySetInnerHTML={{ __html: notes.pic }} />
                    <p className="c4n__val">{notes.colours} paths, {notes.kb} kB</p>
                  </li>
                </ol>

              </div>
            </div>

            <div className="tear__fig">
              <svg className="tear__svg" viewBox={`0 0 ${vbW} ${vbH}`} shapeRendering="crispEdges" aria-hidden="true"
                data-hl={hl ? "" : flash >= 0 ? "flash" : undefined}>
                {sheets.map((sh, si) => {
                  const lit = hl ? sh.idx.some((i) => hl.includes(i)) : si === flash;
                  const num = sh.idx.length > 1 ? `${sh.idx[0]! + 1}–${sh.idx[sh.idx.length - 1]! + 1}` : `${sh.idx[0]! + 1}`;
                  const f = exF(si), cy = f + sheetH / 2, pw = num.length > 2 ? 42 : 24;
                  return (
                    <g key={`${t.seed}-${sh.key}-${si}`} className={`tear__layer${lit ? " is-hl" : ""}`}
                      onPointerEnter={(e) => { if (e.pointerType === "mouse") setHl(sh.idx); }} onPointerLeave={() => setHl(null)}>
                      <g ref={(el) => { sheetEls.current[si] = el; }} transform={matrix(f).replace(/,/g, " ")}>
                        <path ref={(el) => { plateEls.current[si] = el; }} className="tear__plate" d={`M0 0H${N}V${N}H0Z`} vectorEffect="non-scaling-stroke" />
                        {sh.paths.map(([c, p], j) => <path key={j} d={p} fill={c} />)}
                      </g>
                      <g ref={(el) => { callEls.current[si] = el; }} className="tear__call">
                        <path className="tear__lead" d={`M${ox + N * C + (N / 2) * S + 4} ${Math.round(cy) + 0.5}H${callX - 2}`} />
                        <rect x={callX} y={cy - 11} width={pw} height={22} rx={11} />
                        <text x={callX + pw / 2} y={cy + 4} textAnchor="middle">{num}</text>
                        {wide && <text className="tear__cname" x={callX + pw + 8} y={cy + 4}>{sheetNames(si)}</text>}
                      </g>
                    </g>
                  );
                })}
              </svg>
              <button type="button" className="pg__btn pg__btn--primary tear__pull" onClick={onPull}>Pull another</button>
            </div>

            <ol className="tear__parts" aria-label={`The ${L} layers botGrid() paints, first to last`}>
              {layers.map((l, i) => {
                const on = !!hl && hl.includes(i);
                return (
                  <li key={l.name} className={on ? "is-hl" : undefined}>
                    <button type="button" aria-pressed={on} onClick={() => setHl(on ? null : [i])}
                      onPointerEnter={(e) => { if (e.pointerType === "mouse") setHl([i]); }} onPointerLeave={(e) => { if (e.pointerType === "mouse") setHl(null); }}
                      onFocus={() => setHl([i])} onBlur={() => setHl(null)}>
                      <span className="tear__num" aria-hidden="true">{i + 1}</span>
                      <span className="tear__pname"><b>{l.name}</b><small>{l.slot ? label(l.slot, l.part) : l.part} · {l.cells.size} cells</small></span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
