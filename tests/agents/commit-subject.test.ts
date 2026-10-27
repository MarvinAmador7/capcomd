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
