// Builds the publishable @capcomd/plugin (spec §17.2 step 13) into <out>/capcomd-plugin-X.Y.Z.tgz and prints its path.
// The workspace package (../package.json) points at the TypeScript sources and stays private: the published one is
// made here, from it. ESM JavaScript for Node ≥ 20 and Bun (Bun.build, zod left a dependency), declarations from tsc
// (relative imports given their `.js`, so `moduleResolution: nodenext` consumers resolve them), the manifest's JSON
// Schema, the README, the LICENSE; its version is the workspace package's, which must be capcomd's (they are released
// together: AGENTS.md). Publishing is the release workflow's (.github/workflows/release.yml), never by hand.
//   bun packages/plugin/scripts/pack.ts [--out <dir>]      (default packages/plugin/dist)
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = join(import.meta.dir, "..");
const repo = join(root, "..", "..");
// A refusal throws (the tests call `pack`); run as a script, it is printed and the exit code is 1.
const fail = (m: string): never => { throw new Error(`pack: ${m}`); };
const run = (argv: string[], cwd: string) => {
  const p = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) fail(`${argv.join(" ")} failed:\n${p.stdout.toString()}${p.stderr.toString()}`);
  return p.stdout.toString();
};

/** The entry points, as the published `exports` name them. */
export const ENTRIES = { ".": "index", "./client": "client", "./testkit": "testkit" } as const;

/** The published package.json: the workspace one's identity, the built files' exports, nothing of the workspace's. */
export function publishedManifest(ws: Record<string, any>, version: string): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  for (const [path, name] of Object.entries(ENTRIES)) exports[path] = { types: `./dist/types/${name}.d.ts`, default: `./dist/${name}.js` };
  exports["./schema"] = "./schema/plugin-manifest.schema.json";
  exports["./package.json"] = "./package.json";
  return {
    name: ws.name, version, type: "module",
    description: "Write capcomd plugins: the manifest schema, the hook and context types, the client library for out-of-process plugins (connect) and the test kit.",
    keywords: ["capcomd", "plugin", "agents", "orchestration"],
    license: "MIT",
    author: "Marvin Amador Campos (https://github.com/MarvinAmador7)",
    homepage: "https://github.com/MarvinAmador7/capcomd/blob/main/docs/plugins.md",
    repository: { type: "git", url: "git+https://github.com/MarvinAmador7/capcomd.git", directory: "packages/plugin" },
    bugs: { url: "https://github.com/MarvinAmador7/capcomd/issues" },
    main: "./dist/index.js", types: "./dist/types/index.d.ts", exports,
    files: ["dist", "schema", "README.md", "LICENSE"],
    engines: { node: ">=20" },
    sideEffects: false,
    dependencies: ws.dependencies,
  };
}

/** `from "./x"` → `from "./x.js"` (or `./x/index.js` for a directory) in a declaration file under `dir`. */
export function withExtensions(text: string, dir: string): string {
  return text.replace(/((?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"']+)\2/g, (m, pre: string, q: string, spec: string) => {
    if (/\.(js|json)$/.test(spec)) return m;
    const target = resolve(dir, spec);
    const ext = existsSync(target) && statSync(target).isDirectory() ? "/index.js" : ".js";
    return `${pre}${q}${spec}${ext}${q}`;
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

/** `capcomd` is capcomd's version (default: the repository's package.json), which the package's must be. */
export async function pack(out: string, capcomd: string = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version): Promise<string> {
  const ws = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (ws.version !== capcomd) fail(`packages/plugin/package.json is ${ws.version} and capcomd ${capcomd}: they are released together (bump both in the release commit)`);
  const stage = join(out, "package");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const built = await Bun.build({
    entrypoints: Object.values(ENTRIES).map((n) => join(root, "src", `${n}.ts`)),
    outdir: join(stage, "dist"), target: "node", format: "esm", splitting: true, external: Object.keys(ws.dependencies ?? {}),
    naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
  });
  if (!built.success) fail(`bun build failed:\n${built.logs.map(String).join("\n")}`);

  const types = join(stage, "dist", "types");
  run(["bun", "x", "tsc", "-p", join(root, "tsconfig.build.json"), "--outDir", types], repo);
  for (const f of walk(types).filter((f) => f.endsWith(".d.ts"))) writeFileSync(f, withExtensions(readFileSync(f, "utf8"), dirname(f.replace(types, join(root, "src")))));

  mkdirSync(join(stage, "schema"));
  copyFileSync(join(root, "schema", "plugin-manifest.schema.json"), join(stage, "schema", "plugin-manifest.schema.json"));
  copyFileSync(join(root, "README.md"), join(stage, "README.md"));
  copyFileSync(join(repo, "LICENSE"), join(stage, "LICENSE"));
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(publishedManifest(ws, ws.version), null, 2)}\n`);

  run(["bun", "pm", "pack", "--destination", out, "--quiet"], stage);
  const tgz = join(out, `capcomd-plugin-${ws.version}.tgz`);
  if (!existsSync(tgz)) fail(`expected ${tgz}; ${out} has ${readdirSync(out).join(", ")}`);
  return tgz;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  try { console.log(await pack(resolve(values.out ?? join(root, "dist")))); }
  catch (e) { console.error((e as Error).message); process.exit(1); }
}
