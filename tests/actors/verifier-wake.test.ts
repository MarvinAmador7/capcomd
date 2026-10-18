import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Server } from "rivetkit/server";
import { verifierActor } from "../../src/actors/verifier";
import { transitionLifecycle } from "../../src/utils/lifecycle";

describe("Verifier Actor Wake", () => {
  let server: Server;

  beforeEach(() => {
    server = new Server();
    server.listen(6421);
    server.registry.actor("verifier", verifierActor);
  });

  afterEach(async () => {
    await server.close();
  });

  test("should wake with persisted verifying state", async () => {
    const verifierId = "test-wake-1";
    const taskId = "task-1";
    const runId = "run-1";

    // Step 1: Create verifier actor and insert a 'verifying' row
    const verifier1 = await server.registry.actor("verifier").getOrCreate({
      id: verifierId,
      input: {},
    });

    const db1 = verifier1.db;
    await db1.transaction(async (tx) => {
      await transitionLifecycle(
        tx,
        verifierId,
        "verifier",
        "verifying",
        {
          taskId,
          branch: "test-branch",
          commitSha: "abc123",
          runId,
        },
        { type: "START_VERIFY" },
        `verifier-${verifierId}-start-wake-test`,
        []
      );
    }, { name: "insertVerifyingState" });

    console.log("[wake-test] Inserted 'verifying' row");

    // Step 2: Stop the actor (simulate crash/kill)
    await verifier1.stop();
    console.log("[wake-test] Stopped actor");

    // Step 3: Wake the actor (simulate engine restart)
    console.log("[wake-test] Re-getting actor to trigger wake...");
    
    try {
      const verifier2 = await server.registry.actor("verifier").getOrCreate({
        id: verifierId,
        input: {},
      });

      console.log("[wake-test] Actor woke successfully");

      // Verify we can read the row
      const rows = await verifier2.db.execute(
        "SELECT * FROM lifecycle WHERE entity_id = ?",
        verifierId
      );

      expect(rows.length).toBe(1);
      expect(rows[0].state).toBe("verifying");
      console.log("[wake-test] Verified state persisted");

    } catch (error) {
      console.error("[wake-test] ERROR during wake:", error);
      if (error instanceof Error) {
        console.error("[wake-test] Stack:", error.stack);
      }
      throw error;
    }
  });
});
