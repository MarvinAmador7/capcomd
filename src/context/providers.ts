// The context providers as the kernel's router finds them (ADR-025 §3.1): the `context` registrations of this process's
// plugin host, by name. The daemon's are its host's (`capcomd serve` calls useContextHost); every other process that
// prepares an agent or prints a brief (a run's driver, the CLI) uses its local host (src/plugins/host.ts `localHost`),
// which loads the built-in providers. A profile names providers; the kernel never names one.
import type { PluginHost } from "../../packages/plugin/src/host/host";
import type { ContextKind, ContextProvider } from "../../packages/plugin/src/context-layer";

type Hosted = Pick<PluginHost, "contributions">;
let daemon: Hosted | null = null;
let local: Hosted | null = null;

/** The daemon's host (`capcomd serve`), or null: this process then uses its local host (tests set and clear it). */
export function useContextHost(h: Hosted | null): void { daemon = h; }

async function host(): Promise<Hosted> {
  if (daemon) return daemon;
  local ??= await (await import("../plugins/host")).localHost();
  return local;
}

export interface ActiveProvider { name: string; plugin: string; kinds: readonly ContextKind[]; provider: ContextProvider }

/** The active context providers, by name. */
export async function contextProviders(): Promise<Map<string, ActiveProvider>> {
  const h = await host();
  return new Map(h.contributions.list("context").map((e) => [e.key, { name: e.key, plugin: e.plugin, kinds: e.value.kinds, provider: e.value.impl }]));
}

/**
 * The names a profile may give in `context.providers` (checked when profiles are read, ADR-025 §3.1, as a sandbox
 * provider's name is): the daemon's or the started local host's registrations, else what the built-ins declare (no
 * plugin is started for it: profiles are read synchronously, often before any host is up).
 */
export function contextProviderNames(): string[] {
  const h = daemon ?? local;
  if (h) return h.contributions.list("context").map((e) => e.key);
  const { BUILTINS } = require("../plugins/builtins") as typeof import("../plugins/builtins");
  return BUILTINS.flatMap((b) => ((b.manifest as { contributes?: { context?: Array<{ name: string }> } }).contributes?.context ?? []).map((c) => c.name));
}
