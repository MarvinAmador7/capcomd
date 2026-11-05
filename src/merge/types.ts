import type { MergeStrategy } from "./config";

export interface MergeRequest {
  runId: string;
  taskId: string;
  /** capcomd/<run>/<task> */
  branch: string;
  target: string;
  /** Run tests only (protected target awaiting approval): integrate + verify, never push/merge. */
  testOnly?: boolean;
  /** Override the repo's test command (primitive `capcomd verify --checks`). */
  testCommand?: string;
  /** Merge only if the task branch tip is still this commit (the one `capcomd verify` passed). */
  expectSha?: string;
  /** Land it this way whatever the repo's merge mode: a run's goal branch takes reviewed work by a direct push (no PR). */
  mode?: "direct";
  /**
   * What the passing verify tested (direct mode): the commit it made by putting the branch on the target (`sha`, whose
   * tree passed the checks) and the target it made it on. When the target is still there, the merge pushes that commit
   * as it is, with no second fetch, integration or check run; when it moved, the merge does all of those again.
   */
  verified?: { sha: string; targetSha: string; how?: string };
  /** The branch's commit the caller expects (a done agent's pushed commit): a verify may then use a fetch another verify
   *  just made, when it has that commit, instead of a fetch of its own. */
  branchSha?: string;
  /** A merge (not a verify): what merge.landing's plugins are asked under the target's lock (plugin API §6.6.15). */
  gate?: MergeGate;
}

/** A plugin's hold on a merge (merge.landing `hold`, §6.6.15): who held it, the reason the approver is shown, and the
 *  plugin's own name for the hold (`holdId`) when it gave one. */
export interface PluginHold { plugin: string; reason: string; holdId?: string }

/** A merge as merge.landing's plugins see it. `approvedHolds`: the holds a person approved this merge after (each the
 *  plugin, the reason they were shown and its holdId); the same hold again (`sameHold`) lets it land, any other veto
 *  still stops it. `attempt`:
 *  which landing this is (1, then one more per approved hold), for the idempotency key (§6.7). `operator`: `merge
 *  --operator`, whose plugin vetoes are recorded and bypassed (§6.5). */
export interface MergeGate {
  merge: import("../../packages/plugin/src/shapes").Merge;
  verification: import("../../packages/plugin/src/shapes").Verification | null;
  operator: boolean;
  requestedBy: import("../../packages/plugin/src/shapes").Principal;
  attempt?: number;
  approvedHolds?: PluginHold[];
}

/** Where a verify's or a merge's time went (ms). Absent parts didn't happen. */
export interface MergeTimings {
  /** Waiting for the target's merge lock: merges into one target land one at a time. */
  lockWaitMs?: number;
  /** Fetching the target and the branch (with the wait for the clone's lock). */
  fetchMs?: number;
  /** Putting the branch on the target (squash, rebase or merge commit). */
  integrateMs?: number;
  /** Running the checks (0 when an identical tree already passed them: checksWhere "reused"). */
  checksMs?: number;
  /** Where the checks ran: a fresh sandbox (vm), the host, not at all because this tree passed them already (reused). */
  checksWhere?: "vm" | "host" | "reused" | "none";
  /** Pushing the result to the target. */
  pushMs?: number;
  /** A merge's path: fast (the verified commit pushed as it was: the target hadn't moved) or full (fetched, integrated and checked again). */
  path?: "fast" | "full";
  /** Why a merge that could have taken the fast path didn't (e.g. the target moved since the verify). */
  fastFallback?: string;
}

export type MergeOutcome =
  | { status: "merged"; sha: string; already: boolean; how: string; strategy: MergeStrategy | "none"; mode: "pr" | "direct" | "none"; attempts: number; pr?: number; targetBefore?: string; timings?: MergeTimings;
      /** `merge --operator` landed although these plugins vetoed it (§6.5). */
      bypassedVetoes?: Array<{ plugin: string; reason: string }> }
  | { status: "verified"; sha: string; output: string; taskSha?: string; targetSha?: string; how?: string; timings?: MergeTimings }
  | { status: "conflict"; files: string[]; targetSha: string; taskSha: string; timings?: MergeTimings }
  /** `held`: a merge.landing plugin held it for a person's approval; nothing landed and the merge is parked (§6.6.15). */
  | { status: "failed"; reason: string; output?: string; timings?: MergeTimings; held?: { plugin: string; holdId?: string } };

/** Whether a hold a plugin answers now is one a person already approved (§6.6.15): the same plugin, and the same
 *  `holdId` when the plugin names its holds, else the same reason text. A named hold never matches an unnamed one. */
export function sameHold(approved: PluginHold, now: { plugin: string; text: string; holdId?: string }): boolean {
  if (approved.plugin !== now.plugin) return false;
  if (approved.holdId !== undefined || now.holdId !== undefined) return approved.holdId === now.holdId;
  return approved.reason === now.text;
}

export class MergeRetryableError extends Error {
  constructor(message: string) { super(message); this.name = "MergeRetryableError"; }
}
