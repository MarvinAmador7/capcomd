// ADR-024 §7 step 7: profile packages installed from a git repository (a local fixture repository, the
// tests/merge/gitfixture.ts pattern) with a LOCK as a plugin's (`kind: "profile"`, src/install/), `update` reporting a
// changed hash (and each skill's) before replacing the package and keeping the user's override.yaml, `export` (as is,
// and `--flat`) installing again, `rm` of an installed package, and the refusals: a package naming a file outside its
// directory, an executable, an override.yaml, one the profiles wouldn't resolve with. And decision 4: a project's
// profile skills wait for `capcomd profiles trust`, per SKILL.md content hash.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Git } from "../../src/merge/git";
import { RelayError } from "../../src/core/errors";
import { exportProfile, installedFacts, installProfile, packageWarnings, removeInstalledProfile, updateProfile } from "../../src/profiles/install";
import { projectSkillTrust, readProfiles, resolveAgent, trustProfileSkills, untrustedSkillsProblem } from "../../src/profiles";
import { hashTree, readLock } from "../../src/install/lock";
import { trustState } from "../../src/install/trust";

const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;
const sha = (t: string) => new Bun.CryptoHasher("sha256").update(t).digest("hex");
const yaml = (lines: string[]) => lines.join("\n") + "\n";
const md = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name}, for the tests\n---\n${body}\n`;
const harness = "harness: { provider: claude, auth: apikey }";

/** A project (repo/.capcomd/agents.json, its profiles in repo/.capcomd/profiles/) and a CAPCOMD_HOME of its own. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "capcomd-prof-install-"));
  const project = join(root, "repo", ".capcomd");
  mkdirSync(project, { recursive: true });
  const path = join(project, "agents.json");
  const env = { ...process.env, CAPCOMD_HOME: join(root, "home"), CAPCOMD_AGENTS_FILE: path } as Record<string, string | undefined>;
  const user = join(root, "home", "profiles"), projectProfiles = join(project, "profiles");
  const o = { path, env };
  const cli = (args: string[]) => {
    const p = Bun.spawnSync(["bun", CLI, ...args], { cwd: join(root, "repo"), env: { ...env, HOME: join(root, "user"), ANTHROPIC_API_KEY: "" } as Record<string, string> });
    const out = p.stdout.toString();
    let j: any = null;
    try { j = JSON.parse(out.trim().split("\n").pop()!); } catch { /* text */ }
    return { code: p.exitCode, out, err: p.stderr.toString(), j };
  };
  return { root, path, env, o, user, projectProfiles, cli, load: () => readProfiles(path, env) };
}

type Body = string | { exec: string } | { link: string } | null;
/** A bare repository of profile packages (a local "git server"), and a clone to commit to it from. */
async function profileRepo(files: Record<string, Body>) {
  const root = mkdtempSync(join(tmpdir(), "capcomd-profile-repo-"));
  const bare = join(root, "profiles.git");
  mkdirSync(bare);
  await new Git(bare).ok(["init", "-q", "--bare", "-b", "main"]);
  const work = join(root, "work");
  mkdirSync(work);
  const g = new Git(work);
  await g.ok(["init", "-q", "-b", "main"]);
  await g.ok(["remote", "add", "origin", bare]);
  const write = async (fs: Record<string, Body>, msg: string) => {
    for (const [p, body] of Object.entries(fs)) {
      const to = join(work, p);
      rmSync(to, { force: true });
      if (body === null) continue;
      mkdirSync(dirname(to), { recursive: true });
      if (typeof body === "string") writeFileSync(to, body);
      else if ("link" in body) symlinkSync(body.link, to);
      else { writeFileSync(to, body.exec); chmodSync(to, 0o755); }
    }
    await g.ok(["add", "-A"]);
    await g.ok(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg]);
    await g.ok(["push", "-q", "origin", "HEAD:main"]);
    return g.ok(["rev-parse", "HEAD"]);
  };
  const first = await write(files, "first");
  return { bare, work, git: g, first, commit: (fs: Record<string, Body>, msg = "next") => write(fs, msg) };
}

const THREAT = md("threat-model", "List the trust boundaries first.");
const critic = (o: { version?: number; extra?: string[] } = {}) => yaml(["name: security-critic", `version: ${o.version ?? 1}`, harness, "description: Reviews for security", "prompt: { append: prompt.md }", "skills: [{ name: threat-model }]", "tags: [review, security]", ...(o.extra ?? [])]);
const twoProfiles = (): Record<string, Body> => ({
  "profiles/security-critic/profile.yaml": critic(),
  "profiles/security-critic/prompt.md": "Look for injection first.\nThen secrets.\n",
  "profiles/security-critic/skills/threat-model/SKILL.md": THREAT,
  "profiles/docs-writer/profile.yaml": yaml(["name: docs-writer", harness]),
  "README.md": "two profiles\n",
});

const refused = async (p: Promise<unknown>, code: string, text: RegExp) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(RelayError);
  expect((e as RelayError).code).toBe(code as never);
  expect(`${(e as Error).message} ${(e as RelayError).hint}`).toMatch(text);
};
const leftovers = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(".")) : []);

describe("install", () => {
  test("from a local repository into your profiles: the named package's files and its LOCK; it resolves as yours", async () => {
    const w = world(), repo = await profileRepo(twoProfiles());
    const r = await installProfile(`${repo.bare}#security-critic@main`, w.o);
    const dir = join(w.user, "security-critic");
    expect(r).toEqual({ name: "security-critic", version: 1, source: `${repo.bare}#security-critic@main`, commit: repo.first, hash: hashTree(dir).hash, dir, layer: "user", hiddenBy: null });
    expect(readdirSync(dir).sort()).toEqual(["LOCK", "profile.yaml", "prompt.md", "skills"]);
    const lock = readLock(dir)!;
    expect(lock).toMatchObject({ schema: "capcomd.lock/v1", kind: "profile", name: "security-critic", version: "1", source: r.source, remote: repo.bare, ref: "main", commit: repo.first, path: "profiles/security-critic", hash: r.hash });
    expect(Object.keys(lock.files).sort()).toEqual(["profile.yaml", "prompt.md", "skills/threat-model/SKILL.md"]);
    expect(lock.files["skills/threat-model/SKILL.md"]!.sha256).toBe(sha(THREAT));
    const p = w.load().profiles["security-critic"]!;
    expect(p).toMatchObject({ source: "user", version: 1, spec: { provider: "claude", auth: "apikey", appendSystemPrompt: "Look for injection first.\nThen secrets.\n" } });
    expect(p.skills.map((s) => [s.name, s.source, s.hash])).toEqual([["threat-model", "user", sha(THREAT)]]);
    expect(installedFacts(p)).toMatchObject({ source: r.source, commit: repo.first, hash: r.hash, modified: null });
    // Your own package: its skills need no trust (only a project's do).
    expect(untrustedSkillsProblem("security-critic", p.skills, w.env)).toBeNull();
    expect(resolveAgent("security-critic", w.env).profile).toEqual({ name: "security-critic", version: 1, source: "user" });
    // Again is a conflict: update replaces one.
    await refused(installProfile(`${repo.bare}#security-critic`, w.o), "conflict", /already in your profiles .*capcomd profiles update security-critic/);
    expect(leftovers(w.user)).toEqual([]);
  });

  test("several packages need #name; a repository whose root is a package installs that", async () => {
    const w = world(), repo = await profileRepo(twoProfiles());
    await refused(installProfile(repo.bare, w.o), "run_failed", /several profiles: name one with #<name> \(.*docs-writer.*security-critic|several profiles: name one with #<name> \(.*security-critic.*docs-writer/);
    await refused(installProfile(`${repo.bare}#nope`, w.o), "run_failed", /no profile named nope \(it has /);
    const single = await profileRepo({ "profile.yaml": yaml(["name: solo", harness]), "LICENSE": "MIT\n" });
    const r = await installProfile(single.bare, w.o);
    expect(r).toMatchObject({ name: "solo", version: null, layer: "user" });
    expect(readdirSync(join(w.user, "solo")).sort()).toEqual(["LICENSE", "LOCK", "profile.yaml"]);
  });

  test("a package that names a file outside its directory is refused, and nothing is installed", async () => {
    const w = world();
    const repo = await profileRepo({
      "secret.md": "the host's secrets\n",
      "p/up/profile.yaml": yaml(["name: up", harness, "prompt: { append: ../../secret.md }"]),
      "p/persona/profile.yaml": yaml(["name: persona", harness, "identity: { persona: ../secret.md }"]),
      "p/linked/profile.yaml": yaml(["name: linked", harness, "skills: [{ name: s }]"]),
      "p/linked/skills/s/SKILL.md": { link: "../../../../secret.md" },
      "p/missing/profile.yaml": yaml(["name: missing", harness, "prompt: { system: absent.md }"]),
    });
    await refused(installProfile(`${repo.bare}#up`, w.o), "config", /installing up would leave the profiles unreadable.*prompt\.append names \.\.\/\.\.\/secret\.md, which leads outside the profile's directory/);
    await refused(installProfile(`${repo.bare}#persona`, w.o), "config", /identity\.persona: must name a \.md or \.txt file next to the manifest/);
    await refused(installProfile(`${repo.bare}#linked`, w.o), "run_failed", /skills\/s\/SKILL\.md links outside the package/);
    await refused(installProfile(`${repo.bare}#missing`, w.o), "config", /prompt\.system names absent\.md, which isn't in/);
    for (const n of ["up", "persona", "linked", "missing"]) expect(existsSync(join(w.user, n))).toBe(false);
    expect(leftovers(w.user)).toEqual([]);
    // The profiles are as they were.
    expect(Object.keys(w.load().profiles)).toEqual([]);
  });

  test("profiles are data: an executable, an override.yaml, a broken manifest and a missing parent are refused", async () => {
    const w = world();
    const repo = await profileRepo({
      "a/profile.yaml": yaml(["name: tool", harness]), "a/setup.sh": { exec: "#!/bin/sh\necho hi\n" },
      "b/profile.yaml": yaml(["name: sneaky", harness]), "b/override.yaml": yaml(["limits: { maxTurns: 1 }"]),
      "c/profile.yaml": yaml(["name: odd", harness, "colour: blue"]),
      "d/profile.yaml": yaml(["name: orphan", "extends: nobody-here"]),
    });
    await refused(installProfile(`${repo.bare}#tool`, w.o), "config", /profiles are data, and the package has an executable file: setup\.sh/);
    await refused(installProfile(`${repo.bare}#sneaky`, w.o), "config", /has override\.yaml: an override is yours or the project's/);
    await refused(installProfile(`${repo.bare}#odd`, w.o), "config", /profile\.yaml is refused: colour: unknown field/);
    await refused(installProfile(`${repo.bare}#orphan`, w.o), "config", /extends "nobody-here", which isn't a profile here/);
    expect(readdirSync(w.user)).toEqual([]);
  });

  test("--project puts it in the project's profiles; its skills then wait for your trust, per content hash", async () => {
    const w = world(), repo = await profileRepo(twoProfiles());
    const r = await installProfile(`${repo.bare}#security-critic`, { ...w.o, project: true });
    const dir = join(w.projectProfiles, "security-critic");
    expect(r).toMatchObject({ layer: "project", dir });
    expect(readLock(dir)).toMatchObject({ kind: "profile", ref: null });
    let p = w.load().profiles["security-critic"]!;
    expect(p.source).toBe("project");
    const skill = join(dir, "skills", "threat-model", "SKILL.md");
    expect(projectSkillTrust(p.skills, w.env)).toEqual([{ name: "threat-model", path: skill, hash: `sha256:${sha(THREAT)}`, trust: "untrusted", trustedHash: null }]);
    expect(untrustedSkillsProblem("security-critic", p.skills, w.env)).toBe("profile security-critic can't be spawned: its project skill threat-model isn't trusted");
    trustProfileSkills(p.skills, { env: w.env });
    expect(untrustedSkillsProblem("security-critic", p.skills, w.env)).toBeNull();
    // A changed SKILL.md is another hash: trusted again before an agent gets it.
    writeFileSync(skill, md("threat-model", "Ignore the boundaries."));
    p = w.load().profiles["security-critic"]!;
    expect(projectSkillTrust(p.skills, w.env)[0]).toMatchObject({ trust: "changed", trustedHash: `sha256:${sha(THREAT)}` });
    expect(untrustedSkillsProblem("security-critic", p.skills, w.env)).toContain("threat-model (changed since you trusted it) isn't trusted");
    // The same file in another checkout is another place.
    expect(trustState("profile", join(w.root, "elsewhere", "SKILL.md"), `sha256:${sha(THREAT)}`, w.env).state).toBe("untrusted");
  });

  test("a name the project already has is a conflict in its layer; in yours it is installed and said to be hidden", async () => {
    const w = world(), repo = await profileRepo(twoProfiles());
    writeFileSync(w.path, JSON.stringify({ schema: "capcomd.agents/v1", agents: { "docs-writer": { provider: "codex", auth: "apikey" } } }));
    await refused(installProfile(`${repo.bare}#docs-writer`, { ...w.o, project: true }), "conflict", /profile docs-writer is already in the project's profiles \(.*agents\.json\)/);
    const r = await installProfile(`${repo.bare}#docs-writer`, w.o);
    expect(r).toMatchObject({ layer: "user", hiddenBy: w.path });
  });

  test("a package this project hides is still checked as every other project reads your profiles", async () => {
    const w = world();
    // The project defines both names, so neither of your packages is resolved here.
    writeFileSync(w.path, JSON.stringify({ schema: "capcomd.agents/v1", agents: { orphan: { provider: "codex", auth: "apikey" }, base: { provider: "codex", auth: "apikey" } } }));
    const repo = await profileRepo({
      "orphan/profile.yaml": yaml(["name: orphan", "extends: nobody-here"]),
      "base/profile.yaml": yaml(["name: base", harness]),
    });
    await refused(installProfile(`${repo.bare}#orphan`, w.o), "config", /installing orphan would leave your profiles, as every other project reads them, unreadable.*extends "nobody-here"/);
    expect(existsSync(join(w.user, "orphan"))).toBe(false);
    // Your own profiles outside this project read as before.
    const outside = join(w.env.CAPCOMD_HOME!, "agents.json");
    expect(Object.keys(readProfiles(outside, w.env).profiles)).toEqual([]);
    // An update that would break it, and a removal another of your profiles needs, are refused the same way.
    await installProfile(`${repo.bare}#base`, w.o);
    const lock = readLock(join(w.user, "base"))!;
    await repo.commit({ "base/profile.yaml": yaml(["name: base", "extends: gone-parent"]) });
    await refused(updateProfile("base", w.o), "config", /updating base would leave your profiles, as every other project reads them, unreadable.*gone-parent/);
    expect(readLock(join(w.user, "base"))).toEqual(lock);
    writeFileSync(join(w.user, "child.yaml"), yaml(["name: child", "extends: base"]));
    expect(() => removeInstalledProfile("base", w.o)).toThrow(/removing base would leave your profiles, as every other project reads them, unreadable.*extends "base"/);
    expect(existsSync(join(w.user, "base"))).toBe(true);
    expect(leftovers(w.user)).toEqual([]);
  });
});

describe("update", () => {
  test("reports the changed files, each skill's hash and the content hash before replacing; --dry-run changes nothing", async () => {
    const w = world(), repo = await profileRepo(twoProfiles());
    const before = await installProfile(`${repo.bare}#security-critic`, w.o);
    const dir = join(w.user, "security-critic");
    expect(await updateProfile("security-critic", w.o)).toMatchObject({ updated: false, added: [], removed: [], changed: [], skills: [], modified: null, from: { hash: before.hash }, to: { hash: before.hash } });
    const THREAT2 = md("threat-model", "List the trust boundaries, then the data flows.");
    const next = await repo.commit({
      "profiles/security-critic/profile.yaml": critic({ version: 2, extra: ["identity: { title: Security critic }"] }),
      "profiles/security-critic/skills/threat-model/SKILL.md": THREAT2,
      "profiles/security-critic/skills/owasp/SKILL.md": md("owasp", "The top ten."),
      "profiles/security-critic/prompt.md": null,
    });
    // Yours, beside the package: an override (kept) and an edit to the package (reported, then replaced).
    writeFileSync(join(dir, "override.yaml"), yaml(["limits: { maxTurns: 7 }"]));
    writeFileSync(join(dir, "prompt.md"), "Edited by hand.\n");
    expect(installedFacts(w.load().profiles["security-critic"]!)?.modified).toEqual(["prompt.md"]);
    expect(packageWarnings(w.load())).toEqual([expect.stringContaining("profiles.security-critic: edited since it was installed (prompt.md)")]);
    const dry = await updateProfile("security-critic", { ...w.o, dryRun: true });
    expect(dry).toMatchObject({
      updated: false, changed: ["profile.yaml", "skills/threat-model/SKILL.md"], added: ["skills/owasp/SKILL.md"], removed: ["prompt.md"],
      skills: [{ name: "owasp", from: null, to: `sha256:${sha(md("owasp", "The top ten."))}` }, { name: "threat-model", from: `sha256:${sha(THREAT)}`, to: `sha256:${sha(THREAT2)}` }],
      modified: { added: [], removed: [], changed: ["prompt.md"] },
      from: { version: "1", commit: before.commit, hash: before.hash }, to: { version: "2", commit: next },
    });
    expect(dry.to.hash).not.toBe(before.hash);
    expect(readLock(dir)!.commit).toBe(before.commit);
    // The new profile.yaml drops prompt.md's reference: it resolves without it.
    await repo.commit({ "profiles/security-critic/profile.yaml": critic({ version: 2, extra: ["identity: { title: Security critic }"] }).replace("prompt: { append: prompt.md }\n", "") });
    const u = await updateProfile("security-critic", w.o);
    expect(u).toMatchObject({ updated: true, to: { version: "2" } });
    expect(readLock(dir)).toMatchObject({ commit: u.to.commit, hash: u.to.hash, version: "2" });
    expect(readdirSync(dir).sort()).toEqual(["LOCK", "override.yaml", "profile.yaml", "skills"]);
    expect(readFileSync(join(dir, "override.yaml"), "utf8")).toBe(yaml(["limits: { maxTurns: 7 }"]));
    const p = w.load().profiles["security-critic"]!;
    expect(p).toMatchObject({ version: 2, spec: { maxTurns: 7 } });
    expect(p.skills.map((s) => s.name)).toEqual(["threat-model"]);
    expect(installedFacts(p)?.modified).toBeNull();
    expect(leftovers(w.user)).toEqual([]);
  });

  test("files you added beside the package are kept and said to be; one the new package needs the place of is a conflict", async () => {
    const w = world(), repo = await profileRepo(twoProfiles());
    await installProfile(`${repo.bare}#security-critic`, w.o);
    const dir = join(w.user, "security-critic");
    // Yours: a note at the top, one inside a skill the update removes, and one the new package ships as it is.
    writeFileSync(join(dir, "notes.md"), "My notes on this profile.\n");
    writeFileSync(join(dir, "skills", "threat-model", "mine.md"), "Mine too.\n");
    writeFileSync(join(dir, "CHANGES.md"), "v2\n");
    const v2 = critic({ version: 2 }).replace("skills: [{ name: threat-model }]\n", "");
    await repo.commit({ "profiles/security-critic/profile.yaml": v2, "profiles/security-critic/skills/threat-model/SKILL.md": null, "profiles/security-critic/CHANGES.md": "v2\n" });
    const dry = await updateProfile("security-critic", { ...w.o, dryRun: true });
    expect(dry).toMatchObject({ updated: false, kept: ["notes.md", "skills/threat-model/mine.md"], removed: ["skills/threat-model/SKILL.md"], added: ["CHANGES.md"] });
    const text = w.cli(["profiles", "update", "security-critic", "--dry-run"]).out;
    expect(text).toContain("added by you, kept: notes.md, skills/threat-model/mine.md");
    expect(text).not.toContain("replaced by the update");
    const u = await updateProfile("security-critic", w.o);
    expect(u).toMatchObject({ updated: true, kept: ["notes.md", "skills/threat-model/mine.md"], to: { version: "2" } });
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("My notes on this profile.\n");
    expect(readFileSync(join(dir, "skills", "threat-model", "mine.md"), "utf8")).toBe("Mine too.\n");
    expect(existsSync(join(dir, "skills", "threat-model", "SKILL.md"))).toBe(false);
    expect(readLock(dir)!.files["CHANGES.md"]).toBeDefined();
    expect(readLock(dir)!.files["notes.md"]).toBeUndefined();
    expect(leftovers(w.user)).toEqual([]);
    // Up to date, your files still there: nothing to replace.
    expect(await updateProfile("security-critic", w.o)).toMatchObject({ updated: false, kept: ["notes.md", "skills/threat-model/mine.md"] });
    expect(w.cli(["profiles", "update", "security-critic"]).out).toContain("security-critic is up to date");
    // The package now ships a notes.md of its own, a directory where your mine.md is, and a file where your docs/ is:
    // refused, nothing changed.
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "a.md"), "Mine.\n");
    const lock = readLock(dir)!;
    await repo.commit({ "profiles/security-critic/notes.md": "The package's notes.\n", "profiles/security-critic/skills/threat-model/mine.md/x.md": "x\n", "profiles/security-critic/docs": "a file\n" });
    await refused(updateProfile("security-critic", { ...w.o, dryRun: true }), "conflict", /needs the place of files you added.*: docs\/a\.md, notes\.md, skills\/threat-model\/mine\.md .*Move them out/);
    await refused(updateProfile("security-critic", w.o), "conflict", /notes\.md/);
    expect(readLock(dir)).toEqual(lock);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("My notes on this profile.\n");
    expect(leftovers(w.user)).toEqual([]);
  });

  test("an update the profiles wouldn't resolve with is put back, with the files you added", async () => {
    const w = world(), repo = await profileRepo(twoProfiles());
    await installProfile(`${repo.bare}#security-critic`, w.o);
    const dir = join(w.user, "security-critic");
    writeFileSync(join(dir, "notes.md"), "Mine.\n");
    await repo.commit({ "profiles/security-critic/profile.yaml": critic({ extra: ["extends: gone-parent"] }) });
    await refused(updateProfile("security-critic", w.o), "config", /gone-parent/);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("Mine.\n");
    expect(readFileSync(join(dir, "profile.yaml"), "utf8")).toBe(critic());
    expect(leftovers(w.user)).toEqual([]);
  });

  test("an update the profiles wouldn't resolve with is put back", async () => {
    const w = world(), repo = await profileRepo(twoProfiles());
    await installProfile(`${repo.bare}#security-critic`, w.o);
    const dir = join(w.user, "security-critic");
    const lock = readLock(dir)!;
    writeFileSync(join(dir, "override.yaml"), yaml(["limits: { maxTurns: 9 }"]));
    await repo.commit({ "profiles/security-critic/profile.yaml": critic({ extra: ["extends: gone-parent"] }) });
    await refused(updateProfile("security-critic", w.o), "config", /updating security-critic would leave the profiles unreadable.*gone-parent/);
    expect(readLock(dir)).toEqual(lock);
    expect(readFileSync(join(dir, "override.yaml"), "utf8")).toContain("maxTurns: 9");
    expect(leftovers(w.user)).toEqual([]);
    await refused(updateProfile("docs-writer", w.o), "not_found", /no profile docs-writer installed/);
  });
});

describe("export and remove", () => {
  test("export keeps a package's own files and extends; --flat resolves it into one package that installs again", async () => {
    const w = world();
    const PLAN = md("plan", "Split by file.");
    mkdirSync(join(w.projectProfiles, "base", "skills", "plan"), { recursive: true });
    writeFileSync(join(w.projectProfiles, "base", "profile.yaml"), yaml(["name: base", harness, "limits: { maxTurns: 20 }", "skills: [{ name: plan }]"]));
    writeFileSync(join(w.projectProfiles, "base", "skills", "plan", "SKILL.md"), PLAN);
    mkdirSync(join(w.projectProfiles, "lead"), { recursive: true });
    writeFileSync(join(w.projectProfiles, "lead", "profile.yaml"), yaml(["# the team's lead", "name: lead", "extends: base", "default: true", "prompt: { append: brief.md }", "x-acme: { team: payments }"]));
    writeFileSync(join(w.projectProfiles, "lead", "brief.md"), "Keep the team small.\nAsk before merging.\n");
    writeFileSync(join(w.projectProfiles, "lead", "override.yaml"), yaml(["limits: { maxTurns: 30 }"]));
    const out = join(w.root, "out");

    const plain = exportProfile("lead", { ...w.o, out });
    expect(plain).toEqual({ name: "lead", dir: join(out, "lead"), flat: false, files: ["brief.md", "profile.yaml"], extends: "base" });
    expect(readFileSync(join(out, "lead", "profile.yaml"), "utf8")).toBe(yaml(["# the team's lead", "name: lead", "extends: base", "prompt: { append: brief.md }", "x-acme: { team: payments }"]));
    expect(() => exportProfile("lead", { ...w.o, out })).toThrow(/already exists/);

    const flat = exportProfile("lead", { ...w.o, out: join(out, "flat"), flat: true });
    expect(flat).toMatchObject({ flat: true, files: ["profile.yaml", "prompt.md", "skills/plan/SKILL.md"], extends: null });
    const doc = parseYaml(readFileSync(join(flat.dir, "profile.yaml"), "utf8"));
    expect(doc).toEqual({ schema: "capcomd.profile/v2", name: "lead", harness: { provider: "claude", auth: "apikey" }, prompt: { append: "prompt.md" }, skills: [{ name: "plan" }], limits: { maxTurns: 30 }, "x-acme": { team: "payments" } });
    expect(readFileSync(join(flat.dir, "skills", "plan", "SKILL.md"), "utf8")).toBe(PLAN);

    // The flat package is a package: from a repository, into someone else's profiles, it resolves the same.
    const repo = await profileRepo({ "lead/profile.yaml": readFileSync(join(flat.dir, "profile.yaml"), "utf8"), "lead/prompt.md": readFileSync(join(flat.dir, "prompt.md"), "utf8"), "lead/skills/plan/SKILL.md": PLAN });
    const other = world();
    await installProfile(repo.bare, other.o);
    const mine = w.load().profiles.lead!, theirs = other.load().profiles.lead!;
    expect(theirs.spec).toEqual(mine.spec);
    expect(theirs.skills.map((s) => s.hash)).toEqual(mine.skills.map((s) => s.hash));
    expect(theirs.manifest["x-acme"]).toEqual({ team: "payments" });

    // A persona file that has the name a flat prompt would take keeps it; the prompt gets another.
    mkdirSync(join(w.projectProfiles, "voice"), { recursive: true });
    writeFileSync(join(w.projectProfiles, "voice", "profile.yaml"), yaml(["name: voice", harness, "identity: { persona: prompt.md }"]));
    writeFileSync(join(w.projectProfiles, "voice", "prompt.md"), "I am calm.\n");
    mkdirSync(join(w.projectProfiles, "speaker"), { recursive: true });
    writeFileSync(join(w.projectProfiles, "speaker", "profile.yaml"), yaml(["name: speaker", "extends: voice", "prompt: { append: brief.md }"]));
    writeFileSync(join(w.projectProfiles, "speaker", "brief.md"), "Speak slowly.\nThen stop.\n");
    const spoken = exportProfile("speaker", { ...w.o, out: join(out, "flat"), flat: true });
    expect(spoken.files).toEqual(["append-prompt.md", "profile.yaml", "prompt.md"]);
    expect(readFileSync(join(spoken.dir, "prompt.md"), "utf8")).toBe("I am calm.\n");
    expect(readFileSync(join(spoken.dir, "append-prompt.md"), "utf8")).toBe("Speak slowly.\nThen stop.\n");
    expect(parseYaml(readFileSync(join(spoken.dir, "profile.yaml"), "utf8"))).toMatchObject({ identity: { persona: "prompt.md" }, prompt: { append: "append-prompt.md" } });

    // An agents.json entry exports as a profile.yaml.
    writeFileSync(w.path, JSON.stringify({ schema: "capcomd.agents/v1", default: "reviewer", agents: { reviewer: { provider: "codex", auth: "subscription", maxTurns: 12, description: "Reviews" } } }));
    const v1 = exportProfile("reviewer", { ...w.o, out: join(out, "v1") });
    expect(parseYaml(readFileSync(join(v1.dir, "profile.yaml"), "utf8"))).toEqual({ schema: "capcomd.profile/v2", name: "reviewer", description: "Reviews", harness: { provider: "codex", auth: "subscription" }, limits: { maxTurns: 12 } });
  });

  test("rm of an installed package removes it and the trust given to its skills; not while another profile extends it", async () => {
    const w = world(), repo = await profileRepo(twoProfiles());
    await installProfile(`${repo.bare}#security-critic`, { ...w.o, project: true });
    const dir = join(w.projectProfiles, "security-critic"), skill = join(dir, "skills", "threat-model", "SKILL.md");
    trustProfileSkills(w.load().profiles["security-critic"]!.skills, { env: w.env });
    writeFileSync(join(w.projectProfiles, "strict.yaml"), yaml(["name: strict", "extends: security-critic"]));
    expect(() => removeInstalledProfile("security-critic", { ...w.o, project: true })).toThrow(/removing security-critic would leave the profiles unreadable.*extends "security-critic"/);
    expect(existsSync(dir)).toBe(true);
    rmSync(join(w.projectProfiles, "strict.yaml"));
    expect(removeInstalledProfile("security-critic", w.o)).toEqual({ name: "security-critic", dir, layer: "project" });
    expect(existsSync(dir)).toBe(false);
    expect(trustState("profile", skill, `sha256:${sha(THREAT)}`, w.env).state).toBe("untrusted");
    expect(JSON.parse(readFileSync(join(w.env.CAPCOMD_HOME!, "trust.json"), "utf8")).entries).toEqual([]);
    expect(leftovers(w.projectProfiles)).toEqual([]);
  });
});

describe("the CLI", () => {
  test("install, show, validate, trust, update --dry-run, export and rm, with --json", async () => {
    const w = world(), repo = await profileRepo(twoProfiles());
    const i = w.cli(["profiles", "install", `${repo.bare}#security-critic`, "--project", "--json"]);
    if (i.code !== 0) console.log(i.out, i.err);
    expect(i.code).toBe(0);
    expect(i.j.installed).toMatchObject({ name: "security-critic", layer: "project", commit: repo.first });
    const v = w.cli(["profiles", "validate", "--json"]);
    expect(v.j).toMatchObject({ ok: true, errors: [], warnings: [expect.stringContaining("profiles.security-critic: its project skill threat-model isn't trusted: capcomd profiles trust security-critic")] });
    const show = w.cli(["profiles", "show", "security-critic", "--json"]);
    expect(show.j).toMatchObject({ installed: { source: `${repo.bare}#security-critic`, commit: repo.first, modified: null }, skills: [{ name: "threat-model", source: "project", trust: "untrusted" }] });
    expect(w.cli(["profiles", "show", "security-critic"]).out).toContain(`Installed from ${repo.bare}#security-critic (commit ${repo.first.slice(0, 12)}`);
    // Without a terminal, trusting needs --yes.
    const asked = w.cli(["profiles", "trust", "security-critic"]);
    expect(asked.code).not.toBe(0);
    expect(asked.out).toContain("threat-model: threat-model, for the tests");
    expect(asked.out).toContain(`hash  sha256:${sha(THREAT)}`);
    expect(w.cli(["profiles", "trust", "security-critic", "--yes", "--json"]).j.trusted).toMatchObject({ name: "security-critic", already: false, skills: [{ name: "threat-model", trust: "trusted" }] });
    expect(w.cli(["profiles", "trust", "--json"]).j.profiles).toEqual([{ name: "security-critic", skills: [expect.objectContaining({ name: "threat-model", trust: "trusted" })] }]);
    expect(w.cli(["profiles", "validate", "--json"]).j.warnings).toBeUndefined();
    await repo.commit({ "profiles/security-critic/skills/threat-model/SKILL.md": md("threat-model", "v2") });
    const dry = w.cli(["profiles", "update", "security-critic", "--dry-run"]);
    expect(dry.out).toContain(`skill threat-model: sha256:${sha(THREAT)} → sha256:${sha(md("threat-model", "v2"))}`);
    expect(dry.out).toContain("Nothing was changed (--dry-run).");
    const ex = w.cli(["profiles", "export", "security-critic", "--flat", "--out", join(w.root, "shared"), "--json"]);
    expect(ex.j.exported).toMatchObject({ flat: true, dir: join(w.root, "shared", "security-critic") });
    const rm = w.cli(["profiles", "rm", "security-critic", "--json"]);
    expect(rm.j).toMatchObject({ removed: "security-critic", installed: true });
    expect(w.cli(["profiles", "update", "security-critic"]).code).not.toBe(0);
  }, 60_000);
});

