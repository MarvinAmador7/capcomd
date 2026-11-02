import { PatternPicker } from "./PatternPicker";

// The seven patterns live in PatternPicker (plugins/capcomd/skills/capcomd-orchestration/SKILL.md).

export function Patterns() {
  return (
    <section className="sec" id="patterns" aria-labelledby="pt-title">
      <h2 className="big" id="pt-title" data-reveal><span>Seven patterns,</span> <span>one set of primitives.</span></h2>
      <p className="prims" data-reveal>
        The orchestration skill teaches your agent which pattern fits the job, built from the same few calls.
      </p>
      <PatternPicker />
      <p className="pt__plus" data-reveal><b>Plus report agents.</b> <code>spawn --report</code> gives a read-only checkout; the final message is the result and nothing is pushed: research, triage, analysis.</p>
    </section>
  );
}
