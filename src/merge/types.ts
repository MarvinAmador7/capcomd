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
}

export type MergeOutcome =
  | { status: "merged"; sha: string; already: boolean; how: string; strategy: MergeStrategy | "none"; mode: "pr" | "direct" | "none"; attempts: number; pr?: number; targetBefore?: string }
  | { status: "verified"; sha: string; output: string; taskSha?: string }
  | { status: "conflict"; files: string[]; targetSha: string; taskSha: string }
  | { status: "failed"; reason: string; output?: string };

export class MergeRetryableError extends Error {
  constructor(message: string) { super(message); this.name = "MergeRetryableError"; }
}
