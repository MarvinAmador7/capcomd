// The bot playground's logic, on top of the avatar engine (packages/bot-avatar, vendored). Pure functions; the PNG
// helpers need a browser canvas. Nothing here adds a trait the engine doesn't have.
import {
  CATALOG, ROLES, botGrid, botTraits, candidates, compatible, weightOf, withPart,
  type BotGrid, type BotTraits, type Part, type PartSlot, type Role, type Size, type Slot,
} from "./vendor/bot-avatar.js";

/** The slots a player can set, in the engine's pick order (name comes from the seed). */
export const PART_SLOTS: PartSlot[] = ["palette", "antenna", "accessory", "head", "ears", "screen", "eyes", "mouth", "blush", "torso", "plate", "pose", "legs", "dither"];
export const SLOT_LABEL: Record<PartSlot, string> = {
  palette: "Palette", antenna: "Antenna", accessory: "Accessory", head: "Head", ears: "Ears", screen: "Screen", eyes: "Eyes",
  mouth: "Mouth", blush: "Blush", torso: "Torso", plate: "Chest plate", pose: "Pose", legs: "Legs", dither: "Dither",
};
export { ROLES };
export type { BotTraits, Role, Size, PartSlot };

export const partOf = (slot: PartSlot, id: string): Part => CATALOG.slots[slot].find((p) => p.id === id)!;
const chosen = (t: BotTraits, except?: PartSlot): Array<[Slot, Part]> =>
  PART_SLOTS.filter((s) => s !== except).map((s) => [s, partOf(s, t[s])]);

export const randomSeed = (): string =>
  "agt-" + Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join(""); // taste-skill-ignore: hex agent id

/** Set one part; any other part that no longer fits gives way (the engine's withPart). */
export const setPart = (t: BotTraits, slot: PartSlot, id: string): BotTraits => withPart(t, slot, id);

/** Whether `id` fits `slot` with the rest of the bot as it is (otherwise picking it moves another part). */
export const fits = (t: BotTraits, slot: PartSlot, id: string): boolean => compatible(partOf(slot, id), slot, chosen(t, slot));

/**
 * How likely the engine is to draw this exact bot (all 14 parts) for its role from a random id: the product, in pick
 * order, of each part's weight over the weights of the parts that could be picked there. 0 when a part can't be
 * drawn for the role (crown for a worker) or the bot was made by hand into a combination the order rules out.
 */
export function odds(t: BotTraits): number {
  let p = 1;
  const picked: Array<[Slot, Part]> = [];
  for (const s of PART_SLOTS) {
    const c = candidates(s, t.role, picked);
    const me = c.find((x) => x.id === t[s]);
    if (!me) return 0;
    p *= weightOf(me, t.role) / c.reduce((n, x) => n + weightOf(x, t.role), 0);
    picked.push([s, me]);
  }
  return p;
}

/** A plain-language description of the bot, for its accessible name and the spec sheet. */
// Part labels as prose, where the catalog's short labels don't read as a sentence.
const PROSE: Record<string, string> = {
  "eyes:ovals": "oval", "eyes:dots": "dot", "eyes:happy": "happy arc", "eyes:hearts": "heart", "eyes:squint": "squinting", "eyes:bar": "scanner-bar",
  "mouth:cat": "cat-like", "mouth:o": "round O", "mouth:small": "small smiling", "mouth:smile": "smiling", "mouth:grin": "grinning", "mouth:flat": "flat",
  "plate:logo": "capcomd mark", "plate:screen": "pulse screen", "plate:letter": "letter block",
};
export function describe(t: BotTraits): string {
  const l = (s: PartSlot) => PROSE[`${s}:${t[s]}`] ?? partOf(s, t[s]).label.replace(/ \(.*\)$/, "").toLowerCase();
  const bits = [
    `${l("palette")} palette`, `${l("head")} head`,
    t.antenna !== "none" ? `${l("antenna")} antenna` : "", t.accessory !== "none" ? l("accessory") : "",
    t.ears !== "none" ? `${l("ears")} ears` : "", `${l("screen")} screen with ${l("eyes")} eyes`,
    t.mouth !== "none" ? `a ${l("mouth")} mouth` : "no mouth", t.blush === "on" ? "blush" : "",
    `${l("torso")} torso`, t.plate !== "none" ? `${l("plate")} chest plate` : "", `${l("pose")} pose`, `${l("legs")} legs`,
  ].filter(Boolean);
  return `${t.name}, a ${t.role} bot: ${bits.join(", ")}.`;
}

// Share links ---------------------------------------------------------------------------------------------------------
// #s=<seed>&r=<role>&t=<one base-36 digit per slot: the part's index in the catalog>&z=<size>
// Catalog parts are append-only, so indices stay valid; the name comes from the seed. A link that doesn't decode to a
// valid bot falls back to the seed's own bot.

export interface Shared { traits: BotTraits; size: Size }

export function encode(t: BotTraits, size: Size): string {
  const code = PART_SLOTS.map((s) => CATALOG.slots[s].findIndex((p) => p.id === t[s]).toString(36)).join("");
  const q = new URLSearchParams({ s: t.seed, r: t.role, t: code, z: size });
  return q.toString();
}

export function decode(hash: string): Shared | null {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const seed = q.get("s");
  if (!seed || seed.length > 64) return null;
  const role = (ROLES as readonly string[]).includes(q.get("r") ?? "") ? (q.get("r") as Role) : "other";
  const z = q.get("z");
  const size: Size = z === "xs" || z === "small" || z === "full" ? z : "full";
  let t = botTraits(seed, role);
  // A link made before parts or slots were appended to the catalog has a shorter code: its digits still mean the
  // same parts (the catalog is append-only), and the slots it doesn't cover come from the seed. One base-36 digit
  // per slot allows 36 parts per slot.
  const code = q.get("t");
  if (code && code.length <= PART_SLOTS.length) {
    const next = { ...t } as BotTraits;
    let ok = true;
    PART_SLOTS.slice(0, code.length).forEach((s, i) => {
      const p = CATALOG.slots[s][parseInt(code[i]!, 36)];
      if (p) (next as unknown as Record<string, string>)[s] = p.id; else ok = false;
    });
    if (ok && PART_SLOTS.every((s) => compatible(partOf(s, next[s]), s, chosen(next, s)))) t = next;
  }
  return { traits: t, size };
}

// Pixels --------------------------------------------------------------------------------------------------------------

export type Backdrop = "none" | "floor" | "paper";
const PLUM = "#2B0E57", FLOOR = "#47208A", PAPER = "#ECEBEF";

/** Paint a grid onto a 2D context at an integer scale, cell by cell (nearest neighbour, no smoothing). */
function paint(ctx: CanvasRenderingContext2D, g: BotGrid, ox: number, oy: number, scale: number) {
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const v = g.px[y * g.w + x]!;
    if (v < 0) continue;
    ctx.fillStyle = g.palette[v]!;
    ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
  }
}

function backdrop(ctx: CanvasRenderingContext2D, w: number, h: number, scale: number, kind: Backdrop) {
  if (kind === "paper") { ctx.fillStyle = PAPER; ctx.fillRect(0, 0, w, h); }
  if (kind !== "floor") return;
  // The slot's plum with a 2-cell checker floor across the bottom fifth, as on the site.
  ctx.fillStyle = PLUM; ctx.fillRect(0, 0, w, h);
  const cell = Math.max(1, scale) * 2, top = h - Math.ceil((h * 0.2) / cell) * cell;
  ctx.fillStyle = FLOOR;
  for (let j = 0; top + j * cell < h; j++) for (let i = 0; i * cell < w; i++) if ((i + j) % 2 === 0) ctx.fillRect(i * cell, top + j * cell, cell, cell);
}

/** One bot as a PNG blob: w×h cells × scale, nearest-neighbour, on a transparent, floor or paper backdrop. */
export async function botPng(t: BotTraits, size: Size, scale: number, kind: Backdrop): Promise<Blob> {
  const g = botGrid(t, size);
  const c = document.createElement("canvas");
  c.width = g.w * scale; c.height = g.h * scale;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  backdrop(ctx, c.width, c.height, scale, kind);
  paint(ctx, g, 0, 0, scale);
  return new Promise((r, e) => c.toBlob((b) => (b ? r(b) : e(new Error("png"))), "image/png"));
}

/** The whole crew in a row, full size, on the dither floor. */
export async function crewPng(crew: BotTraits[], scale = 6): Promise<Blob> {
  const gs = crew.map((t) => botGrid(t, "full"));
  const cw = 32 * scale, gap = 4 * scale, pad = 8 * scale;
  const c = document.createElement("canvas");
  c.width = pad * 2 + gs.length * cw + (gs.length - 1) * gap; c.height = pad + 32 * scale + 2 * scale;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  backdrop(ctx, c.width, c.height, scale, "floor");
  gs.forEach((g, i) => paint(ctx, g, pad + i * (cw + gap), pad, scale));
  return new Promise((r, e) => c.toBlob((b) => (b ? r(b) : e(new Error("png"))), "image/png"));
}

export function download(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A file-safe name: "ziggy-worker-agt-1f3a". */
export const fileName = (t: BotTraits) => `${t.name}-${t.role}-${t.seed}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").slice(0, 60);
