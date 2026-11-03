"use client";

// "Many projects, one title bar": one slider drives a clause and the title bar beside it, through four states
// from the approved boards (ReelStack, ReelSwarm): one project open, a folded one whose run is ready and asks, that
// one fanned out, and a 17-agent swarm whose subtrees fold into stacks.
import { useState } from "react";
import { Bot, Icon } from "./parts";

// What the first columns on screen say, by tab, for the crop of the reel under the title bar.
const SAYS: Record<string, [string, string]> = {
  planner: ["working", "Matchkey moves to v3.2. One lead takes ids/v1; a critic reads every diff before it lands."],
  lead: ["working", "Splitting ids/v1 across three workers. 4423 fixed the join; checking it against the nulls."],
  "lead ids/v1": ["working", "Four workers on ids/v1. 4423 fixed the join; d3ce is writing shards; 9b1f waits."],
  d3ce: ["working", "Writing the v3.2 shards to r2://staging/mk: 118 of 256."],
  "7c2e": ["merged", "Proration rounds per line now, not per invoice. Approved by the critic and merged into fix-proration."],
};
const PLANNER_P: [string, string] = ["waiting on you", "fix-proration is ready: one fix, reviewed, checks green. Open a pull request into dev?"];

type Head = { seed: string; role: string };
type Deck = { name: string; cloud: boolean; status: string; heads: Head[]; asks?: string };
type Tab = { label: string; seed: string; role: string; asks?: boolean; stack?: number; dim?: boolean };
type Cell = "w" | "a" | "q" | "d";

const H = (seed: string, role: string): Head => ({ seed, role });
const MATCHKEY_HEADS = [H("dk-98", "planner"), H("dk-47", "lead"), H("dk-8", "worker"), H("dk-88", "worker")];
const PRORATION_HEADS = [H("dk-6", "planner"), H("dk-50", "worker")];
const ADDRIVA: Deck = { name: "addriva", cloud: true, status: "Pull request open", heads: [H("dk-0", "planner"), H("dk-28", "worker"), H("dk-41", "worker")] };

const MATCHKEY_TABS: Tab[] = [
  { label: "planner", seed: "dk-98", role: "planner" }, { label: "lead", seed: "dk-47", role: "lead" }, { label: "d3ce", seed: "dk-8", role: "worker" },
  { label: "4423", seed: "dk-88", role: "worker" }, { label: "9b1f", seed: "dk-41", role: "worker", dim: true }, { label: "critic", seed: "dk-201", role: "critic" },
];

const STAGES: Array<{ name: string; clause: string; note: string; open: { name: string; cloud: boolean; sub: string; tabs: Tab[] }; decks: Deck[]; cells: Cell[][] }> = [
  {
    name: "One open", clause: "One project is open, the rest fold.",
    note: "The open project shows its crew as tabs. Every other project folds into a deck of its crew's heads with one line of status.",
    open: { name: "Migrate matchkey", cloud: true, sub: "Cloud · 18:40", tabs: MATCHKEY_TABS },
    decks: [{ name: "Fix proration", cloud: false, status: "2 working", heads: PRORATION_HEADS }, ADDRIVA],
    cells: [["w", "w"], ["w", "w", "d", "q"], ["d"]],
  },
  {
    name: "One asks", clause: "A folded project is ready for you.",
    note: "Its planner asks whether to open the pull request. The deck gets an amber ring and says who asks, and an asking project never drops into the overflow.",
    open: { name: "Migrate matchkey", cloud: true, sub: "Cloud · 18:44", tabs: MATCHKEY_TABS },
    decks: [{ name: "Fix proration", cloud: false, status: "planner asks", heads: PRORATION_HEADS, asks: "planner" }, ADDRIVA],
    cells: [["w", "w"], ["w", "w", "d", "q"], ["d"]],
  },
  {
    name: "Fans out", clause: "Click it, and its crew fans out.",
    note: "The deck opens in place into crew tabs, and the project you were in folds into a deck of its own.",
    open: { name: "Fix proration", cloud: false, sub: "Local · 0:52", tabs: [{ label: "planner", seed: "dk-6", role: "planner", asks: true }, { label: "7c2e", seed: "dk-50", role: "worker" }] },
    decks: [{ name: "Migrate matchkey", cloud: true, status: "5 working", heads: MATCHKEY_HEADS }, ADDRIVA],
    cells: [["a", "d"]],
  },
  {
    name: "Swarm", clause: "A swarm folds the same way.",
    note: "17 agents: each lead and its workers are one stack, and only the subtree on screen fans out. However wide the tree, the bar stays one line.",
    open: { name: "Migrate matchkey", cloud: true, sub: "Cloud · 18:40 · 17 agents", tabs: [
      { label: "planner", seed: "dk-98", role: "planner" }, { label: "lead ids/v1", seed: "dk-47", role: "lead" }, { label: "d3ce", seed: "dk-8", role: "worker" },
      { label: "4423", seed: "dk-88", role: "worker" }, { label: "9b1f", seed: "dk-41", role: "worker", dim: true },
      { label: "addriva", seed: "dk-28", role: "lead", stack: 5 }, { label: "matchkey", seed: "dk-201", role: "lead", stack: 5 },
    ] },
    decks: [{ name: "Fix proration", cloud: false, status: "2 working", heads: PRORATION_HEADS }],
    cells: [["w"], ["w", "w", "d", "q", "w"], ["w", "w", "w", "w", "w"], ["w", "q", "w", "w", "d"], ["q"]],
  },
];

export function Decks() {
  const [i, setI] = useState(0);
  const s = STAGES[i];
  const counts = s.cells.flat().reduce((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {} as Record<Cell, number>);

  return (
    <section className="dk-decks" id="decks" aria-labelledby="decks-h">
      <div className="dk-decks__words">
        <h2 id="decks-h" className="dk-h2" data-reveal>Many projects, one title bar.</h2>
        <div className="dk-decks__clause" aria-live="polite" key={i}>
          <p className="dk-lead">{s.clause}</p>
          <p>{s.note}</p>
        </div>
      </div>

      <div className="dk-decks__pic">
        <div className="dk-tb" data-ui role="img" aria-label={`The title bar: ${s.open.name} open, ${s.decks.map((d) => d.name + (d.asks ? ", asking" : "")).join(", ")} folded.`} key={i}>
          <div className="dk-bar dk-bar--solo">
            <span className="dk-lights"><i /><i /><i /></span>
            <div className="dk-open">
              <span className="dk-open__name"><Icon name={s.open.cloud ? "cloud" : "laptop"} size={17} /><span><b>{s.open.name}</b><small>{s.open.sub}</small></span></span>
              <div className="dk-tabs">
                {s.open.tabs.map((t, k) => (
                  <span key={t.label} className={`dk-tab${k < 3 ? " is-on" : ""}${k === 0 ? " is-first" : ""}${k === 2 ? " is-last" : ""}${t.asks ? " is-asks" : ""}${t.dim ? " is-dim" : ""}${t.stack ? " is-stack" : ""}`}>
                    {t.stack ? <span className="dk-heads">{Array.from({ length: 3 }, (_, n) => <Bot key={n} seed={`${t.seed}-${n}`} role={n ? "worker" : t.role} />)}</span> : <Bot seed={t.seed} role={t.role} />}
                    <span>{t.label}{t.stack ? <small> {t.stack}</small> : null}{t.asks && !t.stack ? <em> asks</em> : null}</span>
                  </span>
                ))}
              </div>
            </div>
            {s.decks.map((d) => (
              <span key={d.name} className={`dk-deck${d.asks ? " is-asks" : ""}`}>
                <Icon name={d.cloud ? "cloud" : "laptop"} size={16} />
                <span><b>{d.name}</b><small>{d.status}</small></span>
                <span className="dk-heads">{d.heads.map((h) => <Bot key={h.seed} seed={h.seed} role={h.role} />)}</span>
              </span>
            ))}
          </div>
          <div className="dk-mini">
            {s.open.tabs.slice(0, 2).map((t) => {
              const [st, msg] = t.label === "planner" && s.open.name === "Fix proration" ? PLANNER_P : SAYS[t.label] ?? ["working", ""];
              return (
                <div key={t.label} className={`dk-col${t.asks ? " is-asks" : ""}`}>
                  <div className="dk-col__head"><Bot seed={t.seed} role={t.role} size="small" className="dk-col__bot" /><b>{t.role}</b>{t.role === "worker" && <span className="dk-id">{t.label}</span>}{t.label.startsWith("lead ") && <span className="dk-id">{t.label.slice(5)}</span>}<span className={`dk-st${t.asks ? " dk-st--asks" : ""}`}>· {st}</span></div>
                  <div className="dk-thread"><p className="dk-msg">{msg}</p></div>
                </div>
              );
            })}
          </div>
          <div className="dk-strip">
            {s.cells.map((g, gi) => <span key={gi} className="dk-strip__g">{g.map((c, ci) => <i key={ci} className={`c-${c}`} />)}</span>)}
            <span className="dk-strip__sum">{[counts.w && `${counts.w} working`, counts.a && <em key="a">{counts.a} ask{counts.a > 1 ? "" : "s"}</em>, counts.q && `${counts.q} queued`, counts.d && `${counts.d} done`].filter(Boolean).flatMap((x, k) => (k ? [" · ", x] : [x]))}</span>
          </div>
        </div>
      </div>

      <div className="dk-slide">
        <label className="sr" htmlFor="dk-stage">Title bar state</label>
        <div className="dk-slide__track" style={{ ["--p" as string]: `${(i / 3) * 100}%` }}>
          <span className="dk-slide__fill" aria-hidden="true" />
          <input id="dk-stage" type="range" min={0} max={3} step={1} value={i} onChange={(e) => setI(Number(e.target.value))} aria-valuetext={STAGES[i].name} />
        </div>
        <ol className="dk-slide__names" aria-hidden="true">{STAGES.map((st, k) => <li key={st.name}><button type="button" tabIndex={-1} className={k === i ? "is-on" : undefined} onClick={() => setI(k)}>{st.name}</button></li>)}</ol>
      </div>

      <figure className="dk-decks__real" data-reveal>
        <img src="/desktop/real-tb.jpg" width={2880} height={94} alt="The real title bar: Migrate matchkey to v3.2, running locally, its 17 agents as tabs, worker 316f marked as asking, and Follow at the right." loading="lazy" decoding="async" />
        <figcaption>The title bar in the current build, with a 17-agent crew and one ask.</figcaption>
      </figure>
    </section>
  );
}
