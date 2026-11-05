// Refresh tests/scenario-timings.json from a CI run: every scenarios shard uploads the per-file times it measured
// (artifact scenario-timings-N, .github/workflows/ci.yml); this downloads a run's and merges them into the file, so the
// shards are balanced by times measured on the CI runner (a local `bun run test:scenarios:timings` measures this machine).
//   bun scripts/scenario-timings.ts <run id>        (needs gh; files the run didn't measure keep their time)
//   bun scripts/scenario-timings.ts --check          (every file test:scenarios runs has a time)
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Glob } from "bun";

const ROOT = new URL("..", import.meta.url).pathname;
const FILE = join(ROOT, "tests/scenario-timings.json");
type Timings = { version: number; files: Record<string, number> };
const read = (f: string): Timings => JSON.parse(readFileSync(f, "utf8"));

/** The test files `bun run test:scenarios` runs (the directories and files in its script). */
function suiteFiles(): string[] {
  const script: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts["test:scenarios"];
  const paths = script.split(/\s+/).filter((p) => p.startsWith("tests/"));
  const out = new Set<string>();
  for (const p of paths) {
    if (p.endsWith(".ts")) { out.add(p); continue; }
    for (const f of new Glob(`${p}/**/*.test.{ts,tsx}`).scanSync({ cwd: ROOT })) out.add(f);
  }
  return [...out].sort();
}

const arg = process.argv[2];
if (arg === "--check") {
  const have = read(FILE).files;
  const missing = suiteFiles().filter((f) => have[f] === undefined);
  if (missing.length) { console.error(`tests/scenario-timings.json has no time for:\n  ${missing.join("\n  ")}`); process.exit(1); }
  console.log("tests/scenario-timings.json covers every test:scenarios file");
  process.exit(0);
}
if (!arg || !/^\d+$/.test(arg)) { console.error("usage: bun scripts/scenario-timings.ts <CI run id> | --check"); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), "capcomd-timings-"));
try {
  const dl = Bun.spawnSync(["gh", "run", "download", arg, "--pattern", "scenario-timings-*", "--dir", dir], { cwd: ROOT, stderr: "inherit" });
  if (dl.exitCode !== 0) process.exit(dl.exitCode ?? 1);
  const current = read(FILE);
  const files = new Set(suiteFiles());
  let n = 0;
  for (const shard of readdirSync(dir)) {
    const measured = read(join(dir, shard, "scenario-timings.json")).files;
    for (const [f, ms] of Object.entries(measured)) if (files.has(f)) { current.files[f] = ms; n++; }
  }
  // Files the suite no longer runs are dropped; the rest stay sorted, so a refresh diffs cleanly.
  current.files = Object.fromEntries(Object.entries(current.files).filter(([f]) => files.has(f)).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(FILE, JSON.stringify(current, null, 2) + "\n");
  console.log(`tests/scenario-timings.json: ${n} times from run ${arg}`);
} finally { rmSync(dir, { recursive: true, force: true }); }
