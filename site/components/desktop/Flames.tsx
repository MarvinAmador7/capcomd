"use client";

// Flame graphs of the main thread from the perf log's Time Profiler exports (public/desktop/perf-trees.json, fetched
// once the first graph mounts). Every sample is one millisecond on the CPU; graphs that share a scale use the same pixels per
// sample, so their widths compare. Chains that never branch are folded into one bar. Hover or focus a bar to read
// it; click or Enter zooms into it, again to zoom out.
import { useEffect, useMemo, useRef, useState } from "react";

type Node = { n: string; v: number; c?: Node[] };
type Bar = { label: string; chain: string[]; v: number; cat: string; c: Bar[] };
type TreeKey = "before" | "middle" | "after" | "switch";

export const CATS: Array<[string, string, RegExp]> = [
  ["focus", "focus walk", /FocusNavigat|ResponderNode|MultiViewResponder|PlatformUnaryViewResponder|ViewResponder|acceptsFirstResponder|_regionForOpaque|_opaqueRect|_resetDragMargins/],
  ["scroll", "scrolling", /NSScrollAnimationHelper|_immediateScrollToPoint|translateOriginToPoint|_postBoundsChange|ScrollViewCommitMutation|ScrollViewHelper|HostingScrollView|setBoundsOrigin|ReelView\.slide|NSClipView/],
  ["track", "tracking areas", /TrackingArea/],
  ["text", "text", /Text\.|TextFilter|TextHelper|CoreText|CTLine|CTFrame|TimeDataFormatting|NSTextField|AttributedString/],
  ["free", "teardown", /dealloc|deinit|autoreleasePool|AutoreleasePool|invalidate_now|Node::destroy|_finalize/],
  ["ours", "capcomd", /^(Reel|Desk|Column|Capcomd|EntryRow|CrewTab|OpenGroup|TitleBar|Thread[A-Z]|Composer|Bot)|ReelRepresentable|ReelView/],
  ["ca", "Core Animation", /^CA::|CALayer|CABackingStore|CA::Context/],
  ["layout", "AppKit layout", /layoutSubtree|_NSViewLayout|NSView layout|_findAnySubviewNeedingAutoLayoutEngine|NSISEngine|updateConstraints|NSHostingView\.layout/],
  ["graph", "SwiftUI graph", /^AG|ViewGraph|GraphHost|Attribute|LayoutEngine|sizeThatFits|Layout|DisplayList|ForEach|ViewList|Lazy|UpdateGroup|EventBinding|StatefulRule|Subgraph|SwiftUI|PlatformViewChild|RootGeometry/],
];
const NAMES: Record<string, string> = { loop: "run loop", ...Object.fromEntries(CATS.map(([k, n]) => [k, n])) };
const catOf = (name: string, parent: string) => { for (const [k, , rx] of CATS) if (rx.test(name)) return k; return parent; };

/** Folds chains (a node whose only child holds 97% or more of it) and tags each bar with the system that spent it. */
function prep(node: Node, parentCat: string): Bar {
  const chain = [node.n]; let cur = node;
  while (cur.c?.length === 1 && cur.c[0].v >= cur.v * 0.97) { cur = cur.c[0]; chain.push(cur.n); }
  let cat = parentCat; for (const f of chain) cat = catOf(f, cat);
  return { label: chain[chain.length - 1], chain, v: node.v, cat, c: (cur.c ?? []).map((k) => prep(k, cat)) };
}

let trees: Promise<Record<TreeKey, Node>> | null = null;
const load = () => (trees ??= fetch("/desktop/perf-trees.json").then((r) => r.json()).then((d: { trees: Record<TreeKey, Node> }) => d.trees));

const RH = 18, MAXD = 32;

export function FlameKey() {
  return <p className="pf-fkey">{["loop", "layout", "graph", "focus", "scroll", "track", "text", "ca", "free", "ours"].map((k) => <span key={k}><i className={`pf-k-${k}`} />{NAMES[k]}</span>)}</p>;
}

export function Flame({ tree, scaleTo, title, sub }: { tree: TreeKey; scaleTo?: TreeKey; title: string; sub: string }) {
  const [data, setData] = useState<Record<TreeKey, Node> | null>(null);
  const [w, setW] = useState(0);
  const [zoom, setZoom] = useState<Bar | null>(null);
  const [tip, setTip] = useState<{ b: Bar; x: number; y: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => { let on = true; load().then((d) => on && setData(d), () => on && setFailed(true)); return () => { on = false; }; }, []);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const root = useMemo(() => (data ? prep(data[tree], "loop") : null), [data, tree]);
  const bars = useMemo(() => {
    if (!root || !data || !w) return { list: [] as Array<{ b: Bar; x: number; d: number; bw: number }>, h: 0 };
    const top = zoom ?? root;
    const scale = zoom ? w / top.v : w / data[scaleTo ?? tree].v;
    const list: Array<{ b: Bar; x: number; d: number; bw: number }> = [];
    let depth = 0;
    (function walk(b: Bar, x: number, d: number) {
      const bw = b.v * scale; if (bw < 0.6 || d > MAXD) return;
      list.push({ b, x, d, bw }); depth = Math.max(depth, d);
      let cx = x; for (const k of b.c) { walk(k, cx, d + 1); cx += k.v * scale; }
    })(top, 0, 0);
    return { list, h: (depth + 1) * RH };
  }, [root, data, w, zoom, scaleTo, tree]);

  const total = root?.v ?? 1;
  const show = (b: Bar, el: Element, e?: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect(), t = el.getBoundingClientRect();
    setTip({ b, x: (e ? e.clientX : t.left) - r.left, y: (e ? e.clientY : t.bottom) - r.top });
  };
  const toggle = (b: Bar) => { setZoom((z) => (z === b ? null : b)); setTip(null); };

  return (
    <figure className="pf-flame">
      <figcaption className="pf-flame__head">
        <span><b>{title}</b> {sub}</span>
        {zoom ? <button type="button" onClick={() => setZoom(null)}>Zoom out</button> : null}
      </figcaption>
      <div className="pf-flame__box" ref={box} onPointerLeave={() => setTip(null)}>
        {bars.list.length ? (
          <svg width={w} height={bars.h} viewBox={`0 0 ${w} ${bars.h}`} role="img" aria-label={`Flame graph, ${title}: ${total.toLocaleString("en")} main-thread samples.`}>
            {bars.list.map(({ b, x, d, bw }, i) => {
              const fit = Math.floor((bw - 8) / 7.3);
              let s = b.label + (b.chain.length > 1 ? `  +${b.chain.length - 1}` : "");
              if (s.length > fit) s = s.slice(0, Math.max(1, fit - 1)) + "…";
              return (
                <g key={i} className={`pf-k-${b.cat}`}>
                  <rect x={x + 0.25} y={d * RH} width={Math.max(0.4, bw - 0.5)} height={RH - 1} tabIndex={bw > 24 ? 0 : -1} aria-label={`${b.label}, ${b.v.toLocaleString("en")} samples`}
                    onPointerMove={(e) => show(b, e.currentTarget, e)} onFocus={(e) => show(b, e.currentTarget)} onBlur={() => setTip(null)}
                    onClick={() => toggle(b)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(b); } }} />
                  {bw > 52 ? <text x={x + 4} y={d * RH + 12.5}>{s}</text> : null}
                </g>
              );
            })}
          </svg>
        ) : <p className="pf-flame__wait">{failed ? "The profile didn't load. Reload the page to try again." : "Loading the profile…"}</p>}
        {tip ? (
          <div className="pf-tip" style={{ left: Math.min(tip.x + 14, w - 300), top: tip.y + 14 }} aria-hidden="true">
            <b>{tip.b.label}</b>
            {tip.b.chain.length > 1 ? <span>{tip.b.chain.length} frames folded, from {tip.b.chain[0]}</span> : null}
            <span>{tip.b.v.toLocaleString("en")} samples · {((tip.b.v / total) * 100).toFixed(1)}% · {NAMES[tip.b.cat]}</span>
          </div>
        ) : null}
      </div>
    </figure>
  );
}
