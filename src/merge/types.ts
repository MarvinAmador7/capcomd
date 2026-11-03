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
  | { status: "merged"; sha: string; already: boolean; how: string; strategy: MergeStrategy | "none"; mode: "pr" | "direct" | "none"; attempts: number; pr?: number; targetBefore?: string; timings?: MergeTimings }
  | { status: "verified"; sha: string; output: string; taskSha?: string; targetSha?: string; how?: string; timings?: MergeTimings }
  | { status: "conflict"; files: string[]; targetSha: string; taskSha: string; timings?: MergeTimings }
  | { status: "failed"; reason: string; output?: string; timings?: MergeTimings };

export class MergeRetryableError extends Error {
  constructor(message: string) { super(message); this.name = "MergeRetryableError"; }
}
