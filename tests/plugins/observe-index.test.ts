// observe-runs-index appends a run's row to the runs index its creator named (scope `setOrigin`, plugin API §6.6.4).
// Anyone who reaches the engine can name that file, so the daemon appends only to a runs index: an absolute `.jsonl`
// path in a folder that exists, not a link, missing, empty or with a row on its first line. Anything else (a shell
// profile, another program's file) is never written: the row goes to the daemon's own index instead.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isRunsIndex } from "../../src/plugins/observe";

const dir = mkdtempSync(join(tmpdir(), "capcomd-observe-index-"));

describe("isRunsIndex", () => {
  test("a missing, empty or existing runs index in a folder that exists", () => {
    expect(isRunsIndex(join(dir, "missing.jsonl"))).toBe(true);
    writeFileSync(join(dir, "empty.jsonl"), "");
    expect(isRunsIndex(join(dir, "empty.jsonl"))).toBe(true);
    writeFileSync(join(dir, "runs.jsonl"), `${JSON.stringify({ runId: "run-a", label: null, repo: null, cwd: "/x", createdAt: 1 })}\n`);
    expect(isRunsIndex(join(dir, "runs.jsonl"))).toBe(true);
  });

  test("never another kind of file, a link, a folder it would have to make, or a path that isn't plain and absolute", () => {
    // Not a .jsonl file: a shell profile, say, which a JSON line with $(…) in a label would run.
    expect(isRunsIndex(join(dir, ".zshenv"))).toBe(false);
    expect(isRunsIndex(join(dir, "runs.json"))).toBe(false);
    // A .jsonl file that isn't a runs index.
    writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify({ type: "x" })}\n`);
    expect(isRunsIndex(join(dir, "events.jsonl"))).toBe(false);
    writeFileSync(join(dir, "torn.jsonl"), "not json\n");
    expect(isRunsIndex(join(dir, "torn.jsonl"))).toBe(false);
    // A link to a runs index, or to anything else.
    symlinkSync(join(dir, "runs.jsonl"), join(dir, "link.jsonl"));
    expect(isRunsIndex(join(dir, "link.jsonl"))).toBe(false);
    // A folder named like one.
    mkdirSync(join(dir, "folder.jsonl"));
    expect(isRunsIndex(join(dir, "folder.jsonl"))).toBe(false);
    // A folder that doesn't exist (the daemon makes none for another process).
    expect(isRunsIndex(join(dir, "nope", "runs.jsonl"))).toBe(false);
    // Relative, or not in its plainest form.
    expect(isRunsIndex("runs.jsonl")).toBe(false);
    expect(isRunsIndex(`${dir}/nope/../runs.jsonl`)).toBe(false);
  });
});
