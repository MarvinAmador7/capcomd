// Drift of the env image's warm template (src/env/drift.ts): commits behind the target, a changed lockfile, a
// rewritten target. Read from a local bare repo, as `env status` / `env doctor` read the project's remote.
import { describe, expect, test } from "bun:test";
import { bareRepo } from "../merge/gitfixture";
import { driftOf, loginsOnOlderEnv, templateDrift, templateDriftFacts } from "../../src/env/drift";
import type { EnvRecord } from "../../src/env/resolve";

const C = "c".repeat(40);
const facts = { target: "main", tip: "d".repeat(40), ancestor: true, behind: 0, lockChanged: false };

describe("driftOf", () => {
  test("current, behind, lockfile changed, diverged, unknown; the rebuild command where one is due", () => {
    expect(driftOf(C, facts)).toMatchObject({ state: "current", behind: 0 });
    const behind = driftOf(C, { ...facts, behind: 3 });
    expect(behind).toMatchObject({ state: "behind", behind: 3 });
    expect(behind.message).toContain("3 commits behind main");
    expect(behind.message).toContain("capcomd env build --sandbox docker");
    expect(driftOf(C, { ...facts, behind: 1 }).message).toContain("1 commit behind");
    const lock = driftOf(C, { ...facts, behind: 2, lockChanged: true });
    expect(lock).toMatchObject({ state: "lockfile", lockChanged: true });
    expect(lock.message).toContain("agents clone and install their own dependencies");
    expect(driftOf(C, { ...facts, ancestor: false, behind: null })).toMatchObject({ state: "diverged" });
    expect(driftOf(C, { ...facts, tip: null, ancestor: null, error: "git fetch failed" })).toMatchObject({ state: "unknown" });
  });
});

test("templateDriftFacts: behind by the commits pushed since, the lockfile change seen, a commit not in the history", async () => {
  const r = await bareRepo();
  await r.pushToMain("bun.lock", "{\"lockfileVersion\":1}\n", "lockfile");
  const built = (await r.sha("refs/heads/main"))!;
  const rec = (commit: string, depsInstalled = true): EnvRecord => ({ name: "capcomd-env-x", builtAt: "", buildMs: 1000, versions: {}, depsInstalled, manifest: { schema: 1, pins: { claude: "", codex: "", node: "" }, lockHash: "h", lockFile: "bun.lock", repo: r.bare, template: { commit, target: "main" } } });
  expect(await templateDrift(rec(built), r.cfg)).toMatchObject({ state: "current", behind: 0 });

  await r.pushToMain("a.txt", "a\n");
  await r.pushToMain("b.txt", "b\n");
  expect(await templateDrift(rec(built), r.cfg)).toMatchObject({ state: "behind", behind: 2, lockChanged: false });

  await r.pushToMain("bun.lock", "{\"lockfileVersion\":1,\"x\":1}\n", "bump deps");
  expect(await templateDrift(rec(built), r.cfg)).toMatchObject({ state: "lockfile", behind: 3, lockChanged: true });
  // Without installed dependencies a lockfile change costs nothing; a record of an image found already built (buildMs
  // 0) doesn't know whether it has them, so the change counts.
  expect(await templateDrift(rec(built, false), r.cfg)).toMatchObject({ state: "behind", behind: 3 });
  expect(await templateDrift({ ...rec(built, false), buildMs: 0 }, r.cfg)).toMatchObject({ state: "lockfile" });

  expect(await templateDriftFacts(rec("e".repeat(40)).manifest, r.cfg)).toMatchObject({ ancestor: false });
  // No warm template (a shallow one, or boxd): nothing to say.
  expect(await templateDrift({ ...rec(built), manifest: { ...rec(built).manifest, template: undefined } }, r.cfg)).toBeNull();
}, 60_000);

test("plan logins saved on an older env image are named, with the command that moves them", () => {
  const notes = loginsOnOlderEnv("capcomd-env-new", [
    { agent: "claude-code", snapshot: "capcomd-auth-claude-old", env: "capcomd-env-old" },
    { agent: "codex", snapshot: "capcomd-auth-codex-new", env: "capcomd-env-new" },
    { agent: "codex", env: "capcomd-env-old" },
  ]);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("capcomd auth login claude --sandbox docker");
});
