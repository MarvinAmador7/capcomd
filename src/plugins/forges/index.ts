// The forge seam as the kernel uses it (docs/spec/plugin-api.md §7.1, §7.4). The daemon's forges are the ones its plugin
// host activated (`capcomd serve` calls useForges); every other process that lands work or opens a pull request (the CLI,
// `capcomd mcp`, a test) starts a host of its own with just the forge plugins, so a forge is always a plugin and is
// chosen the same way. Kernel code asks forgeFor(cfg) and never names an implementation.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost, type Candidate } from "../../../packages/plugin/src/host/host";
import type { Forge, LandOutcome, LandRequest, SeamCall } from "../../../packages/plugin/src/seams";
import type { MergeConfig } from "../../merge/config";
import { withSpan } from "../../utils/tracing-simple";
import { VERSION } from "../../utils/self";
import { BUILTINS } from "../builtins";
import { forgeScope, type ForgeScope } from "./scope";

export { forgeScope, type ForgeScope } from "./scope";

type Hosted = Pick<PluginHost, "contributions" | "list">;
let daemon: Hosted | null = null;
let local: Promise<Hosted> | null = null;

/** The daemon's host (`capcomd serve`), or null: this process then uses one of its own (tests set and clear it). */
export function useForges(h: Hosted | null): void { daemon = h; }

const declaresForge = (m: unknown) => !!(m as { contributes?: { seams?: Array<{ kind?: string }> } } | null)?.contributes?.seams?.some((s) => s.kind === "forge");

/** The forge plugins this process would load: the built-ins that declare a forge, and (tests) CAPCOMD_TEST_PLUGINS'. */
export function forgeCandidates(env: Record<string, string | undefined> = process.env): Candidate[] {
  const builtins = BUILTINS.filter((b) => declaresForge(b.manifest)).map((b) => ({ source: "builtin" as const, manifest: b.manifest, module: b.module }));
  const tests = env.NODE_ENV === "test" && env.CAPCOMD_TEST_PLUGINS ? env.CAPCOMD_TEST_PLUGINS.split(":").filter(Boolean) : [];
  const dirs = tests.filter((dir) => { try { return declaresForge(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"))); } catch { return false; } });
  return [...builtins, ...dirs.map((dir) => ({ source: "builtin" as const, dir }))];
}

async function host(): Promise<Hosted> {
  if (daemon) return daemon;
  local ??= (async () => {
    const h = new PluginHost({ capcomd: VERSION, kernel: [], emit: () => {}, dataDir: (name) => join(tmpdir(), `capcomd-plugin-${name}`) });
    await h.start(forgeCandidates());
    return h;
  })();
  return local;
}

/** The active forges in load order (the default selection's order, §7.1), each with the plugin that provides it. */
export async function activeForges(): Promise<Array<{ name: string; plugin: string; forge: Forge }>> {
  const h = await host();
  const order = h.list().map((p) => p.name);
  const rank = (plugin: string) => { const i = order.indexOf(plugin); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  return h.contributions.list("seam").filter((e) => e.value.seam === "forge")
    .sort((a, b) => rank(a.plugin) - rank(b.plugin))
    .map((e) => ({ name: e.key.slice("forge/".length), plugin: e.plugin, forge: e.value.impl as Forge }));
}

/** Why no forge serves a project: a named one that no active plugin provides. */
export class ForgeNotActive extends Error {
  constructor(readonly forge: string) { super(`merge.forge names ${forge}, which no active plugin provides`); this.name = "ForgeNotActive"; }
}

/**
 * The forge for a project (§7.1): the one its `merge.forge` names (CAPCOMD_MERGE_FORGE, `.capcomd.json`; a configured
 * GitHub repository names `github`), else the first active forge whose `matches(remote)` is true in load order. Throws
 * ForgeNotActive for a named forge that isn't active; null when no forge at all claims the remote.
 */
export async function forgeFor(o: Pick<MergeConfig, "remote"> & { forge?: string | null }): Promise<Forge | null> {
  const all = await activeForges();
  if (o.forge) {
    const named = all.find((f) => f.name === o.forge);
    if (!named) throw new ForgeNotActive(o.forge);
    return named.forge;
  }
  return all.find((f) => f.forge.matches(o.remote))?.forge ?? null;
}

/** A SeamCall that aborts at `ms` from now (§7.1); `done()` releases its timer. */
export function seamCall(ms: number): SeamCall & { done(): void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, deadline: new Date(Date.now() + ms).toISOString(), trace: { traceId: "", spanId: "" }, done: () => clearTimeout(t) };
}

/** Run `fn` with the project's settings visible to the forge (scope.ts), bounded by a SeamCall of `ms`. */
export async function withForge<T>(scope: ForgeScope, ms: number, fn: (c: SeamCall) => Promise<T>): Promise<T> {
  const c = seamCall(ms);
  try { return await forgeScope.run(scope, () => fn(c)); } finally { c.done(); }
}

/** `forge.land` as the kernel calls it: traced, under the caller's target lock, bounded by `ms`. */
export function land(forge: Forge, req: LandRequest, scope: ForgeScope, ms: number): Promise<LandOutcome> {
  return withSpan("forge.land", { "relay.run_id": req.runId, "forge.name": forge.describe().name, "forge.mode": req.mode, "git.target": req.target }, () =>
    withForge(scope, ms, (c) => forge.land(req, c)));
}
