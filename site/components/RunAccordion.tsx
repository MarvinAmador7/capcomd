"use client";

// The run's five stages: an accordion of disclosure buttons (WAI-ARIA APG accordion), one stage open at a time.
// Each stage's button sits in an h3 and controls a labelled region. Up/Down (and Left/Right) move between the
// buttons, Home/End jump. Without JavaScript the CSS shows every stage, stacked, with its own heading.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface Stage { id: string; name: string; face: ReactNode; text: ReactNode; picture: ReactNode }

export function RunAccordion({ stages, initial }: { stages: Stage[]; initial: string }) {
  const [open, setOpen] = useState(initial);
  const [scripted, setScripted] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    const want = new URLSearchParams(location.hash.slice(1)).get("open");
    if (want && stages.some((s) => s.id === want)) setOpen(want);
    setScripted(true);
  }, [stages]);
  const onKey = (k: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const go = ({ ArrowDown: k + 1, ArrowRight: k + 1, ArrowUp: k - 1, ArrowLeft: k - 1, Home: 0, End: stages.length - 1 } as Record<string, number>)[e.key];
    if (go === undefined) return;
    e.preventDefault();
    tabs.current[(go + stages.length) % stages.length]?.focus();
  };
  return (
    <div className="stages" data-reveal style={{ ["--d" as string]: "200ms" }} role="group" aria-label="The five stages of a run">
      {stages.map((s, k) => {
        const isOpen = s.id === open;
        return (
          <article key={s.id} className={`stage${isOpen ? " is-open" : ""}`}>
            <h3 className="stage__head">
              <button ref={(el) => { tabs.current[k] = el; }} className="stage__tab" id={`t-${s.id}`} aria-expanded={isOpen} aria-controls={`s-${s.id}`} onClick={() => setOpen(s.id)} onKeyDown={onKey(k)}>
                <span className="stage__face" aria-hidden="true">{s.face}</span>
                <span className="stage__name">{s.name}</span>
                <svg className="chev" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 2.5 9.5 7 5 11.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </h3>
            <div className="stage__body" id={`s-${s.id}`} role="region" aria-labelledby={`t-${s.id}`}>
              <div className="stage__text">
                {/* The visual title repeats the button's name; it is the heading only when the script doesn't run. */}
                <h3 className="stage__title" aria-hidden={scripted || undefined}>{s.name}</h3>
                {s.text}
              </div>
              {s.picture}
            </div>
          </article>
        );
      })}
    </div>
  );
}
