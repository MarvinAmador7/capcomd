"use client";

// "How they talk": the four channels between agents, drawn on a small chain of the page's crew (your agent → planner
// → lead → worker) with the run's task board and kv beside it. Pick a channel and its path plays on the drawing.
// Copy from docs/agents.md and ADR-019 as the section had it. Without the script (or before it runs) every path is
// drawn at once and every channel's text is there; with reduced motion the paths appear without travelling.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Bot } from "./crew";

type Ch = "down" | "up" | "shared" | "fenced";
const CHANNELS: Array<{ id: Ch; name: string; text: ReactNode }> = [
  { id: "down", name: "Down", text: <><code>send</code>: the orchestrator, a parent or an ancestor messages a running agent. Claude reads it at its next step; Codex can&apos;t while it runs.</> },
  { id: "up", name: "Up", text: <>A child&apos;s result goes to whoever awaits it: its branch, commit and verification, and from an agent that may spawn, a summary, artifacts and data.</> },
  { id: "shared", name: "Shared", text: <>The run&apos;s task board, with leases and epochs, and a kv blackboard written with compare-and-swap, for the orchestrator and agents that may spawn.</> },
  { id: "fenced", name: "Fenced", text: <>What another agent wrote arrives as data, never instructions. Authority comes only from the agent&apos;s capability token and its scope&apos;s limits.</> },
];

// The drawing, on a 600 × 400 canvas (positions in canvas units; HTML is placed in % so it scales with the box).
const W = 600, H = 400, B = 48;
const NODES = [
  { key: "you", x: 24, y: 24, name: "Your agent", note: "plugin, MCP or CLI" },
  { key: "planner", x: 84, y: 112, name: "Planner", note: "may spawn", crew: 0 },
  { key: "lead", x: 144, y: 200, name: "Lead", note: "may spawn", crew: 6 },
  { key: "worker", x: 204, y: 288, name: "Worker", note: "a leaf", crew: 7 },
] as const;
const cx = (i: number) => NODES[i]!.x + B / 2, cy = (i: number) => NODES[i]!.y + B / 2;
const elbow = (p: number, c: number) => `M${cx(p)} ${NODES[p]!.y + B}V${cy(c) - 8}Q${cx(p)} ${cy(c)} ${cx(p) + 8} ${cy(c)}H${NODES[c]!.x - 4}`;
const DOWN = `${elbow(0, 1)}${elbow(1, 2)}${elbow(2, 3)}`;
// Up runs the same elbows the other way: from the worker's left edge back to each parent.
// Offset 10 units below and right of the tree's lines, so up and down never share a stroke.
const back = (c: number, p: number) => `M${NODES[c]!.x - 4} ${cy(c) + 10}H${cx(p) + 18}Q${cx(p) + 10} ${cy(c) + 10} ${cx(p) + 10} ${cy(c) + 2}V${NODES[p]!.y + B + 4}`;
const UP = `${back(3, 2)}${back(2, 1)}${back(1, 0)}`;
const BOARD = { x: 416, y: 104, w: 168, h: 132 };
const SHARED = [1, 2].map((i) => `M${NODES[i]!.x + 184} ${cy(i)}H${BOARD.x - 4}`).join("");
const pct = (v: number, of: number) => `${(v / of) * 100}%`;

export function Talk() {
  const [ch, setCh] = useState<Ch | "all">("all");
  const [motion, setMotion] = useState(false);
  useEffect(() => { setCh("down"); setMotion(!matchMedia("(prefers-reduced-motion: reduce)").matches); }, []);
  const on = (c: Ch) => ch === "all" || ch === c;
  return (
    <div className="talk">
      <figure className="talk__fig2" aria-hidden="true" data-ch={ch}>
        <div className="talk__canvas">
          <svg viewBox={`0 0 ${W} ${H}`} className="talk__svg">
            {[[0, 1], [1, 2], [2, 3]].map(([p, c]) => <path key={`${p}${c}`} className="talk__tree" d={elbow(p!, c!)} />)}
            <path key={`d-${ch}`} className={`talk__path talk__path--down${on("down") || on("fenced") ? " is-on" : ""}`} d={DOWN} pathLength={1} />
            <path key={`u-${ch}`} className={`talk__path talk__path--up${on("up") || on("fenced") ? " is-on" : ""}`} d={UP} pathLength={1} />
            <path key={`s-${ch}`} className={`talk__path talk__path--shared${on("shared") ? " is-on" : ""}`} d={SHARED} pathLength={1} />
            {motion && ch === "down" ? <circle className="talk__packet" r={6}><animateMotion dur="1.8s" repeatCount="indefinite" path={DOWN} /></circle> : null}
            {motion && ch === "up" ? <circle className="talk__packet talk__packet--up" r={6}><animateMotion dur="1.6s" repeatCount="indefinite" path={UP} /></circle> : null}
          </svg>
          {NODES.map((n, i) => (
            <div key={n.key} className={`talk__node talk__node--${n.key}`} style={{ left: pct(n.x, W), top: pct(n.y, H) } as CSSProperties}>
              {"crew" in n ? <Bot i={n.crew} className="talk__bot" /> : <span className="talk__you">›_</span>}
              <span className="talk__name"><b>{n.name}</b><small>{n.note}</small></span>
              {i === 3 ? <span className={`talk__tag talk__tag--down${on("down") ? " is-on" : ""}`}>send</span> : null}
              {i === 0 ? <span className={`talk__tag talk__tag--up${on("up") ? " is-on" : ""}`}>result</span> : null}
              {i === 3 || i === 1 ? <span className={`talk__fence${on("fenced") ? " is-on" : ""}`}>data, not instructions</span> : null}
            </div>
          ))}
          <div className={`talk__board${on("shared") ? " is-on" : ""}`} style={{ left: pct(BOARD.x, W), top: pct(BOARD.y, H), width: pct(BOARD.w, W), height: pct(BOARD.h, H) }}>
            <b>Task board</b><small>leases, epochs</small>
            <b>kv</b><small>compare-and-swap</small>
          </div>
        </div>
        <div className={`talk__board talk__board--phone${on("shared") ? " is-on" : ""}`}>
          <b>Task board</b><small>leases, epochs</small>
          <b>kv</b><small>compare-and-swap</small>
        </div>
      </figure>
      <div className="talk__side">
        <ul className="talk__chs" role="radiogroup" aria-label="Channels">
          {CHANNELS.map((c, k) => (
            <li key={c.id} className={ch === "all" || ch === c.id ? "is-on" : undefined}>
              <button type="button" role="radio" aria-checked={ch === c.id} tabIndex={ch === c.id || (ch === "all" && k === 0) ? 0 : -1}
                onClick={() => setCh(c.id)} onKeyDown={(e) => {
                  const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
                  if (!d) return;
                  e.preventDefault();
                  const n = CHANNELS[(k + d + CHANNELS.length) % CHANNELS.length]!;
                  setCh(n.id);
                  (e.currentTarget.closest("ul")?.querySelectorAll("button")[CHANNELS.indexOf(n)] as HTMLButtonElement | undefined)?.focus();
                }}>{c.name}</button>
              <p>{c.text}</p>
            </li>
          ))}
        </ul>
        <p className="talk__notyet">Not yet: siblings talk through their parent. Direct messages between siblings of one parent are on the roadmap.</p>
      </div>
    </div>
  );
}
