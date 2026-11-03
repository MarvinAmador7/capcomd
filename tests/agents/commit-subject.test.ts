import { describe, expect, test } from "bun:test";
import { commitSubject } from "../../src/agents/runner";

describe("commitSubject", () => {
  test("a short task is its own subject", () => {
    expect(commitSubject("Add a multiply(a, b) function\n\nDetails…")).toBe("Add a multiply(a, b) function");
  });
  test("a long task is cut at a word, within 72 characters, without trailing punctuation", () => {
    const s = commitSubject("In src/math.ts add and export function multiply(a: number, b: number): number returning a * b, then add a test");
    expect(s).toBe("In src/math.ts add and export function multiply(a: number, b: number)…");
    expect(s.length).toBeLessThanOrEqual(72);
    expect(s.endsWith("…")).toBe(true);
  });
  test("one long word is cut where it must be", () => {
    expect(commitSubject("x".repeat(100))).toBe(`${"x".repeat(71)}…`);
  });
});

describe("subjectFor: the agent's own words for its change, never the raw brief", () => {
  const brief = "You are laying the shared foundation for tinycalc, a small expression calculator. Create src/lexer.ts and…\n\nMore detail";
  test("its own commit message first, then a summary that reads like a subject, then its title", async () => {
    const { subjectFor } = await import("../../src/agents/runner");
    expect(subjectFor({ own: "Add the lexer and token types", summary: "Implemented things.", title: "lexer", goal: brief })).toBe("Add the lexer and token types");
    expect(subjectFor({ summary: "Added the lexer and its tests in src/lexer.ts. All 12 tests pass.", title: "lexer", goal: brief })).toBe("Added the lexer and its tests in src/lexer.ts");
    expect(subjectFor({ summary: "Done! Here's what I changed:", title: "shared foundation", goal: brief })).toBe("Shared foundation");
    expect(subjectFor({ summary: "**Summary:** created the lexer module", goal: brief })).toBe("Created the lexer module");
  });
  test("without any of those: the brief's first sentence, its role framing dropped", async () => {
    const { subjectFor, taskSubject } = await import("../../src/agents/runner");
    expect(subjectFor({ goal: brief })).toBe("Laying the shared foundation for tinycalc, a small expression calculator");
    expect(taskSubject("Your task is to add multiply(a, b) to src/math.ts.")).toBe("Add multiply(a, b) to src/math.ts");
    expect(taskSubject("make the failing test pass")).toBe("Make the failing test pass");
    expect(commitSubject(subjectFor({ goal: "# Goal\n\nFix the login redirect; keep the old route" }))).toBe("Fix the login redirect");
  });
});
