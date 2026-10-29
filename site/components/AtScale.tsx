import type { ReactNode } from "react";

// Each problem from README "Why", answered in one line. Durability has its own block ("Built on Rivet") above.
const PAIRS: Array<[string, ReactNode]> = [
  ["Agents claim success", <>Your checks and a read-only reviewer decide; no agent merges its own work.</>],
  ["Parallel agents collide", <>One VM and branch each; merges land one at a time, exactly once.</>],
  ["Delegation multiplies risk", <>Limits only narrow down the tree, and budgets are carved from the parent&apos;s.</>],
  ["Agents get stuck", <>Idle or spinning agents are flagged to their parent, their work checkpointed.</>],
  ["Nobody sees what happened", <>A live agent tree, timelines and costs per agent and subtree.</>],
  ["Machines are left behind", <>Every VM is destroyed when its work is done, or reaped once idle.</>],
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
