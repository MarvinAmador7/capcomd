// The context router's budgets per model (src/context/limits.gen.ts), from the eval's output: every
// docs/evidence/context/<model>/limits.json (ADR-025 §6.4, D4). The package ships src/ but not docs/evidence/, and a
// package file is imported, never read at run time (src/utils/assets.ts), so the router reads this copy. `--check` fails
// when it's stale; tests/unit/context-limits.test.ts checks it too.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const dir = join(root, "docs/evidence/context");
const out = join(root, "src/context/limits.gen.ts");

/** The fields the router reads, from each model's file, by model name. */
export function evidenceLimits(from = dir): Record<string, Record<string, unknown>> {
  const all: Record<string, Record<string, unknown>> = {};
  for (const model of readdirSync(from).sort()) {
    const f = join(from, model, "limits.json");
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8"));
    all[model] = { briefBytes: j.briefBytes ?? null, indexLines: j.indexLines ?? null, descriptionChars: j.descriptionChars ?? null, itemBytes: j.itemBytes ?? null, proposalsPerRun: j.proposalsPerRun ?? null, measured: j.measured === true };
  }
  return all;
}

export const generated = (limits: Record<string, Record<string, unknown>>) =>
  `// Generated from docs/evidence/context/<model>/limits.json by scripts/gen-context-limits.ts: don't edit\n` +
  `// (bun scripts/gen-context-limits.ts after the context eval writes new limits).\n` +
  `export const EVAL_LIMITS: Readonly<Record<string, { briefBytes: number | null; indexLines: number | null; descriptionChars: number | null; itemBytes: number | null; proposalsPerRun: number | null; measured: boolean }>> = ${JSON.stringify(limits, null, 2)};\n`;

if (import.meta.main) {
  const want = generated(evidenceLimits());
  if (process.argv.includes("--check")) {
    let have = "";
    try { have = readFileSync(out, "utf8"); } catch {}
    if (have !== want) { console.error("src/context/limits.gen.ts is stale: run `bun scripts/gen-context-limits.ts`"); process.exit(1); }
    console.log("limits.gen.ts matches docs/evidence/context");
  } else {
    writeFileSync(out, want);
    console.log("wrote src/context/limits.gen.ts");
  }
}
