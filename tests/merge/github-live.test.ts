/**
 * Optional live test against real GitHub. SKIPPED unless CAPCOMD_GH_LIVE=1.
 * Setting CAPCOMD_GH_LIVE=1 authorizes it to create a throwaway PRIVATE repo
 * with `gh` (owner CAPCOMD_GH_LIVE_OWNER, default MarvinAmador7) and delete it
 * afterwards (needs the gh `delete_repo` scope; otherwise it is left and reported).
 */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMergeConfig, taskBranch } from "../../src/merge/config";
import { mergeTask, setGitHubApi } from "../../src/merge/service";
import { produceFakeWork } from "../../src/merge/fakework";

const live = process.env.CAPCOMD_GH_LIVE === "1";
const sh = (cmd: string[], cwd?: string) => {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};

test.skipIf(!live)("live: pr mode squash-merges through real GitHub exactly once", async () => {
  const owner = process.env.CAPCOMD_GH_LIVE_OWNER ?? "MarvinAmador7";
  const name = `capcomd-live-${Date.now()}`;
  const full = `${owner}/${name}`;
  sh(["gh", "repo", "create", full, "--private", "--add-readme"]);
  try {
    await Bun.sleep(2000);
    const dir = mkdtempSync(join(tmpdir(), "capcomd-live-"));
    const cfg = loadMergeConfig({
      CAPCOMD_REPO: `https://github.com/${full}.git`, CAPCOMD_MERGE_MODE: "pr", CAPCOMD_MERGE_STRATEGY: "squash",
      CAPCOMD_MERGE_TARGET: "main", CAPCOMD_WORKDIR: dir, CAPCOMD_GITHUB_REPO: full,
      CAPCOMD_TEST_COMMAND: 'test -f "tasks/$CAPCOMD_TASK_ID.md"',
    } as any)!;
    sh(["gh", "auth", "setup-git"]);
    setGitHubApi(null);
    const req = { runId: "live", taskId: "t1", branch: taskBranch("live", "t1"), target: "main" };
    await produceFakeWork(cfg, { ...req, epoch: 1 });
    const out = await mergeTask(req, cfg);
    expect(out.status).toBe("merged");
    const again = await mergeTask(req, cfg);
    expect(again).toMatchObject({ status: "merged", already: true });
  } finally {
    try { sh(["gh", "repo", "delete", full, "--yes"]); }
    catch (e) { console.warn(`could not delete ${full} (needs delete_repo scope): ${e}`); }
  }
}, 180_000);
