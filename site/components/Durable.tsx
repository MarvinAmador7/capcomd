"use client";

// "Built on Rivet": why a run survives a crash, told with one of the chaos suite's real cases. The engine is killed at
// the kill point merge.after_cas.before_event (the merge has landed, its event isn't written yet), restarts, runs the
// merge step again, finds the landing by its Capcomd-Task trailer, and records the merge once
// (tests/chaos/cases.ts, src/merge/repo.ts, docs/durability.md). The replay plays once when it comes into view;
// without the page script or with reduced motion every line is simply there.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { delay } from "./marks";

type Line = { k: "ev" | "do" | "kill" | "boot" | "ok"; t: ReactNode; note?: ReactNode };
const LINES: Line[] = [
  { k: "ev", t: <><code>task.claimed</code></>, note: "worker a1f2 takes the lease, epoch 1" },
  { k: "ev", t: <><code>verify.passed</code></>, note: "checks ran on the branch merged with the latest target" },
  { k: "ev", t: <><code>merge.started</code></> },
  { k: "do", t: <>squash commit lands on <code>main</code></>, note: <>compare-and-swap on the target, trailer <code>Capcomd-Task: …/t1</code></> },
  { k: "kill", t: <>killed at <code>merge.after_cas.before_event</code></>, note: "exit 137: the merge landed, its event was never written" },
  { k: "boot", t: <>engine restarts</>, note: "the actors wake from their SQLite state; the driver runs the merge step again" },
  { k: "do", t: <>finds the landing by its trailer</>, note: "nothing lands twice" },
  { k: "ok", t: <><code>merge.succeeded</code></>, note: "recorded once; one landing on main" },
];
const STEP_MS = 900;

function Replay() {
  const [shown, setShown] = useState(LINES.length);   // the static picture until the script runs
  const [playing, setPlaying] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const io = useRef<IntersectionObserver | null>(null);
  const play = () => {
    io.current?.disconnect();
    clearInterval(timer.current);
    setShown(0); setPlaying(true);
    let n = 0;
    timer.current = window.setInterval(() => {
      n += 1; setShown(n);
      if (n >= LINES.length) { clearInterval(timer.current); setPlaying(false); }
    }, STEP_MS);
  };
  useEffect(() => {
    const el = box.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    io.current = new IntersectionObserver(([e]) => { if (e?.isIntersecting) play(); }, { threshold: 0.5 });
    io.current.observe(el);
    return () => { io.current?.disconnect(); clearInterval(timer.current); };
  }, []);
  const killed = shown >= 5 && shown < 6;
  return (
    <div className={`crash${killed ? " is-killed" : ""}`} ref={box}>
      <div className="win win--big crash__win" data-ui role="group" aria-label="A chaos case, replayed">
        <span className="win__bar" aria-hidden="true"><i /><i /><i /><span>capcomd engine · chaos case, direct merge</span></span>
        <ol className="crash__log">
          {LINES.map((l, i) => (
            <li key={i} className={`crash__line crash__line--${l.k}${i < shown ? " is-in" : ""}`}>
              <span className="crash__t">{l.t}</span>
              {l.note ? <span className="crash__note">{l.note}</span> : null}
            </li>
          ))}
        </ol>
        <div className="crash__foot">
          <span className="crash__count">landings on main: <b>{shown >= 4 ? 1 : 0}</b></span>
          <button type="button" className="crash__replay" onClick={play} disabled={playing}>{playing ? "Replaying…" : "Replay"}</button>
        </div>
      </div>
    </div>
  );
}

export function Durable() {
  return (
    <div className="durable">
      <div className="durable__text">
        <a className="durable__by" href="https://rivet.dev" target="_blank" rel="noopener noreferrer" aria-label="Built on Rivet (rivet.dev)" data-reveal>
          <span>Built on</span><img src="/logos/rivet.svg" alt="" width={84} height={28} />
        </a>
        <h3 className="durable__title" data-reveal style={delay(60)}><span>Kill it mid-merge.</span> <span>It lands once.</span></h3>
        <p data-reveal style={delay(120)}>Every step of a run is recorded before it counts, so a crashed engine resumes from the last recorded step and a retried step never acts twice. The record lives in Rivet actors, each with its own SQLite database.</p>
        <dl className="durable__cases" data-reveal style={delay(200)}>
          <div><dt>The engine crashes</dt><dd>It resumes from the last recorded step.</dd></div>
          <div><dt>A worker VM dies</dt><dd>Its task goes back on the board for a new agent; anything the dead one sends later is ignored.</dd></div>
          <div><dt>The engine is down</dt><dd>Worker VMs keep working and pushing their branches; nothing merges until it&apos;s back.</dd></div>
        </dl>
      </div>
      <div className="durable__demo" data-reveal style={delay(140)}>
        <Replay />
        <p className="durable__suite">A chaos suite runs cases like this one at named kill points, and at random. After each it checks: no double merge, in the event log or in git; no lost task; every sandbox reaped; no double charge; no gap in any event log.</p>
      </div>
    </div>
  );
}
