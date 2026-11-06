// `capcomd profiles` (ADR-024 §5, §7 step 2): list, show with the files laid together and which one set each value,
// schema, validate; `capcomd agents` is the same command under its old name.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { capcomd } from "../helpers/engine";

/** A project (repo/.capcomd/) and a CAPCOMD_HOME (home/) with these files; `P/` is the project's profiles, `U/` the user's. */
function world(files: Record<string, string>, agents?: Record<string, unknown>, def?: string) {
  const root = mkdtempSync(join(tmpdir(), "capcomd-profcli-"));
  const cap = join(root, "repo", ".capcomd");
  mkdirSync(cap, { recursive: true });
  if (agents) writeFileSync(join(cap, "agents.json"), JSON.stringify({ schema: "capcomd.agents/v1", ...(def ? { default: def } : {}), agents }));
  const at = (rel: string) => join(root, rel.replace(/^P\//, "repo/.capcomd/profiles/").replace(/^U\//, "home/profiles/"));
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(at(rel)), { recursive: true }); writeFileSync(at(rel), body); }
  // Own ledgers: "ready" reads the auth ledger, and the checkout's real .relay/ must not leak in.
  const env = { CAPCOMD_HOME: join(root, "home"), CAPCOMD_AGENTS_FILE: join(cap, "agents.json"), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", CAPCOMD_AUTH_LEDGER: join(root, "auths.json"), CAPCOMD_ENV_LEDGER: join(root, "envs.json") };
  return { at, env, agentsFile: join(cap, "agents.json") };
}
const worker = { provider: "claude", auth: "subscription", model: "sonnet", maxTurns: 20, appendSystemPrompt: "Be brief.\nReally." };
const LEAD = ["name: lead", "extends: worker", "version: 2", "description: Leads a part.", "prompt: { append: null }",
  "tools: { mode: orchestrate }", "children: { allowSpawn: true, allowedChildProfiles: [worker], maxChildren: 3 }", "skills: [{ name: tdd }]",
  "harness: { cliVersion: \">=2.1\" }"].join("\n");
const TDD = "---\nname: tdd\n---\nWrite the failing test first.\n";
const tddHash = `sha256:${new Bun.CryptoHasher("sha256").update(TDD).digest("hex")}`;
const json = (r: { stdout: string }) => JSON.parse(r.stdout);

describe("capcomd profiles", () => {
  const w = world({ "P/lead/profile.yaml": LEAD, "P/lead/skills/tdd/SKILL.md": TDD, "P/lead/override.yaml": "limits: { maxTurns: 30 }\nharness: { effort: high }\n" }, { worker }, "worker");

  test("list: every profile with its layer and version; --json rows under `profiles`", async () => {
    const t = await capcomd(["profiles", "list"], w.env);
    expect(t.code).toBe(0);
    expect(t.stderr).toBe("");
    expect(t.stdout).toMatch(/^\* worker {11}project claude {2}subscription/m);
    expect(t.stdout).toMatch(/^ {2}lead {13}project claude/m);
    expect(t.stdout).toContain("(1 warning: `capcomd profiles validate` lists it)");
    const j = json(await capcomd(["profiles", "list", "--json"], w.env));
    expect(j).toMatchObject({ ok: true, file: w.agentsFile, default: "worker", warnings: ["profiles.lead: harness.cliVersion is read but not used yet by this capcomd"] });
    expect(j.agents).toBeUndefined();
    expect(j.profiles.map((p: any) => [p.name, p.source, p.format, p.version, p.toolMode, p.ready])).toEqual([["worker", "project", "v1", 1, "execute", false], ["lead", "project", "v2", 2, "orchestrate", false]]);
    expect(j.profiles[1].applied.map((a: any) => [a.as, a.name, a.path])).toEqual([["extends", "worker", w.agentsFile], ["profile", "lead", w.at("P/lead/profile.yaml")], ["override", "lead", w.at("P/lead/override.yaml")]]);
  }, 30_000);

  test("show: the files laid together, first to last, and the file that set each value", async () => {
    const t = await capcomd(["profiles", "show", "lead"], w.env);
    expect(t.code).toBe(0);
    const lines = t.stdout.split("\n");
    expect(lines[0]).toBe("lead: version 2, found in the project's profiles");
    expect(lines.slice(1, 6)).toEqual([
      "Fit: orchestrates: sees everything, runs nothing; Claude Code, sonnet, high effort, medium cost; up to 30 turns; leads up to 3 worker helpers, any depth",
      "Files, first to last (a later one wins):",
      `   1  extends  worker           project ${w.agentsFile}`,
      `   2  profile  lead             project ${w.at("P/lead/profile.yaml")}`,
      `   3  override lead             project ${w.at("P/lead/override.yaml")}`,
    ]);
    const value = (path: string) => lines.find((l) => l.startsWith(`  ${path} `))?.trim().split(/\s{2,}/);
    expect(value("harness.model")).toEqual(["harness.model", "sonnet", "1"]);
    expect(value("harness.effort")).toEqual(["harness.effort", "high", "3"]);
    expect(value("limits.maxTurns")).toEqual(["limits.maxTurns", "30", "3"]);
    expect(value("tools.mode")).toEqual(["tools.mode", "orchestrate", "2"]);
    expect(value("children.allowedChildProfiles")).toEqual(["children.allowedChildProfiles", '["worker"]', "2"]);
    expect(value("prompt.append")).toBeUndefined(); // lead removes what it inherits
    expect(t.stdout).toContain("Read but not used yet by this capcomd: harness.cliVersion");
    // Its skills (ADR-024 §7 step 5): each one's source, hash and file.
    expect(t.stdout).toContain(`Skills (an agent of it is pinned with these SKILL.md files):\n  tdd                      project ${tddHash.slice(0, 19)}…  ${w.at("P/lead/skills/tdd/SKILL.md")}\n`);
    expect(t.stdout).toContain("NOT READY: not logged in: capcomd auth login claude");
    // A string is shown by its first line.
    expect((await capcomd(["profiles", "show", "worker"], w.env)).stdout).toMatch(/^ {2}prompt\.append +Be brief\.… +1$/m);

    const j = json(await capcomd(["profiles", "show", "lead", "--json"], w.env));
    expect(j).toMatchObject({ ok: true, name: "lead", default: false, version: 2, source: "project", format: "v2", path: w.at("P/lead/profile.yaml"), notApplied: ["harness.cliVersion"], error: null, ready: false, title: null, tags: [], canReport: true, cost: "medium" });
    expect(j.spec).toEqual({ provider: "claude", auth: "subscription", model: "sonnet", effort: "high", description: "Leads a part.", maxTurns: 30, toolMode: "orchestrate", children: { allowSpawn: true, allowedChildProfiles: ["worker"], maxChildren: 3 } });
    expect(j.skills).toEqual([{ name: "tdd", source: "project", hash: tddHash, path: w.at("P/lead/skills/tdd/SKILL.md") }]);
    expect(j.values.find((v: any) => v.path === "limits.maxTurns")).toEqual({ path: "limits.maxTurns", value: 30, from: { as: "override", name: "lead", layer: "project", path: w.at("P/lead/override.yaml") } });
    expect(j.effective).toMatchObject({ model: "sonnet", effort: "high", maxTurns: 30 });
    const missing = await capcomd(["profiles", "show", "nobody", "--json"], w.env);
    expect(missing.code).toBe(3);
    expect(json(missing).error).toMatchObject({ code: "not_found", message: 'profile "nobody" not found', hint: "capcomd profiles list" });
  }, 30_000);

  test("schema: a profile file's (v2); `schema v1`: agents.json's", async () => {
    expect(json(await capcomd(["profiles", "schema", "--json"], w.env))).toMatchObject({ $id: "https://capcomd.dev/schema/profile-v2.json" });
    expect(json(await capcomd(["profiles", "schema", "v1", "--json"], w.env)).$defs.agent.required).toEqual(["provider", "auth"]);
  }, 30_000);

  test("validate, and add/set/rm on agents.json, as `capcomd agents` did; hints name `capcomd profiles`", async () => {
    expect(json(await capcomd(["profiles", "validate", "--json"], w.env))).toMatchObject({ ok: true, errors: [], warnings: ["profiles.lead: harness.cliVersion is read but not used yet by this capcomd"] });
    const own = world({}, { worker });
    expect((await capcomd(["profiles", "add", "cx", "--provider", "codex", "--auth", "apikey", "--json"], own.env)).code).toBe(0);
    const again = await capcomd(["profiles", "add", "cx", "--provider", "codex", "--auth", "apikey", "--json"], own.env);
    expect(json(again).error).toMatchObject({ code: "conflict", hint: "capcomd profiles set cx …" });
    expect(json(await capcomd(["profiles", "rm", "cx", "--json"], own.env))).toMatchObject({ removed: "cx" });
    const v2 = await capcomd(["profiles", "set", "lead", "--model", "opus", "--json"], w.env);
    expect(json(v2).error.message).toBe(`profile "lead" is defined in ${w.at("P/lead/profile.yaml")}, which \`capcomd profiles set\` doesn't edit`);
  }, 30_000);
});

describe("capcomd agents: the old name, for one minor release", () => {
  const w = world({ "P/lead/profile.yaml": LEAD, "P/lead/skills/tdd/SKILL.md": TDD }, { worker }, "worker");

  test("says the new name (not in --json); list --json keeps its rows under `agents`; schema stays agents.json's", async () => {
    const t = await capcomd(["agents", "list"], w.env);
    expect(t.code).toBe(0);
    expect(t.stderr).toBe("capcomd agents is now capcomd profiles (the same commands; `capcomd agents` stays until the next minor release)\n");
    const j = await capcomd(["agents", "list", "--json"], w.env);
    expect(j.stderr).toBe("");
    expect(json(j).agents.map((a: any) => [a.name, a.source])).toEqual([["worker", "project"], ["lead", "project"]]);
    expect(json(j).profiles).toBeUndefined();
    expect(json(await capcomd(["agents", "schema", "--json"], w.env)).$defs.agent.required).toEqual(["provider", "auth"]);
    expect(json(await capcomd(["agents", "show", "lead", "--json"], w.env)).applied.length).toBe(2);
    expect(json(await capcomd(["agents", "rm", "nobody", "--json"], w.env)).error.hint).toBe("capcomd agents list");
  }, 30_000);

  test("--help: profiles' usage under either name", async () => {
    for (const name of ["profiles", "agents"]) {
      const r = await capcomd([name, "--help"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`capcomd ${name} `);
      expect(r.stdout).not.toContain("capcomd serve");
    }
    expect((await capcomd(["profiles", "--help"])).stdout).toContain("show <name>: the files laid together and which one set each value");
  }, 30_000);
});
