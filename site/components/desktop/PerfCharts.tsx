// The perf log's charts, drawn at build time from lib/perf-log.json (no script): one slide on two threads, the
// compositor's hitches, main-thread time by burst length, and the A/B ranges. Before is drawn in muted ink, after in
// plum; the accent marks time past a frame.
import LOG from "@/lib/perf-log.json";

const W = 1120;
const fmt = (v: number) => (v >= 100 ? Math.round(v).toLocaleString("en") : String(Math.round(v * 10) / 10));

function Chart({ h, title, desc, children }: { h: number; title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="pf-chart">
      <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`${title}. ${desc}`}>{children}</svg>
    </div>
  );
}

/** One 350 ms slide: before, the main thread works every tick and the panel gets a frame every 41.7 ms; after, one
 *  update at the start and the render server draws a frame every 8.3 ms. Drawn from the bench's medians. */
export function SlideLanes() {
  const X0 = 210, X1 = 1100, T = 350, sx = (t: number) => X0 + (t / T) * (X1 - X0);
  const rows: Array<[string, string, number]> = [["Before", "main thread", 20], ["", "render server", 66], ["After", "main thread", 142], ["", "render server", 188]];
  const before = [], after = [];
  for (let t = 0; t < T; t += 41.7) before.push(t);
  for (let t = 12.5; t < T; t += 8.33) after.push(t);
  return (
    <Chart h={262} title="One 350 ms slide, before and after" desc="Before, the main thread works through every frame and the panel gets a new frame about every 42 ms. After, the main thread does one update at the start and the render server draws a frame every 8.3 ms.">
      {rows.map(([a, b, y]) => (
        <g key={y}>
          {a ? <text x={0} y={y + 17} className="pf-t-strong">{a}</text> : null}
          <text x={72} y={y + 17}>{b}</text>
          <line x1={X0} x2={X1} y1={y + 30} y2={y + 30} className="pf-rule" />
        </g>
      ))}
      {before.map((t) => <g key={t}><rect x={sx(t)} y={24} width={sx(t + 36) - sx(t)} height={24} className="pf-busy" /><rect x={sx(t + 37)} y={70} width={Math.max(3, sx(t + 39) - sx(t + 37))} height={24} className="pf-frame" /></g>)}
      <rect x={sx(0)} y={146} width={sx(12) - sx(0)} height={24} className="pf-busy" />
      {after.map((t) => <rect key={t} x={sx(t)} y={192} width={Math.max(3, sx(t + 1.6) - sx(t))} height={24} className="pf-frame" />)}
      <text x={sx(16)} y={163} className="pf-t-note">one setBoundsOrigin, then one additive CABasicAnimation</text>
      <text x={sx(0)} y={121} className="pf-t-note">every tick: setBoundsOrigin → bounds change → 16 SwiftUI graphs update</text>
      {[0, 50, 100, 150, 200, 250, 300, 350].map((t) => (
        <g key={t}><line x1={sx(t)} x2={sx(t)} y1={226} y2={232} className="pf-rule" /><text x={sx(t)} y={252} textAnchor={t === 0 ? "start" : t === T ? "end" : "middle"}>{t} ms</text></g>
      ))}
    </Chart>
  );
}

/** Every hitch the Animation Hitches instrument recorded in 12 s, as a spike as tall as it was late (square-root scale). */
export function Hitches() {
  const X0 = 170, X1 = 1100, H = 118, maxMs = 450;
  const span = Math.max(...LOG.hitches.before.map(([t, ms]) => t + ms)) - Math.min(...LOG.hitches.before.map(([t]) => t));
  const panels: Array<["before" | "after", string, number]> = [["before", "Before", 16], ["after", "After", 172]];
  return (
    <Chart h={330} title="Compositor hitches over a 12-second recording" desc="Before, 257 hitches, up to 450 ms late. After, 52, none more than 25 ms late.">
      {panels.map(([k, name, y0]) => {
        const hs = LOG.hitches[k], t0 = Math.min(...hs.map(([t]) => t));
        const sy = (ms: number) => y0 + H - Math.sqrt(ms / maxMs) * H;
        return (
          <g key={k} className={`pf-${k}`}>
            <text x={0} y={y0 + 16} className="pf-t-strong">{name}</text>
            <text x={0} y={y0 + 36}>{hs.length} hitches</text>
            <text x={0} y={y0 + 54}>worst {fmt(Math.max(...hs.map(([, ms]) => ms)))} ms late</text>
            {[16.7, 100, 450].map((ms) => <g key={ms}><line x1={X0} x2={X1} y1={sy(ms)} y2={sy(ms)} className={ms === 16.7 ? "pf-rule pf-rule--frame" : "pf-rule"} /><text x={X0 - 10} y={sy(ms) + 4} textAnchor="end" className="pf-t-small">{ms} ms</text></g>)}
            <line x1={X0} x2={X1} y1={y0 + H} y2={y0 + H} className="pf-rule pf-rule--base" />
            {hs.map(([t, ms], i) => { const x = X0 + ((t - t0) / span) * (X1 - X0); return x > X1 ? null : <line key={i} x1={x} x2={x} y1={y0 + H} y2={sy(ms)} className="pf-spike" />; })}
          </g>
        );
      })}
      {[0, 2, 4, 6, 8, 10, 12].map((s) => { const x = X0 + ((s * 1000) / span) * (X1 - X0); return x > X1 + 1 ? null : <text key={s} x={x} y={318} textAnchor={s === 0 ? "start" : "middle"}>{s} s</text>; })}
    </Chart>
  );
}

/** Main-thread time by how long the thread held on without going back to the run loop, weighted by the time spent. */
export function Bursts() {
  const edges = [1, 2, 4, 8.3, 16.7, 33.3, 66, 133, 266, 533, 1066];
  const X0 = 170, X1 = 1100, mid = 150, H = 112, bw = (X1 - X0) / (edges.length - 1);
  const sums = (ns: number[]) => { const s = new Array(edges.length - 1).fill(0); for (const n of ns) for (let i = 0; i < edges.length - 1; i++) if (n >= edges[i] && n < edges[i + 1]) { s[i] += n; break; } return s as number[]; };
  const a = sums(LOG.bursts.before), b = sums(LOG.bursts.after), mx = Math.max(...a, ...b);
  const total = (s: number[]) => (s.reduce((x, y) => x + y, 0) / 1000).toFixed(1);
  return (
    <Chart h={306} title="Main-thread time by burst length" desc={`Before, most main-thread time was in bursts of 66 to 266 ms, ${total(a)} s in all. After, it sits in bursts under 33 ms, ${total(b)} s in all.`}>
      <rect x={X0 + 4 * bw} y={mid - H - 8} width={(edges.length - 5) * bw} height={2 * H + 16} className="pf-over" />
      <text x={X0 + 4 * bw + 8} y={mid - H + 6} className="pf-t-over">longer than a frame at 60 Hz</text>
      {a.map((v, i) => {
        const x = X0 + i * bw + 8, w = bw - 16, ha = (v / mx) * H, hb = (b[i] / mx) * H;
        return (
          <g key={i}>
            <rect x={x} y={mid - ha} width={w} height={Math.max(0.5, ha)} className="pf-before-fill" />
            <rect x={x} y={mid + 1} width={w} height={Math.max(0.5, hb)} className="pf-after-fill" />
            {v > mx * 0.04 ? <text x={x + w / 2} y={mid - ha - 6} textAnchor="middle" className="pf-t-small">{(v / 1000).toFixed(1)} s</text> : null}
            {b[i] > mx * 0.04 ? <text x={x + w / 2} y={mid + hb + 15} textAnchor="middle" className="pf-t-small">{(b[i] / 1000).toFixed(1)} s</text> : null}
            <text x={X0 + i * bw + bw / 2} y={298} textAnchor="middle" className="pf-t-small">{edges[i]}–{edges[i + 1]}</text>
          </g>
        );
      })}
      <line x1={X0} x2={X1} y1={mid + 0.5} y2={mid + 0.5} className="pf-rule pf-rule--base" />
      <text x={0} y={mid - 40} className="pf-t-strong">Before</text><text x={0} y={mid - 20}>{total(a)} s on the CPU</text>
      <text x={0} y={mid + 34} className="pf-t-strong">After</text><text x={0} y={mid + 54}>{total(b)} s on the CPU</text>
      <text x={X1} y={278} textAnchor="end" className="pf-t-small">burst length, ms</text>
    </Chart>
  );
}

/** Each metric's range and median across the alternating runs, the noise band around the old median shaded. */
export function AbRanges() {
  const X0 = 320, X1 = 930, RH = 54, Y0 = 36;
  return (
    <Chart h={Y0 + LOG.ab.length * RH + 40} title="A/B ranges per metric" desc="For each metric, the range and median of the old build and the new one across five alternating runs a side, or thirty switches for switch latency.">
      <text x={X0} y={16} className="pf-t-small">0</text>
      <text x={X1} y={16} textAnchor="end" className="pf-t-small">each row to its own maximum</text>
      {LOG.ab.map((r, i) => {
        const y = Y0 + i * RH, mx = Math.max(r.a.max, r.b.max) * 1.05, sx = (v: number) => X0 + (v / mx) * (X1 - X0);
        const lo = sx(Math.max(0, r.a.median * (1 - r.band / 100))), hi = sx(Math.min(mx, r.a.median * (1 + r.band / 100)));
        return (
          <g key={r.s + r.m}>
            <text x={0} y={y + 12} className="pf-t-small">{r.s}</text>
            <text x={0} y={y + 31} className="pf-t-strong">{r.m}</text>
            <line x1={X0} x2={X1} y1={y + 20} y2={y + 20} className="pf-rule" />
            <rect x={lo} y={y + 4} width={hi - lo} height={32} className="pf-band" />
            {([[r.a, 13, "pf-before"], [r.b, 27, "pf-after"]] as const).map(([s, dy, c]) => (
              <g key={c} className={c}><line x1={sx(s.min)} x2={sx(s.max)} y1={y + dy} y2={y + dy} className="pf-range" /><circle cx={sx(s.median)} cy={y + dy} r={5} className="pf-dot" /></g>
            ))}
            <text x={X1 + 20} y={y + 18} className="pf-t-strong">{fmt(r.a.median)} → {fmt(r.b.median)}</text>
            <text x={X1 + 20} y={y + 35} className="pf-t-small">{r.u}, n = {r.a.n}</text>
          </g>
        );
      })}
      <g transform={`translate(${X0} ${Y0 + LOG.ab.length * RH + 14})`}>
        <circle cx={5} cy={0} r={5} className="pf-before pf-dot" /><text x={16} y={4}>before, median and range</text>
        <circle cx={225} cy={0} r={5} className="pf-after pf-dot" /><text x={236} y={4}>after</text>
        <rect x={300} y={-8} width={24} height={16} className="pf-band" /><text x={332} y={4}>noise band around the old median</text>
      </g>
    </Chart>
  );
}
