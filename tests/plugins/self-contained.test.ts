// A third-party plugin is self-contained (plugin API §4.8, §4.9, §9.2, §11.6; ADR-023 §9 decision 7, 2026-11-08): what
// it runs lies inside its own folder, where its LOCK and its trust hash see it. src/plugins/contained.ts reads the
// entry, the manifest's environment, bunfig.toml and every module they reach, made real; install, trust, validate and
// the host (when it validates the plugin, and before each start) refuse a plugin that reaches outside, naming each path.
// src/plugins/guard.ts refuses it again in the running process (Bun and Node), for what no static read can see.
import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayError } from "../../src/core/errors";
import { Git } from "../../src/merge/git";
import { containedIssues, selfContained } from "../../src/plugins/contained";
import { guardFiles } from "../../src/plugins/guard";
import { kernelHost } from "../../src/plugins/host";
import { installPlugin, projectPluginList, trustPlugin } from "../../src/plugins/install";
import { pluginEnv } from "../../src/plugins/process";
import { loadManifest } from "../../packages/plugin/src/load";
import type { PluginManifest } from "../../packages/plugin/src/manifest";

const home = process.env.CAPCOMD_HOME!;
const ROOT = join(import.meta.dir, "..", "..");
const manifest = (name: string, entry: Record<string, unknown> = { runtime: "process", command: ["bun", "${PLUGIN_ROOT}/main.ts"] }) => ({
  schema: "capcomd.plugin/v1", name, version: "1.0.0", description: `${name}, a fixture`, apiVersion: 1, engines: { capcomd: ">=0.0.0" },
  entry, scopes: ["read"], contributes: { hooks: { "run.changed": {} } },
});
const parsed = (m: unknown): PluginManifest => { const r = loadManifest(m); if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.manifest; };

/** Files under a fresh, real temp directory: a string is a file, `{ link }` a symlink. Returns the directory. */
function tree(files: Record<string, string | { link: string }>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "capcomd-contained-")));
  for (const [p, body] of Object.entries(files)) {
    const to = join(root, p);
    mkdirSync(join(to, ".."), { recursive: true });
    if (typeof body === "string") writeFileSync(to, body); else symlinkSync(body.link, to);
  }
  return root;
}
/** `p/` is the plugin; everything else in the tree is outside it. */
function plugin(files: Record<string, string | { link: string }>, m: object = manifest("pp")) {
  const root = tree({ "p/plugin.json": JSON.stringify(m), ...files });
  return { root, dir: join(root, "p"), manifest: parsed(m) };
}

describe("what the check reads (src/plugins/contained.ts)", () => {
  test("an import of ../lib is outside, named with the file that imports it and the real path", () => {
    const p = plugin({ "lib/x.ts": "export const x = 1;\n", "p/main.ts": 'import { x } from "../lib/x";\nconsole.log(x);\n' });
    const r = selfContained(p.dir, p.manifest);
    expect(r.outside).toEqual([{ from: "main.ts", specifier: "../lib/x", resolved: join(p.root, "lib", "x.ts") }]);
    expect(containedIssues(r, p.dir).issues).toEqual([{ path: "main.ts", message: `../lib/x resolves outside the plugin's folder: ${join(p.root, "lib", "x.ts")}` }]);
  });

  test("followed through the plugin's own modules, require() and import() of a literal; a type-only import runs nothing", () => {
    const p = plugin({
      "lib/a.cjs": "module.exports = 1;\n", "lib/b.mjs": "export default 2;\n", "lib/types.ts": "export type T = number;\n",
      "p/main.ts": 'import type { T } from "../lib/types";\nimport "./src/deep";\nexport const t: T = 1;\n',
      "p/src/deep.ts": 'const a = require("../../lib/a.cjs");\nconst b = await import("../../lib/b.mjs");\nconsole.log(a, b);\n',
    });
    expect(selfContained(p.dir, p.manifest).outside.map((o) => [o.from, o.specifier])).toEqual([["src/deep.ts", "../../lib/a.cjs"], ["src/deep.ts", "../../lib/b.mjs"]]);
  });

  test("a link that points out is outside: a linked directory, and a node_modules package that is a link out", () => {
    const p = plugin({
      "lib/x.ts": "export const x = 1;\n", "ext/dep/package.json": '{"name":"dep","main":"index.js"}', "ext/dep/index.js": "module.exports = 1;\n",
      "p/vendor": { link: "../lib" }, "p/node_modules/dep": { link: "../../ext/dep" },
      "p/main.ts": 'import { x } from "./vendor/x";\nimport dep from "dep";\nconsole.log(x, dep);\n',
    });
    expect(selfContained(p.dir, p.manifest).outside).toEqual([
      { from: "main.ts", specifier: "./vendor/x", resolved: join(p.root, "lib", "x.ts") },
      { from: "main.ts", specifier: "dep", resolved: join(p.root, "ext", "dep", "index.js") },
    ]);
  });

  test("its own node_modules, Node and Bun built-ins and the client library are fine; a parent node_modules is not", () => {
    const own = plugin({
      "p/node_modules/dep/package.json": '{"name":"dep","main":"index.js"}', "p/node_modules/dep/index.js": 'module.exports = require("./more");\n', "p/node_modules/dep/more.js": "module.exports = 1;\n",
      "p/main.ts": 'import dep from "dep";\nimport { readFileSync } from "node:fs";\nimport path from "path";\nimport { connect } from "@capcomd/plugin";\nimport { Database } from "bun:sqlite";\nconsole.log(dep, readFileSync, path, connect, Database);\n',
    });
    const r = selfContained(own.dir, own.manifest);
    expect(r.outside).toEqual([]);
    expect(r.client).toEqual([{ from: "main.ts", specifier: "@capcomd/plugin", resolved: null }]);
    expect(r.modules).toBe(3);
    const parent = plugin({ "node_modules/leftpad/package.json": '{"name":"leftpad","main":"i.js"}', "node_modules/leftpad/i.js": "module.exports = 1;\n", "p/main.ts": 'import l from "leftpad";\nconsole.log(l);\n' });
    expect(selfContained(parent.dir, parent.manifest).outside).toEqual([{ from: "main.ts", specifier: "leftpad", resolved: join(parent.root, "node_modules", "leftpad", "i.js") }]);
  });

  test("a relative import that leaves the folder is outside even with nothing there; a bare one that resolves nowhere is a warning", () => {
    const p = plugin({ "p/main.ts": 'import "../gone/x.js";\ntry { require("fsevents-not-installed"); } catch {}\n' });
    const r = selfContained(p.dir, p.manifest);
    expect(r.outside).toEqual([{ from: "main.ts", specifier: "../gone/x.js", resolved: join(p.root, "gone", "x.js") }]);
    expect(r.unresolved).toEqual([{ from: "main.ts", specifier: "fsevents-not-installed" }]);
    expect(containedIssues(r, p.dir).warnings.map((w) => w.path)).toEqual(["main.ts"]);
  });

  test("the command, the manifest's NODE_PATH, NODE_OPTIONS and BUN_OPTIONS, and bunfig.toml's preload", () => {
    const lib = { "lib/x.ts": "export {};\n", "p/main.ts": "export {};\n" };
    const outside = (entry: Record<string, unknown>, more: Record<string, string> = {}) => {
      const p = plugin({ ...lib, ...more }, manifest("pp", entry));
      return selfContained(p.dir, p.manifest, { dataDir: join(p.root, "data") }).outside.map((o) => [o.from, o.specifier, o.resolved.slice(p.root.length)]);
    };
    expect(outside({ runtime: "process", command: ["bun", "../lib/x.ts"] })).toEqual([["entry.command.1", "../lib/x.ts", "/lib/x.ts"]]);
    expect(outside({ runtime: "process", command: ["node", "${PLUGIN_DATA}/x.js"] })).toEqual([["entry.command.1", "${PLUGIN_DATA}/x.js", "/data/x.js"]]);
    expect(outside({ runtime: "process", command: ["bun", "--preload=../lib/x.ts", "main.ts"] })).toEqual([["entry.command.1", "--preload=../lib/x.ts", "/lib/x.ts"]]);
    expect(outside({ runtime: "process", command: ["bun", "main.ts"], env: { NODE_PATH: "${PLUGIN_ROOT}/vendor:../lib" } })).toEqual([["entry.env.NODE_PATH", "${PLUGIN_ROOT}/vendor:../lib", "/lib"]]);
    expect(outside({ runtime: "process", command: ["node", "main.js"], env: { NODE_OPTIONS: '--max-old-space-size=512 --require "../lib/x.ts"' } })).toEqual([["entry.env.NODE_OPTIONS", "../lib/x.ts", "/lib/x.ts"]]);
    expect(outside({ runtime: "process", command: ["bun", "main.ts"] }, { "p/bunfig.toml": 'preload = ["./ok.ts", "../lib/x.ts"]\n' })).toEqual([["bunfig.toml", "../lib/x.ts", "/lib/x.ts"]]);
    // A runtime by its name is the PATH's; by a path, it is a program outside the folder.
    expect(outside({ runtime: "process", command: ["bun", "${PLUGIN_ROOT}/main.ts", "--flag", "1"] })).toEqual([]);
    expect(outside({ runtime: "process", command: ["/usr/bin/env", "bun", "main.ts"] }).map((o) => o[0])).toEqual(["entry.command.0"]);
  });

  test("a module that can't be read can't be shown to stay inside: refused", () => {
    const p = plugin({ "p/main.ts": 'import { x from "../lib/x";\n' });
    const r = selfContained(p.dir, p.manifest);
    expect(r.outside.map((o) => [o.from, o.specifier])).toEqual([["main.ts", "(unreadable)"]]);
    expect(containedIssues(r, p.dir).issues[0]!.message).toContain("can't be read to check what it imports");
  });

  test("the entry's own imports are followed from the command", () => {
    const p = plugin({ "lib/x.ts": "export {};\n", "p/dist/index.js": 'import "../../lib/x.ts";\n' }, manifest("pp", { runtime: "process", command: ["node", "dist/index.js"] }));
    expect(selfContained(p.dir, p.manifest).outside.map((o) => o.from)).toEqual(["dist/index.js"]);
  });
});

describe("refused at install, trust and load, with the path named", () => {
  beforeEach(() => { rmSync(join(home, "trust.json"), { force: true }); rmSync(join(home, "plugins"), { recursive: true, force: true }); });

  /** A project checkout whose own plugin `pp` (.capcomd/plugins/pp) has `files`. */
  function project(files: Record<string, string | { link: string }>) {
    const dir = tree({ ".capcomd/config.json": "{}\n", ".capcomd/plugins/pp/plugin.json": JSON.stringify(manifest("pp")), ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k.startsWith("/") ? k.slice(1) : `.capcomd/plugins/pp/${k}`, v])) });
    return { dir, plugin: join(dir, ".capcomd", "plugins", "pp") };
  }
  const env = () => ({ ...process.env, CAPCOMD_NO_CONFIG: "" });

  test("trust: an import of ../lib is refused, naming the file and the path; nothing is recorded", () => {
    const p = project({ "/lib/x.ts": "export const x = 1;\n", "main.ts": 'import { x } from "../../../lib/x";\nconsole.log(x);\n' });
    const listed = projectPluginList(p.dir, env()).find((x) => x.name === "pp")!;
    expect(listed.outside).toEqual([{ from: "main.ts", specifier: "../../../lib/x", resolved: join(p.dir, "lib", "x.ts") }]);
    expect(listed.issues).toContain(`main.ts: ../../../lib/x resolves outside the plugin's folder: ${join(p.dir, "lib", "x.ts")}`);
    let err: unknown;
    try { trustPlugin("pp", { project: p.dir, env: env() }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).message).toContain(`main.ts: ../../../lib/x → ${join(p.dir, "lib", "x.ts")}`);
    expect((err as RelayError).reason).toBe("not_self_contained");
    expect(projectPluginList(p.dir, env()).find((x) => x.name === "pp")!.trust).toBe("untrusted");
  });

  test("trust: a link that points out of the folder is refused", () => {
    const p = project({ "/shared/x.ts": "export const x = 1;\n", "vendor": { link: "../../../shared" }, "main.ts": 'import { x } from "./vendor/x";\nconsole.log(x);\n' });
    // Its hash refuses the link too (src/install/lock.ts); the message names the import that reaches through it.
    expect(() => trustPlugin("pp", { project: p.dir, env: env() })).toThrow(`main.ts: ./vendor/x resolves outside the plugin's folder: ${join(p.dir, "shared", "x.ts")}`);
  });

  test("trust: a plugin with its own node_modules is trusted", () => {
    const p = project({ "node_modules/dep/package.json": '{"name":"dep","main":"index.js"}', "node_modules/dep/index.js": "module.exports = 1;\n", "main.ts": 'import dep from "dep";\nconsole.log(dep);\n' });
    expect(trustPlugin("pp", { project: p.dir, env: env() })).toMatchObject({ name: "pp", trust: "trusted", outside: [] });
  });

  test("install: a repository's plugin that imports ../lib is refused, and nothing is installed", async () => {
    const root = mkdtempSync(join(tmpdir(), "capcomd-contained-repo-"));
    const work = join(root, "work");
    mkdirSync(join(work, "plugins", "reacher"), { recursive: true });
    mkdirSync(join(work, "lib"));
    writeFileSync(join(work, "lib", "x.ts"), "export const x = 1;\n");
    writeFileSync(join(work, "plugins", "reacher", "plugin.json"), JSON.stringify(manifest("reacher")));
    writeFileSync(join(work, "plugins", "reacher", "main.ts"), 'import { x } from "../../lib/x";\nconsole.log(x);\n');
    const g = new Git(work);
    await g.ok(["init", "-q", "-b", "main"]);
    await g.ok(["add", "-A"]);
    await g.ok(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "first"]);
    try {
      // Only the plugin's directory is fetched: ../../lib isn't there, and is outside whether or not it is.
      await expect(installPlugin(`${work}#reacher`, { env: process.env })).rejects.toThrow(/reacher runs code from outside its folder, which its hash doesn't cover: main\.ts: \.\.\/\.\.\/lib\/x → /);
      expect(() => readFileSync(join(home, "plugins", "reacher", "plugin.json"))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("load: the host fails a user's plugin that imports ../lib (untrusted), with the path in its message; a self-contained one validates", async () => {
    const bad = plugin({ "lib/x.ts": "export const x = 1;\n", "p/main.ts": 'import { x } from "../lib/x";\nconsole.log(x);\n' }, manifest("reacher"));
    const good = plugin({ "p/main.ts": 'import { readFileSync } from "node:fs";\nconsole.log(readFileSync);\n' }, manifest("homebody"));
    const events: Array<{ type: string; data: Record<string, any> }> = [];
    const host = kernelHost({ log: false, record: (e) => { events.push(e); return { seq: events.length }; } });
    await host.start([{ source: "user", dir: bad.dir }, { source: "user", dir: good.dir }]);
    const [r, h] = host.list();
    expect(r).toMatchObject({ name: "reacher", state: "failed", cause: "untrusted" });
    expect(events.find((e) => e.type === "plugin.failed" && e.data.plugin === "reacher")!.data.message).toContain(`main.ts: ../lib/x resolves outside the plugin's folder: ${join(bad.root, "lib", "x.ts")}`);
    // Without a launcher (this host is a CLI's) the self-contained one stays validated, never failed.
    expect(h).toMatchObject({ name: "homebody", state: "validated", cause: null });
    await host.stop();
  });
});

describe("validate lists each outside import (capcomd plugins validate)", () => {
  test("an issue per path, with the file that names it, and `outside` in --json; exit 1", () => {
    const p = plugin({ "lib/x.ts": "export {};\n", "p/main.ts": 'import "../lib/x";\nimport "./more";\n', "p/more.ts": 'export * from "../lib/x.ts";\n' });
    const r = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli", "index.ts"), "plugins", "validate", p.dir, "--json"], { env: { ...process.env, CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    const j = JSON.parse(r.stdout.toString().trim().split("\n").pop()!);
    const v = j.plugins[0];
    expect(v.ok).toBe(false);
    expect(v.issues).toEqual([
      { path: "main.ts", message: `../lib/x resolves outside the plugin's folder: ${join(p.root, "lib", "x.ts")}` },
      { path: "more.ts", message: `../lib/x.ts resolves outside the plugin's folder: ${join(p.root, "lib", "x.ts")}` },
    ]);
    expect(v.outside.map((o: { from: string }) => o.from)).toEqual(["main.ts", "more.ts"]);
    const text = Bun.spawnSync([process.execPath, join(ROOT, "src", "cli", "index.ts"), "plugins", "validate", p.dir], { env: { ...process.env, CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1" }, stdout: "pipe" }).stdout.toString();
    expect(text).toContain(`✗ main.ts: ../lib/x resolves outside the plugin's folder: ${join(p.root, "lib", "x.ts")}`);
  });
});

describe("the runtime guard (src/plugins/guard.ts)", () => {
  /** Run `argv` as the daemon starts a plugin at `dir` (its environment, the guard's options), returning its output. */
  function run(dir: string, argv: string[], entryEnv?: Record<string, string>) {
    const g = guardFiles(join(home, "state", "plugins"));
    expect(g).not.toBeNull();
    const env = pluginEnv({ name: "pp", root: dir, dataDir: join(home, "state", "plugins", "pp"), socket: "/nonexistent.sock", session: "s", token: "t", guard: g, ...(entryEnv ? { entryEnv } : {}) });
    const r = spawnSync(argv[0]!, argv.slice(1), { cwd: dir, env, encoding: "utf8", timeout: 30_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }
  // A path computed at run time: no static read sees it.
  const sneaky = 'const p = ["..", "lib", "x"].join("/") + ".mjs";\nconst m = await import(p);\nconsole.log("loaded", m.x);\n';

  test("Bun: a module outside the folder is refused as it loads; one inside, its own node_modules and the client library load; the guard leaves the environment", () => {
    const p = plugin({
      "lib/x.mjs": "export const x = 1;\n",
      "p/node_modules/dep/package.json": '{"name":"dep","main":"index.js"}', "p/node_modules/dep/index.js": "module.exports = 7;\n",
      "p/ok.ts": 'import dep from "dep";\nimport { connect } from "@capcomd/plugin/client";\nconsole.log("ok", dep, typeof connect, process.env.BUN_OPTIONS ?? "-", process.env.NODE_OPTIONS ?? "-");\n',
      "p/sneaky.ts": sneaky, "p/linked": { link: "../lib" }, "p/via-link.ts": 'const m = await import("./linked/" + "x.mjs");\nconsole.log(m.x);\n',
    });
    // The client library as an author installs it, in the folder's node_modules (here a link to this checkout's).
    mkdirSync(join(p.dir, "node_modules", "@capcomd"), { recursive: true });
    symlinkSync(join(ROOT, "packages", "plugin"), join(p.dir, "node_modules", "@capcomd", "plugin"));
    const ok = run(p.dir, ["bun", "ok.ts"]);
    expect(ok.err).toBe("");
    expect(ok.out.trim()).toBe("ok 7 function - -");
    for (const f of ["sneaky.ts", "via-link.ts"]) {
      const r = run(p.dir, ["bun", f]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(`capcomd: ${join(p.root, "lib", "x.mjs")} is outside the plugin's folder (${p.dir})`);
      expect(r.out).not.toContain("loaded");
    }
    // The manifest's own BUN_OPTIONS stays, after the guard's.
    const own = run(p.dir, ["bun", "-e", "console.log(process.env.BUN_OPTIONS)"], { BUN_OPTIONS: "--smol" });
    expect(own.out.trim()).toBe("--smol");
  });

  const node = spawnSync("node", ["--version"], { encoding: "utf8" });
  test.skipIf(node.status !== 0)("Node: an ES module or CommonJS module outside the folder is refused; inside ones load", () => {
    const p = plugin({
      "lib/x.mjs": "export const x = 1;\n", "lib/y.cjs": "module.exports = 2;\n",
      "p/node_modules/dep/package.json": '{"name":"dep","main":"index.js"}', "p/node_modules/dep/index.js": "module.exports = 7;\n",
      "p/ok.mjs": 'import dep from "dep";\nconsole.log("ok", dep, process.env.NODE_OPTIONS ?? "-");\n',
      "p/sneaky.mjs": sneaky, "p/sneaky.cjs": 'const p = ["..", "lib", "y"].join("/") + ".cjs";\nconsole.log("loaded", require(p));\n',
    });
    expect(run(p.dir, ["node", "ok.mjs"]).out.trim()).toBe("ok 7 -");
    for (const f of ["sneaky.mjs", "sneaky.cjs"]) {
      const r = run(p.dir, ["node", f]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("is outside the plugin's folder");
      expect(r.out).not.toContain("loaded");
    }
  });

  test.skipIf(node.status !== 0)("Node without module.registerHooks: the CommonJS resolver and module.register hold it", () => {
    const p = plugin({ "lib/x.mjs": "export const x = 1;\n", "lib/y.cjs": "module.exports = 2;\n", "p/sneaky.mjs": sneaky, "p/sneaky.cjs": 'const p = ["..", "lib", "y"].join("/") + ".cjs";\nconsole.log("loaded", require(p));\n', "p/fine.cjs": 'console.log("fine", require("node:path").sep);\n' });
    // A preload ahead of the guard takes registerHooks away, as an older Node doesn't have it.
    const old = join(p.root, "old-node.cjs");
    writeFileSync(old, 'delete require("node:module").registerHooks;\n');
    const g = guardFiles(join(home, "state", "plugins"))!;
    const runOld = (f: string) => spawnSync("node", ["--require", old, "--require", g.node, f], { cwd: p.dir, env: { PATH: process.env.PATH, CAPCOMD_PLUGIN_ROOT: p.dir }, encoding: "utf8" });
    expect(runOld("fine.cjs").stdout.trim()).toBe("fine /");
    for (const f of ["sneaky.mjs", "sneaky.cjs"]) {
      const r = runOld(f);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("is outside the plugin's folder");
    }
  });
});
