import { expect, test } from "bun:test";
import { loadFixture } from "../src/adapters/source";
import { SETS, kindOf } from "../src/icons";

test("span names map to one kind each", () => {
  const k = (name: string, attrs = {}) => kindOf({ name, attrs });
  expect([k("agent.claude_code"), k("gen_ai.chat"), k("tool.Edit"), k("git.clone"), k("sandbox.exec"), k("approval.await"), k("relay.run"), k("actor.planner.createPlan"), k("transition.task")])
    .toEqual(["agent", "llm", "tool", "git", "sandbox", "approval", "run", "run", "state"]);
});

test("no symbol has two meanings within a set", () => {
  for (const [name, s] of Object.entries(SETS)) {
    const kinds = Object.values(s.kind);
    const statuses = name === "minimal" ? [] : Object.values(s.status); // minimal: one dot, meaning carried by color
    const all = [...kinds, ...statuses];
    expect(new Set(all).size).toBe(all.length);
  }
});

test("demo fixture exercises every kind", () => {
  const kinds = new Set(loadFixture("demo-3-tasks").trace!.spans.map(kindOf));
  expect([...kinds].sort()).toEqual(["agent", "approval", "git", "llm", "run", "sandbox", "state", "tool"]);
});
