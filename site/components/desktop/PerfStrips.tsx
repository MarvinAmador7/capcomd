"use client";

// The main thread as a barcode: nine seconds of a DeskBench scenario (`step` along the reel, or `switch` between
// projects) on the 17-agent fixture, one xctrace sample per millisecond, before and after the AppKit reel
// (lib/perf-reel.json, from the "Benching the Reel" log).
// Ink where the thread was on the CPU, orange inside a run of 17 ms or more (a frame it couldn't draw). A playhead
// sweeps both once when they come into view; pointer or arrow keys read any moment.
import { useEffect, useMemo, useRef, useState } from "react";
import DATA from "@/lib/perf-reel.json";

const MS = 9000, FRAME = 17;
type Strip = { first: number; runs: number[]; steps: number[][] };

/** Expands a run-length strip into per-ms flags: 0 idle, 1 on CPU, 2 on CPU inside a run of FRAME ms or more. */
function expand(s: Strip): { at: Uint8Array; runAt: Uint16Array } {
  const at = new Uint8Array(MS), runAt = new Uint16Array(MS);
  let i = 0, on = s.first === 1;
  for (const n of s.runs) {
    if (on) { at.fill(n >= FRAME ? 2 : 1, i, i + n); runAt.fill(n, i, i + n); }
    i += n; on = !on;
  }
  return { at, runAt };
}

const LANES = [
  { key: "before", name: "Before", sub: "SwiftUI reel · 3a6b5b7" },
  { key: "after", name: "After", sub: "AppKit reel · 9bcd41a" },
] as const;
const CAPTION = { step: "Nine seconds of reel steps, 17 agents, one sample a millisecond.", switch: "Nine seconds of project switches, 17 agents, one sample a millisecond." };

export function PerfStrips({ scenario = "step" }: { scenario?: "step" | "switch" }) {
  const lanes = useMemo(() => LANES.map((l) => { const s = DATA[scenario][l.key] as Strip; return { ...l, ...expand(s), steps: s.steps }; }), [scenario]);
  const cvs = useRef<Array<HTMLCanvasElement | null>>([]);
  const box = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(MS); // the playhead, in ms; at rest it stands at the end
  const [cursor, setCursor] = useState<number | null>(null);

  // On-CPU milliseconds up to the playhead, per lane (prefix sums, so the sweep costs nothing per frame).
  const sums = useMemo(() => lanes.map((l) => { const p = new Uint16Array(MS + 1); for (let i = 0; i < MS; i++) p[i + 1] = p[i] + (l.at[i] ? 1 : 0); return p; }), [lanes]);

  useEffect(() => {
    const draw = () => lanes.forEach((l, k) => {
      const cv = cvs.current[k]; if (!cv) return;
      const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      const g = cv.getContext("2d")!; g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
      const css = getComputedStyle(cv);
      const ink = css.getPropertyValue("--strip-on").trim(), over = css.getPropertyValue("--strip-over").trim(), mark = css.getPropertyValue("--strip-mark").trim();
      const top = 10;
      for (let x = 0; x < w; x++) {
        const a = Math.floor((x * MS) / w), b = Math.max(a + 1, Math.floor(((x + 1) * MS) / w));
        let on = 0, ov = 0; for (let i = a; i < b; i++) { if (l.at[i]) on++; if (l.at[i] === 2) ov++; }
        if (!on) continue;
        g.globalAlpha = 0.3 + 0.7 * (on / (b - a));
        g.fillStyle = ov > on / 2 ? over : ink;
        g.fillRect(x, top, 1, h - top);
      }
      g.globalAlpha = 1; g.fillStyle = mark;
      for (const [a, b] of l.steps) { const x0 = (a / MS) * w, x1 = Math.min(w, (b / MS) * w); if (x0 < w) { g.fillRect(x0, 3, Math.max(1, x1 - x0), 2); g.fillRect(x0, 0, 1, 7); } }
    });
    draw();
    const ro = new ResizeObserver(draw);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [lanes]);

  // One sweep at twice real time when the strips come into view.
  useEffect(() => {
    if (!box.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const t0 = performance.now();
      const tick = (now: number) => { const v = Math.min(MS, (now - t0) * 2); setT(v); if (v < MS) raf = requestAnimationFrame(tick); };
      setT(0); raf = requestAnimationFrame(tick);
    }, { threshold: 0.6 });
    io.observe(box.current);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  const at = cursor ?? t;
  const pick = (clientX: number) => { const r = box.current!.getBoundingClientRect(); setCursor(Math.max(0, Math.min(MS - 1, Math.round(((clientX - r.left) / r.width) * MS)))); };
  const key = (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowRight" ? 250 : e.key === "ArrowLeft" ? -250 : 0;
    if (e.key === "Home") { e.preventDefault(); setCursor(0); }
    else if (e.key === "End") { e.preventDefault(); setCursor(MS - 1); }
    else if (d) { e.preventDefault(); setCursor((c) => Math.max(0, Math.min(MS - 1, (c ?? MS - 1) + d))); }
  };
  const state = (k: number) => { const i = Math.min(MS - 1, Math.floor(at)); const v = lanes[k].at[i]; return v === 2 ? `busy, ${lanes[k].runAt[i]} ms without a break` : v ? "busy, under a frame" : "asleep"; };

  return (
    <figure className="dk-strips" data-ui>
      <div className="dk-strips__lanes" ref={box} style={{ ["--rec" as string]: `${100 - (t / MS) * 100}%` }} tabIndex={0} role="slider" aria-label="Time in the recording" aria-valuemin={0} aria-valuemax={9} aria-valuenow={Math.round(at / 100) / 10}
        aria-valuetext={`${(at / 1000).toFixed(1)} s. Before: ${state(0)}. After: ${state(1)}.`}
        onPointerMove={(e) => pick(e.clientX)} onPointerDown={(e) => pick(e.clientX)} onPointerLeave={() => setCursor(null)} onKeyDown={key} onBlur={() => setCursor(null)}>
        {lanes.map((l, k) => (
          <div key={l.key} className={`dk-lane dk-lane--${l.key}`}>
            <p className="dk-lane__name"><b>{l.name}</b> {l.sub}</p>
            <canvas ref={(c) => { cvs.current[k] = c; }} aria-hidden="true" />
            <p className="dk-lane__sum"><b>{(sums[k][Math.floor(at)] / 1000).toFixed(1)} s</b> on the CPU</p>
          </div>
        ))}
        {(cursor !== null || t < MS) && <span className="dk-strips__head" style={{ left: `${(at / MS) * 100}%` }} aria-hidden="true" />}
      </div>
      <figcaption>
        <span className="dk-strips__at">{cursor === null ? CAPTION[scenario] : `${(at / 1000).toFixed(2)} s · before: ${state(0)} · after: ${state(1)}`}</span>
        <span className="dk-strips__key"><i className="k-on" />on the CPU <i className="k-over" />a run longer than a frame</span>
      </figcaption>
    </figure>
  );
}
