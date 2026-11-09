import { describe, expect, test } from "bun:test";
import { foldChangelog, foldSpec, parseNote } from "../../scripts/changes";

const CHANGELOG = "# Changelog\n\nIntro.\n\n## Unreleased\n\n- Existing entry.\n\n## 0.6.0 (2026-10-25)\n\n- Old.\n";
const SPEC = "# Spec\n\n## 18. Changes\n\n| Version | Date | Change |\n|---|---|---|\n| 1.0 | 2026-11-04 | First. |\n| 1.0.9 | 2026-11-05 | Ninth. |\n\nDecisions paragraph.\n";

describe("change notes", () => {
  test("a note with both sections parses", () => {
    const n = parseNote("routes.md", "# CHANGELOG\n\n- One.\n- Two.\n\n# Spec\n\nWith routes:\nthe gateway.\n");
    expect(n.changelog).toEqual(["- One.", "- Two."]);
    expect(n.spec).toBe("With routes: the gateway.");
  });

  test("bad notes are refused with the reason", () => {
    expect(() => parseNote("Routes.md", "# CHANGELOG\n- x")).toThrow("lowercase");
    expect(() => parseNote("a.md", "")).toThrow("empty");
    expect(() => parseNote("a.md", "# Notes\n- x")).toThrow("unknown section");
    expect(() => parseNote("a.md", "# CHANGELOG\nplain text")).toThrow("bullets");
    expect(() => parseNote("a.md", "# Spec\na | b")).toThrow('"|"');
    expect(() => parseNote("a.md", "intro\n# CHANGELOG\n- x")).toThrow("before the first section");
    expect(() => parseNote("a.md", "# Spec\nx\n# Spec\ny")).toThrow("twice");
  });

  test("fold appends bullets at the end of Unreleased, in note order", () => {
    const out = foldChangelog(CHANGELOG, [parseNote("a.md", "# CHANGELOG\n- A."), parseNote("b.md", "# CHANGELOG\n- B.")]);
    expect(out).toBe("# Changelog\n\nIntro.\n\n## Unreleased\n\n- Existing entry.\n- A.\n- B.\n\n## 0.6.0 (2026-10-25)\n\n- Old.\n");
  });

  test("fold into an empty Unreleased", () => {
    const out = foldChangelog("## Unreleased\n\n## 0.6.0 (2026-10-25)\n", [parseNote("a.md", "# CHANGELOG\n- A.")]);
    expect(out).toBe("## Unreleased\n\n- A.\n\n## 0.6.0 (2026-10-25)\n");
  });

  test("fold numbers spec rows after the last 1.0.x and keeps what follows the table", () => {
    const out = foldSpec(SPEC, [parseNote("a.md", "# Spec\nAlpha."), parseNote("b.md", "# CHANGELOG\n- only"), parseNote("c.md", "# Spec\nGamma.")], "2026-11-09");
    expect(out).toContain("| 1.0.9 | 2026-11-05 | Ninth. |\n| 1.0.10 | 2026-11-09 | Alpha. |\n| 1.0.11 | 2026-11-09 | Gamma. |\n\nDecisions paragraph.");
  });

  test("nothing to fold leaves the files as they are", () => {
    expect(foldChangelog(CHANGELOG, [])).toBe(CHANGELOG);
    expect(foldSpec(SPEC, [parseNote("a.md", "# CHANGELOG\n- x")], "2026-11-09")).toBe(SPEC);
  });
});
