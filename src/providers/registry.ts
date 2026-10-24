// ADR-020: the sandbox providers capcomd knows, by the name CAPCOMD_SANDBOX selects, and what each can do. Code
// that depends on a feature asks for the capability (`sandboxCaps().snapshots`), never for a provider by name, so a
// new provider is one entry here plus its SandboxProvider.
import { env as envVar } from "../utils/env";

export interface ProviderCaps {
  /** Where an agent's commands run: in a VM or a container (real agent CLIs, checks on agent code), or on this host
   *  (the test fakes). */
  isolation: "vm" | "container" | "host";
  /** Saved images to boot from: `capcomd env build` (the agent CLIs baked in) and plan logins (`capcomd auth login`). */
  snapshots: boolean;
  /** Secrets the platform swaps in on the way to one host, so the agent only ever sees a placeholder
   *  (`capcomd secrets sync`, credential mode "secret"). Without it, an API key reaches the agent in its environment. */
  hostBoundSecrets: boolean;
  /** Egress limited to a list of hosts (a profile's `egress`, the checks sandbox's package registries only). */
  egressAllowlist: boolean;
  /** A command with a terminal, for interactive logins. */
  interactive: boolean;
}

export const PROVIDERS = {
  /** In-memory: nothing runs; task commits are made locally (tests, `capcomd setup`'s demo). */
  fake: { isolation: "host", snapshots: false, hostBoundSecrets: false, egressAllowlist: false, interactive: false },
  /** Runs commands on this host (adapter tests with fake agent CLIs). */
  "fake-host": { isolation: "host", snapshots: false, hostBoundSecrets: false, egressAllowlist: false, interactive: false },
  /** boxd cloud VMs. */
  boxd: { isolation: "vm", snapshots: true, hostBoundSecrets: true, egressAllowlist: true, interactive: true },
  /** Containers on this machine's Docker (Docker Desktop, OrbStack, Colima, Podman's docker): snapshots are images. */
  docker: { isolation: "container", snapshots: true, hostBoundSecrets: false, egressAllowlist: false, interactive: true },
} as const satisfies Record<string, ProviderCaps>;
export type ProviderName = keyof typeof PROVIDERS;

/** The provider CAPCOMD_SANDBOX (or the deprecated RELAY_SANDBOX) names; the in-memory fake when unset. */
export function sandboxName(source: Record<string, string | undefined> = process.env): ProviderName {
  const name = (envVar("SANDBOX", source) ?? "fake").toLowerCase();
  if (!(name in PROVIDERS)) throw new Error(`Unknown CAPCOMD_SANDBOX=${name} (expected ${Object.keys(PROVIDERS).join("|")})`);
  return name as ProviderName;
}

export function sandboxCaps(source: Record<string, string | undefined> = process.env): ProviderCaps {
  return PROVIDERS[sandboxName(source)];
}

/**
 * A state file of this provider's (env snapshots, plan logins): boxd and the fakes keep the original name, others get
 * their own (`envs-docker.json`), so switching providers never points one at the other's images.
 */
export function providerStateFile(base: string, source: Record<string, string | undefined> = process.env): string {
  const name = sandboxName(source);
  return name === "boxd" || name === "fake" || name === "fake-host" ? base : base.replace(/(\.[a-z]+)$/, `-${name}$1`);
}

/** Real agent CLIs run isolated from this host (a VM or a container), not in a test fake. */
export function realSandbox(source: Record<string, string | undefined> = process.env): boolean {
  return sandboxCaps(source).isolation !== "host";
}
