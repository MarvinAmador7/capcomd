import { PatternPicker } from "./PatternPicker";

// The seven patterns live in PatternPicker (plugins/capcomd/skills/capcomd-orchestration/SKILL.md).
const PRIMS = ["run new", "spawn", "await", "wait-any", "send", "cancel", "verify", "merge"];

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
    </section>
  );
}
