"use client";

// "Swarms, made human", played as one shot in the desktop window, title bar and all. Lumen, the planner, waits in
// the first column; when the window comes into view its composer types a goal and sends it. Lumen reads the
// repository, writes a three-step plan and spawns the swarm, a lead per step with four workers each and a critic, one
// column every few frames, while the camera follows the newest column to the last one. The camera is a spring: the
// faster it moves the more the columns blur. The title bar folds every subtree that is off screen into a stack, as
// the app does. With reduced motion the run lands at its last frame at once.
import { useEffect, useRef, useState } from "react";
import { botName } from "@/lib/vendor/bot-avatar.js";
import { Bot, Icon } from "./parts";

const GOAL = "Backfill addriva_id for 2024";
const PLAN = ["Find every 2024 row missing addriva_id", "Backfill in batches of 5,000, resumable", "Check the counts before the merge"];

type Member = { seed: string; role: "planner" | "lead" | "worker" | "critic"; label: string; step: number; part: number };
const LEADS = ["dk-47", "dk-28", "dk-20"];
const WORKERS = [["dk-8", "d3ce"], ["dk-88", "4423"], ["dk-41", "9b1f"], ["dk-50", "7c2e"], ["dk-10", "a91c"], ["dk-12", "316f"],
  ["dk-13", "e07b"], ["dk-23", "52d8"], ["dk-21", "b6a4"], ["dk-25", "0f39"], ["dk-32", "c2e1"], ["dk-34", "8d5a"]];
// The swarm in tree order: Lumen, then each lead followed by its four workers, then the critic.
const SWARM: Member[] = [
  { seed: "dk-0", role: "planner", label: "planner", step: -1, part: 0 },
  ...LEADS.flatMap((seed, s): Member[] => [
    { seed, role: "lead", label: `lead ${s + 1}`, step: s, part: 0 },
    ...WORKERS.slice(s * 4, s * 4 + 4).map(([w, label], p): Member => ({ seed: w, role: "worker", label, step: s, part: p + 1 })),
  ]),
  { seed: "dk-201", role: "critic", label: "critic", step: -1, part: 0 },
];
const N = SWARM.length;
const GROUPS = LEADS.map((_, s) => SWARM.flatMap((m, i) => (m.step === s ? [i] : [])));
const WORK: Array<Array<[string, string, boolean?]>> = [
  [["doc", "Reading the code it touches"], ["term", "Writing a failing test", true]],
  [["check", "Read 38 files"], ["term", "Running the suite", true]],
  [["check", "Wrote the test"], ["term", "Making the change", true]],
  [["doc", "Reading the last run's logs"], ["eye", "Checking the edge cases", true]],
];

// The shot, in ms after Send: Lumen reads, writes the plan, then spawns a column every SPAWN ms.
const READ = 650, WRITE = 1150, SWARM_AT = 1500, SPAWN = 170;
const GAP = 14, PAD = 14;

type Phase = "idle" | "typing" | "run" | "done" | "rewind";
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export function StartLumen() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [typed, setTyped] = useState(0);
  const [sent, setSent] = useState(false);
  const [step, setStep] = useState(-1); // Lumen: 0 reading, 1 writing the plan, 2 the plan, 3 spawning
  const [spawned, setSpawned] = useState(0);
  const [secs, setSecs] = useState(1);
  const [cloud, setCloud] = useState(true);
  const [pin, setPin] = useState<number | null>(null);
  const [geo, setGeo] = useState({ col: 400, vw: 1200 });
  const win = useRef<HTMLDivElement>(null);
  const reel = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const cam = useRef({ x: 0, v: 0, to: 0, raf: 0, last: 0, still: false });

  const running = phase === "run" || phase === "done";
  const live = running || phase === "rewind";
  const count = live ? 1 + spawned : 1;

  // Where the camera wants to be: on a pinned column, else far enough right to show the newest one.
  const unit = geo.col + GAP;
  const end = Math.max(0, PAD + count * unit - GAP + PAD - geo.vw);
  const to = phase === "rewind" ? 0 : pin !== null ? Math.min(end, pin * unit) : end;
  const shown = Math.max(1, Math.floor((geo.vw - PAD + GAP / 2) / unit));
  const first = Math.min(Math.round(to / unit), Math.max(0, count - shown));
  const inView = (i: number) => i >= first && i < first + shown && i < count;

  useEffect(() => {
    const el = reel.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const c = (track.current?.firstElementChild as HTMLElement | null)?.offsetWidth || 400;
      setGeo({ col: c, vw: el.clientWidth });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The camera: a spring toward `to`, written straight to the track. Its speed sets the blur.
  useEffect(() => {
    const c = cam.current; c.to = to;
    const t = track.current; if (!t) return;
    const paint = () => {
      const blur = Math.min(3.5, Math.abs(c.v) / 900);
      t.style.transform = `translate3d(${-c.x}px, 0, 0)`;
      t.style.filter = blur > 0.25 ? `blur(${blur.toFixed(2)}px)` : "";
    };
    if (c.still) { c.x = to; c.v = 0; paint(); return; }
    const tick = (now: number) => {
      const dt = Math.min(0.032, (now - c.last) / 1000); c.last = now;
      const k = 120, d = 2 * Math.sqrt(k) * 0.92;
      c.v += (k * (c.to - c.x) - d * c.v) * dt; c.x += c.v * dt;
      const done = Math.abs(c.to - c.x) < 0.5 && Math.abs(c.v) < 4;
      if (done) { c.x = c.to; c.v = 0; }
      paint();
      c.raf = done ? 0 : requestAnimationFrame(tick);
    };
    if (!c.raf) { c.last = performance.now(); c.raf = requestAnimationFrame(tick); }
  }, [to]);
  useEffect(() => () => { const c = cam.current; cancelAnimationFrame(c.raf); c.raf = 0; timers.current.forEach(clearTimeout); timers.current = []; }, []);

  useEffect(() => {
    if (phase !== "run") return;
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const later = (ms: number, f: () => void) => { timers.current.push(window.setTimeout(f, ms)); };

  const play = () => {
    timers.current.forEach(clearTimeout); timers.current = [];
    setPin(null);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cam.current.still = true;
      setTyped(GOAL.length); setSent(true); setStep(3); setSpawned(N - 1); setSecs(4); setPhase("done");
      return;
    }
    const begin = () => {
      setPhase("typing"); setTyped(0); setSent(false); setStep(-1); setSpawned(0); setSecs(1);
      let at = 380;
      for (let i = 1; i <= GOAL.length; i++) { at += 34 + ((i * 7) % 5) * 9; later(at, () => setTyped(i)); }
      at += 420; later(at, () => setSent(true));
      at += 180; later(at, () => { setPhase("run"); setStep(0); });
      later(at + READ, () => setStep(1));
      later(at + WRITE, () => setStep(2));
      later(at + SWARM_AT, () => setStep(3));
      for (let k = 1; k < N; k++) later(at + SWARM_AT + k * SPAWN, () => setSpawned(k));
      later(at + SWARM_AT + N * SPAWN + 600, () => setPhase("done"));
    };
    if (phase === "idle") begin();
    else { setPhase("rewind"); later(650, begin); }
  };

  // The shot starts once, when most of the window is on screen.
  useEffect(() => {
    const el = win.current; if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); play(); } }, { threshold: 0.45 });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typing = phase === "typing" || (phase === "idle" && typed === 0);
  const shownGoal = phase === "typing" ? GOAL.slice(0, typed) : phase === "idle" ? "" : GOAL;
  const where = cloud ? "in the cloud" : "on this Mac";

  return (
    <section className="dk-start" id="start" aria-labelledby="start-h">
      <div className="dk-start__head">
        <h2 id="start-h" className="dk-h2" data-reveal>Swarms, made human.</h2>
        <p className="dk-start__lead" data-reveal>One goal becomes a tree of agents: a planner, a lead per step, workers under each lead, a critic on every diff. The engine runs the tree in parallel. The window keeps it readable: one column per agent, every subtree off screen folded into the title bar.</p>
      </div>

      <div className="dk-start__act" data-reveal>
        <p className="dk-start__note" aria-live="polite">
          {phase === "done" ? `17 agents in 3 subtrees, ${where}. The subtrees off screen fold into the title bar.`
            : running ? `Planning against main ${where}, then assigning the steps.`
            : "Waiting for a goal."}
        </p>
        <button type="button" className="dk-start__go" onClick={play} disabled={phase === "typing" || phase === "run" || phase === "rewind"}>Replay</button>
      </div>

      <div className="dk-shot" ref={win} data-ui data-reveal role="group" aria-label="The capcomd Desktop window: a new project, its planner and the crew it spawns">
        <div className="dk-bar">
          <span className="dk-lights" aria-hidden="true"><i /><i /><i /></span>
          <div className="dk-open">
            <span className="dk-open__name"><Icon name={cloud ? "cloud" : "laptop"} size={17} /><span><b>{running ? GOAL : "New project"}</b><small>{cloud ? "Cloud" : "Local"}{running ? ` · ${clock(secs)} · ${count} agent${count > 1 ? "s" : ""}` : " · not started"}</small></span></span>
            <Tabs count={live ? count : 0} inView={inView} onPick={phase === "done" ? setPin : undefined} />
          </div>
          <span className="dk-bar__end" aria-hidden="true"><Icon name="cmd" size={17} /><Icon name="plus" size={17} /></span>
        </div>

        <div className="dk-shot__reel" ref={reel}>
          <div className="dk-shot__track" ref={track}>
            <section className="dk-col dk-col--lumen" aria-label="planner Lumen">
              {live ? (
                <div className="dk-col__head"><Bot seed="dk-0" role="planner" size="small" className="dk-col__bot" /><b>planner</b><span className="dk-dim">Lumen</span><span className="dk-st">· {phase === "done" ? "waiting on the crew" : "working"}</span><span className="dk-col__clock">{clock(secs)}</span></div>
              ) : null}
              <div className="dk-new__body">
                {live ? (
                  <div className="dk-thread">
                    <div className="dk-hand dk-hand--you"><p><b>You</b></p><p>{GOAL}</p></div>
                    {step < 1 ? <Tool icon="doc" live t={clock(secs)}>Reading the repository</Tool> : <Tool icon="check" ok t="0:01">Read 214 files on main</Tool>}
                    {step >= 1 ? (step < 2 ? <Tool icon="doc" live t={clock(secs)}>Writing the plan</Tool> : <Tool icon="check" ok t="0:01">Wrote the plan</Tool>) : null}
                    {step >= 2 ? <ol className="dk-plan">{PLAN.map((p) => <li key={p}>{p}</li>)}</ol> : null}
                    {step >= 3 ? (spawned < N - 1 ? <Tool icon="spawn" live t={clock(secs)}>Spawning the crew · {spawned} of {N - 1}</Tool> : <Tool icon="spawn" t="0:03">Spawned {N - 1} agents</Tool>) : null}
                  </div>
                ) : (
                  <div className="dk-lumen">
                    <Bot seed="dk-0" role="planner" size="full" mood={phase === "typing" ? "happy" : "sleepy"} className="dk-lumen__bot" />
                    <p>Hi, I&apos;m <b>Lumen</b>. What are we building?</p>
                  </div>
                )}
              </div>
              <div className={`dk-card${sent ? " is-sent" : ""}`}>
                <p className="dk-card__chips"><span className="dk-chip"><Icon name="folder" size={13} />my-app</span><span className="dk-dim"><Icon name="branch" size={13} /> main</span></p>
                <p className="dk-card__goal">{sent ? <span className="dk-dim">Reply to Lumen…</span> : <>{shownGoal}{typing ? <i className="dk-caret" /> : null}</>}</p>
                <div className="dk-card__tools">
                  <span className="dk-round" aria-hidden="true"><Icon name="plus" size={14} /></span>
                  <span className="dk-local" role="radiogroup" aria-label="Where it runs">
                    <button type="button" role="radio" aria-checked={!cloud} onClick={() => setCloud(false)}><Icon name="laptop" size={14} />Local</button>
                    <button type="button" role="radio" aria-checked={cloud} onClick={() => setCloud(true)}><Icon name="cloud" size={14} />Cloud</button>
                  </span>
                  <span className="dk-dim dk-model">Opus 5.5</span>
                  <span className="dk-mic" aria-hidden="true"><Icon name="mic" size={15} /></span>
                  <span className={`dk-go${phase === "typing" && typed === GOAL.length ? " is-press" : ""}`} aria-hidden="true"><Icon name="up" size={15} /></span>
                </div>
              </div>
            </section>

            {SWARM.slice(1).map((m, j) => {
              const i = j + 1, on = live && i <= spawned;
              return on ? (
                <section key={m.seed} className="dk-col is-in" aria-label={`${m.role} ${m.label}`}>
                  <div className="dk-col__head"><Bot seed={m.seed} role={m.role} size="small" className="dk-col__bot" /><b>{m.role}</b>{m.role !== "critic" ? <span className="dk-id">{m.role === "lead" ? `step ${m.step + 1}` : m.label}</span> : null}<span className="dk-dim">{botName(m.seed)}</span><span className="dk-st">· {m.role === "critic" ? "waiting" : "working"}</span><span className="dk-col__clock">0:0{Math.min(9, Math.max(0, secs - 3))}</span></div>
                  <div className="dk-thread">{say(m)}</div>
                  <p className="dk-box">Tell {m.role === "worker" ? `worker ${m.label}` : m.role}…</p>
                </section>
              ) : <div key={m.seed} className="dk-col is-ghost" aria-hidden="true" />;
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

/** The title bar's crew: every subtree on screen fans out into tabs, the rest fold into a stack. A bracket marks the
 * columns on screen; after the shot a tab moves the camera to its column. */
function Tabs({ count, inView, onPick }: { count: number; inView: (i: number) => boolean; onPick?: (i: number) => void }) {
  type T = { key: string; i: number; label: string; seed: string; role: string; stack?: number[] };
  const tabs: T[] = [];
  const one = (i: number): T => ({ key: SWARM[i].seed, i, label: SWARM[i].label, seed: SWARM[i].seed, role: SWARM[i].role });
  if (count > 0) tabs.push(one(0));
  for (const g of GROUPS) {
    const here = g.filter((i) => i < count);
    if (!here.length) continue;
    if (here.some(inView)) here.forEach((i) => tabs.push(one(i)));
    else tabs.push({ ...one(here[0]), key: `stack-${here[0]}`, stack: here });
  }
  if (count === N) tabs.push(one(N - 1));
  const on = tabs.map((t) => !t.stack && inView(t.i));
  const lo = on.indexOf(true), hi = on.lastIndexOf(true);

  return (
    <div className="dk-tabs" role="group" aria-label="Crew, in tree order">
      {tabs.map((t, k) => (
        <button key={t.key} type="button" tabIndex={onPick ? 0 : -1} aria-pressed={k === lo}
          className={`dk-tab${on[k] ? " is-on" : ""}${k === lo ? " is-first" : ""}${k === hi ? " is-last" : ""}${t.stack ? " is-stack" : ""}`}
          onClick={() => onPick?.(t.i)}>
          {t.stack ? <span className="dk-heads">{t.stack.slice(0, 3).map((i) => <Bot key={i} seed={SWARM[i].seed} role={SWARM[i].role} />)}</span> : <Bot seed={t.seed} role={t.role} />}
          <span>{t.label}{t.stack ? <small> {t.stack.length}</small> : null}</span>
        </button>
      ))}
    </div>
  );
}

/** What a spawned column says: a lead takes its step of the plan and splits it, a worker gets its part, the critic waits. */
function say(m: Member) {
  const lead = botName(LEADS[Math.max(0, m.step)]);
  if (m.role === "lead") return <>
    <div className="dk-hand"><p><b>Lumen</b> <span className="dk-dim">step {m.step + 1} of 3</span></p><p>{PLAN[m.step]}</p></div>
    <Tool icon="spawn" t="0:01">Split it into four parts</Tool>
    <Tool icon="eye" live t="0:02">Watching four workers</Tool>
  </>;
  if (m.role === "worker") return <>
    <div className="dk-hand"><p><b>{lead}</b> <span className="dk-dim">part {m.part} of 4</span></p><p>{PLAN[m.step]}</p></div>
    {WORK[(m.part - 1 + m.step) % 4].map(([icon, text, live]) => <Tool key={text} icon={icon} live={live} ok={icon === "check"} t={live ? "0:01" : "0:00"}>{text}</Tool>)}
  </>;
  return <>
    <Tool icon="check" ok t="0:01">Read Lumen&apos;s plan</Tool>
    <Tool icon="eye" t="0:00">Waiting for the first diff</Tool>
  </>;
}

function Tool({ icon, live, ok, t, children }: { icon: string; live?: boolean; ok?: boolean; t: string; children: React.ReactNode }) {
  return <p className={`dk-tool${ok ? " dk-tool--ok" : ""}`}><Icon name={icon} /><span>{children}</span><span className={live ? "dk-t dk-t--live" : "dk-t"}>{t}</span></p>;
}
