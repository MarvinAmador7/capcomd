import { expect, test } from "bun:test";
import { envSnapshotProblem } from "../../src/primitives/ops";

test("real claude/codex agents on boxd fail fast without an env snapshot; others are unaffected", () => {
  const base = { CAPCOMD_SANDBOX: "boxd", CAPCOMD_ENV_LEDGER: "/nonexistent/ledger.json" };
  expect(envSnapshotProblem("claude", base)).toContain("capcomd env build");
  expect(envSnapshotProblem("codex", base)).toContain("codex CLI would be missing");
  expect(envSnapshotProblem("claude", { ...base, CAPCOMD_ENV_SNAPSHOT: "capcomd-env-abc" })).toBeNull();
  expect(envSnapshotProblem("claude", { ...base, CAPCOMD_ENV: "image" })).toBeNull();
  expect(envSnapshotProblem("claude", { ...base, CAPCOMD_SPAWN_EXEC: "script" })).toBeNull();
  expect(envSnapshotProblem("claude", { CAPCOMD_SANDBOX: "fake" })).toBeNull();
  expect(envSnapshotProblem("fake", base)).toBeNull();
});
