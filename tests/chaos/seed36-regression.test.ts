// Regression for chaos-run-2 seed 36: kill at merge.after_cas.before_event (2nd hit),
// recover, and require the worker sandbox to be reaped. Clock-independent: the
// "unreaped sandbox" invariant fires on any finished run whose worker is still active,
// so this no longer needs wall-clock time past the TTL (the 7.26h box suspension) to show up.
import { describe, expect, test } from "bun:test";
import { randomKillpoint } from "./harness";
import { survive } from "./survive";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { testPort } from "../helpers/engine";
import { auditRun } from "./invariants";

describe("chaos regression: seed 36", () => {
  test("seed 36 still maps to merge.after_cas.before_event:2", () => {
    expect(randomKillpoint(36)).toEqual({ killpoint: "merge.after_cas.before_event", iteration: 2 });
  });

  test("merge.after_cas.before_event:2 → recovery reaps the sandbox (all invariants hold)", async () => {
    const r = await survive("merge.after_cas.before_event", 2, true, { port: await testPort(), dataDir: mkdtempSync(join(tmpdir(), "capcomd-chaos-seed-")) });
    expect(r.error).toBeUndefined();
    expect(r.killed).toBe(true);
    expect(r.ok).toBe(true);
  }, 300_000);
});
