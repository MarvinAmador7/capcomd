// The bot's pixel layers, in the order the engine's botGrid() paints them. This mirrors botGrid() in
// packages/bot-avatar/src/engine.ts step for step, but keeps each part's cells apart instead of only the composite, so
// the page can pull them apart. checkLayers() proves it: stacking the layers reproduces botGrid() cell for cell.
// (The engine has no per-layer API; if one is added, use it and drop this file.)
import { CATALOG, artFor, botGrid, tone, type BotTraits, type Size } from "./vendor/bot-avatar.js";

type Pt = [number, number];
interface Art { rows: string[]; anchor?: Pt; anchors?: Record<string, Pt> }
// The vendored typings cover only what the site otherwise uses; the catalog carries more (frames, art, anchors).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CAT = CATALOG as any;

export interface Layer {
  /** What botGrid() is drawing at this step. */
  name: string;
  /** The catalog slot the drawing came from (null for the ground and the outline pass). */
  slot: string | null;
  /** The catalog part id ("dome", "boots", …), or a note for the two passes. */
  part: string;
  /** Cells this layer wrote: index → colour. Later layers may paint over them in the composite. */
  cells: Map<number, string>;
}
export interface Layered { w: number; h: number; layers: Layer[] }

const FACE_KEYS = new Set(["E", "e", "M", "K"]);

export function botLayers(traits: BotTraits, size: Size): Layered {
  const fr = CAT.frames[size];
  const W: number = fr.w, H: number = fr.h;
  const kind = new Uint8Array(W * H); // 0 empty, 1 bot, 2 ground shadow
  const onVisor = new Uint8Array(W * H);
  const get = (s: string) => CAT.slots[s].find((p: { id: string }) => p.id === (traits as unknown as Record<string, string>)[s]);
  const pal = get("palette").colors, k = CAT.constants;
  const scr = { ...get("screen").colors, ...(size === "xs" ? get("screen").colorsXs : undefined) };
  const style = fr.shading === "flat" ? "flat" : get("dither").style;
  const layers: Layer[] = [];
  let cur: Layer;
  const begin = (name: string, slot: string | null, part: string) => { cur = { name, slot, part, cells: new Map() }; layers.push(cur); };

  const color = (c: string, lx: number, ly: number, w: number, h: number, x: number, y: number): string => {
    const tn = () => tone(lx, ly, w, h, x, y, style, CAT.bayer4);
    switch (c) {
      case "B": return pal[`body${tn()}`]; case "b": return pal.body2; case "H": return pal.body0;
      case "A": return pal[`accent${tn()}`]; case "a": return pal.accent2;
      case "T": return pal.trim0; case "t": return pal.trim1; case "P": return pal.deep; case "L": return pal.plateInk;
      case "G": return k[`metal${tn()}`]; case "g": return k.metal2; case "W": return k.white; case "I": return k.ink;
      case "F": return k.flame; case "S": return k.shadow;
      default: return scr[c];
    }
  };
  const draw = (a: Art | undefined, at: Pt, mirror = false, face = false): Pt => {
    if (!a || !a.rows.length) return at;
    const w = a.rows[0]!.length, h = a.rows.length, an = a.anchor ?? [0, 0];
    const ox = at[0] - (mirror ? w - an[0] : an[0]), oy = at[1] - an[1];
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const key = a.rows[r]![mirror ? w - 1 - c : c]!;
      if (key === ".") continue;
      const x = ox + c, y = oy + r;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      onVisor[i] = key === "V" || (face && onVisor[i]) ? 1 : 0;
      const sc = mirror ? w - 1 - c : c;
      const rim = key === "V" && scr.v && fr.outline && [[sc - 1, r], [sc + 1, r], [sc, r - 1], [sc, r + 1]].some(([q, s]) => a.rows[s!]?.[q!] !== "V");
      cur.cells.set(i, rim ? scr.v : color(key, c, r, w, h, x, y));
      kind[i] = key === "S" ? 2 : 1;
    }
    void FACE_KEYS;
    return [ox, oy];
  };
  const add = (o: Pt, p: Pt): Pt => [o[0] + p[0], o[1] + p[1]];

  const head = artFor(get("head"), size) as unknown as Art;
  const ho: Pt = fr.head, ha = head.anchors!;
  if (fr.shadow && CAT.ground) { begin("Ground shadow", null, "full body only"); draw(CAT.ground, [W >> 1, H]); } // taste-skill-ignore: the engine's ground shadow, not a CSS shadow
  const torsoArt = artFor(get("torso"), size) as unknown as Art | undefined;
  if (torsoArt) {
    begin("Torso", "torso", traits.torso);
    const to = draw(torsoArt, add(ho, ha.neck!));
    const ta = torsoArt.anchors!;
    if (ta.hip) { begin("Legs", "legs", traits.legs); draw(artFor(get("legs"), size) as unknown as Art, add(to, ta.hip)); }
    const plate = get("plate");
    begin("Chest plate", "plate", traits.plate);
    const po = draw(artFor(plate, size) as unknown as Art, add(to, ta.plate!));
    if (plate.id === "letter" && size === "full") {
      const g = CAT.glyphs[traits.name[0]!.toUpperCase()];
      if (g) draw({ rows: g.map((r: string) => r.replaceAll("#", "L")), anchor: [0, 0] }, add(po, [2, 0]));
    }
    const arms = get("pose").arms;
    if (arms && ta.armL && ta.armR) { begin("Arms", "pose", traits.pose); draw(arms[0], add(to, ta.armL), true); draw(arms[1], add(to, ta.armR)); }
  }
  begin("Head", "head", traits.head); draw(head, ho);
  const ear = artFor(get("ears"), size) as unknown as Art | undefined;
  begin("Ears", "ears", traits.ears); draw(ear, add(ho, ha.earL!)); draw(ear, add(ho, ha.earR!), true);
  const vo = add(ho, ha.visor!);
  for (const s of ["blush", "eyes", "mouth"] as const) { begin(s === "blush" ? "Blush" : s === "eyes" ? "Eyes" : "Mouth", s, traits[s]); draw(artFor(get(s), size) as unknown as Art, vo, false, true); }
  begin("Antenna", "antenna", traits.antenna); draw(artFor(get("antenna"), size) as unknown as Art, add(ho, ha.top!));
  const acc = get("accessory");
  begin("Accessory", "accessory", traits.accessory); draw(artFor(acc, size) as unknown as Art, add(ho, ha[acc.attach ?? "top"]!));
  if (fr.outline) {
    begin("Ink outline", null, "one cell round the silhouette");
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (kind[i] === 1) continue;
      if ((x > 0 && kind[i - 1] === 1) || (x < W - 1 && kind[i + 1] === 1) || (y > 0 && kind[i - W] === 1) || (y < H - 1 && kind[i + W] === 1)) cur!.cells.set(i, k.ink);
    }
  }
  return { w: W, h: H, layers: layers.filter((l) => l.cells.size > 0) };
}

/** Stack the layers in order (later wins) and compare with botGrid(): true when every cell's colour matches. */
export function checkLayers(traits: BotTraits, size: Size): boolean {
  const { w, h, layers } = botLayers(traits, size);
  const g = botGrid(traits, size);
  const top = new Array<string>(w * h).fill("");
  for (const l of layers) for (const [i, c] of l.cells) top[i] = c;
  return g.px.every((v, i) => (v < 0 ? "" : g.palette[v]!.toUpperCase()) === top[i]!.toUpperCase());
}
