// Git.run's stall bound: a call is killed when its stderr has been quiet for `stallMs` (git's `--progress` output stops
// when nothing arrives), not when a slow transfer that is still moving passes a fixed time.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Git } from "../../src/merge/git";

/** A git "command" (a shell alias) that writes `n` progress lines to stderr, one every `everyMs`, then exits 0. */
const ticking = (n: number, everyMs: number) => ["-c", `alias.tick=!i=0; while [ $i -lt ${n} ]; do printf 'Receiving objects: %d%%\\r' $i >&2; i=$((i+1)); sleep ${everyMs / 1000}; done; echo done`, "tick"];
const silent = (secs: number) => ["-c", `alias.quiet=!sleep ${secs}; echo late`, "quiet"];

describe("Git.run stallMs", () => {
  const cwd = mkdtempSync(join(tmpdir(), "capcomd-git-stall-"));

  test("a call that keeps reporting runs past stallMs, and its progress lines are heard", async () => {
    const lines: string[] = [];
    const t0 = Date.now();
    const r = await new Git(cwd).run(ticking(8, 150), { stallMs: 600, onProgress: (l) => lines.push(l) });
    expect(r.code).toBe(0);
    expect(r.stalled).toBeUndefined();
    expect(r.stdout.trim()).toBe("done");
    expect(Date.now() - t0).toBeGreaterThan(900);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.at(-1)).toMatch(/^Receiving objects: \d+%$/);
  });

  test("a call that goes quiet is killed after stallMs, and says so", async () => {
    const t0 = Date.now();
    const r = await new Git(cwd).run(silent(20), { stallMs: 1_000 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r).toMatchObject({ code: 124, timedOut: true, stalled: true });
    expect(r.stderr).toContain("made no progress for 1 s");
  });

  test("the overall cap still applies to a call that keeps reporting", async () => {
    const r = await new Git(cwd).run(ticking(100, 100), { stallMs: 2_000, timeoutMs: 500 });
    expect(r).toMatchObject({ code: 124, timedOut: true });
    expect(r.stalled).toBeUndefined();
    expect(r.stderr).toContain("timed out after 500 ms");
  });

  test("without stallMs or onProgress, stderr is read as before", async () => {
    const r = await new Git(cwd).run(ticking(2, 10));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Receiving objects: 1%");
  });
});
