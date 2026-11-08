// ADR-024 §7 step 6: writing profiles. A write changes the one file a profile is defined in and bumps its version; it is
// checked as the files would be after it and changes nothing when they wouldn't resolve, or when a later file hides it.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addProfileFile, AGENTS_SCHEMA, editOf, editProfile, profileFields, profileRev, readProfiles, removeProfile, writeAtomic, type ProfileWriteError } from "../../src/profiles";

/** A project (repo/.capcomd/) and a CAPCOMD_HOME (home/) with these files; `P/` is the project's profiles, `U/` the user's. */
function world(files: Record<string, string>, agents?: Record<string, unknown>, def?: string) {
  const root = mkdtempSync(join(tmpdir(), "capcomd-profw-"));
  const dir = join(root, "repo", ".capcomd");
  mkdirSync(dir, { recursive: true });
  if (agents) writeFileSync(join(dir, "agents.json"), JSON.stringify({ schema: AGENTS_SCHEMA, ...(def ? { default: def } : {}), agents }, null, 2));
  const at = (rel: string) => join(root, rel.replace(/^P\//, "repo/.capcomd/profiles/").replace(/^U\//, "home/profiles/"));
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(at(rel)), { recursive: true }); writeFileSync(at(rel), body); }
  const source = { CAPCOMD_HOME: join(root, "home"), CAPCOMD_AGENTS_FILE: join(dir, "agents.json") };
  const o = { path: source.CAPCOMD_AGENTS_FILE, source };
  return { at, o, agentsFile: o.path, read: (rel: string) => readFileSync(at(rel), "utf8"), load: () => readProfiles(o.path, source) };
}
const refusal = (f: () => unknown) => { try { f(); } catch (e) { const w = e as ProfileWriteError; return { code: w.code, message: w.message, field: w.field }; } return null; };
const worker = { provider: "claude", auth: "subscription", model: "sonnet", maxTurns: 20 };
const LEAD = [
  "# The lead: a worker that may spawn workers.",
  "name: lead",
  "extends: worker",
  "description: Leads a part.",
  "limits:",
  "  maxTurns: 40 # enough for a part",
  "children: { allowSpawn: true, allowedChildProfiles: [worker], maxChildren: 3 }",
  "",
].join("\n");

describe("editProfile: the profile's own file", () => {
  test("a YAML profile file: the values set, its comments kept, its version bumped (1 → 2 when it had none, placed after its name)", () => {
    const w = world({ "P/lead.yaml": LEAD }, { worker });
    const before = w.load().profiles.lead!;
    const r = editProfile("lead", { "limits.maxTurns": 60, tags: ["lead"], "harness.effort": "high", "children.maxChildren": null }, { ...w.o, rev: profileRev(before) });
    expect(r).toMatchObject({ name: "lead", file: w.at("P/lead.yaml"), format: "v2", changed: true, version: 2, previousVersion: 1 });
    expect(r.changes).toEqual([
      { path: "tags", from: undefined, to: ["lead"] },
      { path: "harness.effort", from: undefined, to: "high" },
      { path: "limits.maxTurns", from: 40, to: 60 },
      { path: "children.maxChildren", from: 3, to: undefined },
    ]);
    expect(w.read("P/lead.yaml")).toBe([
      "# The lead: a worker that may spawn workers.",
      "name: lead",
      "version: 2",
      "extends: worker",
      "description: Leads a part.",
      "limits:",
      "  maxTurns: 60 # enough for a part",
      "children: { allowSpawn: true, allowedChildProfiles: [ worker ] }", // the YAML writer pads a flow list
      "tags:",
      "  - lead",
      "harness:",
      "  effort: high",
      "",
    ].join("\n"));
    const lead = w.load().profiles.lead!;
    expect(lead.version).toBe(2);
    expect(lead.spec).toMatchObject({ maxTurns: 60, effort: "high", model: "sonnet", children: { allowSpawn: true, allowedChildProfiles: ["worker"] } });
    // The next write bumps it again; one that changes nothing writes nothing.
    expect(editProfile("lead", { "limits.maxTurns": 50 }, w.o).version).toBe(3);
    const text = w.read("P/lead.yaml");
    expect(editProfile("lead", { "limits.maxTurns": 50 }, w.o)).toMatchObject({ changed: false, version: 3, changes: [] });
    expect(w.read("P/lead.yaml")).toBe(text);
  });

  test("an agents.json entry: its v1 fields by either name; no version (it stays 1); the file's default", () => {
    const w = world({}, { worker, other: { provider: "codex", auth: "apikey" } }, "other");
    const r = editProfile("worker", { maxTurns: 30, "harness.effort": "high", "children.allowSpawn": false, model: null, default: true }, w.o);
    expect(r).toMatchObject({ format: "v1", file: w.agentsFile, changed: true, version: 1, previousVersion: 1 });
    const f = JSON.parse(readFileSync(w.agentsFile, "utf8"));
    expect(f).toEqual({ $schema: "https://capcomd.dev/schema/agents-v1.json", schema: AGENTS_SCHEMA, default: "worker", agents: { worker: { provider: "claude", auth: "subscription", maxTurns: 30, effort: "high", children: { allowSpawn: false } }, other: { provider: "codex", auth: "apikey" } } });
    // What only a profile file holds is refused, naming where it could go.
    expect(refusal(() => editProfile("worker", { tags: ["x"] }, w.o))).toEqual({ code: "invalid", field: "tags", message: `tags: an agents.json entry can't hold it (only the v1 fields: \`capcomd profiles schema v1\`); put the profile in a profile file (${w.at("P/worker.yaml")}) to set it` });
  });

  test("a JSON profile file stays JSON", () => {
    const w = world({ "U/critic.json": JSON.stringify({ name: "critic", harness: { provider: "codex", auth: "subscription" } }) });
    expect(editProfile("critic", { "sandbox.codex": "read-only" }, w.o)).toMatchObject({ version: 2, changes: [{ path: "sandbox.codex", from: undefined, to: "read-only" }] });
    expect(JSON.parse(w.read("U/critic.json"))).toEqual({ name: "critic", version: 2, harness: { provider: "codex", auth: "subscription" }, sandbox: { codex: "read-only" } });
  });

  test("refused, nothing written: a stale rev, an invalid value, a widening child, a value an override hides, what capcomd sets", () => {
    const w = world({ "P/lead.yaml": LEAD, "P/lead/override.yaml": "harness: { effort: low }\n" }, { worker });
    const text = w.read("P/lead.yaml");
    expect(refusal(() => editProfile("lead", { "limits.maxTurns": 1 }, { ...w.o, rev: "0000000000000000" }))).toMatchObject({ code: "conflict", message: `profile "lead" changed since it was read (its rev is now ${profileRev(w.load().profiles.lead!)}): read it again, then retry` });
    expect(refusal(() => editProfile("lead", { "limits.maxTurns": 0 }, w.o))).toMatchObject({ code: "invalid", message: expect.stringMatching(/^the change would leave the profiles unreadable, so nothing was changed: profiles\.lead: limits\.maxTurns/) });
    expect(refusal(() => editProfile("lead", { "harness.effort": "high" }, w.o))).toEqual({ code: "invalid", field: "harness.effort", message: `harness.effort: ${w.at("P/lead/override.yaml")} (an override of lead) sets it after this profile's own file, so a change here wouldn't show: change it there` });
    // Checked on every profile the write would leave: a worker wider than the lead that spawns it, a lead with no children.
    expect(refusal(() => editProfile("worker", { maxTurns: 100 }, w.o))?.message).toContain(`profiles.lead.children: child profile "worker" is wider than its parent`);
    expect(refusal(() => editProfile("lead", { "children.allowedChildProfiles": null }, w.o))?.message).toContain("allowSpawn requires at least one allowedChildProfiles entry");
    for (const k of ["version", "name", "sharing.source", "schema"]) expect(refusal(() => editProfile("lead", { [k]: 9 }, w.o))).toMatchObject({ code: "invalid", field: k });
    expect(refusal(() => editProfile("nobody", { maxTurns: 1 }, w.o))).toMatchObject({ code: "not_found" });
    expect(w.read("P/lead.yaml")).toBe(text);
  });

  test("a parent's edit: the child keeps its own version, and its rev changes", () => {
    const w = world({ "P/lead.yaml": LEAD }, { worker });
    const rev = profileRev(w.load().profiles.lead!);
    editProfile("worker", { model: "opus" }, w.o);
    const lead = w.load().profiles.lead!;
    expect([lead.version, lead.spec.model, profileRev(lead) === rev]).toEqual([1, "opus", false]);
  });
});

describe("addProfileFile and removeProfile", () => {
  test("add: <the project's profiles>/<name>.yaml at version 1; a name that exists is a conflict", () => {
    const w = world({}, { worker });
    const r = addProfileFile("reviewer", { extends: "worker", tags: ["review"], "tools.allowed": ["Read", "Grep"], "permissions.report": true }, w.o);
    expect(r).toMatchObject({ file: w.at("P/reviewer.yaml"), version: 1, changed: true });
    expect(w.read("P/reviewer.yaml")).toBe("schema: capcomd.profile/v2\nname: reviewer\nversion: 1\nextends: worker\ntags:\n  - review\ntools:\n  allowed:\n    - Read\n    - Grep\npermissions:\n  report: true\n");
    expect(w.load().profiles.reviewer!.spec).toMatchObject({ provider: "claude", model: "sonnet", allowedTools: ["Read", "Grep"] });
    expect(refusal(() => addProfileFile("worker", { extends: "worker" }, w.o))).toMatchObject({ code: "conflict", message: `profile "worker" already exists (${w.agentsFile})` });
    expect(refusal(() => addProfileFile("orphan", { extends: "nobody" }, w.o))?.message).toContain('extends "nobody", which isn\'t a profile here');
    expect(existsSync(w.at("P/orphan.yaml"))).toBe(false);
  });

  test("a link a checkout put where the write's temporary file would be is never written through", () => {
    const w = world({}, { worker });
    // The project's checkout carries a link at the name a write used to take (<file>.tmp-<pid>), to a file of yours.
    const victim = w.at("home/victim.txt");
    mkdirSync(dirname(victim), { recursive: true });
    writeFileSync(victim, "yours\n");
    const file = w.at("P/reviewer.yaml");
    mkdirSync(dirname(file), { recursive: true });
    symlinkSync(victim, `${file}.tmp-${process.pid}`);
    symlinkSync(victim, `${w.agentsFile}.tmp-${process.pid}`);
    addProfileFile("reviewer", { extends: "worker" }, w.o);
    editProfile("worker", { "limits.maxTurns": 30 }, w.o);
    expect(readFileSync(victim, "utf8")).toBe("yours\n");
    expect(w.read("P/reviewer.yaml")).toContain("name: reviewer");
    expect(w.load().profiles.worker!.spec.maxTurns).toBe(30);
    expect(lstatSync(w.agentsFile).isSymbolicLink()).toBe(false);
    // A write that fails leaves no temporary file of its own (a directory is in the file's place).
    mkdirSync(w.at("P/taken.yaml/inside"), { recursive: true });
    expect(() => writeAtomic(w.at("P/taken.yaml"), "x\n")).toThrow();
    expect(readdirSync(dirname(file)).filter((n) => n.includes(".tmp-")).sort()).toEqual([`reviewer.yaml.tmp-${process.pid}`]);
  });

  test("rm: a single profile file, or an agents.json entry (the default moves on); a package and a parent others extend stay", () => {
    const w = world({ "P/lead.yaml": LEAD, "P/solo/profile.yaml": "name: solo\nharness: { provider: claude, auth: subscription }\n" }, { worker, other: { provider: "codex", auth: "apikey" } }, "worker");
    expect(refusal(() => removeProfile("worker", w.o))?.message).toContain('extends "worker", which isn\'t a profile here');
    expect(refusal(() => removeProfile("solo", w.o))).toMatchObject({ code: "read_only", message: `profile "solo" is a package (${w.at("P/solo/profile.yaml")} and the files beside it): remove its directory yourself` });
    removeProfile("lead", w.o);
    expect(existsSync(w.at("P/lead.yaml"))).toBe(false);
    expect(removeProfile("worker", w.o).after.default).toBe("other");
    expect(Object.keys(w.load().profiles)).toEqual(["other", "solo"]);
  });

  test("default: true moves the default, as agents.json's does: the layer's profile file that had it loses it (a write: its version goes up)", () => {
    // As `capcomd setup project` leaves a project: worker.yaml is the default.
    const WORKER = "# Mine.\nschema: capcomd.profile/v2\nname: worker\nversion: 1\ndefault: true\nharness: { provider: claude, auth: subscription }\n";
    const w = world({ "P/worker.yaml": WORKER, "U/mine.yaml": "name: mine\ndefault: true\nharness: { provider: codex, auth: apikey }\n" });
    expect(w.load().default).toBe("worker");
    addProfileFile("rev", { provider: "claude", auth: "subscription", default: true }, w.o);
    expect(w.load().default).toBe("rev");
    expect(w.read("P/worker.yaml")).toBe("# Mine.\nschema: capcomd.profile/v2\nname: worker\nversion: 2\nharness: { provider: claude, auth: subscription }\n");
    // set --default on another moves it again, from rev.yaml; the user's own default (another layer) is left alone.
    editProfile("worker", { default: true }, w.o);
    expect([w.load().default, w.load().profiles.rev!.version, w.read("P/rev.yaml")]).toEqual(["worker", 2, expect.not.stringContaining("default")]);
    expect(w.read("U/mine.yaml")).toContain("default: true");
    // A JSON profile file loses it too; an agents.json entry made the default takes it from a profile file.
    const j = world({ "P/a.json": JSON.stringify({ name: "a", default: true, harness: { provider: "claude", auth: "subscription" } }) }, { b: { provider: "codex", auth: "apikey" } });
    editProfile("b", { default: true }, j.o);
    expect([j.load().default, JSON.parse(j.read("P/a.json"))]).toEqual(["b", { name: "a", version: 2, harness: { provider: "claude", auth: "subscription" } }]);
  });
});

// Spec §7.1: reading profiles outside the daemon only warns about a provider no daemon is running to confirm; a write
// that names one is refused, as a candidate is (`capcomd agents validate --spec`), and one a running daemon lists is fine.
describe("a write naming a provider no daemon is running to confirm", () => {
  /** The running daemon's listing in this world's home: this process stands in for the daemon (its pid is alive). */
  const listing = (w: ReturnType<typeof world>, seams: Array<{ kind: "sandbox" | "agent"; name: string }>) => {
    mkdirSync(join(w.o.source.CAPCOMD_HOME, "state"), { recursive: true });
    const plugin = { name: "third-party", version: "1.0.0", apiVersion: 1, runtime: "in-process", source: "user", state: "active", enabled: true, cause: null, hooks: [], seams, hooksSuspended: false, stats: {} };
    writeFileSync(join(w.o.source.CAPCOMD_HOME, "state", "plugins.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), plugins: [plugin] }));
  };
  const SOLO = "name: solo\nharness: { provider: claude, auth: subscription }\n";
  const unconfirmed = (at: string, field: string, kind: string, name: string) => `${at}: ${field} "${name}" isn't a built-in ${kind} provider, and no daemon is running to say whether one of its plugins provides it, so nothing was changed`;

  test("set and add are refused and change nothing; with a daemon that lists it they write", () => {
    const w = world({ "P/solo.yaml": SOLO }, { worker });
    const agents = readFileSync(w.agentsFile, "utf8");
    expect(refusal(() => editProfile("solo", { "harness.provider": "gemini" }, w.o))).toMatchObject({ code: "invalid", message: expect.stringContaining(unconfirmed("profiles.solo", "harness.provider", "agent", "gemini")) });
    expect(refusal(() => editProfile("solo", { "sandbox.provider": "modal" }, w.o))?.message).toContain(unconfirmed("profiles.solo", "sandbox.provider", "sandbox", "modal"));
    expect(refusal(() => editProfile("worker", { provider: "gemini" }, w.o))?.message).toContain(unconfirmed("agents.worker", "provider", "agent", "gemini"));
    expect(refusal(() => addProfileFile("cloud", { extends: "worker", "sandbox.provider": "modal" }, w.o))?.message).toContain(unconfirmed("profiles.cloud", "sandbox.provider", "sandbox", "modal"));
    expect([w.read("P/solo.yaml"), readFileSync(w.agentsFile, "utf8"), existsSync(w.at("P/cloud.yaml"))]).toEqual([SOLO, agents, false]);
    listing(w, [{ kind: "agent", name: "gemini" }, { kind: "sandbox", name: "modal" }]);
    editProfile("solo", { "harness.provider": "gemini", "sandbox.provider": "modal" }, w.o);
    addProfileFile("cloud", { extends: "worker", "sandbox.provider": "modal" }, w.o);
    expect(w.load()).toMatchObject({ warnings: [], profiles: { solo: { spec: { provider: "gemini" }, runtime: { sandboxProvider: "modal" } }, cloud: { runtime: { sandboxProvider: "modal" } } } });
  });

  test("a profile that already names one can still be changed otherwise, and removed", () => {
    const w = world({ "P/solo.yaml": "name: solo\nharness: { provider: claude, auth: subscription }\nsandbox: { provider: modal }\n", "P/other.yaml": SOLO.replace("solo", "other") });
    expect(w.load().warnings).toHaveLength(1);
    expect(editProfile("solo", { "limits.maxTurns": 30 }, w.o)).toMatchObject({ changed: true, version: 2 });
    expect(editProfile("other", { "limits.maxTurns": 30 }, w.o)).toMatchObject({ changed: true, version: 2 });
    expect(refusal(() => editProfile("solo", { "sandbox.provider": "fly" }, w.o))?.message).toContain(unconfirmed("profiles.solo", "sandbox.provider", "sandbox", "fly"));
    removeProfile("solo", w.o);
    expect(w.load().warnings).toEqual([]);
  });
});

describe("profileFields: the rows a client edits", () => {
  test("each value with its type, encoding, display, the file that sets it and whether PUT can change it", () => {
    const w = world({ "P/lead.yaml": LEAD.replace("description: Leads a part.", "description: Leads a part.\nprompt: { append: Plan first. }\nx-perfloop: { gestures: [scroll] }\ntools: { mcp: [{ name: gh, command: [gh-mcp, --token, ghp_secret] }, { name: docs, command: [docs-mcp] }] }"), "P/lead/override.yaml": "harness: { effort: low }\n" }, { worker });
    const lead = w.load().profiles.lead!;
    const f = Object.fromEntries(profileFields(lead).map((r) => [r.id, r]));
    expect(f["limits.maxTurns"]).toEqual({ id: "limits.maxTurns", type: "number", label: "Turns", help: null, value: "40", display: "40 turns", choices: [], source: "profile", from: 1, editable: true, untrusted: false });
    expect(f["harness.model"]).toMatchObject({ value: "sonnet", source: "inherited", from: 0, editable: true });
    expect(f["harness.effort"]).toMatchObject({ value: "low", source: "override", from: 2, editable: false, help: `${w.at("P/lead/override.yaml")} sets it after the profile's own file: change it there` });
    expect(f["harness.effort"]!.choices.map((c) => c.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(f["limits.maxBudgetUsd"]).toMatchObject({ value: null, display: "No limit", source: "unset", from: null, editable: true });
    expect(f["children.allowedChildProfiles"]).toMatchObject({ type: "list", value: '["worker"]', display: "worker" });
    expect(f["description"]).toMatchObject({ value: "Leads a part.", untrusted: true });
    // A prompt's text is never served; a value outside the rows is read-only, as its file has it.
    expect(f["prompt.append"]).toMatchObject({ type: "info", value: null, display: "Set (11 characters)", editable: false });
    expect(f["x-perfloop.gestures"]).toMatchObject({ type: "info", label: "x-perfloop.gestures", value: null, display: '["scroll"]', editable: false, untrusted: true });
    expect(JSON.stringify(profileFields(lead))).not.toContain("Plan first");
    // An MCP server by its name only: its command line may hold a token.
    expect(f["tools.mcp"]).toMatchObject({ type: "info", value: null, display: "gh, docs", editable: false });
    expect(JSON.stringify(profileFields(lead))).not.toContain("ghp_secret");
    // PUT's values: an editable row with a value of its type.
    expect(editOf(lead, { "limits.maxTurns": "60", tags: '["a"]', "permissions.report": "false", "harness.model": null })).toEqual({ edit: { "limits.maxTurns": 60, tags: ["a"], "permissions.report": false, "harness.model": null } });
    expect(editOf(lead, { "harness.effort": "high" })).toMatchObject({ field: "harness.effort" });
    expect(editOf(lead, { "limits.maxTurns": "many" })).toEqual({ field: "limits.maxTurns", message: "limits.maxTurns: must be a number" });
    expect(editOf(lead, { "tools.mode": "sideways" })).toEqual({ field: "tools.mode", message: "tools.mode: must be one of execute, orchestrate" });
    expect(editOf(lead, { tags: "a,b" })).toEqual({ field: "tags", message: "tags: must be a JSON array of strings" });
    expect(editOf(lead, { "prompt.append": "x" })).toMatchObject({ field: "prompt.append" });
    expect(editOf(lead, { bogus: "1" })).toMatchObject({ field: "bogus" });
    // An agents.json entry: the rows it can't hold say so.
    const v1 = Object.fromEntries(profileFields(w.load().profiles.worker!).map((r) => [r.id, r]));
    expect(v1["tags"]).toMatchObject({ editable: false, help: "Lowercase words a planner matches on (review, security). An agents.json entry can't hold it: move the profile to a profile file to set it" });
    expect(v1["limits.maxTurns"]).toMatchObject({ editable: true, value: "20" });
  });
});
