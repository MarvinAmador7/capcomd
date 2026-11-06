// capcomd profiles list|show|add|set|rm|schema|validate — named agent profiles (ADR-024 §5). list, show and validate read
// every profile the project sees (.capcomd/agents.json, and the v2 ones in .capcomd/profiles/ and ~/.capcomd/profiles/);
// show prints the files laid together and which one set each value; add, set and rm edit the agents file.
// `capcomd agents …` is the same command under its old name, for one minor release.
// Every subcommand supports --json (schema "capcomd.cli/v1" envelope) so an orchestrator (e.g. Hermes)
// can define and pick harness agent specs programmatically.
import { AGENTS_JSON_SCHEMA, AGENTS_SCHEMA, AgentConfigError, agentsFilePath, notApplied, PROFILE_JSON_SCHEMA, profileRows, profileValues, readAgentsFile, readProfiles, validateSpec, writeAgentsFile, type AgentSpec, type AgentsFile, type AppliedFile } from "../../profiles";
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
  // A v2 profile (a profile.yaml) isn't in the agents file: these commands don't edit it.
  const v2File = (n: string) => { try { const r = readProfiles(path).profiles[n]; return r?.format === "v2" ? r.path ?? "capcomd's bundled profiles" : null; } catch { return null; } };

  switch (sub) {
    case "schema":
      // A profile file's (profile.yaml); agents.json's for `capcomd agents schema` and `capcomd profiles schema v1`.
      console.log(JSON.stringify(as === "agents" || name === "v1" ? AGENTS_JSON_SCHEMA : PROFILE_JSON_SCHEMA, null, json ? 0 : 2));
      return 0;
    case "validate": {
      let warnings: string[] = [];
      const errs = values.spec ? validateSpec(name ?? "candidate", specFromFlags(values)) : (() => { try { warnings = readProfiles(path).warnings; return []; } catch (e) { return [(e as Error).message]; } })();
      console.log(json ? JSON.stringify({ schema: SCHEMA, ok: errs.length === 0, errors: errs, ...(warnings.length ? { warnings } : {}) }) : errs.length ? errs.join("\n") : ["valid", ...warnings.map((w) => `warning: ${w}`)].join("\n"));
      return errs.length ? 2 : 0;
    }
    case "list": {
      const f = guard(() => readProfiles(path));
      const rows = profileRows(f).map((r) => ({ ...r, ...readiness(r.name, f.agents[r.name]!) }));
      const warned = f.warnings.length ? `\n(${f.warnings.length} warning${f.warnings.length === 1 ? "" : "s"}: \`${cmd} validate\` lists ${f.warnings.length === 1 ? "it" : "them"})` : "";
      out({ file: path, default: f.default ?? null, [as]: rows, ...(f.warnings.length ? { warnings: f.warnings } : {}) }, rows.length ? rows.map((r) => `${r.default ? "*" : " "} ${r.name.padEnd(16)} ${r.source.padEnd(7)} ${r.provider.padEnd(7)} ${r.auth.padEnd(13)} ${(r.model ?? "-").padEnd(18)} ${r.ready ? "ready" : "NOT READY"}: ${r.detail}${r.canLead ? `\n  ${"".padEnd(16)} leads: ${r.canLead}` : ""}${r.toolMode === "orchestrate" ? `\n  ${"".padEnd(16)} orchestrates: sees everything, runs nothing (no edits, builds or tests); its children's checks run at verify and merge` : ""}`).join("\n") + warned : `no profiles (${path}); add one: ${cmd} add <name> --provider claude|codex --auth apikey|subscription`);
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
      const vals = profileValues(r), unused = notApplied(r.manifest), ready = readiness(n, spec), isDefault = f.default === n;
      const text = [
        `${n}: version ${r.version}, found in ${{ project: "the project's profiles", user: "your profiles", bundled: "capcomd's bundled profiles" }[r.source]}${isDefault ? ", the default" : ""}`,
        "Files, first to last (a later one wins):",
        ...r.applied.map((a, i) => `  ${String(i + 1).padStart(2)}  ${appliedText(a)}`),
        "Values (the number is the file that set it):",
        ...vals.map((v) => `  ${v.path.padEnd(30)} ${shown(v.value).padEnd(48)} ${v.from ? r.applied.indexOf(v.from) + 1 : "-"}`),
        ...(unused.length ? [`Read but not used yet by this capcomd: ${unused.join(", ")}`] : []),
        error ? `Effective config: ${error}` : `Effective config (with capcomd's defaults): ${JSON.stringify(effective)}`,
        `${ready.ready ? "Ready" : "NOT READY"}: ${ready.detail}`,
      ].join("\n");
      out({ name: n, default: isDefault, version: r.version, source: r.source, format: r.format, path: r.path, applied: r.applied, values: vals, notApplied: unused, spec, effective, error, ...ready }, text);
      return error ? 1 : 0;
    }
    case "add":
    case "set": {
      const n = need();
      const f = guard(() => readAgentsFile(path));
      const v2 = v2File(n);
      if (v2 && !f.agents[n]) throw new RelayError(sub === "add" ? "conflict" : "usage", `profile "${n}" is defined in ${v2}, which \`${cmd} ${sub}\` doesn't edit`, `Edit ${v2}.`);
      if (sub === "add" && f.agents[n]) throw new RelayError("conflict", `profile "${n}" already exists`, `${cmd} set ${n} …`);
      if (sub === "set" && !f.agents[n]) throw new RelayError("not_found", `profile "${n}" not found`, `${cmd} add ${n} …`);
      const next: Record<string, unknown> = { ...(f.agents[n] ?? {}), ...specFromFlags(values) };
      for (const k of list(values.unset) ?? []) delete next[k];
      const errs = validateSpec(n, next);
      if (errs.length) throw new RelayError("config", errs.join("; "), "Each agent needs provider (claude|codex) and exactly one auth (apikey|subscription).");
      const file: AgentsFile = { ...f, schema: AGENTS_SCHEMA, agents: { ...f.agents, [n]: next as unknown as AgentSpec } };
      if (values.default || !file.default) file.default = n;
      guard(() => writeAgentsFile(file, path));
      out({ name: n, spec: next, default: file.default === n, file: path }, `${sub === "add" ? "added" : "updated"} ${n}${file.default === n ? " (default)" : ""} → ${path}`);
      return 0;
    }
    case "rm": {
      const n = need();
      const f = guard(() => readAgentsFile(path));
      const v2 = v2File(n);
      if (v2 && !f.agents[n]) throw new RelayError("usage", `profile "${n}" is defined in ${v2}, which \`${cmd} rm\` doesn't edit`, `Remove ${v2}.`);
      if (!f.agents[n]) throw new RelayError("not_found", `profile "${n}" not found`, `${cmd} list`);
      const { [n]: _, ...rest } = f.agents;
      const file = { ...f, agents: rest, default: f.default === n ? Object.keys(rest)[0] : f.default };
      if (!file.default) delete (file as any).default;
      guard(() => writeAgentsFile(file, path));
      out({ removed: n, default: file.default ?? null }, `removed ${n}`);
      return 0;
    }
  }
  throw new RelayError("usage", `usage: ${cmd} list|show|add|set|rm|schema|validate`, "");
}
