// Who drives a run: the provider of its planner agent. `capcomd run --planner-provider claude|codex` (POST /v1/runs
// `driver`) runs the project's planner profile on that provider: unchanged when the profile already uses it, else with
// its provider swapped and the model and login of that provider (another of the project's profiles on it, e.g. the
// `codex-worker` capcomd setup writes; else the provider's default model). GET /v1/run-options lists the same choice.
import { agentEffort, agentModel } from "./config";
import { agentsFilePath, encodeAgentRef, PROVIDER_DEFAULT_EFFORT, PROVIDER_EFFORTS, PROVIDER_KIND, readAgentsFile, resolveAgent, type AgentSpec, type AuthMode, type Provider } from "./profiles";
import { profileFor } from "../auth/profiles";
import { env as envVar } from "../utils/env";

type Env = Record<string, string | undefined>;
export const DRIVERS = ["claude", "codex"] as const satisfies readonly Provider[];
export const DRIVER_LABEL: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };
export const DEFAULT_PLANNER = "planner";

/** Is this provider's credential in this auth mode present, the way capcomd checks logins (never reads a value out)? */
export function credentialReady(provider: Provider, auth: AuthMode, source: Env = process.env): { ready: boolean; reason: string | null } {
  if (auth === "apikey") {
    const key = provider === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    if (source[key]?.trim() || envVar("CREDENTIALS", source)?.toLowerCase() === "secret") return { ready: true, reason: null };
    return { ready: false, reason: `${key} isn't set` };
  }
  return profileFor(PROVIDER_KIND[provider], source) ? { ready: true, reason: null } : { ready: false, reason: `Not logged in to ${DRIVER_LABEL[provider]} (run capcomd auth login ${provider})` };
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
  | { ok: false; code: "planner" | "login" | "effort"; reason: string; model: string | null; defaultEffort: string | null };

/** The provider a profile runs on (null: no such profile). */
export function profileProvider(name: string, source: Env = process.env): Provider {
  return readAgentsFile(agentsFilePath(source)).agents[name]?.provider ?? "claude";
}

const levelsText = (provider: Provider) => PROVIDER_EFFORTS[provider].join(", ");
/** Is `effort` one of `provider`'s levels? The reason when it isn't. */
export function effortProblem(provider: Provider, effort: string): string | null {
  return PROVIDER_EFFORTS[provider].includes(effort) ? null : `effort ${JSON.stringify(effort)} isn't a ${DRIVER_LABEL[provider]} level: use one of ${levelsText(provider)}`;
}

/**
 * The planner `name` (default: "planner") run on `provider`, with `effort` when given, or why it can't be.
 * `effort`: what the planner runs with (the chosen level, else its profile's, else null: the CLI's default);
 * `defaultEffort`: what a run without a chosen level gets (its profile's, else the provider's default).
 */
export function plannerDriver(provider: Provider, name?: string, source: Env = process.env, chosen?: string): DriverChoice {
  const fallback = PROVIDER_DEFAULT_EFFORT[provider];
  if (chosen !== undefined) { const bad = effortProblem(provider, chosen); if (bad) return { ok: false, code: "effort", reason: bad, model: null, defaultEffort: fallback }; }
  const planner = plannerProfile(name, source);
  if (!planner) return { ok: false, code: "planner", reason: name ? `profile ${name} can't plan: it doesn't exist or may not spawn agents (children.allowSpawn)` : `No planner profile (run capcomd setup)`, model: null, defaultEffort: fallback };
  const file = readAgentsFile(agentsFilePath(source));
  const spec = file.agents[planner]!;
  if (spec.provider === provider) {
    const c = credentialReady(provider, spec.auth, source), model = agentModel(spec, source) ?? null;
    const configured = agentEffort(spec, source) ?? null, defaultEffort = configured ?? fallback;
    if (!c.ready) return { ok: false, code: "login", reason: c.reason!, model, defaultEffort };
    // A chosen effort is a plain override (it widens nothing).
    const ref = chosen !== undefined ? encodeAgentRef(planner, { set: { effort: chosen } }) : planner;
    return { ok: true, profile: planner, ref, provider, auth: spec.auth, model, effort: chosen ?? configured, defaultEffort, swapped: false };
  }
  // The project's own choice for this provider: a profile on it (its children first: the workers it would spawn).
  const names = [...(spec.children?.allowedChildProfiles ?? []), ...Object.keys(file.agents)];
  const peer = names.map((n) => file.agents[n]).find((s): s is AgentSpec => !!s && s.provider === provider);
  const modes: AuthMode[] = peer ? [peer.auth] : [spec.auth, spec.auth === "apikey" ? "subscription" : "apikey"];
  const checks = modes.map((m) => ({ m, c: credentialReady(provider, m, source) }));
  const ok = checks.find((x) => x.c.ready);
  const model = agentModel({ model: peer?.model }, source) ?? null;
  const configured = agentEffort({ effort: peer?.effort }, source) ?? null, defaultEffort = configured ?? fallback;
  if (!ok) return { ok: false, code: "login", reason: checks[0]!.c.reason!, model, defaultEffort };
  // Overrides only narrow a profile unless the operator asks: a provider swap is the operator's (the API client's) choice.
  // `null` drops the other provider's model and effort.
  const set: Record<string, unknown> = { provider, auth: ok.m, model: peer?.model ?? null, effort: chosen ?? peer?.effort ?? null };
  return { ok: true, profile: planner, ref: encodeAgentRef(planner, { set, operator: true }), provider, auth: ok.m, model, effort: chosen ?? configured, defaultEffort, swapped: true };
}
