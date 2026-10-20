// capcomd agents add|set|list|show|rm|schema|validate — named agent profiles (.capcomd/agents.json).
// Every subcommand supports --json (schema "capcomd.cli/v1" envelope) so an orchestrator (e.g. Hermes)
// can define and pick harness agent specs programmatically.
import { AGENTS_JSON_SCHEMA, AGENTS_SCHEMA, AgentConfigError, agentsFilePath, readAgentsFile, validateSpec, writeAgentsFile, type AgentSpec } from "../../agents/profiles";
import { credentialModeFor, loadAgentConfig } from "../../agents/config";
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
  set("maxTurns", num(v["max-turns"], "max-turns"));
  set("maxBudgetUsd", num(v.budget, "budget"));
  set("timeoutMs", num(v["timeout-ms"], "timeout-ms"));
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

export async function agentsCommand(pos: string[], values: Record<string, any>): Promise<number> {
  const json = !!values.json;
  const out = (obj: Record<string, unknown>, text: string) => console.log(json ? JSON.stringify({ schema: SCHEMA, ok: true, ...obj }) : text);
  const sub = pos[1] ?? "list";
  const name = pos[2];
  const path = agentsFilePath();
  const need = () => { if (!name) throw new RelayError("usage", `usage: capcomd agents ${sub} <name>`, ""); return name; };
  const guard = <T>(f: () => T): T => { try { return f(); } catch (e) { if (e instanceof AgentConfigError) throw new RelayError("config", e.message, `Fix ${path} or use \`capcomd agents set\`.`); throw e; } };

  switch (sub) {
    case "schema":
      console.log(JSON.stringify(AGENTS_JSON_SCHEMA, null, json ? 0 : 2));
      return 0;
    case "validate": {
      const errs = values.spec ? validateSpec(name ?? "candidate", specFromFlags(values)) : (() => { try { readAgentsFile(path); return []; } catch (e) { return [(e as Error).message]; } })();
      console.log(json ? JSON.stringify({ schema: SCHEMA, ok: errs.length === 0, errors: errs }) : errs.length ? errs.join("\n") : "valid");
      return errs.length ? 2 : 0;
    }
    case "list": {
      const f = guard(() => readAgentsFile(path));
      const rows = Object.entries(f.agents).map(([n, s]) => ({ name: n, provider: s.provider, auth: s.auth, model: s.model ?? null, default: f.default === n, ...readiness(n, s) }));
      out({ file: path, default: f.default ?? null, agents: rows }, rows.length ? rows.map((r) => `${r.default ? "*" : " "} ${r.name.padEnd(16)} ${r.provider.padEnd(7)} ${r.auth.padEnd(13)} ${(r.model ?? "-").padEnd(18)} ${r.ready ? "ready" : "NOT READY"}: ${r.detail}`).join("\n") : `no agents (${path}); add one: capcomd agents add <name> --provider claude|codex --auth apikey|subscription`);
      return 0;
    }
    case "show": {
      const n = need();
      const f = guard(() => readAgentsFile(path));
      const spec = f.agents[n];
      if (!spec) throw new RelayError("not_found", `agent "${n}" not found`, "capcomd agents list");
      let effective: unknown = null, error: string | null = null;
      try {
        const c = loadAgentConfig(process.env, n);
        effective = { kind: c.profile ? spec.provider : null, credentialMode: c.credentialMode, model: c.model ?? null, maxTurns: c.maxTurns, maxBudgetUsd: c.maxBudgetUsd, timeoutMs: c.timeoutMs, sandbox: c.codexSandbox, egress: c.egress, allowedTools: c.allowedTools, disallowedTools: c.disallowedTools, systemPrompt: c.systemPrompt ?? null, appendSystemPrompt: c.appendSystemPrompt ?? null };
      } catch (e) { error = (e as Error).message; }
      out({ name: n, default: f.default === n, spec, effective, error, ...readiness(n, spec) }, JSON.stringify({ name: n, spec, effective, error }, null, 2));
      return error ? 1 : 0;
    }
    case "add":
    case "set": {
      const n = need();
      const f = guard(() => readAgentsFile(path));
      if (sub === "add" && f.agents[n]) throw new RelayError("conflict", `agent "${n}" already exists`, `capcomd agents set ${n} …`);
      if (sub === "set" && !f.agents[n]) throw new RelayError("not_found", `agent "${n}" not found`, `capcomd agents add ${n} …`);
      const next: Record<string, unknown> = { ...(f.agents[n] ?? {}), ...specFromFlags(values) };
      for (const k of list(values.unset) ?? []) delete next[k];
      const errs = validateSpec(n, next);
      if (errs.length) throw new RelayError("config", errs.join("; "), "Each agent needs provider (claude|codex) and exactly one auth (apikey|subscription).");
      const file = { ...f, schema: AGENTS_SCHEMA, agents: { ...f.agents, [n]: next as unknown as AgentSpec } };
      if (values.default || !file.default) file.default = n;
      guard(() => writeAgentsFile(file, path));
      out({ name: n, spec: next, default: file.default === n, file: path }, `${sub === "add" ? "added" : "updated"} ${n}${file.default === n ? " (default)" : ""} → ${path}`);
      return 0;
    }
    case "rm": {
      const n = need();
      const f = guard(() => readAgentsFile(path));
      if (!f.agents[n]) throw new RelayError("not_found", `agent "${n}" not found`, "capcomd agents list");
      const { [n]: _, ...rest } = f.agents;
      const file = { ...f, agents: rest, default: f.default === n ? Object.keys(rest)[0] : f.default };
      if (!file.default) delete (file as any).default;
      guard(() => writeAgentsFile(file, path));
      out({ removed: n, default: file.default ?? null }, `removed ${n}`);
      return 0;
    }
  }
  throw new RelayError("usage", "usage: capcomd agents list|show|add|set|rm|schema|validate", "");
}
