// The kernel's records as the plugin API's shapes (docs/spec/plugin-api.md §3, packages/plugin/src/shapes.ts): what a
// hook payload carries. Built only when a plugin listens (src/plugins/hooks.ts).
import type { Agent, Approval, Merge, PinnedSpec, Verification } from "../../packages/plugin/src/shapes";
import type { ScopeAgent, ScopeOp } from "../actors/scope";
import { describeEvent } from "../api/describe";
import { iso } from "./hooks";

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function agentOf(a: ScopeAgent): Agent {
  const spec = (a.spec ?? {}) as Record<string, unknown>;
  return {
    id: a.agentId, runId: a.runId, parent: a.parent, depth: a.depth, profile: a.profile,
    profileVersion: a.profileVersion, profileSource: a.profileSource, status: a.status,
    text: describeEvent("agent.status_changed", { status: a.status }, a.agentId), task: a.task,
    provider: str(spec.provider), model: str(spec.model), effort: str(spec.effort), createdAt: iso(a.createdAt), updatedAt: iso(a.updatedAt),
  };
}

/** The agent's pinned spec without the kernel's own `kind` (a fake agent has none: an empty spec), with the profile
 *  it was resolved from when the agent recorded one (`PinnedSpec.profile`, as `profile.resolved` carries it). */
export function pinnedOf(a: Pick<ScopeAgent, "spec" | "profile" | "profileVersion" | "profileSource">): PinnedSpec {
  const { kind: _kind, ...spec } = (a.spec ?? {}) as Record<string, unknown>;
  const profile = a.profile && a.profileVersion !== null && a.profileSource ? { profile: { name: a.profile, version: a.profileVersion, source: a.profileSource } } : {};
  return { ...spec, ...profile } as unknown as PinnedSpec;
}

/** A verification op (vfy-…). `tested` and `passed` once its checks ran; `reasons` from its reviewer. */
export function verificationOf(runId: string, op: ScopeOp): Verification {
  const r = (op.result ?? {}) as Record<string, any>;
  const tested = r.tested && typeof r.tested.sha === "string" && typeof r.tested.targetSha === "string" ? { sha: r.tested.sha, targetSha: r.tested.targetSha } : null;
  return {
    vfyId: op.id, runId, ref: String(op.data.ref ?? ""), target: String(op.data.target ?? ""), check: str(op.data.check),
    state: op.state === "passed" || op.state === "failed" ? op.state : "running", tested,
    passed: op.state === "running" ? null : op.state === "passed", reasons: Array.isArray(r.review?.reasons) ? r.review.reasons.map(String) : [],
  };
}

export function mergeOf(runId: string, op: ScopeOp): Merge {
  const r = (op.result ?? {}) as Record<string, any>;
  const state = op.state === "merged" ? "merged" : op.state === "failed" ? "failed" : op.state === "awaiting_approval" ? "parked" : "running";
  return {
    mrgId: op.id, runId, ref: String(op.data.ref ?? ""), target: String(op.data.target ?? ""), state,
    sha: str(r.sha), pr: typeof r.pr?.number === "number" ? r.pr.number : typeof r.pr === "number" ? r.pr : null, reason: str(r.reason) ?? str(r.status === "denied" ? "denied" : null),
  };
}

/** A parked merge as an approval (harness.v1 Approval, kind merge); its id is the API's (`approvalIdFor`). */
export function approvalOf(runId: string, op: ScopeOp, approvalId: string): Approval {
  const status = op.state === "awaiting_approval" ? "pending" : op.state === "failed" && (op.result as any)?.status === "denied" ? "denied" : "approved";
  return {
    approvalId, runId, agentId: str(op.data.askedBy) ?? str(op.data.agentId), kind: "merge",
    question: `Merge ${String(op.data.branch ?? op.data.ref ?? "")} into ${String(op.data.target ?? "")}?`, subject: { target: op.data.target ?? null, ref: op.data.ref ?? null, branch: op.data.branch ?? null },
    status, requestedAt: iso(op.createdAt), expiresAt: null,
  };
}
