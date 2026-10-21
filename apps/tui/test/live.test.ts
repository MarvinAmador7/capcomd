import { describe, expect, test } from "bun:test";
import { budgetUse } from "../src/views/Live";

describe("budget meter", () => {
  test("subscription agent ($0 spent): the meter follows turns, not an empty USD bar", () => {
    expect(budgetUse({ spent: { usd: 0, turns: 5, wallSeconds: 23 }, budget: { usd: 0.5, turns: 20, wallSeconds: 600 } })).toEqual({ frac: 0.25, unit: "turns" });
  });
  test("the unit closest to its limit wins", () => {
    expect(budgetUse({ spent: { usd: 0.9, turns: 2 }, budget: { usd: 1, turns: 40 } })).toEqual({ frac: 0.9, unit: "usd" });
    expect(budgetUse({ spent: { turns: 3, wallSeconds: 590 }, budget: { turns: 40, wallSeconds: 600 } })?.unit).toBe("wallSeconds");
  });
  test("capped at 1; no budget at all → no meter", () => {
    expect(budgetUse({ spent: { turns: 50 }, budget: { turns: 40 } })).toEqual({ frac: 1, unit: "turns" });
    expect(budgetUse({ spent: { turns: 5 }, budget: {} })).toBeNull();
  });
});
