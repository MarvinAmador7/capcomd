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
  test("its own commit message first, then a summary that reads like a subject (in the imperative), then its title", async () => {
    const { subjectFor } = await import("../../src/agents/runner");
    expect(subjectFor({ own: "Add the lexer and token types", summary: "Implemented things.", title: "lexer", goal: brief })).toBe("Add the lexer and token types");
    expect(subjectFor({ summary: "Added the lexer and its tests in src/lexer.ts. All 12 tests pass.", title: "lexer", goal: brief })).toBe("Add the lexer and its tests in src/lexer.ts");
    expect(subjectFor({ summary: "Done! Here's what I changed:", title: "shared foundation", goal: brief })).toBe("Shared foundation");
    expect(subjectFor({ summary: "**Summary:** created the lexer module", goal: brief })).toBe("Create the lexer module");
  });
  test("the title (the driver's --title, else the agent's own) comes before the brief", async () => {
    const { subjectFor } = await import("../../src/agents/runner");
    expect(subjectFor({ summary: "", title: "lexer and tokens", goal: brief })).toBe("Lexer and tokens");
    expect(subjectFor({ summary: null, title: null, goal: brief })).toBe("Lay the shared foundation for tinycalc, a small expression calculator");
  });
  test("chat in the summary becomes a subject, or gives way to the title (the live examples)", async () => {
    const { subjectFor, summarySubject } = await import("../../src/agents/runner");
    // "I added …" → imperative
    expect(subjectFor({ summary: "I added test/e2e.test.ts covering the CLI end to end.", title: "e2e tests", goal: brief })).toBe("Add test/e2e.test.ts covering the CLI end to end");
    expect(summarySubject("I've now implemented the printer.")).toBe("Implement the printer");
    // "X are now implemented …" → "Implement X …", the identifier kept as written
    expect(subjectFor({ summary: "`printExpr` and `printProgram` are now implemented in src/printer.ts.", title: "printer", goal: brief })).toBe("Implement printExpr and printProgram in src/printer.ts");
    // Not what was done: the title instead
    expect(subjectFor({ summary: "All three fixes are in, and the tests pass.", title: "parser fixes", goal: brief })).toBe("Parser fixes");
    expect(subjectFor({ summary: "Tinycalc (TypeScript on Bun) — the foundation is ready.", title: "foundation", goal: brief })).toBe("Foundation");
    expect(subjectFor({ summary: "Tests pass: 93 of 93.", title: "cli", goal: brief })).toBe("Cli");
    expect(subjectFor({ summary: "I'm done with the lexer.", title: "lexer", goal: brief })).toBe("Lexer");
    expect(summarySubject("Build is green now.")).toBeNull();
  });
  test("an identifier at the start keeps its case", async () => {
    const { subjectFor } = await import("../../src/agents/runner");
    expect(subjectFor({ summary: null, title: "printExpr", goal: brief })).toBe("printExpr");
    expect(subjectFor({ summary: null, title: "src/printer.ts tests", goal: brief })).toBe("src/printer.ts tests");
    expect(subjectFor({ summary: null, title: "printer", goal: brief })).toBe("Printer");
  });
  test("without any of those: the brief's first sentence, its role framing dropped, its verb in the imperative", async () => {
    const { subjectFor, taskSubject } = await import("../../src/agents/runner");
    expect(taskSubject("Your task is to add multiply(a, b) to src/math.ts.")).toBe("Add multiply(a, b) to src/math.ts");
    expect(taskSubject("make the failing test pass")).toBe("Make the failing test pass");
    expect(commitSubject(subjectFor({ goal: "# Goal\n\nFix the login redirect; keep the old route" }))).toBe("Fix the login redirect");
    // The live one: the brief's lead verb, and the parenthesis the 72-character cut would leave open dropped.
    expect(commitSubject(subjectFor({ goal: "You are landing the shared CONTRACT for tinycalc (TypeScript on Bun, strict mode, no dependencies). Then …" })))
      .toBe("Land the shared CONTRACT for tinycalc");
  });
});
