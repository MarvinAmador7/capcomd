import { expect, test } from "bun:test";
import stringWidth from "string-width";
import { SETS } from "../src/icons";

// East Asian "Ambiguous" chars (◆ ● · …) render two cells wide in CJK locales and break the columns.
test("every glyph-set char is exactly one cell, even with ambiguous-wide terminals", () => {
  for (const name of ["glyph", "glyph-b", "minimal"] as const) {
    for (const g of [...Object.values(SETS[name].kind), ...Object.values(SETS[name].status)]) {
      expect({ name, g, w: stringWidth(g, { ambiguousIsNarrow: false }) }).toEqual({ name, g, w: 1 });
    }
  }
});

test("the old set is flagged: it has ambiguous-width chars", () => {
  const old = [...Object.values(SETS["glyph-v1"].kind), ...Object.values(SETS["glyph-v1"].status)];
  expect(old.filter((g) => stringWidth(g, { ambiguousIsNarrow: false }) !== 1).sort()).toEqual(["·", "◆", "◇", "◎", "●"].sort());
});
