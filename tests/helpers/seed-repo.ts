import type { EngineOpts } from "./test-engine";

/** Fresh bare repo per case with a seeded `trunk` (the merge target). */
export async function seedRepo(opts: EngineOpts): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("fs");
  const { Git } = await import("../../src/merge/git");
  const bare = `${opts.dataDir}/git/origin.git`;
  const seed = `${opts.dataDir}/git/seed`;
  mkdirSync(bare, { recursive: true });
  mkdirSync(seed, { recursive: true });
  await new Git(bare).ok(["init", "-q", "--bare", "-b", "trunk"]);
  const g = new Git(seed);
  await g.ok(["init", "-q", "-b", "trunk"]);
  writeFileSync(`${seed}/README.md`, "test fixture\n");
  await g.ok(["add", "."]);
  await g.ok(["commit", "-q", "-m", "seed"]);
  await g.ok(["push", "-q", bare, "trunk"]);
}
