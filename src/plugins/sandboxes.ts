// The sandbox seam as the kernel uses it (docs/spec/plugin-api.md §7.1, §7.2, §17.2 step 3): every provider is a
// plugin's seam, found by name, and the kernel never names one. In the daemon the seams are its plugin host's, once
// `capcomd serve` has started it (useSandboxHost). Every other process (the CLI, the MCP server, an in-VM capcomd, a
// test), and the daemon before its host is up, activates the built-in sandbox plugins here, through the host's own
// context and in the host's load order, so a built-in is held to its manifest the same way in both.
import { join } from "node:path";
import { loadManifest } from "../../packages/plugin/src/load";
import { ContributionStore, createContext } from "../../packages/plugin/src/host/context";
import { configDefaults } from "../../packages/plugin/src/host/host";
import { resolveOrder } from "../../packages/plugin/src/host/order";
import { HookRegistry } from "../../packages/plugin/src/host/registry";
import type { ErrorClass, SandboxDescriptor, SandboxProvider as SandboxSeam } from "../../packages/plugin/src/seams";
import { RelayError } from "../core/errors";
import { kernelSandbox, seamCall } from "../providers/seam";
import type { SandboxProvider } from "../providers/sandbox";
import { stateDir } from "../utils/home";
import { VERSION } from "../utils/self";
import { SANDBOX_BUILTINS } from "./builtin/sandboxes";
import { resolveSecret, secretOrUndefined } from "./secrets";

type Env = Record<string, string | undefined>;

let daemon: ContributionStore | null = null;
/** The daemon's plugin host, once it has started (`capcomd serve`), or null. */
export function useSandboxHost(host: { contributions: ContributionStore } | null): void { daemon = host?.contributions ?? null; }

let local: ContributionStore | null = null;
/** This process's built-in sandbox plugins, activated on first use. Activation only registers the seams; no provider is
 *  made until one is asked for. A built-in that doesn't load is a bug, so it throws. */
function builtins(): ContributionStore {
  if (local) return local;
  const store = new ContributionStore();
  const hooks = new HookRegistry({ emit: () => {}, rank: () => 0 });
  const loaded = SANDBOX_BUILTINS.map((b) => {
    const r = loadManifest(b.manifest, { capcomd: VERSION });
    if (!r.ok) throw new Error(`built-in plugin ${b.manifest.name}: ${r.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    return { b, manifest: r.manifest };
  });
  const { order, failed } = resolveOrder(loaded.map((l) => ({ name: l.manifest.name, manifest: l.manifest })), []);
  if (failed.size) throw new Error(`built-in sandbox plugins: ${[...failed].map(([n, f]) => `${n}: ${f.message}`).join("; ")}`);
  for (const name of order) {
    const { b, manifest } = loaded.find((l) => l.manifest.name === name)!;
    const runtime = createContext({
      manifest, runtime: "in-process", root: "", dataDir: join(stateDir(), "plugins", name), hooks, store,
      config: configDefaults(manifest, null), secret: async (key) => resolveSecret(manifest, key),
    });
    const r = b.module.activate(runtime.ctx as never) as unknown;
    if (r instanceof Promise) throw new Error(`built-in plugin ${name}: a sandbox plugin activates synchronously`);
    if (runtime.violations.length || runtime.missing().length) throw new Error(`built-in plugin ${name}: registered ${runtime.violations.join(", ") || "less than it declares"}`);
  }
  return (local = store);
}
const store = () => daemon ?? builtins();

/** The active sandbox seams, in load order. */
export function sandboxSeams(): Array<{ plugin: string; name: string; seam: SandboxSeam }> {
  return store().list("seam").filter((e) => e.value.seam === "sandbox").map((e) => ({ plugin: e.plugin, name: e.key.slice("sandbox/".length), seam: e.value.impl as SandboxSeam }));
}

/** The seam named `name` (what CAPCOMD_SANDBOX and a run's `sandbox` say), or null when no active plugin provides it. */
export function sandboxSeam(name: string): SandboxSeam | null {
  return (store().get("seam", `sandbox/${name}`)?.value.impl as SandboxSeam | undefined) ?? null;
}

/** Every active sandbox seam's descriptor (§7.2 `describe()`), in load order. */
export function describedSandboxes(): SandboxDescriptor[] {
  return sandboxSeams().map((s) => s.seam.describe());
}

/** The kernel provider for the sandbox `name`, built for `env` (§7.1: the kernel asks the host, by name). A built-in's
 *  secrets (§10.3) resolve against the same `env`. */
export function sandboxProvider(name: string, env: Env = process.env): SandboxProvider {
  const e = store().get("seam", `sandbox/${name}`);
  if (!e) throw new RelayError("config", `no active plugin provides the ${name} sandbox`, "See `capcomd plugins list` for why it isn't loaded.", { code: "sandbox" });
  const manifest = SANDBOX_BUILTINS.find((b) => b.manifest.name === e.plugin)?.manifest;
  return kernelSandbox(e.value.impl as SandboxSeam, env, manifest ? (key) => secretOrUndefined(manifest, key, env) : undefined);
}

function current(): string | null {
  try { return (require("../providers/registry") as typeof import("../providers/registry")).sandboxName(); } catch { return null; }
}

function classes(e: unknown, name: string | null): ErrorClass[] {
  const seams = sandboxSeams();
  const first = seams.find((s) => s.name === name);
  return (first ? [first, ...seams.filter((s) => s !== first)] : seams).flatMap((s) => {
    try { return [s.seam.classifyError(e)]; } catch { return []; }
  });
}

/** §7.2.3: what `e` is, as the seam of the place in use says (`name`, default the daemon's CAPCOMD_SANDBOX), else as the
 *  first other seam that knows it: an error that crossed an actor boundary as text may come from a run on another place. */
export function sandboxErrorClass(e: unknown, name: string | null = current()): ErrorClass {
  return classes(e, name).find((c) => c.kind !== "unknown") ?? { kind: "unknown", retryable: false };
}

/** A rejected sandbox credential (§7.2.3 `auth`: the run fails, non-retryable, with the hint as the user's next step),
 *  as any active seam recognises it, the place in use first; null otherwise. */
export function sandboxAuthError(e: unknown, name: string | null = current()): Extract<ErrorClass, { kind: "auth" }> | null {
  return (classes(e, name).find((c) => c.kind === "auth") as Extract<ErrorClass, { kind: "auth" }> | undefined) ?? null;
}

const SWEEP_EVERY_MS = 5 * 60_000;
const swept = new Set<string>();
/**
 * Delete the place's machines past their idle lifetime now and every 5 minutes, when its seam sweeps (§7.2: `sweep`,
 * `caps.idleLifetime === "sweep"`: Docker doesn't delete containers by itself, ADR-020). Once per place per process;
 * each round asks for the seam again, so a plugin that was disabled is no longer swept.
 */
export function keepTidy(name: string, log: (line: string) => void = (l) => console.log(l)): void {
  if (swept.has(name)) return;
  const first = sandboxSeam(name);
  if (!first?.sweep || first.describe().caps.idleLifetime !== "sweep") return;
  swept.add(name);
  const round = () => {
    const seam = sandboxSeam(name);
    if (!seam?.sweep) return;
    const { call, done } = seamCall(SWEEP_EVERY_MS - 10_000);
    seam.sweep(call).then((r) => { if (r.deleted.length) log(`  removed ${r.deleted.length} expired sandbox machine(s) (${name})`); }, () => {}).finally(done);
  };
  round();
  setInterval(round, SWEEP_EVERY_MS).unref?.();
}
