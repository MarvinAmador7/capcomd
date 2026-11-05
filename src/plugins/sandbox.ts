// sandbox.ensuring and sandbox.changed (docs/spec/plugin-api.md §6.6.10-11) where every sandbox call passes: the
// provider the kernel builds for a place (src/dependencies.ts providerFromEnv) is wrapped here, so an agent's machine,
// a check's, a login's, an environment build's and the doctor's are seen alike. With no plugin listening each call
// goes straight to the provider (the same promise, nothing awaited in between).
import type { SandboxEnsuring, SandboxChange } from "../../packages/plugin/src/hooks";
import type { SandboxProvider, VmId, VmSpec } from "../providers/sandbox";
import { applySandboxPatch, hooks, principalOf, refusedError } from "./hooks";

const WRAPPED = Symbol("capcomd.hookedProvider");
type Use = { runId: string | null; agentId: string | null; at: number };
/** What a machine is for, by its idempotency key and its id (this process's: a destroy after a restart names neither). */
const uses = new Map<string, Use>();
const MAX_USES = 2000;

/** What a machine is for (§6.6.10 `purpose`), from the labels capcomd gives it. */
export function purposeOf(labels: Record<string, string>): SandboxEnsuring["purpose"] {
  const p = labels.purpose;
  if (p === "checks") return "check";
  if (p === "env-build") return "env_build";
  if (p === "doctor" || p === "login" || p === "job") return p;
  if (p && (p.startsWith("auth-") || /login/.test(p))) return "login";
  return labels.workerId ? "agent" : "check";
}

function remember(key: string, u: Use) {
  uses.set(key, u);
  if (uses.size > MAX_USES) uses.delete(uses.keys().next().value!);
}

function changed(provider: string, id: string, change: SandboxChange) {
  if (!hooks.listening("sandbox.changed")) return;
  const u = uses.get(id);
  hooks.fire("sandbox.changed", "observe", { provider, machine: { id }, runId: u?.runId ?? null, agentId: u?.agentId ?? null, change },
    { principal: principalOf(null), entity: `${provider}/${id}#${change.kind}`, runId: u?.runId ?? null, agentId: u?.agentId ?? null });
}

async function ensuring(p: SandboxProvider, name: string, spec: VmSpec): Promise<{ id: VmId; created: boolean }> {
  const labels = spec.labels ?? {};
  const known = uses.get(spec.idemKey);
  const runId = labels.runId ?? labels.run ?? known?.runId ?? null;
  const agentId = labels.workerId?.startsWith("agt-") ? labels.workerId : known?.agentId ?? null;
  if (hooks.listening("sandbox.ensuring")) {
    const payload: SandboxEnsuring = { runId, agentId, purpose: purposeOf(labels), provider: name, spec: { ...spec, labels: { ...labels }, isolated: true } };
    const out = await hooks.fire("sandbox.ensuring", "modify", payload, { principal: principalOf(null), entity: spec.idemKey, runId, agentId,
      apply: (q, patch, plugin) => applySandboxPatch(q, patch, plugin) });
    if (out.decision === "deny") throw refusedError("sandbox.ensuring", out, "config");
    spec = { ...spec, labels: out.payload.spec.labels, ttlSeconds: out.payload.spec.ttlSeconds, ...(out.payload.spec.size ? { size: out.payload.spec.size } : {}) };
  }
  const at = Date.now();
  const r = await p.ensure(spec);
  remember(spec.idemKey, { runId, agentId, at });
  remember(r.id, { runId, agentId, at });
  return r;
}

/** `p` with the sandbox hooks fired around ensure, waitReady and destroy. Idempotent. */
export function hookedProvider<P extends SandboxProvider>(p: P, name: string): P {
  if ((p as any)[WRAPPED]) return p;
  return new Proxy(p, {
    get(target, prop, receiver) {
      if (prop === WRAPPED) return true;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "ensure") return (spec: VmSpec) => (hooks.listening("sandbox.ensuring") || hooks.listening("sandbox.changed") ? ensuring(target, name, spec) : value.call(target, spec));
      if (prop === "waitReady") return (id: VmId, ...rest: unknown[]) => {
        const r = value.call(target, id, ...rest);
        if (!hooks.listening("sandbox.changed")) return r;
        return Promise.resolve(r).then((v) => { changed(name, id, { kind: "ready", createdMs: Math.max(0, Date.now() - (uses.get(id)?.at ?? Date.now())) }); return v; });
      };
      if (prop === "destroy") return (id: VmId, ...rest: unknown[]) => {
        if (!hooks.listening("sandbox.changed")) return value.call(target, id, ...rest);
        changed(name, id, { kind: "destroying", reason: "released" });
        return Promise.resolve(value.call(target, id, ...rest)).then((v) => { changed(name, id, { kind: "destroyed" }); uses.delete(id); return v; });
      };
      return value.bind(target);
    },
  });
}
