// ADR-024 §7 step 5: a profile's `skills`, resolved and pinned by hash when the profile resolves (src/profiles/skills.ts),
// as `send --skill` resolves a message's (tests/api/steer-skills-agent-pause.test.ts): from the profile's own package
// (`skills/<name>/SKILL.md`, the nearest of its overrides, itself and its ancestors), the user's ~/.claude/skills
// (`source: user`) or capcomd's (the orchestration skill, which the kernel attaches by itself to an agent that may
// spawn); unknown, too big, too many, a changed pinned hash and a file outside the package are refused by name. What the
// agent gets at its start is tests/subagents/profile-skills.test.ts.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { checkManifest, readProfiles, resolveAgent, AGENTS_SCHEMA, PROFILE_JSON_SCHEMA } from "../../src/profiles";
import { SKILL_MAX_BYTES } from "../../src/agents/skills";

const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;
const sha = (t: string) => new Bun.CryptoHasher("sha256").update(t).digest("hex");
const yaml = (lines: string[]) => lines.join("\n") + "\n";
const errorOf = (f: () => unknown) => { try { f(); } catch (e) { return (e as Error).message; } return ""; };

/** A project (repo/.capcomd/), a CAPCOMD_HOME (home/) and a HOME (user/); `P/` is the project's profiles, `U/` the
 *  user's, `S/` the user's ~/.claude/skills. */
function world(files: Record<string, string>, agents?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "capcomd-prof-skills-"));
  const dir = join(root, "repo", ".capcomd");
  mkdirSync(dir, { recursive: true });
  if (agents) writeFileSync(join(dir, "agents.json"), JSON.stringify({ schema: AGENTS_SCHEMA, agents }));
  const at = (rel: string) => join(root, rel.replace(/^P\//, "repo/.capcomd/profiles/").replace(/^U\//, "home/profiles/").replace(/^S\//, "user/.claude/skills/"));
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(at(rel)), { recursive: true }); writeFileSync(at(rel), body); }
  const source = { CAPCOMD_HOME: join(root, "home"), CAPCOMD_AGENTS_FILE: join(dir, "agents.json") };
  const cli = (args: string[]) => {
    const p = Bun.spawnSync(["bun", CLI, ...args], { env: { ...process.env, ...source, HOME: join(root, "user"), ANTHROPIC_API_KEY: "", CAPCOMD_AUTH_LEDGER: join(root, "auths.json"), CAPCOMD_ENV_LEDGER: join(root, "envs.json") } as any });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  return { root, at, source, cli, load: () => readProfiles(source.CAPCOMD_AGENTS_FILE, source) };
}
const md = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`;
const worker = "harness: { provider: claude, auth: apikey }";
const lead = "children: { allowSpawn: true, maxChildren: 2, allowedChildProfiles: [worker] }";

describe("profile skills", () => {
  test("a package's skills resolve from the nearest directory, pinned by the sha256 of each SKILL.md", () => {
    const w = world({
      "P/reviewer/profile.yaml": yaml(["name: reviewer", worker, "skills: [{ name: threat-model }, { name: owasp, source: package }]"]),
      "P/reviewer/skills/threat-model/SKILL.md": md("threat-model", "List the trust boundaries."),
      "P/reviewer/skills/owasp/SKILL.md": md("owasp", "Check the top ten."),
      // Extends reviewer: its skills list, read from reviewer's package (it has no skills/ of its own) …
      "P/strict/profile.yaml": yaml(["name: strict", "extends: reviewer"]),
      // … and one that has its own threat-model, which is nearer.
      "P/mine/profile.yaml": yaml(["name: mine", "extends: reviewer"]),
      "P/mine/skills/threat-model/SKILL.md": md("threat-model", "Mine: start from the data."),
      // A user profile that the project's override.yaml gives a skill of the override's own directory.
      "U/helper/profile.yaml": yaml(["name: helper", worker]),
      "P/helper/override.yaml": yaml(["skills: [{ name: local }]"]),
      "P/helper/skills/local/SKILL.md": md("local", "This repo's conventions."),
    });
    const set = w.load();
    const pin = (rel: string, source: "project" | "user") => {
      const text = require("fs").readFileSync(w.at(rel), "utf8") as string;
      return { name: rel.split("/").at(-2)!, source, hash: sha(text), text, path: w.at(rel) };
    };
    expect(set.profiles.reviewer!.skills).toEqual([pin("P/reviewer/skills/threat-model/SKILL.md", "project"), pin("P/reviewer/skills/owasp/SKILL.md", "project")]);
    expect(set.profiles.strict!.skills).toEqual(set.profiles.reviewer!.skills);
    expect(set.profiles.mine!.skills).toEqual([pin("P/mine/skills/threat-model/SKILL.md", "project"), pin("P/reviewer/skills/owasp/SKILL.md", "project")]);
    expect(set.profiles.helper!.skills).toEqual([pin("P/helper/skills/local/SKILL.md", "project")]);
    // A skill is no longer a "read but not used" block, and the flat spec doesn't carry it: the agent's pin does.
    expect(set.warnings).toEqual([]);
    expect(set.agents.reviewer).toEqual({ provider: "claude", auth: "apikey" });
    const r = resolveAgent("mine", w.source);
    expect(r.skills!.map((s) => [s.name, s.hash])).toEqual([["threat-model", sha(md("threat-model", "Mine: start from the data."))], ["owasp", sha(md("owasp", "Check the top ten."))]]);
    expect(resolveAgent("reviewer", w.source).profile).toEqual({ name: "reviewer", version: 1, source: "project" });
    // `null` removes an inherited list.
    const none = world({
      "P/reviewer/profile.yaml": yaml(["name: reviewer", worker, "skills: [{ name: t }]"]), "P/reviewer/skills/t/SKILL.md": md("t", "x"),
      "P/plain/profile.yaml": yaml(["name: plain", "extends: reviewer", "skills: null"]),
    });
    expect(none.load().profiles.plain!.skills).toEqual([]);
    expect(resolveAgent("plain", none.source).skills).toBeUndefined();
  });

  test("capcomd's orchestration skill is the kernel's: named by a profile that may spawn, it isn't pinned (the agent gets it once)", () => {
    const w = world({
      "P/lead/profile.yaml": yaml(["name: lead", worker, lead, "skills: [{ name: capcomd-orchestration }, { name: plan }]"]),
      "P/lead/skills/plan/SKILL.md": md("plan", "Split the work by file."),
      "P/worker/profile.yaml": yaml(["name: worker", worker]),
    });
    expect(w.load().profiles.lead!.skills.map((s) => s.name)).toEqual(["plan"]);
    const bad = world({
      "P/a/profile.yaml": yaml(["name: a", worker, "skills: [{ name: capcomd-orchestration }]"]),
      "P/b/profile.yaml": yaml(["name: b", worker, lead, `skills: [{ name: capcomd-orchestration, hash: "sha256:${"1".repeat(64)}" }]`]),
      "P/c/profile.yaml": yaml(["name: c", worker, lead, "skills: [{ name: capcomd-orchestration, source: user }]"]),
      "P/d/profile.yaml": yaml(["name: d", worker, "skills: [{ name: review, source: bundled }]"]),
      "P/worker/profile.yaml": yaml(["name: worker", worker]),
    });
    const e = errorOf(() => bad.load());
    expect(e).toContain("profiles.a: skills[0] (capcomd-orchestration): capcomd's orchestration skill goes only to an agent that may spawn (children.allowSpawn: true), which gets it by itself");
    expect(e).toContain("profiles.b: skills[0] (capcomd-orchestration): capcomd writes this skill for each agent (its limits, budget and goal branch), so a hash can't pin it: remove the hash");
    expect(e).toContain("profiles.c: skills[0] (capcomd-orchestration): that name is capcomd's own skill (source: bundled); give yours another name");
    expect(e).toContain("profiles.d: skills[0] (review): capcomd bundles no skill named review (only capcomd-orchestration)");
  });

  test("refused by name: unknown, empty, too big, too many, a changed pinned hash, a file outside the package", () => {
    const outside = mkdtempSync(join(tmpdir(), "capcomd-prof-out-"));
    writeFileSync(join(outside, "SKILL.md"), md("x", "secret instructions"));
    const eight = Array.from({ length: 8 }, (_, i) => `s${i}`);
    const files: Record<string, string> = {
      "P/missing/profile.yaml": yaml(["name: missing", worker, "skills: [{ name: nope }]"]),
      "P/single.yaml": yaml(["name: single", worker, "skills: [{ name: nope }]"]),
      "P/empty/profile.yaml": yaml(["name: empty", worker, "skills: [{ name: blank }]"]),
      "P/empty/skills/blank/SKILL.md": "  \n",
      "P/big/profile.yaml": yaml(["name: big", worker, "skills: [{ name: huge }]"]),
      "P/big/skills/huge/SKILL.md": "x".repeat(SKILL_MAX_BYTES + 1),
      "P/sum/profile.yaml": yaml(["name: sum", worker, "skills: [{ name: a }, { name: b }]"]),
      "P/sum/skills/a/SKILL.md": "a".repeat(SKILL_MAX_BYTES / 2 + 1), "P/sum/skills/b/SKILL.md": "b".repeat(SKILL_MAX_BYTES / 2 + 1),
      // Eight is the most for an agent that can't spawn (it is fine), seven for one that may (the orchestration skill is the eighth).
      "P/many/profile.yaml": yaml(["name: many", worker, `skills: [${eight.map((n) => `{ name: ${n} }`).join(", ")}]`]),
      "P/crowd/profile.yaml": yaml(["name: crowd", worker, lead, `skills: [${eight.map((n) => `{ name: ${n} }`).join(", ")}]`]),
      "P/pinned/profile.yaml": yaml(["name: pinned", worker, `skills: [{ name: tdd, hash: "sha256:${sha(md("tdd", "Write the test first."))}" }]`]),
      "P/pinned/skills/tdd/SKILL.md": md("tdd", "Write the test first, then the code."),
      "P/escape/profile.yaml": yaml(["name: escape", worker, "skills: [{ name: link }]"]),
      "P/worker/profile.yaml": yaml(["name: worker", worker]),
    };
    for (const p of ["many", "crowd"]) for (const n of eight) files[`P/${p}/skills/${n}/SKILL.md`] = md(n, `skill ${n}`);
    const w = world(files);
    mkdirSync(w.at("P/escape/skills"), { recursive: true });
    symlinkSync(outside, w.at("P/escape/skills/link"));
    const e = errorOf(() => w.load());
    expect(e).toContain("profiles.missing: skills[0] (nope): no skills/nope/SKILL.md in the profile's directory; a skill of your own (~/.claude/skills) needs source: user");
    expect(e).toContain("profiles.single: skills[0] (nope): a single-file profile has no skills/ directory (make it <name>/profile.yaml); a skill of your own (~/.claude/skills) needs source: user");
    expect(e).toContain("profiles.empty: skills[0] (blank): its SKILL.md is empty");
    expect(e).toContain(`profiles.big: skills[0] (huge): its SKILL.md is ${SKILL_MAX_BYTES + 1} bytes, over the ${SKILL_MAX_BYTES} an agent's skills may have`);
    expect(e).toContain(`profiles.sum: skills: their SKILL.md files add up to ${SKILL_MAX_BYTES + 2} bytes, over the ${SKILL_MAX_BYTES} an agent's skills may have`);
    expect(e).not.toContain("profiles.many");
    expect(e).toContain("profiles.crowd: skills: at most 7 skills (an agent that may spawn keeps room for capcomd's orchestration skill), and it names 8");
    expect(e).toContain(`profiles.pinned: skills[0] (tdd): its SKILL.md changed: it is sha256:${sha(md("tdd", "Write the test first, then the code."))} now, and the profile pins sha256:${sha(md("tdd", "Write the test first."))}. Read it, then pin the new hash`);
    expect(e).toContain(`profiles.escape: skills[0] (link): ${w.at("P/escape/skills/link/SKILL.md")} leads outside the profile's directory`);
    expect(e).not.toContain("secret instructions");
    // The source is one of three.
    expect(checkManifest({ name: "z", skills: [{ name: "t", source: "github" }] }, "profile", "z")).toEqual(["skills[0].source: must be package, user, bundled (unset: the profile's own skills/, then capcomd's)"]);
    expect((PROFILE_JSON_SCHEMA.properties.skills as any).items.properties.source.enum).toEqual(["package", "user", "bundled"]);
  });

  test("source: user is the user's ~/.claude/skills, as `capcomd send --skill` reads them; `agents show` prints each pin", () => {
    const w = world({
      "P/critic/profile.yaml": yaml(["name: critic", worker, "skills: [{ name: owasp, source: user }, { name: own }]"]),
      "P/critic/skills/own/SKILL.md": md("own", "The project's checklist."),
      "S/owasp/SKILL.md": md("owasp", "Check the top ten."),
      "P/other/profile.yaml": yaml(["name: other", worker, "skills: [{ name: absent, source: user }]"]),
    });
    const show = w.cli(["agents", "show", "critic", "--json"]);
    expect(show.out).toContain("absent"); // `other` can't resolve: the whole set is refused, naming it
    expect(JSON.parse(show.out).error.message).toContain(`profiles.other: skills[0] (absent): you have no skill named absent (~/.claude/skills/absent/SKILL.md; \`capcomd skills\` lists yours)`);
    require("fs").rmSync(w.at("P/other"), { recursive: true });
    const ok = JSON.parse(w.cli(["agents", "show", "critic", "--json"]).out);
    expect(ok.skills).toEqual([
      { name: "owasp", source: "user", hash: `sha256:${sha(md("owasp", "Check the top ten."))}`, path: null },
      { name: "own", source: "project", hash: `sha256:${sha(md("own", "The project's checklist."))}`, path: w.at("P/critic/skills/own/SKILL.md") },
    ]);
  }, 30_000);
});
