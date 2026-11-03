"use client";

// "Pull the plug": a run of three workers on one goal, and a fuse box of four real failures the visitor can cause at
// any moment, as often as they like. Each ending is what a test checks today:
//   Pull the plug   tests/subagents/restart.test.ts, workflow.test.ts (restart mid-agent, mid-step, mid-watch): the
//                   agents finish, the attempt the restart broke runs again, and it isn't counted as a failure;
//                   tests/merge/*.test.ts (the seven kill points): a change already on main is never merged twice.
//   Crash a worker  tests/scenarios/coordination.test.ts ("lease takeover from a crashed worker, fenced epochs"): the
//                   lease expires, the task is claimed again at the next epoch and finished; the old epoch is fenced.
//   Cloud outage    tests/agents/outage.test.ts: shorter than the window (CAPCOMD_SANDBOX_OUTAGE_MS, 10 min by default)
//                   capcomd waits, the agent keeps working and its work is pushed; longer, it fails and says why.
//   Out of quota    workflow.test.ts ("quota wake"): paused at the limit, it sleeps to the reset and runs the next
//                   epoch, with nobody awaiting.
// Without the page script, or with reduced motion, the run is shown finished and starts only when asked.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { rng } from "@/lib/vendor/bot-avatar.js";
import { AgentSuffix, Bot, GoalTitle } from "./crew";
import { delay } from "./marks";

type Fuse = "plug" | "crash" | "cloud" | "quota";
type WState = "work" | "crashed" | "expired" | "wait" | "asleep" | "done";
type Worker = { bot: number; prog: number; speed: number; state: WState; epoch: number; late: boolean };
type Model = { phase: "idle" | "run" | "done"; ws: Worker[]; fuse: Fuse | null; beat: string; power: "on" | "yank" | "dark" | "waking"; flipped: number; spare: number };

const SPEEDS = [1 / 10500, 1 / 13000, 1 / 15500]; // progress per ms: the three workers finish at about 10, 13 and 15 s
const SPARES = [7, 8];                             // the crew's spare workers, who take over a crashed worker's task
const CONFETTI = ["#FF7A10", "#9457DC", "#5EE6FF", "#F7A3DA"]; // the app's run-finished moment (Theme.Moments)

const FUSES: Array<{ id: Fuse; name: string; sub: string }> = [
  { id: "plug", name: "Pull the plug", sub: "capcomd goes down" },
  { id: "crash", name: "Crash a worker", sub: "its machine dies" },
  { id: "cloud", name: "Cloud outage", sub: "under 10 minutes" },
  { id: "quota", name: "Out of quota", sub: "the plan's limit" },
];

const TESTS: Array<[string, string[]]> = [
  ["Pull the plug", ["tests/subagents/restart.test.ts", "tests/subagents/workflow.test.ts (restart mid-agent, mid-step, mid-watch)", "tests/merge/direct.test.ts, pr.test.ts: SIGKILL at merge.lock.acquired, merge.after_fetch.before_integrate, merge.before_cas, merge.after_cas.before_event, merge.pr.before_merge, merge.after_pr_merge.before_event"]],
  ["Crash a worker", ["tests/scenarios/coordination.test.ts: lease takeover from a crashed worker, fenced epochs"]],
  ["Cloud outage", ["tests/agents/outage.test.ts: shorter than the window the agent finishes and its work is pushed; longer, it fails with sandbox_unreachable, naming the provider"]],
  ["Out of quota", ["tests/subagents/workflow.test.ts: quota wake"]],
];

const fresh = (): Model => ({ phase: "idle", ws: SPEEDS.map((speed, i) => ({ bot: i + 1, prog: 0, speed, state: "work", epoch: 1, late: false })), fuse: null, beat: "", power: "on", flipped: 0, spare: 0 });
const finished = (): Model => ({ ...fresh(), phase: "done", ws: fresh().ws.map((w) => ({ ...w, prog: 1, state: "done" })) });

export function Durable() {
  const m = useRef<Model>(finished());
  const [, render] = useState(0);
  const raf = useRef(0);
  const last = useRef(0);
  const timers = useRef<number[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const draw = () => render((n) => n + 1);
  const later = (ms: number, f: () => void) => { timers.current.push(window.setTimeout(() => { f(); draw(); }, ms)); };
  const clear = () => { cancelAnimationFrame(raf.current); timers.current.forEach(clearTimeout); timers.current = []; };

  const tick = (now: number) => {
    const dt = Math.min(64, now - (last.current || now));
    last.current = now;
    const s = m.current;
    if (s.phase === "run" && s.power === "on") {
      for (const w of s.ws) {
        if (w.state !== "work" && w.state !== "wait") continue;
        w.prog = Math.min(1, w.prog + dt * w.speed);
        if (w.prog >= 1) w.state = "done";
      }
      if (s.ws.every((w) => w.state === "done")) { s.phase = "done"; s.beat = "done"; }
    }
    draw();
    if (s.phase !== "done") raf.current = requestAnimationFrame(tick);
  };

  const start = () => {
    clear();
    m.current = { ...fresh(), phase: "run", beat: "go" };
    last.current = 0;
    raf.current = requestAnimationFrame(tick);
  };

  const flip = (f: Fuse) => {
    const s = m.current;
    if (s.phase !== "run" || s.fuse) return;
    s.fuse = f; s.flipped += 1;
    const live = s.ws.filter((w) => w.state !== "done");
    const end = (ms: number, beat: string) => later(ms, () => { s.fuse = null; s.beat = beat; });
    if (f === "plug") {
      s.power = "yank"; s.beat = "plug-cut";
      later(450, () => { s.power = "dark"; });
      later(1750, () => { s.power = "waking"; s.beat = "plug-back"; });
      later(3300, () => { s.power = "on"; for (const w of live) w.prog = Math.max(0, w.prog - 0.06); });
      end(3300, "plug-on");
    } else if (f === "crash") {
      const w = live.reduce((a, b) => (b.prog < a.prog ? b : a));
      w.state = "crashed"; s.beat = "crash";
      later(1500, () => { w.state = "expired"; s.beat = "crash-lease"; });
      later(2700, () => { w.bot = SPARES[s.spare++ % SPARES.length]!; w.epoch += 1; w.prog = 0; w.state = "work"; w.late = true; });
      later(5200, () => { w.late = false; });
      end(2700, "crash-new");
    } else if (f === "cloud") {
      for (const w of live) w.state = "wait";
      s.beat = "cloud";
      later(3400, () => { for (const w of s.ws) if (w.state === "wait") w.state = "work"; });
      end(3400, "cloud-back");
    } else {
      for (const w of live) w.state = "asleep";
      s.beat = "quota";
      later(3600, () => { for (const w of s.ws) if (w.state === "asleep") { w.state = "work"; w.epoch += 1; } });
      end(3600, "quota-back");
    }
    draw();
  };

  useEffect(() => {
    const el = box.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) { io.disconnect(); start(); } }, { threshold: 0.4 });
    io.observe(el);
    return () => { io.disconnect(); clear(); };
  }, []);

  const s = m.current;
  const landed = s.ws.filter((w) => w.state === "done").length;
  const out = s.power === "yank" || s.power === "dark";
  const sleepy = s.power === "dark" || s.power === "waking";
  const say: Record<string, string> = {
    "": "Three workers on one goal. Flip any switch, as often as you like.",
    go: "Three workers on one goal. Flip any switch, as often as you like.",
    "plug-cut": "Power cut. capcomd is down.",
    "plug-back": "Back up. Everyone reads their notes.",
    "plug-on": "Everyone carried on. A step that was cut in half ran again, and nothing already on main is merged twice.",
    crash: "A worker's machine crashed mid-task.",
    "crash-lease": "Its lease ran out, so the task goes back on the board.",
    "crash-new": "A fresh worker picked the task up. A late reply from the crashed one is turned away.",
    cloud: "The cloud stopped answering. The agents keep working in their machines; capcomd waits for them.",
    "cloud-back": "The cloud is back. Nothing was lost while capcomd waited.",
    quota: "Out of quota. The crew sleeps until the limit resets.",
    "quota-back": "The quota reset. They woke up and carried on, with nobody watching.",
    done: s.flipped ? `Done: three changes on main after ${s.flipped} ${s.flipped === 1 ? "failure" : "failures"}. Nothing lost, nothing twice.` : "Done: three changes on main. Run it again and flip a few switches.",
  };
  const confetti = useMemo(() => {
    const r = rng("pull-the-plug", "confetti");
    return Array.from({ length: 26 }, () => ({ x: (r() % 10000) / 100, y: (r() % 10000) / 140, s: r() % 2 === 0 ? 6 : 9, c: CONFETTI[r() % CONFETTI.length]! }));
  }, []);
  const status = (w: Worker) => (w.state === "work" ? (SPARES.includes(w.bot) ? "took over the task" : "working")
    : w.state === "crashed" ? "crashed" : w.state === "expired" ? "lease ran out" : w.state === "wait" ? "machine not answering"
    : w.state === "asleep" ? "asleep till the reset" : "on main");

  return (
    <section className="durable" id="durable" aria-labelledby="durable-title">
      <div className="durable__head">
        <div className="durable__words">
          <h2 id="durable-title" className="durable__title" data-reveal><span>Pull the plug.</span> <span>Nothing is lost.</span></h2>
          <p data-reveal style={delay(80)}>capcomd writes every step of a run down before it counts. Take the power, a worker, the cloud or the quota away at the worst moment, and the run picks up from its notes: no task lost, nothing done twice.</p>
        </div>
        <p className="durable__one" data-reveal style={delay(140)}>
          <span className="durable__n">0</span>
          <span className="durable__unit">tasks lost, {s.flipped ? <>after <b>{s.flipped}</b> {s.flipped === 1 ? "failure" : "failures"} so far.</> : "whichever switch you flip."}</span>
        </p>
      </div>

      <div className="plug" data-reveal style={delay(200)}>
        <div className={`plug__room is-${s.power}${s.fuse ? ` fuse-${s.fuse}` : ""}`} ref={box}>
          <div className="plug__bot">
            <Power out={out} />
            <div className="plug__body">
              {s.phase === "done" && s.flipped ? <span className="plug__confetti" aria-hidden="true">{confetti.map((c, k) => <i key={k} style={{ left: `${c.x}%`, top: `${c.y}%`, width: c.s, height: c.s, background: c.c, ["--k" as string]: k } as CSSProperties} />)}</span> : null}
              <Bot i={0} className="plug__me" mood={sleepy ? "sleepy" : s.power === "yank" ? "oops" : s.phase === "done" ? "happy" : undefined} pose={s.phase === "done" && s.flipped ? "cheer" : undefined} />
              <p className="plug__role">planner</p>
            </div>
          </div>

          <div className="plug__desks">
            <p className="plug__goal"><GoalTitle /></p>
            <ol className="plug__crew">
              {s.ws.map((w, k) => (
                <li key={k} className={`desk is-${w.state}`}>
                  {w.state === "wait" ? <span className="desk__cloud" aria-hidden="true" /> : null}
                  {w.state === "asleep" ? <span className="desk__z" aria-hidden="true">z<i>z</i></span> : null}
                  <Bot i={w.bot} className="desk__bot" mood={sleepy || w.state === "asleep" ? "sleepy" : w.state === "crashed" || w.state === "expired" ? "oops" : w.state === "done" ? "happy" : undefined} />
                  <p className="desk__name">worker <AgentSuffix i={w.bot} /></p>
                  <span className="desk__bar" aria-hidden="true"><i style={{ width: `${w.prog * 100}%` }} /></span>
                  <p className="desk__st">{status(w)}</p>
                  {w.late ? <p className="desk__late">late reply: turned away</p> : null}
                </li>
              ))}
            </ol>
          </div>

          <div className="plug__to">
            <p className="plug__label">main</p>
            <ol className="plug__log">
              {s.ws.map((w, k) => (
                <li key={k} className={`plug__row${w.state === "done" ? " is-on" : ""}`}>
                  {w.state === "done" ? <><Bot i={w.bot} size="xs" className="plug__by" /><span className="plug__title">worker <AgentSuffix i={w.bot} />&apos;s change</span></> : null}
                </li>
              ))}
            </ol>
            <p className="plug__count">{landed} of 3 on main</p>
          </div>

          <span className="plug__dark" aria-hidden="true" />
        </div>

        <div className="fuses">
          <div className="fuses__box" role="group" aria-label="The fuse box">
            {FUSES.map((f) => {
              const on = s.fuse === f.id;
              return (
                <button key={f.id} type="button" className={`fuse${on ? " is-on" : ""}`} aria-pressed={on} disabled={s.phase !== "run" || (!!s.fuse && !on)} onClick={() => flip(f.id)}>
                  <span className="fuse__lever" aria-hidden="true"><i /></span>
                  <span className="fuse__t"><b>{f.name}</b><small>{f.sub}</small></span>
                </button>
              );
            })}
          </div>
          <div className="fuses__side">
            <p className="plug__say" aria-live="polite">{say[s.beat] ?? say[""]}</p>
            {s.phase === "done" ? <button type="button" className="fuses__again" onClick={start}>{s.flipped ? "Run it again" : "Start the run"}</button> : null}
          </div>
        </div>
      </div>

      <div className="durable__foot" data-reveal style={delay(240)}>
        <p className="durable__long">A longer cloud outage is the one thing it won&apos;t wait out: past ten minutes the agent stops and tells you which provider didn&apos;t answer, and for how long.</p>
        <details className="durable__eng">
          <summary>For engineers: the tests behind each switch</summary>
          {TESTS.map(([g, ts]) => <div key={g} className="durable__kp"><b>{g}</b>{ts.map((t) => <code key={t}>{t}</code>)}</div>)}
        </details>
      </div>
    </section>
  );
}

/** The socket at the top of the room and the cable down to the planner, in the bots' pixels. `out` pulls the plug. */
function Power({ out }: { out: boolean }) {
  return (
    <div className={`power${out ? " is-out" : ""}`} aria-hidden="true">
      <svg className="power__socket" viewBox="0 0 16 9" shapeRendering="crispEdges">
        <path fill="#9EA3B7" d="M1 0h14v7h-1v1H2v-1H1z" /><path fill="#DADDE8" d="M2 0h12v6H2z" />
        <path fill="#2B0E57" d="M5 3h1v3H5zM10 3h1v3h-1z" /><path fill="#62677C" d="M2 6h12v1H2z" />
      </svg>
      <svg className="power__spark" viewBox="0 0 12 6" shapeRendering="crispEdges">
        <path fill="#FFD60A" d="M1 1h1v1H1zM3 3h1v1H3zM8 2h1v1H8zM10 0h1v1h-1zM6 4h1v1H6z" /><path fill="#FFFFFF" d="M2 2h1v1H2zM9 1h1v1H9zM5 5h1v1H5z" />
      </svg>
      <div className="power__cord">
        <svg className="power__plug" viewBox="0 0 12 11" shapeRendering="crispEdges">
          <path fill="#BDB7BC" d="M3 0h1v3H3zM8 0h1v3H8z" />
          <path fill="#FF7410" d="M1 3h10v5H1z" /><path fill="#FFB566" d="M2 3h8v1H2z" /><path fill="#C8530E" d="M1 7h10v1H1zM3 8h6v1H3z" />
          <path fill="#0E0818" d="M5 9h2v2H5z" />
        </svg>
        <i className="power__wire" />
      </div>
    </div>
  );
}
