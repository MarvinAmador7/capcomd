// The agent seam (docs/spec/plugin-api.md §7.3, ADR-023 step 4): which agent providers are active here, selected by
// name (a profile's `provider`), and each one as the runner's AgentAdapter. Only the daemon has a plugin host: once
// `capcomd serve` has started it, the active providers are the ones its plugins registered (a disabled agent-codex is
// no codex); in every other process (the CLI, the MCP server, a driver) they are the built-ins, as their plugins
// register them. Kernel code asks here and never names a provider.
import type { ContributionStore } from "../../packages/plugin/src/host/context";
import type { AgentConfig as SeamConfig, AgentProvider } from "../../packages/plugin/src/seams";
import type { AgentConfig } from "../agents/config";
import type { AgentAdapter } from "../agents/types";
import { claude } from "./agent-claude";
import { codex } from "./agent-codex";
import { fx } from "./agent-fx";
import { daemonSeamNames } from "./snapshot";

/** The built-in agent seams, in the order capcomd lists them. */
export const BUILTIN_AGENTS: readonly AgentProvider[] = [claude, codex, fx];

let store: ContributionStore | null = null;

/** The daemon's registrations (`capcomd serve`), or null: the built-ins. */
export function useAgentSeams(s: ContributionStore | null): void { store = s; }

/** The active agent providers, in load order. */
export function agentSeams(): AgentProvider[] {
  if (!store) return [...BUILTIN_AGENTS];
  return store.list("seam").filter((e) => e.value.seam === "agent").map((e) => e.value.impl as AgentProvider);
}

/** The active provider named `name` (a profile's `provider`), or null. */
export function agentSeam(name: string): AgentProvider | null {
  return agentSeams().find((p) => p.describe().name === name) ?? null;
}

/** The active providers' names: what a profile's `provider` may be. */
export const agentProviderNames = (): string[] => agentSeams().map((p) => p.describe().name);

/** "provider must be one of …" for a name that isn't an active provider: this process's, and outside the daemon the
 *  running daemon's too (src/plugins/snapshot.ts). */
export function unknownProviderText(name: unknown, env: Record<string, string | undefined> = process.env): string {
  const names = [...new Set([...agentProviderNames(), ...(daemonSeamNames("agent", env) ?? [])])];
  return `provider ${JSON.stringify(name)} isn't an active agent provider (${names.length ? `one of ${names.join(", ")}` : "none is active"}; see \`capcomd plugins list\`)`;
}

/**
 * The runner's kind for a provider (`AgentAdapter.kind`, CAPCOMD_AGENT, the auth logins, the `Capcomd-Agent:`
 * trailer): the provider's name, except Claude Code's, which capcomd named `claude-code` before providers were seams.
 */
const LEGACY_KIND: Record<string, string> = { claude: "claude-code" };
export const kindOf = (provider: string): string => LEGACY_KIND[provider] ?? provider;
export const providerOfKind = (kind: string): string => Object.entries(LEGACY_KIND).find(([, k]) => k === kind)?.[0] ?? kind;

/** The CLI version pins operators can override today (CAPCOMD_CLAUDE_CODE_VERSION, CAPCOMD_CODEX_VERSION). */
const VERSION_FIELD: Record<string, "version" | "codexVersion"> = { claude: "version", codex: "codexVersion" };

/** The kernel's agent config as the seam's (§7.3): only what a provider reads. `provider`: whose token rates
 *  (`usdPerMtok`) it gets: its own when the config has them (`cfg.usdPerMtok`: CAPCOMD_<PROVIDER>_USD_PER_MTOK_IN, _OUT),
 *  else codex's (CAPCOMD_CODEX_USD_PER_MTOK_IN, _OUT), as every provider got before providers had their own. */
export function seamConfig(cfg: AgentConfig, provider = "codex"): SeamConfig {
  const codexRates = cfg.codexUsdPerMtokIn !== undefined && cfg.codexUsdPerMtokOut !== undefined ? { in: cfg.codexUsdPerMtokIn, out: cfg.codexUsdPerMtokOut } : undefined;
  const rates = (provider !== "codex" ? cfg.usdPerMtok?.[provider] : undefined) ?? codexRates;
  return {
    model: cfg.model, effort: cfg.effort, maxTurns: cfg.maxTurns, maxBudgetUsd: cfg.maxBudgetUsd,
    allowedTools: cfg.allowedTools, disallowedTools: cfg.disallowedTools, sandbox: cfg.codexSandbox, credentialMode: cfg.credentialMode,
    ...(cfg.denyCommands?.length ? { denyCommands: cfg.denyCommands } : {}),
    ...(rates ? { usdPerMtok: rates } : {}),
  };
}

const adapters = new WeakMap<AgentProvider, AgentAdapter>();

/** A provider as the runner's AgentAdapter (`src/agents/types.ts`): the runner keeps clone, install, credentials,
 *  start, streaming, guards, cancel, commit and push; the provider says how its CLI is run and read. */
export function adapterOf(p: AgentProvider): AgentAdapter {
  const had = adapters.get(p);
  if (had) return had;
  const d = p.describe();
  const field = VERSION_FIELD[d.name];
  const a: AgentAdapter = {
    kind: kindOf(d.name), bin: d.bin, ...(d.npmPackage !== undefined ? { npmPackage: d.npmPackage } : {}), ...(d.install ? { install: d.install } : {}),
    pinnedVersion: (cfg) => (field ? cfg[field] : undefined) || d.pinnedVersion,
    secretName: d.secretName, apiHost: d.apiHost,
    credentialEnv: (v) => p.credentialEnv(v), baseEnv: () => p.baseEnv(),
    ...(d.streamInput ? { streamInput: true } : {}),
    command: (ctx, q) => p.command({ ...ctx, cfg: seamConfig(ctx.cfg, d.name) }, q),
    parse: (line, r, state, cfg) => p.parse(line, (s) => r.text(s), state, seamConfig(cfg, d.name)),
    guard: (state, cfg) => p.guard(state, seamConfig(cfg, d.name)),
    subscriptionCheck: (home, q) => p.subscriptionCheck(home, q),
    subscriptionPrelude: (home, q) => p.subscriptionPrelude(home, q),
    loginCommand: (bin) => p.loginCommand(bin),
    loginEgress: [...d.loginEgress],
    verifyCommand: (bin, q) => p.verifyCommand(bin, q),
    outcome: (state, exitCode) => p.outcome(state, exitCode),
    ...(p.refusal ? { refusal: (line, r) => p.refusal!(line, (s) => r.text(s)) } : {}),
  };
  adapters.set(p, a);
  return a;
}

/** The runner's adapter for an agent kind (`claude-code`, `codex`, or another provider's name). Throws when no active
 *  provider has it: a profile naming one is refused at validation, so this is a provider disabled since. */
export function agentAdapter(kind: string): AgentAdapter {
  const p = agentSeam(providerOfKind(kind));
  if (!p) throw new Error(unknownProviderText(providerOfKind(kind)));
  return adapterOf(p);
}

/** The active providers as adapters. */
export const allAdapters = (): AgentAdapter[] => agentSeams().map(adapterOf);

const SANDBOX_RANK = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 } as const;

/**
 * §16.1: an `orchestrate` agent's config, the provider's `toolPolicies.orchestrate` on top of the profile's own lists.
 * The allowlist becomes the policy's (or the profile's, narrowed to it), the denylist and the denied commands gain the
 * policy's, and the CLI's sandbox is no looser than the policy's. A provider with no allowlist (codex) leaves the
 * profile's alone.
 */
export function orchestrateConfig<C extends Pick<AgentConfig, "allowedTools" | "disallowedTools" | "codexSandbox" | "denyCommands">>(cfg: C, provider: AgentProvider): C {
  const policy = provider.describe().toolPolicies.orchestrate;
  const next = { ...cfg };
  if (policy.allowed.length) next.allowedTools = cfg.allowedTools ? cfg.allowedTools.filter((t) => policy.allowed.includes(t)) : [...policy.allowed];
  next.disallowedTools = [...new Set([...cfg.disallowedTools, ...policy.disallowed])];
  if (policy.denyCommands?.length) next.denyCommands = [...new Set([...(cfg.denyCommands ?? []), ...policy.denyCommands])];
  if (policy.sandbox && SANDBOX_RANK[cfg.codexSandbox] > SANDBOX_RANK[policy.sandbox]) next.codexSandbox = policy.sandbox;
  return next;
}
