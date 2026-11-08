// The proc-gate fixture as a plugin of its own folder (plugin API §4.9, §11.6: a third-party plugin is self-contained,
// so its main.ts, which imports the client library from this checkout, can't run from here). Tests put it in the
// plugin's directory bundled into one file, as docs/plugins.md tells an author to ship one: `main.js`, with
// `PROC_GATE_COMMAND` as the manifest's command.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PROC_GATE_MAIN = join(import.meta.dir, "proc-gate", "main.ts");
export const PROC_GATE_COMMAND = ["bun", "${PLUGIN_ROOT}/main.js"];

let built: Promise<string> | null = null;
/** proc-gate's main.ts and what it imports, bundled once per test process. */
export function procGateBundle(): Promise<string> {
  built ??= (async () => {
    const out = mkdtempSync(join(tmpdir(), "proc-gate-build-"));
    try {
      const r = await Bun.build({ entrypoints: [PROC_GATE_MAIN], target: "bun", outdir: out, naming: "main.js" });
      if (!r.success) throw new Error(`bundling proc-gate: ${r.logs.map(String).join("\n")}`);
      return readFileSync(join(out, "main.js"), "utf8");
    } finally { rmSync(out, { recursive: true, force: true }); }
  })();
  return built;
}

/** Write proc-gate's bundle into the plugin directory `dir` (its manifest's command is PROC_GATE_COMMAND). */
export async function putProcGate(dir: string): Promise<void> {
  writeFileSync(join(dir, "main.js"), await procGateBundle());
}
