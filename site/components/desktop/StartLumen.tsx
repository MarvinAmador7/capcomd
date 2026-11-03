"use client";

// "Swarms, made human", played as one shot in the desktop window, title bar and all. Lumen, the planner, is docked at
// the left and stays there; the crew's columns slide in under it. When the window comes into view Lumen's composer
// types a goal and sends it. Lumen reads the repository, writes a three-step plan and spawns a lead per step; each
// lead spawns four workers and a critic. The camera follows the newest column to the last one, a spring whose speed
// sets the blur. Then the work lands: workers finish, critics approve their diffs, leads merge their steps into the
// goal branch, and Lumen's thread logs all of it until the one decision that is yours: open the pull request. The
// title bar folds every subtree off screen into a stack, as the app does. With reduced motion the shot lands on its
// last frame at once.
import { useEffect, useRef, useState } from "react";
import { botName } from "@/lib/vendor/bot-avatar.js";
import { Bot, Decision, Icon } from "./parts";

const GOAL = "Backfill addriva_id for 2024";
const BRANCH = "backfill-addriva-2024";
const PLAN = ["Find every 2024 row missing addriva_id", "Backfill in batches of 5,000, resumable", "Check the counts before the merge"];

type Role = "planner" | "lead" | "worker" | "critic";
type Member = { seed: string; role: Role; label: string; step: number; part: number };
const LEADS = ["dk-47", "dk-28", "dk-20"];
const CRITICS = ["dk-201", "dk-202", "dk-207"];
const WORKERS = [["dk-8", "d3ce"], ["dk-88", "4423"], ["dk-41", "9b1f"], ["dk-50", "7c2e"], ["dk-10", "a91c"], ["dk-12", "316f"],
  ["dk-13", "e07b"], ["dk-23", "52d8"], ["dk-21", "b6a4"], ["dk-25", "0f39"], ["dk-32", "c2e1"], ["dk-34", "8d5a"]];
// The swarm in tree order: Lumen, then per step its lead, four workers and the critic who reviews them.
const SWARM: Member[] = [
  { seed: "dk-0", role: "planner", label: "planner", step: -1, part: 0 },
  ...LEADS.flatMap((seed, s): Member[] => [
    { seed, role: "lead", label: `lead ${s + 1}`, step: s, part: 0 },
    ...WORKERS.slice(s * 4, s * 4 + 4).map(([w, label], p): Member => ({ seed: w, role: "worker", label, step: s, part: p + 1 })),
    { seed: CRITICS[s], role: "critic", label: `critic ${s + 1}`, step: s, part: 0 },
  ]),
];
const N = SWARM.length;
const SIZE = 6; // a lead, four workers, a critic
const at = (s: number, p: number) => 1 + s * SIZE + p; // p: 0 lead, 1–4 workers, 5 critic
const GROUPS = LEADS.map((_, s) => Array.from({ length: SIZE }, (_, p) => at(s, p)));
const name = (i: number) => botName(SWARM[i].seed);
const diff = (i: number) => [18 + ((i * 37) % 60), 2 + ((i * 13) % 11)];
const WORK: Array<Array<[string, string]>> = [
  [["doc", "Read the code it touches"], ["term", "Writing a failing test"]],
  [["check", "Read 38 files"], ["term", "Running the suite"]],
  [["check", "Wrote the test"], ["term", "Making the change"]],
  [["doc", "Read the last run's logs"], ["eye", "Checking the edge cases"]],
];

// The work, in ms after the last spawn: workers finish across the subtrees, each critic approves a diff a beat later,
// and a lead merges its step once all four of its workers are approved. Then Lumen asks.
type Ev = { t: number; kind: "done" | "ok" | "merge"; i: number };
const EVENTS: Ev[] = (() => {
  const evs: Ev[] = [];
  const last = [0, 0, 0];
  for (let p = 1; p <= 4; p++) for (let s = 0; s < 3; s++) {
    const k = (p - 1) * 3 + s, i = at(s, p);
    evs.push({ t: k * 230, kind: "done", i }, { t: k * 230 + 460, kind: "ok", i });
    last[s] = Math.max(last[s], k * 230 + 460);
  }
  last.forEach((t, s) => evs.push({ t: t + 300, kind: "merge", i: at(s, 0) }));
  return evs.sort((a, b) => a.t - b.t);
})();
const ASK_AT = EVENTS[EVENTS.length - 1].t + 450;

// The shot, in ms after Send.
const READ = 650, WRITE = 1150, SWARM_AT = 1500, SPAWN = 150, WORK_AT = SWARM_AT + N * SPAWN + 400;
const GAP = 14, PAD = 14;

type Phase = "idle" | "typing" | "run" | "done" | "rewind";
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const stamp = (ms: number) => clock(Math.floor(ms / 1000));

export function StartLumen() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [typed, setTyped] = useState(0);
  const [sent, setSent] = useState(false);
  const [step, setStep] = useState(-1); // Lumen: 0 reading, 1 writing the plan, 2 the plan, 3 spawning
  const [spawned, setSpawned] = useState(0); // columns after Lumen's
  const [tick, setTick] = useState(0); // work events landed
  const [answer, setAnswer] = useState<"pr" | "keep" | null>(null);
  const [secs, setSecs] = useState(1);
  const [cloud, setCloud] = useState(true);
  const [pin, setPin] = useState<number | null>(null);
  const [geo, setGeo] = useState({ col: 400, left: 442, vw: 1200 });
  const win = useRef<HTMLDivElement>(null);
  const reel = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const cam = useRef({ x: 0, v: 0, to: 0, raf: 0, last: 0, still: false });

  const running = phase === "run" || phase === "done";
  const live = running || phase === "rewind";
  const count = live ? spawned : 0;
  const past = EVENTS.slice(0, tick);
  const done = new Set(past.filter((e) => e.kind === "done").map((e) => e.i));
  const ok = new Set(past.filter((e) => e.kind === "ok").map((e) => e.i));
  const merged = new Set(past.filter((e) => e.kind === "merge").map((e) => e.i));
  const asking = phase === "done" && answer === null;

  // Where the camera wants to be: on a pinned column, else far enough right to show the newest one.
  const unit = geo.col + GAP;
  const end = Math.max(0, geo.left + count * unit - GAP + PAD - geo.vw);
  const to = phase === "rewind" ? 0 : pin !== null ? Math.min(end, Math.max(0, pin - 1) * unit) : end;
  const shown = Math.max(1, Math.floor((geo.vw - geo.left + GAP / 2) / unit));
  const first = 1 + Math.min(Math.round(to / unit), Math.max(0, count - shown));
  const inView = (i: number) => i === 0 || (i >= first && i < first + shown && i <= count);

  useEffect(() => {
    const el = reel.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const c = track.current?.firstElementChild as HTMLElement | null;
      setGeo({ col: c?.offsetWidth || 400, left: c?.offsetLeft ?? 442, vw: el.clientWidth });
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
    const frame = (now: number) => {
      const dt = Math.min(0.032, (now - c.last) / 1000); c.last = now;
      const k = 120, d = 2 * Math.sqrt(k) * 0.92;
      c.v += (k * (c.to - c.x) - d * c.v) * dt; c.x += c.v * dt;
      const still = Math.abs(c.to - c.x) < 0.5 && Math.abs(c.v) < 4;
      if (still) { c.x = c.to; c.v = 0; }
      paint();
      c.raf = still ? 0 : requestAnimationFrame(frame);
    };
    if (!c.raf) { c.last = performance.now(); c.raf = requestAnimationFrame(frame); }
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
    setPin(null); setAnswer(null);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cam.current.still = true;
      setTyped(GOAL.length); setSent(true); setStep(3); setSpawned(N - 1); setTick(EVENTS.length); setSecs(9); setPhase("done");
      return;
    }
    const begin = () => {
      setPhase("typing"); setTyped(0); setSent(false); setStep(-1); setSpawned(0); setTick(0); setSecs(1);
      let t = 380;
      for (let i = 1; i <= GOAL.length; i++) { t += 34 + ((i * 7) % 5) * 9; later(t, () => setTyped(i)); }
      t += 420; later(t, () => setSent(true));
      t += 180; later(t, () => { setPhase("run"); setStep(0); });
      later(t + READ, () => setStep(1));
      later(t + WRITE, () => setStep(2));
      later(t + SWARM_AT, () => setStep(3));
      for (let k = 1; k < N; k++) later(t + SWARM_AT + k * SPAWN, () => setSpawned(k));
      EVENTS.forEach((e, n) => later(t + WORK_AT + e.t, () => setTick(n + 1)));
      later(t + WORK_AT + ASK_AT, () => setPhase("done"));
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

  const typing = phase === "typing" || phase === "idle";
  const shownGoal = phase === "typing" ? GOAL.slice(0, typed) : phase === "idle" ? "" : GOAL;
  const where = cloud ? "in the cloud" : "on this Mac";
  const when = (i: number) => stamp(SWARM_AT + i * SPAWN);
  const wt = (e: Ev) => stamp(WORK_AT + e.t);
  const plannerState = answer ? "done" : asking ? "waiting on you" : step >= 3 && spawned === N - 1 ? "watching the crew" : "working";

  return (
    <section className="dk-start" id="start" aria-labelledby="start-h">
      <div className="dk-start__head">
        <h2 id="start-h" className="dk-h2" data-reveal>Swarms, made human.</h2>
        <p className="dk-start__lead" data-reveal>One goal becomes a tree of agents that work in parallel, review each other and merge. You&apos;re asked once, at the end.</p>
        <p className="sr" aria-live="polite">
          {answer === "pr" ? `Pull request opened from ${BRANCH}.`
            : answer === "keep" ? `The work stays on ${BRANCH}.`
            : phase === "done" ? `${N} agents, ${ok.size} diffs approved, ${merged.size} steps merged ${where}. One decision is waiting for you.`
            : running ? `Planning against dev ${where}, then assigning the steps.`
            : "Waiting for a goal."}
        </p>
        <button type="button" className="dk-start__go" onClick={play} disabled={phase === "typing" || phase === "run" || phase === "rewind"}>Replay</button>
      </div>

      <div className="dk-shot" ref={win} data-ui data-reveal role="group" aria-label="The capcomd Desktop window: a new project, its planner docked at the left and the crew it spawns">
        <div className="dk-bar">
          <span className="dk-lights" aria-hidden="true"><i /><i /><i /></span>
          <div className="dk-open">
            <span className="dk-open__name"><Icon name={cloud ? "cloud" : "laptop"} size={17} /><span><b>{running ? GOAL : "New project"}</b><small>{cloud ? "Cloud" : "Local"}{running ? ` · ${clock(secs)} · ${count + 1} agent${count ? "s" : ""}` : " · not started"}</small></span></span>
            <Tabs show={live} count={count} inView={inView} asking={asking} onPick={phase === "done" ? setPin : undefined} />
          </div>
          <span className="dk-bar__end" aria-hidden="true"><Icon name="cmd" size={17} /><Icon name="plus" size={17} /></span>
        </div>

        <div className="dk-shot__body">
          <div className="dk-dock">
            <section className={`dk-col dk-col--lumen${asking ? " is-asks" : ""}`} aria-label="planner Lumen, docked">
              {live ? (
                <div className="dk-col__head"><Bot seed="dk-0" role="planner" size="small" className="dk-col__bot" /><b>planner</b><span className="dk-dim">Lumen</span><span className={`dk-st${asking ? " dk-st--asks" : answer ? " dk-st--merged" : ""}`}>· {plannerState}</span><span className="dk-col__clock">{clock(secs)}</span></div>
              ) : null}
              <div className="dk-new__body">
                {live ? (
                  <div className="dk-thread dk-feed">
                    <div className="dk-hand dk-hand--you"><p><b>You</b></p><p>{GOAL}</p></div>
                    {step < 1 ? <Tool icon="doc" live t={clock(secs)}>Reading the repository</Tool> : <Tool icon="check" ok t="0:01">Read 214 files on dev</Tool>}
                    {step >= 1 ? (step < 2 ? <Tool icon="doc" live t={clock(secs)}>Writing the plan</Tool> : <Tool icon="check" ok t="0:01">Wrote the plan</Tool>) : null}
                    {step >= 2 ? <ol className="dk-plan">{PLAN.map((p) => <li key={p}>{p}</li>)}</ol> : null}
                    {LEADS.flatMap((_, s) => {
                      const l = at(s, 0), c = at(s, SIZE - 1);
                      return [
                        count >= l ? <Tool key={`l${s}`} icon="spawn" t={when(l)}>Spawned lead {s + 1} · {name(l)}</Tool> : null,
                        count >= c ? <Tool key={`c${s}`} icon="spawn" t={when(c)}>{name(l)} spawned four workers and a critic</Tool> : null,
                      ];
                    })}
                    {past.map((e) => e.kind === "ok"
                      ? <Tool key={`ok${e.i}`} icon="check" ok t={wt(e)}>{name(at(SWARM[e.i].step, SIZE - 1))} approved worker {SWARM[e.i].label} <span className="dk-dim">+{diff(e.i)[0]} −{diff(e.i)[1]}</span></Tool>
                      : e.kind === "merge"
                        ? <div key={`m${e.i}`} className="dk-hand"><p><b>lead {SWARM[e.i].step + 1}</b> <span className="dk-dim">handed back</span></p><p>Step {SWARM[e.i].step + 1} is merged into {BRANCH}.</p></div>
                        : null)}
                    {answer === "pr" ? <Tool icon="check" ok t={clock(secs)}>Opened a pull request from {BRANCH}</Tool> : null}
                    {answer === "keep" ? <Tool icon="check" t={clock(secs)}>Kept the work on {BRANCH}</Tool> : null}
                  </div>
                ) : (
                  <div className="dk-lumen">
                    <Bot seed="dk-0" role="planner" size="full" mood={phase === "typing" ? "happy" : "sleepy"} className="dk-lumen__bot" />
                    <p>Hi, I&apos;m <b>Lumen</b>. What are we building?</p>
                  </div>
                )}
              </div>
              {asking ? (
                <div onKeyDown={(e) => { if (e.key === "Enter" && !(e.target as HTMLElement).closest(".dk-b--deny")) { e.preventDefault(); setAnswer("pr"); } }}>
                  <Decision title={`Open a pull request from ${BRANCH}?`} sub={`3 steps merged · 12 diffs approved · ${N} agents`} onApprove={() => setAnswer("pr")} onDeny={() => setAnswer("keep")} />
                </div>
              ) : (
                <div className={`dk-card${sent ? " is-sent" : ""}`}>
                  <p className="dk-card__chips"><span className="dk-chip"><Icon name="folder" size={13} />my-app</span><span className="dk-dim"><Icon name="branch" size={13} /> dev</span></p>
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
              )}
            </section>
          </div>

          <div className="dk-shot__reel" ref={reel}>
            <div className="dk-shot__track" ref={track}>
              {SWARM.slice(1).map((m, j) => {
                const i = j + 1;
                if (!(live && i <= spawned)) return <div key={m.seed} className="dk-col is-ghost" aria-hidden="true" />;
                const st = status(m, i, done, ok, merged);
                return (
                  <section key={m.seed} className="dk-col is-in" aria-label={`${m.role} ${m.label}`}>
                    <div className="dk-col__head"><Bot seed={m.seed} role={m.role} size="small" className="dk-col__bot" /><b>{m.role}</b><span className="dk-id">{m.role === "worker" ? m.label : `step ${m.step + 1}`}</span><span className="dk-dim">{botName(m.seed)}</span><span className={`dk-st${st === "approved" || st === "merged" || st === "done" ? " dk-st--merged" : ""}`}>· {st}</span><span className="dk-col__clock">{clock(Math.max(0, secs - 3))}</span></div>
                    <div className="dk-thread">{say(m, i, done, ok, merged)}</div>
                    <p className="dk-box">Tell {m.role === "worker" ? `worker ${m.label}` : m.label}…</p>
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The title bar's crew: Lumen, docked, then every subtree on screen fanned out into tabs and the rest folded into a
 * stack. A bracket marks the columns on screen; after the shot a tab moves the camera to its column. */
function Tabs({ show, count, inView, asking, onPick }: { show: boolean; count: number; inView: (i: number) => boolean; asking: boolean; onPick?: (i: number) => void }) {
  if (!show) return null;
  type T = { key: string; i: number; stack?: number[] };
  const tabs: T[] = [];
  for (const g of GROUPS) {
    const here = g.filter((i) => i <= count);
    if (!here.length) continue;
    if (here.some((i) => i > 0 && inView(i))) here.forEach((i) => tabs.push({ key: SWARM[i].seed, i }));
    else tabs.push({ key: `stack-${here[0]}`, i: here[0], stack: here });
  }
  const on = tabs.map((t) => !t.stack && inView(t.i));
  const lo = on.indexOf(true), hi = on.lastIndexOf(true);
  const tab = (t: T, cls: string, pressed: boolean) => (
    <button key={t.key} type="button" tabIndex={onPick ? 0 : -1} aria-pressed={pressed}
      className={`dk-tab${cls}${t.stack ? " is-stack" : ""}`} onClick={() => onPick?.(t.i)}>
      {t.stack ? <span className="dk-heads">{t.stack.slice(0, 3).map((i) => <Bot key={i} seed={SWARM[i].seed} role={SWARM[i].role} />)}</span> : <Bot seed={SWARM[t.i].seed} role={SWARM[t.i].role} />}
      <span>{SWARM[t.i].label}{t.stack ? <small> {t.stack.length}</small> : null}{t.i === 0 && asking ? <em> asks</em> : null}</span>
    </button>
  );
  return (
    <div className="dk-tabs" role="group" aria-label="Crew, in tree order">
      {tab({ key: "planner", i: 0 }, asking ? " is-asks" : " is-on is-first is-last is-dock", false)}
      {tabs.map((t, k) => tab(t, `${on[k] ? " is-on" : ""}${k === lo ? " is-first" : ""}${k === hi ? " is-last" : ""}`, k === lo))}
    </div>
  );
}

function status(m: Member, i: number, done: Set<number>, ok: Set<number>, merged: Set<number>) {
  if (m.role === "lead") return merged.has(i) ? "merged" : "working";
  if (m.role === "worker") return ok.has(i) ? "approved" : done.has(i) ? "in review" : "working";
  const mine = [1, 2, 3, 4].map((p) => at(m.step, p));
  if (mine.every((w) => ok.has(w))) return "done";
  return mine.some((w) => done.has(w) && !ok.has(w)) ? "reviewing" : "waiting";
}

/** What a spawned column says as the work lands: a worker finishes and sends its diff, its critic reviews and
 * approves it, its lead merges the step. */
function say(m: Member, i: number, done: Set<number>, ok: Set<number>, merged: Set<number>) {
  const s = m.step, critic = botName(CRITICS[s]);
  if (m.role === "lead") return <>
    <div className="dk-hand"><p><b>Lumen</b> <span className="dk-dim">step {s + 1} of 3</span></p><p>{PLAN[s]}</p></div>
    <Tool icon="spawn" t="0:01">Spawned four workers and a critic</Tool>
    {merged.has(i) ? <Tool icon="check" ok t="0:07">Merged step {s + 1} into {BRANCH}</Tool> : <Tool icon="eye" live t="0:02">Watching four workers</Tool>}
  </>;
  if (m.role === "worker") {
    const [a, d] = diff(i), [[i1, t1], [i2, t2]] = WORK[(m.part - 1 + s) % 4];
    return <>
      <div className="dk-hand"><p><b>{botName(LEADS[s])}</b> <span className="dk-dim">part {m.part} of 4</span></p><p>{PLAN[s]}</p></div>
      <Tool icon={i1} ok={i1 === "check"} t="0:00">{t1}</Tool>
      <Tool icon={done.has(i) ? "check" : i2} ok={done.has(i)} live={!done.has(i)} t="0:01">{t2}</Tool>
      {done.has(i) ? <Tool icon="spawn" t="0:05">Sent the diff to {critic} <span className="dk-dim">+{a} −{d}</span></Tool> : null}
      {ok.has(i) ? <Tool icon="check" ok t="0:06">Approved by {critic}</Tool> : null}
    </>;
  }
  const mine = [1, 2, 3, 4].map((p) => at(s, p));
  const reviewing = mine.find((w) => done.has(w) && !ok.has(w));
  return <>
    <Tool icon="check" ok t="0:01">Read Lumen&apos;s plan</Tool>
    {mine.filter((w) => ok.has(w)).map((w) => <Tool key={w} icon="check" ok t="0:06">Approved worker {SWARM[w].label} <span className="dk-dim">+{diff(w)[0]} −{diff(w)[1]}</span></Tool>)}
    {reviewing ? <Tool icon="eye" live t="0:05">Reviewing worker {SWARM[reviewing].label}</Tool> : mine.every((w) => ok.has(w)) ? null : <Tool icon="eye" t="0:00">Waiting for the {mine.some((w) => ok.has(w)) ? "next" : "first"} diff</Tool>}
  </>;
}

function Tool({ icon, live, ok, t, children }: { icon: string; live?: boolean; ok?: boolean; t: string; children: React.ReactNode }) {
  return <p className={`dk-tool${ok ? " dk-tool--ok" : ""}`}><Icon name={icon} /><span>{children}</span><span className={live ? "dk-t dk-t--live" : "dk-t"}>{t}</span></p>;
}
