// The context eval's measurements and results: what an agent did (its tool calls, from `capcomd logs`) and spent (its
// agent span in the run's trace: turns, tokens, cache reads, cost, the model the CLI reported), one result row per
// scored step, the per-arm summary, and the per-model limits file the router reads (ADR-025 §6.4, D4). Pure functions,
// so tests pin them without an engine.
import type { Verdict } from "./tasks";

export interface Metrics {
  wallSeconds: number | null; turns: number | null; toolCalls: number;
  /** What the run cost: the API price, else (a plan login) the notional price of the same tokens. */
  costUsd: number | null; billing: string | null;
  inputTokens: number | null; outputTokens: number | null;
  /** Cache reads over all input tokens (ADR-025 §12 "cache_read_input_tokens ratio"); null when the CLI doesn't say. */
  cacheReadRatio: number | null;
  /** Tool calls that touched one of the step's fact files: the fact found again (re-discovery, §12 (a)). */
  factReads: number;
  model: string | null; cliVersion: string | null;
  /** Messages the runner put in the agent's inbox while it ran (span events `agent.message`): pushes that reached it. */
  messages?: number;
}

/** An agent's log lines (`capcomd logs`: `tool <Name> <input>`, `result <text>`, the CLI's own lines): what it did. */
export function actionsFromLogs(lines: readonly string[], factFiles: readonly string[] = []): Pick<Metrics, "toolCalls" | "factReads"> {
  const calls = lines.filter((l) => /^tool \S/.test(l));
  const touches = (l: string) => factFiles.some((f) => l.includes(f) || l.includes(f.split("/").pop()!));
  return { toolCalls: calls.length, factReads: calls.filter(touches).length };
}

type Span = { name?: string; attributes?: Record<string, unknown>; events?: Array<{ name?: string; attributes?: Record<string, unknown> }> };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The agent's spans (`agent.claude_code` / `agent.codex`, one per attempt) in a run's trace: what it spent. */
export function spendFromSpans(spans: readonly Span[], agentId: string): Omit<Metrics, "wallSeconds" | "toolCalls" | "factReads"> {
  const spansOf = spans.filter((s) => /^agent\.(claude_code|codex)$/.test(String(s.name)) && s.attributes?.["relay.agent_id"] === agentId);
  const mine = spansOf.map((s) => s.attributes!);
  const messages = spansOf.flatMap((s) => s.events ?? []).filter((e) => e.name === "agent.message").reduce((n, e) => n + (num(e.attributes?.["agent.messages"]) ?? 0), 0);
  const sum = (k: string) => { const v = mine.map((x) => num(x[k])).filter((x): x is number => x !== null); return v.length ? v.reduce((x, y) => x + y, 0) : null; };
  const input = sum("gen_ai.usage.input_tokens"), cached = sum("gen_ai.usage.cache_read.input_tokens");
  const billing = mine.map((x) => x["agent.billing"]).find((x) => typeof x === "string") as string | undefined;
  const cost = billing === "subscription" ? sum("agent.notional_cost_usd") : sum("agent.cost_usd");
  const last = <T>(k: string) => mine.map((x) => x[k]).filter((x) => typeof x === "string").pop() as T | undefined;
  return {
    turns: sum("agent.turns"), costUsd: cost === null ? null : Math.round(cost * 1e4) / 1e4, billing: billing ?? null,
    inputTokens: input, outputTokens: sum("gen_ai.usage.output_tokens"),
    cacheReadRatio: input && cached !== null ? Math.round((cached / input) * 1000) / 1000 : null,
    model: last<string>("gen_ai.response.model") ?? null, cliVersion: last<string>("agent.version") ?? null, messages,
  };
}

export interface Row {
  arm: string; rep: number; chain: string; family: string; step: string;
  runId: string | null; agentId: string | null; status: string;
  verdict: Verdict; metrics: Metrics | null; landed?: boolean;
  /** Why the step has no real verdict (the agent never ran, the check couldn't run): not the agent's failure. */
  harnessError?: string;
  /** What the arm delivered beyond the brief (./deliver.ts): the files inlined, the files pushed. */
  delivered?: { inlined?: string[]; pushed?: string[] };
}

const frac = (k: number, n: number) => `${k}/${n}`;
const mean = (xs: Array<number | null | undefined>) => { const v = xs.filter((x): x is number => typeof x === "number"); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null; };

/** Per arm and step: successes, the answer classes, probes, citations and the means of the metrics. */
export function summarize(rows: readonly Row[]) {
  const out: Record<string, any> = {};
  for (const arm of [...new Set(rows.map((r) => r.arm))]) {
    const rs = rows.filter((r) => r.arm === arm);
    const scored = rs.filter((r) => !r.harnessError);
    const steps: Record<string, any> = {};
    for (const step of [...new Set(rs.map((r) => r.step))]) {
      const xs = rs.filter((r) => r.step === step), ok = xs.filter((r) => !r.harnessError);
      const classes: Record<string, number> = {};
      for (const r of ok) classes[r.verdict.class ?? (r.verdict.success ? "pass" : "fail")] = (classes[r.verdict.class ?? (r.verdict.success ? "pass" : "fail")] ?? 0) + 1;
      steps[step] = {
        success: frac(ok.filter((r) => r.verdict.success).length, ok.length), classes,
        ...(ok.some((r) => r.verdict.probe) ? { probePassed: frac(ok.filter((r) => r.verdict.probe?.passed).length, ok.filter((r) => r.verdict.probe).length) } : {}),
        ...(ok.some((r) => r.verdict.cited !== undefined) ? { cited: Object.fromEntries([...new Set(ok.map((r) => String(r.verdict.cited ?? "none")))].map((c) => [c, ok.filter((r) => String(r.verdict.cited ?? "none") === c).length])) } : {}),
        ...(xs.length > ok.length ? { harnessErrors: xs.length - ok.length } : {}),
        wallSeconds: mean(ok.map((r) => r.metrics?.wallSeconds)), toolCalls: mean(ok.map((r) => r.metrics?.toolCalls)), turns: mean(ok.map((r) => r.metrics?.turns)),
        factReads: mean(ok.map((r) => r.metrics?.factReads)), costUsd: mean(ok.map((r) => r.metrics?.costUsd)), cacheReadRatio: mean(ok.map((r) => r.metrics?.cacheReadRatio)),
      };
    }
    out[arm] = {
      success: frac(scored.filter((r) => r.verdict.success).length, scored.length), steps,
      totalCostUsd: Math.round(scored.reduce((x, r) => x + (r.metrics?.costUsd ?? 0), 0) * 1e4) / 1e4,
      totalWallSeconds: scored.reduce((x, r) => x + (r.metrics?.wallSeconds ?? 0), 0),
    };
  }
  return out;
}

/** The router's budgets for one model (ADR-025 §6.4): the eval's output, starting from D4's values until it measures. */
export interface Limits {
  schema: "capcomd.context-limits/v1"; model: string;
  briefBytes: number; indexLines: number; descriptionChars: number; itemBytes: number | null; proposalsPerRun: number | null;
  /** Inline items (k, §6.1): the brief's first k items in full as a fenced first message; 0 until an arm admits them. */
  inlineItems: number;
  /** Triggered injection (§6.3): an item pushed as a fenced `context` message on a first touch; off until admitted. */
  triggeredInjection: boolean;
  measured: boolean; source: string; evidence: string[];
  /** Why inlineItems and triggeredInjection have their values: the run that decided each, and its reason. */
  decisions?: Partial<Record<"inlineItems" | "triggeredInjection", { evidence: string; reason: string }>>;
}

export function startingLimits(model: string): Limits {
  return {
    schema: "capcomd.context-limits/v1", model, briefBytes: 25_600, indexLines: 200, descriptionChars: 150, itemBytes: null, proposalsPerRun: null,
    inlineItems: 0, triggeredInjection: false, measured: false,
    source: "ADR-025 D4 starting values (Claude Code's 25 KB / 200-line memory index; descriptionChars from the one-line index entries of that index). itemBytes and proposalsPerRun are set by the steps that add capture and consolidation (2-3). No inline items and no triggered injection until the matrix admits them (§6.1, §6.3).",
    evidence: [],
  };
}

/** One of step 6's questions, answered for one model: an arm against the one it would extend or replace. */
export interface Admission {
  arm: string; against: string;
  question: "inline" | "triggered" | "ablation";
  /** null: not decided (an arm didn't run, or too many of its steps are harness errors); an ablation decides nothing. */
  admitted: boolean | null;
  reason: string;
  /** Scored steps passed (k/n) and the difference in steps, on the smaller n. */
  success?: { arm: string; against: string; delta: number };
  /** Means per scored step. */
  toolCalls?: { arm: number | null; against: number | null };
  costUsd?: { arm: number | null; against: number | null };
  /** Triggered: steps with a push, and steps where one reached the agent's inbox before it ended. */
  pushes?: { steps: number; reached: number };
}

/** Steps a difference in success must reach to count (README: at 3 reps, one step is noise). */
export const SUCCESS_STEPS = 2;
/** Inline items' other way in (§12: "improves success or steps at acceptable cost"): this much less work per step… */
export const FEWER_TOOL_CALLS = 0.2, FEWER_TOOL_CALLS_MIN = 0.5;
/** …at no more than this much more cost. */
export const COST_SLACK = 0.1;
/** More harness errors than this share of an arm's steps leaves its question undecided. */
const HARNESS_ERRORS_MAX = 0.1;

/**
 * Step 6's decision rules (ADR-025 §6.1, §6.3, §12 "Decision rules"), fixed before the live run, per model:
 * - inline items (§6.1: "if the eval shows a gain"): admitted when success is no lower (by SUCCESS_STEPS) and either
 *   higher by SUCCESS_STEPS, or the agents use FEWER_TOOL_CALLS (and FEWER_TOOL_CALLS_MIN) fewer tool calls per step at
 *   no more than COST_SLACK more cost per step;
 * - triggered injection (§6.3: "only while it beats the paths column on success"): admitted when success is higher by
 *   SUCCESS_STEPS;
 * - an arm that couldn't be delivered to the model's agents (`notDeliverable`) is not admitted for it;
 * - undecided when either arm has no scored step or over 10% of its steps are harness errors.
 */
export function admission(rows: readonly Row[], arm: { name: string; inline?: number; triggered?: boolean; against?: string }, notDeliverable = false): Admission {
  const against = arm.against ?? "index";
  const question: Admission["question"] = arm.inline ? "inline" : arm.triggered ? "triggered" : "ablation";
  if (notDeliverable) return { arm: arm.name, against, question, admitted: false, reason: "it can't be delivered to this model's agents" };
  const of = (name: string) => rows.filter((r) => r.arm === name);
  const x = of(arm.name), b = of(against);
  const xs = x.filter((r) => !r.harnessError), bs = b.filter((r) => !r.harnessError);
  if (!xs.length || !bs.length) return { arm: arm.name, against, question, admitted: null, reason: `${!xs.length ? arm.name : against} has no scored step` };
  const pass = (rs: readonly Row[]) => rs.filter((r) => r.verdict.success).length;
  const delta = Math.round((pass(xs) / xs.length - pass(bs) / bs.length) * Math.min(xs.length, bs.length) * 100) / 100;
  const per = (rs: readonly Row[], k: "toolCalls" | "costUsd") => mean(rs.map((r) => r.metrics?.[k]));
  const out: Admission = {
    arm: arm.name, against, question, admitted: null, reason: "",
    success: { arm: frac(pass(xs), xs.length), against: frac(pass(bs), bs.length), delta },
    toolCalls: { arm: per(xs, "toolCalls"), against: per(bs, "toolCalls") }, costUsd: { arm: per(xs, "costUsd"), against: per(bs, "costUsd") },
    // Triggered: how many steps had a push, and in how many the runner put one in the agent's inbox before it ended.
    ...(question === "triggered" ? { pushes: { steps: xs.filter((r) => r.delivered?.pushed?.length).length, reached: xs.filter((r) => r.delivered?.pushed?.length && (r.metrics?.messages ?? 0) > 0).length } } : {}),
  };
  const errs = [x, b].find((rs) => rs.length - rs.filter((r) => !r.harnessError).length > rs.length * HARNESS_ERRORS_MAX);
  if (errs) return { ...out, reason: `too many harness errors in ${errs[0]!.arm} to decide` };
  const s = `success ${out.success!.arm} against ${out.success!.against} (${delta >= 0 ? "+" : ""}${delta} steps)`;
  if (question === "ablation") return { ...out, reason: `an ablation: ${s}` };
  if (delta <= -SUCCESS_STEPS) return { ...out, admitted: false, reason: `${s}: fewer steps passed` };
  if (delta >= SUCCESS_STEPS) return { ...out, admitted: true, reason: `${s}: more steps passed` };
  if (question === "triggered") return { ...out, admitted: false, reason: `${s}: no gain in success over the paths column, which §6.3 requires (a push reached the agent in ${out.pushes!.reached} of the ${out.pushes!.steps} steps that had one)` };
  const tc = out.toolCalls!, cost = out.costUsd!;
  const fewer = tc.arm !== null && tc.against !== null && tc.against - tc.arm >= Math.max(FEWER_TOOL_CALLS_MIN, tc.against * FEWER_TOOL_CALLS);
  const affordable = cost.arm === null || cost.against === null || cost.arm <= cost.against * (1 + COST_SLACK);
  const work = `${tc.arm} tool calls per step against ${tc.against}, $${cost.arm} per step against $${cost.against}`;
  if (fewer && affordable) return { ...out, admitted: true, reason: `${s}; ${work}: less work at an acceptable cost` };
  return { ...out, admitted: false, reason: `${s}; ${work}: ${fewer ? "less work, but at more than " + COST_SLACK * 100 + "% more cost" : "no gain in success or work"}` };
}

/** Every arm of the run that asks one of step 6's questions or is an ablation of the brief, for one model. */
export function admissions(rows: readonly Row[], arms: ReadonlyArray<{ name: string; inline?: number; triggered?: boolean; against?: string }>, notDeliverable: readonly string[] = []): Admission[] {
  return arms.filter((a) => a.against).map((a) => admission(rows, a, notDeliverable.includes(a.name)));
}

/** A model's limits file after a run that answered step 6's questions: inlineItems is the largest admitted k (0 when
 *  none was), triggeredInjection whether it was admitted; an undecided question leaves its value as it was. */
export function decidedLimits(prev: Limits, decided: readonly Admission[], evidence: string): Limits {
  const next: Limits = { ...prev, triggeredInjection: prev.triggeredInjection ?? false, decisions: { ...prev.decisions } };
  const inline = decided.filter((d) => d.question === "inline" && d.admitted !== null);
  if (inline.length) {
    const ks = inline.filter((d) => d.admitted).map((d) => Number(/k(\d+)$/.exec(d.arm)?.[1] ?? 0));
    next.inlineItems = ks.length ? Math.max(...ks) : 0;
    next.decisions!.inlineItems = { evidence, reason: inline.map((d) => `${d.arm}: ${d.admitted ? "admitted" : "not admitted"}, ${d.reason}`).join("; ") };
  }
  const trig = decided.find((d) => d.question === "triggered" && d.admitted !== null);
  if (trig) {
    next.triggeredInjection = trig.admitted === true;
    next.decisions!.triggeredInjection = { evidence, reason: `${trig.arm}: ${trig.admitted ? "admitted" : "not admitted"}, ${trig.reason}` };
  }
  if ((inline.length || trig) && !next.evidence.includes(evidence)) next.evidence = [...next.evidence, evidence];
  if (!Object.keys(next.decisions!).length) delete next.decisions;
  return next;
}
