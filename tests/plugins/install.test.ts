// Plugin API §4.4, §4.8, §17.2 step 12: installing a plugin from a git repository (a local fixture repository, the
// tests/merge/gitfixture.ts pattern), its LOCK, `update` reporting a changed hash, `remove`, `allow-version`, and the
// refusals: a manifest that escapes its directory, a link out of the package, an in-process plugin, a built-in's name.
import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git } from "../../src/merge/git";
import { RelayError } from "../../src/core/errors";
import { allowVersion, installPlugin, isExempt, removePlugin, updatePlugin, userPluginsDir } from "../../src/plugins/install";
import { diffTrees, hashTree, lockState, readLock, TreeError } from "../../src/install/lock";
import { parseSource } from "../../src/install/source";
import { recordTrust, trustState } from "../../src/install/trust";
import { kernelHost, userPlugins } from "../../src/plugins/host";

const home = process.env.CAPCOMD_HOME!;
const manifest = (name: string, o: Record<string, unknown> = {}) => ({
  schema: "capcomd.plugin/v1", name, version: "1.0.0", description: `${name}, a fixture`, apiVersion: 1, engines: { capcomd: ">=0.0.0" },
  entry: { runtime: "process", command: ["./run.sh"] }, scopes: ["read"], contributes: { hooks: { "run.changed": {} } }, ...o,
});

/** A bare repository holding plugin packages (a local "git server"), and a clone to commit to it from. */
async function pluginRepo(files: Record<string, string | { link: string } | { exec: string }>) {
  const root = mkdtempSync(join(tmpdir(), "capcomd-plugin-repo-"));
  const bare = join(root, "plugins.git");
  mkdirSync(bare);
  await new Git(bare).ok(["init", "-q", "--bare", "-b", "main"]);
  const work = join(root, "work");
  mkdirSync(work);
  const g = new Git(work);
  await g.ok(["init", "-q", "-b", "main"]);
  await g.ok(["remote", "add", "origin", bare]);
  const write = async (fs: Record<string, string | { link: string } | { exec: string } | null>, msg: string) => {
    for (const [p, body] of Object.entries(fs)) {
      const to = join(work, p);
      rmSync(to, { force: true });
      if (body === null) continue;
      mkdirSync(join(to, ".."), { recursive: true });
      if (typeof body === "string") writeFileSync(to, body);
      else if ("link" in body) symlinkSync(body.link, to);
      else { writeFileSync(to, body.exec); chmodSync(to, 0o755); }
    }
    await g.ok(["add", "-A"]);
    await g.ok(["commit", "-q", "-m", msg]);
    await g.ok(["push", "-q", "origin", "HEAD:main"]);
    return g.ok(["rev-parse", "HEAD"]);
  };
  const first = await write(files, "first");
  return { bare, work, git: g, first, commit: (fs: Record<string, string | { link: string } | { exec: string } | null>, msg = "next") => write(fs, msg) };
}

const twoPlugins = () => ({
  "plugins/alpha/plugin.json": JSON.stringify(manifest("alpha")),
  "plugins/alpha/run.sh": { exec: "#!/bin/sh\nexec sleep 1\n" },
  "plugins/alpha/lib/util.txt": "util\n",
  "plugins/beta/plugin.json": JSON.stringify(manifest("beta")),
  "plugins/beta/run.sh": { exec: "#!/bin/sh\n" },
  "README.md": "two plugins\n",
});

const refused = async (p: Promise<unknown>, code: string, text: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(RelayError);
  expect((e as RelayError).code).toBe(code as never);
  expect(`${(e as Error).message} ${(e as RelayError).hint}`).toMatch(text);
};

beforeEach(() => { rmSync(join(home, "plugins"), { recursive: true, force: true }); rmSync(join(home, "trust.json"), { force: true }); });

describe("sources", () => {
  test("owner/repo, URLs and local paths, with #name and @ref", () => {
    expect(parseSource("acme/plugins#slack@v1.2")).toEqual({ spec: "acme/plugins#slack@v1.2", remote: "https://github.com/acme/plugins.git", name: "slack", ref: "v1.2" });
    expect(parseSource("acme/plugins")).toMatchObject({ remote: "https://github.com/acme/plugins.git", name: null, ref: null });
    expect(parseSource("git@github.com:acme/plugins.git#x")).toMatchObject({ remote: "git@github.com:acme/plugins.git", name: "x", ref: null });
    expect(parseSource("./repo.git#x@main", "/srv")).toMatchObject({ spec: "/srv/repo.git#x@main", remote: "/srv/repo.git", name: "x", ref: "main" });
    for (const bad of ["", "-x", "acme", "acme/plugins#Bad", "acme/plugins@..x", "ext::sh -c x", "a b/c"]) expect(() => parseSource(bad)).toThrow();
  });
});

describe("install", () => {
  test("from a local repository: the named plugin's files, its LOCK (source, commit, every file's sha256, the hash)", async () => {
    const repo = await pluginRepo(twoPlugins());
    const r = await installPlugin(`${repo.bare}#alpha@main`);
    const dir = join(userPluginsDir(), "alpha");
    expect(r).toMatchObject({ name: "alpha", version: "1.0.0", commit: repo.first, dir, source: `${repo.bare}#alpha@main`, project: null });
    expect(readFileSync(join(dir, "lib", "util.txt"), "utf8")).toBe("util\n");
    expect(statSync(join(dir, "run.sh")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(dir, "README.md"))).toBe(false);
    const lock = readLock(dir)!;
    expect(lock).toMatchObject({ kind: "plugin", name: "alpha", version: "1.0.0", source: `${repo.bare}#alpha@main`, remote: repo.bare, ref: "main", commit: repo.first, path: "plugins/alpha", hash: r.hash });
    expect(Object.keys(lock.files).sort()).toEqual(["lib/util.txt", "plugin.json", "run.sh"]);
    expect(lock.files["run.sh"]!.mode).toBe("100755");
    expect(hashTree(dir).hash).toBe(lock.hash);
    // The daemon discovers it (§4.8 step 2) and, without a launcher, lists it without running it.
    expect(userPlugins().map((c) => c.dir)).toEqual([dir]);
    // Installing it again is a conflict: update replaces one.
    await refused(installPlugin(`${repo.bare}#alpha`), "conflict", /already installed/);
  });

  test("a repository with several plugins needs #name; one with a root plugin.json installs that", async () => {
    const repo = await pluginRepo(twoPlugins());
    await refused(installPlugin(repo.bare), "run_failed", /several plugins: name one/);
    await refused(installPlugin(`${repo.bare}#gamma`), "run_failed", /no plugin named gamma \(it has alpha, beta\)/);
    const single = await pluginRepo({ "plugin.json": JSON.stringify(manifest("solo")), "run.sh": { exec: "#!/bin/sh\n" } });
    expect((await installPlugin(single.bare)).name).toBe("solo");
  });

  test("a manifest escaping its directory is refused, and nothing is installed", async () => {
    const out = await pluginRepo({
      "plugins/esc/plugin.json": JSON.stringify(manifest("esc", { entry: { runtime: "process", command: ["./../../evil.sh"] } })),
      "evil.sh": { exec: "#!/bin/sh\n" },
      "plugins/ref/plugin.json": JSON.stringify(manifest("ref", { config: { $ref: "../../secrets.json" } })),
      "plugins/ref/run.sh": { exec: "#!/bin/sh\n" },
      "secrets.json": "{}",
      "plugins/link/plugin.json": JSON.stringify(manifest("link")),
      "plugins/link/run.sh": { link: "../../evil.sh" },
    });
    await refused(installPlugin(`${out.bare}#esc`), "config", /entry\.command\.0: .*resolves outside the plugin's directory/);
    await refused(installPlugin(`${out.bare}#ref`), "config", /config\.\$ref: .*resolves outside the plugin's directory/);
    await refused(installPlugin(`${out.bare}#link`), "run_failed", /run\.sh links outside the package/);
    expect(existsSync(join(userPluginsDir(), "esc"))).toBe(false);
    expect(existsSync(join(userPluginsDir(), "ref"))).toBe(false);
    expect(existsSync(join(userPluginsDir(), "link"))).toBe(false);
    // No staging directory is left behind either.
    expect(existsSync(userPluginsDir()) ? (await import("node:fs")).readdirSync(userPluginsDir()).filter((n) => n.startsWith(".staging")) : []).toEqual([]);
  });

  test("paths that differ only in case never write through the package's own link (a case-insensitive filesystem)", async () => {
    // `p/q/D` links to `e` (inside); on macOS `p/q/d/X` then lands in `e/X`, and its target, inside when read from
    // `p/q/d`, is <home>/plugins from there: `p/q/d/x/backdoor/plugin.json` would plant a user's plugin no one trusted.
    const root = mkdtempSync(join(tmpdir(), "capcomd-plugin-alias-"));
    const g = new Git(root);
    await g.ok(["init", "-q", "-b", "main"]);
    const blob = (body: string) => spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: body, encoding: "utf8" }).stdout.trim();
    const add = (mode: string, body: string, path: string) => g.ok(["update-index", "--add", "--cacheinfo", `${mode},${blob(body)},${path}`]);
    await add("100644", JSON.stringify(manifest("alias")), "plugin.json");
    await add("100755", "#!/bin/sh\n", "run.sh");
    await add("100644", "keep\n", "e/keep");
    await add("120000", "../../e", "p/q/D");
    await add("120000", "../../../plugins", "p/q/d/X");
    await add("100644", JSON.stringify(manifest("backdoor")), "p/q/d/x/backdoor/plugin.json");
    await g.ok(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "alias"]);
    writeFileSync(join(root, "CaseProbe"), "");
    const folds = existsSync(join(root, "caseprobe"));
    const r = await installPlugin(root).then(() => null, (e) => e as RelayError);
    expect(existsSync(join(userPluginsDir(), "backdoor"))).toBe(false);
    if (folds) expect(r?.message).toMatch(/p\/q\/d\/X goes through a link of the package/);
    expect(existsSync(userPluginsDir()) ? readdirSync(userPluginsDir()).filter((n) => n.startsWith(".staging")) : []).toEqual([]);
  });

  test("an in-process plugin, a built-in's name and a bad manifest are refused", async () => {
    const repo = await pluginRepo({
      "a/plugin.json": JSON.stringify(manifest("inproc", { entry: { runtime: "in-process", module: "./index.ts" } })),
      "a/index.ts": "export const plugin = { activate() {} };\n",
      "b/plugin.json": JSON.stringify(manifest("gate-reviewer")),
      "b/run.sh": { exec: "#!/bin/sh\n" },
      "c/plugin.json": JSON.stringify({ ...manifest("bad"), scopes: ["approve"] }),
      "c/run.sh": { exec: "#!/bin/sh\n" },
    });
    await refused(installPlugin(`${repo.bare}#inproc`), "config", /runs in process: only capcomd's built-in plugins do/);
    await refused(installPlugin(`${repo.bare}#gate-reviewer`), "conflict", /one of capcomd's built-in plugins/);
    await refused(installPlugin(`${repo.bare}#bad`), "config", /manifest is refused: scopes/);
  });

  test("engines: an incompatible plugin is refused, unless that exact version is allowed (allow-version --accept-risk)", async () => {
    const repo = await pluginRepo({ "plugin.json": JSON.stringify(manifest("old", { version: "0.1.0", engines: { capcomd: "<0.0.1" } })), "run.sh": { exec: "#!/bin/sh\n" } });
    await refused(installPlugin(repo.bare), "config", /old@0\.1\.0 doesn't support capcomd .*allow-version old@0\.1\.0 --accept-risk/s);
    expect(() => allowVersion("old@0.1.0", { acceptRisk: false })).toThrow(/runs it on a capcomd it wasn.t tested with/);
    expect(() => allowVersion("old@^0.1", { acceptRisk: true })).toThrow(/not <name>@<version>/);
    allowVersion("old@0.1.0", { acceptRisk: true });
    expect(isExempt("old", "0.1.0")).toBe(true);
    expect(isExempt("old", "0.1.1")).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "plugins", "compatibility.json"), "utf8")).allow).toEqual([expect.objectContaining({ name: "old", version: "0.1.0" })]);
    expect((await installPlugin(repo.bare)).name).toBe("old");
    // The daemon's host honours the same exemption (§4.4): validated, not failed(incompatible).
    const host = kernelHost({ log: false });
    host.plan(userPlugins());
    expect(host.get("old")).toMatchObject({ state: "validated", cause: null });
  });
});

describe("update and remove", () => {
  test("update fetches again and reports the changed hash and files; --dry-run changes nothing", async () => {
    const repo = await pluginRepo(twoPlugins());
    const before = await installPlugin(`${repo.bare}#alpha`);
    const dir = join(userPluginsDir(), "alpha");
    // Nothing new: up to date.
    expect(await updatePlugin("alpha")).toMatchObject({ updated: false, added: [], removed: [], changed: [], modified: null, from: { hash: before.hash }, to: { hash: before.hash } });
    const next = await repo.commit({ "plugins/alpha/run.sh": { exec: "#!/bin/sh\nexec sleep 2\n" }, "plugins/alpha/new.txt": "new\n", "plugins/alpha/lib/util.txt": null, "plugins/alpha/plugin.json": JSON.stringify(manifest("alpha", { version: "1.1.0" })) });
    // A local edit since the install is reported too.
    writeFileSync(join(dir, "lib", "util.txt"), "edited\n");
    const dry = await updatePlugin("alpha", { dryRun: true });
    expect(dry).toMatchObject({ updated: false, changed: ["plugin.json", "run.sh"], added: ["new.txt"], removed: ["lib/util.txt"], from: { version: "1.0.0", commit: before.commit, hash: before.hash }, to: { version: "1.1.0", commit: next } });
    expect(dry.to.hash).not.toBe(before.hash);
    expect(dry.modified).toEqual({ added: [], removed: [], changed: ["lib/util.txt"] });
    expect(readLock(dir)!.commit).toBe(before.commit);
    const u = await updatePlugin("alpha");
    expect(u).toMatchObject({ updated: true, to: { version: "1.1.0", commit: next, hash: dry.to.hash } });
    expect(readLock(dir)).toMatchObject({ commit: next, hash: dry.to.hash, version: "1.1.0" });
    expect(existsSync(join(dir, "lib"))).toBe(false);
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("new\n");
    expect(lockState(dir)).toMatchObject({ modified: false });
  });

  test("a tag pins: update at a tag stays; at a branch it moves", async () => {
    const repo = await pluginRepo({ "plugin.json": JSON.stringify(manifest("pinned")), "run.sh": { exec: "#!/bin/sh\n" } });
    await repo.git.ok(["tag", "v1"]);
    await repo.git.ok(["push", "-q", "origin", "v1"]);
    await installPlugin(`${repo.bare}@v1`);
    await repo.commit({ "run.sh": { exec: "#!/bin/sh\necho 2\n" } });
    expect(await updatePlugin("pinned")).toMatchObject({ updated: false, changed: [] });
  });

  test("remove deletes the plugin's files and the trust given to them, never its data", async () => {
    const repo = await pluginRepo(twoPlugins());
    await installPlugin(`${repo.bare}#beta`);
    const dir = join(userPluginsDir(), "beta");
    recordTrust({ kind: "plugin", name: "beta", dir, hash: hashTree(dir).hash, by: "operator" });
    const data = join(home, "state", "plugins", "beta");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "storage.json"), "{}");
    expect(removePlugin("beta")).toMatchObject({ name: "beta", dir });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(data, "storage.json"))).toBe(true);
    expect(trustState("plugin", dir, "sha256:x").state).toBe("untrusted");
    expect(() => removePlugin("beta")).toThrow(/no plugin beta installed/);
    await refused(updatePlugin("beta"), "not_found", /no plugin beta installed/);
  });
});

describe("the package tree", () => {
  test("every file's sha256 and mode, LOCK left out; a changed mode or file changes the hash; a link out is refused", () => {
    const d = mkdtempSync(join(tmpdir(), "capcomd-tree-"));
    writeFileSync(join(d, "a.txt"), "a");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "b.sh"), "b");
    symlinkSync("../a.txt", join(d, "sub", "a-link"));
    const t0 = hashTree(d);
    expect(Object.keys(t0.files).sort()).toEqual(["a.txt", "sub/a-link", "sub/b.sh"]);
    expect(t0.files["sub/a-link"]!.mode).toBe("120000");
    writeFileSync(join(d, "LOCK"), "{}");
    expect(hashTree(d).hash).toBe(t0.hash);
    chmodSync(join(d, "sub", "b.sh"), 0o755);
    const t1 = hashTree(d);
    expect(t1.hash).not.toBe(t0.hash);
    expect(diffTrees(t0.files, t1.files)).toEqual({ added: [], removed: [], changed: ["sub/b.sh"] });
    symlinkSync("/etc/passwd", join(d, "abs"));
    expect(() => hashTree(d)).toThrow(TreeError);
    rmSync(join(d, "abs"));
    symlinkSync("../../outside", join(d, "sub", "up"));
    expect(() => hashTree(d)).toThrow(/links outside the package/);
    expect(lstatSync(join(d, "sub", "up")).isSymbolicLink()).toBe(true);
  });
});
