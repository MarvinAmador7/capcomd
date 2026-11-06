// The context router's budgets (ADR-025 §6.4, D4): one object the router owns, its defaults the eval's output per model
// (docs/evidence/context/<model>/limits.json, bundled as ./limits.gen.ts), a profile's `context.limits` over them, and
// the kernel's floors and ceilings around both. The brief's header prints the budget and where it came from, so a stale
// constant is visible. The kernel refuses or truncates deterministically; it never summarises to fit.
import type { ContextLimitName, ContextSpec } from "../../packages/plugin/src/context-layer";
import { EVAL_LIMITS } from "./limits.gen";

export type ContextLimits = Record<ContextLimitName, number | null>;

/** D4's starting values (Claude Code's 25 KB / 200-line memory index; one-line descriptions), for a model the eval
 *  hasn't run on. `itemBytes` since capture (ADR-025 step 2): a proposed lesson over it is refused, and lint flags an
 *  item's body over it. `proposalsPerRun` since consolidation (step 3): the most candidates a run keeps (capture), and
 *  the most changes its consolidator stages (src/context/consolidate.ts), so the one hold a person reads stays short. */
export const DEFAULT_LIMITS: ContextLimits = { briefBytes: 25_600, indexLines: 200, descriptionChars: 150, itemBytes: 4096, proposalsPerRun: 20 };

/** The kernel's floor and ceiling for each budget: a profile or an eval file can't make the brief useless or huge. */
export const LIMIT_BOUNDS: Record<ContextLimitName, [number, number]> = {
  briefBytes: [1024, 102_400], indexLines: [1, 1000], descriptionChars: [20, 500], itemBytes: [256, 65_536], proposalsPerRun: [1, 100],
};

const clamp = (k: ContextLimitName, v: number | null): number | null => v === null ? null : Math.min(LIMIT_BOUNDS[k][1], Math.max(LIMIT_BOUNDS[k][0], Math.floor(v)));

/**
 * The budgets for an agent of `model` with its profile's `context.limits`: the eval's file for that model (its exact
 * name), else D4's defaults; each value the profile sets wins; all clamped. `source` is what the header prints.
 */
export function limitsFor(model: string | null | undefined, spec: ContextSpec | null | undefined): { limits: ContextLimits; source: string } {
  const evidence = model && Object.hasOwn(EVAL_LIMITS, model) ? EVAL_LIMITS[model]! : null;
  const base: ContextLimits = { ...DEFAULT_LIMITS };
  if (evidence) for (const k of Object.keys(base) as ContextLimitName[]) if (typeof evidence[k] === "number") base[k] = evidence[k];
  const own = spec?.limits ?? {};
  const set = (Object.keys(base) as ContextLimitName[]).filter((k) => typeof own[k] === "number");
  for (const k of set) base[k] = own[k] as number;
  for (const k of Object.keys(base) as ContextLimitName[]) base[k] = clamp(k, base[k]);
  const from = evidence ? `eval/${model}${evidence.measured ? "" : ", not measured yet"}` : "capcomd's defaults";
  return { limits: base, source: set.length ? `the profile, over ${from}` : from };
}
