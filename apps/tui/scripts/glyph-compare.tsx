/** FORCE_COLOR=3 bun scripts/glyph-compare.tsx — v1 vs candidates A/B, demo + task-timeout, two fonts. */
import { writeFileSync } from "node:fs";
import { SETS, type IconSet } from "../src/icons";
import { renderView } from "./render";
import { toHtml } from "./shots";

const out = Bun.argv[2] ?? "/workspace/capcomd-tui-shots";
const sets: Array<[IconSet, string]> = [["glyph-v1", "current (v1)"], ["glyph", "A · filled/hollow/line (new default)"], ["glyph-b", "B · triangles/squares"]];
const fonts = ["JetBrainsMono NFM", "DejaVu Sans Mono"];
const body = (ansi: string) => toHtml(ansi).split("<pre>")[1]!.split("</pre>")[0]!;
const legend = (k: IconSet) => { const s = SETS[k as Exclude<IconSet, "none">]; return Object.entries(s.kind).map(([n, g]) => `${g} ${n}`).join("  ") + "\nstatus " + Object.entries(s.status).map(([n, g]) => `${g} ${n}`).join("  "); };

const panels: Record<string, string[]> = {};
for (const [k, title] of sets) {
  const demo = await renderView("demo-3-tasks", "waterfall", { icons: k, width: 96, height: 40 });
  const real = await renderView("task-timeout", "waterfall", { icons: k, width: 96, height: 24, waterfallSel: 60 });
  panels[k] = [title, legend(k), body(demo), body(real)];
  const one = fonts.map((f) => `<h3>${f}</h3><pre style="font-family:'${f}'">${title}\n${legend(k)}\n\n${body(demo)}\n\n${body(real)}</pre>`).join("");
  writeFileSync(`${out}/glyph-v2-${k}.html`, page(one, "flex"));
}
const cols = sets.map(([k]) => k);
const grid = fonts.map((f) => `<h3>${f}</h3><div class=row>${cols.map((k) => `<pre style="font-family:'${f}'">${panels[k]![0]}\n${panels[k]![1]}\n\n${panels[k]![2]}\n\n${panels[k]![3]}</pre>`).join("")}</div>`).join("");
writeFileSync(`${out}/glyph-v2-compare.html`, page(grid, "block"));

function page(inner: string, _d: string) {
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:12px;background:#15171a;color:#8A8F98;font:14px sans-serif}
h3{margin:14px 10px 4px;font-weight:500}.row{display:flex;gap:14px}
pre{margin:0;padding:14px 16px;background:#1b1d21;color:#E6E6E6;font-size:12px;line-height:1.32;white-space:pre}</style>${inner}`;
}
