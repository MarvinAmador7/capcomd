// Resolution and the total order (spec §4.6, §6.3): seam and source conflicts, unsatisfiable `requires`, and one order
// that is the hook order, the load order and, reversed, the dispose order.
import type { PluginManifest } from "../manifest";

export type Resolvable = { name: string; manifest: PluginManifest };
export type ResolveFailure = { cause: "unresolved" | "cycle" | "seam_conflict"; message: string };

const ORDERS = ["pre", "normal", "post"] as const;
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What a plugin provides, its implicit `plugin:<name>` included (§4.6). */
export const provided = (m: PluginManifest): string[] => [`plugin:${m.name}`, ...(m.provides ?? [])];

/**
 * `plugins` in discovery order; `kernel` the capability ids the kernel provides (`kernel:<feature flag>`). Returns the
 * load order of the plugins that resolved, and why each other one failed. A plugin can fail only for itself: those that
 * require it fail `unresolved` in turn.
 */
export function resolveOrder(plugins: Resolvable[], kernel: Iterable<string>): { order: string[]; failed: Map<string, ResolveFailure> } {
  const failed = new Map<string, ResolveFailure>();
  // Two plugins providing one seam or source: the later in discovery order fails (§4.6).
  const claimed = new Map<string, string>();
  for (const p of plugins) {
    const ids = (p.manifest.provides ?? []).filter((id) => id.startsWith("seam:") || id.startsWith("source:"));
    const clash = ids.find((id) => claimed.has(id));
    if (clash) { failed.set(p.name, { cause: "seam_conflict", message: `${clash} is already provided by ${claimed.get(clash)}` }); continue; }
    for (const id of ids) claimed.set(id, p.name);
  }
  const kernelIds = new Set(kernel);
  const live = () => plugins.filter((p) => !failed.has(p.name));
  // Requirements no live plugin and no kernel feature provides, until nothing changes.
  const unresolved = () => {
    for (let changed = true; changed;) {
      changed = false;
      const have = new Set([...kernelIds, ...live().flatMap((p) => provided(p.manifest))]);
      for (const p of live()) {
        const missing = (p.manifest.requires ?? []).filter((id) => !have.has(id));
        if (missing.length) { failed.set(p.name, { cause: "unresolved", message: `nothing active provides ${missing.join(", ")}` }); changed = true; }
      }
    }
  };
  unresolved();

  const order: string[] = [];
  for (const group of ORDERS) {
    for (;;) {
      const members = live().filter((p) => (p.manifest.order ?? "normal") === group && !order.includes(p.name));
      if (!members.length) break;
      const names = new Set(members.map((p) => p.name));
      const providers = new Map<string, string[]>();
      for (const p of members) for (const id of provided(p.manifest)) providers.set(id, [...(providers.get(id) ?? []), p.name]);
      // Edges inside the group: `after` names and providers of what a plugin requires come first.
      const before = new Map<string, Set<string>>(members.map((p) => [p.name, new Set([
        ...(p.manifest.after ?? []).filter((n) => names.has(n) && n !== p.name),
        ...(p.manifest.requires ?? []).flatMap((id) => providers.get(id) ?? []).filter((n) => n !== p.name),
      ])]));
      // Kahn's algorithm, ties by name in byte order (§6.3 rule 3).
      const placed = new Set<string>();
      for (;;) {
        const ready = [...before].filter(([n, deps]) => !placed.has(n) && [...deps].every((d) => placed.has(d))).map(([n]) => n).sort(byName);
        if (!ready.length) break;
        placed.add(ready[0]!);
        order.push(ready[0]!);
      }
      if (placed.size === members.length) break;
      // A cycle: the later plugin in discovery order among those on one fails (not those merely waiting behind it), then
      // the rest are placed again.
      const left = members.filter((p) => !placed.has(p.name));
      const reaches = (from: string, to: string, seen = new Set<string>()): boolean =>
        [...(before.get(from) ?? [])].some((d) => !placed.has(d) && (d === to || (!seen.has(d) && (seen.add(d), reaches(d, to, seen)))));
      const cyclic = left.filter((p) => reaches(p.name, p.name));
      const last = cyclic[cyclic.length - 1]!;
      failed.set(last.name, { cause: "cycle", message: `${last.name} is in an \`after\`/\`requires\` cycle with ${cyclic.filter((p) => p !== last).map((p) => p.name).join(", ")}` });
      for (const n of placed) order.splice(order.indexOf(n), 1);
      unresolved();
    }
  }
  return { order: order.filter((n) => !failed.has(n)), failed };
}
