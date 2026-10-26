// Writes fixtures/golden/<session>.items.json from fixtures/sessions/<session>.jsonl: every item revision the builder
// emits, in order (an open tool item, then its done rev), and the images it stored. Other languages' renderers decode
// the same files. --check fails when a golden file is stale (run `bun scripts/golden.ts` to refresh them).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { goldenOf } from "../test/golden-lib";

const dir = join(import.meta.dir, "..", "fixtures");
const sessions = readdirSync(join(dir, "sessions")).filter((f) => f.endsWith(".jsonl")).sort();
const out = sessions.map((f) => [join(dir, "golden", f.replace(/\.jsonl$/, ".items.json")), `${JSON.stringify(goldenOf(f, readFileSync(join(dir, "sessions", f), "utf8")), null, 2)}\n`] as const);
if (process.argv.includes("--check")) {
	const stale = out.filter(([p, c]) => { try { return readFileSync(p, "utf8") !== c; } catch { return true; } }).map(([p]) => p);
	if (stale.length) { console.error(`stale golden files (run bun packages/agent-thread/scripts/golden.ts):\n${stale.join("\n")}`); process.exit(1); }
	console.log(`golden files are up to date (${out.length})`);
} else for (const [p, c] of out) writeFileSync(p, c);
