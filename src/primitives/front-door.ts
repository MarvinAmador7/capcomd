// A kernel front door's operations (docs/spec/plugin-api.md §6.1, the owner's decision of 2026-11-08): the CLI's and
// `capcomd mcp`'s verify, merge and approval of a merge run in the daemon that hosts their engine (capability
// ops.front_door, src/api/front-door.ts), so every plugin's gate judges them, an out-of-process plugin's too, exactly as
// it judges an agent's. With no daemon to take one, the front door runs it itself, as before, once nothing it can't ask
// must judge it (src/plugins/unconsulted.ts: a gate refuses it; any other listener it can't ask is named, skipped).
// Each answers within `waitMs` (unbounded: until the operation ends): its record, or its id while it still runs.
import type { HookName } from "../../packages/plugin/src/hooks";
import type { ClientScope } from "../api/clients";
import { FRONT_WAIT_MAX_MS } from "../api/contract";
import { RelayError } from "../core/errors";
import type { Unconsulted } from "../plugins/unconsulted";
import type { MergeOpts, VerifyOpts } from "./ops";

/** An operation's end (its record; `where` it ran; `skipped`: the listeners a front door that ran it itself couldn't
 *  ask), or its id while it still runs. */
export type FrontAnswer = { done: true; value: any; where: "daemon" | "here"; skipped: Unconsulted[] } | { done: false; id: string };

/** The hooks each operation fires (§6.6), where it runs: the plugins the daemon would ask. */
export const FRONT_HOOKS = {
  verify: ["verify.starting", "verify.judging", "verify.changed"],
  merge: ["merge.landing", "merge.changed"],
  decide: ["approval.deciding", "approval.changed", "merge.landing", "merge.changed"],
} as const satisfies Record<string, readonly HookName[]>;

/** `what`: how the front door names the operation; `waitMs`: how long to wait for its end (unbounded: until it ends);
 *  `skipping`: told before an operation this process runs itself starts, of the listeners it can't ask. */
type Wait = { waitMs?: number; what: string; skipping?: (skipped: Unconsulted[], why: string) => void };

/** This process's drive settings, with the agents file its profiles resolve from (the project's where it runs), as
 *  spawnAgent records them on an agent: the daemon runs the operation with them, so a run's reviewer is the profile this
 *  project defines, as when the operation ran here. */
async function ownDriveEnv(): Promise<{ driveEnv: Record<string, string> }> {
  const { captureDriveEnv } = await import("../utils/env");
  const { agentsFilePath } = await import("../profiles/load");
  const { resolve } = await import("node:path");
  return { driveEnv: { ...captureDriveEnv(), CAPCOMD_AGENTS_FILE: resolve(agentsFilePath()) } };
}

/** `capcomd verify`, `capcomd_verify`: verifyRef (src/primitives/ops.ts), in the daemon when one hosts the engine. */
export async function frontVerify(o: VerifyOpts, w: Wait): Promise<FrontAnswer> {
  const body = {
    ...(o.ref ? { ref: o.ref } : {}), ...(o.id ? { id: o.id } : {}), ...(o.check !== undefined ? { check: o.check } : {}), ...(o.checks !== undefined ? { checks: o.checks } : {}),
    ...(o.acceptance !== undefined ? { acceptance: o.acceptance } : {}), ...(o.target !== undefined ? { target: o.target } : {}),
    ...((o.reviewProfile ?? o.judgeProfile) !== undefined ? { reviewProfile: o.reviewProfile ?? o.judgeProfile } : {}), ...(o.key !== undefined ? { key: o.key } : {}),
    ...(await ownDriveEnv()),
  };
  return front(`/v1/runs/${encodeURIComponent(o.runId)}/verifications`, "steer", body, (id) => ({ id }), FRONT_HOOKS.verify, w, async () => {
    const O = await import("./ops");
    const id = o.id ?? O.verifyIdFor(o.runId, o.ref, o.key);
    return { id, done: O.verifyRef({ ...o, id }) };
  });
}

/** The protected-branch patterns this process sets itself (CAPCOMD_PROTECTED_BRANCHES), for a merge it sends to the
 *  daemon: they protect a target there too (never unprotect one), as they did when the merge ran here. */
async function ownProtected(): Promise<{ protectedBranches?: string[] }> {
  const { env } = await import("../utils/env");
  if (env("PROTECTED_BRANCHES") === undefined) return {};
  const patterns = (await import("../utils/protected")).protectedPatterns();
  return patterns.length ? { protectedBranches: patterns } : {};
}

/** `capcomd merge`, `capcomd_merge`: mergeRef, in the daemon when one hosts the engine. */
export async function frontMerge(o: MergeOpts, w: Wait): Promise<FrontAnswer> {
  if (o.askedBy !== undefined) throw new RelayError("usage", "askedBy is an agent's merge (its RPC), never a front door's", "Leave askedBy out.");
  const body = {
    ...(o.ref ? { ref: o.ref } : {}), ...(o.id ? { id: o.id } : {}), ...(o.require !== undefined ? { require: o.require } : {}), ...(o.target !== undefined ? { target: o.target } : {}),
    ...(o.operator ? { operator: true } : {}), ...(o.requestApproval ? { requestApproval: true } : {}), ...(o.key !== undefined ? { key: o.key } : {}),
    ...(await ownProtected()), ...(await ownDriveEnv()),
  };
  return front(`/v1/runs/${encodeURIComponent(o.runId)}/merges`, "steer", body, (id) => ({ id }), FRONT_HOOKS.merge, w, async () => {
    const O = await import("./ops");
    const id = o.id ?? (await O.mergeIdFor(o.runId, o.ref, o.key, o.target));
    return { id, done: O.mergeRef({ ...o, id }) };
  });
}

/** `capcomd approve <runId> <mrg-…>`, `capcomd_approve`: decideMerge, in the daemon when one hosts the engine. */
export async function frontDecide(runId: string, mergeId: string, d: { approve: boolean; by: string; reason?: string }, w: Wait): Promise<FrontAnswer> {
  // Its own key: a poll after the decision ended gets its record, never a second decision (src/api/front-door.ts).
  const body = { approve: d.approve, by: d.by, ...(d.reason ? { reason: d.reason } : {}), key: `fd-${crypto.randomUUID()}`, ...(await ownDriveEnv()) };
  return front(`/v1/runs/${encodeURIComponent(runId)}/merges/${encodeURIComponent(mergeId)}/decision`, "approve", body, () => body, FRONT_HOOKS.decide, w, async () => {
    const O = await import("./ops");
    return { id: mergeId, done: O.decideMerge(runId, mergeId, d) };
  });
}

/**
 * One operation: on the daemon that hosts this engine (asked again with `poll(id)` while it runs, until `w.waitMs`
 * passes), else here (`local`) once `unconsulted` lets it.
 */
async function front(path: string, scope: ClientScope, body: Record<string, unknown>, poll: (id: string) => Record<string, unknown>, hooks: readonly HookName[], w: Wait,
  local: () => Promise<{ id: string; done: Promise<unknown> }>): Promise<FrontAnswer> {
  const D = await import("../cli/daemon");
  const until = Date.now() + (w.waitMs ?? Number.POSITIVE_INFINITY);
  const daemon = await D.engineDaemon();
  let why = daemon ? "" : "no daemon runs for this engine to ask them";
  if (daemon) {
    let next = body, started: string | null = null;
    for (;;) {
      const left = until - Date.now();
      const r = await D.daemonOp(daemon, path, { ...next, waitMs: Math.max(0, Math.min(FRONT_WAIT_MAX_MS, left)) }, scope);
      if (r.kind === "done") return { done: true, value: r.value, where: "daemon", skipped: [] };
      if (r.kind === "running") {
        started = r.id;
        (await import("./ops")).noteStartedInDaemon(r.id); // its record may not be written yet: a wait counts it running
        if (until - Date.now() <= 0) return { done: false, id: r.id };
        next = poll(r.id);
        continue;
      }
      // Gone while it ran: never run it again here (it may be running still, or have ended there).
      if (started) throw new RelayError("run_failed", `the daemon went away while ${w.what} ran (${started}): ${r.reason}`, `Start the daemon (\`capcomd serve\`) and ask again for ${started}: it picks the operation up.`, { code: "daemon_unreachable", retryable: true });
      why = r.reason;
      break;
    }
  }
  const U = await import("../plugins/unconsulted");
  const skipped = await U.unconsulted(w.what, hooks, why);
  if (skipped.length) w.skipping?.(skipped, why);
  const { id, done } = await local();
  if (w.waitMs === undefined) return { done: true, value: await done, where: "here", skipped };
  done.catch(() => {}); // a timed-out call leaves it running; its error reaches the next call
  let timer: ReturnType<typeof setTimeout> | undefined;
  const left = Math.max(0, until - Date.now());
  const r = await Promise.race([done.then((value) => ({ value })), new Promise<null>((res) => { timer = setTimeout(() => res(null), left); })]).finally(() => clearTimeout(timer));
  return r ? { done: true, value: r.value, where: "here", skipped } : { done: false, id };
}
