import { markSvg, MENU_BAR_MARK } from "./vendor/bot-avatar.js";

// The pixel CAPCOMD wordmark, redrawn on a cell grid (9 cells tall, 2-cell strokes), not copied from the brand files.
const GLYPHS: Record<string, string[]> = {
  C: ["..######", ".#######", "###.....", "##......", "##......", "##......", "###.....", ".#######", "..######"],
  A: ["..####..", ".######.", "###..###", "##....##", "##....##", "########", "########", "##....##", "##....##"],
  P: ["#######.", "########", "##....##", "##....##", "########", "#######.", "##......", "##......", "##......"],
  O: ["..####..", ".######.", "###..###", "##....##", "##....##", "##....##", "###..###", ".######.", "..####.."],
  M: ["###....###", "####..####", "##.####.##", "##..##..##", "##......##", "##......##", "##......##", "##......##", "##......##"],
  D: ["######..", "#######.", "##...###", "##....##", "##....##", "##....##", "##...###", "#######.", "######.."],
};

/** The wordmark as SVG, in currentColor, hidden from assistive tech (the link around it carries the name). */
export function wordmarkSvg(word = "CAPCOMD", gap = 2): string {
  let x0 = 0, d = "";
  for (const ch of word) {
    const g = GLYPHS[ch]!;
    g.forEach((row, y) => {
      for (let x = 0; x < row.length;) {
        if (row[x] !== "#") { x++; continue; }
        let n = 1;
        while (row[x + n] === "#") n++;
        d += `M${x0 + x} ${y}h${n}v1h-${n}z`;
        x += n;
      }
    });
    x0 += g[0]!.length + gap;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x0 - gap} 9" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path fill="currentColor" d="${d}"/></svg>`;
}

/** The app's menu bar mark (the dome bot head), in one colour. */
export const menuMarkSvg = (color: string): string => markSvg(MENU_BAR_MARK, { color }).replace(/ width="\d+" height="\d+"/, "");

/** The favicon: the orange mark on a plum tile. */
export function faviconSvg(): string {
  const path = markSvg(MENU_BAR_MARK, { color: "#FF7410" }).match(/<path[^>]*\/>/)![0];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" rx="3" fill="#2B0E57"/>${path}</svg>`;
}
