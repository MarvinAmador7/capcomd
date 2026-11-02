import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { TITLE_SHIM } from "../../src/primitives/title-shim.gen";

// The uploaded shim is a generated copy of title-rules.mjs (scripts/gen-title-shim.ts); it must not drift.
test("the generated naming shim is title-rules.mjs, verbatim", () => {
  expect(TITLE_SHIM).toBe(readFileSync(join(import.meta.dir, "../../src/primitives/title-rules.mjs"), "utf8"));
});
