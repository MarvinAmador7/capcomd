/**
 * Render every view against fixtures to ANSI + HTML (for PNG capture with any headless browser).
 *   FORCE_COLOR=3 bun scripts/shots.tsx [outDir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TabKey } from "../src/app";
import { renderView } from "./render";

if (import.meta.main) await main();
async function main() {
const out = Bun.argv[2] ?? "/workspace/capcomd-tui-shots";
mkdirSync(out, { recursive: true });

const shots: Array<[string, string, TabKey, Record<string, unknown>?]> = [
  ["1-live", "demo-3-tasks", "live"],
  ["1b-live-real-subagents", "live-scope", "live"],
  ["3c-timeline-real-subagents", "live-scope", "timeline"],
  ["2c-waterfall-real-scope", "live-scope", "waterfall"],
  ["5d-events-real-scope", "live-scope", "events"],
  ["2-waterfall", "demo-3-tasks", "waterfall"],
  ["2b-waterfall-real-timeout", "task-timeout", "waterfall"],
  ["3-timeline", "demo-3-tasks", "timeline"],
  ["3b-timeline-real-timeout", "task-timeout", "timeline"],
  ["4-rollups", "demo-3-tasks", "rollups"],
  ["4b-rollups-real-retries", "claude-retries", "rollups"],
  ["5-events", "demo-3-tasks", "events"],
  ["5b-events-problems", "demo-3-tasks", "events", { eventsFamily: "problems" }],
  ["5c-events-real-boxd", "boxd-blocked", "events"],
  ["6-replay", "demo-3-tasks", "replay", { replayT: 200_000 }],
];

for (const [name, fixture, tab, extra] of shots) {
  const ansi = await renderView(fixture, tab, extra as any);
  writeFileSync(join(out, `${name}.ansi`), ansi);
  writeFileSync(join(out, `${name}.html`), toHtml(ansi));
  console.log(name);
}

}

export function toHtml(ansi: string): string {
  let html = "", fg = "", bold = false, dim = false, ul = false, open = false;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const flush = () => { if (open) html += "</span>"; open = false; };
  const start = () => {
    const st = [fg && `color:${fg}`, bold && "font-weight:700", dim && "opacity:.6", ul && "text-decoration:underline;text-underline-offset:3px"].filter(Boolean).join(";");
    if (st) { html += `<span style="${st}">`; open = true; }
  };
  for (const part of ansi.split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!m) { html += esc(part); continue; }
    const codes = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const k = codes[i]!;
      if (k === 0) { fg = ""; bold = dim = ul = false; }
      else if (k === 1) bold = true; else if (k === 2) dim = true; else if (k === 4) ul = true;
      else if (k === 22) bold = dim = false; else if (k === 24) ul = false; else if (k === 39) fg = "";
      else if (k === 38 && codes[i + 1] === 2) { fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
      else if (k === 38 && codes[i + 1] === 5) { fg = `var(--c${codes[i + 2]})`; i += 2; }
    }
    flush(); start();
  }
  flush();
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#15171a}
pre{margin:0;padding:22px 26px;color:#E6E6E6;font:13px/1.32 "JetBrainsMono NFM","DejaVu Sans Mono","JetBrains Mono",Menlo,monospace;display:inline-block;white-space:pre}
</style><pre>${html}</pre>`;
}
