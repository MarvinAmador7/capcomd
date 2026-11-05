// Spec §15: every worked example's manifest validates against the JSON Schema (ajv) and the zod schema, declares only
// known hooks, and the examples typecheck against the package (tsc on packages/plugin/tsconfig.json).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { HOOK_NAMES } from "../src/hooks";
import { parseManifest } from "../src/manifest";

const root = join(import.meta.dir, "..");
const examples = readdirSync(join(root, "examples")).filter((d) => existsSync(join(root, "examples", d, "plugin.json")));
const schema = JSON.parse(readFileSync(join(root, "schema", "plugin-manifest.schema.json"), "utf8"));
// `uri` is the only format the schema uses; ajv-formats is not a dependency, so accept it as a plain string here.
const ajv = new Ajv2020({ strict: false, allErrors: true, formats: { uri: true } });
const validate = ajv.compile(schema);

describe("worked examples (spec §15)", () => {
  test("there are five", () => {
    expect(examples.sort()).toEqual(["forge-github", "gate-reviewer", "sandbox-docker", "slack-notifier", "watchdog"]);
  });
  for (const name of examples) {
    describe(name, () => {
      const raw = JSON.parse(readFileSync(join(root, "examples", name, "plugin.json"), "utf8"));
      test("plugin.json validates against the JSON Schema", () => {
        const ok = validate(raw);
        expect(validate.errors ?? []).toEqual([]);
        expect(ok).toBe(true);
      });
      test("plugin.json validates against the zod schema and names itself after its directory", () => {
        const r = parseManifest(raw);
        expect(r.ok ? [] : r.issues).toEqual([]);
        if (r.ok) {
          expect(r.manifest.name).toBe(name);
          for (const h of Object.keys(r.manifest.contributes?.hooks ?? {})) expect(HOOK_NAMES as readonly string[]).toContain(h);
          if (r.manifest.entry.runtime === "in-process") expect(existsSync(join(root, "examples", name, r.manifest.entry.module))).toBe(true);
          if (r.manifest.entry.runtime === "process") expect(existsSync(join(root, "examples", name, "index.ts"))).toBe(true);
        }
      });
    });
  }
  test("a manifest that is not an example fails the JSON Schema", () => {
    expect(validate({ schema: "capcomd.plugin/v1", name: "x" })).toBe(false);
    expect(validate({ ...JSON.parse(readFileSync(join(root, "examples", "slack-notifier", "plugin.json"), "utf8")), scopes: ["approve"] })).toBe(false);
  });
  test("the package, its examples and tests typecheck", async () => {
    const proc = Bun.spawn(["bun", "x", "tsc", "--noEmit", "-p", join(root, "tsconfig.json")], { cwd: join(root, "..", ".."), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(out + err).toBe("");
    expect(code).toBe(0);
  }, 120_000);
});
