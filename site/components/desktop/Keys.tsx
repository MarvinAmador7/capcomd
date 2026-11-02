"use client";

// "Every move has a key": the desktop SPEC's shortcuts (§4) and the project menu's, a tab per kind of move. Without
// script every group shows, one after another.
import { useEffect, useState } from "react";
import { KEYS } from "@/lib/desktop";

export function Keys() {
  const [tab, setTab] = useState(0);
  const [js, setJs] = useState(false);
  useEffect(() => setJs(true), []);

  const keyNav = (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (tab + d + KEYS.length) % KEYS.length;
    setTab(n);
    document.getElementById(`dk-tab-${n}`)?.focus();
  };

  return (
    <section className="dk-keyspage" id="keys" aria-labelledby="keys-h">
      <div className="dk-keys__head">
        <h2 id="keys-h" className="dk-h2" data-reveal>Every move has a key.</h2>
        <p data-reveal>The app is built to be driven from the keyboard, and keyboard moves never wait on an animation.</p>
      </div>
      <div className="dk-keys__body">
        <div className="dk-daytabs" role="tablist" aria-label="Kinds of move" aria-orientation="vertical" onKeyDown={keyNav} hidden={!js}>
          {KEYS.map((g, i) => (
            <button key={g.tab} id={`dk-tab-${i}`} type="button" role="tab" aria-selected={tab === i} aria-controls={`dk-panel-${i}`} tabIndex={tab === i ? 0 : -1} onClick={() => setTab(i)}>
              {g.tab}<small>{g.rows.length} {g.rows.length === 1 ? "key" : "keys"}</small>
            </button>
          ))}
        </div>
        <div className="dk-bands-wrap">
          {KEYS.map((g, i) => (
            <div key={g.tab} id={`dk-panel-${i}`} role={js ? "tabpanel" : undefined} aria-labelledby={js ? `dk-tab-${i}` : undefined} hidden={js && tab !== i} className="dk-bands">
              {!js && <h3 className="dk-bands__h">{g.tab}</h3>}
              {g.rows.map((r, k) => (
                <div key={r.title} className="dk-band" style={{ ["--k" as string]: k }}>
                  <span className="dk-band__keys">{r.keys.map((x) => <kbd key={x}>{x}</kbd>)}</span>
                  <span className="dk-band__t"><b>{r.title}</b><small>{r.note}</small></span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
