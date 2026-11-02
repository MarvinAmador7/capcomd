"use client";

// The seven orchestration patterns (plugins/capcomd/skills/capcomd-orchestration/SKILL.md), each drawn as the shape of
// the run it makes: who is spawned, where verify and merge sit, what goes back. Pick one and the drawing changes. Before
// the script runs (or without it) every pattern's text is shown as a list and the first drawing stands.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Bot } from "./crew";

type Node = { id: string; x: number; y: number; label: string; bot?: number; dim?: boolean; w?: number };
type Edge = [from: string, to: string, opts?: { back?: boolean; label?: string; dashed?: boolean; lx?: number }];
interface Pattern { id: string; name: string; text: ReactNode; use: string; nodes: Node[]; edges: Edge[]; notes?: Array<[x: number, y: number, text: string]> }

const W = 700, H = 300, SW = 96, AW = 120, NH = 44;
const PATTERNS: Pattern[] = [
  {
    id: "loop", name: "Single loop", use: "One coherent change.",
    text: <>spawn, await, verify; on a fail, send the failures or spawn again with them; merge.</>,
    nodes: [{ id: "s", x: 20, y: 130, label: "spawn" }, { id: "w", x: 180, y: 130, label: "worker", bot: 1 }, { id: "v", x: 370, y: 130, label: "verify" }, { id: "m", x: 540, y: 130, label: "merge" }],
    edges: [["s", "w"], ["w", "v"], ["v", "m"], ["v", "w", { back: true, label: "send the failures" }]],
  },
  {
    id: "fan", name: "Fan-out, fan-in", use: "Independent subtasks.",
    text: <>A task per disjoint area, a spawn per task, a <code>wait-any</code> loop that verifies each, merges in series, then one verify on the target.</>,
    nodes: [{ id: "s", x: 20, y: 150, label: "spawn ×3" }, { id: "a", x: 160, y: 50, label: "worker", bot: 1 }, { id: "b", x: 160, y: 150, label: "worker", bot: 2 }, { id: "c", x: 160, y: 250, label: "worker", bot: 3 },
      { id: "va", x: 330, y: 50, label: "verify" }, { id: "vb", x: 330, y: 150, label: "verify" }, { id: "vc", x: 330, y: 250, label: "verify" }, { id: "m", x: 470, y: 150, label: "merge ×3" }, { id: "t", x: 590, y: 150, label: "verify", w: 90 }],
    edges: [["s", "a"], ["s", "b"], ["s", "c"], ["a", "va"], ["b", "vb"], ["c", "vc"], ["va", "m"], ["vb", "m"], ["vc", "m"], ["m", "t"]],
    notes: [[470, 196, "in series"], [590, 196, "the target"]],
  },
  {
    id: "queue", name: "Supervisor and workers", use: "A long queue of dynamic work.",
    text: <>Workers claim leased tasks, renew, mark them done; shared decisions go through <code>kv cas</code>. A crashed worker&apos;s task goes to the next claim.</>,
    nodes: [{ id: "b", x: 20, y: 150, label: "task board", w: 130 }, { id: "a", x: 290, y: 50, label: "worker", bot: 1 }, { id: "w", x: 290, y: 150, label: "worker", bot: 2 }, { id: "c", x: 290, y: 250, label: "crashed", bot: 3, dim: true }, { id: "k", x: 560, y: 150, label: "kv cas", w: 110 }],
    edges: [["a", "b", { label: "claim, renew, done", lx: 205 }], ["w", "b"], ["c", "b", { dashed: true }], ["a", "k"], ["w", "k"]],
    notes: [[160, 286, "its lease expires; the next claim takes it"]],
  },
  {
    id: "critic", name: "Critic loop", use: "A bar tests can't express. Put the critic on another provider.",
    text: <>A coder, then verify with a review profile and acceptance criteria; the reviewer&apos;s reasons go back to the coder, up to k rounds.</>,
    nodes: [{ id: "c", x: 20, y: 130, label: "coder", bot: 1 }, { id: "v", x: 200, y: 130, label: "verify" }, { id: "r", x: 360, y: 130, label: "reviewer", bot: 4 }, { id: "m", x: 560, y: 130, label: "merge" }],
    edges: [["c", "v"], ["v", "r"], ["r", "m"], ["r", "c", { back: true, label: "its reasons, up to k rounds" }]],
  },
  {
    id: "best", name: "Best of n", use: "High-variance, high-value changes.",
    text: <>n coders on the same task, verified each; a judge agent picks among those that passed; merge the winner, cancel the rest. There is no built-in compare yet.</>,
    nodes: [{ id: "a", x: 20, y: 50, label: "coder", bot: 1 }, { id: "b", x: 20, y: 150, label: "coder", bot: 2 }, { id: "c", x: 20, y: 250, label: "coder", bot: 3 },
      { id: "va", x: 190, y: 50, label: "verify" }, { id: "vb", x: 190, y: 150, label: "verify" }, { id: "vc", x: 190, y: 250, label: "verify" }, { id: "j", x: 360, y: 150, label: "judge", bot: 5 }, { id: "m", x: 560, y: 150, label: "merge" }],
    edges: [["a", "va"], ["b", "vb"], ["c", "vc"], ["va", "j"], ["vb", "j"], ["vc", "j", { dashed: true }], ["j", "m", { label: "the winner" }]],
    notes: [[190, 286, "failed: out"], [360, 196, "the rest are cancelled"]],
  },
  {
    id: "tree", name: "Hierarchical planner", use: "Big, multi-area goals.",
    text: <><code>capcomd run &quot;&lt;goal&gt;&quot;</code> spawns a planner that splits the work and verifies and merges its children from its VM; sub-planners for big areas.</>,
    nodes: [{ id: "g", x: 20, y: 150, label: "run <goal>", w: 110 }, { id: "p", x: 170, y: 150, label: "planner", bot: 0 }, { id: "l1", x: 350, y: 80, label: "lead", bot: 6 }, { id: "l2", x: 350, y: 220, label: "lead", bot: 7 },
      { id: "w1", x: 540, y: 40, label: "worker", bot: 1 }, { id: "w2", x: 540, y: 120, label: "worker", bot: 2 }, { id: "w3", x: 540, y: 180, label: "worker", bot: 3 }, { id: "w4", x: 540, y: 260, label: "worker", bot: 8 }],
    edges: [["g", "p"], ["p", "l1"], ["p", "l2"], ["l1", "w1"], ["l1", "w2"], ["l2", "w3"], ["l2", "w4"]],
  },
  {
    id: "iface", name: "Interface first", use: "Dependent work.",
    text: <>A small contract child lands first; provider and consumers then run in parallel and land in dependency order. Stacked branches aren&apos;t supported.</>,
    nodes: [{ id: "c", x: 20, y: 150, label: "contract", bot: 1 }, { id: "m1", x: 190, y: 150, label: "merge" }, { id: "p", x: 340, y: 70, label: "provider", bot: 2, w: 136 }, { id: "u", x: 340, y: 230, label: "consumer", bot: 3, w: 136 }, { id: "m2", x: 540, y: 150, label: "merge", w: 110 }],
    edges: [["c", "m1"], ["m1", "p"], ["m1", "u"], ["p", "m2", { label: "1" }], ["u", "m2", { label: "2" }]],
    notes: [[540, 196, "in dependency order"]],
  },
];

const width = (n: Node) => n.w ?? (n.bot !== undefined ? AW : SW);
function edgePath(a: Node, b: Node, back?: boolean): string {
  if (back) {
    const x1 = a.x + width(a) / 2, x2 = b.x + width(b) / 2, y = a.y + NH / 2, low = y + 52;
    return `M${x1} ${y}V${low - 10}Q${x1} ${low} ${x1 - 10} ${low}H${x2 + 10}Q${x2} ${low} ${x2} ${low - 10}V${b.y + NH / 2 + 6}`;
  }
  const leftward = b.x < a.x;
  const x1 = leftward ? a.x : a.x + width(a), x2 = leftward ? b.x + width(b) + 6 : b.x - 6, y1 = a.y, y2 = b.y;
  if (y1 === y2) return `M${x1} ${y1}H${x2}`;
  const mx = (x1 + x2) / 2, r = Math.min(10, Math.abs(y2 - y1) / 2), d = Math.sign(y2 - y1), h = Math.sign(x2 - x1);
  return `M${x1} ${y1}H${mx - h * r}Q${mx} ${y1} ${mx} ${y1 + d * r}V${y2 - d * r}Q${mx} ${y2} ${mx + h * r} ${y2}H${x2}`;
}
const pct = (v: number, of: number) => `${(v / of) * 100}%`;

export function PatternPicker() {
  const [sel, setSel] = useState<string | null>(null);   // null before the script runs: every pattern's text is shown
  useEffect(() => setSel(PATTERNS[0]!.id), []);
  const p = PATTERNS.find((x) => x.id === sel) ?? PATTERNS[0]!;
  const byId = (id: string) => p.nodes.find((n) => n.id === id)!;
  return (
    <div className={`pp${sel ? "" : " is-static"}`}>
      <div className="pp__list" role="radiogroup" aria-label="Patterns">
        {PATTERNS.map((x, k) => (
          <div key={x.id} className={`pp__item${sel === x.id ? " is-on" : ""}`}>
            <button type="button" role="radio" aria-checked={sel === x.id} tabIndex={sel === x.id || (!sel && k === 0) ? 0 : -1}
              onClick={() => setSel(x.id)} onKeyDown={(e) => {
                const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
                if (!d) return;
                e.preventDefault();
                const n = (k + d + PATTERNS.length) % PATTERNS.length;
                setSel(PATTERNS[n]!.id);
                (e.currentTarget.closest(".pp__list")?.querySelectorAll("button")[n] as HTMLButtonElement | undefined)?.focus();
              }}>{x.name}</button>
            <div className="pp__body"><p>{x.text}</p><p className="pp__use">{x.use}</p></div>
          </div>
        ))}
      </div>
      <figure className="pp__fig" aria-hidden="true">
        <div className="pp__canvas" key={p.id}>
          <svg viewBox={`0 0 ${W} ${H}`} className="pp__svg">
            {p.edges.map(([f, t, o], i) => {
              const a = byId(f), b = byId(t);
              return <path key={i} className={`pp__edge${o?.back ? " is-back" : ""}${o?.dashed ? " is-dashed" : ""}`} d={edgePath(a, b, o?.back)} style={{ "--i": i } as CSSProperties} pathLength={1} />;
            })}
          </svg>
          {p.nodes.map((n, i) => (
            <div key={n.id} className={`pp__node${n.bot !== undefined ? " pp__node--agent" : ""}${n.dim ? " is-dim" : ""}`}
              style={{ left: pct(n.x, W), top: pct(n.y - NH / 2, H), width: pct(width(n), W), height: pct(NH, H), "--i": i } as CSSProperties}>
              {n.bot !== undefined ? <Bot i={n.bot} className="pp__bot" /> : null}
              <span>{n.label}</span>
            </div>
          ))}
          {p.edges.filter(([, , o]) => o?.label).map(([f, t, o], i) => {
            const a = byId(f), b = byId(t);
            const x = o!.back ? (a.x + width(a) / 2 + b.x + width(b) / 2) / 2 : o!.lx ?? (a.x + width(a) + b.x) / 2;
            const y = o!.back ? a.y + NH / 2 + 52 : (a.y + b.y) / 2 - 18;
            return <span key={i} className="pp__label" style={{ left: pct(x, W), top: pct(y, H) }}>{o!.label}</span>;
          })}
          {(p.notes ?? []).map(([x, y, t], i) => <span key={`n${i}`} className="pp__note" style={{ left: pct(x, W), top: pct(y, H) }}>{t}</span>)}
        </div>
      </figure>
    </div>
  );
}
