// Writes fixtures/catalog.json and fixtures/golden/bots.json. --check fails when either is stale
// (refresh: bun packages/bot-avatar/scripts/golden.ts). A change that alters any golden bot is a catalog version bump:
// existing agents would get a different face.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogJson, goldenJson } from "../test/golden-lib";

const dir = join(import.meta.dir, "..", "fixtures");
const out = [[join(dir, "catalog.json"), catalogJson()], [join(dir, "golden", "bots.json"), goldenJson()]] as const;
if (process.argv.includes("--check")) {
	const stale = out.filter(([p, c]) => { try { return readFileSync(p, "utf8") !== c; } catch { return true; } }).map(([p]) => p);
	if (stale.length) { console.error(`stale golden files (run bun packages/bot-avatar/scripts/golden.ts):\n${stale.join("\n")}`); process.exit(1); }
	console.log(`golden files are up to date (${out.length})`);
} else for (const [p, c] of out) writeFileSync(p, c);
