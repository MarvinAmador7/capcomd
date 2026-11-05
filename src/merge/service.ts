import { join } from "path";
import { killpoint } from "../utils/killpoint";
import { loadMergeConfig, type MergeConfig } from "./config";
import { withTargetLock } from "./lock";
import { directMerge, directVerify } from "./direct";
import { prMerge } from "./pr";
import { HttpGitHub, githubToken, type GitHubApi } from "./github";
import type { MergeGate, MergeOutcome, MergeRequest, MergeTimings } from "./types";
import { hooks, recordGateEvent, refusedText } from "../plugins/hooks";

let githubOverride: GitHubApi | null = null;
/** Tests inject a fake GitHub adapter. */
export function setGitHubApi(api: GitHubApi | null) { githubOverride = api; }
/** A test injected a GitHub adapter (so no login is needed). */
export const hasGitHubOverride = () => githubOverride !== null;

/** The GitHub API for `cfg`'s repository: the injected fake, else REST with the user's token (GITHUB_TOKEN, GH_TOKEN, `gh auth token`). */
export async function github(cfg: MergeConfig): Promise<GitHubApi> {
  return githubOverride ?? new HttpGitHub(cfg.github.api, await githubToken());
}

/**
 * Land (or, with testOnly, just verify) one task. Serialized per (remote, target).
 * Returns `mode: "none"` when no repository is configured (explicit dry run).
 */
export async function mergeTask(req: MergeRequest, cfg: MergeConfig | null = loadMergeConfig()): Promise<MergeOutcome> {
  if (!cfg) {
    // No repo: nothing to merge. Kept so the orchestrator runs without git (and the old killpoints still fire).
    killpoint("merge.before_cas");
    killpoint("merge.after_cas.before_event");
    return req.testOnly
      ? { status: "verified", sha: "", output: "(no repository configured)" }
      : { status: "merged", sha: "", already: false, how: "none", strategy: "none", mode: "none", attempts: 0 };
  }
  const clone = `${req.runId}-merge`;
  const direct = (req.mode ?? cfg.mode) === "direct";
  // A direct-mode verify pushes nothing: it works in a worktree of its own, beside the others and the merges.
  if (direct && req.testOnly) return directVerify(cfg, req, clone);
  const asked = Date.now();
  return withTargetLock(join(cfg.workdir, "locks"), cfg.remote, req.target, async () => {
    killpoint("merge.lock.acquired");
    const t: MergeTimings = { lockWaitMs: Date.now() - asked };
    const gate = !req.testOnly && req.gate && hooks.listening("merge.landing") ? await mergeLanding(req, req.gate) : null;
    if (gate && "status" in gate) return { ...gate, timings: t };
    const landed = (out: MergeOutcome): MergeOutcome => (gate?.bypassed.length && out.status === "merged" ? { ...out, bypassedVetoes: gate.bypassed } : out);
    if (direct) return landed(await directMerge(cfg, req, clone, t));
    const out = await prMerge(cfg, req, await github(cfg), clone);
    return landed({ ...out, timings: { ...t, ...out.timings } });
  });
}

/**
 * merge.landing (plugin API §6.6.15): under the target's lock, before anything is pushed. A deny fails the merge
 * (`plugin:<name>`); a hold parks it for a person's approval (a plugin adds a requirement, never decides one). For
 * `merge --operator` both are recorded and bypassed.
 */
async function mergeLanding(req: MergeRequest, g: MergeGate): Promise<MergeOutcome | { bypassed: Array<{ plugin: string; reason: string }> }> {
  const runEnv = await (await import("./run-config")).runEnv(req.runId).catch(() => process.env);
  const out = await hooks.fire("merge.landing", "veto", {
    merge: g.merge, verification: g.verification, target: { branch: req.target, protected: (await import("../utils/protected")).isProtectedBranch(req.target, runEnv), sha: req.verified?.targetSha ?? "" },
    sha: req.verified?.sha ?? req.expectSha ?? "", fastPath: !!req.verified, operator: g.operator, requestedBy: g.requestedBy,
  }, { principal: g.requestedBy, entity: g.merge.mrgId, runId: req.runId, agentId: g.requestedBy.kind === "agent" ? g.requestedBy.agentId : null, askAll: g.operator });
  if (out.decision === "allow") return { bypassed: [] };
  // `merge --operator` (§6.5): every listener was asked; each that vetoed is named on the run's stream, then it lands.
  if (g.operator && out.plugin) {
    const plugins = (out.vetoes ?? [{ plugin: out.plugin, text: out.text }]).map((v) => ({ plugin: v.plugin, reason: v.text }));
    await recordGateEvent(req.runId, { type: "plugin.gate_bypassed", data: { hook: "merge.landing", entity: g.merge.mrgId, by: "operator", plugins }, key: `gate-bypassed-${g.merge.mrgId}` });
    return { bypassed: plugins };
  }
  if (out.decision === "hold") return g.holdSatisfied ? { bypassed: [] } : { status: "failed", reason: out.text, held: { plugin: out.plugin } };
  return { status: "failed", reason: refusedText(out) };
}
