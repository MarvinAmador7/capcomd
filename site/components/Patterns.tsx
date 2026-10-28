import type { ReactNode } from "react";

// The seven patterns of plugins/capcomd/skills/capcomd-orchestration/SKILL.md, and README "A real run".
const PATTERNS: Array<[string, ReactNode, string]> = [
  ["Single loop", <>spawn, await, verify; on a fail, send the failures or spawn again with them; merge.</>, "One coherent change."],
  ["Fan-out, fan-in", <>A task per disjoint area, a spawn per task, a <code>wait-any</code> loop that verifies each, merges in series, then one verify on the target.</>, "Independent subtasks."],
  ["Supervisor and workers", <>Workers claim leased tasks, renew, mark them done; shared decisions go through <code>kv cas</code>. A crashed worker&apos;s task goes to the next claim.</>, "A long queue of dynamic work."],
  ["Critic loop", <>A coder, then verify with a review profile and acceptance criteria; the reviewer&apos;s reasons go back to the coder, up to k rounds.</>, "A bar tests can't express. Put the critic on another provider."],
  ["Best of n", <>n coders on the same task, verified each; a judge agent picks among those that passed; merge the winner, cancel the rest. There is no built-in compare yet.</>, "High-variance, high-value changes."],
  ["Hierarchical planner", <><code>capcomd run &quot;&lt;goal&gt;&quot;</code> spawns a planner that splits the work and verifies and merges its children from its VM; sub-planners for big areas.</>, "Big, multi-area goals."],
  ["Interface first", <>A small contract child lands first; provider and consumers then run in parallel and land in dependency order. Stacked branches aren&apos;t supported.</>, "Dependent work."],
];
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
      <div className="pt__grid">
        <ol className="pt__list">
          {PATTERNS.map(([h, p, use]) => <li key={h} data-reveal><h3>{h}</h3><p>{p}</p><p className="use">{use}</p></li>)}
        </ol>
        <p className="pt__plus" data-reveal><b>Plus report agents.</b> <code>spawn --report</code> gives a read-only checkout; the final message is the result and nothing is pushed: research, triage, analysis.</p>
        <aside className="case" data-reveal aria-labelledby="case-title">
          <h3 id="case-title">A live run</h3>
          <p>From the end-to-end test of 2026-10-21: three broken functions in a private repo, one failing test each. A planner split the fix across two Claude workers and one Codex worker, verified each against its own named check in a checks VM, had a reviewer review each change, and merged all three.</p>
          <dl>{LIVE.map(([dt, dd]) => <div key={dt}><dt>{dt}</dt><dd>{dd}</dd></div>)}</dl>
        </aside>
      </div>
    </section>
  );
}
