"use client";

// "A night of the loop": the real experiments and findings of 30–31 Oct 2026 (lib/perfloop.ts), replayed as one
// overnight queue on a spare Mac. The ledger fills one entry at a time while the window is on screen; the slider, the
// entries themselves and ←/→ move through it. The server renders the whole night, so without script nothing is
// hidden; under reduced motion it never plays on its own.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { NIGHT, SENSE_LABEL, type Verdict } from "@/lib/perfloop";
import { botSvg } from "@/lib/vendor/bot-avatar.js";

const LAST = NIGHT.length - 1;
const TICK = 2600;

// The agent's face for each verdict: pleased with a clean result, wincing at a rejection, sparking at a find.
const FACE: Record<Verdict, { mood?: "happy" | "oops"; pose?: string }> = {
  same: { mood: "happy" }, rejected: { mood: "oops" }, lost: {}, "needs review": { pose: "spark" },
  finding: { mood: "happy", pose: "spark" }, queued: { pose: "wave" },
};

function Agent({ verdict }: { verdict: Verdict }) {
  const svg = useMemo(() => botSvg({ seed: "perfloop/agent", role: "worker", size: "full", decorative: true, ...FACE[verdict] }).replace(/ width="\d+" height="\d+"/, ""), [verdict]);
  return <span className="pl-night__bot" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Night() {
  const [at, setAt] = useState(LAST);
  const [playing, setPlaying] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const touched = useRef(false);

  // Before the first paint: start the night from its first entry, unless motion is reduced.
  useLayoutEffect(() => {
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) setAt(0);
  }, []);

  // Play while on screen, until someone takes the controls.
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(([e]) => { if (!touched.current) setPlaying(!!e?.isIntersecting); }, { threshold: 0.2 });
    if (root.current) io.observe(root.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    if (at >= LAST) { setPlaying(false); return; }
    const t = setTimeout(() => setAt((n) => Math.min(LAST, n + 1)), TICK);
    return () => clearTimeout(t);
  }, [playing, at]);

  const go = (n: number) => { touched.current = true; setPlaying(false); setAt(Math.max(0, Math.min(LAST, n))); };
  const toggle = () => {
    touched.current = true;
    if (playing) { setPlaying(false); return; }
    if (at >= LAST) setAt(0);
    setPlaying(true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); go(at + (e.key === "ArrowRight" ? 1 : -1)); }
  };

  const now = NIGHT[at]!;
  const seen = NIGHT.slice(0, at + 1);
  const tried = seen.filter((e) => e.verdict !== "queued").length;
  const review = seen.filter((e) => e.verdict === "needs review").length;
  const queued = seen.filter((e) => e.verdict === "queued").length;
  const morning = at === LAST;

  return (
    <figure className="pl-night" aria-label="A night of the loop">
      <div className="pl-night__win" ref={root} onKeyDown={onKey}>
        <p className="pl-night__bar" aria-hidden="true"><i /><i /><i /><code>perfloop queue run --runner ssh://mini --until 07:00</code></p>
        <div className="pl-night__body">
          <aside className="pl-night__desk" style={{ "--p": at / LAST } as CSSProperties}>
            <p className="pl-night__clock" aria-live="off"><span>{now.at}</span><small>{morning ? "Good morning." : "You're asleep."}</small></p>
            <Agent verdict={now.verdict} />
            <dl className="pl-night__tally">
              <div><dt>{tried}</dt><dd>experiments run</dd></div>
              <div><dt>0</dt><dd>kept: none beat today&apos;s build</dd></div>
              <div><dt>{review}</dt><dd>for you to look at</dd></div>
              <div><dt>{queued}</dt><dd>queued for tomorrow</dd></div>
            </dl>
          </aside>
          <ol className="pl-ledger">
            {NIGHT.map((e, k) => (
              <li key={e.at} className={`pl-ledger__e${k === at ? " is-now" : ""}${k > at ? " is-later" : ""}`} aria-hidden={k > at || undefined}>
                <button type="button" tabIndex={k > at ? -1 : 0} onClick={() => go(k)} aria-current={k === at || undefined}>
                  <span className="pl-ledger__at">{e.at}</span>
                  <span className={`pl-sense pl-sense--${e.sense}`}>{SENSE_LABEL[e.sense]}</span>
                  <span className="pl-ledger__what">{e.what}{e.knob ? <code>{e.knob}</code> : null}</span>
                  <span className={`pl-verdict pl-verdict--${e.verdict.replace(" ", "-")}`}>{e.verdict}</span>
                </button>
                <p className="pl-ledger__why">{e.why}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <div className="pl-night__ctl">
        <button type="button" className="pl-night__play" onClick={toggle} aria-label={playing ? "Pause" : morning ? "Play the night again" : "Play"}>
          {playing ? <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" /><rect x="9.5" y="2" width="3.5" height="12" /></svg>
            : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" /></svg>}
        </button>
        <input type="range" min={0} max={LAST} value={at} onChange={(e) => go(Number(e.target.value))} aria-label="Time in the night" aria-valuetext={`${now.at}: ${now.what}, ${now.verdict}`} />
      </div>
      <figcaption>Real entries from PerfLoop&apos;s runs on capcomd Desktop, 30–31 October 2026, replayed here as one night&apos;s queue. &ldquo;Saw&rdquo;, &ldquo;felt&rdquo; and &ldquo;checked&rdquo; say which sense decided it.</figcaption>
    </figure>
  );
}
