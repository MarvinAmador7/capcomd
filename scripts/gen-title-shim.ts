// The naming shim's source as a string (src/primitives/title-shim.gen.ts), for src/utils/assets.ts to upload into the
// VMs of agents that may not spawn. The daemon imports src/primitives/title-rules.mjs as code; the single executable's
// bundler keeps one copy per file, so the same file can't also be a text import. `--check` fails when it's stale.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const src = join(root, "src/primitives/title-rules.mjs");
const out = join(root, "src/primitives/title-shim.gen.ts");

export const generated = (text: string) =>
  `// Generated from title-rules.mjs by scripts/gen-title-shim.ts: don't edit (bun scripts/gen-title-shim.ts).\n` +
  `export const TITLE_SHIM = ${JSON.stringify(text)};\n`;

if (import.meta.main) {
  const want = generated(readFileSync(src, "utf8"));
  if (process.argv.includes("--check")) {
    let have = "";
    try { have = readFileSync(out, "utf8"); } catch {}
    if (have !== want) { console.error("src/primitives/title-shim.gen.ts is stale: run `bun scripts/gen-title-shim.ts`"); process.exit(1); }
    console.log("title-shim.gen.ts matches title-rules.mjs");
  } else {
    writeFileSync(out, want);
    console.log("wrote src/primitives/title-shim.gen.ts");
  }
}
