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

export interface OutboxRow {
  id: number;
  entity_id: string;
  action: string;
  payload: string;
  created_at: number;
  dispatched_at?: number;
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

  await db.execute(`
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      dispatched_at INTEGER
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_outbox_dispatched 
    ON outbox(dispatched_at) 
    WHERE dispatched_at IS NULL
  `);
}

async function transitionLifecycleInner(
  tx: RawAccess,
  entityId: string,
  machine: string,
  newState: string,
  newContext: any,
  event: any,
  idemKey: string,
  actions: Array<{ type: string; params?: any }>,
  traceMetadata?: { traceId: string; spanId: string }
): Promise<void> {
  const now = Date.now();

  const existingEvent = await tx.execute(
    "SELECT idem_key FROM lifecycle_events WHERE idem_key = ?",
    idemKey
  );

  if (existingEvent.length > 0) {
    return;
  }

  const existing = await tx.execute(
    "SELECT seq FROM lifecycle WHERE entity_id = ?",
    entityId
  );

  const seq = existing.length > 0 && existing[0] ? Number(existing[0].seq) + 1 : 1;

  await tx.execute(
    `INSERT INTO lifecycle_events (entity_id, seq, event, idem_key, at, trace_id, span_id) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    entityId, seq, JSON.stringify(event), idemKey, now,
    traceMetadata?.traceId || null,
    traceMetadata?.spanId || null
  );

  killpoint("tx.mid");

  if (existing.length > 0) {
    await tx.execute(
      `UPDATE lifecycle 
       SET state = ?, context = ?, seq = ?, version = version + 1
       WHERE entity_id = ?`,
      newState, JSON.stringify(newContext), seq, entityId
    );
  } else {
    await tx.execute(
      `INSERT INTO lifecycle (entity_id, machine, version, state, context, seq)
       VALUES (?, ?, ?, ?, ?, ?)`,
      entityId, machine, 1, newState, JSON.stringify(newContext), seq
    );
  }

  for (const action of actions) {
    await tx.execute(
      `INSERT INTO outbox (entity_id, action, payload, created_at)
       VALUES (?, ?, ?, ?)`,
      entityId, action.type, JSON.stringify(action.params || {}), now
    );
  }
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

export async function getUndispatchedOutbox(
  db: RawAccess,
  entityId?: string
): Promise<OutboxRow[]> {
  const rows = entityId
    ? await db.execute(
        "SELECT * FROM outbox WHERE dispatched_at IS NULL AND entity_id = ? ORDER BY id",
        entityId
      )
    : await db.execute(
        "SELECT * FROM outbox WHERE dispatched_at IS NULL ORDER BY id"
      );

  return rows.map((row) => ({
    id: row.id as number,
    entity_id: row.entity_id as string,
    action: row.action as string,
    payload: row.payload as string,
    created_at: row.created_at as number,
    dispatched_at: row.dispatched_at as number | undefined,
  }));
}

export async function markOutboxDispatched(
  db: RawAccess,
  id: number
): Promise<void> {
  killpoint("outbox.dispatch.after_send.before_ack");
  await db.execute("UPDATE outbox SET dispatched_at = ? WHERE id = ?", Date.now(), id);
}

export async function transitionLifecycle(
  tx: RawAccess,
  entityId: string,
  machine: string,
  newState: string,
  newContext: any,
  event: any,
  idemKey: string,
  actions: Array<{ type: string; params?: any }>,
  traceMetadata?: { traceId: string; spanId: string }
): Promise<void> {
  const prev = await tx.execute("SELECT state, version FROM lifecycle WHERE entity_id = ?", entityId);
  const from = prev.length > 0 && prev[0] ? String(prev[0].state) : "(new)";
  const version = prev.length > 0 && prev[0] ? Number(prev[0].version) + 1 : 1;
  const span = startSpan(`transition.${machine}`, { "relay.entity_id": entityId, "relay.idempotency_key": idemKey });
  recordStateTransition(span, from, newState, String(event?.type ?? "unknown"), version);
  const meta = traceMetadata ?? (activeSpan() ? { traceId: span.traceId, spanId: span.spanId } : undefined);
  try {
    await transitionLifecycleInner(tx, entityId, machine, newState, newContext, event, idemKey, actions, meta);
    span.status.code = 1;
  } catch (error) {
    span.status = { code: 2, message: error instanceof Error ? error.message : String(error) };
    throw error;
  } finally {
    endSpan(span);
  }
}
