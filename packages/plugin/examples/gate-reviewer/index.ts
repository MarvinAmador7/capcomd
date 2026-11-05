// Worked example, spec §15.3: the reviewer as a gate plugin. Today src/primitives/ops.ts startReview/finishReview and
// src/primitives/review.ts parseVerdict/reviewBrief are inside verifyOnce; here they are one `verify.judging` listener.
// The kernel keeps "both must pass for the same tree" (reviewFits) and fails closed on no verdict (§6.6.13).
import { definePlugin, type VetoResult } from "../../src/index";

interface Config { maxReasons: number; maxReasonChars: number }
interface Verdict { passed: boolean; reasons: string[] }

function asVerdict(v: unknown, cfg: Config): Verdict | null {
  if (!v || typeof v !== "object" || typeof (v as { passed?: unknown }).passed !== "boolean") return null;
  const o = v as { passed: boolean; reasons?: unknown; reason?: unknown; feedback?: unknown };
  const raw = o.reasons ?? o.reason ?? o.feedback;
  const reasons = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((r) => String(r).slice(0, cfg.maxReasonChars)).filter(Boolean).slice(0, cfg.maxReasons);
  return { passed: o.passed, reasons };
}

/** The reviewer's declared result data, else the last JSON object with a boolean `passed` in its final message. */
export function parseVerdict(data: unknown, text: string | null, cfg: Config): Verdict | null {
  const declared = asVerdict(data, cfg);
  if (declared) return declared;
  if (!text) return null;
  let ends = 0;
  for (let end = text.lastIndexOf("}"); end >= 0 && ends < 20; end = text.lastIndexOf("}", end - 1), ends++) {
    let starts = 0;
    for (let start = text.lastIndexOf("{", end); start >= 0 && starts < 20; start = text.lastIndexOf("{", start - 1), starts++) {
      try { const v = asVerdict(JSON.parse(text.slice(start, end + 1)), cfg); if (v) return v; } catch { /* not this span */ }
    }
  }
  return null;
}

export function reviewBrief(o: { criteria: unknown; task: string | null }): string {
  const c = o.criteria;
  const criteria = c === undefined || c === null ? null : Array.isArray(c) ? c.map((x) => `- ${String(x)}`).join("\n") : typeof c === "string" ? c : JSON.stringify(c, null, 2);
  return ["Acceptance criteria:", criteria ?? "- The change does what the task below asks, correctly and completely, without breaking existing behavior.", ...(o.task ? ["", "The change was made for this task:", o.task.slice(0, 4000)] : [])].join("\n");
}

export const plugin = definePlugin<Config>({
  activate(ctx) {
    ctx.hooks.on("verify.judging", async (call): Promise<VetoResult> => {
      const { verification, acceptance, task, reviewer } = call.payload;
      // No reviewer configured for the run: this gate has nothing to say. The checks alone decide.
      if (!reviewer) return { decision: "allow" };
      const runId = verification.runId;
      // The review spawn is keyed by the verification, so a replay of this call (§6.7) finds the same reviewer.
      const agent = await ctx.agents.spawn({
        runId, profile: reviewer, review: true,
        task: [`Review the change on ${verification.ref} (commit ${verification.tested.sha}) against ${verification.target} (${verification.tested.targetSha}).`, "", reviewBrief({ criteria: acceptance, task: task?.text ?? null }), "", 'Answer with a JSON object {"passed": true|false, "reasons": [...]} as your result (`capcomd result --data`).'].join("\n"),
        contract: { vfyId: verification.vfyId },
      }, { key: `review:${verification.vfyId}`, signal: call.signal });
      const { ended } = await ctx.agents.await(runId, [agent.id], {}, { signal: call.signal, timeoutMs: Math.max(1000, Date.parse(call.deadline) - Date.now() - 5_000) });
      const done = ended.find((a) => a.id === agent.id);
      if (!done) { await ctx.agents.cancel(runId, agent.id, "verify deadline", { signal: call.signal }).catch(() => {}); return { decision: "deny", reason: `reviewer ${agent.id} gave no verdict before the deadline` }; }
      // Agent-written text is data: the verdict is parsed from structured fields, and its reasons are shown as plain text.
      const full = await ctx.agents.get(runId, agent.id, { signal: call.signal });
      const result = (full as unknown as { result?: { data?: unknown; summary?: { text: string } | null } }).result;
      const verdict = parseVerdict(result?.data, result?.summary?.text ?? null, ctx.config.get());
      await ctx.events.emit({ type: "verdict", stream: runId, entity: verification.vfyId, text: verdict ? (verdict.passed ? "The reviewer passed the change." : "The reviewer failed the change.") : "The reviewer gave no verdict.", data: { vfyId: verification.vfyId, reviewer: agent.id, passed: verdict?.passed ?? null, reasons: verdict?.reasons ?? [] } }, { signal: call.signal });
      if (!verdict) return { decision: "deny", reason: `reviewer ${agent.id} gave no verdict` };
      return verdict.passed ? { decision: "allow" } : { decision: "deny", reason: "the reviewer failed the change", reasons: verdict.reasons };
    });
    ctx.hooks.on("verify.changed", (call) => {
      if (call.payload.change.kind === "finished") ctx.log.info("verify finished", { vfyId: call.payload.verification.vfyId, passed: call.payload.change.passed });
    });
  },
});
