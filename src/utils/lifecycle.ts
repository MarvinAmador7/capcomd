import type { RawAccess } from "rivetkit/db";
import { killpoint } from "./killpoint";
import { activeSpan, startSpan, endSpan, recordStateTransition } from "./tracing-simple";

export interface LifecycleRow {
  entity_id: string;
  machine: string;
  version: number;
  state: string;
  context: string;
  seq: number;
}

export interface EventRow {
  entity_id: string;
  seq: number;
  event: string;
  idem_key: string;
  at: number;
  trace_id?: string;
  span_id?: string;
}

export async function setupLifecycleTables(db: RawAccess): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS lifecycle (
      entity_id TEXT PRIMARY KEY,
      machine TEXT NOT NULL,
      version INTEGER NOT NULL,
      state TEXT NOT NULL,
      context TEXT NOT NULL,
      seq INTEGER NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS lifecycle_events (
      entity_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event TEXT NOT NULL,
      idem_key TEXT UNIQUE NOT NULL,
      at INTEGER NOT NULL,
      trace_id TEXT,
      span_id TEXT,
      PRIMARY KEY (entity_id, seq)
    )
  `);
  // No outbox: a transition's side effects run where it happens, each with its own idempotency key
  // (docs/durability.md). Actors created before keep an unused `outbox` table.
}

export async function getLifecycle(
  db: RawAccess,
  entityId: string
): Promise<LifecycleRow | null> {
  const rows = await db.execute(
    "SELECT * FROM lifecycle WHERE entity_id = ?",
    entityId
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  if (!row) return null;
  
  return {
    entity_id: row.entity_id as string,
    machine: row.machine as string,
    version: row.version as number,
    state: row.state as string,
    context: row.context as string,
    seq: row.seq as number,
  };
}

/**
 * One state change inside the caller's transaction: the event (once per idempotency key: a repeat is a no-op) and the
 * lifecycle row, traced as `transition.<machine>`.
 */
export async function transitionLifecycle(
  tx: RawAccess,
  entityId: string,
  machine: string,
  newState: string,
  newContext: any,
  event: any,
  idemKey: string
): Promise<void> {
  const prev = (await tx.execute("SELECT state, version, seq FROM lifecycle WHERE entity_id = ?", entityId))[0];
  const version = prev ? Number(prev.version) + 1 : 1;
  const span = startSpan(`transition.${machine}`, { "relay.entity_id": entityId, "relay.idempotency_key": idemKey });
  recordStateTransition(span, prev ? String(prev.state) : "(new)", newState, String(event?.type ?? "unknown"), version);
  const meta = activeSpan() ? { traceId: span.traceId, spanId: span.spanId } : undefined;
  try {
    if ((await tx.execute("SELECT idem_key FROM lifecycle_events WHERE idem_key = ?", idemKey)).length > 0) { span.status.code = 1; return; }
    const seq = prev ? Number(prev.seq) + 1 : 1;
    await tx.execute(
      `INSERT INTO lifecycle_events (entity_id, seq, event, idem_key, at, trace_id, span_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      entityId, seq, JSON.stringify(event), idemKey, Date.now(), meta?.traceId ?? null, meta?.spanId ?? null
    );
    killpoint("tx.mid");
    if (prev) {
      await tx.execute("UPDATE lifecycle SET state = ?, context = ?, seq = ?, version = version + 1 WHERE entity_id = ?", newState, JSON.stringify(newContext), seq, entityId);
    } else {
      await tx.execute("INSERT INTO lifecycle (entity_id, machine, version, state, context, seq) VALUES (?, ?, ?, ?, ?, ?)", entityId, machine, 1, newState, JSON.stringify(newContext), seq);
    }
    span.status.code = 1;
  } catch (error) {
    span.status = { code: 2, message: error instanceof Error ? error.message : String(error) };
    throw error;
  } finally {
    endSpan(span);
  }
}
