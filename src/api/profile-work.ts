// GET /v1/profiles/{name}/work (capability profiles.work): a profile's recent work, for its page in the app (Crew):
// its latest agents across the runs the daemon lists (with `repo`, that project's), newest first, each with the
// outcome the daemon reads from its state and the results its verify, review and merge wrote on it (Agent.result
// `verification`, `verdict`, `merge`). Cheap by construction: one query per listed run (the scope's `profileWork`, its
// agents of that profile only, without their task or spec), at most `limit` rows from each, which is about what GET
// /v1/runs costs (it lists every run's agents). No thread, transcript or event log is read.
import { basename, resolve, sep } from "node:path";
import type { z } from "zod";
import { shownTitle, type TitleState } from "../primitives/agent-title";
import { redactShapes } from "../agents/redact";
// Types only: the scope actor imports this file, and the contract imports its constants.
import type { ProfileWork, ProfileWorkItem } from "./contract";

/** At most this many items (the route's `limit`). */
export const PROFILE_WORK_MAX = 50;
export const PROFILE_WORK_OUTCOMES = ["running", "idle", "merged", "passed", "found_issues", "failed", "cancelled"] as const;
export type WorkOutcome = (typeof PROFILE_WORK_OUTCOMES)[number];
type Item = z.infer<typeof ProfileWorkItem>;

/** What the scope's `profileWork` answers for one agent: its state, what its results say, never its task or result text. */
export interface WorkRow {
  agentId: string;
  status: string;
  titleState: TitleState | null;
  /** Its task's first characters, for the title derived from it when nobody named it. */
  taskHead: string;
  /** Its title as already worked out (a source that keeps Agent.title, e.g. the memory source); absent: from
   *  `titleState` and `taskHead`. */
  title?: string | null;
  /** A reviewer's verdict (`result.verdict.passed`); null when it has none. */
  verdict: boolean | null;
  /** Its work's verify (`result.verification.pass`); null when it wasn't verified. */
  verification: boolean | null;
  /** Its work's merge (`result.merge.state`: merged, failed, denied); null when it wasn't merged. */
  merge: string | null;
  updatedAt: number;
  /** When its latest attempt ended (its latest agent.done, failed or cancelled); null when it hasn't. */
  endedAt: number | null;
}

const ENDED = new Set(["done", "failed", "cancelled", "handed-off"]);

/**
 * The outcome a page shows for an agent: running while it works (or waits, or is paused); cancelled and failed as its
 * status says; then what its results say, best first: merged, found_issues (its work failed verify's checks or review,
 * or as a reviewer its verdict failed), failed (its work's merge failed), passed (its work passed verify, or its
 * verdict passed); else idle (it ended its turn: ADR-026 §1, it takes messages).
 */
export function workOutcome(r: Pick<WorkRow, "status" | "verdict" | "verification" | "merge">): WorkOutcome {
  if (!ENDED.has(r.status)) return "running";
  if (r.status === "cancelled") return "cancelled";
  if (r.status === "failed") return "failed";
  if (r.merge === "merged") return "merged";
  if (r.verdict === false || r.verification === false) return "found_issues";
  if (r.merge === "failed") return "failed";
  if (r.verdict === true || r.verification === true) return "passed";
  return "idle";
}

/** The parts of an agent's stored result (Agent.result) an outcome is read from. */
export function workResult(result: unknown): Pick<WorkRow, "verdict" | "verification" | "merge"> {
  const o = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const r = o(result), v = o(r?.verdict), vf = o(r?.verification), m = o(r?.merge);
  return {
    verdict: typeof v?.passed === "boolean" ? v.passed : null,
    verification: typeof vf?.pass === "boolean" ? vf.pass : null,
    merge: typeof m?.state === "string" ? m.state : null,
  };
}

/** A run the daemon lists (the runs index's row), as far as this needs it. */
export interface WorkRun { runId: string; repo: string | null; cwd?: string | null }

/** A project's runs: those started in its checkout (or below it), or on its repository (`projectRepo`, CAPCOMD_REPO). */
export function projectRuns<T extends WorkRun>(runs: readonly T[], checkout: string, projectRepo: string | null): T[] {
  const dir = resolve(checkout);
  return runs.filter((r) => (r.cwd && (resolve(r.cwd) === dir || resolve(r.cwd).startsWith(dir + sep))) || (projectRepo !== null && r.repo === projectRepo));
}

/** One row as the route answers it. */
export function workItem(run: WorkRun, w: WorkRow): Item {
  const outcome = workOutcome(w);
  return {
    agentId: w.agentId, runId: run.runId, title: w.title !== undefined ? w.title : shownTitle(w.titleState, redactShapes(w.taskHead)).title,
    project: run.repo ? basename(run.repo) : null, outcome,
    endedAt: outcome === "running" ? null : w.endedAt ?? w.updatedAt, updatedAt: w.updatedAt,
  };
}

/** How many runs are read at once. */
const AT_ONCE = 16;

/**
 * The newest `limit` agents of profile `name` in `runs` (each run's own newest `limit`, then merged), newest first.
 * `rowsOf` reads one run's (null or a throw: a run this engine doesn't have, which is skipped).
 */
export async function profileWork(name: string, runs: readonly WorkRun[], rowsOf: (runId: string, profile: string, limit: number) => Promise<WorkRow[] | null>, limit = 10): Promise<z.infer<typeof ProfileWork>> {
  const n = Math.max(1, Math.min(PROFILE_WORK_MAX, Math.floor(limit)));
  const items: Item[] = [];
  for (let i = 0; i < runs.length; i += AT_ONCE) {
    const batch = await Promise.all(runs.slice(i, i + AT_ONCE).map(async (run) => {
      const rows = await rowsOf(run.runId, name, n).catch(() => null);
      return (rows ?? []).map((w) => workItem(run, w));
    }));
    items.push(...batch.flat());
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt || (a.agentId < b.agentId ? 1 : a.agentId > b.agentId ? -1 : 0));
  return { items: items.slice(0, n) };
}
