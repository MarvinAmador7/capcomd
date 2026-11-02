import type { ReactNode } from "react";

// The problems that break agent swarms at scale, each answered in one line (owner-approved copy, 2026-10-29).
const PAIRS: Array<[string, ReactNode]> = [
  ["Agents claim success", <>Your checks and a read-only reviewer decide; no agent merges its own work.</>],
  ["Flat teams stall", <>A planner owns the goal and hands out tasks; each worker owns one, with limits that only narrow down the tree.</>],
  ["Parallel agents collide", <>One sandbox and branch each; merges land one at a time, exactly once.</>],
  ["Planners don't hear back", <>A parent awaits its children and wakes on their events, not on a poll.</>],
  ["Agents run too long", <>Budgets in dollars, turns and time, carved from the parent&apos;s; idle agents are flagged, their work checkpointed.</>],
  ["Crashes end long runs", <>Every agent is a durable workflow in the engine; the run picks up after a crash.</>],
  ["Half-built environments", <>Each agent starts from a snapshot with the agent CLIs and your repo&apos;s dependencies baked in.</>],
  ["Nobody sees what happened", <>A live agent tree, timelines and costs per agent and subtree.</>],
  ["Machines are left behind", <>Every sandbox is destroyed when its work is done, or reaped once idle.</>],
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
