// The runtime half of "a plugin is self-contained" (docs/spec/plugin-api.md §9.2, §11.6; src/plugins/contained.ts is
// the half that reads files before anything runs). A plugin's process gets a preload that refuses, as the module is
// loaded, any module that lies outside the plugin's folder (made real: a link that points out is outside), so what a
// static read can't see (a specifier computed at run time, a script that starts `bun ../lib/x.js`) is refused too:
//  - Bun reads BUN_OPTIONS: `--preload <guard>.mjs`, a Bun plugin whose `onLoad` filter matches every path outside the
//    allowed directories and throws;
//  - Node reads NODE_OPTIONS: `--require <guard>.cjs`, a resolve hook (`module.registerHooks`; on a Node without it, the
//    CommonJS resolver and an ES module `resolve` hook through `module.register`) that throws.
// Allowed: the folder; and the client library `@capcomd/plugin` where it resolves from the folder (its node_modules up
// the tree, or the package itself), with its dependencies. Each guard takes its own option back out of the variable,
// so a program the plugin starts (a tool on the PATH) runs without it. It is a guardrail for a process running as the
// same user, not a boundary: another runtime (Python, a binary, Deno), an old Bun that doesn't read BUN_OPTIONS, a guard
// path holding whitespace (BUN_OPTIONS can't carry one: no Bun guard then) or a process that clears the hooks aren't held.
// The guards are written by the daemon under <state>/plugins/.guard/ (named by their content), never read from the
// package (the single executable has no files of its own).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Shared by both guards: the directories a plugin's process may load modules from. */
const ALLOWED = String.raw`
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
/** The package \`name\` as it resolves from \`from\`: the package itself (a self-reference), or node_modules up the tree. */
function packageDir(name, from) {
  for (let d = from; ; d = dirname(d)) {
    try { if (JSON.parse(readFileSync(join(d, "package.json"), "utf8")).name === name) return real(d); } catch {}
    const p = join(d, "node_modules", name);
    if (existsSync(join(p, "package.json"))) return real(p);
    if (dirname(d) === d) return null;
  }
}
function allowedDirs(root) {
  const dirs = [root];
  const client = packageDir("@capcomd/plugin", root);
  if (client) {
    dirs.push(client);
    let deps = [];
    try { deps = Object.keys(JSON.parse(readFileSync(join(client, "package.json"), "utf8")).dependencies || {}); } catch {}
    for (const dep of deps) { const d = packageDir(dep, client); if (d) dirs.push(d); }
  }
  return dirs;
}
/** Both guards' options come back out of the environment (the one that runs, and the other runtime's), so what the
 *  plugin starts doesn't carry them: each is the leading option of its variable, naming a file beside this one. */
function dropGuards(own) {
  const here = real(dirname(own));
  for (const [name, re] of [["BUN_OPTIONS", /^--preload (\S+)\s*/], ["NODE_OPTIONS", /^--require (?:"([^"]+)"|(\S+))\s*/]]) {
    const opts = process.env[name] || "";
    const m = re.exec(opts);
    if (!m || real(dirname(m[1] || m[2])) !== here) continue;
    const rest = opts.slice(m[0].length);
    if (rest) process.env[name] = rest; else delete process.env[name];
  }
}
const outsideError = (what, root) => Object.assign(new Error("capcomd: " + what + " is outside the plugin's folder (" + root + "): a plugin must be self-contained (its own files and node_modules)"), { code: "ERR_CAPCOMD_PLUGIN_OUTSIDE" });
`;

/** Bun's guard: an `onLoad` that matches every path outside the allowed directories. */
export const BUN_GUARD = String.raw`// capcomd's runtime guard for a plugin's Bun process (written by the daemon: src/plugins/guard.ts). Do not edit.
import { plugin } from "bun";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
${ALLOWED}
dropGuards(import.meta.path);
if (process.env.CAPCOMD_PLUGIN_ROOT) {
  const root = real(process.env.CAPCOMD_PLUGIN_ROOT);
  const esc = (s) => s.replace(/[.*+?^${"$"}{}()|[\]\\]/g, "\\$&");
  const filter = new RegExp("^(?!(?:" + allowedDirs(root).map((d) => esc(d) + "/").join("|") + "))");
  plugin({ name: "capcomd-plugin-guard", setup(build) { build.onLoad({ filter }, (args) => { throw outsideError(args.path, root); }); } });
}
`;

/** Node's guard (CommonJS, for `--require`). */
export const NODE_GUARD = String.raw`// capcomd's runtime guard for a plugin's Node process (written by the daemon: src/plugins/guard.ts). Do not edit.
"use strict";
const Module = require("node:module");
const { existsSync, readFileSync, realpathSync } = require("node:fs");
const { dirname, isAbsolute, join } = require("node:path");
const { fileURLToPath } = require("node:url");
${ALLOWED}
(() => {
  dropGuards(__filename);
  if (!process.env.CAPCOMD_PLUGIN_ROOT) return;
  const root = real(process.env.CAPCOMD_PLUGIN_ROOT);
  const dirs = allowedDirs(root);
  const ok = (file) => { const r = real(file); return dirs.some((d) => r === d || r.startsWith(d + "/")); };
  const check = (spec, url) => {
    if (typeof url !== "string" || !url.startsWith("file:")) return;
    const file = fileURLToPath(url);
    if (!ok(file)) throw outsideError(spec + " (" + real(file) + ")", root);
  };
  if (typeof Module.registerHooks === "function") {
    Module.registerHooks({ resolve(spec, context, next) { const r = next(spec, context); check(spec, r && r.url); return r; } });
    return;
  }
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    const file = resolveFilename.call(this, request, parent, isMain, options);
    if (isAbsolute(file) && !ok(file)) throw outsideError(request + " (" + real(file) + ")", root);
    return file;
  };
  if (typeof Module.register === "function") {
    const hooks = "import { realpathSync } from 'node:fs'; import { fileURLToPath } from 'node:url';\n" +
      "const dirs = " + JSON.stringify(dirs) + "; const root = " + JSON.stringify(root) + ";\n" +
      "const real = (p) => { try { return realpathSync(p); } catch { return p; } };\n" +
      "export async function resolve(spec, context, next) { const r = await next(spec, context);\n" +
      "  if (r && typeof r.url === 'string' && r.url.startsWith('file:')) { const f = real(fileURLToPath(r.url));\n" +
      "    if (!dirs.some((d) => f === d || f.startsWith(d + '/'))) throw Object.assign(new Error('capcomd: ' + spec + ' (' + f + ') is outside the plugin\\'s folder (' + root + '): a plugin must be self-contained (its own files and node_modules)'), { code: 'ERR_CAPCOMD_PLUGIN_OUTSIDE' }); }\n" +
      "  return r; }\n";
    Module.register("data:text/javascript," + encodeURIComponent(hooks));
  }
})();
`;

export interface GuardFiles { bun: string | null; node: string }

function put(dir: string, name: string, text: string): string {
  const file = join(dir, name);
  try { if (readFileSync(file, "utf8") === text) return realpathSync(file); } catch { /* not written yet */ }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  return realpathSync(file);
}

/** Write the guards under `plugins` (<state>/plugins) and return their real paths; null when they can't be written. */
export function guardFiles(plugins: string): GuardFiles | null {
  try {
    const dir = join(plugins, ".guard");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tag = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
    const bun = put(dir, `bun-${tag(BUN_GUARD)}.mjs`, BUN_GUARD);
    const node = put(dir, `node-${tag(NODE_GUARD)}.cjs`, NODE_GUARD);
    return { bun: /\s/.test(bun) ? null : bun, node };
  } catch { return null; }
}

/** The guards' options ahead of the manifest's own BUN_OPTIONS and NODE_OPTIONS (§9.2): capcomd's variables win. */
export function guardEnv(env: Record<string, string>, files: GuardFiles): Record<string, string> {
  const join2 = (a: string, b: string | undefined) => (b ? `${a} ${b}` : a);
  return {
    ...env,
    ...(files.bun ? { BUN_OPTIONS: join2(`--preload ${files.bun}`, env.BUN_OPTIONS) } : {}),
    NODE_OPTIONS: join2(`--require ${JSON.stringify(files.node)}`, env.NODE_OPTIONS),
  };
}
