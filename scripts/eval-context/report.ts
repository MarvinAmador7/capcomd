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
}

/** An agent's log lines (`capcomd logs`: `tool <Name> <input>`, `result <text>`, the CLI's own lines): what it did. */
export function actionsFromLogs(lines: readonly string[], factFiles: readonly string[] = []): Pick<Metrics, "toolCalls" | "factReads"> {
  const calls = lines.filter((l) => /^tool \S/.test(l));
  const touches = (l: string) => factFiles.some((f) => l.includes(f) || l.includes(f.split("/").pop()!));
  return { toolCalls: calls.length, factReads: calls.filter(touches).length };
}

type Span = { name?: string; attributes?: Record<string, unknown> };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The agent's spans (`agent.claude_code` / `agent.codex`, one per attempt) in a run's trace: what it spent. */
export function spendFromSpans(spans: readonly Span[], agentId: string): Omit<Metrics, "wallSeconds" | "toolCalls" | "factReads"> {
  const mine = spans.filter((s) => /^agent\.(claude_code|codex)$/.test(String(s.name)) && s.attributes?.["relay.agent_id"] === agentId).map((s) => s.attributes!);
  const sum = (k: string) => { const v = mine.map((x) => num(x[k])).filter((x): x is number => x !== null); return v.length ? v.reduce((x, y) => x + y, 0) : null; };
  const input = sum("gen_ai.usage.input_tokens"), cached = sum("gen_ai.usage.cache_read.input_tokens");
  const billing = mine.map((x) => x["agent.billing"]).find((x) => typeof x === "string") as string | undefined;
  const cost = billing === "subscription" ? sum("agent.notional_cost_usd") : sum("agent.cost_usd");
  const last = <T>(k: string) => mine.map((x) => x[k]).filter((x) => typeof x === "string").pop() as T | undefined;
  return {
    turns: sum("agent.turns"), costUsd: cost === null ? null : Math.round(cost * 1e4) / 1e4, billing: billing ?? null,
    inputTokens: input, outputTokens: sum("gen_ai.usage.output_tokens"),
    cacheReadRatio: input && cached !== null ? Math.round((cached / input) * 1000) / 1000 : null,
    model: last<string>("gen_ai.response.model") ?? null, cliVersion: last<string>("agent.version") ?? null,
  };
}

export interface Row {
  arm: string; rep: number; chain: string; family: string; step: string;
  runId: string | null; agentId: string | null; status: string;
  verdict: Verdict; metrics: Metrics | null; landed?: boolean;
  /** Why the step has no real verdict (the agent never ran, the check couldn't run): not the agent's failure. */
  harnessError?: string;
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
  /** Inline items in the brief (k). v1 ships none (§6.1); this is the k the matrix tries first if it ever admits them. */
  inlineItems: number;
  measured: boolean; source: string; evidence: string[];
}

export function startingLimits(model: string): Limits {
  return {
    schema: "capcomd.context-limits/v1", model, briefBytes: 25_600, indexLines: 200, descriptionChars: 150, itemBytes: null, proposalsPerRun: null, inlineItems: 1,
    measured: false,
    source: "ADR-025 D4 starting values (Claude Code's 25 KB / 200-line memory index, ReasoningBank's k = 1; descriptionChars from the one-line index entries of that index). itemBytes and proposalsPerRun are set by the steps that add capture and consolidation (2-3). Not yet measured: the step-0 baselines have no index arm.",
    evidence: [],
  };
}
