"use client";

// The hero's fragment: the desktop window's title bar and reel at true size, working. A crew tab slides the reel to
// that agent's column (the bracket follows the columns on screen); the ask docked under worker 4423 approves with
// its button or with Return while it has focus. Without script it is the same window, standing still.
import { useEffect, useRef, useState } from "react";
import { ASK, CREW, RUN } from "@/lib/desktop";
import { Bot, ColumnHead, Decision, Icon, Thread } from "./parts";

const GAP = 14;

export function HeroReel() {
  const [lead, setLead] = useState(2); // the leading column: d3ce, then 4423 with its ask
  const [approved, setApproved] = useState(false);
  const [done, setDone] = useState(118);
  const [shown, setShown] = useState(2);
  const [col, setCol] = useState(420);
  const reel = useRef<HTMLDivElement>(null);

  // How many columns the cropped stage shows, for the bracket.
  useEffect(() => {
    const el = reel.current?.parentElement;
    if (!el) return;
    let first = true;
    const ro = new ResizeObserver(() => {
      const w = (reel.current?.firstElementChild as HTMLElement | null)?.offsetWidth || 420;
      setCol(w);
      const n = Math.max(1, Math.round((el.clientWidth - 20) / (w + GAP)));
      setShown(n);
      if (first && n === 1) setLead(3); // a phone shows one column: the one that asks
      first = false;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // d3ce keeps writing shards: one every few seconds, as its log says.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setDone((d) => (d < 256 ? d + 1 : d)), 3200);
    return () => clearInterval(t);
  }, []);

  const crew = CREW.map((a) => (a.id === "4423" && approved ? { ...a, state: "merged" as const } : a));
  const go = (i: number) => setLead(Math.min(i, CREW.length - 1));

  return (
    <div className="dk-win" data-ui role="group" aria-label="The capcomd Desktop window: a project's agents as columns">
      <div className="dk-bar">
        <span className="dk-lights" aria-hidden="true"><i /><i /><i /></span>
        <div className="dk-open">
          <span className="dk-open__name"><Icon name="cloud" size={17} /><span><b>{RUN.goal}</b><small>{RUN.place}</small></span></span>
          <div className="dk-tabs" role="group" aria-label="Crew, in tree order: show an agent's column">
            {crew.map((a, i) => {
              const on = i >= lead && i < lead + shown;
              const asks = a.state === "asks";
              return (
                <button key={a.id} type="button" aria-pressed={i === lead}
                  className={`dk-tab${on ? " is-on" : ""}${on && i === lead ? " is-first" : ""}${on && (i === lead + shown - 1 || i === crew.length - 1) ? " is-last" : ""}${asks ? " is-asks" : ""}${a.state === "queued" ? " is-dim" : ""}`}
                  onClick={() => go(i)}>
                  <Bot seed={a.seed} role={a.role} />
                  <span>{a.label}{asks && <em> asks</em>}</span>
                </button>
              );
            })}
          </div>
        </div>
        <span className="dk-bar__end" aria-hidden="true"><span className="dk-follow"><Icon name="eye" size={16} />Follow</span><Icon name="cmd" size={17} /><Icon name="plus" size={17} /></span>
      </div>

      <div className="dk-reel">
        <div className="dk-reel__track" ref={reel} style={{ transform: `translateX(${-lead * (col + GAP)}px)` }}>
          {crew.map((a, i) => {
            const visible = i >= lead && i < lead + shown;
            return (
              <section key={a.id} className={`dk-col${a.state === "asks" ? " is-asks" : ""}`} aria-label={`${a.role} ${a.label}`} aria-hidden={!visible || undefined}>
                <ColumnHead a={a} onClose={a.state === "asks"} />
                <Thread lines={a.id === "4423" && approved ? [...a.thread, { kind: "check", text: "Merged into main", t: "now" }] : a.thread} progress={a.id === "d3ce" ? done : undefined} />
                {a.state === "asks" ? (
                  <div onKeyDown={(e) => { if (e.key === "Enter" && !(e.target as HTMLElement).closest(".dk-b--deny")) { e.preventDefault(); setApproved(true); } }}>
                    <Decision title={ASK.title} sub={ASK.sub} onApprove={() => setApproved(true)} tabIndex={visible ? 0 : -1} />
                  </div>
                ) : (
                  <p className="dk-box">Tell {a.role === "worker" ? `worker ${a.label}` : a.role}…</p>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
