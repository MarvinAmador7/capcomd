"use client";

// "Pull the plug": the page's planner bot moves an approved change onto main while the visitor holds the plug. Pull it
// whenever you like; the two endings are the two cases the merge tests check after a SIGKILL:
//   before the change reached main (merge.lock.acquired, merge.after_fetch.before_integrate, merge.before_cas): the
//   rerun picks up and lands it once;
//   after it reached main, before the record said so (merge.after_cas.before_event): the rerun finds it on main by its
//   Capcomd-Task trailer (src/merge/direct.ts, findExistingMerge) and records it once.
// tests/merge/direct.test.ts, tests/merge/pr.test.ts and tests/subagents/workflow.test.ts hold the seven kill points
// listed for engineers at the foot. Without the page script, or with reduced motion, the scene shows the second ending.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { rng } from "@/lib/vendor/bot-avatar.js";
import { Bot, GoalTitle, README_GOALS, useGoal } from "./crew";
import { delay } from "./marks";

type Phase = "idle" | "moving" | "yank" | "dark" | "waking" | "checking" | "done";
type Cut = null | "before" | "after";

const MOVE_MS = 7000;   // from approved to written down, if nobody pulls the plug
const LANDS_AT = 0.72;  // where on the way the change reaches main
const NOTED_AT = 0.94;  // and where it's written down
const CONFETTI = ["#FF7A10", "#9457DC", "#5EE6FF", "#F7A3DA"]; // the app's run-finished moment (Theme.Moments)

const KILL_POINTS: Array<[string, string[]]> = [
  ["Direct merge", ["merge.lock.acquired", "merge.after_fetch.before_integrate", "merge.before_cas", "merge.after_cas.before_event"]],
  ["Pull request", ["merge.pr.before_merge", "merge.after_pr_merge.before_event"]],
  ["Workflow", ["workflow.start_agent.mid"]],
];

/** The socket at the top of the room and the cable down to the bot, in the bots' pixels. `out` pulls the plug. */
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

export function Durable() {
  const [phase, setPhase] = useState<Phase>("done");
  const [cut, setCut] = useState<Cut>("after");   // the static picture: cut after it landed, then found and noted
  const [p, setP] = useState(1);                    // progress of the move, 0–1
  const raf = useRef(0);
  const timers = useRef<number[]>([]);
  const started = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  const clear = () => { cancelAnimationFrame(raf.current); timers.current.forEach(clearTimeout); timers.current = []; };
  const later = (ms: number, f: () => void) => { timers.current.push(window.setTimeout(f, ms)); };

  // Runs the move from `from` to the end.
  const move = (from: number) => {
    setPhase("moving");
    started.current = performance.now() - from * MOVE_MS;
    const tick = (now: number) => {
      const v = Math.min(1, (now - started.current) / MOVE_MS);
      setP(v);
      if (v >= 1) { setPhase("done"); return; }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  const start = () => { clear(); setCut(null); setP(0); move(0); };

  const pull = () => {
    if (phase !== "moving") return;
    clear();
    const at = p;
    const c: Cut = at < LANDS_AT ? "before" : "after";
    setCut(c);
    setPhase("yank");                    // the plug comes out first, then the lights go
    later(450, () => setPhase("dark"));
    later(1750, () => setPhase("waking")); // and it goes back in as they come on
    if (c === "before") later(3750, () => move(Math.max(0, at - 0.08)));
    else {
      later(3750, () => setPhase("checking"));
      later(6050, () => { setP(1); setPhase("done"); });
    }
  };

  useEffect(() => {
    const el = box.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) { io.disconnect(); start(); } }, { threshold: 0.5 });
    io.observe(el);
    return () => { io.disconnect(); clear(); };
  }, []);

  const goal = useGoal().trim().toLowerCase();
  const older = README_GOALS.filter((g) => g.toLowerCase() !== goal).slice(0, 2).map((t, k) => [["8c1f2a0", "3e9b7d4"][k]!, t] as const);
  const landed = p >= LANDS_AT;
  const noted = phase === "done" || (phase === "moving" && p >= NOTED_AT);
  const mood = phase === "dark" || phase === "waking" ? "sleepy" : phase === "checking" || phase === "yank" ? "oops" : phase === "done" ? "happy" : undefined;
  const pose = phase === "done" && cut ? "cheer" : phase === "done" ? "wave" : undefined;
  const say =
    phase === "idle" ? "An approved change is about to move onto main."
    : phase === "moving" && !cut ? (landed ? "It's on main. Writing it down…" : "Moving the approved change onto main. Pull the plug whenever you like.")
    : phase === "moving" ? (landed ? "It's on main. Writing it down…" : "Picking up where it stopped…")
    : phase === "yank" || phase === "dark" ? "Power cut."
    : phase === "waking" ? (cut === "before" ? "Back up. Its notes say the change never reached main." : "Back up. Its notes stop before the change was written down.")
    : phase === "checking" ? "So it looks at main first. The change is already there."
    : cut === "before" ? "It picked up where it stopped. One change on main: nothing lost, nothing twice."
    : cut === "after" ? "It found the change on main and wrote it down, once. Nothing lost, nothing twice."
    : "Done, without a power cut. Run it again and pull the plug halfway.";

  const confetti = useMemo(() => {
    const r = rng("pull-the-plug", "confetti");
    return Array.from({ length: 26 }, () => ({ x: (r() % 10000) / 100, y: (r() % 10000) / 140, s: r() % 2 === 0 ? 6 : 9, c: CONFETTI[r() % CONFETTI.length]! }));
  }, []);

  return (
    <section className="durable" id="durable" aria-labelledby="durable-title">
      <div className="durable__head">
        <div className="durable__words">
          <h2 id="durable-title" className="durable__title" data-reveal><span>Pull the plug.</span> <span>Nothing lands twice.</span></h2>
          <p data-reveal style={delay(80)}>capcomd writes every step down before it counts. Cut the power in the middle of a merge, and when it comes back it reads its notes and carries on: nothing lost, nothing done twice.</p>
        </div>
        <p className="durable__one" data-reveal style={delay(140)}>
          <span className="durable__n">{landed ? 1 : 0}</span>
          <span className="durable__unit">{landed ? "change on main, however you cut it." : "changes on main so far."}</span>
        </p>
      </div>

      <div className="plug" data-reveal style={delay(200)}>
        <div className={`plug__room is-${phase}`} ref={box}>
          <div className="plug__bot">
            <Power out={phase === "yank" || phase === "dark"} />
            <div className="plug__body">
              {phase === "done" && cut ? <span className="plug__confetti" aria-hidden="true">{confetti.map((c, k) => <i key={k} style={{ left: `${c.x}%`, top: `${c.y}%`, width: c.s, height: c.s, background: c.c, ["--k" as string]: k } as CSSProperties} />)}</span> : null}
              <Bot i={0} mood={mood} pose={pose} className="plug__me" />
              {phase === "checking" ? <span className="plug__bubble">Already on main?</span> : null}
            </div>
          </div>

          <div className="plug__main">
            <div className="plug__flow" style={{ ["--p" as string]: Math.min(p / LANDS_AT, 1) } as CSSProperties}>
              <div className="plug__from">
                <p className="plug__label">Its branch</p>
                <span className="plug__slot" />
              </div>
              <span className="plug__path" aria-hidden="true" />
              <div className="plug__to">
                <p className="plug__label">main</p>
                <ol className="plug__log">
                  <li className={`plug__row plug__row--new${landed ? " is-on" : ""}${phase === "checking" ? " is-found" : ""}`}>
                    {landed ? <><Bot i={1} size="xs" className="plug__by" /><span className="plug__title"><GoalTitle /></span></> : null}
                  </li>
                  {older.map(([sha, t]) => <li key={sha} className="plug__row"><code>{sha}</code><span className="plug__title">{t}</span></li>)}
                </ol>
              </div>
              {landed ? null : (
                <span className="plug__card">
                  <Bot i={1} size="xs" className="plug__by" />
                  <span className="plug__title"><GoalTitle /></span>
                </span>
              )}
            </div>
          </div>

          <div className="plug__notes">
            <p className="plug__nh">Its notes</p>
            <ol>
              <li className="is-done">Change approved</li>
              <li className={phase === "idle" ? "" : "is-done"}>Started moving it onto main</li>
              <li className={noted ? "is-done" : "is-blank"}>{noted ? "On main" : "…"}</li>
            </ol>
          </div>

          <span className="plug__dark" aria-hidden="true" />
        </div>

        <div className="plug__bar">
          {phase === "moving" ? (
            <button type="button" className="plug__switch" onClick={pull}><span className="plug__knob" aria-hidden="true" />Pull the plug</button>
          ) : phase === "done" ? (
            <button type="button" className="plug__switch is-again" onClick={start}><span className="plug__knob" aria-hidden="true" />Run it again</button>
          ) : (
            <button type="button" className="plug__switch is-off" disabled><span className="plug__knob" aria-hidden="true" />{phase === "idle" ? "Pull the plug" : "Unplugged"}</button>
          )}
          <p className="plug__say" aria-live="polite">{say}</p>
        </div>
      </div>

      <div className="durable__foot" data-reveal style={delay(240)}>
        <dl className="durable__cases">
          <div><dt>A worker&apos;s machine dies</dt><dd>Its task goes back on the board for a new agent; anything the old one sends later is ignored.</dd></div>
          <div><dt>capcomd itself is down</dt><dd>Workers keep working and pushing their branches. Nothing merges until it&apos;s back.</dd></div>
        </dl>
        <details className="durable__eng">
          <summary>For engineers: the seven kill points</summary>
          <p>The merge and workflow tests kill the engine with SIGKILL at each of these points, run it again and check the outcome: the change lands once, the pull request is merged once, the agent finishes by itself.</p>
          {KILL_POINTS.map(([g, names]) => <p key={g} className="durable__kp"><b>{g}</b>{names.map((n) => <code key={n}>{n}</code>)}</p>)}
        </details>
      </div>
    </section>
  );
}
