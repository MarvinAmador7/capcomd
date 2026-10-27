// ADR-020: the sandbox providers capcomd knows, by the name CAPCOMD_SANDBOX selects, and what each can do. Code
// that depends on a feature asks for the capability (`sandboxCaps().snapshots`), never for a provider by name, so a
// new provider is one entry here plus its SandboxProvider.
// ADR-021 §1: each entry is the provider's descriptor, which the daemon also serves to clients as data
// (GET /v1/sandboxes): its name and label, the settings and info rows its details screen shows, and the resource
// actions it supports. Everything that lists places (run options, logins, environments, the API's sandbox names) is
// derived from the listed descriptors here.
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
  /** Who deletes a machine left behind once its idle lifetime is up: the provider itself (`platform`), capcomd's
   *  engine (`sweep`, every few minutes), or nobody (`none`: nothing outlives the process). */
  idleLifetime: "platform" | "sweep" | "none";
  /** An interactive shell into a live machine (`capcomd sandbox shell`). */
  shell: boolean;
}

/** Setting rows a provider's details screen can show (GET /v1/sandboxes/{name} `settings`). */
export const SETTING_IDS = ["idleLifetime"] as const;
export type SettingId = (typeof SETTING_IDS)[number];
/** Read-only info rows (GET /v1/sandboxes/{name} `info`). */
export const INFO_IDS = ["logins", "checkpoints"] as const;
export type InfoId = (typeof INFO_IDS)[number];
/** Actions on a resource: a closed list in code; a descriptor says which of them its provider supports. */
export const RESOURCE_ACTIONS = ["open_terminal", "delete"] as const;
export type ResourceAction = (typeof RESOURCE_ACTIONS)[number];
/** Actions this daemon serves today (ADR-021 phase 1): open_terminal only; delete comes with phase 3. */
export const SERVED_ACTIONS: readonly ResourceAction[] = ["open_terminal"];

export interface ProviderDescriptor {
  /** What CAPCOMD_SANDBOX and the API call it. */
  name: string;
  /** Bumped only by a breaking change to the descriptor's shape (additions never bump it). */
  descriptorVersion: 1;
  /** What to call the place: "Local", "Cloud". */
  label: string;
  /** How the app groups it and which glyph it falls back to. */
  kind: "local" | "cloud";
  /** Who provides it: what the title says after the dot. */
  vendor: string;
  /** "Cloud · boxd". */
  title: string;
  /** Id of the mark the app bundles (never an image). */
  mark: string;
  /** Shown to clients (run options, logins, GET /v1/sandboxes); false for the test fakes. */
  listed: boolean;
  caps: ProviderCaps;
  settings: readonly SettingId[];
  info: readonly InfoId[];
  resourceKinds: readonly "machine"[];
  actions: readonly ResourceAction[];
}

const hostCaps = { isolation: "host", snapshots: false, hostBoundSecrets: false, egressAllowlist: false, interactive: false, idleLifetime: "none", shell: false } as const;

// Listed providers in the order clients show them: docker, then boxd.
export const PROVIDERS = {
  /** Containers on this machine's Docker (Docker Desktop, OrbStack, Colima, Podman's docker): snapshots are images. */
  docker: {
    name: "docker", descriptorVersion: 1, label: "Local", kind: "local", vendor: "Docker", title: "Local · Docker", mark: "docker", listed: true,
    caps: { isolation: "container", snapshots: true, hostBoundSecrets: false, egressAllowlist: false, interactive: true, idleLifetime: "sweep", shell: true },
    settings: ["idleLifetime"], info: ["logins", "checkpoints"], resourceKinds: ["machine"], actions: ["open_terminal", "delete"],
  },
  /** boxd cloud VMs. */
  boxd: {
    name: "boxd", descriptorVersion: 1, label: "Cloud", kind: "cloud", vendor: "boxd", title: "Cloud · boxd", mark: "boxd", listed: true,
    caps: { isolation: "vm", snapshots: true, hostBoundSecrets: true, egressAllowlist: true, interactive: true, idleLifetime: "platform", shell: true },
    settings: ["idleLifetime"], info: ["logins", "checkpoints"], resourceKinds: ["machine"], actions: ["open_terminal", "delete"],
  },
  /** In-memory: nothing runs; task commits are made locally (tests, `capcomd setup`'s demo). */
  fake: {
    name: "fake", descriptorVersion: 1, label: "Fake", kind: "local", vendor: "in-memory", title: "Fake · in-memory", mark: "fake", listed: false,
    caps: hostCaps, settings: [], info: [], resourceKinds: [], actions: [],
  },
  /** Runs commands on this host (adapter tests with fake agent CLIs). */
  "fake-host": {
    name: "fake-host", descriptorVersion: 1, label: "Fake host", kind: "local", vendor: "this host", title: "Fake host · this host", mark: "fake-host", listed: false,
    caps: hostCaps, settings: [], info: [], resourceKinds: [], actions: [],
  },
} as const satisfies Record<string, ProviderDescriptor>;
export type ProviderName = keyof typeof PROVIDERS;
/** The providers clients see (`listed: true`), as a type. */
export type ListedProvider = { [K in ProviderName]: (typeof PROVIDERS)[K]["listed"] extends true ? K : never }[ProviderName];

/** Every descriptor, in declaration order. */
export const DESCRIPTORS: readonly ProviderDescriptor[] = Object.values(PROVIDERS);
/** The listed providers' names, in the order clients show them (docker, then boxd). */
export const LISTED_PROVIDERS = DESCRIPTORS.filter((d) => d.listed).map((d) => d.name) as readonly ListedProvider[];
/** What to call each listed place ("Local", "Cloud"). */
export const PROVIDER_LABEL = Object.fromEntries(LISTED_PROVIDERS.map((n) => [n, PROVIDERS[n].label])) as Record<ListedProvider, string>;

export function isProviderName(name: string): name is ProviderName {
  return Object.hasOwn(PROVIDERS, name);
}
/** A provider clients may name (API `sandbox` fields, `?sandbox=`, /v1/sandboxes/{name}). */
export function isListedProvider(name: string): name is ListedProvider {
  return isProviderName(name) && PROVIDERS[name].listed;
}
export function descriptorOf(name: string): ProviderDescriptor | null {
  return isProviderName(name) ? PROVIDERS[name] : null;
}

/** The provider CAPCOMD_SANDBOX (or the deprecated RELAY_SANDBOX) names; the in-memory fake when unset. */
export function sandboxName(source: Record<string, string | undefined> = process.env): ProviderName {
  const name = (envVar("SANDBOX", source) ?? "fake").toLowerCase();
  if (!isProviderName(name)) throw new Error(`Unknown CAPCOMD_SANDBOX=${name} (expected ${Object.keys(PROVIDERS).join("|")})`);
  return name;
}

export function sandboxCaps(source: Record<string, string | undefined> = process.env): ProviderCaps {
  return PROVIDERS[sandboxName(source)].caps;
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
