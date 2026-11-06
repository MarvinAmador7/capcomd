import { join } from "path";
import { killpoint } from "../utils/killpoint";
import { loadMergeConfig, type MergeConfig } from "./config";
import { withTargetLock } from "./lock";
import { directMerge, directVerify } from "./direct";
import { prMerge } from "./pr";
import { sameHold, type MergeGate, type MergeOutcome, type MergeRequest, type MergeTimings } from "./types";
import { hooks, recordGateEvent, refusedText } from "../plugins/hooks";
import { ForgeNotActive, forgeFor, orList, pullRequestLabels } from "../plugins/forges";

/**
 * Land (or, with testOnly, just verify) one task. Serialized per (remote, target). The kernel fetches, integrates and
 * checks; the project's forge (docs/spec/plugin-api.md §7.4) lands the checked commit under the target's lock.
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
    let forge;
    try { forge = await forgeFor(cfg); } catch (e) { if (e instanceof ForgeNotActive) return { status: "failed", reason: e.message }; throw e; }
    if (!direct && !forge?.describe().pullRequests) {
      // Said in the words of the forges that have pull requests ("a GitHub repo"); none active: say that instead.
      const prs = await pullRequestLabels();
      return { status: "failed", reason: prs.length
        ? `pr mode needs a ${orList(prs)} repo (one its forge claims, or CAPCOMD_MERGE_FORGE naming a forge with pull requests); remote is ${cfg.remote}`
        : `pr mode needs a forge with pull requests, and no active forge supports them (see \`capcomd plugins list\`); remote is ${cfg.remote}` };
    }
    if (!forge) return { status: "failed", reason: `no active forge lands on ${cfg.remote}` };
    if (direct) return landed(await directMerge(cfg, req, clone, t, forge));
    const out = await prMerge(cfg, req, forge, clone);
    return landed({ ...out, timings: { ...t, ...out.timings } });
  });
}

/**
 * merge.landing (plugin API §6.6.15): under the target's lock, before anything is pushed. A deny fails the merge
 * (`plugin:<name>`); a hold parks it for a person's approval (a plugin adds a requirement, never decides one). For
 * `merge --operator` both are recorded and bypassed. After a person approved a plugin's hold, that same hold (the plugin
 * and its holdId, else the reason they were shown: `sameHold`) lets it land; every listener is asked then, so a later plugin's deny or new hold
 * still stops it.
 */
const heldOf = (h: { plugin: string; holdId?: string }) => ({ plugin: h.plugin, ...(h.holdId !== undefined ? { holdId: h.holdId } : {}) });

async function mergeLanding(req: MergeRequest, g: MergeGate): Promise<MergeOutcome | { bypassed: Array<{ plugin: string; reason: string }> }> {
  const runEnv = await (await import("./run-config")).runEnv(req.runId).catch(() => process.env);
  const approved = g.approvedHolds ?? [];
  const out = await hooks.fire("merge.landing", "veto", {
    merge: g.merge, verification: g.verification, target: { branch: req.target, protected: (await import("../utils/protected")).isProtectedBranch(req.target, runEnv), sha: req.verified?.targetSha ?? "" },
    sha: req.verified?.sha ?? req.expectSha ?? "", fastPath: !!req.verified, operator: g.operator, requestedBy: g.requestedBy,
  }, { principal: g.requestedBy, entity: g.merge.mrgId, attempt: g.attempt ?? 1, runId: req.runId, agentId: g.requestedBy.kind === "agent" ? g.requestedBy.agentId : null, askAll: g.operator || approved.length > 0 });
  if (out.decision === "allow") return { bypassed: [] };
  // `merge --operator` (§6.5): every listener was asked; each that vetoed is named on the run's stream, then it lands.
  if (g.operator && out.plugin) {
    const plugins = (out.vetoes ?? [{ plugin: out.plugin, text: out.text }]).map((v) => ({ plugin: v.plugin, reason: v.text }));
    await recordGateEvent(req.runId, { type: "plugin.gate_bypassed", data: { hook: "merge.landing", entity: g.merge.mrgId, by: "operator", plugins }, key: `gate-bypassed-${g.merge.mrgId}` });
    return { bypassed: plugins };
  }
  if (approved.length) {
    // The first veto, in order, that isn't a hold a person approved: it stops the merge as it would have.
    const satisfied = (v: { plugin: string; decision: "deny" | "hold"; text: string; holdId?: string }) => v.decision === "hold" && approved.some((h) => sameHold(h, v));
    const vetoes = out.vetoes ?? [{ plugin: out.plugin ?? "", decision: out.decision, text: out.text }];
    const next = vetoes.find((v) => !satisfied(v));
    if (!next) return { bypassed: [] };
    return next.decision === "hold" ? { status: "failed", reason: next.text, held: heldOf(next) } : { status: "failed", reason: refusedText({ plugin: next.plugin, text: next.text }) };
  }
  if (out.decision === "hold") return { status: "failed", reason: out.text, held: heldOf(out) };
  return { status: "failed", reason: refusedText(out) };
}
