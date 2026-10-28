// Shared identity for the art-direction comps: the pixel CAPCOMD wordmark (redrawn here on a cell grid, not
// copied from the brand files) and mounting of the deterministic bots from packages/bot-avatar
// (bundled as ./bot-avatar.js by `bun build packages/bot-avatar/src/index.ts`).
import { botSvg, botTeam } from "./bot-avatar.js";

// 9 cells tall, 2-cell strokes, chamfered corners. "#" is a filled cell.
const GLYPHS = {
  C: ["..######", ".#######", "###.....", "##......", "##......", "##......", "###.....", ".#######", "..######"],
  A: ["..####..", ".######.", "###..###", "##....##", "##....##", "########", "########", "##....##", "##....##"],
  P: ["#######.", "########", "##....##", "##....##", "########", "#######.", "##......", "##......", "##......"],
  O: ["..####..", ".######.", "###..###", "##....##", "##....##", "##....##", "###..###", ".######.", "..####.."],
  M: ["###....###", "####..####", "##.####.##", "##..##..##", "##......##", "##......##", "##......##", "##......##", "##......##"],
  D: ["######..", "#######.", "##...###", "##....##", "##....##", "##....##", "##...###", "#######.", "######.."],
};

export function wordmarkSvg({ word = "CAPCOMD", gap = 2, label = "capcomd" } = {}) {
  let x0 = 0, d = "";
  for (const ch of word) {
    const g = GLYPHS[ch];
    g.forEach((row, y) => {
      for (let x = 0; x < row.length;) {
        if (row[x] !== "#") { x++; continue; }
        let n = 1;
        while (row[x + n] === "#") n++;
        d += `M${x0 + x} ${y}h${n}v1h-${n}z`;
        x += n;
      }
    });
    x0 += g[0].length + gap;
  }
  const w = x0 - gap;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 9" shape-rendering="crispEdges" role="img" aria-label="${label}"><path fill="currentColor" d="${d}"/></svg>`;
}

/** Fill every [data-wordmark] and every [data-bot] on the page. */
export function mountBrand(root = document) {
  root.querySelectorAll("[data-wordmark]").forEach((el) => { el.innerHTML = wordmarkSvg(); });
  // Teams: elements sharing data-team are made distinct in DOM order, like botTeam() in the app.
  const teams = new Map();
  root.querySelectorAll("[data-bot][data-team]").forEach((el) => {
    const k = el.dataset.team; if (!teams.has(k)) teams.set(k, []); teams.get(k).push(el);
  });
  const traitsFor = new Map();
  for (const els of teams.values()) {
    const t = botTeam(els.map((el) => ({ seed: el.dataset.bot, role: el.dataset.role || null })));
    els.forEach((el, i) => traitsFor.set(el, t[i]));
  }
  root.querySelectorAll("[data-bot]").forEach((el) => renderBot(el, traitsFor.get(el)));
}

export function renderBot(el, traits) {
  const o = el.dataset;
  el.innerHTML = botSvg({
    seed: o.bot, role: o.role || null, size: o.size || "full", scale: 1,
    mood: o.mood || undefined, pose: o.pose || undefined, accessory: o.accessory || undefined,
    traits, decorative: o.decorative === "true", label: o.label || undefined,
  });
  const svg = el.firstElementChild;
  svg.removeAttribute("width"); svg.removeAttribute("height");
}

export { botSvg, botTeam };
