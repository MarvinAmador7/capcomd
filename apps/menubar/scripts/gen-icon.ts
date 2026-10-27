// The capcomd app icon: the approved menu bar mark (packages/bot-avatar MENU_BAR_MARK, the dome bot head) in white
// on a rounded square in the brand orange, as a macOS .iconset (every size iconutil wants). The mark is scaled by
// whole pixels per cell (nearest neighbour), so it stays crisp at every size; only the background's corners are
// antialiased. No dependencies: PNGs are written by hand (zlib from node:zlib).
//
//   bun apps/menubar/scripts/gen-icon.ts <out.iconset>   then   iconutil -c icns <out.iconset> -o AppIcon.icns
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { MENU_BAR_MARK } from "../../../packages/bot-avatar/src/marks.ts";

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const TOP = hex("#FF8A2E"), BOTTOM = hex("#F26A0C");   // the brand orange (#FF7410) with a little light from above
const INK = hex("#FFFFFF");                           // the mark
const DROP = hex("#B8480A");                          // the mark's one-cell pixel shadow (the palette's deep orange)

/** The mark's lit cells, cropped to their bounding box. */
function markCells(rows: string[]): { w: number; h: number; on: (x: number, y: number) => boolean } {
  const ys = rows.flatMap((r, y) => (r.includes("#") ? [y] : []));
  const xs = rows.flatMap((r) => [...r].flatMap((c, x) => (c === "#" ? [x] : [])));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, on: (x, y) => rows[y + y0]?.[x + x0] === "#" };
}

/** Signed distance from (px, py) to a rounded rectangle (negative inside). */
function roundedRectDistance(px: number, py: number, x: number, y: number, side: number, r: number): number {
  const cx = x + side / 2, cy = y + side / 2, half = side / 2 - r;
  const qx = Math.abs(px - cx) - half, qy = Math.abs(py - cy) - half;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** One icon, `size` pixels square, as RGBA. */
export function renderIcon(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const mark = markCells(MENU_BAR_MARK);
  // Apple's grid: an 824/1024 rounded square (corner radius 0.225 of its side), shadow below. Tiny sizes go nearly
  // full bleed so the mark keeps whole pixels.
  let inset = Math.round((size * 100) / 1024);
  let cell = Math.max(1, Math.floor(((size - 2 * inset) * 0.68) / mark.w));
  if (mark.w * cell + 2 > size - 2 * inset) inset = Math.max(0, Math.floor((size - mark.w * cell - 2) / 2));
  const side = size - 2 * inset, radius = side * 0.225;
  const shadow = size >= 64, blur = size * 0.022, drop = size * 0.01;

  const put = (i: number, c: RGB, a: number) => {
    // "over" compositing onto what's there (premultiplied maths, straight alpha out)
    const da = px[i + 3]! / 255, oa = a + da * (1 - a);
    if (oa <= 0) return;
    for (let k = 0; k < 3; k++) px[i + k] = Math.round((c[k]! * a + px[i + k]! * da * (1 - a)) / oa);
    px[i + 3] = Math.round(oa * 255);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (shadow) {
        const d = roundedRectDistance(x + 0.5, y + 0.5 - drop, inset, inset, side, radius);
        if (d < blur * 6) put(i, [0, 0, 0], 0.28 * Math.exp(-Math.max(0, d) / blur));
      }
      // 4×4 supersampled coverage of the rounded square
      let cover = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        if (roundedRectDistance(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4, inset, inset, side, radius) <= 0) cover++;
      }
      if (cover === 0) continue;
      const t = Math.min(1, Math.max(0, (y - inset) / side));
      const bg: RGB = [0, 1, 2].map((k) => Math.round(TOP[k]! + (BOTTOM[k]! - TOP[k]!) * t)) as RGB;
      put(i, bg, cover / 16);
    }
  }

  // The mark, centred on the square, whole pixels per cell; its shadow one cell down (from 32 px up).
  const mx = inset + Math.floor((side - mark.w * cell) / 2), my = inset + Math.floor((side - mark.h * cell) / 2);
  const paint = (ox: number, oy: number, c: RGB) => {
    for (let cy = 0; cy < mark.h; cy++) for (let cx = 0; cx < mark.w; cx++) {
      if (!mark.on(cx, cy)) continue;
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
        const X = mx + ox + cx * cell + x, Y = my + oy + cy * cell + y;
        if (X >= 0 && Y >= 0 && X < size && Y < size) put((Y * size + X) * 4, c, 1);
      }
    }
  };
  if (cell >= 2) paint(0, cell, DROP);
  paint(0, 0, INK);
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGBA → PNG (8-bit, colour type 6, no filtering). */
export function png(rgba: Uint8Array, size: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
  hv.setUint32(0, size); hv.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir?.endsWith(".iconset")) { console.error("usage: bun gen-icon.ts <out.iconset>"); process.exit(2); }
  mkdirSync(dir, { recursive: true });
  for (const pt of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const size = pt * scale;
      writeFileSync(join(dir, `icon_${pt}x${pt}${scale === 2 ? "@2x" : ""}.png`), png(renderIcon(size), size));
    }
  }
}
