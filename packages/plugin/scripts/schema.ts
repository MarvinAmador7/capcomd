// Writes schema/plugin-manifest.schema.json from the zod manifest schema (src/manifest.ts). `--check` fails when the
// committed file is stale (test/manifest.test.ts runs it too).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PluginManifest } from "../src/manifest";

export const SCHEMA_PATH = join(import.meta.dir, "..", "schema", "plugin-manifest.schema.json");

export function manifestJsonSchema(): string {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(PluginManifest, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  const out = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://capcomd.dev/schema/plugin-manifest.schema.json",
    title: "capcomd plugin manifest (capcomd.plugin/v1)",
    description: "plugin.json: docs/spec/plugin-api.md §4. Generated from packages/plugin/src/manifest.ts; do not edit.",
    ...schema,
  };
  return JSON.stringify(out, null, 2) + "\n";
}

if (import.meta.main) {
  const text = manifestJsonSchema();
  if (process.argv.includes("--check")) {
    let cur = "";
    try { cur = readFileSync(SCHEMA_PATH, "utf8"); } catch { /* missing */ }
    if (cur !== text) { console.error(`${SCHEMA_PATH} is stale; run \`bun packages/plugin/scripts/schema.ts\``); process.exit(1); }
    console.log("schema up to date");
  } else {
    writeFileSync(SCHEMA_PATH, text);
    console.log(`wrote ${SCHEMA_PATH}`);
  }
}
