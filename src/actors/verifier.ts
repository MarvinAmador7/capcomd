import { traceActions, withSpan } from "../utils/tracing-simple";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { setupLifecycleTables, transitionLifecycle, getLifecycle, getUndispatchedOutbox, markOutboxDispatched } from "../utils/lifecycle";
import { killpoint } from "../utils/killpoint";

export const verifierActor = actor({
  db: db({
    onMigrate: async (database) => {
      await setupLifecycleTables(database);
    },
  }),

  actions: traceActions("verifier", {
    async verify(
      c,
      params: {
        verifierId: string;
        taskId: string;
        branch: string;
        commitSha: string;
        runId: string;
      }
    ) {
      const { verifierId, taskId, branch, commitSha, runId } = params;

      // Check if already completed (idempotency)
      const existing = await getLifecycle(c.db, verifierId);
      if (existing && (existing.state === "passed" || existing.state === "failed")) {
        console.log(`[verifier.verify] ${verifierId} already ${existing.state}`);
        return {
          verifierId,
          passed: existing.state === "passed",
          commitSha,
        };
      }

      // Start verification - write to DB before killpoint
      await c.db.transaction(async (tx) => {
        await transitionLifecycle(
          tx,
          verifierId,
          "verifier",
          "verifying",
          { taskId, branch, commitSha, runId },
          { type: "START_VERIFY" },
          `verifier-${verifierId}-start`,
          []
        );
      }, { name: "startVerify" });

      const passed = await withSpan(
        "git.merge_cas",
        { "relay.run_id": runId, "git.operation": "merge_cas", "git.ref": branch, "git.sha": commitSha },
        () => {
          killpoint("merge.before_cas");
          const ok = true;
          killpoint("merge.after_cas.before_event");
          return ok;
        }
      );

      // Complete verification with outbox to run
      await c.db.transaction(async (tx) => {
        await transitionLifecycle(
          tx,
          verifierId,
          "verifier",
          passed ? "passed" : "failed",
          { taskId, branch, commitSha, passed, verifiedAt: Date.now(), runId },
          { type: passed ? "VERIFY_PASS" : "VERIFY_FAIL" },
          `verifier-${verifierId}-${passed ? "pass" : "fail"}`,
          []
        );
      }, { name: "completeVerify" });

      return {
        verifierId,
        passed,
        commitSha,
      };
    },

    async recoverInflight(c, params: {}) {
      try {
        // Find stuck verifications
        const stuck = await c.db.execute(
          "SELECT entity_id, context FROM lifecycle WHERE machine = 'verifier' AND state = 'verifying'"
        );

        if (stuck.length === 0) return;

        console.log(`[verifier.recoverInflight] Recovering ${stuck.length} stuck verifications`);

        for (const row of stuck) {
          const verifierId = row.entity_id as string;
          const context = JSON.parse(row.context as string);
          
          // TODO: Check git to see if merge already happened (CAS against expected sha)
          // For now, just mark as passed to recover
          const passed = true;
          
          const idemKey = `verifier-${verifierId}-recovered-${Date.now()}`;
          
          await c.db.transaction(async (tx) => {
            // Check if already recovered
            const existing = await tx.execute(
              "SELECT idem_key FROM lifecycle_events WHERE idem_key = ?",
              idemKey
            );
            
            if (existing.length > 0) {
              console.log(`[verifier.recoverInflight] Already recovered: ${verifierId}`);
              return;
            }

            await transitionLifecycle(
              tx,
              verifierId,
              "verifier",
              passed ? "passed" : "failed",
              { ...context, passed, verifiedAt: Date.now(), recovered: true },
              { type: passed ? "VERIFY_PASS" : "VERIFY_FAIL" },
              idemKey,
              []
            );
          }, { name: "recoverVerify" });
        }
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
      return rows.map((row) => ({
        entityId: row.entity_id as string,
        seq: Number(row.seq),
      }));
    },
  }),
});
