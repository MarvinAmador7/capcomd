// The environment variable families the kernel keeps for itself (docs/spec/plugin-api.md §6.6.7, §7.3, §10.3): its own,
// fixed here, and every agent provider's, which each provider declares (`describe().envPrefixes`) so the kernel keeps
// no list of them (the owner's decision of 2026-11-10). A provider's families only add protection: the kernel's are
// always there, the built-ins' stay when one is disabled (the user's keys are still the user's), and a family that would
// take in one of the kernel's is refused when the seam registers (`agentSeamRefusal`) and left out here anyway.
import { envPrefixesIssue, type AgentProvider } from "../../packages/plugin/src/seams";
import { agentSeams, BUILTIN_AGENTS } from "./agents";

/** §10.3: the kernel's own variables (`kernelVariable`, whatever their case): every CAPCOMD_* and its deprecated
 *  RELAY_* alias, the boxd key, the engine's and git's, and the GitHub tokens the forges use. */
export const KERNEL_SECRET_PREFIXES: readonly string[] = ["CAPCOMD_", "RELAY_", "BOXD_", "RIVET", "GIT_"];
export const KERNEL_SECRET_NAMES: ReadonlySet<string> = new Set(["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

/** §6.6.7: what an agent.preparing `env` never sets beside the providers' families (`reservedEnvName`): the kernel's
 *  CAPCOMD_*, what a shell or a runtime loads before the agent's code, the proxy and certificates its traffic trusts,
 *  and git's. */
export const KERNEL_RESERVED_PREFIXES: readonly string[] = ["CAPCOMD_", "LD_", "DYLD_", "NODE_", "NPM_CONFIG_", "PYTHON", "PERL5", "RUBY", "GIT_"];
export const KERNEL_RESERVED_NAMES: ReadonlySet<string> = new Set(["BASH_ENV", "ENV", "SHELL", "IFS", "CDPATH", "PS4", "PROMPT_COMMAND", "ZDOTDIR", "TMPDIR", "USER", "LOGNAME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE"]);

/** What a check on the host doesn't get beside the providers' families (src/merge/verify.ts `hostCheckEnv`, whatever
 *  their case): capcomd's settings, GitHub's and the clouds' keys, git's credential config and the SSH agent. */
export const HOST_CHECK_DROP_PREFIXES: readonly string[] = ["CAPCOMD_", "RELAY_", "BOXD_", "GH_", "GITHUB_", "GIT_CONFIG_", "AWS_", "GOOGLE_", "AZURE_"];
export const HOST_CHECK_DROP_NAMES: ReadonlySet<string> = new Set(["GIT_ASKPASS", "SSH_AUTH_SOCK", "NPM_TOKEN"]);

const KERNEL_PREFIXES = [...new Set([...KERNEL_SECRET_PREFIXES, ...KERNEL_RESERVED_PREFIXES, ...HOST_CHECK_DROP_PREFIXES])];
const KERNEL_NAMES = [...new Set([...KERNEL_SECRET_NAMES, ...KERNEL_RESERVED_NAMES, ...HOST_CHECK_DROP_NAMES])];

/** The kernel family a provider's prefix would take in, or null: a kernel prefix or name it is the start of (`NPM_` of
 *  `NPM_CONFIG_`, `GITHUB_` of `GITHUB_TOKEN`). One equal to a kernel prefix, or inside one (`GIT_X_`), takes in none. */
export function kernelFamilyTakenIn(prefix: string): string | null {
  const p = prefix.toUpperCase();
  return KERNEL_PREFIXES.find((k) => k !== p && k.startsWith(p)) ?? KERNEL_NAMES.find((n) => n.startsWith(p)) ?? null;
}

/** Why the kernel refuses an agent seam's `envPrefixes` (§7.3), or null: one that isn't a family (`ENV_PREFIX`: not
 *  `""`, `C` or lower case) or that would take in a kernel family. The host asks at registration (src/plugins/host.ts). */
export function agentSeamRefusal(p: Pick<AgentProvider, "describe">): string | null {
  const prefixes: unknown = p.describe().envPrefixes;
  const issue = envPrefixesIssue(prefixes);
  if (issue || prefixes === undefined) return issue;
  for (const x of prefixes as string[]) {
    const taken = kernelFamilyTakenIn(x);
    if (taken) return `describe().envPrefixes: ${x} would take in the kernel's ${taken} (a provider's families only add protection, §7.3)`;
  }
  return null;
}

const declared = new WeakMap<object, readonly string[]>();
/** A provider's families, as its describe() (pure, §7.3) gives them; none when they'd be refused. */
function familiesOf(p: AgentProvider): readonly string[] {
  let f = declared.get(p);
  if (!f) {
    f = agentSeamRefusal(p) ? [] : [...(p.describe().envPrefixes ?? [])];
    declared.set(p, f);
  }
  return f;
}

/** Every agent provider's families: the built-ins' (claude, codex, fx, in that order) whether or not they're active,
 *  then each other active provider's, each prefix once. */
export function providerEnvPrefixes(): string[] {
  return [...new Set([...BUILTIN_AGENTS, ...agentSeams()].flatMap(familiesOf))];
}

/** The prefixes `reservedEnvName` (src/plugins/hooks.ts) reserves: the kernel's and every provider's. */
export const reservedEnvPrefixes = (): string[] => [...new Set([...KERNEL_RESERVED_PREFIXES, ...providerEnvPrefixes()])];
/** The prefixes `kernelVariable` (src/plugins/config.ts) matches: the kernel's and every provider's. */
export const kernelEnvPrefixes = (): string[] => [...new Set([...KERNEL_SECRET_PREFIXES, ...providerEnvPrefixes()])];
/** The prefixes `hostCheckEnv` (src/merge/verify.ts) drops: the kernel's and every provider's. */
export const hostCheckDropPrefixes = (): string[] => [...new Set([...HOST_CHECK_DROP_PREFIXES, ...providerEnvPrefixes()])];
