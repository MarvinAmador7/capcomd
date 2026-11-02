"use client";

// "Start with a sentence", on a plum stage like the hero's: the goal line is the new project's composer, set at display size. Lumen, the planner-to-be,
// sleeps in the empty column and smiles once you type (one change, no loop). The crew's columns wait beside it as
// outlines. On Start, Lumen becomes the column's header with your goal as its first message, reads the repository,
// writes a plan and spawns the crew one column at a time. With reduced motion the run lands at its last step at once.
import { useEffect, useRef, useState } from "react";
import { Bot, Icon } from "./parts";

const LUMEN = "dk-0";
const DEFAULT = "Backfill addriva_id for 2024";
const PLANS: Record<string, string[]> = {
  [DEFAULT]: ["Find every 2024 row missing addriva_id", "Backfill in batches of 5,000, resumable", "Check the counts before the merge"],
  "Migrate matchkey to v3.2": ["List the call sites of matchkey v3.1", "Move them to v3.2 behind the old tests", "Diff the match rates on last week's data"],
  "Fix proration rounding": ["Reproduce the cent drift in a failing test", "Round once, at the invoice line", "Check last month's invoices still match"],
  "Add rate limiting to the API": ["Pick the routes and the limits", "Add a token bucket per API key", "Load-test it before the merge"],
};
const GENERIC = ["Read what the goal touches", "Make the change behind a test", "Review the diff before it merges"];
const EXAMPLES = Object.keys(PLANS).slice(1);
const CREW = [
  { seed: "dk-47", role: "lead", name: "Nugget" },
  { seed: "dk-8", role: "worker", name: "Tinker" },
  { seed: "dk-201", role: "critic", name: "Mica" },
];
// When each step of the run lands, in ms after Start: read, plan, the three spawns, then the lead hands out task 1.
const AT = [0, 900, 1500, 2500, 3000, 3500, 4000, 5200];
const LAST = AT.length - 1;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function StartLumen() {
  const [goal, setGoal] = useState(DEFAULT);
  const [typed, setTyped] = useState(false);
  const [step, setStep] = useState(-1);
  const [secs, setSecs] = useState(1);
  const [cloud, setCloud] = useState(true);
  const field = useRef<HTMLTextAreaElement>(null);
  const started = step >= 0;
  const plan = PLANS[goal.trim()] ?? GENERIC;

  // The goal line grows to its wrapped height, so a long goal takes a second line instead of scrolling sideways.
  useEffect(() => {
    const el = field.current; if (!el) return;
    const fit = () => { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => ro.disconnect();
  }, [goal]);

  useEffect(() => {
    if (!started) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setStep(LAST); setSecs(4); return; }
    const timers = AT.slice(1).map((ms, i) => setTimeout(() => setStep((s) => Math.max(s, i + 1)), ms));
    const tick = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => { timers.forEach(clearTimeout); clearInterval(tick); };
  }, [started]);

  const type = (v: string) => { setGoal(v.replace(/\n/g, " ")); setTyped(true); setStep(-1); setSecs(1); };
  const start = () => { if (goal.trim() && !started) setStep(0); };
  const reset = () => { setStep(-1); setSecs(1); field.current?.focus(); };

  return (
    <section className="dk-start" id="start" aria-labelledby="start-h">
      <div className="dk-start__head">
        <h2 id="start-h" className="dk-h2" data-reveal>Start with a sentence.</h2>
        <p className="dk-start__lead" data-reveal>Type the goal the way you&apos;d say it. Lumen, the planner, reads the repository, writes the plan and spawns the crew, each in its own column.</p>
      </div>

      <form className="dk-start__line" data-reveal onSubmit={(e) => { e.preventDefault(); start(); }}>
        <label className="sr" htmlFor="dk-goal">The new project&apos;s goal</label>
        <textarea id="dk-goal" ref={field} className="dk-goal" rows={1} value={goal} placeholder="Describe the goal…" spellCheck={false} autoComplete="off" maxLength={80}
          onChange={(e) => type(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); start(); } }} />
        <div className="dk-start__act">
          {started ? (
            <button type="button" className="dk-start__go is-again" onClick={reset}>Try another</button>
          ) : (
            <button type="submit" className="dk-start__go" disabled={!goal.trim()}>Start <Icon name="ret" size={18} /></button>
          )}
          <p className="dk-start__try"><span>Or try</span>{EXAMPLES.map((x) => <button key={x} type="button" className="dk-ex" aria-pressed={goal === x} onClick={() => type(x)}>{x}</button>)}</p>
        </div>
      </form>

      <p className="dk-start__note" aria-live="polite">
        {!started ? "Press Start. The crew's columns fill the space beside Lumen as it spawns them."
          : step < LAST ? `Lumen is planning ${cloud ? "in the cloud" : "on this Mac"}.`
          : `Four columns from one sentence, running ${cloud ? "in the cloud" : "on this Mac"}. You hear from them when one needs a decision.`}
      </p>

      <div className="dk-board" data-ui data-reveal>
        <div className="dk-new" role="group" aria-label="The new project's column">
          {started ? (
            <div className="dk-col__head"><Bot seed={LUMEN} role="planner" size="small" className="dk-col__bot" /><b>planner</b><span className="dk-dim">Lumen</span><span className="dk-st">· {step < LAST ? "working" : "waiting on the crew"}</span><span className="dk-col__clock">{clock(secs)}</span></div>
          ) : null}
          <div className="dk-new__body">
            {started ? (
              <div className="dk-thread" aria-live="polite">
                <div className="dk-hand dk-hand--you"><p><b>You</b></p><p>{goal}</p></div>
                {step < 1 ? <Tool icon="doc" live t={clock(secs)}>Reading the repository</Tool> : <Tool icon="check" ok t="0:01">Read 214 files on main</Tool>}
                {step >= 2 ? (step < 3 ? <Tool icon="doc" live t={clock(secs)}>Writing the plan</Tool> : <Tool icon="check" ok t="0:02">Wrote the plan</Tool>) : null}
                {step >= 3 ? <ol className="dk-plan">{plan.map((p) => <li key={p}>{p}</li>)}</ol> : null}
                {step >= 4 ? <Tool icon="spawn" t={clock(Math.min(secs, 4))}>Spawned {CREW.slice(0, step - 3).map((c) => c.role).join(", ")}</Tool> : null}
              </div>
            ) : (
              <div className="dk-lumen">
                <Bot seed={LUMEN} role="planner" size="full" mood={typed ? "happy" : "sleepy"} className="dk-lumen__bot" />
                <p>Hi, I&apos;m <b>Lumen</b>. What are we building?</p>
              </div>
            )}
          </div>
          <div className={`dk-card${started ? " is-sent" : ""}`}>
            <p className="dk-card__chips"><span className="dk-chip"><Icon name="folder" size={13} />my-app</span><span className="dk-dim"><Icon name="branch" size={13} /> main</span></p>
            <p className="dk-card__goal">{started ? <span className="dk-dim">Reply to Lumen…</span> : goal || <span className="dk-dim">Describe the goal…</span>}</p>
            <div className="dk-card__tools">
              <span className="dk-round" aria-hidden="true"><Icon name="plus" size={14} /></span>
              <span className="dk-local" role="radiogroup" aria-label="Where it runs">
                <button type="button" role="radio" aria-checked={!cloud} onClick={() => setCloud(false)}><Icon name="laptop" size={14} />Local</button>
                <button type="button" role="radio" aria-checked={cloud} onClick={() => setCloud(true)}><Icon name="cloud" size={14} />Cloud</button>
              </span>
              <span className="dk-dim dk-model">Opus 5.5</span>
              <span className="dk-mic" aria-hidden="true"><Icon name="mic" size={15} /></span>
              <button type="button" className="dk-go" onClick={start} disabled={started} aria-label="Start"><Icon name="up" size={15} /></button>
            </div>
          </div>
        </div>

        <div className="dk-space" aria-label="The crew's columns">
          {CREW.map((c, i) => {
            const on = step >= 4 + i;
            return (
              <div key={c.seed} className={`dk-stub${on ? " is-on" : ""}`}>
                <div className="dk-col__head"><Bot seed={c.seed} role={c.role} size="small" className="dk-col__bot" /><b>{c.role}</b><span className="dk-dim">{on ? c.name : "not spawned"}</span>{on ? <span className="dk-st">· {i === 2 || (i === 1 && step < LAST) ? "waiting" : "working"}</span> : null}</div>
                {on ? <div className="dk-thread">{crewLines(i, step, plan)}</div> : null}
              </div>
            );
          })}
        </div>
      </div>

    </section>
  );
}

/** What each crew column shows once it is spawned: the lead reads the plan and hands task 1 to the worker. */
function crewLines(i: number, step: number, plan: string[]) {
  const handed = step >= LAST;
  if (i === 0) return handed
    ? <><Tool icon="check" ok t="0:01">Read Lumen&apos;s plan</Tool><Tool icon="spawn" t="0:01">Gave task 1 to Tinker</Tool></>
    : <Tool icon="doc" live t="0:00">Reading Lumen&apos;s plan</Tool>;
  if (i === 1) return handed
    ? <><div className="dk-hand"><p><b>Nugget</b> <span className="dk-dim">task 1</span></p><p>{plan[0]}</p></div><Tool icon="term" live t="0:00">Working on it</Tool></>
    : <Tool icon="term" t="0:00">Waiting for a task</Tool>;
  return <Tool icon="eye" t="0:00">Waiting for the first diff</Tool>;
}

function Tool({ icon, live, ok, t, children }: { icon: string; live?: boolean; ok?: boolean; t: string; children: React.ReactNode }) {
  return <p className={`dk-tool${ok ? " dk-tool--ok" : ""}`}><Icon name={icon} /><span>{children}</span><span className={live ? "dk-t dk-t--live" : "dk-t"}>{t}</span></p>;
}
