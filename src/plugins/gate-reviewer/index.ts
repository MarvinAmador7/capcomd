// The reviewer gate (docs/spec/plugin-api.md §15.3, §6.6.13), a built-in plugin: the run's reviewer profile (`run new
// --reviewer P`, or a verify's --review-profile) reads each change the checks passed and gives a verdict. It is one
// judge of `verify.judging`; the kernel ANDs the checks and every judge, and keeps "both for the same tree" (reviewFits).
// Built in and in process, it uses the kernel's agent primitives directly: the reviewer is spawned under the verify's
// caller (who pays for it), in review mode (exempt from that caller's fan-out limits), keyed by the verification.
//  - verify.starting: the reviewer starts alongside the checks (CAPCOMD_REVIEW_PARALLEL=0 turns it off), for the agent's
//    pushed commit on the target as it is now. It answers at once; the start goes on in the background.
//  - verify.judging: once the checks passed, the reviewer that read the tree they tested (else a new one for it) is
//    awaited; its verdict is the answer, with the review as `review` for the verification's record.
// No reviewer → allow (the checks decide alone). No verdict → deny (fail closed). A reviewer the verify doesn't need in
// the end (the checks failed, the work had landed) is stopped by the kernel when the verify finishes.
import { definePlugin } from "../../../packages/plugin/src/context";
import type { HookCall, JudgeResult, ReviewReport } from "../../../packages/plugin/src/hooks";
import type { Principal } from "../../../packages/plugin/src/shapes";
import type { Budget } from "../../primitives/policy";
import { env } from "../../utils/env";
import { inBackground } from "../hooks";
import { reviewBrief } from "./review";

const kernel = () => import("../../primitives/ops");

interface Review { profile: string; agentId: string | null; passed: boolean; reasons: string[]; error?: string }
/** What a reviewer reads: the agent's commit `sha`, merged onto `target` at `targetSha` (the tree the checks test) when
 *  that is known; without a repository (a dry run) the commit alone. */
interface ReviewTarget { runId: string; vfyId: string; profile: string; branch: string; sha: string; target: string; targetSha?: string; agentId: string | null; acceptance?: unknown; parent?: string; key?: string }
type Reviewing = { agentId: string; sha: string; targetSha?: string; spec: Record<string, any> | null; startedAt: number } | { failed: Review };

/** Reviewers started with the checks, by verification: what this process's verify.judging calls take up. */
const early = new Map<string, Promise<Reviewing | null>>();
const EARLY_MAX = 500;

/**
 * Whether the reviewer starts with the checks instead of after them. The reviewer reads what the checks test (the
 * agent's pushed commit merged onto the target as it is when the verify starts, in its own checkout), not the checks'
 * result, so it needn't wait for them: a verify then takes about max(checks, review) instead of their sum. The gate is
 * unchanged: both must pass, for the same tree (a reviewer that read another commit or another target than the checks
 * tested is replaced by one for the tested tree: reviewFits). The price: when the checks fail (a conflict included),
 * the reviewer has already started, and is cancelled (a few seconds of its tokens).
 */
const reviewInParallel = () => env("REVIEW_PARALLEL") !== "0";

/** The agent a verify's caller is, when it is one: its reviewer is that agent's child (the operator's: the run's). */
const parentOf = (p: Principal): string | undefined => (p.kind === "agent" ? p.agentId : undefined);

/** The verification's record: its branch and the agent whose work it is (recorded before verify.starting fires). */
async function opOf(runId: string, vfyId: string): Promise<{ branch: string; agentId: string | null; target: string }> {
  const { client } = await import("../../core/relay");
  const op = await client().scope.getOrCreate([runId]).getOp({ opId: vfyId });
  if (!op) throw new Error(`verification ${vfyId} not found in ${runId}`);
  return { branch: String(op.data.branch ?? ""), agentId: (op.data.agentId as string | null) ?? null, target: String(op.data.target ?? "") };
}

const reviewFailed = (o: ReviewTarget, reviewer: string | null, e: unknown): Review =>
  ({ profile: o.profile, agentId: reviewer, passed: false, reasons: [], error: `review failed: ${String((e as Error)?.message ?? e).slice(0, 300)}` });

/** Spawn the reviewer for this verification (keyed: a retry reuses it). */
async function startReview(o: ReviewTarget): Promise<Reviewing> {
  try {
    const O = await kernel();
    const spec = O.reviewerSpec(o.profile);
    const childTask = o.agentId ? (await O.getAgentOrThrow(o.runId, o.agentId)).task : null;
    const requested: Budget = {};
    if (spec?.maxTurns) requested.turns = spec.maxTurns;
    if (spec?.timeoutMs) requested.wallSeconds = Math.ceil(spec.timeoutMs / 1000);
    if (spec?.maxBudgetUsd) requested.usd = spec.maxBudgetUsd;
    const r = await O.spawnAgent({
      runId: o.runId, task: reviewBrief({ criteria: o.acceptance, childTask }), profile: o.profile, key: o.key ?? `review-${o.vfyId}`,
      ...(o.parent ? { parent: o.parent } : {}), contract: { review: { sha: o.sha, branch: o.branch, target: o.target, ...(o.targetSha ? { targetSha: o.targetSha } : {}), of: o.agentId ?? o.branch, vfyId: o.vfyId } },
      ...(Object.keys(requested).length ? { budget: requested } : {}), review: true,
    });
    return { agentId: r.agentId, sha: o.sha, ...(o.targetSha ? { targetSha: o.targetSha } : {}), spec, startedAt: Date.now() };
  } catch (e) { return { failed: reviewFailed(o, null, e) }; }
}

/** Await the reviewer, read its verdict, within `waitMs` (the judging call's deadline). Fails closed. */
async function finishReview(o: ReviewTarget, started: Reviewing, waitMs: number): Promise<Review> {
  if ("failed" in started) return started.failed;
  try {
    const O = await kernel();
    const { agentId, spec } = started;
    const [a] = (await O.awaitAgents(o.runId, [agentId], { timeoutMs: Math.min(spec?.timeoutMs ? spec.timeoutMs + 10 * 60_000 : Infinity, waitMs) })).agents as any[];
    const v = a?.status === "done" ? (a.result?.verdict ?? null) : null;
    if (v) return { profile: o.profile, agentId, passed: v.passed === true, reasons: v.reasons ?? [] };
    if (a && (a.status === "running" || a.status === "pending")) {
      dropReview(o.runId, started, "the verify's deadline passed");
      return { profile: o.profile, agentId, passed: false, reasons: [], error: "the reviewer gave no verdict before the verify's deadline" };
    }
    return { profile: o.profile, agentId, passed: false, reasons: [], error: a?.status === "done" ? 'the reviewer gave no verdict (expected a final line {"passed": true|false, "reasons": [...]})' : `the reviewer ended ${a?.status ?? "unknown"}${a?.result?.error ? `: ${String(a.result.error).slice(0, 300)}` : ""}` };
  } catch (e) { return reviewFailed(o, started.agentId, e); }
}

/** A reviewer that turned out not to be needed (it read another tree): stop it, best effort. */
function dropReview(runId: string, started: Reviewing | null, why: string) {
  if (started && !("failed" in started)) inBackground(kernel().then((O) => O.cancelAgents(runId, started.agentId, why)));
}

/** The key of a reviewer that replaces one that read another tree: the tested commit, and the target when it moved. */
function replacementKey(vfyId: string, first: Reviewing, tested: { taskSha: string; targetSha?: string }): string {
  const moved = !("failed" in first) && first.sha === tested.taskSha && tested.targetSha;
  return `review-${vfyId}-${tested.taskSha.slice(0, 12)}${moved ? `-${tested.targetSha!.slice(0, 12)}` : ""}`;
}

/**
 * The reviewer that starts with the checks, for the agent's pushed commit merged onto the target as it is now (its tip
 * on the remote, one ls-remote). A verify that runs again (its process went away) keeps the target its first reviewer
 * was given, so that reviewer is the same agent (keyed), not a conflict. The target's tip unknown (the remote didn't
 * answer): no early reviewer; one starts after the checks, for the tree they tested. No repository (a dry run): the
 * commit alone, as there is no target to put it on. No pushed commit: none.
 */
async function startEarlyReview(o: { runId: string; vfyId: string; profile: string; acceptance: unknown; parent?: string }): Promise<Reviewing | null> {
  const O = await kernel();
  const { branch, agentId, target } = await opOf(o.runId, o.vfyId);
  const pushed = agentId ? ((await O.getAgentOrThrow(o.runId, agentId)).result?.commit as string | undefined) : undefined;
  if (!pushed) return null;
  const of = (targetSha: string | undefined): ReviewTarget => ({ runId: o.runId, vfyId: o.vfyId, profile: o.profile, branch, sha: pushed, target, ...(targetSha ? { targetSha } : {}), agentId, acceptance: o.acceptance ?? undefined, ...(o.parent ? { parent: o.parent } : {}) });
  const cfg = await (await import("../../merge/run-config")).mergeConfigFor(o.runId).catch(() => null);
  if (!cfg) return startReview(of(undefined));
  const { client } = await import("../../core/relay");
  const { stableId } = await import("../../primitives/policy");
  const prior: any = await client().scope.getOrCreate([o.runId]).getAgent({ agentId: stableId("agt", `${o.runId}\0${o.parent ?? "operator"}`, `review-${o.vfyId}`) }).catch(() => null);
  if (prior?.contract?.review) return startReview(of(typeof prior.contract.review.targetSha === "string" ? prior.contract.review.targetSha : undefined));
  const targetSha = await (await import("../../merge/repo")).remoteBranchSha(cfg, target, 15_000).catch(() => null);
  return targetSha ? startReview(of(targetSha)) : null;
}

/** The judge's answer: the verdict, with the review for the verification's record (§6.6.13). */
function answer(review: Review, read: { sha: string; targetSha?: string }, startedAt: number | null): JudgeResult {
  const report: ReviewReport = {
    profile: review.profile, agentId: review.agentId, passed: review.passed, reasons: review.reasons, ...(review.error ? { error: review.error } : {}),
    sha: read.sha, ...(read.targetSha ? { targetSha: read.targetSha } : {}), ...(startedAt ? { startedAt: new Date(startedAt).toISOString() } : {}),
  };
  if (review.passed) return { decision: "allow", review: report };
  return { decision: "deny", reason: review.error ?? `the reviewer (${review.profile}) failed the change`, reasons: review.reasons, review: report };
}

export const plugin = definePlugin({
  activate(ctx) {
    ctx.hooks.on("verify.starting", (call) => {
      const { verification: v, reviewer, acceptance } = call.payload;
      if (reviewer && reviewInParallel()) {
        const p = startEarlyReview({ runId: v.runId, vfyId: v.vfyId, profile: reviewer, acceptance, parent: parentOf(call.principal) })
          .then(async (r) => {
            // Checks that failed fast can end the verify before this reviewer existed for the kernel to stop: stop it here.
            if (r && !("failed" in r) && (await (await kernel()).finishedVerify(v.runId, v.vfyId))) { dropReview(v.runId, r, "not needed: the verification ended"); early.delete(v.vfyId); }
            return r;
          }).catch(() => null);
        early.set(v.vfyId, p);
        inBackground(p);
        if (early.size > EARLY_MAX) early.delete(early.keys().next().value!);
      }
      return { decision: "allow" };
    });

    ctx.hooks.on("verify.judging", async (call): Promise<JudgeResult> => {
      const { verification: v, reviewer } = call.payload;
      // No reviewer for this verification: this judge has nothing to say. The checks (and the other judges) decide.
      if (!reviewer) return { decision: "allow" };
      // Fails closed with its own answer, never by throwing: three failed calls in a row would suspend this plugin, and a
      // suspended gate denies every verify, with a reviewer or not (§6.5).
      try { return await judge(call); } catch (e) {
        return answer({ profile: reviewer, agentId: null, passed: false, reasons: [], error: `review failed: ${String((e as Error)?.message ?? e).slice(0, 300)}` }, { sha: v.tested?.commit || "unknown", ...(v.tested?.targetSha ? { targetSha: v.tested.targetSha } : {}) }, null);
      }
    });
  },
});

/** verify.judging with a reviewer: take up the early reviewer, or start one for the tested tree, and await its verdict. */
async function judge(call: HookCall<"verify.judging">): Promise<JudgeResult> {
  const { verification: v, acceptance } = call.payload;
  const reviewer = call.payload.reviewer!;
  const tested = { taskSha: v.tested.commit, targetSha: v.tested.targetSha };
  const first = (await early.get(v.vfyId)) ?? null;
  early.delete(v.vfyId);
  const { branch, agentId } = await opOf(v.runId, v.vfyId);
  const parent = parentOf(call.principal);
  const of = (key?: string): ReviewTarget => ({ runId: v.runId, vfyId: v.vfyId, profile: reviewer, branch, sha: tested.taskSha, target: v.target, targetSha: tested.targetSha, agentId, acceptance: acceptance ?? undefined, ...(parent ? { parent } : {}), ...(key ? { key } : {}) });
  // The reviewer must have read the tree the checks tested; one that read another (the branch or the target moved
  // between the reviewer's start and the checks' integration) is replaced by one for the tested tree.
  const O = await kernel();
  let started = first && !("failed" in first) && !O.reviewFits(first, tested) ? (dropReview(v.runId, first, first.sha !== tested.taskSha ? "replaced: it read another commit than the one the checks tested" : "replaced: the target moved before the checks put the change on it"), null) : first;
  started ??= await startReview(of(first ? replacementKey(v.vfyId, first, tested) : undefined));
  const review = await finishReview(of(), started, Math.max(1000, Date.parse(call.deadline) - Date.now() - 5_000));
  return answer(review, "failed" in started ? { sha: tested.taskSha, targetSha: tested.targetSha } : started, "failed" in started ? null : started.startedAt);
}
