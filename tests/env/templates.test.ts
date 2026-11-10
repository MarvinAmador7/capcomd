// Project templates (src/env/templates.ts): their names, which one an agent boots from, the build (whole history from
// the host's mirror, the setup step without the place's secret placeholders or their domains, the size cap, the
// ledger that keeps one per project and deletes only what capcomd made), and when a rebuild is scheduled. The sandbox
// is FakeProvider's host mode, so the build's commands run here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { activeAdapters } from "../../src/agents/adapters";
import { agentHome, templateDir } from "../../src/agents/runner";
import { loadAgentConfig } from "../../src/agents/config";
import { TEMPLATE_MARKER, parseTemplateMarker } from "../../src/agents/workspace";
import { baseEnvHash, envName, ENV_SCHEMA, isTemplateName, projectKey, projectTemplateFor, readTemplates, resolveEnvSnapshot, templateName, writeBuildMarker, writeLedger, writeTemplates } from "../../src/env/resolve";
import { stubFx } from "../helpers/fx-stub";
import { buildEgress, buildProjectTemplate, reaches, rebuildReason, refreshTemplates, removeProjectTemplate, scheduleTemplateBuild, templateBuildsSettled, templateMarkerPath, templateTarget, templateViews } from "../../src/env/templates";

const KNOBS = ["CAPCOMD_SANDBOX", "CAPCOMD_TEMPLATE_LEDGER", "CAPCOMD_ENV_LEDGER", "CAPCOMD_PROJECT_TEMPLATES", "CAPCOMD_TEMPLATE_MAX_GB", "CAPCOMD_TEMPLATE_REBUILD_MB", "CAPCOMD_ENV", "CAPCOMD_ENV_SNAPSHOT"];
let saved: Record<string, string | undefined> = {};
let state: string;
beforeEach(() => {
  saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
  state = mkdtempSync(join(tmpdir(), "capcomd-templates-"));
  process.env.CAPCOMD_SANDBOX = "boxd";
  process.env.CAPCOMD_TEMPLATE_LEDGER = join(state, "templates.json");
  process.env.CAPCOMD_ENV_LEDGER = join(state, "envs.json");
  for (const k of ["CAPCOMD_PROJECT_TEMPLATES", "CAPCOMD_TEMPLATE_MAX_GB", "CAPCOMD_TEMPLATE_REBUILD_MB", "CAPCOMD_ENV", "CAPCOMD_ENV_SNAPSHOT"]) delete process.env[k];
});
afterEach(() => { for (const k of KNOBS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

const PINS = { claude: "2.1.303", codex: "0.50.0", node: "22.23.3" };

describe("names", () => {
  test("per project and base env, starting with the base env's own name, never a plain env build's", () => {
    const n = templateName(PINS, "https://github.com/acme/widgets.git", "0123abcd");
    const base = envName({ schema: ENV_SCHEMA, pins: PINS, lockHash: "none", lockFile: "none", repo: "" });
    expect(n.startsWith(`${base}-`)).toBe(true);
    expect(n).toBe(`${base}-${projectKey("https://github.com/acme/widgets")}-0123abcd`);
    expect(isTemplateName(n)).toBe(true);
    expect(isTemplateName(base)).toBe(false);
    expect(isTemplateName("capcomd-env-2f1eed2b11c528fc")).toBe(false);
    // The same repository however it is spelled; another one differs.
    expect(projectKey("https://GitHub.com/acme/widgets.git/")).toBe(projectKey("https://github.com/acme/widgets"));
    expect(projectKey("https://github.com/acme/gadgets")).not.toBe(projectKey("https://github.com/acme/widgets"));
  });
});

describe("which snapshot an agent boots from", () => {
  const repo = "https://github.com/acme/widgets";
  const record = (pins = PINS) => ({ project: projectKey(repo), repo, name: templateName(pins, repo, "0123abcd"), base: baseEnvHash(pins), pins, target: "main", commit: "a".repeat(40), heads: { main: "a".repeat(40) }, lockFile: "none", lockHash: "none", depsInstalled: false, setup: null, versions: {}, builtAt: new Date().toISOString(), buildMs: 1, sizeBytes: 1 });
  beforeEach(() => {
    writeLedger({ current: { name: "capcomd-env-base0000000000", manifest: { schema: 1, pins: PINS, lockHash: "none", lockFile: "none", repo: "" }, versions: {}, builtAt: "", buildMs: 0, depsInstalled: false }, history: [] });
  });

  test("its project's template on boxd, built on its CLI pins; else the env build", () => {
    writeTemplates({ templates: { [projectKey(repo)]: record() }, created: [record().name] });
    expect(projectTemplateFor(repo, PINS)).toEqual({ name: record().name, why: "used" });
    expect(resolveEnvSnapshot(process.env, { repo, pins: PINS })).toBe(record().name);
    // Another project, or no repository: the env build, as before.
    expect(resolveEnvSnapshot(process.env, { repo: "https://github.com/acme/gadgets", pins: PINS })).toBe("capcomd-env-base0000000000");
    expect(resolveEnvSnapshot()).toBe("capcomd-env-base0000000000");
  });

  test("a template built on other CLI pins is stale: the env build, and why", () => {
    writeTemplates({ templates: { [projectKey(repo)]: record({ ...PINS, claude: "2.0.0" }) }, created: [] });
    expect(projectTemplateFor(repo, PINS).why).toBe("stale_base");
    expect(resolveEnvSnapshot(process.env, { repo, pins: PINS })).toBe("capcomd-env-base0000000000");
  });

  test("Docker, templates off, CAPCOMD_ENV_SNAPSHOT and CAPCOMD_ENV=image keep their meaning", () => {
    writeTemplates({ templates: { [projectKey(repo)]: record() }, created: [] });
    expect(projectTemplateFor(repo, PINS, { ...process.env, CAPCOMD_SANDBOX: "docker" }).why).toBe("not_kept");
    expect(projectTemplateFor(repo, PINS, { ...process.env, CAPCOMD_PROJECT_TEMPLATES: "off" }).why).toBe("not_kept");
    expect(resolveEnvSnapshot({ ...process.env, CAPCOMD_ENV_SNAPSHOT: "capcomd-env-mine" }, { repo, pins: PINS })).toBe("capcomd-env-mine");
    expect(resolveEnvSnapshot({ ...process.env, CAPCOMD_ENV: "image" }, { repo, pins: PINS })).toBeUndefined();
  });
});

/** A build sandbox on this host: fake agent CLIs in its agent home, so nothing is installed. */
async function buildBox() {
  const p = new FakeProvider({ hostExec: true });
  p.snapshotReadyAfter = 1;
  const workdir = mkdtempSync(join(tmpdir(), "capcomd-tpl-vm-"));
  const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_CREDENTIALS: "auto", CAPCOMD_AGENT: "fake" });
  const bin = join(agentHome(cfg), "npm", "bin");
  mkdirSync(bin, { recursive: true });
  for (const a of activeAdapters()) { writeFileSync(join(bin, a.bin), `#!/bin/sh\necho "${a.bin} 9.9.9"\n`); chmodSync(join(bin, a.bin), 0o755); }
  stubFx(agentHome(cfg));
  return { p, cfg, workdir, T: templateDir(cfg), home: agentHome(cfg) };
}

describe("the build", () => {
  test("every branch from the host's mirror, the setup step without placeholders or their domains, recorded per project", async () => {
    const r = await bareRepo();
    await r.seed.ok(["push", "-q", "origin", "main:refs/heads/feature"]);
    const b = await buildBox();
    // A host-bound secret: its placeholder is in every VM's env; it is bound to github.com.
    await b.p.secretSet("ANTHROPIC_API_KEY", "sk-ant-api03-REALVALUE-0123456789abcdef", { domains: ["github.com"], scope: "org" });
    const lines: string[] = [];
    const res = await buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit: { workdir: join(state, "host-git") }, setup: `mkdir -p node_modules/warm && echo ok > node_modules/warm/index.js && printenv ANTHROPIC_API_KEY > "$HOME/seen.txt"; true`, log: (l) => lines.push(l) });
    expect(isTemplateName(res.name)).toBe(true);
    // The VM's egress left out the secret's domain; the setup step didn't see the placeholder.
    expect([...b.p.egress.values()][0]).not.toContain("github.com");
    expect(lines.some((l) => l.includes("github.com left out of the build VM"))).toBe(true);
    expect(readFileSync(join(b.home, "seen.txt"), "utf8").trim()).toBe("");
    // The template: the whole history, every branch, the default branch checked out, its record.
    const marker = parseTemplateMarker(readFileSync(join(b.T, TEMPLATE_MARKER), "utf8"))!;
    expect(marker).toMatchObject({ repo: r.bare, target: "main", commit: (await r.sha("main"))!, depsInstalled: true });
    expect(existsSync(join(b.T, "node_modules", "warm", "index.js"))).toBe(true);
    const t = readTemplates().templates[projectKey(r.bare)]!;
    expect(t).toMatchObject({ name: res.name, repo: r.bare, target: "main", commit: marker.commit, setup: expect.stringContaining("mkdir -p node_modules"), base: baseEnvHash(t.pins) });
    expect(Object.keys(t.heads).sort()).toEqual(["feature", "main"]);
    expect(readTemplates().created).toEqual([res.name]);
    expect(b.p.snapshots.get(res.name)?.status).toBe("ready");
    // The env build's current one is untouched.
    expect(existsSync(join(state, "envs.json"))).toBe(false);
  }, 60_000);

  test("the project's mapped brains go into its template (`env build --project`): each bundle at its commit with the marker, part of the build's name", async () => {
    const r = await bareRepo();
    const brain = await bareRepo();
    await brain.pushToMain("knowledge.md", "a file beside the bundle, not in it\n");
    const b = await buildBox();
    const plain = await buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit: { workdir: join(state, "host-git") } });
    // A bundle of the brain's root files: a directory of it (bareRepo seeds README.md and shared.txt at the root).
    mkdirSync(join(brain.root, "seed", "kb"), { recursive: true });
    await brain.pushToMain("kb/fact.md", "---\ntype: concept\n---\nA fact.\n");
    const commit = (await brain.sha("main"))!;
    const dir = join(b.workdir, "context", "groundray", "acme");
    const bundles = [{ provider: "groundray", name: "acme", remote: brain.bare, branch: "main", commit, path: "kb", dir }];
    const lines: string[] = [];
    const res = await buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit: { workdir: join(state, "host-git") }, bundles, log: (l) => lines.push(l) });
    expect(res.cached).toBe(false);
    expect(res.name).not.toBe(plain.name);
    expect(res.record.manifest.bundles).toEqual([{ provider: "groundray", name: "acme", commit, path: "kb" }]);
    expect(readFileSync(join(dir, ".capcomd-bundle"), "utf8")).toBe(`${commit} kb`);
    expect(readFileSync(join(dir, "kb", "fact.md"), "utf8")).toContain("A fact.");
    expect(existsSync(join(dir, "knowledge.md"))).toBe(false);
    expect(existsSync(join(dir, "README.md"))).toBe(false);
    expect(lines.some((l) => l.includes("context: placed groundray acme (kb/)"))).toBe(true);
  }, 60_000);

  test("a rebuild keeps the one before as `previous` and deletes the one before that, never a snapshot it didn't make", async () => {
    const r = await bareRepo();
    const b = await buildBox();
    const build = () => buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit: { workdir: join(state, "host-git") } });
    const one = (await build()).name;
    expect((await build()).cached).toBe(true);
    await r.pushToMain("two.txt", "2\n");
    const two = (await build()).name;
    expect(readTemplates().templates[projectKey(r.bare)]).toMatchObject({ name: two, previous: one });
    await r.pushToMain("three.txt", "3\n");
    const three = (await build()).name;
    expect(readTemplates().templates[projectKey(r.bare)]).toMatchObject({ name: three, previous: two });
    expect(b.p.snapshots.has(one)).toBe(false);
    expect(readTemplates().created.sort()).toEqual([two, three].sort());
    // A `previous` capcomd didn't make (the owner's snapshot, say) is never deleted.
    const l = readTemplates();
    b.p.snapshots.set("capcomd-env-owners", { name: "capcomd-env-owners", status: "ready", fromVm: "x", polls: 0 });
    writeTemplates({ ...l, templates: { [projectKey(r.bare)]: { ...l.templates[projectKey(r.bare)]!, previous: "capcomd-env-owners" } } });
    await r.pushToMain("four.txt", "4\n");
    await build();
    expect(b.p.snapshots.has("capcomd-env-owners")).toBe(true);
  }, 90_000);

  test("a snapshot of that name that capcomd didn't make is not overwritten", async () => {
    const r = await bareRepo();
    const b = await buildBox();
    const first = await buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit: { workdir: join(state, "host-git") } });
    writeTemplates({ templates: {}, created: [] });
    b.p.snapshots.set(first.name, { name: first.name, status: "pending", fromVm: "someone", polls: -1000 });
    await expect(buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit: { workdir: join(state, "host-git") } })).rejects.toThrow(/capcomd didn't make it; not overwriting it/);
    expect(b.p.snapshots.get(first.name)?.fromVm).toBe("someone");
  }, 60_000);

  test("over the size cap: refused before any snapshot", async () => {
    process.env.CAPCOMD_TEMPLATE_MAX_GB = String(1 / 1024 ** 3); // 1 byte
    const r = await bareRepo();
    const b = await buildBox();
    await expect(buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit: { workdir: join(state, "host-git") } })).rejects.toThrow(/over the 0 GB cap \(CAPCOMD_TEMPLATE_MAX_GB\)/);
    expect(b.p.snapshots.size).toBe(0);
    expect(readTemplates().templates).toEqual({});
  }, 60_000);

  test("a setup step that fails, or dirties the checkout, fails the build and leaves the template as it was", async () => {
    const r = await bareRepo();
    const b = await buildBox();
    const hostGit = { workdir: join(state, "host-git") };
    await expect(buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit, setup: "exit 3" })).rejects.toThrow(/setup step failed \(exit 3\)/);
    await expect(buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit, setup: "echo x > tracked-by-mistake.txt" })).rejects.toThrow(/setup step changed the checkout/);
    expect(readTemplates().templates).toEqual({});
  }, 60_000);
});

describe("when a template is rebuilt", () => {
  test("after an agent couldn't use it, or got a delta over the threshold", () => {
    expect(rebuildReason({ path: "clone", reason: "the lockfile changed since the warm template was built", bytes: 400 * 1024 ** 2 })).toContain("couldn't use it (the lockfile changed");
    expect(rebuildReason({ path: "in_place", bytes: 5 * 1024 ** 2 })).toBeNull();
    expect(rebuildReason({ path: "in_place", bytes: 80 * 1024 ** 2 })).toBe("an agent's delta was 80.0 MB, over 50 MB");
    process.env.CAPCOMD_TEMPLATE_REBUILD_MB = "100";
    expect(rebuildReason({ path: "in_place", bytes: 80 * 1024 ** 2 })).toBeNull();
  });

  test("in the background, once at a time, not again for an hour after a failure, never when manual or off", async () => {
    const r = await bareRepo();
    const b = await buildBox();
    const req = { provider: b.p, repo: r.bare, cfg: b.cfg, hostGit: { workdir: join(state, "host-git") }, reason: "it has no template yet", log: () => {} };
    process.env.CAPCOMD_PROJECT_TEMPLATES = "off";
    expect(scheduleTemplateBuild(req)).toBe("off");
    process.env.CAPCOMD_PROJECT_TEMPLATES = "manual";
    expect(scheduleTemplateBuild(req)).toBe("manual");
    delete process.env.CAPCOMD_PROJECT_TEMPLATES;
    writeBuildMarker(templateMarkerPath(r.bare), { state: "failed", pid: 1, startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date(Date.now() - 30_000).toISOString() });
    expect(scheduleTemplateBuild(req)).toBe("retry_later");
    writeBuildMarker(templateMarkerPath(r.bare), { state: "building", pid: process.pid, startedAt: new Date().toISOString() });
    expect(scheduleTemplateBuild(req)).toBe("running");
    writeBuildMarker(templateMarkerPath(r.bare), { state: "failed", pid: 1, startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), endedAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    expect(scheduleTemplateBuild(req)).toBe("started");
    expect(scheduleTemplateBuild(req)).toBe("running");
    await templateBuildsSettled();
    expect(readTemplates().templates[projectKey(r.bare)]?.repo).toBe(r.bare);
    expect(existsSync(templateMarkerPath(r.bare))).toBe(false);
  }, 60_000);
});

describe("the scheduled refresh", () => {
  test("rebuilds, in the background and with its setup step, only a template whose repository moved", async () => {
    const r = await bareRepo();
    const b = await buildBox();
    const hostGit = { workdir: join(state, "host-git") };
    const setup = "mkdir -p node_modules/x";
    const first = await buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit, setup });
    const refresh = () => refreshTemplates({ provider: () => b.p, cfg: () => b.cfg, log: () => {} });
    expect(await refresh()).toEqual([{ repo: r.bare, result: "current" }]);
    await r.pushToMain("later.txt", "moved\n");
    expect(await refresh()).toEqual([{ repo: r.bare, result: "started" }]);
    await templateBuildsSettled();
    const t = readTemplates().templates[projectKey(r.bare)]!;
    expect(t).toMatchObject({ previous: first.name, setup, hostGit: hostGit.workdir, commit: (await r.sha("main"))! });
    process.env.CAPCOMD_PROJECT_TEMPLATES = "manual";
    await r.pushToMain("again.txt", "moved\n");
    expect(await refresh()).toEqual([]);
  }, 90_000);
});

describe("seeing them", () => {
  test("age, size, commits behind and the delta an agent would get now; removing one deletes only its snapshots", async () => {
    const r = await bareRepo();
    const b = await buildBox();
    const hostGit = { workdir: join(state, "host-git") };
    const res = await buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit });
    let [v] = await templateViews(b.p, { workdir: () => hostGit.workdir });
    expect(v).toMatchObject({ repo: r.bare, name: res.name, status: "ready", behind: 0, deltaBytes: 0, building: false });
    expect(v!.sizeBytes).toBeGreaterThan(0);
    await r.pushToMain("later.txt", "x".repeat(5000));
    [v] = await templateViews(b.p, { workdir: () => hostGit.workdir });
    expect(v!.behind).toBe(1);
    expect(v!.deltaBytes).toBeGreaterThan(0);
    b.p.snapshots.set("capcomd-env-owners", { name: "capcomd-env-owners", status: "ready", fromVm: "x", polls: 0 });
    expect(await removeProjectTemplate(b.p, r.bare)).toEqual([res.name]);
    expect(b.p.snapshots.has(res.name)).toBe(false);
    expect(b.p.snapshots.has("capcomd-env-owners")).toBe(true);
    expect(readTemplates().templates).toEqual({});
  }, 60_000);

  test("on a sandbox that keeps none, `env templates` and `rm` refuse, and the ledger keeps the boxd template (live run)", () => {
    // The fake sandbox (CAPCOMD_SANDBOX unset) reads boxd's ledger file: `rm` used to forget the template, say
    // "removed" and leave its boxd snapshot behind with no record of it.
    const repo = "https://github.com/acme/widgets.git";
    const name = templateName(PINS, repo, "0123abcd");
    writeTemplates({ templates: { [projectKey(repo)]: { project: projectKey(repo), repo, name, base: "b", pins: PINS, target: "main", commit: "0".repeat(40), heads: { main: "0".repeat(40) }, lockFile: "none", lockHash: "none", depsInstalled: false, setup: null, builtAt: new Date().toISOString(), buildMs: 1, sizeBytes: 1 } as any }, created: [name] });
    const before = readFileSync(process.env.CAPCOMD_TEMPLATE_LEDGER!, "utf8");
    const cli = join(import.meta.dir, "..", "..", "src", "cli", "index.ts");
    for (const [sandbox, args] of [["fake", ["env", "templates", "rm", "--repo", repo]], ["docker", ["env", "templates", "--json"]]] as const) {
      const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: state, env: { ...process.env, CAPCOMD_SANDBOX: sandbox, CAPCOMD_HOME: state, CAPCOMD_NO_CONFIG: "1" } });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain(`the ${sandbox} sandbox keeps no project templates`);
    }
    expect(readFileSync(process.env.CAPCOMD_TEMPLATE_LEDGER!, "utf8")).toBe(before);
  });
});

describe("what the build VM may reach (review)", () => {
  test("a host that reaches a secret's domain is left out: the domain itself, a parent wildcard, `*`; nothing left refuses", () => {
    expect(reaches("*", "api.anthropic.com")).toBe(true);
    expect(reaches("*.anthropic.com", "api.anthropic.com")).toBe(true);
    expect(reaches("api.anthropic.com", "*.anthropic.com")).toBe(true);
    expect(reaches("api.anthropic.com", "api.anthropic.com")).toBe(true);
    expect(reaches("proxy.golang.org", "api.anthropic.com")).toBe(false);
    expect(reaches("anthropic.com.evil.io", "*.anthropic.com")).toBe(false);
    const e = buildEgress(["github.com", "registry.npmjs.org"], ["*", "*.anthropic.com", "proxy.golang.org"], ["api.anthropic.com"]);
    expect(e.allow).toEqual(["github.com", "registry.npmjs.org", "proxy.golang.org"]);
    expect(e.left).toEqual(["*", "*.anthropic.com"]);
    expect(() => buildEgress(["github.com"], [], ["github.com"])).toThrow(/nothing is left for its egress/);
  });

  test("a setup egress of `*` doesn't open the build VM while a host-bound secret exists", async () => {
    const r = await bareRepo();
    const b = await buildBox();
    await b.p.secretSet("ANTHROPIC_API_KEY", "sk-ant-api03-REALVALUE-0123456789abcdef", { domains: ["api.anthropic.com"], scope: "org" });
    const lines: string[] = [];
    await buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit: { workdir: join(state, "host-git") }, egress: ["*", "proxy.golang.org"], log: (l) => lines.push(l) });
    const allowed = [...b.p.egress.values()][0]!;
    expect(allowed).not.toContain("*");
    expect(allowed).toContain("proxy.golang.org");
    expect(lines.some((l) => l.includes("egress: * left out of the build VM"))).toBe(true);
  }, 60_000);
});

describe("one build per project, and no local key in it (review)", () => {
  test("another process's running build of the project refuses this one", async () => {
    const r = await bareRepo();
    const b = await buildBox();
    // The parent process is alive, and isn't this one.
    writeBuildMarker(templateMarkerPath(r.bare), { state: "building", pid: process.ppid, startedAt: new Date().toISOString() });
    await expect(buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit: { workdir: join(state, "host-git") } })).rejects.toThrow(/already running \(pid \d+/);
    expect(b.p.snapshots.size).toBe(0);
  }, 60_000);

  test("a local API key value the setup step wrote into the VM refuses the snapshot", async () => {
    const r = await bareRepo();
    const b = await buildBox();
    const value = "local-key-value-0123456789";
    const source = { ...process.env, ANTHROPIC_API_KEY: value };
    await expect(buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit: { workdir: join(state, "host-git") }, source, setup: `printf %s ${value} > "$HOME/leak.txt"` })).rejects.toThrow(/a local API key value is present in the VM/);
    expect(b.p.snapshots.size).toBe(0);
  }, 60_000);
});

describe("a rebuild that would make the same template (review)", () => {
  test("is skipped while the template's branch hasn't moved, and runs once it has", async () => {
    const r = await bareRepo();
    const b = await buildBox();
    const hostGit = { workdir: join(state, "host-git") };
    const first = await buildProjectTemplate({ provider: b.p, repo: r.bare, cfg: b.cfg, hostGit });
    const at = templateTarget(r.bare)!;
    expect(at).toEqual({ target: "main", commit: (await r.sha("main"))! });
    // Another branch moved (an agent's push), not main: an agent on another target would clone again either way.
    await r.seed.ok(["push", "-q", "origin", "main:refs/heads/release"]);
    const said: string[] = [];
    const req = { provider: b.p, repo: r.bare, cfg: b.cfg, hostGit, reason: "an agent couldn't use it (another target)", log: (l: string) => said.push(l), unlessTargetAt: at };
    expect(scheduleTemplateBuild(req)).toBe("started");
    await templateBuildsSettled();
    expect(said.some((l) => /main is still at [0-9a-f]{12}, as its template was built: .*not rebuilding/.test(l))).toBe(true);
    expect(readTemplates().templates[projectKey(r.bare)]!.name).toBe(first.name);
    expect(b.p.egress.size).toBe(1); // no build VM booted
    await r.pushToMain("moved.txt", "moved\n");
    expect(scheduleTemplateBuild(req)).toBe("started");
    await templateBuildsSettled();
    expect(readTemplates().templates[projectKey(r.bare)]).toMatchObject({ previous: first.name, commit: (await r.sha("main"))! });
  }, 90_000);
});
