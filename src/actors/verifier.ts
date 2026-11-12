import type { RawAccess } from "rivetkit/db";
import { traceActions, withSpan } from "../utils/tracing-simple";
import { actor } from "rivetkit";
import { db } from "./db";
import { setupLifecycleTables, transitionLifecycle, getLifecycle } from "../utils/lifecycle";
import { mergeTask } from "../merge/service";
import type { MergeOutcome } from "../merge/types";
import type { CheckOutcome } from "../merge/check";

/** The verify/merge runs in progress in this process, by (run, op). */
const running = new Map<string, Promise<{ verifierId: string; passed: boolean; commitSha: string; outcome: MergeOutcome }>>();
/** The checks (`capcomd check`) in progress in this process, by (run, check). */
const checking = new Map<string, Promise<CheckResult>>();

/** A check's outcome and how long it waited for a machine slot. */
export interface CheckResult { outcome: CheckOutcome; slotWaitMs: number }

/**
 * A machine slot for a check's sandbox where the run's place has a cap (src/providers/capacity.ts: Docker's memory over
 * the per-agent budget), as an agent waits for one: held while the command runs, given back after. Gives up after
 * CAPCOMD_CHECK_SLOT_WAIT_MS (20 minutes), and the check fails saying so.
 */
async function checkSlot(runId: string, checkId: string, source: Record<string, string | undefined>): Promise<{ waitedMs: number; release: () => void }> {
  let place: string | null = null;
  // `source` is the run's sandbox env (verify.ts runTests): its place is the run's own, else this process's.
  try { place = (await import("../providers/registry")).sandboxName(source); } catch { /* unknown: no cap */ }
  const { holdSlot } = await import("../providers/capacity");
  return holdSlot(place, `capcomd-check-${runId}-${checkId}`, { pollMs: Number(process.env.CAPCOMD_CHECK_SLOT_POLL_MS ?? 2000), waitMs: Number(process.env.CAPCOMD_CHECK_SLOT_WAIT_MS ?? 20 * 60_000) })
    .catch((e) => { throw new Error(`${(e as Error).message}, so the checks didn't run`); });
}

export const verifierActor = actor({
  // PR mode can wait on required checks / merge queue (CAPCOMD_GITHUB_TIMEOUT_MS).
  options: { actionTimeout: 60 * 60_000 },
  db: db({
    onMigrate: async (database) => {
      await setupLifecycleTables(database);
    },
  }),

  actions: traceActions("verifier", {
    /**
     * Verify (and, unless testOnly, land) one task: tests run on the task branch merged with the
     * latest target, then PR or direct merge (src/merge). Re-entrant: a crash anywhere leaves the
     * row in `verifying`, and the next call re-runs mergeTask, which finds an already-landed change
     * in git (ancestor / trailer / patch-id / merged PR) and records it instead of merging twice.
     */
    async verify(
      c,
      params: {
        verifierId: string;
        taskId: string;
        branch: string;
        commitSha?: string;
        runId: string;
        target?: string;
        testOnly?: boolean;
        testCommand?: string;
        expectSha?: string;
        /** "direct": a run's goal branch (reviewed work is pushed to it, never a PR per child), whatever the repo's mode. */
        mode?: "direct";
        /** A merge after a passing verify: the commit that verify made and checked, and the target it made it on (the fast path). */
        verified?: { sha: string; targetSha: string; how?: string };
        /** A merge: what merge.landing's plugins are asked (plugin API §6.6.15). */
        gate?: import("../merge/types").MergeGate;
        /** A verify of a done agent: its pushed commit (lets the verify share a fetch that has it). */
        branchSha?: string;
      }
    ) {
      const { verifierId, taskId, branch, runId } = params;
      // A second call while one runs (a poll from another session, an await resuming an op) shares its run.
      const key = `${runId}\0${verifierId}`;
      const live = running.get(key);
      if (live) return live;
      const p = run().finally(() => running.delete(key));
      running.set(key, p);
      return p;
      async function run() {

      const existing = await getLifecycle(c.db, verifierId);
      if (existing && ["passed", "failed", "conflict"].includes(existing.state)) {
        const ctx = JSON.parse(existing.context as string);
        return { verifierId, passed: existing.state === "passed", commitSha: ctx.commitSha ?? params.commitSha ?? "", outcome: ctx.outcome as MergeOutcome };
      }

      if (!existing) {
        await c.db.transaction(async (tx: RawAccess) => {
          await transitionLifecycle(tx, verifierId, "verifier", "verifying", { taskId, branch, runId, target: params.target, testOnly: !!params.testOnly }, { type: "START_VERIFY" }, `verifier-${verifierId}-start`);
        }, { name: "startVerify" });
      }

      const outcome = await withSpan(
        params.testOnly ? "git.verify" : "git.merge",
        { "relay.run_id": runId, "git.operation": params.testOnly ? "verify" : "merge", "git.ref": branch, "git.target": params.target ?? "" },
        async () => mergeTask({ runId, taskId, branch, target: params.target ?? "main", testOnly: params.testOnly, ...(params.testCommand ? { testCommand: params.testCommand } : {}), ...(params.expectSha ? { expectSha: params.expectSha } : {}), ...(params.mode ? { mode: params.mode } : {}), ...(params.verified ? { verified: params.verified } : {}), ...(params.branchSha ? { branchSha: params.branchSha } : {}), ...(params.gate ? { gate: params.gate } : {}) },
          await (await import("../merge/run-config")).mergeConfigFor(runId)) // the run's repository, not the engine's env
      );

      // Held by a plugin for a person's approval: nothing landed and it isn't over (the approved merge calls again).
      if (outcome.status === "failed" && outcome.held) return { verifierId, passed: false, commitSha: "", outcome };
      const state = outcome.status === "merged" || outcome.status === "verified" ? "passed" : outcome.status === "conflict" ? "conflict" : "failed";
      const commitSha = "sha" in outcome ? outcome.sha : "";
      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(
          tx, verifierId, "verifier", state,
          { taskId, branch, runId, target: params.target, commitSha, passed: state === "passed", outcome, verifiedAt: Date.now() },
          { type: state === "passed" ? "VERIFY_PASS" : state === "conflict" ? "VERIFY_CONFLICT" : "VERIFY_FAIL" },
          `verifier-${verifierId}-${state}`
        );
      }, { name: "completeVerify" });

      return { verifierId, passed: state === "passed", commitSha, outcome };
      }
    },

    /**
     * `capcomd check` (plugin API §16.1): the run's checks on one commit as it is (src/merge/check.ts), merging nothing.
     * One per check id in the engine, whoever asks (the operator's CLI, a driver, an agent in its VM): a second call while
     * it runs shares that run, a call after it ended gets its recorded outcome, and one after an engine restart runs it
     * again. The command waits for a machine slot where the run's sandbox has a cap (Docker's memory), as an agent does.
     */
    async check(c, params: { checkId: string; runId: string; branch: string; sha: string; testCommand?: string }) {
      const key = `${params.runId}\0${params.checkId}`;
      const live = checking.get(key);
      if (live) return live;
      const p = run().finally(() => checking.delete(key));
      checking.set(key, p);
      return p;
      async function run(): Promise<CheckResult> {
        const existing = await getLifecycle(c.db, params.checkId);
        if (existing && ["passed", "failed"].includes(existing.state)) return JSON.parse(existing.context as string).result as CheckResult;
        if (!existing) await c.db.transaction(async (tx: RawAccess) => {
          await transitionLifecycle(tx, params.checkId, "check", "checking", { runId: params.runId, branch: params.branch, sha: params.sha }, { type: "START_CHECK" }, `check-${params.checkId}-start`);
        }, { name: "startCheck" });
        const { checkCommit } = await import("../merge/check");
        const cfg = await (await import("../merge/run-config")).mergeConfigFor(params.runId);
        let slotWaitMs = 0;
        // It couldn't run (no slot came free, the sandbox or git failed): a failed check that says why, never a crash.
        const outcome: CheckOutcome = !cfg
          ? { status: "passed", sha: params.sha, command: "", output: "(no repository configured)", where: "none", fetchMs: 0, checksMs: 0 }
          : await withSpan("git.check", { "relay.run_id": params.runId, "git.operation": "check", "git.ref": params.branch, "git.sha": params.sha, "relay.check_id": params.checkId },
            () => checkCommit(cfg, { ...params, beforeRun: async (_where, source) => { const s = await checkSlot(params.runId, params.checkId, source); slotWaitMs = s.waitedMs; return s.release; } }))
            .catch((e): CheckOutcome => ({ status: "error", reason: String((e as Error)?.message ?? e).slice(0, 1000), fetchMs: 0 }));
        const result: CheckResult = { outcome, slotWaitMs };
        const state = outcome.status === "passed" ? "passed" : "failed";
        await c.db.transaction(async (tx: RawAccess) => {
          await transitionLifecycle(tx, params.checkId, "check", state, { runId: params.runId, branch: params.branch, sha: params.sha, result, checkedAt: Date.now() }, { type: state === "passed" ? "CHECK_PASS" : "CHECK_FAIL" }, `check-${params.checkId}-${state}`);
        }, { name: "completeCheck" });
        return result;
      }
    },

    /**
     * A merge a plugin held, then a person denied: its row was left `verifying` for the approved re-run, which won't
     * come now. Nothing landed (a hold is decided before anything is pushed), so it ends `failed`. Only a row still in
     * flight moves; an ended one, or none, is left as it is.
     */
    async settleHeld(c, params: { verifierId: string; reason: string }) {
      const row = await getLifecycle(c.db, params.verifierId);
      if (!row || row.state !== "verifying") return { settled: false };
      const ctx = JSON.parse(row.context as string);
      const outcome: MergeOutcome = { status: "failed", reason: params.reason };
      await c.db.transaction(async (tx: RawAccess) => {
        await transitionLifecycle(tx, params.verifierId, "verifier", "failed", { ...ctx, commitSha: "", passed: false, outcome, verifiedAt: Date.now() }, { type: "VERIFY_FAIL" }, `verifier-${params.verifierId}-failed`);
      }, { name: "settleHeld" });
      return { settled: true };
    },

    /**
     * onWake hook. Deliberately does NOT decide outcomes any more: only git can say whether a
     * crashed merge landed, and that check is a remote call. The resuming client re-enters
     * verify(), which reconciles against git idempotently.
     */
    async recoverInflight(c, params: {}) {
      try {
        const stuck = await c.db.execute("SELECT entity_id FROM lifecycle WHERE machine = 'verifier' AND state = 'verifying'");
        if (stuck.length > 0) console.log(`[verifier.recoverInflight] ${stuck.length} in-flight verification(s); will reconcile against git on resume`);
      } catch (error) {
        console.error("[verifier.recoverInflight] Error:", error);
      }
    },

    async getVerifier(c, params: { verifierId: string }) {
      const rows = await c.db.execute(
        "SELECT * FROM lifecycle WHERE entity_id = ?",
        params.verifierId
      );

      if (rows.length === 0) return null;

      const row = rows[0];
      if (!row) return null;
      
      return {
        verifierId: row.entity_id as string,
        state: row.state as string,
        context: JSON.parse(row.context as string),
      };
    },

    async listEventSeqs(c, _params: Record<string, never>) {
      const rows = await c.db.execute(
        "SELECT entity_id, seq FROM lifecycle_events ORDER BY entity_id, seq"
      );
      return rows.map((row: Record<string, unknown>) => ({
        entityId: row.entity_id as string,
        seq: Number(row.seq),
      }));
    },
  }),
});
