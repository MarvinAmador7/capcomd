import { PatternPicker } from "./PatternPicker";

// The seven patterns live in PatternPicker (plugins/capcomd/skills/capcomd-orchestration/SKILL.md); the live run is README "A real run".
const PRIMS = ["run new", "spawn", "await", "wait-any", "send", "cancel", "verify", "merge"];
const LIVE: Array<[string, string]> = [
  ["3 of 3", "fixed, reviewed and merged; full suite green"],
  ["7", "agents: planner, 3 workers, 3 reviewers"],
  ["13", "VMs, all cleaned up"],
  ["228 s", "end to end"],
  ["$0", "billed on subscription plans; about $0.37 at API prices"],
];

export function Patterns() {
  return (
    <section className="sec" id="patterns" aria-labelledby="pt-title">
      <h2 className="big" id="pt-title" data-reveal><span>Seven patterns,</span> <span>one set of primitives.</span></h2>
      <p className="prims" data-reveal>
        The orchestration skill teaches your agent the primitives and when to use which pattern:{" "}
        {PRIMS.map((p) => <span key={p}><code>{p}</code>, </span>)}the <code>task</code> board, <code>kv</code>, <code>events</code>, <code>budget</code> and <code>grant</code>, <code>tree</code>.
      </p>
      <PatternPicker />
      <p className="pt__plus" data-reveal><b>Plus report agents.</b> <code>spawn --report</code> gives a read-only checkout; the final message is the result and nothing is pushed: research, triage, analysis.</p>
      <aside className="case" data-reveal aria-labelledby="case-title">
        <div className="case__text">
          <h3 id="case-title">A live run</h3>
          <p>From the end-to-end test of 2026-10-21: three broken functions in a private repo, one failing test each. A planner split the fix across two Claude workers and one Codex worker, verified each against its own named check in a checks VM, had a reviewer review each change, and merged all three.</p>
        </div>
        <dl>{LIVE.map(([dt, dd]) => <div key={dt}><dt>{dt}</dt><dd>{dd}</dd></div>)}</dl>
      </aside>
    </section>
  );
}
