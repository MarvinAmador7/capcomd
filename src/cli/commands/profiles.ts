// capcomd profiles list|show|add|set|rm|schema|validate — named agent profiles (ADR-024 §5). list, show and validate read
// every profile the project sees (.capcomd/agents.json, and the v2 ones in .capcomd/profiles/ and ~/.capcomd/profiles/);
// show prints the files laid together and which one set each value; set and rm change the file a profile is defined in
// (its agents.json entry or its profile file, ../../profiles/write.ts), add writes agents.json or, for what only a
// profile file holds (--extends, tags, a title), a profile file. install, update and export move profile packages
// between a git repository and the profiles here (ADR-024 §2.5, §7 step 7: ../../profiles/install.ts, with a LOCK as a
// plugin's); trust is the prompt a project's profile skills wait for (decision 4: ../../profiles/trust.ts).
// `capcomd agents …` is the same command under its old name, for one minor release.
// Every subcommand supports --json (schema "capcomd.cli/v1" envelope) so an orchestrator (e.g. Hermes)
// can define and pick harness agent specs programmatically.
import { addProfileFile, agentsEntryOf, AGENTS_JSON_SCHEMA, AGENTS_SCHEMA, AgentConfigError, agentsFilePath, editProfile, lifecyclePlugins, notApplied, onlyInProfileFile, parseSetPairs, PROFILE_JSON_SCHEMA, profileFacts, profileRows, profileValues, ProfileWriteError, readAgentsFile, projectSkillTrust, readProfiles, removeProfile, trustProfileSkills, validateSpec, writeAgentsFile, type AgentSpec, type AgentsFile, type AppliedFile, type ProfileEdit, type ProfileSet, type ResolvedProfile } from "../../profiles";
import { loadAgentConfig } from "../../agents/config";
import { profileFor } from "../../auth/profiles";
import { RelayError, SCHEMA } from "../../core/errors";

const list = (v: unknown) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const num = (v: unknown, k: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new RelayError("usage", `--${k} must be a number`, "");
  return n;
};

/** Flags → partial spec (only the flags given). */
export function specFromFlags(v: Record<string, any>): Partial<AgentSpec> {
  const s: Record<string, unknown> = {};
  if (v.spec) {
    try { Object.assign(s, JSON.parse(v.spec)); } catch (e) { throw new RelayError("usage", `--spec is not valid JSON: ${(e as Error).message}`, ""); }
  }
  const set = (k: keyof AgentSpec, x: unknown) => { if (x !== undefined) s[k] = x; };
  set("provider", v.provider === "claude-code" ? "claude" : v.provider);
  set("auth", v.auth === "api-key" ? "apikey" : v.auth);
  set("description", v.description);
  set("model", v.model);
  set("effort", v.effort);
  set("maxTurns", num(v["max-turns"], "max-turns"));
  set("maxBudgetUsd", num(v.budget, "budget"));
  set("timeoutMs", num(v["timeout-ms"], "timeout-ms"));
  set("idleAfterMs", num(v["idle-after-ms"], "idle-after-ms"));
  set("checkpointEveryMs", num(v["checkpoint-every-ms"], "checkpoint-every-ms"));
  set("stuckRepeats", num(v["stuck-repeats"], "stuck-repeats"));
  set("noChangeAfterMs", num(v["no-change-after-ms"], "no-change-after-ms"));
  set("sandbox", v.sandbox);
  set("egress", list(v.egress));
  set("systemPrompt", v["system-prompt"]);
  set("appendSystemPrompt", v["append-system-prompt"]);
  set("allowedTools", list(v["allowed-tools"]));
  set("disallowedTools", list(v["disallowed-tools"]));
  return s as Partial<AgentSpec>;
}

/**
 * What `add`/`set` change (./write.ts ProfileEdit): the flags and `--spec` (v1 names), each `--set path=value` (v2 paths
 * or v1 names: limits.maxTurns=40, tags=review,security), `--unset` (removed from the profile's own file) and
 * `--default`.
 */
export function editFromFlags(v: Record<string, any>): ProfileEdit {
  const edit: ProfileEdit = { ...specFromFlags(v) };
  let pairs: Record<string, unknown> = {};
  try { pairs = parseSetPairs(v.set ?? []); } catch (e) { throw new RelayError("usage", (e as Error).message, "--set path=value, e.g. --set limits.maxTurns=40"); }
  for (const [k, x] of Object.entries(pairs)) {
    if (x && typeof x === "object" && !Array.isArray(x) && !k.startsWith("x-")) for (const [sub, y] of Object.entries(x)) edit[`${k}.${sub}`] = y;
    else edit[k] = x;
  }
  for (const k of list(v.unset) ?? []) edit[k] = null;
  if (v.default) edit.default = true;
  return edit;
}

/** Is this profile's single credential actually present? (never reads values out) */
export function readiness(name: string, spec: AgentSpec, source = process.env) {
  const kind = spec.provider === "codex" ? "codex" : "claude-code";
  const keyName = kind === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  if (spec.auth === "apikey") return { ready: !!source[keyName]?.trim() || source.CAPCOMD_CREDENTIALS === "secret", detail: source[keyName]?.trim() ? `${keyName} set` : source.CAPCOMD_CREDENTIALS === "secret" ? "boxd secret (CAPCOMD_CREDENTIALS=secret)" : `${keyName} not set` };
  const p = profileFor(kind, source);
  return { ready: !!p, detail: p ? `logged in (${p.store === "secret" ? "boxd secret" : p.snapshot})` : `not logged in: capcomd auth login ${spec.provider}` };
}

/** A value as `show` prints it: a string as written (its first line, cut at 48 characters), anything else as JSON. */
function shown(v: unknown): string {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  const line = t.split("\n")[0]!;
  return line.length > 48 ? `${line.slice(0, 47)}…` : line === t ? t : `${line}…`;
}
const appliedText = (a: AppliedFile) => `${a.as.padEnd(8)} ${a.name.padEnd(16)} ${a.layer.padEnd(7)} ${a.path ?? "(bundled with capcomd)"}`;

/**
 * What `validate` asks of this host beside the files (ADR-024 §7 step 8): a `lifecycle` plugin must be active and
 * listening to agent.changed on the running daemon (an error, as a seam no plugin provides is: plugin API §7.1; a
 * warning when no daemon runs to ask), and a `sandbox.environment` should be one its sandbox has (a warning: environments
 * are this host's, and a spawn refuses one that isn't there).
 */
async function hostChecks(set: ProfileSet): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [], warnings: string[] = [];
  const { lifecycleCheck } = await import("../../plugins/lifecycle");
  const { bootSnapshot, EnvironmentProblem } = await import("../../env/resolve");
  const { withSandbox } = await import("../../providers/run-sandbox");
  for (const [n, r] of Object.entries(set.profiles)) {
    const names = lifecyclePlugins(r.runtime.lifecycle);
    if (names.length) {
      const c = await lifecycleCheck(names);
      if (c.problem) errors.push(`profiles.${n}: ${c.problem}`);
      else if (!c.checked) warnings.push(`profiles.${n}: lifecycle names ${names.join(", ")}: no daemon is running to say whether ${names.length === 1 ? "it is" : "they are"} active (a spawn checks again)`);
    }
    if (r.runtime.environment) {
      try { bootSnapshot({ environment: r.runtime.environment, real: false }, withSandbox(process.env, r.runtime.sandboxProvider)); } catch (e) {
        if (!(e instanceof EnvironmentProblem)) throw e;
        warnings.push(`profiles.${n}: ${e.message}`);
      }
    }
  }
  return { errors, warnings };
}

/** `as`: the name it was run under; `capcomd agents` keeps its old outputs where they differ (list's `agents`, schema). */
export async function profilesCommand(pos: string[], values: Record<string, any>, as: "profiles" | "agents" = "profiles"): Promise<number> {
  const json = !!values.json;
  const cmd = `capcomd ${as}`;
  const out = (obj: Record<string, unknown>, text: string) => console.log(json ? JSON.stringify({ schema: SCHEMA, ok: true, ...obj }) : text);
  if (as === "agents" && !json) console.error("capcomd agents is now capcomd profiles (the same commands; `capcomd agents` stays until the next minor release)");
  const sub = pos[1] ?? "list";
  const name = pos[2];
  const path = agentsFilePath();
  const need = () => { if (!name) throw new RelayError("usage", `usage: ${cmd} ${sub} <name>`, ""); return name; };
  const guard = <T>(f: () => T): T => { try { return f(); } catch (e) { if (e instanceof AgentConfigError) throw new RelayError("config", e.message, `Fix the file it names (${path} or a profile file), or use \`${cmd} set\` for agents.json.`); throw e; } };
  // A v2 profile (a profile.yaml) isn't in the agents file: `add` doesn't add one of its name there.
  const v2File = (n: string) => { try { const r = readProfiles(path).profiles[n]; return r?.format === "v2" ? r.path ?? "capcomd's bundled profiles" : null; } catch { return null; } };
  // A write's refusal as the CLI says it.
  const written = <T>(f: () => T, n: string): T => {
    try { return f(); } catch (e) {
      if (!(e instanceof ProfileWriteError)) throw e;
      if (e.code === "not_found") throw new RelayError("not_found", e.message, `${cmd} list`);
      if (e.code === "conflict") throw new RelayError("conflict", e.message, `${cmd} set ${n} …`);
      throw new RelayError(e.code === "invalid" ? "config" : "usage", e.message, `${cmd} validate says what is wrong with the files as they are; ${cmd} show ${n} where each value comes from.`);
    }
  };

  switch (sub) {
    case "schema":
      // A profile file's (profile.yaml); agents.json's for `capcomd agents schema` and `capcomd profiles schema v1`.
      console.log(JSON.stringify(as === "agents" || name === "v1" ? AGENTS_JSON_SCHEMA : PROFILE_JSON_SCHEMA, null, json ? 0 : 2));
      return 0;
    case "validate": {
      let warnings: string[] = [];
      let errs: string[], set: ProfileSet | null = null;
      if (values.spec) errs = validateSpec(name ?? "candidate", specFromFlags(values));
      else { try { set = readProfiles(path); warnings = set.warnings; errs = []; } catch (e) { errs = [(e as Error).message]; } }
      if (set) {
        const host = await hostChecks(set);
        errs.push(...host.errors);
        // ADR-024 §7 step 7: an installed package edited since, and a project's skills not trusted yet.
        const { packageWarnings } = await import("../../profiles/install");
        warnings = [...warnings, ...host.warnings, ...packageWarnings(set), ...trustWarnings(set)];
      }
      console.log(json ? JSON.stringify({ schema: SCHEMA, ok: errs.length === 0, errors: errs, ...(warnings.length ? { warnings } : {}) }) : errs.length ? errs.join("\n") : ["valid", ...warnings.map((w) => `warning: ${w}`)].join("\n"));
      return errs.length ? 2 : 0;
    }
    case "list": {
      const f = guard(() => readProfiles(path));
      const rows = profileRows(f).map((r) => ({ ...r, ...profileFacts(f.profiles[r.name]!), ...readiness(r.name, f.agents[r.name]!) }));
      const warned = f.warnings.length ? `\n(${f.warnings.length} warning${f.warnings.length === 1 ? "" : "s"}: \`${cmd} validate\` lists ${f.warnings.length === 1 ? "it" : "them"})` : "";
      out({ file: path, default: f.default ?? null, [as]: rows, ...(f.warnings.length ? { warnings: f.warnings } : {}) }, rows.length ? rows.map((r) => `${r.default ? "*" : " "} ${r.name.padEnd(16)} ${r.source.padEnd(7)} ${r.provider.padEnd(7)} ${r.auth.padEnd(13)} ${(r.model ?? "-").padEnd(18)} ${r.ready ? "ready" : "NOT READY"}: ${r.detail}${r.title || r.tags.length ? `\n  ${"".padEnd(16)} ${[r.title, r.tags.length ? `tags: ${r.tags.join(", ")}` : null].filter(Boolean).join(" · ")}` : ""}${r.canLead ? `\n  ${"".padEnd(16)} leads: ${r.canLead}` : ""}${r.toolMode === "orchestrate" ? `\n  ${"".padEnd(16)} orchestrates: sees everything, runs nothing (no edits, builds or tests); its children's checks run at verify and merge` : ""}`).join("\n") + warned : `no profiles (${path}); add one: ${cmd} add <name> --provider claude|codex --auth apikey|subscription`);
      return 0;
    }
    case "show": {
      const n = need();
      const f = guard(() => readProfiles(path));
      const r = Object.hasOwn(f.profiles, n) ? f.profiles[n] : undefined;
      if (!r) throw new RelayError("not_found", `profile "${n}" not found`, `${cmd} list`);
      const spec = r.spec;
      let effective: unknown = null, error: string | null = null;
      try {
        const c = loadAgentConfig(process.env, n);
        effective = { kind: c.profile ? spec.provider : null, credentialMode: c.credentialMode, model: c.model ?? null, effort: c.effort ?? null, maxTurns: c.maxTurns ?? null, maxBudgetUsd: c.maxBudgetUsd ?? null, timeoutMs: c.timeoutMs ?? null, idleAfterMs: c.idleAfterMs, stuckRepeats: c.stuckRepeats, checkpointEveryMs: c.checkpointEveryMs, sandbox: c.codexSandbox, egress: c.egress, allowedTools: c.allowedTools ?? null, disallowedTools: c.disallowedTools, systemPrompt: c.systemPrompt ?? null, appendSystemPrompt: c.appendSystemPrompt ?? null };
      } catch (e) { error = (e as Error).message; }
      const facts = profileFacts(r), vals = profileValues(r), unused = notApplied(r.manifest), ready = readiness(n, spec), isDefault = f.default === n;
      // Its skills as an agent of it is pinned with them: where each came from and the sha256 of its SKILL.md; a
      // project's, whether you trust it (ADR-024 decision 4).
      const trust = new Map(projectSkillTrust(r.skills).map((t) => [t.name, t.trust]));
      const pins = r.skills.map((s) => ({ name: s.name, source: s.source, hash: `sha256:${s.hash}`, path: s.path, ...(trust.has(s.name) ? { trust: trust.get(s.name)! } : {}) }));
      // Where an installed package came from (its LOCK), and whether its files changed since.
      const installed = (await import("../../profiles/install")).installedFacts(r);
      const text = [
        `${n}: version ${r.version}, found in ${{ project: "the project's profiles", user: "your profiles", bundled: "capcomd's bundled profiles" }[r.source]}${isDefault ? ", the default" : ""}`,
        ...(installed ? [`Installed from ${installed.source} (commit ${installed.commit.slice(0, 12)}, ${installed.hash})${installed.error ? `; can't be checked against its LOCK: ${installed.error}` : installed.modified ? `; edited since: ${installed.modified.join(", ")} (\`${cmd} update ${n}\` replaces them)` : ""}`] : []),
        ...(facts.title || facts.tags.length ? [[facts.title, facts.tags.length ? `tags: ${facts.tags.join(", ")}` : null].filter(Boolean).join(" · ")] : []),
        `Fit: ${facts.fit}`,
        "Files, first to last (a later one wins):",
        ...r.applied.map((a, i) => `  ${String(i + 1).padStart(2)}  ${appliedText(a)}`),
        "Values (the number is the file that set it):",
        ...vals.map((v) => `  ${v.path.padEnd(30)} ${shown(v.value).padEnd(48)} ${v.from ? r.applied.indexOf(v.from) + 1 : "-"}`),
        ...(pins.length ? ["Skills (an agent of it is pinned with these SKILL.md files):", ...pins.map((s) => `  ${s.name.padEnd(24)} ${s.source.padEnd(7)} ${s.hash.slice(0, 19)}…  ${s.path ?? "~/.claude/skills"}${s.trust && s.trust !== "trusted" ? `  NOT TRUSTED${s.trust === "changed" ? " (changed since you trusted it)" : ""}: ${cmd} trust ${n}` : ""}`)] : []),
        ...(unused.length ? [`Read but not used yet by this capcomd: ${unused.join(", ")}`] : []),
        error ? `Effective config: ${error}` : `Effective config (with capcomd's defaults): ${JSON.stringify(effective)}`,
        `${ready.ready ? "Ready" : "NOT READY"}: ${ready.detail}`,
      ].join("\n");
      out({ name: n, default: isDefault, version: r.version, source: r.source, format: r.format, path: r.path, applied: r.applied, values: vals, notApplied: unused, ...facts, spec, ...(pins.length ? { skills: pins } : {}), ...(installed ? { installed } : {}), effective, error, ...ready }, text);
      return error ? 1 : 0;
    }
    case "add": {
      const n = need();
      const edit = editFromFlags(values);
      // A profile that needs what agents.json can't hold (extends, tags, a title, …) is added as a profile file.
      if (values.extends !== undefined || onlyInProfileFile(edit).length) {
        const w = written(() => addProfileFile(n, { ...(values.extends !== undefined ? { extends: values.extends } : {}), ...edit }, { path }), n);
        const isDefault = w.after.default === n;
        out({ name: n, spec: w.after.agents[n], default: isDefault, file: path, path: w.file, version: w.version }, `added ${n}${isDefault ? " (default)" : ""} → ${w.file}`);
        return 0;
      }
      const f = guard(() => readAgentsFile(path));
      const v2 = v2File(n);
      if (v2 && !f.agents[n]) throw new RelayError("conflict", `profile "${n}" is defined in ${v2}`, `${cmd} set ${n} …`);
      if (f.agents[n]) throw new RelayError("conflict", `profile "${n}" already exists`, `${cmd} set ${n} …`);
      const next = agentsEntryOf(edit);
      const errs = validateSpec(n, next);
      if (errs.length) throw new RelayError("config", errs.join("; "), "Each agent needs provider (claude|codex) and exactly one auth (apikey|subscription).");
      const file: AgentsFile = { ...f, schema: AGENTS_SCHEMA, agents: { ...f.agents, [n]: next as unknown as AgentSpec } };
      if (values.default || !file.default) file.default = n;
      guard(() => writeAgentsFile(file, path));
      out({ name: n, spec: next, default: file.default === n, file: path, path, version: 1 }, `added ${n}${file.default === n ? " (default)" : ""} → ${path}`);
      return 0;
    }
    case "set": {
      // The profile's own file, wherever it is (an agents.json entry or a profile file); its version goes up.
      const n = need();
      const f = guard(() => readProfiles(path));
      const r = Object.hasOwn(f.profiles, n) ? f.profiles[n]! : undefined;
      if (!r) throw new RelayError("not_found", `profile "${n}" not found`, `${cmd} add ${n} …`);
      const edit = editFromFlags(values);
      // As before profile files: an agents.json without a default gets the profile set.
      if (r.format === "v1" && r.path === path && guard(() => readAgentsFile(path)).default === undefined) edit.default = true;
      if (!Object.keys(edit).length) throw new RelayError("usage", `nothing to set: give the values to change`, `${cmd} set ${n} --max-turns 40, or --set limits.maxTurns=40 (--unset limits.maxTurns removes one)`);
      const w = written(() => editProfile(n, edit, { path }), n);
      const isDefault = w.after.default === n;
      const said = w.changes.map((c) => c.path).join(", ");
      out({ name: n, spec: w.after.agents[n], default: isDefault, file: path, path: w.file, changed: w.changed, version: w.version, previousVersion: w.previousVersion, changes: w.changes },
        w.changed ? `updated ${n}${isDefault ? " (default)" : ""}${w.version !== w.previousVersion ? `, version ${w.previousVersion} → ${w.version}` : ""}${said ? `: ${said}` : ""} → ${w.file}` : `${n}: nothing changed (${w.file})`);
      return 0;
    }
    case "rm": {
      const n = need();
      // An installed package (one with the LOCK `install` wrote) goes whole, with any trust given to its skills.
      const I = await import("../../profiles/install");
      let pkg: ResolvedProfile | undefined;
      try { pkg = readProfiles(path).profiles[n]; } catch { /* removeProfile says why */ }
      if (pkg && I.installedFacts(pkg)) {
        const g = I.removeInstalledProfile(n, { path, project: pkg.source === "project" });
        out({ removed: n, path: g.dir, installed: true }, `removed ${n} (${g.dir})`);
        return 0;
      }
      const w = written(() => removeProfile(n, { path }), n);
      out({ removed: n, default: w.after.default ?? null, path: w.file }, `removed ${n} (${w.file})`);
      return 0;
    }
    case "install": return installCommand(pos.slice(2), values, cmd, path);
    case "update": return updateCommand(pos.slice(2), values, cmd, path);
    case "export": return exportCommand(pos.slice(2), values, cmd, path);
    case "trust": return trustCommand(pos.slice(2), values, cmd, path);
  }
  throw new RelayError("usage", `usage: ${cmd} list|show|add|set|rm|schema|validate|install|update|export|trust`, "");
}

const short = (sha: string) => sha.slice(0, 12);
const ok = (body: Record<string, unknown>) => console.log(JSON.stringify({ schema: SCHEMA, ok: true, ...body }));
/** Text a repository wrote, as the trust prompt prints it: control and format characters shown as `\u{…}` (as
 *  `capcomd plugins trust` does), so a skill can't redraw or hide what the operator is asked about. */
const visible = (s: string) => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);

/** `trust` warnings for `validate`: each profile with skills from the project that aren't trusted as they are. */
function trustWarnings(set: ProfileSet): string[] {
  return Object.entries(set.profiles).flatMap(([n, r]) => {
    const bad = projectSkillTrust(r.skills).filter((t) => t.trust !== "trusted");
    return bad.length ? [`profiles.${n}: its project skill${bad.length > 1 ? "s" : ""} ${bad.map((t) => t.name).join(", ")} ${bad.length > 1 ? "aren't" : "isn't"} trusted${bad.some((t) => t.trust === "changed") ? " as it is now" : ""}: capcomd profiles trust ${n} (a spawn of it is refused until then)`] : [];
  });
}

/** `capcomd profiles install <owner/repo>[#<name>][@<ref>] [--project]` (ADR-024 §2.5): ../../profiles/install.ts. */
async function installCommand(args: string[], values: Record<string, any>, cmd: string, path: string): Promise<number> {
  if (args.length !== 1) throw new RelayError("usage", "install takes one source", `${cmd} install <owner/repo>[#<name>][@<ref>] [--project] (a git URL or a local repository path works too)`);
  const r = await (await import("../../profiles/install")).installProfile(args[0]!, { project: !!values.project, path });
  if (values.json) { ok({ installed: r }); return 0; }
  console.log(`Installed ${r.name}${r.version ? ` version ${r.version}` : ""} from ${r.source} (commit ${short(r.commit)}, ${r.hash}) in ${r.dir}.`);
  if (r.hiddenBy) console.log(`This project uses another profile named ${r.name} (${r.hiddenBy}), which comes first.`);
  if (r.layer === "project") console.log(`It is in the project's profiles: commit it to share it. Its skills reach its agents once you trust them: ${cmd} trust ${r.name}`);
  return 0;
}

/** `capcomd profiles update <name> [--project] [--dry-run]`: what changed, then (without --dry-run) the new files. */
async function updateCommand(args: string[], values: Record<string, any>, cmd: string, path: string): Promise<number> {
  const name = args[0];
  if (!name || args.length > 1) throw new RelayError("usage", "update takes a profile's name", `${cmd} update <name> [--project] [--dry-run]`);
  const u = await (await import("../../profiles/install")).updateProfile(name, { project: !!values.project, path, dryRun: !!values["dry-run"] });
  if (values.json) { ok({ update: u }); return 0; }
  if (u.from.hash === u.to.hash && !u.modified) {
    console.log(`${name} is up to date (${u.to.hash})${u.updated ? `; its LOCK now names commit ${short(u.to.commit)}` : ""}.`);
    return 0;
  }
  console.log(`${name}: version ${u.from.version ?? "?"} → ${u.to.version ?? "?"}, commit ${short(u.from.commit)} → ${short(u.to.commit)}`);
  console.log(`  hash ${u.from.hash}\n    → ${u.to.hash}`);
  for (const s of u.skills) console.log(`  skill ${s.name}: ${s.from ?? "(new)"} → ${s.to ?? "(removed)"}`);
  for (const [k, list] of [["changed", u.changed], ["added", u.added], ["removed", u.removed]] as const) if (list.length) console.log(`  ${k}: ${list.join(", ")}`);
  if (u.modified) console.log(`  edited since it was installed (replaced by the update): ${[...u.modified.changed, ...u.modified.added, ...u.modified.removed].join(", ")}`);
  if (!u.updated) { console.log("Nothing was changed (--dry-run)."); return 0; }
  console.log(`Updated ${u.dir}.${u.layer === "project" && u.skills.length ? ` Its changed skills reach its agents once you trust them: ${cmd} trust ${name}` : ""}`);
  return 0;
}

/** `capcomd profiles export <name> [--flat] [--out DIR]`: the profile as a package directory to share. */
async function exportCommand(args: string[], values: Record<string, any>, cmd: string, path: string): Promise<number> {
  const name = args[0];
  if (!name || args.length > 1) throw new RelayError("usage", "export takes a profile's name", `${cmd} export <name> [--flat] [--out DIR]`);
  const e = (await import("../../profiles/install")).exportProfile(name, { flat: !!values.flat, out: values.out, path });
  if (values.json) { ok({ exported: e }); return 0; }
  console.log(`Exported ${name}${e.flat ? " (flat: resolved, no extends)" : ""} to ${e.dir}: ${e.files.join(", ")}.`);
  if (e.extends) console.log(`It extends ${e.extends}: whoever installs it needs a profile of that name (or export it with --flat).`);
  return 0;
}

/**
 * `capcomd profiles trust [<name>] [--yes]` (ADR-024 decision 4): the trust prompt for a project profile's skills. It
 * shows each one that isn't trusted as it is (its name, description, file, size and sha256) and asks; --yes trusts
 * without asking. With no name, every profile with project skills and whether each is trusted.
 */
async function trustCommand(args: string[], values: Record<string, any>, cmd: string, path: string): Promise<number> {
  let set: ProfileSet;
  try { set = readProfiles(path); } catch (e) { if (e instanceof AgentConfigError) throw new RelayError("config", e.message, `${cmd} validate says what is wrong.`); throw e; }
  if (!args.length) {
    const rows = Object.entries(set.profiles).map(([n, r]) => ({ name: n, skills: projectSkillTrust(r.skills) })).filter((x) => x.skills.length);
    if (values.json) { ok({ profiles: rows }); return 0; }
    if (!rows.length) { console.log("No profile here has skills from the project's profiles (.capcomd/profiles/<name>/skills/)."); return 0; }
    for (const row of rows) for (const s of row.skills) console.log(`  ${row.name.padEnd(16)} ${s.name.padEnd(24)} ${s.trust.padEnd(9)} ${s.hash.slice(0, 19)}…  ${s.path}`);
    return 0;
  }
  const name = args[0]!;
  if (args.length > 1) throw new RelayError("usage", "trust takes a profile's name", `${cmd} trust [<name>] [--yes]`);
  const r = Object.hasOwn(set.profiles, name) ? set.profiles[name]! : undefined;
  if (!r) throw new RelayError("not_found", `profile "${name}" not found`, `${cmd} list`);
  const all = projectSkillTrust(r.skills), todo = all.filter((s) => s.trust !== "trusted");
  if (!todo.length) {
    if (values.json) ok({ trusted: { name, skills: all, already: true } });
    else console.log(all.length ? `${name}'s project skills are trusted as they are (${all.map((s) => s.name).join(", ")}).` : `${name} has no skills from the project's profiles: nothing to trust.`);
    return 0;
  }
  if (!values.json) {
    console.log(`${name}: ${todo.length} project skill${todo.length > 1 ? "s" : ""} its agents would read as instructions:`);
    for (const s of todo) {
      const text = r.skills.find((x) => x.name === s.name)!.text;
      const description = /^description:\s*(.+)$/m.exec(text.split(/^---\s*$/m)[1] ?? "")?.[1]?.trim();
      console.log(`  ${s.name}${description ? `: ${visible(description).slice(0, 200)}` : ""}`);
      console.log(`    file  ${visible(s.path)} (${Buffer.byteLength(text)} bytes)`);
      console.log(`    hash  ${s.hash}${s.trust === "changed" ? `  (you trusted ${s.trustedHash} before: it changed since)` : ""}`);
    }
  }
  if (!values.yes) {
    const ask = (await import("../prompt")).prompter();
    if (!ask.interactive) throw new RelayError("usage", `trusting ${name}'s skills needs your confirmation`, `Read them, then run it in a terminal, or pass --yes to trust them as they are.`);
    if (!(await ask.confirm(`Give ${name}'s agents these skills as they are?`, false))) { console.log("Not trusted."); return 1; }
  }
  const trusted = trustProfileSkills(r.skills);
  if (values.json) { ok({ trusted: { name, skills: trusted, already: false } }); return 0; }
  console.log(`Trusted ${todo.map((s) => s.name).join(", ")} for ${name}. A changed SKILL.md needs trusting again.`);
  return 0;
}
