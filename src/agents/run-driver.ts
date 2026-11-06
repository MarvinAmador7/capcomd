// Who drives a run: the provider of its planner agent. `capcomd run --planner-provider claude|codex` (POST /v1/runs
// `driver`) runs the project's planner profile on that provider: unchanged when the profile already uses it, else with
// its provider swapped and the model and login of that provider (another of the project's profiles on it, e.g. the
// `codex-worker` capcomd setup writes; else the provider's default model). GET /v1/run-options lists the same choice.
import { agentEffort, agentModel } from "./config";
import { agentsFilePath, encodeAgentRef, providerDefaultEffort, providerEfforts, providerKind, readProfiles, resolveAgent, type AgentSpec, type AuthMode, type Provider } from "../profiles";
import { agentSeam } from "../plugins/agents";
import { profileFor } from "../auth/profiles";
import { modelProblem } from "../config/models";
import { env as envVar } from "../utils/env";

type Env = Record<string, string | undefined>;
/** The providers a run can be driven by (harness.v1 `DriverOption.provider`): the built-in ones. */
export const DRIVERS = ["claude", "codex"] as const satisfies readonly Provider[];
export type Driver = (typeof DRIVERS)[number];
export const DRIVER_LABEL: Record<Driver, string> = { claude: "Claude Code", codex: "Codex" };
/** A provider as people know it (its `describe().label`). */
const labelOf = (provider: Provider) => agentSeam(provider)?.describe().label ?? provider;
export const DEFAULT_PLANNER = "planner";

/** A sandbox a check is made for, by name (for the command that fixes it) and as the app calls it. */
export interface SandboxWhere { name: string; label: string }

/**
 * Is this provider's credential in this auth mode present, the way capcomd checks logins (never reads a value out)?
 * Plan logins are per sandbox (`source`'s CAPCOMD_SANDBOX); `where` names that sandbox in the reason.
 */
export function credentialReady(provider: Provider, auth: AuthMode, source: Env = process.env, where?: SandboxWhere): { ready: boolean; reason: string | null } {
  if (auth === "apikey") {
    const key = agentSeam(provider)?.describe().secretName ?? `${provider.toUpperCase()}_API_KEY`;
    if (source[key]?.trim() || envVar("CREDENTIALS", source)?.toLowerCase() === "secret") return { ready: true, reason: null };
    return { ready: false, reason: `${key} isn't set` };
  }
  if (profileFor(providerKind(provider), source)) return { ready: true, reason: null };
  return { ready: false, reason: where ? `Not logged in to ${labelOf(provider)} for ${where.label} (run \`capcomd auth login ${provider} --sandbox ${where.name}\`)` : `Not logged in to ${labelOf(provider)} (run capcomd auth login ${provider})` };
}

/** The planner profile `capcomd run` would use, if one may spawn: `name`, else the profile named "planner". */
export function plannerProfile(name?: string, source: Env = process.env): string | null {
  try {
    const r = resolveAgent(name ?? DEFAULT_PLANNER, source);
    return (r.spec as { children?: { allowSpawn?: boolean } } | null)?.children?.allowSpawn ? r.name : null;
  } catch { return null; }
}

export type DriverChoice =
  | { ok: true; profile: string; ref: string; provider: Provider; auth: AuthMode; model: string | null; effort: string | null; defaultEffort: string | null; swapped: boolean }
  | { ok: false; code: "planner" | "login" | "effort" | "model"; reason: string; model: string | null; defaultEffort: string | null };

/** The provider a profile runs on (null: no such profile). */
export function profileProvider(name: string, source: Env = process.env): Provider {
  return readProfiles(agentsFilePath(source), source).agents[name]?.provider ?? "claude";
}

const levelsText = (provider: Provider) => providerEfforts(provider).join(", ");
/** Is `effort` one of `provider`'s levels? The reason when it isn't. */
export function effortProblem(provider: Provider, effort: string): string | null {
  return providerEfforts(provider).includes(effort) ? null : `effort ${JSON.stringify(effort)} isn't a ${labelOf(provider)} level: use one of ${levelsText(provider)}`;
}

/**
 * The planner `name` (default: "planner") run on `provider`, with `effort` and `chosenModel` when given, or why it can't
 * be. `effort`: what the planner runs with (the chosen level, else its profile's, else null: the CLI's default);
 * `defaultEffort`: what a run without a chosen level gets (its profile's, else the provider's default). `chosenModel`
 * (`--planner-model`, POST /v1/runs `model`): one of the models the harness offers (src/config/models.ts), passed to the
 * CLI as a profile's model is (Claude Code `--model`, Codex `-m`); `model` is then that one.
 */
export function plannerDriver(provider: Provider, name?: string, source: Env = process.env, chosen?: string, where?: SandboxWhere, chosenModel?: string): DriverChoice {
  const fallback = providerDefaultEffort(provider);
  if (chosen !== undefined) { const bad = effortProblem(provider, chosen); if (bad) return { ok: false, code: "effort", reason: bad, model: null, defaultEffort: fallback }; }
  if (chosenModel !== undefined) { const bad = modelProblem(provider, chosenModel, source); if (bad) return { ok: false, code: "model", reason: bad, model: null, defaultEffort: fallback }; }
  const planner = plannerProfile(name, source);
  if (!planner) return { ok: false, code: "planner", reason: name ? `profile ${name} can't plan: it doesn't exist or may not spawn agents (children.allowSpawn)` : `No planner profile (run capcomd setup)`, model: null, defaultEffort: fallback };
  const file = readProfiles(agentsFilePath(source), source);
  const spec = file.agents[planner]!;
  if (spec.provider === provider) {
    const c = credentialReady(provider, spec.auth, source, where), model = chosenModel ?? agentModel(spec, source) ?? null;
    const configured = agentEffort(spec, source) ?? null, defaultEffort = configured ?? fallback;
    if (!c.ready) return { ok: false, code: "login", reason: c.reason!, model, defaultEffort };
    // A chosen effort or model is a plain override (it widens nothing).
    const set: Record<string, unknown> = { ...(chosen !== undefined ? { effort: chosen } : {}), ...(chosenModel !== undefined ? { model: chosenModel } : {}) };
    const ref = Object.keys(set).length ? encodeAgentRef(planner, { set }) : planner;
    return { ok: true, profile: planner, ref, provider, auth: spec.auth, model, effort: chosen ?? configured, defaultEffort, swapped: false };
  }
  // The project's own choice for this provider: a profile on it (its children first: the workers it would spawn).
  const names = [...(spec.children?.allowedChildProfiles ?? []), ...Object.keys(file.agents)];
  const peer = names.map((n) => file.agents[n]).find((s): s is AgentSpec => !!s && s.provider === provider);
  const modes: AuthMode[] = peer ? [peer.auth] : [spec.auth, spec.auth === "apikey" ? "subscription" : "apikey"];
  const checks = modes.map((m) => ({ m, c: credentialReady(provider, m, source, where) }));
  const ok = checks.find((x) => x.c.ready);
  const model = chosenModel ?? agentModel({ model: peer?.model }, source) ?? null;
  const configured = agentEffort({ effort: peer?.effort }, source) ?? null, defaultEffort = configured ?? fallback;
  if (!ok) return { ok: false, code: "login", reason: checks[0]!.c.reason!, model, defaultEffort };
  // Overrides only narrow a profile unless the operator asks: a provider swap is the operator's (the API client's) choice.
  // `null` drops the other provider's model and effort.
  const set: Record<string, unknown> = { provider, auth: ok.m, model: chosenModel ?? peer?.model ?? null, effort: chosen ?? peer?.effort ?? null };
  return { ok: true, profile: planner, ref: encodeAgentRef(planner, { set, operator: true }), provider, auth: ok.m, model, effort: chosen ?? configured, defaultEffort, swapped: true };
}
