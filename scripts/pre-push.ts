import { existsSync } from "node:fs";

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout.toString();
}

const remote = process.argv[2];
const updates = (await Bun.stdin.text())
  .trim()
  .split("\n")
  .map((line) => line.split(" "))
  .filter(([, local, target]) => target?.startsWith("refs/heads/") && !/^0+$/.test(local ?? ""));
if (updates.length === 0) process.exit(0);

const head = git("rev-parse", "HEAD").trim();
if (updates.some(([, local]) => local !== head) || git("diff", "--name-only", "HEAD").length > 0) {
  console.error(
    "Pre-push checks need the pushed commit checked out with clean tracked files. Use a clean worktree for that commit.",
  );
  process.exit(1);
}

const changed = new Set<string>();
for (const [, , , old] of updates) {
  let base = old!;
  if (/^0+$/.test(base)) {
    const upstream = [
      `refs/remotes/${remote}/main`,
      "refs/remotes/origin/main",
      "refs/heads/main",
    ].find((ref) => Bun.spawnSync(["git", "show-ref", "--verify", "--quiet", ref]).exitCode === 0);
    base = upstream
      ? git("merge-base", head, upstream).trim()
      : git("hash-object", "-t", "tree", "/dev/null").trim();
  }
  for (const path of git("diff", "--name-only", "-z", "--diff-filter=ACMRT", base, head).split(
    "\0",
  )) {
    if (path && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) && !path.endsWith(".gen.ts"))
      changed.add(path);
  }
}

const projects = [
  ".",
  "apps/canvas",
  "apps/tui",
  "packages/agent-thread",
  "packages/bot-avatar",
  "packages/plugin",
];
if (["oxfmt", "oxlint", "tsrs"].some((tool) => !existsSync(`node_modules/.bin/${tool}`))) {
  console.error("Pre-push tools are missing. Run bun run setup.");
  process.exit(1);
}

const deadline = AbortSignal.timeout(9_000);
const run = (tool: string, ...args: string[]) =>
  Bun.spawn([`node_modules/.bin/${tool}`, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    signal: deadline,
  }).exited;

const styleChecks = changed.size
  ? [run("oxfmt", "--check", "--", ...changed), run("oxlint", "--deny-warnings", "--", ...changed)]
  : [];
const exitCodes = await Promise.all([
  ...styleChecks,
  // Checking the project graph also catches dependents of changed or deleted files.
  ...projects.map((project) => run("tsrs", "--noEmit", "-p", project)),
]);
if (deadline.aborted) console.error("Pre-push checks exceeded 9 seconds.");
process.exit(exitCodes.some((code) => code !== 0) || deadline.aborted ? 1 : 0);
