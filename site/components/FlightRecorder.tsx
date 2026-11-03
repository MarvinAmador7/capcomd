"use client";

// "Every run has a flight recorder": the real `capcomd tui`, drawn by its own Ink components (apps/tui, the shots
// script's ANSI-to-HTML) from a recorded run: the tinycalc build of 3 Nov 2026, 18 agents, cut at the end of its work
// (28m 19s; later read-only spans from inspecting it were dropped). lib/flight-recorder.json holds the five views and
// twenty Replay frames. Pick a view with its tab, the list beside it, or 1–6 while the window has focus; Replay scrubs
// with the slider or ←/→, as the TUI's own playhead does.
import { useState, type CSSProperties, type KeyboardEvent } from "react";
import rec from "@/lib/flight-recorder.json";
import { delay } from "./marks";

type View = "live" | "waterfall" | "timeline" | "rollups" | "events" | "replay";
const VIEWS: Array<{ id: View; tab: string; q: string; a: string }> = [
  { id: "live", tab: "1 Live", q: "Who's running, and what has it spent?", a: "The agent tree with each one's cost, turns and checks → review → merge, beside the latest events." },
  { id: "waterfall", tab: "2 Waterfall", q: "Where did the time go?", a: "Every span, nested, from the run down to a single git push. Repeats fold into one row." },
  { id: "timeline", tab: "3 Timeline", q: "What ran in parallel?", a: "One lane per agent: its own work, git and sandbox time, and any wait for your approval." },
  { id: "rollups", tab: "4 Rollups", q: "What did it cost?", a: "Wall time, cost, turns and errors, per agent and per kind of work." },
  { id: "events", tab: "5 Events", q: "What happened, in order?", a: "The whole event log, filtered by family and searchable." },
  { id: "replay", tab: "6 Replay", q: "What was happening at minute 8?", a: "Scrub a finished run: spans grow to the playhead and events appear as they happened." },
];

// Where each tab label sits in the header row, in characters, so the drawn tabs can be clicked too.
const header = (rec.views.live.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").split("\n")[1] ?? "");
const TABS = VIEWS.map((v) => ({ ...v, col: header.indexOf(v.tab) }));
const LAST = rec.replay.length - 1;

export function FlightRecorder() {
  const [view, setView] = useState<View>("live");
  const [frame, setFrame] = useState(Math.round(LAST * 0.29)); // about minute 8
  const html = view === "replay" ? rec.replay[frame]! : rec.views[view];

  const onKey = (e: KeyboardEvent) => {
    const n = Number(e.key);
    if (n >= 1 && n <= 6) { e.preventDefault(); setView(VIEWS[n - 1]!.id); return; }
    if (view === "replay" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      setFrame((f) => Math.min(LAST, Math.max(0, f + (e.key === "ArrowRight" ? 1 : -1))));
    }
  };

  return (
    <section className="sec fr" id="tui" aria-labelledby="fr-title">
      <h2 className="big" id="fr-title" data-reveal><span>Every run has</span> <span>a flight recorder.</span></h2>
      <p className="fr__lead" data-reveal style={delay(60)}><code>capcomd tui</code> shows a swarm while it works: who&apos;s running, what each agent has spent, where the time goes. Every span and event is recorded, so you can replay any run step by step.</p>

      <div className="fr__body" data-reveal style={delay(120)}>
        <figure className="fr__fig">
          <div className="fr__win" tabIndex={0} onKeyDown={onKey} role="group" aria-label={`capcomd tui, ${VIEWS.find((v) => v.id === view)!.tab.slice(2)} view of a recorded run. Press 1 to 6 to switch views.`}>
            <p className="fr__bar" aria-hidden="true"><i /><i /><i /><span>capcomd tui run-kb23b6ca66fb560bf</span></p>
            <div className="fr__screen">
              <div className="fr__term" style={{ "--cols": rec.cols } as CSSProperties}>
                <pre aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />
                {TABS.map((t) => t.col >= 0 ? (
                  <button key={t.id} type="button" tabIndex={-1} aria-hidden="true" className="fr__hit" style={{ "--c": t.col, "--w": t.tab.length } as CSSProperties} onClick={() => setView(t.id)} />
                ) : null)}
              </div>
            </div>
          </div>
          {view === "replay" ? (
            <label className="fr__scrub">
              <span>Playhead</span>
              <input type="range" min={0} max={LAST} value={frame} onChange={(e) => setFrame(Number(e.target.value))} aria-valuetext={`${Math.round((frame / LAST) * 28.3)} minutes into the run`} />
            </label>
          ) : null}
          <figcaption>The real <code>capcomd tui</code>, drawn from a recorded run: 18 agents building tinycalc, an expression language with a CLI and REPL, over 28 minutes. Cost is an API-price estimate; on a subscription the run was billed $0.</figcaption>
        </figure>

        <div className="fr__views" role="tablist" aria-label="Views">
          {VIEWS.map((v, k) => (
            <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className="fr__view" onClick={() => setView(v.id)}>
              <span className="fr__key" aria-hidden="true">{k + 1}</span>
              <span><b>{v.q}</b><small>{v.tab.slice(2)} · {v.a}</small></span>
            </button>
          ))}
        </div>
      </div>

      <dl className="fr__cmds" data-reveal style={delay(80)}>
        <div><dt><code>capcomd tui [runId]</code></dt><dd>The debugger, live while the run executes. With no run id, the latest run.</dd></div>
        <div><dt><code>capcomd trace &lt;runId&gt;</code></dt><dd>The span waterfall, in plain output.</dd></div>
        <div><dt><code>capcomd events &lt;runId&gt; --follow</code></dt><dd>The event log as it happens; with <code>--json</code>, one line per event.</dd></div>
        <div><dt><code>capcomd inspect &lt;runId&gt; --json</code></dt><dd>The whole bundle: status, tree, trace and events, for your own tools.</dd></div>
      </dl>
    </section>
  );
}
