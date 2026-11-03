"use client";

// "Kill it mid-merge": the engine killed with SIGKILL at a named kill point, run again, and the work counted once. Each kill
// point here is one the tests use today, with the outcome they check:
//   tests/merge/direct.test.ts  merge.lock.acquired, merge.after_fetch.before_integrate, merge.before_cas,
//                               merge.after_cas.before_event: the rerun lands the task exactly once (src/merge/direct.ts
//                               finds an earlier landing by its Capcomd-Task trailer, findExistingMerge);
//   tests/merge/pr.test.ts      merge.pr.before_merge, merge.after_pr_merge.before_event: one PR, one merge call;
//   tests/subagents/workflow.test.ts  workflow.start_agent.mid: the worker wakes by itself and finishes the agent.
// The track draws the run left to right: what happened before the kill, the cut, then what the rerun did. The lane
// under it is main (or the agent); the floor is the run's record, ticked where a step is recorded. Without the page script, or
// with reduced motion, the whole run is simply there.
import { useEffect, useRef, useState } from "react";
import { delay } from "./marks";

type Step = { t: string; code?: boolean; rec?: boolean; land?: boolean; found?: boolean };
type Point = { name: string; group: "Direct merge" | "Pull request" | "Workflow"; before: Step[]; after: Step[]; outcome: string; unit: string; lane: string };

const CLAIM: Step = { t: "task.claimed", code: true, rec: true };
const VERIFY: Step = { t: "verify.passed", code: true, rec: true };
const LOCK: Step = { t: "merge lock" };
const FETCH: Step = { t: "fetch main" };
const SQUASH: Step = { t: "squash commit" };
const CAS: Step = { t: "compare-and-swap", land: true };
const DONE: Step = { t: "merge.succeeded", code: true, rec: true };
const FOUND: Step = { t: "found by its trailer", found: true };
const OPEN: Step = { t: "open the pull request" };
const PRMERGE: Step = { t: "merge the pull request", land: true };
const FOUND_PR: Step = { t: "found it merged", found: true };

const POINTS: Point[] = [
  { name: "merge.lock.acquired", group: "Direct merge", before: [CLAIM, VERIFY, LOCK], after: [LOCK, FETCH, SQUASH, CAS, DONE], unit: "landing on main", lane: "main",
    outcome: "Killed holding the merge lock, before anything moved. The rerun takes the lock again and lands the task once." },
  { name: "merge.after_fetch.before_integrate", group: "Direct merge", before: [CLAIM, VERIFY, LOCK, FETCH], after: [LOCK, FETCH, SQUASH, CAS, DONE], unit: "landing on main", lane: "main",
    outcome: "Killed after fetching main. The rerun fetches again, builds the commit and lands it once." },
  { name: "merge.before_cas", group: "Direct merge", before: [CLAIM, VERIFY, LOCK, FETCH, SQUASH], after: [LOCK, FETCH, SQUASH, CAS, DONE], unit: "landing on main", lane: "main",
    outcome: "Killed with the commit built but not pushed. main never moved; the rerun lands it once." },
  { name: "merge.after_cas.before_event", group: "Direct merge", before: [CLAIM, VERIFY, LOCK, FETCH, SQUASH, CAS], after: [FOUND, DONE], unit: "landing on main", lane: "main",
    outcome: "Killed after the commit landed, before the record said so. The rerun finds the landing by its Capcomd-Task trailer and records it: still one commit on main." },
  { name: "merge.pr.before_merge", group: "Pull request", before: [CLAIM, VERIFY, OPEN], after: [OPEN, PRMERGE, DONE], unit: "pull request, merged once", lane: "main",
    outcome: "Killed with the pull request open, before merging it. The rerun reuses that pull request and merges it: one pull request, one merge call." },
  { name: "merge.after_pr_merge.before_event", group: "Pull request", before: [CLAIM, VERIFY, OPEN, PRMERGE], after: [FOUND_PR, DONE], unit: "pull request, merged once", lane: "main",
    outcome: "Killed after GitHub merged it, before the record said so. The rerun sees it merged and records its commit: one pull request, one merge call." },
  { name: "workflow.start_agent.mid", group: "Workflow", before: [{ t: "spawn", code: true, rec: true }, { t: "claimed by its workflow", rec: true }, { t: "start-agent step" }],
    after: [{ t: "wakes by itself", found: true }, { t: "start-agent step" }, { t: "agent done", land: true, rec: true }], unit: "agent, finished by itself", lane: "agent",
    outcome: "Killed inside a workflow step, with nothing left to call the worker. After the restart it wakes on its own and finishes the agent, with its commit." },
];
const GROUPS = ["Direct merge", "Pull request", "Workflow"] as const;
const STEP_MS = 520;

export function Durable() {
  const [pick, setPick] = useState(3);           // the case the page told before: killed after the commit landed
  const [shown, setShown] = useState(Infinity);   // the whole run until the script plays it
  const timer = useRef(0);
  const io = useRef<IntersectionObserver | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const p = POINTS[pick];
  const nodes = [...p.before.map((s) => ({ ...s, side: "before" as const })), { t: "", side: "cut" as const }, ...p.after.map((s) => ({ ...s, side: "after" as const }))];

  const play = (i: number) => {
    io.current?.disconnect();
    clearInterval(timer.current);
    setPick(i);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(Infinity); return; }
    setShown(0);
    let n = 0; const total = POINTS[i].before.length + POINTS[i].after.length + 1;
    timer.current = window.setInterval(() => {
      n += 1; setShown(n);
      if (n >= total) clearInterval(timer.current);
    }, STEP_MS);
  };
  useEffect(() => {
    const el = box.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    io.current = new IntersectionObserver(([e]) => { if (e?.isIntersecting) play(3); }, { threshold: 0.4 });
    io.current.observe(el);
    return () => { io.current?.disconnect(); clearInterval(timer.current); };
  }, []);

  const cutAt = p.before.length;
  const landed = nodes.some((s, k) => k < shown && "land" in s && s.land);
  const killed = shown > cutAt;
  const playing = shown < nodes.length;

  return (
    <section className="durable" id="durable" aria-labelledby="durable-title">
      <div className="durable__head">
        <div className="durable__words">
          <h2 id="durable-title" className="durable__title" data-reveal style={delay(60)}><span>Kill it mid-merge.</span> <span>It lands once.</span></h2>
          <p data-reveal style={delay(120)}>Every step of a run is recorded before it counts. Kill the engine anywhere and run it again: it resumes from the last recorded step, and a step it repeats never acts twice.</p>
        </div>
        <p className="durable__one" aria-live="polite" data-reveal style={delay(160)}>
          <span className="durable__n">{landed ? 1 : 0}</span>
          <span className="durable__unit">{p.unit}, after a SIGKILL at <code>{p.name}</code></span>
        </p>
      </div>

      <div className="cut" data-reveal style={delay(200)}>
      <div className={`cut__frame${killed ? " is-killed" : ""}${playing ? " is-playing" : ""}`} ref={box}>
        <div className="win win--big cut__win" data-ui role="img" aria-label={`The run, killed at ${p.name} and run again. ${p.outcome}`}>
          <span className="win__bar" aria-hidden="true"><i /><i /><i /><span>capcomd engine · killed at {p.name}</span></span>
          <div className="cut__track" style={{ ["--n" as string]: nodes.length }} key={pick}>
            {nodes.map((s, k) => s.side === "cut" ? (
              <div key={k} className={`cut__slash${k < shown ? " is-in" : ""}`} aria-hidden="true">
                <b>SIGKILL</b><small>exit 137</small><small>engine restarts</small>
              </div>
            ) : (
              <div key={k} className={`cut__node cut__node--${s.side}${k < shown ? " is-in" : ""}${s.found ? " is-found" : ""}`}>
                <span className="cut__ev">{s.code ? <code>{s.t}</code> : s.t}</span>
                <span className="cut__dot" />
                <span className={`cut__main${s.land ? " is-land" : ""}`}>{s.land ? <i /> : null}</span>
                <span className={`cut__rec${s.rec ? " is-rec" : ""}`} />
              </div>
            ))}
            <span className="cut__lane" aria-hidden="true">{p.lane}</span>
            <span className="cut__floor" aria-hidden="true">the run&apos;s record</span>
          </div>
          <p className="cut__out" aria-live="polite">{shown >= nodes.length ? p.outcome : " "}</p>
        </div>
      </div>
      </div>

      <div className="durable__points" data-reveal style={delay(240)}>
        <p className="durable__ask">Pick where to kill it.</p>
        <div className="durable__keys">
          {GROUPS.map((g) => (
            <div key={g} className="durable__group" role="group" aria-label={g}>
              <span>{g}</span>
              {POINTS.map((pt, i) => pt.group === g ? (
                <button key={pt.name} type="button" aria-pressed={pick === i} onClick={() => play(i)}>{pt.name}</button>
              ) : null)}
            </div>
          ))}
        </div>
        <p className="durable__note">The merge and workflow tests kill the engine with SIGKILL at each of these seven points, run it again and check the outcome above. A worker VM that dies hands its task back to the board under a new lease, and anything the dead one sends later is ignored. While the engine is down, worker VMs keep working and pushing their branches; nothing merges until it&apos;s back.</p>
      </div>
    </section>
  );
}
