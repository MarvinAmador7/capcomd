import { spawn } from "child_process";
import { join } from "path";

export interface ChaosTestConfig {
  killpoint: string;
  iteration?: number;
  testName: string;
  testFn: () => Promise<void>;
}

export async function runChaosTest(config: ChaosTestConfig): Promise<void> {
  const { killpoint, iteration = 1, testName, testFn } = config;

  const env = {
    ...process.env,
    RELAY_KILLPOINT: `${killpoint}:${iteration}`,
  };

  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    attempt++;

    try {
      await testFn();
      break;
    } catch (error: any) {
      if (error.code === 137 || error.message?.includes("exit code 137")) {
        console.log(
          `  [Chaos] Killed at ${killpoint}:${iteration}, attempt ${attempt}`
        );

        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
      }

      throw error;
    }
  }
}

export async function checkInvariants(
  db: any,
  options: {
    runId: string;
    expectedTaskCount?: number;
  }
): Promise<{ passed: boolean; violations: string[] }> {
  const violations: string[] = [];

  const mergedEvents = await db.execute(
    `SELECT entity_id, COUNT(*) as count 
     FROM lifecycle_events 
     WHERE event LIKE '%VERIFIED_AND_MERGED%' 
     GROUP BY entity_id 
     HAVING count > 1`
  );

  if (mergedEvents.length > 0) {
    violations.push(
      `Double merge detected: ${mergedEvents.map((r: any) => r.entity_id).join(", ")}`
    );
  }

  const lostTasks = await db.execute(
    `SELECT entity_id, state 
     FROM lifecycle 
     WHERE machine = 'task' 
     AND state NOT IN ('merged', 'failed', 'cancelled', 'pending', 'leased', 'running', 'handed_off', 'verifying')`
  );

  if (lostTasks.length > 0) {
    violations.push(
      `Lost tasks in invalid state: ${lostTasks.map((r: any) => `${r.entity_id}:${r.state}`).join(", ")}`
    );
  }

  const eventGaps = await db.execute(
    `WITH sequences AS (
      SELECT entity_id, seq, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY seq) as expected
      FROM lifecycle_events
    )
    SELECT entity_id, COUNT(*) as gaps
    FROM sequences
    WHERE seq != expected
    GROUP BY entity_id`
  );

  if (eventGaps.length > 0) {
    violations.push(
      `Event log gaps detected: ${eventGaps.map((r: any) => r.entity_id).join(", ")}`
    );
  }

  const charges = await db.execute(
    "SELECT charge_id, COUNT(*) as count FROM budget_charges GROUP BY charge_id HAVING count > 1"
  );

  if (charges.length > 0) {
    violations.push(
      `Double charge detected: ${charges.map((r: any) => r.charge_id).join(", ")}`
    );
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

export function randomKillpoint(seed: number): {
  killpoint: string;
  iteration: number;
} {
  const killpoints = [
    "tx.mid",
    "model.after_return.before_commit",
    "merge.before_cas",
    "merge.after_cas.before_event",
    "push.mid",
    "push.after.before_event",
    "vm.create.after_request.before_record",
    "lease.expire.mid",
    "budget.charge.mid",
    "outbox.dispatch.after_send.before_ack",
  ];

  const random = (seed * 9301 + 49297) % 233280;
  const index = random % killpoints.length;
  const iteration = (random % 3) + 1;

  return {
    killpoint: killpoints[index] || "tx.mid",
    iteration,
  };
}
