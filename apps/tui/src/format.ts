export function dur(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "0s";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
export const usd = (x: number | undefined) => (x === undefined ? "—" : x < 0.01 && x > 0 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
export const pad = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s.padEnd(n));
export const lpad = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s.padStart(n));
export const clock = (ms: number) => `+${dur(ms)}`;

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
/**
 * A bar inside a track of `width` cells, positioned with 1/8-cell precision on the leading
 * edge of the fill so short spans still read as distinct. Returns [lead, fill, trail].
 */
export function bar(start: number, end: number, total: number, width: number): [string, string, string] {
  const t = Math.max(1, total);
  const a = Math.max(0, Math.min(width, (start / t) * width));
  const b = Math.max(a, Math.min(width, (end / t) * width));
  const lead = Math.floor(a);
  let fillCells = b - lead;
  if (fillCells < 1 / 8) fillCells = 1 / 8; // always visible
  const full = Math.floor(fillCells);
  const part = EIGHTHS[Math.round((fillCells - full) * 8)] ?? "";
  let fill = "█".repeat(full) + part;
  if (lead + fill.length > width) fill = fill.slice(0, width - lead);
  return [" ".repeat(lead), fill, " ".repeat(Math.max(0, width - lead - fill.length))];
}

/** Axis ticks under a track: "0s        1m 40s        3m 20s". */
export function axis(total: number, width: number, ticks = 4): string {
  const cells = Array(width).fill(" ");
  for (let i = 0; i <= ticks; i++) {
    const label = dur((total * i) / ticks);
    const pos = Math.min(width - label.length, Math.round((width * i) / ticks) - (i === ticks ? label.length : i === 0 ? 0 : Math.floor(label.length / 2)));
    for (let k = 0; k < label.length; k++) cells[Math.max(0, pos) + k] = label[k];
  }
  return cells.join("");
}
