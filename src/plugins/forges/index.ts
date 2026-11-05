// The forge seam as the kernel uses it (docs/spec/plugin-api.md §7.1, §7.4). The daemon's forges are the ones its plugin
// host activated (`capcomd serve` calls useForges); every other process that lands work, opens a pull request or reads
// a remote's branches (the CLI, `capcomd mcp`, a test) uses its local host (src/plugins/host.ts `localHost`, the one
// that also runs the built-in gates), so a forge is always a plugin and is chosen the same way. Kernel code asks
// forgeFor(cfg) (or publishForge) and never names an implementation; what it gets back is the kernel's wrapper around
// the plugin's object (§7.1): every method traced, a SeamCall that is always honoured, and the reads retried while the
// forge's own classifyError says the failure is transient.
import type { PluginHost } from "../../../packages/plugin/src/host/host";
import { PluginError } from "../../../packages/plugin/src/errors";
import type { ErrorClass, Forge, ForgeLogin, LandOutcome, LandRequest, SeamCall } from "../../../packages/plugin/src/seams";
import type { MergeConfig } from "../../merge/config";
import { addSpanEvent, getTraceContext, setSpanAttributes, withSpan } from "../../utils/tracing-simple";
import { forgeScope, type ForgeScope } from "./scope";

export { forgeScope, type ForgeScope } from "./scope";

type Hosted = Pick<PluginHost, "contributions" | "list">;
let daemon: Hosted | null = null;

/** The daemon's host (`capcomd serve`), or null: this process then uses its local host (tests set and clear it). */
export function useForges(h: Hosted | null): void { daemon = h; }

async function host(): Promise<Hosted> {
  return daemon ?? (await import("../host")).localHost();
}

/** The active forges in load order (the default selection's order, §7.1), each with the plugin that provides it. */
export async function activeForges(): Promise<Array<{ name: string; plugin: string; forge: Forge }>> {
  const h = await host();
  const order = h.list().map((p) => p.name);
  const rank = (plugin: string) => { const i = order.indexOf(plugin); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  return h.contributions.list("seam").filter((e) => e.value.seam === "forge")
    .sort((a, b) => rank(a.plugin) - rank(b.plugin))
    .map((e) => ({ name: e.key.slice("forge/".length), plugin: e.plugin, forge: kernelForge(e.value.impl as Forge, e.plugin) }));
}

/** Why no forge serves a project: a named one that no active plugin provides. */
export class ForgeNotActive extends Error {
  constructor(readonly forge: string) { super(`merge.forge names ${forge}, which no active plugin provides`); this.name = "ForgeNotActive"; }
}

/**
 * The forge for a project (§7.1): the one its `merge.forge` names (CAPCOMD_MERGE_FORGE; a configured
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

/**
 * A run or project naming a forge that isn't active fails when it is validated (§7.1: `POST /v1/runs` 422, `capcomd run`),
 * not when its first merge runs: the refusal, with the forges there are. null when `forge` is unset or active.
 */
export async function inactiveForge(forge: string | null | undefined): Promise<{ message: string; hint: string } | null> {
  if (!forge) return null;
  const names = (await activeForges()).map((f) => f.name);
  if (names.includes(forge)) return null;
  return {
    message: new ForgeNotActive(forge).message,
    hint: names.length ? `Name one that is (${names.join(", ")}) in CAPCOMD_MERGE_FORGE, or see \`capcomd plugins list\` for why ${forge} isn't loaded.` : "No forge is active: see `capcomd plugins list`.",
  };
}

/** The forge that creates repositories for POST /v1/projects/publish: the first active one whose `describe().publish`. */
export async function publishForge(): Promise<Forge | null> {
  return (await activeForges()).find((f) => f.forge.describe().publish === true)?.forge ?? null;
}

/** The labels of the active forges that have pull requests, in load order ("GitHub"); none: no forge supports them. */
export async function pullRequestLabels(): Promise<string[]> {
  return (await activeForges()).filter((f) => f.forge.describe().pullRequests).map((f) => f.forge.describe().label);
}

/** "GitHub", "GitHub or GitLab", "GitHub, GitLab or Gitea". */
export const orList = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`;

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

/** `forge.land` as the kernel calls it: traced (by the wrapper), under the caller's target lock, bounded by `ms`. */
export function land(forge: Forge, req: LandRequest, scope: ForgeScope, ms: number): Promise<LandOutcome> {
  return withForge(scope, ms, (c) => forge.land(req, c));
}

/** The user's own login at the forge for `input.use` (never rejects; §7.4 `login`). */
export function forgeLogin(forge: Forge, input: Parameters<Forge["login"]>[0], scope: ForgeScope = {}, ms = 20_000): Promise<ForgeLogin> {
  return withForge(scope, ms, (c) => forge.login(input, c));
}

// ---- the kernel's wrapper (§7.1) ----

/** What `e` is, as the forge says (§7.2.3); `unknown` when it can't say or its classifyError throws. */
function classify(raw: Forge, e: unknown): ErrorClass {
  try { return raw.classifyError(e) ?? { kind: "unknown", retryable: false }; } catch { return { kind: "unknown", retryable: false }; }
}
/** What the forge says `e` is (§7.2.3), for a kernel consumer that decides by it (an `auth` failure asks for a login). */
export function forgeErrorClass(forge: Forge, e: unknown): ErrorClass { return forge.classifyError(e); }

/** A read that failed transiently is tried again this many times, within the call's deadline. */
const RETRIES = 2;
const backoff = (n: number) => { const cap = Math.min(5_000, 500 * 2 ** n); return Math.round(cap / 2 + Math.random() * (cap / 2)); };
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});
const cancelled = (what: string, c: SeamCall) => new PluginError("timeout", `${what} was cancelled or ran past its deadline (${c.deadline})`, undefined, true);

/** `p`, settled by the call's signal too: a forge that ignores it still answers `timeout` at the deadline (§7.1). */
async function honoured<T>(what: string, c: SeamCall, p: () => Promise<T>): Promise<T> {
  if (c.signal.aborted) throw cancelled(what, c);
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(cancelled(what, c)); });
  c.signal.addEventListener("abort", onAbort, { once: true });
  try { return await Promise.race([p(), aborted]); } finally { c.signal.removeEventListener("abort", onAbort); }
}

/**
 * The plugin's forge as kernel consumers get it: each SeamCall method in a `forge.<method>` span (its trace handed to
 * the forge), its rejections classified by the forge's own classifyError (`forge.error_kind` on the span), the reads
 * (`findPullRequest`, `openPullRequest`, idempotent by (remote, head, base), and `listBranches`) tried again while that
 * says `retryable`, and `login` never rejecting. `land` is called once and waited for: it runs under the target lock,
 * and its outcome (a conflict, a retryable failure) is the kernel's to act on.
 */
function kernelForge(raw: Forge, plugin: string): Forge {
  const name = (() => { try { return raw.describe().name; } catch { return plugin; } })();
  const traced = <T>(method: string, attrs: Record<string, unknown>, c: SeamCall, fn: (c: SeamCall) => Promise<T>, o: { retry: boolean; wait: boolean }): Promise<T> =>
    withSpan(`forge.${method}`, { "forge.name": name, "forge.plugin": plugin, ...attrs }, async (span) => {
      const call: SeamCall = { ...c, trace: getTraceContext(span) };
      for (let n = 0; ; n++) {
        try { return await (o.wait ? fn(call) : honoured(`${name} ${method}`, c, () => fn(call))); }
        catch (e) {
          const k = classify(raw, e);
          setSpanAttributes(span, { "forge.error_kind": k.kind });
          const after = "retryAfterMs" in k ? k.retryAfterMs : undefined;
          const wait = k.retryable ? Math.min(after ?? backoff(n), Date.parse(c.deadline) - Date.now() - 100) : 0;
          if (!o.retry || n >= RETRIES || c.signal.aborted || wait <= 0) throw e;
          addSpanEvent(span, "forge.retry", { attempt: n + 1, "forge.error_kind": k.kind });
          await sleep(wait, c.signal);
        }
      }
    });
  const read = { retry: true, wait: false }, once = { retry: false, wait: false };
  return {
    describe: () => raw.describe(),
    matches: (remote) => { try { return raw.matches(remote) === true; } catch { return false; } },
    classifyError: (e) => classify(raw, e),
    land: (req, c) => traced("land", { "relay.run_id": req.runId, "forge.mode": req.mode, "git.target": req.target }, c, (x) => raw.land(req, x), { retry: false, wait: true }),
    openPullRequest: (input, c) => traced("openPullRequest", { "git.ref": input.head, "git.target": input.base }, c, (x) => raw.openPullRequest(input, x), read),
    findPullRequest: (input, c) => traced("findPullRequest", { "git.ref": input.head, "git.target": input.base }, c, (x) => raw.findPullRequest(input, x), read),
    publishRepository: (input, c) => traced("publishRepository", { "forge.repo": input.owner ? `${input.owner}/${input.name}` : input.name }, c, (x) => raw.publishRepository(input, x), once),
    listBranches: (input, c) => traced("listBranches", {}, c, (x) => raw.listBranches(input, x), read),
    login: (input, c) => traced("login", { "forge.use": input.use }, c, (x) => raw.login(input, x), once).then(
      (r): ForgeLogin => r && typeof r === "object" && "ok" in r ? r : { ok: false, reason: `${name} didn't say whether you are logged in`, fix: null },
      (e): ForgeLogin => {
        const k = classify(raw, e);
        return { ok: false, reason: String((e as Error)?.message ?? e).slice(0, 300), fix: "hint" in k ? k.hint : null };
      }),
  };
}
