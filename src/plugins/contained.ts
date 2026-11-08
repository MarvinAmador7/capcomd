// A third-party plugin is self-contained (docs/spec/plugin-api.md §4.9, §11.6; ADR-023 §9 decision 7, the owner's of
// 2026-11-08): everything it runs lies inside its own folder, where the LOCK and the trust hash see it. What it runs
// from anywhere else (a parent node_modules, ../lib, a link that points out, the data directory) would change without
// its hash changing, so `install`, `trust`, `validate` and the host before every start refuse it, naming each path.
//
// What this reads, without running any of the plugin's code:
//  - `entry.command`: every element that names a path (one with a `/`, or `..`; `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`
//    substituted; a flag's value after `=` too), or a module as a runtime finds one (`.`, `src`, `main`: a directory's
//    package.json `main` or index, a name without its extension), must lie inside the folder, the first element excepted
//    when it is a bare program name (`bun`, `node`, `sh`: a runtime on the PATH, not the plugin's code);
//  - `entry.env`: `NODE_PATH`'s directories, and the paths `NODE_OPTIONS` and `BUN_OPTIONS` name (a `--require` or
//    `--preload` is code);
//  - `bunfig.toml`'s `preload` (Bun reads it from the folder, its cwd);
//  - every JavaScript or TypeScript module those reach, followed through its static imports, `require()` calls and
//    `import()`s of a literal, each resolved as Bun resolves it (tsconfig `paths`, package.json `imports` and
//    `exports`) and made real, so a link that points out is outside. The folder's own node_modules is inside.
// Allowed wherever they are: `node:` and Node's built-in modules, `bun` and `bun:` ones. The client library,
// `@capcomd/plugin`, is allowed from outside the folder only as the kernel provides it: capcomd's own copy (KERNEL_CLIENT,
// covered by capcomd's own integrity; not followed). A copy anywhere else outside the folder (a parent node_modules, a
// package.json above it that names itself `@capcomd/plugin`) is outside like any module; one inside is followed like any
// other (fail-closed, the owner's rule for a security question still open). A bare import that resolves nowhere
// is a warning, not a refusal (a bundle's optional `require` in a `try`); a relative one that leaves the folder is
// outside whether or not its target exists. A specifier computed at run time, and what a shell script or any program
// that isn't JavaScript loads, can't be read here: the runtime guard (src/plugins/guard.ts) covers Bun and Node.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManifestIssue } from "../../packages/plugin/src/load";
import type { PluginManifest } from "../../packages/plugin/src/manifest";

/** The client library (§9.8). */
export const CLIENT_PACKAGE = "@capcomd/plugin";

/** capcomd's own copy of the client library, made real, when capcomd runs from its files (a checkout); null otherwise
 *  (the single executable has no files; the npm package carries no package.json of its own there). The one copy of
 *  `@capcomd/plugin` a plugin may load from outside its folder: capcomd's integrity, not the plugin's hash, covers it. */
export const KERNEL_CLIENT: string | null = (() => {
  // The single executable's own paths are virtual (/$bunfs/…, B:\~BUN\…): "../../packages/plugin" would be the host's.
  if (/\$bunfs|~BUN/.test(import.meta.dir)) return null;
  const d = join(import.meta.dir, "..", "..", "packages", "plugin");
  try { return (JSON.parse(readFileSync(join(d, "package.json"), "utf8")) as { name?: unknown }).name === CLIENT_PACKAGE ? realpathSync(d) : null; } catch { return null; }
})();

/** One reference to code outside the folder: where it is named (a file of the plugin, relative to its folder, or a
 *  manifest path such as `entry.command.1`), what it names, and the real path it leads to. */
export interface OutsideRef { from: string; specifier: string; resolved: string }

export interface SelfContained {
  /** What the plugin would run from outside its folder: refused. */
  outside: OutsideRef[];
  /** Bare imports that resolve nowhere (warnings: they fail at run time as they would anyway). */
  unresolved: Array<{ from: string; specifier: string }>;
  /** Imports of the client library, and where each resolved (null: nowhere yet). One outside the folder that isn't
   *  capcomd's own copy is in `outside` too. */
  client: Array<{ from: string; specifier: string; resolved: string | null }>;
  /** How many modules were read. */
  modules: number;
}

const CODE = /\.(?:[cm]?[jt]sx?)$/i;
const MAX_MODULES = 10_000;

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
/** `path` is `root` or under it (both real, or both as written). */
const within = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
/** The module a runtime runs for a path: the file itself, else as Bun resolves it (a directory's package.json `main`
 *  or index, a name without its extension); null when there is none. */
const moduleAt = (p: string): string | null => {
  if (isFile(p)) return p;
  try { const r = Bun.resolveSync(p, dirname(p)); return isAbsolute(r) && isFile(r) ? r : null; } catch { return null; }
};

/** Where a path that may not exist yet leads: its nearest existing ancestor made real, the rest as written. */
function lead(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return real(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(lead(parent), abs.slice(parent.length + 1));
}

const isClient = (s: string) => s === CLIENT_PACKAGE || s.startsWith(`${CLIENT_PACKAGE}/`);
const isRuntimeBuiltin = (s: string) => s === "bun" || s.startsWith("bun:") || s.startsWith("node:") || isBuiltin(s);
const isPathSpecifier = (s: string) => s.startsWith("./") || s.startsWith("../") || s === "." || s === ".." || isAbsolute(s) || s.startsWith("file:");

const loaderOf = (file: string): "ts" | "tsx" | "js" | "jsx" => {
  const e = extname(file).toLowerCase();
  return e === ".tsx" ? "tsx" : e === ".jsx" ? "jsx" : /^\.[cm]?ts$/.test(e) ? "ts" : "js";
};

/** The specifiers a module names statically: imports, re-exports, `require()` and `import()` of a literal. Throws
 *  when it can't be read (what can't be read can't be shown to stay inside). */
function importsOf(file: string): string[] {
  let code = readFileSync(file, "utf8");
  // A shebang is not JavaScript the transpiler takes.
  if (code.startsWith("#!")) code = `//${code.slice(2)}`;
  return new Bun.Transpiler({ loader: loaderOf(file) }).scanImports(code).map((i) => i.path);
}

/** Words of an options variable (NODE_OPTIONS, BUN_OPTIONS), quotes removed. */
const words = (s: string) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, "$2"));

/**
 * Whether the plugin at `dir` runs only code inside it (see the header). `dataDir` is where `${PLUGIN_DATA}` points
 * (outside the folder either way; a placeholder path will do).
 */
export function selfContained(dir: string, m: PluginManifest, o: { dataDir?: string } = {}): SelfContained {
  const root = real(dir);
  const out: SelfContained = { outside: [], unresolved: [], client: [], modules: 0 };
  const seen = new Set<string>();
  const queue: string[] = [];
  const label = (file: string) => relative(root, file).split("\\").join("/");
  const outside = (from: string, specifier: string, resolved: string) => {
    if (!out.outside.some((x) => x.from === from && x.specifier === specifier)) out.outside.push({ from, specifier, resolved });
  };
  const enqueue = (file: string) => {
    const r = real(file);
    if (!seen.has(r) && CODE.test(r) && isFile(r)) { seen.add(r); queue.push(r); }
  };
  const sub = (s: string) => s.replaceAll("${PLUGIN_ROOT}", dir).replaceAll("${PLUGIN_DATA}", o.dataDir ?? join(dirname(root), ".capcomd-plugin-data"));
  // A path a manifest names (relative ones from the folder, its cwd): inside, or outside with where it leads; the
  // module a runtime would run for it (`bun .` runs package.json's `main`) is followed, and must be inside too.
  const named = (from: string, raw: string, value: string) => {
    const to = lead(resolve(dir, value));
    if (!within(root, to)) return outside(from, raw, to);
    const mod = moduleAt(to);
    if (!mod) return;
    const r = real(mod);
    if (!within(root, r)) return outside(from, raw, r);
    enqueue(r);
  };
  // No shell runs the command: `~/x` is a directory named `~` in the folder, as the runtime reads it.
  const pathish = (s: string) => s.includes("/") || s === "..";
  const argument = (from: string, raw: string) => {
    const v = sub(raw);
    // A flag's value: `--require=../x.js`, `--preload=/abs/x.ts`.
    const flag = /^--?[^=\s]+=(.*)$/.exec(v);
    if (flag) { if (pathish(flag[1]!)) named(from, raw, flag[1]!); return; }
    if (v.startsWith("-")) return;
    if (pathish(v) || moduleAt(resolve(dir, v))) named(from, raw, v);
  };

  if (m.entry.runtime === "in-process") named("entry.module", m.entry.module, m.entry.module);
  else {
    m.entry.command.forEach((raw, i) => {
      // The program a bare name starts (bun, node, python3) is the runtime on the PATH, not the plugin's code.
      if (i === 0 && !pathish(sub(raw))) return;
      argument(`entry.command.${i}`, raw);
    });
    const env = m.entry.env ?? {};
    if (env.NODE_PATH !== undefined) for (const p of sub(env.NODE_PATH).split(":").filter(Boolean)) named("entry.env.NODE_PATH", env.NODE_PATH, p);
    for (const k of ["NODE_OPTIONS", "BUN_OPTIONS"] as const) if (env[k] !== undefined) for (const w of words(env[k]!)) argument(`entry.env.${k}`, w);
  }
  // Bun reads bunfig.toml from its cwd, the folder: a preload there is code it runs first.
  const bunfig = join(root, "bunfig.toml");
  if (isFile(bunfig)) {
    let parsed: Record<string, unknown> = {};
    try { parsed = Bun.TOML.parse(readFileSync(bunfig, "utf8")) as Record<string, unknown>; } catch { /* Bun refuses it too */ }
    const preloads = [parsed.preload, (parsed.run as { preload?: unknown } | undefined)?.preload].flatMap((p) => (Array.isArray(p) ? p : typeof p === "string" ? [p] : []));
    for (const p of preloads) if (typeof p === "string") named("bunfig.toml", p, p);
  }

  while (queue.length) {
    const file = queue.shift()!;
    const from = label(file);
    if (++out.modules > MAX_MODULES) { outside(from, "(more modules)", `more than ${MAX_MODULES} modules to check`); break; }
    let specs: string[];
    try { specs = importsOf(file); } catch (e) { outside(from, "(unreadable)", (e as Error).message.split("\n")[0]!.slice(0, 200)); continue; }
    for (const spec of specs) {
      if (isRuntimeBuiltin(spec)) continue;
      if (isClient(spec)) {
        let to: string | null = null;
        try { to = real(Bun.resolveSync(spec, dirname(file))); } catch { /* not installed here */ }
        if (!out.client.some((c) => c.from === from && c.specifier === spec)) out.client.push({ from, specifier: spec, resolved: to });
        // capcomd's own copy is the kernel's to vouch for; one inside the folder is checked below like any module.
        if (to === null || (KERNEL_CLIENT && within(KERNEL_CLIENT, to))) continue;
      }
      let resolved: string;
      try { resolved = Bun.resolveSync(spec, dirname(file)); } catch {
        // A relative or absolute specifier that leaves the folder is outside even when nothing is there.
        if (isPathSpecifier(spec)) {
          const target = spec.startsWith("file:") ? (() => { try { return fileURLToPath(spec); } catch { return spec; } })() : resolve(dirname(file), spec);
          const to = lead(target);
          if (!within(root, to)) { outside(from, spec, to); continue; }
        }
        if (!out.unresolved.some((u) => u.from === from && u.specifier === spec)) out.unresolved.push({ from, specifier: spec });
        continue;
      }
      if (!isAbsolute(resolved)) continue;
      const to = real(resolved);
      if (!within(root, to)) { outside(from, spec, to); continue; }
      enqueue(to);
    }
  }
  return out;
}

/** What `validate` lists (§4.9): each outside reference as an issue with its path, the rest as warnings. */
export function containedIssues(r: SelfContained, _dir?: string): { issues: ManifestIssue[]; warnings: ManifestIssue[] } {
  return {
    issues: r.outside.map((x) => ({
      path: x.from,
      message: x.specifier === "(more modules)" ? `${x.resolved}: the plugin can't be checked to be self-contained`
        : x.specifier === "(unreadable)" ? `can't be read to check what it imports (${x.resolved}): the plugin can't be checked to be self-contained`
        : `${x.specifier} resolves outside the plugin's folder: ${x.resolved}`,
    })),
    warnings: r.unresolved.map((u) => ({ path: u.from, message: `${u.specifier} resolves nowhere from here: if it ever does, it must be inside the plugin's folder` })),
  };
}

/** One line naming every outside reference, for an error. */
export const outsideText = (outside: OutsideRef[]) => outside.map((x) => `${x.from}: ${x.specifier} → ${x.resolved}`).join("; ");

/** The issues that refuse a third-party plugin (an empty list: it is self-contained). Never throws. */
export function containedRefusals(dir: string, m: PluginManifest, o: { dataDir?: string } = {}): ManifestIssue[] {
  try { return containedIssues(selfContained(dir, m, o), dir).issues; } catch (e) {
    return [{ path: "(plugin)", message: `the plugin can't be checked to be self-contained: ${(e as Error).message}` }];
  }
}
