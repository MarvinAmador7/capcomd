import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Git } from "../../src/merge/git";
import { loadMergeConfig, type MergeConfig } from "../../src/merge/config";

/** A local bare-repo "git server" with a seeded main branch, plus a config pointing at it. */
export async function bareRepo(opts: { mode?: "pr" | "direct"; strategy?: "squash" | "rebase" | "merge"; test?: string; extraEnv?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "capcomd-merge-"));
  const bare = join(root, "origin.git");
  mkdirSync(bare);
  await new Git(bare).ok(["init", "-q", "--bare", "-b", "main"]);
  const seed = join(root, "seed");
  mkdirSync(seed);
  const g = new Git(seed);
  await g.ok(["init", "-q", "-b", "main"]);
  writeFileSync(join(seed, "README.md"), "# fixture\n");
  writeFileSync(join(seed, "shared.txt"), "line 1\nline 2\nline 3\n");
  await g.ok(["add", "."]);
  await g.ok(["commit", "-q", "-m", "seed"]);
  await g.ok(["remote", "add", "origin", bare]);
  await g.ok(["push", "-q", "origin", "main"]);
  const env: Record<string, string> = {
    CAPCOMD_REPO: bare,
    CAPCOMD_MERGE_MODE: opts.mode ?? "direct",
    CAPCOMD_MERGE_STRATEGY: opts.strategy ?? "squash",
    CAPCOMD_WORKDIR: join(root, "work"),
    CAPCOMD_TEST_COMMAND: opts.test ?? "",
    CAPCOMD_GITHUB_REPO: "acme/widgets",
    CAPCOMD_GITHUB_POLL_MS: "20",
    CAPCOMD_GITHUB_TIMEOUT_MS: "10000",
    ...opts.extraEnv,
  };
  const cfg = loadMergeConfig(env) as MergeConfig;
  const remote = new Git(bare);
  return {
    root, bare, env, cfg, seed: g,
    /** Commit on main directly in the bare repo via the seed clone (someone else pushing). */
    async pushToMain(file: string, content: string, msg = `external ${file}`) {
      await g.ok(["fetch", "-q", "origin"]);
      await g.ok(["reset", "-q", "--hard", "origin/main"]);
      writeFileSync(join(seed, file), content);
      await g.ok(["add", file]);
      await g.ok(["commit", "-q", "-m", msg]);
      await g.ok(["push", "-q", "origin", "HEAD:main"]);
    },
    async mainLog(): Promise<string[]> {
      return (await remote.ok(["log", "--format=%s%n%b", "main"])).split("\n");
    },
    async landings(key: string): Promise<number> {
      const out = await remote.run(["log", "--no-merges", "--format=%H", "--fixed-strings", "--grep", `Capcomd-Task: ${key}`, "main"]);
      return out.stdout.split("\n").filter(Boolean).length;
    },
    async show(ref: string, path: string) { return remote.ok(["show", `${ref}:${path}`]); },
    sha: (ref: string) => remote.revParse(ref),
  };
}
