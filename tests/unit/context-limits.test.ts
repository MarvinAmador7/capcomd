import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { evidenceLimits, generated } from "../../scripts/gen-context-limits";

// The router's budgets are a generated copy of the context eval's docs/evidence/context/<model>/limits.json
// (scripts/gen-context-limits.ts; ADR-025 §6.4): it must not drift from what the eval wrote.
test("src/context/limits.gen.ts is the eval's limits.json files, every model", () => {
  const want = evidenceLimits();
  expect(Object.keys(want).length).toBeGreaterThan(0);
  expect(readFileSync(join(import.meta.dir, "../../src/context/limits.gen.ts"), "utf8")).toBe(generated(want));
});
