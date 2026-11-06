// The published @capcomd/plugin (scripts/pack.ts, spec §17.2 step 13): the tarball holds what its exports name, the
// built code needs no Bun (a plugin process may run on Node), its declarations resolve under `nodenext`, and it carries
// capcomd's version. Installing it from npm into a fresh project and using it from Node is scripts/smoke.sh (CI).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENTRIES, pack, publishedManifest, withExtensions } from "../scripts/pack";
import * as source from "../src/index";

const root = join(import.meta.dir, "..");
const out = mkdtempSync(join(tmpdir(), "capcomd-plugin-pack-"));
const stage = join(out, "package");
let tgz = "";
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

// The built code imports its dependency (zod) by name: the checkout's, as an install would have it.
beforeAll(async () => { tgz = await pack(out); symlinkSync(join(root, "..", "..", "node_modules"), join(out, "node_modules"), "dir"); }, 120_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("the published package", () => {
  test("is capcomd's version, public, and its exports name files it has", () => {
    const m = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
    const capcomd = JSON.parse(readFileSync(join(root, "..", "..", "package.json"), "utf8")).version;
    expect(tgz.endsWith(`capcomd-plugin-${capcomd}.tgz`)).toBe(true);
    expect(m).toMatchObject({ name: "@capcomd/plugin", version: capcomd, type: "module", license: "MIT", dependencies: { zod: expect.any(String) } });
    expect(m.private).toBeUndefined();
    const listed = new Set(Bun.spawnSync(["tar", "-tzf", tgz]).stdout.toString().split("\n").filter(Boolean).map((p) => p.replace(/^package\//, "")));
    for (const f of ["package.json", "README.md", "LICENSE", "schema/plugin-manifest.schema.json"]) expect(listed.has(f)).toBe(true);
    for (const [path, target] of Object.entries(m.exports as Record<string, string | { types: string; default: string }>)) {
      for (const f of typeof target === "string" ? [target] : [target.types, target.default]) expect([path, listed.has(f.replace(/^\.\//, ""))]).toEqual([path, true]);
    }
    expect(Object.keys(m.exports)).toEqual([...Object.keys(ENTRIES), "./schema", "./package.json"]);
  });

  test("the built code uses no Bun API (bun:test only inside the conformance suites, which register bun tests)", () => {
    for (const f of walk(join(stage, "dist")).filter((f) => f.endsWith(".js"))) {
      const text = readFileSync(f, "utf8");
      expect([f, /\bBun\./.test(text)]).toEqual([f, false]);
      expect(text.match(/require\("bun:[a-z]+"\)/g)?.every((r) => r === 'require("bun:test")') ?? true).toBe(true);
    }
  });

  test("it exports what the sources export, and works when imported", async () => {
    const built = await import(join(stage, "dist", "index.js"));
    expect(Object.keys(built).sort()).toEqual(Object.keys(source).sort());
    expect(built.satisfies("0.10.0-rc.1", ">=0.9.0 <1.0.0")).toBe(true);
    expect(built.parseManifest(JSON.parse(readFileSync(join(root, "examples", "slack-notifier", "plugin.json"), "utf8"))).ok).toBe(true);
    const kit = await import(join(stage, "dist", "testkit.js"));
    expect(typeof kit.testkit.bootWith).toBe("function");
    expect(typeof (await import(join(stage, "dist", "client.js"))).connect).toBe("function");
  });

  test("every relative import in its declarations names a file it has (nodenext needs the extension)", () => {
    const types = join(stage, "dist", "types");
    for (const f of walk(types).filter((f) => f.endsWith(".d.ts"))) {
      for (const [, spec] of readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        expect(spec!.endsWith(".js")).toBe(true);
        expect([f, spec, existsSync(join(f, "..", spec!.replace(/\.js$/, ".d.ts")))]).toEqual([f, spec, true]);
      }
    }
  });
});

describe("pack's pieces", () => {
  test("withExtensions: a file gets .js, a directory /index.js, the rest is left alone", () => {
    const src = join(root, "src");
    expect(withExtensions(`import { a } from "./hooks";\nexport * from "./host";\nimport type { b } from "../x.js";\ntype T = import("./seams").Forge;\nimport { z } from "zod";`, src))
      .toBe(`import { a } from "./hooks.js";\nexport * from "./host/index.js";\nimport type { b } from "../x.js";\ntype T = import("./seams.js").Forge;\nimport { z } from "zod";`);
  });
  test("publishedManifest keeps the identity and dependencies, never the workspace's private flag or scripts", () => {
    const m = publishedManifest({ name: "@capcomd/plugin", version: "0.0.0", private: true, scripts: { test: "bun test" }, dependencies: { zod: "^4" } }, "1.2.3");
    expect(m).toMatchObject({ name: "@capcomd/plugin", version: "1.2.3", dependencies: { zod: "^4" } });
    expect("private" in m || "scripts" in m).toBe(false);
  });
});
