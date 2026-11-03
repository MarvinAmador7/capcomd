"use client";

// "One column per agent": a column stays pinned on the plum field while four short blocks scroll past, and each
// block's control changes it, for good: pick the agent, tell it something, let it ask, answer the ask.
import { useState } from "react";
import { ASK, CREW, RUN, type Line } from "@/lib/desktop";
import { delay } from "../marks";
import { ColumnHead, Decision, Thread } from "./parts";

const PICK = ["planner", "lead", "d3ce", "4423"] as const;

export function ColumnLab() {
  const [pick, setPick] = useState<(typeof PICK)[number]>("planner");
  const [said, setSaid] = useState<Record<string, string[]>>({});
  const [draft, setDraft] = useState("");
  const [asks, setAsks] = useState(true);
  const [answer, setAnswer] = useState<"approved" | "closed" | null>(null);

  const base = CREW.find((a) => a.id === pick)!;
  const asking = pick === "planner" && asks && answer !== "approved";
  const a = { ...base, state: pick === "planner" ? (answer === "approved" ? "done" : asks ? "asks" : "working") : base.state } as typeof base;
  const lines: Line[] = [...base.thread, ...(said[pick] ?? []).map((t) => ({ kind: "handoff", from: "You", text: t }) as Line)];
  if (pick === "planner" && answer === "approved") lines.push({ kind: "check", text: `Opened a pull request into ${RUN.base}`, t: "now" });

  const send = () => { const t = draft.trim(); if (!t) return; setSaid((s) => ({ ...s, [pick]: [...(s[pick] ?? []), t] })); setDraft(""); };
  const press = (k: "Return" | "Esc") => { setPick("planner"); setAsks(true); setAnswer(k === "Return" ? "approved" : "closed"); };

  return (
    <section className="dk-lab" id="column" aria-labelledby="column-h">
      <div className="dk-lab__field">
        <div className="dk-lab__col" data-ui>
          <section className={`dk-col dk-col--solo${asking ? " is-asks" : ""}`} aria-label={`Column of ${a.role} ${a.label}`} aria-live="polite">
            <ColumnHead a={a} onClose={asking} />
            <Thread lines={lines} />
            {asking ? (
              <Decision title={ASK.title} sub={ASK.sub} onApprove={() => setAnswer("approved")} onDeny={() => setAnswer("closed")} />
            ) : (
              <p className="dk-box">Tell {a.role === "worker" ? `worker ${a.label}` : a.role}…</p>
            )}
          </section>
        </div>
      </div>

      <div className="dk-lab__read">
        <h2 id="column-h" className="dk-h2" data-reveal>One column per agent.</h2>

        <div className="dk-block" data-reveal style={delay(80)}>
          <h3>The whole agent, at a glance.</h3>
          <p>Profile, name and state, where it runs and for how long, then its full thread: messages, tool calls, diffs, hand-offs. Columns stand in tree order, so every lead sits beside the workers it spawned.</p>
          <div className="dk-seg" role="radiogroup" aria-label="Agent shown in the column">
            {PICK.map((p, i) => (
              <button key={p} type="button" role="radio" aria-checked={pick === p} onClick={() => setPick(p)}>
                {p === "d3ce" || p === "4423" ? `worker ${p}` : p}<kbd>⌃{i + 1}</kbd>
              </button>
            ))}
          </div>
        </div>

        <div className="dk-block" data-reveal>
          <h3>Steer one agent, not the swarm.</h3>
          <p>Each column has its own message box. Redirect a lead mid-run while its workers keep going; the message lands in that agent&apos;s thread and nowhere else.</p>
          <form className="dk-say" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <label className="sr" htmlFor="dk-say">Message to {a.role} {a.label}</label>
            <input id="dk-say" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Tell ${a.role === "worker" ? `worker ${a.label}` : a.role}…`} autoComplete="off" />
            <button type="submit" className="dk-pill">Send</button>
          </form>
        </div>

        <div className="dk-block" data-reveal>
          <h3>A question docks at its foot.</h3>
          <p>When an agent needs a decision, the question takes its message box&apos;s place, with the diff one click away. Nothing pops up over the other columns, and nothing interrupts you that isn&apos;t yours to decide.</p>
          <label className="dk-toggle">
            <input type="checkbox" checked={asks && answer !== "approved"} onChange={(e) => { setPick("planner"); setAsks(e.target.checked); setAnswer(null); }} />
            <span aria-hidden="true" />The planner asks to open the pull request
          </label>
        </div>

        <div className="dk-block" data-reveal>
          <h3>Return approves. Esc never denies.</h3>
          <p>With the ask in focus, Return approves it and the planner opens the pull request. Esc only closes it: denying is always a click on Deny.</p>
          <div className="dk-keys" role="group" aria-label="Answer the planner">
            <button type="button" className="dk-cap" onClick={() => press("Return")}>Return ↩</button>
            <button type="button" className="dk-cap" onClick={() => press("Esc")}>Esc</button>
            <p className="dk-keys__out" aria-live="polite">{answer === "approved" ? `Pull request opened into ${RUN.base}.` : answer === "closed" ? "Closed. The ask is still waiting for you." : "The planner is waiting."}</p>
          </div>
          <figure className="dk-realask">
            <img src="/desktop/real-ask.jpg" width={873} height={290} alt="A docked ask in the real app: Merge acme/mobile's change into main? with Deny and Approve, the Return key shown on Approve." loading="lazy" decoding="async" />
            <figcaption>An ask docked in the current build.</figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
