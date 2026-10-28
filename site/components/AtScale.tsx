import type { ReactNode } from "react";

// Each problem from README "Why", paired with the mechanism that answers it.
const PAIRS: Array<[string, ReactNode]> = [
  ["Agents report success, not proof", <>Checks the operator named run in a fresh VM on the branch merged with the latest target, then a separate read-only reviewer. Both must pass; no agent verifies or merges its own work.</>],
  ["Parallel agents collide", <>One VM, clone and branch per agent. Each change is verified against the latest target and merges are serial and exactly once, as the commit that passed.</>],
  ["Delegation multiplies risk", <>Depth, fan-out, child profiles and budget share are ceilings a parent can only narrow. Capability tokens scope every call; agent text is fenced as data. Budgets in dollars, turns and wall time are carved down the tree.</>],
  ["Long runs break", <>Durable actors resume after a crash or restart; a retried call never acts twice. Workspaces checkpoint while agents work, a stopped agent continues from its branch, and a usage-limit pause resumes by itself after the reset.</>],
  ["Agents get stuck", <>Idle, spinning and failing agents raise a notice to the parent and the waiting <code>await</code>, with the work checkpointed. A profile can add a stop after a second window; the work is kept.</>],
  ["Nobody can see what happened", <>The agent tree, a span waterfall, per-agent timelines and the event log, live. Costs roll up per agent and subtree, including the API-equivalent cost of work on Claude and ChatGPT plans.</>],
  ["Machines are left behind", <>Every VM is destroyed when its agent or check is done; one left behind is reaped once its idle lifetime is up. The live run used 13 VMs, all cleaned up.</>],
];

export function AtScale() {
  return (
    <section className="band" id="scale" aria-labelledby="scale-title">
      <h2 className="big" id="scale-title" data-reveal><span>What breaks at scale.</span> <span>What holds it.</span></h2>
      <ul className="scale__list">
        {PAIRS.map(([h, p]) => <li key={h} data-reveal><h3>{h}</h3><p>{p}</p></li>)}
      </ul>
    </section>
  );
}
