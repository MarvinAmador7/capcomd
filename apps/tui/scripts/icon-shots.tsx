/** FORCE_COLOR=3 bun scripts/icon-shots.tsx — one HTML per icon set: demo + real task-timeout waterfall. */
import { writeFileSync } from "node:fs";
import { SETS } from "../src/icons";
import { renderView } from "./render";
import { toHtml } from "./shots";

const out = Bun.argv[2] ?? "/workspace/capcomd-tui-shots";
for (const v of ["glyph", "nerd", "minimal"] as const) {
  const demo = await renderView("demo-3-tasks", "waterfall", { icons: v, height: 44 });
  const real = await renderView("task-timeout", "waterfall", { icons: v, height: 30 });
  const s = SETS[v];
  const legend = [`icons: ${v}  —  ${s.note}`, Object.entries(s.kind).map(([k, g]) => `${g} ${k}`).join("   "), `status: ${Object.entries(s.status).map(([k, g]) => `${g} ${k}`).join("   ")}`].join("\n");
  writeFileSync(`${out}/icons-${v}.html`, toHtml(`${legend}\n\n── demo-3-tasks (synthetic) ──\n${demo}\n\n── task-timeout (real trace) ──\n${real}`));
  console.log(v);
}
