import type { RawAccess } from "rivetkit/db";
import { traceActions, withSpan } from "../utils/tracing-simple";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { setupLifecycleTables, transitionLifecycle, getLifecycle } from "../utils/lifecycle";
import { mergeTask } from "../merge/service";
import type { MergeOutcome } from "../merge/types";

/** The verify/merge runs in progress in this process, by (run, op). */
const running = new Map<string, Promise<{ verifierId: string; passed: boolean; commitSha: string; outcome: MergeOutcome }>>();

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
