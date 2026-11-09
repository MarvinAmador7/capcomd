// ADR-024 §7 step 9: `capcomd profiles migrate`. agents.json's entries become profile files beside it, each resolving
// exactly as before (checked before anything is written), and agents.json stays with a note, or as it was with --keep.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENTS_SCHEMA, MIGRATED_NOTE, migrateProfiles, readAgentsFile, readProfiles, type ProfileWriteError } from "../../src/profiles";
import { capcomd } from "../helpers/engine";

/** A project (repo/.capcomd/) and a CAPCOMD_HOME (home/) with these files; `P/` is the project's profiles, `U/` the user's. */
function world(files: Record<string, string>, agents?: Record<string, unknown>, def?: string) {
  const root = mkdtempSync(join(tmpdir(), "capcomd-profm-"));
  const dir = join(root, "repo", ".capcomd");
  mkdirSync(dir, { recursive: true });
  if (agents) writeFileSync(join(dir, "agents.json"), JSON.stringify({ schema: AGENTS_SCHEMA, ...(def ? { default: def } : {}), agents }, null, 2));
  const at = (rel: string) => join(root, rel.replace(/^P\//, "repo/.capcomd/profiles/").replace(/^U\//, "home/profiles/"));
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(at(rel)), { recursive: true }); writeFileSync(at(rel), body); }
  const source = { CAPCOMD_HOME: join(root, "home"), CAPCOMD_AGENTS_FILE: join(dir, "agents.json") };
  const o = { path: source.CAPCOMD_AGENTS_FILE, source };
  return { root, dir, at, o, source, agentsFile: o.path, read: (rel: string) => readFileSync(at(rel), "utf8"), load: () => readProfiles(o.path, source) };
}
const refusal = (f: () => unknown) => { try { f(); } catch (e) { const w = e as ProfileWriteError; return { code: w.code, message: w.message }; } return null; };
/** What every profile pins, and the default: what a migration must not change. */
const pins = (w: ReturnType<typeof world>) => { const s = w.load(); return { default: s.default, specs: Object.fromEntries(Object.entries(s.profiles).map(([n, p]) => [n, [p.spec, p.version, p.source]])) }; };

// The profiles `capcomd setup project` wrote into agents.json before profile files, as people edited them.
const V1 = {
  worker: { provider: "claude", auth: "subscription", model: "claude-sonnet-4-5", maxTurns: 40, egress: ["github.com"], sandbox: "workspace-write" },
  reviewer: { provider: "claude", auth: "subscription", allowedTools: ["Read", "Grep", "Bash(bun test:*)"], appendSystemPrompt: "Review the diff.\nSay what you checked.\n" },
  lead: { provider: "claude", auth: "subscription", description: "Leads a part.", toolMode: "orchestrate", children: { allowSpawn: true, maxChildren: 3, maxDepth: 1, allowedChildProfiles: ["worker"] } },
  planner: { provider: "codex", auth: "apikey", effort: "high", toolMode: "orchestrate", children: { allowSpawn: true, allowedChildProfiles: ["worker", "lead"] }, jobs: { foregroundMs: 5000 }, context: { providers: [{ name: "memory" }] } },
};

describe("migrateProfiles", () => {
  test("every entry becomes <name>.yaml at version 1, resolving to the same spec; agents.json keeps a note and no entries", () => {
    const w = world({}, V1, "worker");
    const before = pins(w);
    const m = migrateProfiles(w.o);
    expect(m).toEqual({
      file: w.agentsFile, dir: join(w.dir, "profiles"), agentsFile: "updated", dryRun: false, left: [],
      migrated: ["worker", "reviewer", "lead", "planner"].map((name) => ({ name, path: w.at(`P/${name}.yaml`), default: name === "worker" })),
    });
    // Every profile pins what it pinned, from its profile file now; the default is the same profile.
    expect(pins(w)).toEqual(before);
    const after = w.load();
    expect(Object.values(after.profiles).map((p) => [p.format, p.path]).sort()).toEqual(Object.keys(V1).sort().map((n) => ["v2", w.at(`P/${n}.yaml`)]));
    expect(after.warnings).toEqual([]);
    expect(w.read("P/worker.yaml")).toBe([
      "# Moved from agents.json by `capcomd profiles migrate`. `capcomd profiles show <name>` says where each value comes from.",
      "schema: capcomd.profile/v2",
      "name: worker",
      "version: 1",
      "default: true",
      "harness:",
      "  provider: claude",
      "  auth: subscription",
      "  model: claude-sonnet-4-5",
      "sandbox:",
      "  egress:",
      "    - github.com",
      "  codex: workspace-write",
      "limits:",
      "  maxTurns: 40",
      "",
    ].join("\n"));
    // A prompt of several lines stays in the file, as a block.
    expect(w.read("P/reviewer.yaml")).toContain("prompt:\n  append: |\n    Review the diff.\n    Say what you checked.\n");
    expect(w.read("P/planner.yaml")).toContain("jobs:\n  foregroundMs: 5000\n");
    // agents.json stays, with a note and nothing in effect; it still reads as a v1 file.
    expect(JSON.parse(readFileSync(w.agentsFile, "utf8"))).toEqual({
      $schema: "https://capcomd.dev/schema/agents-v1.json", $comment: MIGRATED_NOTE, schema: AGENTS_SCHEMA, agents: {},
    });
    // The note names no folder of this machine: agents.json is committed and shared.
    expect(readFileSync(w.agentsFile, "utf8")).not.toContain(w.root);
    expect(readAgentsFile(w.agentsFile).agents).toEqual({});
    // Nothing to do the second time.
    expect(migrateProfiles(w.o)).toMatchObject({ migrated: [], left: [], agentsFile: "none", dryRun: true });
  });

  test("--dry-run says what it would write and writes nothing; --keep leaves agents.json as it was (a profile file wins, validate warns)", () => {
    const w = world({}, { worker: V1.worker }, "worker");
    const text = readFileSync(w.agentsFile, "utf8");
    expect(migrateProfiles({ ...w.o, dryRun: true })).toMatchObject({ dryRun: true, agentsFile: "updated", migrated: [{ name: "worker", path: w.at("P/worker.yaml"), default: true }] });
    expect(existsSync(w.at("P"))).toBe(false);
    expect(readFileSync(w.agentsFile, "utf8")).toBe(text);
    expect(migrateProfiles({ ...w.o, keep: true })).toMatchObject({ dryRun: false, agentsFile: "kept" });
    expect(readFileSync(w.agentsFile, "utf8")).toBe(text);
    const s = w.load();
    expect([s.profiles.worker!.format, s.default]).toEqual(["v2", "worker"]);
    expect(s.warnings).toEqual([`${w.agentsFile}: agents.worker is hidden by ${w.at("P/worker.yaml")} (a v2 profile wins over agents.json)`]);
  });

  test("profiles around the entries resolve as before: a profile file that extends one, an override of one; entries that stay", () => {
    const w = world({
      "P/critic.yaml": "name: critic\nextends: reviewer\ntags: [review]\nlimits: { maxTurns: 10 }\n",
      "P/worker/override.yaml": "limits: { maxTurns: 60 }\n",
      "P/lead.yaml": "name: lead\nharness: { provider: claude, auth: apikey }\n",
    }, { worker: V1.worker, reviewer: V1.reviewer, lead: V1.lead, notes: { provider: "claude", auth: "subscription", systemPrompt: "notes.md" } }, "notes");
    const before = pins(w);
    const m = migrateProfiles(w.o);
    expect(m.migrated.map((x) => x.name)).toEqual(["worker", "reviewer"]);
    // lead's entry is hidden by lead.yaml already, and notes' prompt would read as a file's name in a profile file: both
    // stay in agents.json (with its default, which names notes), for the person to deal with.
    expect(m.left).toEqual([
      { name: "lead", why: `${w.at("P/lead.yaml")} hides it already` },
      { name: "notes", why: expect.stringContaining("a prompt of it is one word ending .md or .txt") },
    ]);
    expect(pins(w)).toEqual(before);
    // The override is laid over the new file as it was over the entry; the file holds the entry's own value.
    expect(w.read("P/worker.yaml")).toContain("maxTurns: 40");
    expect(w.load().profiles.worker!.applied.map((a) => a.as)).toEqual(["profile", "override"]);
    const left = JSON.parse(readFileSync(w.agentsFile, "utf8"));
    expect([Object.keys(left.agents), left.default]).toEqual([["lead", "notes"], "notes"]);
  });

  test("the user's agents.json (no project) moves to the user's profiles", () => {
    const root = mkdtempSync(join(tmpdir(), "capcomd-profm-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "agents.json"), JSON.stringify({ schema: AGENTS_SCHEMA, agents: { solo: { provider: "codex", auth: "subscription" } } }));
    const o = { path: join(home, "agents.json"), source: { CAPCOMD_HOME: home } };
    expect(migrateProfiles(o)).toMatchObject({ dir: join(home, "profiles"), migrated: [{ name: "solo", path: join(home, "profiles", "solo.yaml") }] });
    expect(readProfiles(o.path, o.source).profiles.solo).toMatchObject({ source: "user", format: "v2", spec: { provider: "codex", auth: "subscription" } });
  });

  test("profiles that don't read: refused, nothing written; no agents.json: nothing to do", () => {
    const bad = world({}, { worker: V1.worker, lead: { ...V1.lead, children: { allowSpawn: true, allowedChildProfiles: ["ghost"] } } });
    const text = readFileSync(bad.agentsFile, "utf8");
    expect(refusal(() => migrateProfiles(bad.o))).toMatchObject({ code: "invalid", message: expect.stringContaining("the profiles can't be read, so nothing was migrated") });
    expect(readFileSync(bad.agentsFile, "utf8")).toBe(text);
    expect(existsSync(bad.at("P"))).toBe(false);
    const w = world({ "P/worker.yaml": "name: worker\nharness: { provider: claude, auth: subscription }\n" });
    expect(migrateProfiles(w.o)).toMatchObject({ migrated: [], agentsFile: "none" });
    expect(existsSync(w.agentsFile)).toBe(false);
  });
});

describe("capcomd profiles migrate", () => {
  test("text and --json; add then writes a profile file, since the project's profiles are files now", async () => {
    const w = world({}, { worker: V1.worker, lead: V1.lead }, "worker");
    const env = { CAPCOMD_HOME: w.source.CAPCOMD_HOME, CAPCOMD_AGENTS_FILE: w.agentsFile, CAPCOMD_AUTH_LEDGER: join(w.root, "auths.json"), CAPCOMD_ENV_LEDGER: join(w.root, "envs.json") };
    const dry = await capcomd(["profiles", "migrate", "--dry-run"], env);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain(`Would move 2 profiles from ${w.agentsFile} to ${join(w.dir, "profiles")}, each resolving as before:`);
    expect(dry.stdout).toContain(`  worker           → ${w.at("P/worker.yaml")} (the default)`);
    expect(dry.stdout).toContain("Nothing was written (--dry-run).");
    const r = await capcomd(["profiles", "migrate", "--json"], env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, migration: { agentsFile: "updated", dryRun: false, migrated: [{ name: "worker", default: true }, { name: "lead", default: false }] } });
    expect((await capcomd(["profiles", "migrate"], env)).stdout).toContain(`Nothing to migrate: ${w.agentsFile} has no profiles.`);
    const add = await capcomd(["profiles", "add", "cx", "--provider", "codex", "--auth", "subscription", "--json"], env);
    expect(JSON.parse(add.stdout)).toMatchObject({ ok: true, path: w.at("P/cx.yaml"), version: 1 });
    expect(JSON.parse(readFileSync(w.agentsFile, "utf8")).agents).toEqual({});
    const extra = await capcomd(["profiles", "migrate", "worker"], env);
    expect([extra.code, extra.stdout + extra.stderr]).toEqual([expect.any(Number), expect.stringContaining("migrate moves every profile of the agents file")]);
    expect(extra.code).not.toBe(0);
  });

  test("a project whose planner can't spawn the context consolidator: migrate moves it as it is and says what adds it (ADR-025 D17)", async () => {
    // As `capcomd setup project` wrote it before the consolidator existed: a planner that spawns workers and leads.
    const w = world({}, V1, "worker");
    const env = { CAPCOMD_HOME: w.source.CAPCOMD_HOME, CAPCOMD_AGENTS_FILE: w.agentsFile, CAPCOMD_AUTH_LEDGER: join(w.root, "auths.json"), CAPCOMD_ENV_LEDGER: join(w.root, "envs.json") };
    const r = await capcomd(["profiles", "migrate", "--json"], env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, migration: { agentsFile: "updated" }, consolidator: { missing: "profile", command: "capcomd setup project" } });
    expect(w.load().agents.planner!.children!.allowedChildProfiles).toEqual(["worker", "lead"]);
    // With the profile there and the planner still without it, the note is the command that lets the planner spawn it.
    const v = world({ "P/context-consolidator.yaml": "name: context-consolidator\nharness: { provider: codex, auth: apikey }\n" }, { worker: V1.worker, lead: V1.lead, planner: V1.planner }, "worker");
    const text = (await capcomd(["profiles", "migrate", "--dry-run"], { ...env, CAPCOMD_HOME: v.source.CAPCOMD_HOME, CAPCOMD_AGENTS_FILE: v.agentsFile })).stdout;
    expect(text).toContain("Note: the project's planner may spawn worker, lead but not context-consolidator, so a run's lessons don't reach the project's memory (its changes still wait for a person). Run `capcomd profiles set planner --set children.allowedChildProfiles=worker,lead,context-consolidator` in the project's checkout.");
    // A project whose planner lists it (as setup writes it now): nothing to say.
    const ok = world({ "P/context-consolidator.yaml": "name: context-consolidator\nharness: { provider: codex, auth: apikey }\n" }, { worker: V1.worker, planner: { ...V1.planner, children: { allowSpawn: true, allowedChildProfiles: ["worker", "context-consolidator"] } } }, "worker");
    expect((await capcomd(["profiles", "migrate", "--dry-run"], { ...env, CAPCOMD_HOME: ok.source.CAPCOMD_HOME, CAPCOMD_AGENTS_FILE: ok.agentsFile })).stdout).not.toContain("Note:");
  });
});
