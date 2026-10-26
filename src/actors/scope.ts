import { redactShapes } from "../agents/redact";
// ADR-016 primitives, step 1: one scope actor per run. It holds the agent tree, the
// idempotency keys and the primitive event log. Every spawn and cancel is a single
// transaction, so children limits and the budget carve can't be raced, and a crash
// either leaves the whole spawn or none of it.
import { strictEventData, type ScopeEventType } from "../api/legacy-events";
import { dottedType } from "../api/envelope";
import { inlineOrAttach } from "../api/inline-cap";
import { workspaceOf, type AgentWorkspace } from "../api/workspace";
import { RUN_REPO_KV } from "../merge/run-config";
import { env as envVar } from "../utils/env";
import type { RawAccess } from "rivetkit/db";
import { actor, UserError } from "rivetkit";
import { db } from "rivetkit/db";
import { traceActions } from "../utils/tracing-simple";
import { killpoint } from "../utils/killpoint";
import { startDriver } from "../primitives/drivers";
import { available, budgetUsed, checkGrant, checkSpawn, type Grant, growRun, overBudget, profileDefaults, TERMINAL_AGENT, treeSpend, UNIT_LIMIT, UNITS, type AgentRow, type AgentStatus, type Budget, type Limits } from "../primitives/policy";
import type { AgentSpec } from "../agents/profiles";
import { ACTIVITY_KINDS, type StoredActivity } from "../agents/activity";
import { handoffDraft, IMAGE_MAX_BYTES, IMAGE_TYPES, type ItemDraft } from "../../packages/agent-thread/src/index";
import { blockers, casOk, claimable, DEFAULT_KV_MAX_BYTES, fence, findCycle, pickNext, valueBytes, type BoardTask } from "../primitives/board";

function rowToTask(r: any): BoardTask & { key: string | null; createdAt: number; updatedAt: number } {
  return {
    taskId: r.task_id as string, title: r.title as string, data: r.data ? JSON.parse(r.data) : null, status: r.status,
    holder: (r.holder as string | null) ?? null, epoch: Number(r.epoch), leaseUntil: Number(r.lease_until ?? 0),
    result: r.result ? JSON.parse(r.result) : null, key: (r.idem_key as string | null) ?? null,
    after: r.after_ids ? (JSON.parse(r.after_ids) as string[]) : [],
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}
export type ScopeTask = ReturnType<typeof rowToTask>;
const kvRow = (r: any) => ({ k: r.k as string, value: JSON.parse(r.v), version: Number(r.version), deleted: Number(r.deleted ?? 0) === 1, writer: (r.writer as string | null) ?? null, updatedAt: Number(r.updated_at) });
const KV_MAX_BYTES = Number(process.env.CAPCOMD_KV_MAX_BYTES ?? DEFAULT_KV_MAX_BYTES);

/** Columns added after a table first shipped: add them if missing (existing scope actors). */
async function addColumn(db: any, table: string, col: string, decl: string) {
  const cols = await db.execute(`PRAGMA table_info(${table})`);
  if (!cols.some((c: any) => c.name === col)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
/** An image a tool returned, stored as an attachment (base64 body, media type `<mime>;base64`). */
export type ThreadAttachment = { id: string; sha256: string; bytes: number; mime: string; base64: string };

/** Write one thread item (a new rev only): a fresh seq on every write, its position kept from its first. */
async function putItemTx(tx: RawAccess, agentId: string, it: ItemDraft): Promise<number | null> {
  const prev = (await tx.execute("SELECT rev, ord, agent_id FROM agent_items WHERE id = ?", it.id)) as any[];
  if (prev.length && (Number(prev[0].rev) >= it.rev || prev[0].agent_id !== agentId)) return null;
  const seq = Number(((await tx.execute("SELECT COALESCE(MAX(seq), 0) AS m FROM agent_items")) as any[])[0].m) + 1;
  const body = JSON.stringify(redactShapes(it));
  await tx.execute("INSERT OR REPLACE INTO agent_items (id, agent_id, seq, ord, rev, at, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
    it.id, agentId, seq, prev.length ? Number(prev[0].ord) : seq, it.rev, Date.parse(it.at) || Date.now(), body);
  return seq;
}

/** A finished child's hand-back card for its parent's thread. */
function handoffOf(parent: string, child: string, status: string, result: Record<string, unknown>): ItemDraft {
  const s = (x: unknown) => (typeof x === "string" ? x : "");
  const summary = s(result.summary) || s(result.report) || s(result.error) || (status === "done" ? "Finished." : "Failed.");
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts.filter((a: any) => a && typeof a.ref === "string").map((a: any) => ({ name: s(a.name), ref: s(a.ref) })) : [];
  return handoffDraft({ id: `itm-${parent}-handoff-${child}`, at: Date.now(), child: { agentId: child, status }, summary, artifacts });
}

export type KvEntry = ReturnType<typeof kvRow>;

/** Replay a keyed write: same key + same params returns the recorded result; other params = conflict. */
async function replay(tx: any, key: string | undefined, hash: string): Promise<Record<string, unknown> | null> {
  if (!key) return null;
  const r = await tx.execute("SELECT params_hash, result FROM idem WHERE idem_key = ?", key);
  if (!r.length) return null;
  if (r[0].params_hash !== hash) fail("conflict", `key ${key} was already used with different parameters`);
  return { ...JSON.parse(r[0].result), replayed: true };
}
async function remember(tx: any, key: string | undefined, kind: string, hash: string, result: Record<string, unknown>) {
  if (key) await tx.execute("INSERT INTO idem (idem_key, kind, params_hash, result, at) VALUES (?, ?, ?, ?, ?)", key, kind, hash, JSON.stringify(result), Date.now());
}

const fail = (code: string, message: string): never => { throw new UserError(message, { code }); };

/** ADR-019 §2: why a running agent looks stuck ("idle", "spinning", "failing"; "dead" is derived, never stored). */
export interface AgentNotice { kind: string; detail: string; at: number }

function rowToAgent(r: any) {
  return {
    agentId: r.agent_id as string,
    runId: r.run_id as string,
    parent: (r.parent as string | null) ?? null,
    depth: Number(r.depth),
    profile: (r.profile as string | null) ?? null,
    ref: (r.ref as string | null) ?? null,
    spec: r.spec ? (JSON.parse(r.spec) as AgentSpec | Record<string, unknown>) : null,
    limits: JSON.parse(r.limits) as Limits,
    task: r.task as string,
    contract: r.contract ? JSON.parse(r.contract) : null,
    status: r.status as AgentStatus,
    budget: JSON.parse(r.budget) as Budget,
    spent: JSON.parse(r.spent ?? "{}") as Budget,
    result: r.result ? JSON.parse(r.result) : null,
    key: (r.idem_key as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    driver: (r.driver as string | null) ?? null,
    driverUntil: Number(r.driver_until ?? 0),
    heartbeatAt: Number(r.heartbeat_at ?? 0),
    heartbeatNote: (r.heartbeat_note as string | null) ?? null,
    /** Attempt number: 1, then one more per resume (each attempt gets its own worker and VM). */
    epoch: Number(r.epoch ?? 1),
    /** Paused until (ms epoch) when its provider gave a reset time; 0 = until `resume`. */
    pausedUntil: Number(r.paused_until ?? 0),
    /** ADR-019 §3: the latest checkpoint of its workspace (a commit at `ref` on the remote), if any. */
    checkpoint: r.checkpoint ? (JSON.parse(r.checkpoint as string) as { ref: string; sha: string; at: number; reason: string; files: number }) : null,
    /** ADR-019 §2: the agent looks stuck (idle, spinning, failing) while it runs; cleared when it doesn't. */
    notice: r.notice ? (JSON.parse(r.notice as string) as AgentNotice) : null,
    /** ADR-019 §4: when it was last given more budget (0: never). */
    grantedAt: Number(r.granted_at ?? 0),
    /** What it is doing now, as the daemon classified its events (src/agents/activity.ts); not an event, kept on the row. */
    activity: r.activity ? (JSON.parse(r.activity as string) as StoredActivity) : null,
    /** Where it works (harness.v1 Agent.workspace), fixed at spawn; null when the run had no repository (or the row predates it). */
    workspace: r.workspace ? (JSON.parse(r.workspace as string) as AgentWorkspace) : null,
    /** Who asked this running agent to pause (`requestPause`): its runner stops it, keeps its work and pauses it. */
    pauseRequested: (r.pause_requested as string | null) ?? null,
  };
}
export type ScopeAgent = ReturnType<typeof rowToAgent>;

function opRow(r: any) {
  return {
    id: r.op_id as string, kind: r.kind as "verify" | "merge", paramsHash: r.params_hash as string, state: r.state as string,
    data: JSON.parse(r.data) as Record<string, any>, result: r.result ? (JSON.parse(r.result) as Record<string, any>) : null,
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}
export type ScopeOp = ReturnType<typeof opRow>;

async function addEvent(tx: any, type: ScopeEventType, agentId: string | null, data: Record<string, unknown>, idemKey: string) {
  // harness.v1 §6.2: the published payload schemas are open, but the daemon emits only declared fields.
  const chk = strictEventData(dottedType(type), data);
  if (!chk.ok) {
    if (process.env.NODE_ENV === "test" || process.env.CAPCOMD_STRICT_EVENTS === "1") throw new Error(`event ${type} payload: ${chk.error}`);
    console.warn(`capcomd: event ${type} payload does not match its schema: ${chk.error}`);
  }
  const dup = await tx.execute("SELECT seq FROM scope_events WHERE idem_key = ?", idemKey);
  if (dup.length) return;
  const last = await tx.execute("SELECT COALESCE(MAX(seq), 0) AS s FROM scope_events");
  const seq = Number(last[0]?.s ?? 0) + 1;
  await tx.execute(
    "INSERT INTO scope_events (seq, at, type, agent_id, data, idem_key) VALUES (?, ?, ?, ?, ?, ?)",
    seq, Date.now(), type, agentId, JSON.stringify(data), idemKey
  );
}

function findPath(edges: Map<string, string[]>, from: string, to: string, seen = new Set<string>()): string[] | null {
  if (from === to) return [to];
  if (seen.has(from)) return null;
  seen.add(from);
  for (const n of edges.get(from) ?? []) { const p = findPath(edges, n, to, seen); if (p) return [from, ...p]; }
  return null;
}

/**
 * A finished parent's live children are orphans (ADR-017). Policy from the parent's contract
 * `orphans`: "reap" (default: cancel each orphan subtree) or "adopt" (re-parent to the nearest
 * live ancestor, or the run's top level). Drivers see the cancel and tear the VMs down.
 */
async function reapOrphans(c: any, parent: ScopeAgent): Promise<{ reaped: string[]; adopted: string[] }> {
  const all: ScopeAgent[] = (await c.db.execute("SELECT * FROM agents_v2")).map(rowToAgent);
  const kids = all.filter((a) => a.parent === parent.agentId && !TERMINAL_AGENT.has(a.status));
  const out = { reaped: [] as string[], adopted: [] as string[] };
  if (!kids.length) return out;
  const policy = parent.contract?.orphans === "adopt" ? "adopt" : "reap";
  const byId = new Map(all.map((a) => [a.agentId, a]));
  let heir: string | null = parent.parent;
  while (heir && TERMINAL_AGENT.has(byId.get(heir)?.status ?? "done")) heir = byId.get(heir)?.parent ?? null;
  const children = new Map<string, ScopeAgent[]>();
  for (const a of all) if (a.parent) children.set(a.parent, [...(children.get(a.parent) ?? []), a]);
  for (const k of kids) {
    if (policy === "adopt") {
      await c.db.transaction(async (tx: RawAccess) => {
        await tx.execute("UPDATE agents_v2 SET parent = ?, updated_at = ? WHERE agent_id = ?", heir, Date.now(), k.agentId);
        await addEvent(tx, "AGENT_ADOPTED", k.agentId, { from: parent.agentId, to: heir }, `adopt-${k.agentId}-${parent.agentId}`);
      }, { name: "scopeAdopt" });
      out.adopted.push(k.agentId);
      continue;
    }
    const order: ScopeAgent[] = [];
    const walk = (a: ScopeAgent) => { order.push(a); for (const g of children.get(a.agentId) ?? []) walk(g); };
    walk(k);
    for (const a of order) {
      if (TERMINAL_AGENT.has(a.status)) continue;
      await c.db.transaction(async (tx: RawAccess) => {
        await tx.execute("UPDATE agents_v2 SET status = 'cancelled', driver = NULL, driver_until = 0, updated_at = ? WHERE agent_id = ? AND status NOT IN ('done','failed','cancelled')", Date.now(), a.agentId);
        await addEvent(tx, "AGENT_REAPED", a.agentId, { orphanOf: parent.agentId, parentStatus: parent.status === "running" ? "finished" : parent.status }, `reap-${a.agentId}`);
      }, { name: "scopeReap" });
      out.reaped.push(a.agentId);
    }
  }
  return out;
}

/** An agent and its descendants (or every agent of the run when agentId is omitted), target first. */
async function preorder(c: { db: RawAccess }, agentId?: string): Promise<ScopeAgent[]> {
  const all: ScopeAgent[] = (await c.db.execute("SELECT * FROM agents_v2")).map(rowToAgent);
  const kids = new Map<string | null, ScopeAgent[]>();
  for (const a of all) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
  let targets: ScopeAgent[];
  if (agentId) {
    const t = all.find((a) => a.agentId === agentId);
    if (!t) fail("not_found", `agent ${agentId} not found`);
    targets = [t!];
  } else targets = kids.get(null) ?? [];
  const order: ScopeAgent[] = [];
  const walk = (a: ScopeAgent) => { order.push(a); for (const k of kids.get(a.agentId) ?? []) walk(k); };
  targets.forEach(walk);
  return order;
}

async function resumeAgent(c: { db: RawAccess }, agentId: string, by?: string) {
  const r = await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", agentId);
  if (!r.length) fail("not_found", `agent ${agentId} not found`);
  const a = rowToAgent(r[0]);
  if (a.status !== "paused") return { changed: false, agent: a };
  await c.db.transaction(async (tx: RawAccess) => {
    await tx.execute("UPDATE agents_v2 SET status = 'running', epoch = ?, paused_until = NULL, pause_requested = NULL, result = NULL, activity = NULL, heartbeat_at = ?, updated_at = ? WHERE agent_id = ? AND status = 'paused'",
      a.epoch + 1, Date.now(), Date.now(), agentId);
    await addEvent(tx, "AGENT_RESUMED", agentId, { epoch: a.epoch + 1, by: by ?? null }, `resume-${agentId}-e${a.epoch + 1}`);
  }, { name: "scopeResume" });
  return { changed: true, agent: rowToAgent((await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", agentId))[0]) };
}

export const scopeActor = actor({
  db: db({
    onMigrate: async (database) => {
      await database.execute(`CREATE TABLE IF NOT EXISTS scope_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
      await database.execute(`
        CREATE TABLE IF NOT EXISTS agents_v2 (
          agent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent TEXT, depth INTEGER NOT NULL,
          profile TEXT, ref TEXT, spec TEXT, limits TEXT NOT NULL, task TEXT NOT NULL, contract TEXT,
          status TEXT NOT NULL, budget TEXT NOT NULL, spent TEXT NOT NULL DEFAULT '{}',
          result TEXT, idem_key TEXT UNIQUE, params_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, driver TEXT, driver_until INTEGER
        )`);
      await database.execute(`
        CREATE TABLE IF NOT EXISTS ops (
          op_id TEXT PRIMARY KEY, kind TEXT NOT NULL, params_hash TEXT NOT NULL, state TEXT NOT NULL,
          data TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )`);
      await database.execute(`
        CREATE TABLE IF NOT EXISTS board_tasks (
          task_id TEXT PRIMARY KEY, title TEXT NOT NULL, data TEXT, status TEXT NOT NULL, holder TEXT,
          epoch INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, result TEXT, idem_key TEXT UNIQUE,
          params_hash TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        )`);
      await database.execute(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, version INTEGER NOT NULL, writer TEXT, updated_at INTEGER NOT NULL)`);
      await addColumn(database, "board_tasks", "after_ids", "TEXT");
      await addColumn(database, "kv", "deleted", "INTEGER NOT NULL DEFAULT 0");
      // ADR-017: agent heartbeats, await edges (deadlock detection), token revocation, mailbox, logs.
      await addColumn(database, "agents_v2", "heartbeat_at", "INTEGER");
      await addColumn(database, "agents_v2", "heartbeat_note", "TEXT");
      await addColumn(database, "agents_v2", "epoch", "INTEGER NOT NULL DEFAULT 1");
      await addColumn(database, "agents_v2", "paused_until", "INTEGER");
      await addColumn(database, "agents_v2", "checkpoint", "TEXT");
      await addColumn(database, "agents_v2", "notice", "TEXT");
      await addColumn(database, "agents_v2", "granted_at", "INTEGER");
      await addColumn(database, "agents_v2", "activity", "TEXT");
      await addColumn(database, "agents_v2", "workspace", "TEXT");
      await addColumn(database, "agents_v2", "pause_requested", "TEXT");
      await database.execute(`CREATE TABLE IF NOT EXISTS awaits (waiter TEXT NOT NULL, target TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (waiter, target))`);
      await database.execute(`CREATE TABLE IF NOT EXISTS revoked (jti TEXT PRIMARY KEY, reason TEXT, at INTEGER NOT NULL)`);
      await database.execute(`CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY, to_agent TEXT NOT NULL, from_agent TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, idem_key TEXT UNIQUE)`);
      await database.execute(`CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, media_type TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)`);
      await database.execute(`CREATE TABLE IF NOT EXISTS agent_logs (seq INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, at INTEGER NOT NULL, stream TEXT NOT NULL, line TEXT NOT NULL)`);
      // harness.v1 thread items (packages/agent-thread): one row per item, rewritten on each rev; seq is the run-wide
      // cursor (advanced by every write), ord its position in the thread (fixed at creation).
      await database.execute(`CREATE TABLE IF NOT EXISTS agent_items (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, seq INTEGER NOT NULL UNIQUE, ord INTEGER NOT NULL, rev INTEGER NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL)`);
      await database.execute(`CREATE INDEX IF NOT EXISTS agent_items_agent_seq ON agent_items (agent_id, seq)`);
      await database.execute(`CREATE TABLE IF NOT EXISTS idem (idem_key TEXT PRIMARY KEY, kind TEXT NOT NULL, params_hash TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL)`);
      await database.execute(`
        CREATE TABLE IF NOT EXISTS scope_events (
          seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, agent_id TEXT,
          data TEXT NOT NULL, idem_key TEXT NOT NULL UNIQUE
        )`);
    },
  }),

  actions: {
  ...traceActions("scope", {
    async init(c, params: { runId: string; budget: Budget; label?: string; goal?: string; paramsHash: string }) {
      const have = await c.db.execute("SELECT v FROM scope_meta WHERE k = 'init'");
      if (have.length) {
        const prev = JSON.parse(have[0]!.v as string);
        if (prev.paramsHash !== params.paramsHash) fail("conflict", `run ${params.runId} already exists with different parameters (budget ${JSON.stringify(prev.budget)})`);
        return { runId: params.runId, created: false, budget: prev.budget as Budget };
      }
      await c.db.transaction(async (tx: RawAccess) => {
        await tx.execute("INSERT OR IGNORE INTO scope_meta (k, v) VALUES ('init', ?)", JSON.stringify({ budget: params.budget, label: params.label ?? null, ...(params.goal ? { goal: params.goal } : {}), paramsHash: params.paramsHash, createdAt: Date.now() }));
        await addEvent(tx, "RUN_NEW", null, { budget: params.budget, label: params.label ?? null, ...(params.goal ? { goal: params.goal.slice(0, 65536) } : {}) }, `run-new`);
      }, { name: "scopeInit" });
      return { runId: params.runId, created: true, budget: params.budget };
    },

    async getScope(c, _p: Record<string, never>) {
      const have = await c.db.execute("SELECT v FROM scope_meta WHERE k = 'init'");
      if (!have.length) return null;
      const meta = JSON.parse(have[0]!.v as string);
      const all: ScopeAgent[] = (await c.db.execute("SELECT * FROM agents_v2")).map(rowToAgent);
      const tree = treeSpend(all);
      const spent: Budget = {};
      for (const u of UNITS) {
        const sp = all.reduce((x, a) => x + (a.spent[u] ?? 0), 0);
        if (sp) spent[u] = Math.round(sp * 1e6) / 1e6;
      }
      const unallocated = available(meta.budget, {}, all.filter((a) => !a.parent).map((a) => ({ ...a, tree: tree.get(a.agentId) })));
      return { budget: meta.budget as Budget, label: meta.label as string | null, goal: (meta.goal as string | undefined) ?? null, createdAt: meta.createdAt as number, spent, unallocated };
    },

    async spawn(
      c,
      params: {
        runId: string; agentId: string; key?: string; paramsHash: string; parent?: string | null;
        profile: string | null; ref: string | null; spec: Record<string, unknown> | null;
        task: string; contract?: Record<string, unknown> | null; budget?: Budget; operator?: boolean; grant?: Grant; review?: boolean;
      }
    ) {
      const existing = await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", params.agentId);
      if (existing.length) {
        const a = existing[0]!;
        if (a.params_hash !== params.paramsHash) fail("conflict", `--key already used for ${params.agentId} with different parameters`);
        return { created: false, agent: rowToAgent(a) };
      }
      const meta = await c.db.execute("SELECT v FROM scope_meta WHERE k = 'init'");
      if (!meta.length) fail("not_found", `run ${params.runId} not found (create it with capcomd run new)`);
      const runBudget = JSON.parse(meta[0]!.v as string).budget as Budget;

      let out: ScopeAgent | null = null;
      let created = false;
      await c.db.transaction(async (tx: RawAccess) => {
        const again = await tx.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", params.agentId);
        if (again.length) {
          if (again[0]!.params_hash !== params.paramsHash) fail("conflict", `--key already used for ${params.agentId} with different parameters`);
          out = rowToAgent(again[0]); return;
        }
        const get = async (id: string) => { const r = await tx.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", id); return r.length ? rowToAgent(r[0]) : null; };
        let parent: ScopeAgent | null = null;
        if (params.parent) {
          parent = await get(params.parent);
          if (!parent) fail("not_found", `parent agent ${params.parent} not found in ${params.runId}`);
        }
        const ancestors: ScopeAgent[] = [];
        for (let a = parent; a; a = a.parent ? await get(a.parent) : null) ancestors.push(a);
        const all = (await tx.execute("SELECT * FROM agents_v2")).map(rowToAgent);
        const kids = new Map<string, string[]>();
        for (const r of all) if (r.parent) kids.set(r.parent, [...(kids.get(r.parent) ?? []), r.agentId]);
        const countDesc = (id: string): number => (kids.get(id) ?? []).reduce((n, k) => n + 1 + countDesc(k), 0);
        // A sibling that reserved nothing holds what its subtree has spent so far (ADR-019).
        const tree = treeSpend(all);
        const siblings = all.filter((a) => a.parent === (params.parent ?? null)).map((a) => ({ ...a, tree: tree.get(a.agentId) }));
        const d = checkSpawn({
          parent: parent as AgentRow | null, ancestors: ancestors as AgentRow[], descendantCounts: ancestors.map((a) => countDesc(a.agentId)),
          siblings: siblings as AgentRow[], childProfile: params.profile, childSpec: (params.spec as unknown as AgentSpec) ?? null,
          requested: params.budget, runBudget, operator: params.operator, grant: params.grant, review: params.review,
        });
        if (!d.ok) fail(d.code, d.error);
        if (!d.ok) return;
        const now = Date.now();
        // The worker clones the run's recorded repository (kv _repo), else this engine's CAPCOMD_REPO (mergeConfigFor),
        // and works at its root: that is the agent's workspace.
        const repoKv = await tx.execute("SELECT v FROM kv WHERE k = ? AND deleted = 0", RUN_REPO_KV);
        let runRepo: string | undefined;
        try { if (repoKv.length) runRepo = envVar("REPO", JSON.parse(repoKv[0]!.v as string) ?? {}); } catch { /* unreadable: fall back */ }
        const workspace = workspaceOf(runRepo ?? envVar("REPO"));
        await tx.execute(
          `INSERT INTO agents_v2 (agent_id, run_id, parent, depth, profile, ref, spec, limits, task, contract, status, budget, spent, result, idem_key, params_hash, created_at, updated_at, workspace)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '{}', NULL, ?, ?, ?, ?, ?)`,
          params.agentId, params.runId, params.parent ?? null, d.depth, params.profile, params.ref,
          params.spec ? JSON.stringify(params.spec) : null, JSON.stringify(d.limits), params.task,
          params.contract ? JSON.stringify(params.contract) : null, JSON.stringify(d.budget), params.key ?? null, params.paramsHash, now, now,
          workspace ? JSON.stringify(workspace) : null
        );
        killpoint("scope.spawn.mid");
        // Same redaction path as message bodies: the row keeps the raw task for the worker; event + attachment are redacted.
        const taskInl = inlineOrAttach(redactShapes(params.task));
        if (taskInl.attachment) await tx.execute("INSERT OR IGNORE INTO attachments (id, sha256, bytes, media_type, body, at) VALUES (?, ?, ?, ?, ?, ?)", taskInl.attachment.id, taskInl.attachment.sha256, taskInl.attachment.bytes, taskInl.attachment.mediaType, taskInl.body, now);
        await addEvent(tx, "AGENT_SPAWNED", params.agentId, {
          parent: params.parent ?? null, depth: d.depth, profile: params.profile, budget: d.budget, limits: d.limits,
          agent: params.spec, task: taskInl.text, ...(taskInl.attachment ? { taskAttachment: taskInl.attachment } : {}), key: params.key ?? null, operator: !!params.operator, ...(params.review ? { review: true } : {}),
          ...(params.grant && Object.keys(params.grant).length ? { grant: params.grant } : {}), workspace,
        }, `spawn-${params.agentId}`);
        out = await get(params.agentId);
        created = true;
      }, { name: "scopeSpawn" });
      return { created, agent: out! as ScopeAgent };
    },

    /** Driver lease: one live driver per agent; a stale lease (crashed CLI) can be taken over. */
    async claimDriver(c, params: { agentId: string; driver: string; ttlMs: number }) {
      const r = await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", params.agentId);
      if (!r.length) fail("not_found", `agent ${params.agentId} not found`);
      const a = rowToAgent(r[0]);
      if (TERMINAL_AGENT.has(a.status) || a.status === "paused") return { ok: false, agent: a };
      const now = Date.now();
      if (a.driver && a.driver !== params.driver && a.driverUntil > now) return { ok: false, agent: a };
      await c.db.transaction(async (tx: RawAccess) => {
        // Starting it is its first sign of life: its liveness window runs from here, not from spawn, so the time its
        // VM takes to come up doesn't read as "no heartbeat" (resume does the same). A takeover keeps the last heartbeat.
        await tx.execute("UPDATE agents_v2 SET driver = ?, driver_until = ?, heartbeat_at = CASE WHEN status = 'pending' THEN ? ELSE heartbeat_at END, status = CASE WHEN status = 'pending' THEN 'running' ELSE status END, updated_at = ? WHERE agent_id = ? AND status NOT IN ('done','failed','cancelled')",
          params.driver, now + params.ttlMs, now, now, params.agentId);
        if (a.status === "pending") await addEvent(tx, "AGENT_STARTED", params.agentId, {}, `start-${params.agentId}`);
      }, { name: "scopeClaim" });
      return { ok: true, agent: rowToAgent((await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", params.agentId))[0]) };
    },

    async finish(c, params: { agentId: string; status: "done" | "failed"; result: Record<string, unknown>; spent?: Budget }) {
      const r = await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", params.agentId);
      if (!r.length) fail("not_found", `agent ${params.agentId} not found`);
      const a = rowToAgent(r[0]);
      if (TERMINAL_AGENT.has(a.status)) return { changed: false, agent: a };
      await c.db.transaction(async (tx: RawAccess) => {
        await tx.execute("UPDATE agents_v2 SET status = ?, result = ?, spent = ?, notice = NULL, driver = NULL, driver_until = 0, updated_at = ? WHERE agent_id = ?",
          params.status, JSON.stringify(params.result), JSON.stringify(params.spent ?? a.spent), Date.now(), params.agentId);
        await addEvent(tx, params.status === "done" ? "AGENT_DONE" : "AGENT_FAILED", params.agentId, { result: params.result, spent: params.spent ?? a.spent, budget: a.budget }, `finish-${params.agentId}`);
        await tx.execute("DELETE FROM awaits WHERE waiter = ?", params.agentId);
        // The parent's thread gets a hand-back card: the child's summary, its artifacts as links and media.
        if (a.parent) await putItemTx(tx, a.parent, handoffOf(a.parent, params.agentId, params.status, params.result));
      }, { name: "scopeFinish" });
      const orphans = await reapOrphans(c, { ...a, status: params.status });
      return { changed: true, orphans, agent: rowToAgent((await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", params.agentId))[0]) };
    },

    /** ADR-019 §3: the supervisor checkpointed the agent's workspace and the engine pushed it to `ref`. */
    async checkpoint(c, params: { agentId: string; ref: string; sha: string; reason: string; files: number }) {
      const cp = { ref: params.ref, sha: params.sha, at: Date.now(), reason: params.reason, files: params.files };
      await c.db.transaction(async (tx: RawAccess) => {
        await tx.execute("UPDATE agents_v2 SET checkpoint = ?, heartbeat_at = ? WHERE agent_id = ?", JSON.stringify(cp), Date.now(), params.agentId);
        await addEvent(tx, "AGENT_CHECKPOINT", params.agentId, cp, `ckpt-${params.agentId}-${params.sha}`);
      }, { name: "scopeCheckpoint" });
      return { ok: true };
    },

    /** ADR-019 §2: the runner's stuck notice for a running agent (null: it no longer looks stuck). */
    async notice(c, params: { agentId: string; notice: { kind: string; detail: string } | null }) {
      const r = await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", params.agentId);
      if (!r.length) fail("not_found", `agent ${params.agentId} not found`);
      const a = rowToAgent(r[0]);
      if (a.status !== "running" || (a.notice?.kind ?? null) === (params.notice?.kind ?? null)) return { changed: false };
      const n: AgentNotice | null = params.notice ? { kind: params.notice.kind, detail: params.notice.detail.slice(0, 300), at: Date.now() } : null;
      await c.db.transaction(async (tx: RawAccess) => {
        await tx.execute("UPDATE agents_v2 SET notice = ?, updated_at = ? WHERE agent_id = ?", n ? JSON.stringify(n) : null, Date.now(), params.agentId);
        await addEvent(tx, n ? "AGENT_NOTICE" : "AGENT_NOTICE_CLEARED", params.agentId, n ? { ...n } : { kind: a.notice?.kind ?? null }, `notice-${params.agentId}-${n?.at ?? `clear-${Date.now()}`}`);
      }, { name: "scopeNotice" });
      return { changed: true };
    },

    /**
     * ADR-019 §6: the agent's provider said its usage limit is reached. Its work is on its branch; it waits, neither
     * failed nor retried, until `until` (0: no reset time given) or `resume`. Releases the driver lease.
     */
    async pause(c, params: { agentId: string; until: number; result: Record<string, unknown>; spent?: Budget }) {
      const r = await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", params.agentId);
      if (!r.length) fail("not_found", `agent ${params.agentId} not found`);
      const a = rowToAgent(r[0]);
      if (TERMINAL_AGENT.has(a.status) || a.status === "paused") return { changed: false, agent: a };
      await c.db.transaction(async (tx: RawAccess) => {
        await tx.execute("UPDATE agents_v2 SET status = 'paused', paused_until = ?, pause_requested = NULL, result = ?, spent = ?, notice = NULL, driver = NULL, driver_until = 0, updated_at = ? WHERE agent_id = ?",
          params.until, JSON.stringify(params.result), JSON.stringify(params.spent ?? a.spent), Date.now(), params.agentId);
        await addEvent(tx, "AGENT_PAUSED", params.agentId, { result: params.result, until: params.until || null }, `pause-${params.agentId}-e${a.epoch}`);
      }, { name: "scopePause" });
      // Wake at the reset even when nobody awaits it (the engine host starts its driver).
      if (params.until > 0) await c.schedule.at(params.until, "wakeDue", { agentId: params.agentId, epoch: a.epoch });
      return { changed: true, agent: rowToAgent((await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", params.agentId))[0]) };
    },

    /**
     * The operator pauses an agent and its descendants (or every agent of the run). One that hasn't started is paused
     * now; a running one is asked to stop (`pause_requested`): its runner stops it at its next poll, pushes its work and
     * pauses it like a usage limit, and `resume` runs it on. Idempotent: an agent already asked is reported again.
     */
    async requestPause(c, params: { agentId?: string; by: string }) {
      const order = await preorder(c, params.agentId);
      const paused: string[] = [], pausing: string[] = [];
      for (const o of order) {
        // Read and write in one transaction, so a driver claiming the agent meanwhile can't start it and see it paused.
        await c.db.transaction(async (tx: RawAccess) => {
          const a = rowToAgent((await tx.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", o.agentId))[0]);
          if (a.status === "pending") {
            const result = { limit: "paused", by: params.by, error: `paused by the operator${params.by === "operator" ? "" : ` (${params.by})`} before it started; it runs on \`capcomd resume\`` };
            await tx.execute("UPDATE agents_v2 SET status = 'paused', paused_until = NULL, pause_requested = NULL, result = ?, driver = NULL, driver_until = 0, updated_at = ? WHERE agent_id = ? AND status = 'pending'",
              JSON.stringify(result), Date.now(), a.agentId);
            await addEvent(tx, "AGENT_PAUSED", a.agentId, { result, until: null }, `pause-${a.agentId}-e${a.epoch}`);
            paused.push(a.agentId);
          } else if (a.status === "running") {
            if (!a.pauseRequested) await tx.execute("UPDATE agents_v2 SET pause_requested = ?, updated_at = ? WHERE agent_id = ? AND status = 'running'", params.by, Date.now(), a.agentId);
            pausing.push(a.agentId);
          }
        }, { name: "scopeRequestPause" });
      }
      return { paused, pausing, affected: order.map((a) => a.agentId) };
    },

    /** A paused agent runs again as its next epoch (a new worker and VM, continuing on its branch). */
    async resume(c, params: { agentId: string; by?: string }) {
      return resumeAgent(c, params.agentId, params.by);
    },

    /**
     * Scheduled by `pause` for its reset time: the agent runs again if it is still that pause (not resumed, cancelled
     * or paused again since), and the engine host starts its driver. A waiter that got there first already did both.
     */
    async wakeDue(c, params: { agentId: string; epoch: number }) {
      const r = await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", params.agentId);
      if (!r.length) return { woken: false };
      const a = rowToAgent(r[0]);
      if (a.status !== "paused" || a.epoch !== params.epoch || !a.pausedUntil || a.pausedUntil > Date.now() + 1000) return { woken: false };
      const res = await resumeAgent(c, params.agentId, "reset");
      if (res.changed) startDriver(a.runId, a.agentId);
      return { woken: res.changed };
    },

    /** Merge fields into a finished agent's result (ADR-017: the latest verification of its branch). */
    async annotateResult(c, params: { agentId: string; patch: Record<string, unknown> }) {
      const r = await c.db.execute("SELECT result FROM agents_v2 WHERE agent_id = ?", params.agentId);
      if (!r.length) fail("not_found", `agent ${params.agentId} not found`);
      const cur = r[0]!.result ? JSON.parse(r[0]!.result as string) : {};
      await c.db.execute("UPDATE agents_v2 SET result = ? WHERE agent_id = ?", JSON.stringify({ ...cur, ...params.patch }), params.agentId);
      return { ok: true };
    },

    /** Agent liveness (ADR-017): every in-VM call and every new log line counts; `note` is free text. */
    async heartbeat(c, params: { agentId: string; note?: string }) {
      await c.db.execute("UPDATE agents_v2 SET heartbeat_at = ?, heartbeat_note = COALESCE(?, heartbeat_note) WHERE agent_id = ?", Date.now(), params.note?.slice(0, 200) ?? null, params.agentId);
      return { ok: true };
    },

    /**
     * ADR-019: a running agent's spend, reported live by its runner (not only when it finishes). Recorded on the agent
     * (so budget, tree and spawns see it), then checked against its own budget, every ancestor's (their subtree's
     * spend) and the run's. `stop` names the limit to stop at (result.limit) when one is over.
     */
    async reportSpend(c, params: { agentId: string; spent: Budget; inboxAfter?: number }) {
      const r = await c.db.execute("SELECT status FROM agents_v2 WHERE agent_id = ?", params.agentId);
      if (!r.length || TERMINAL_AGENT.has(r[0]!.status as string)) return { stop: null };
      await c.db.execute("UPDATE agents_v2 SET spent = ? WHERE agent_id = ? AND status NOT IN ('done','failed','cancelled')", JSON.stringify(params.spent), params.agentId);
      const meta = await c.db.execute("SELECT v FROM scope_meta WHERE k = 'init'");
      const runBudget = meta.length ? (JSON.parse(meta[0]!.v as string).budget as Budget) : {};
      const all: ScopeAgent[] = (await c.db.execute("SELECT * FROM agents_v2")).map(rowToAgent);
      const over = overBudget(params.agentId, all, runBudget);
      // The runner resets its stuck window when it sees a new grant (ADR-019 §2), and checkpoints at budget steps (§3).
      const grantedAt = Number(all.find((a) => a.agentId === params.agentId)?.grantedAt ?? 0);
      const used = budgetUsed(params.agentId, all, runBudget);
      // An agent that reads messages while it runs gets the ones sent since its cursor with each report.
      const messages = params.inboxAfter === undefined ? undefined : ((await c.db.execute("SELECT seq, from_agent, body FROM messages WHERE to_agent = ? AND seq > ? ORDER BY seq", params.agentId, params.inboxAfter)) as any[])
        .map((r) => ({ seq: Number(r.seq), from: r.from_agent as string, body: r.body as string }));
      return { ...(over ? { stop: UNIT_LIMIT[over.unit], over } : { stop: null }), grantedAt, used, ...(messages ? { messages } : {}) };
    },

    /**
     * ADR-019 §4: more budget for a live agent, carved from what its parent (or the run) has left; without an agent,
     * a higher run budget (the operator's call). Additive, so a retry needs the same `key` to count once.
     */
    async grant(c, params: { agentId?: string; add: Budget; by: string; key?: string; paramsHash: string }) {
      let out: Record<string, unknown> = {};
      await c.db.transaction(async (tx: RawAccess) => {
        const again = await replay(tx, params.key, params.paramsHash);
        if (again) { out = again; return; }
        const meta = await tx.execute("SELECT v FROM scope_meta WHERE k = 'init'");
        if (!meta.length) fail("not_found", "run not found (create it with capcomd run new)");
        const init = JSON.parse(meta[0]!.v as string);
        const runBudget = init.budget as Budget;
        const all: ScopeAgent[] = (await tx.execute("SELECT * FROM agents_v2")).map(rowToAgent);
        const tree = treeSpend(all);
        const withTree = (xs: ScopeAgent[]) => xs.map((x) => ({ ...x, tree: tree.get(x.agentId) }));
        if (!params.agentId) {
          const g = growRun(runBudget, params.add);
          if (!g.ok) fail("grant", g.error);
          if (!g.ok) return;
          await tx.execute("UPDATE scope_meta SET v = ? WHERE k = 'init'", JSON.stringify({ ...init, budget: g.budget }));
          await addEvent(tx, "RUN_GRANTED", null, { add: params.add, budget: g.budget, by: params.by }, `grant-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
          out = { agentId: null, add: params.add, budget: g.budget, left: available(g.budget, {}, withTree(all.filter((x) => !x.parent))) };
        } else {
          const a = all.find((x) => x.agentId === params.agentId);
          if (!a) fail("not_found", `agent ${params.agentId} not found`);
          if (!a) return;
          if (TERMINAL_AGENT.has(a.status)) fail("finished", `agent ${a.agentId} is ${a.status}`);
          const parent = a.parent ? all.find((x) => x.agentId === a.parent) ?? null : null;
          const siblings = withTree(all.filter((x) => x.parent === a.parent));
          const avail = parent ? available(parent.budget, parent.spent, siblings) : available(runBudget, {}, siblings);
          const g = checkGrant({ agentId: a.agentId, budget: a.budget, used: tree.get(a.agentId) ?? {}, add: params.add, avail, from: parent?.agentId ?? "run", caps: profileDefaults(a.spec as AgentSpec | null).caps });
          if (!g.ok) fail("grant", g.error);
          if (!g.ok) return;
          const now = Date.now();
          await tx.execute("UPDATE agents_v2 SET budget = ?, granted_at = ?, updated_at = ? WHERE agent_id = ?", JSON.stringify(g.budget), now, now, a.agentId);
          await addEvent(tx, "AGENT_GRANTED", a.agentId, { add: params.add, budget: g.budget, by: params.by }, `grant-${a.agentId}-${now}-${Math.random().toString(36).slice(2, 8)}`);
          const after = siblings.map((x) => (x.agentId === a.agentId ? { ...x, budget: g.budget } : x));
          out = { agentId: a.agentId, add: params.add, budget: g.budget, from: parent?.agentId ?? "run", left: parent ? available(parent.budget, parent.spent, after) : available(runBudget, {}, after) };
        }
        await remember(tx, params.key, "grant", params.paramsHash, out);
      }, { name: "scopeGrant" });
      return out;
    },

    /**
     * Register that `waiter` is blocked on `targets`. Refuses (code deadlock) when a target is
     * (transitively) waiting on the waiter, or is the waiter's ancestor: neither can ever finish.
     */
    async awaitBegin(c, params: { waiter: string; targets: string[] }) {
      const all: ScopeAgent[] = (await c.db.execute("SELECT * FROM agents_v2")).map(rowToAgent);
      const byId = new Map(all.map((a) => [a.agentId, a]));
      const live = (id: string) => { const a = byId.get(id); return !!a && !TERMINAL_AGENT.has(a.status); };
      for (let p = byId.get(params.waiter)?.parent; p; p = byId.get(p)?.parent ?? null)
        if (params.targets.includes(p) && live(p)) fail("deadlock", `deadlock: ${params.waiter} awaits its ancestor ${p}, which cannot finish before its descendants`);
      const edges = new Map<string, string[]>();
      for (const r of (await c.db.execute("SELECT waiter, target FROM awaits")) as any[]) {
        if (!live(r.waiter) || r.waiter === params.waiter) continue;
        edges.set(r.waiter, [...(edges.get(r.waiter) ?? []), r.target]);
      }
      // Path target → … → waiter means the new edges close a cycle.
      for (const t of params.targets) {
        if (!live(t)) continue;
        const path = findPath(edges, t, params.waiter);
        if (path) {
          await c.db.transaction(async (tx: RawAccess) => { await addEvent(tx, "DEADLOCK_DETECTED", params.waiter, { cycle: [params.waiter, ...path] }, `deadlock-${params.waiter}-${t}-${Date.now()}`); }, { name: "scopeDeadlock" });
          fail("deadlock", `deadlock: await cycle ${[params.waiter, ...path].join(" → ")}`);
        }
      }
      await c.db.transaction(async (tx: RawAccess) => {
        await tx.execute("DELETE FROM awaits WHERE waiter = ?", params.waiter);
        for (const t of params.targets) await tx.execute("INSERT OR REPLACE INTO awaits (waiter, target, since) VALUES (?, ?, ?)", params.waiter, t, Date.now());
      }, { name: "scopeAwaitBegin" });
      return { ok: true };
    },
    async awaitEnd(c, params: { waiter: string }) {
      await c.db.execute("DELETE FROM awaits WHERE waiter = ?", params.waiter);
      return { ok: true };
    },
    async listAwaits(c, _p: Record<string, never>) {
      return ((await c.db.execute("SELECT waiter, target, since FROM awaits ORDER BY since")) as any[]).map((r) => ({ waiter: r.waiter as string, target: r.target as string, since: Number(r.since) }));
    },

    /** A drive attempt failed: record it (redacted) and say how many identical failures are in a row. */
    async driveFailed(c, params: { agentId: string; kind: string; message: string; attempt: number; driver: string }) {
      const message = redactShapes(params.message).slice(0, 1000);
      let consecutive = 1;
      await c.db.transaction(async (tx: RawAccess) => {
        const evs = await tx.execute("SELECT type, data FROM scope_events WHERE agent_id = ? ORDER BY seq DESC LIMIT 50", params.agentId);
        for (const e of evs as any[]) {
          if (e.type === "TOKEN_REVOKED" || e.type === "MESSAGE_SENT") continue;
          if (e.type !== "DRIVE_FAILED") break;
          const d = JSON.parse(String(e.data));
          if (d.kind === params.kind && d.message === message) consecutive++; else break;
        }
        await addEvent(tx, "DRIVE_FAILED", params.agentId, { kind: params.kind, error_kind: params.kind, message, attempt: params.attempt, driver: params.driver, consecutive }, `drivefail-${params.driver}-${params.attempt}`);
        // The driver is gone for now: let the next attempt (this process or another) claim at once.
        await tx.execute("UPDATE agents_v2 SET driver = NULL, driver_until = 0 WHERE agent_id = ? AND driver = ?", params.agentId, params.driver);
      }, { name: "scopeDriveFailed" });
      return { consecutive };
    },
    async revokeToken(c, params: { jti: string; reason?: string; agentId?: string }) {
      await c.db.transaction(async (tx: RawAccess) => {
        await tx.execute("INSERT OR IGNORE INTO revoked (jti, reason, at) VALUES (?, ?, ?)", params.jti, params.reason ?? null, Date.now());
        await addEvent(tx, "TOKEN_REVOKED", params.agentId ?? null, { jti: params.jti, reason: params.reason ?? null }, `revoke-${params.jti}`);
      }, { name: "scopeRevoke" });
      return { revoked: true };
    },
    async isRevoked(c, params: { jti: string }) {
      return { revoked: (await c.db.execute("SELECT 1 FROM revoked WHERE jti = ?", params.jti)).length > 0 };
    },

    /** Mailbox: `send` appends (idempotent by key); `inbox` reads messages after a cursor. */
    async sendMessage(c, params: { to: string; from: string; body: string; key?: string }) {
      if (params.key) { const r = await c.db.execute("SELECT seq FROM messages WHERE idem_key = ?", params.key); if (r.length) return { seq: Number(r[0]!.seq), replayed: true }; }
      let seq = 0;
      await c.db.transaction(async (tx: RawAccess) => {
        const m = await tx.execute("SELECT COALESCE(MAX(seq), 0) AS m FROM messages");
        seq = Number(m[0]!.m) + 1;
        await tx.execute("INSERT INTO messages (seq, to_agent, from_agent, body, at, idem_key) VALUES (?, ?, ?, ?, ?, ?)", seq, params.to, params.from, params.body, Date.now(), params.key ?? null);
        // 64 KB inline cap: longer bodies are stored in full as an attachment and the event carries a pointer.
        const inl = inlineOrAttach(redactShapes(params.body));
        if (inl.attachment) await tx.execute("INSERT OR IGNORE INTO attachments (id, sha256, bytes, media_type, body, at) VALUES (?, ?, ?, ?, ?, ?)", inl.attachment.id, inl.attachment.sha256, inl.attachment.bytes, inl.attachment.mediaType, inl.body, Date.now());
        await addEvent(tx, "MESSAGE_SENT", params.from, { to: params.to, seq, bytes: params.body.length, text: inl.text, attachment: inl.attachment }, `msg-${seq}`);
      }, { name: "scopeSend" });
      return { seq };
    },
    /** Full text of an attachment written by the 64 KB inline cap. */
    async getAttachment(c, params: { id: string }) {
      const r = (await c.db.execute("SELECT * FROM attachments WHERE id = ?", params.id)) as any[];
      return r.length ? { id: r[0].id as string, sha256: r[0].sha256 as string, bytes: Number(r[0].bytes), mediaType: r[0].media_type as string, body: r[0].body as string } : null;
    },
    async inbox(c, params: { agentId: string; after?: number }) {
      return ((await c.db.execute("SELECT * FROM messages WHERE to_agent = ? AND seq > ? ORDER BY seq", params.agentId, params.after ?? 0)) as any[])
        .map((r) => ({ seq: Number(r.seq), from: r.from_agent as string, body: r.body as string, at: Number(r.at) }));
    },

    async appendLog(c, params: { agentId: string; stream: string; lines: string[] }) {
      if (!params.lines.length) return { ok: true };
      await c.db.transaction(async (tx: RawAccess) => {
        const now = Date.now();
        for (const l of params.lines) await tx.execute("INSERT INTO agent_logs (agent_id, at, stream, line) VALUES (?, ?, ?, ?)", params.agentId, now, params.stream, redactShapes(l).slice(0, 4000));
        await tx.execute("UPDATE agents_v2 SET heartbeat_at = ? WHERE agent_id = ?", now, params.agentId);
      }, { name: "scopeLog" });
      return { ok: true };
    },
    /**
     * Thread items an agent's runner built (packages/agent-thread), and the images its tools returned. An item whose
     * stored rev is already this high is left alone (a replayed write). Agent text is redacted again here.
     */
    async putItems(c, params: { agentId: string; items: ItemDraft[]; attachments?: ThreadAttachment[] }) {
      if (!params.items.length && !params.attachments?.length) return { seq: null };
      let last: number | null = null;
      await c.db.transaction(async (tx: RawAccess) => {
        for (const a of params.attachments ?? []) {
          if (!/^att-[0-9a-f]{24}$/.test(a.id) || !IMAGE_TYPES.includes(a.mime as any) || a.bytes > IMAGE_MAX_BYTES) continue;
          await tx.execute("INSERT OR IGNORE INTO attachments (id, sha256, bytes, media_type, body, at) VALUES (?, ?, ?, ?, ?, ?)", a.id, a.sha256, a.bytes, `${a.mime};base64`, a.base64, Date.now());
        }
        for (const it of params.items) last = (await putItemTx(tx, params.agentId, it)) ?? last;
        await tx.execute("UPDATE agents_v2 SET heartbeat_at = ? WHERE agent_id = ?", Date.now(), params.agentId);
      }, { name: "scopeItems" });
      return { seq: last };
    },
    /** Thread items after `after` (seq), oldest write first; one agent's, or the whole run's. */
    async getItems(c, params: { agentId?: string; after?: number; limit?: number }) {
      const rows = (params.agentId
        ? await c.db.execute("SELECT * FROM agent_items WHERE agent_id = ? AND seq > ? ORDER BY seq LIMIT ?", params.agentId, params.after ?? 0, params.limit ?? 200)
        : await c.db.execute("SELECT * FROM agent_items WHERE seq > ? ORDER BY seq LIMIT ?", params.after ?? 0, params.limit ?? 200)) as any[];
      return rows.map((r) => {
        const it = JSON.parse(r.body as string);
        // tool.diff came later: a row written before it reads as no diff.
        if (it.tool && !("diff" in it.tool)) it.tool.diff = null;
        return { ...it, seq: Number(r.seq), order: Number(r.ord), agentId: r.agent_id as string };
      });
    },
    /** The run's newest thread write (a live-frame cursor). */
    async itemsHead(c) {
      const r = (await c.db.execute("SELECT COALESCE(MAX(seq), 0) AS m FROM agent_items")) as any[];
      return Number(r[0]?.m ?? 0);
    },

    async getLogs(c, params: { agentId: string; tail?: number; after?: number }) {
      const rows = (params.after !== undefined
        ? await c.db.execute("SELECT * FROM agent_logs WHERE agent_id = ? AND seq > ? ORDER BY seq LIMIT ?", params.agentId, params.after, params.tail ?? 200)
        : await c.db.execute("SELECT * FROM (SELECT * FROM agent_logs WHERE agent_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq", params.agentId, params.tail ?? 200)) as any[];
      return rows.map((r) => ({ seq: Number(r.seq), at: Number(r.at), stream: r.stream as string, line: r.line as string }));
    },

    /**
     * Cancel an agent and all its descendants (or the whole run when agentId is omitted).
     * Each agent is cancelled in its own transaction, in pre-order (target first, then its subtree),
     * so a crash mid-way leaves a prefix that the retried (idempotent) call completes.
     */
    async cancel(c, params: { agentId?: string; reason?: string }) {
      const order = await preorder(c, params.agentId);
      const cancelled: string[] = [];
      let i = 0;
      for (const a of order) {
        if (TERMINAL_AGENT.has(a.status)) continue;
        await c.db.transaction(async (tx: RawAccess) => {
          await tx.execute("UPDATE agents_v2 SET status = 'cancelled', driver = NULL, driver_until = 0, updated_at = ? WHERE agent_id = ? AND status NOT IN ('done','failed','cancelled')", Date.now(), a.agentId);
          await addEvent(tx, "AGENT_CANCELLED", a.agentId, { reason: params.reason ?? null, by: params.agentId ?? "run" }, `cancel-${a.agentId}`);
        }, { name: "scopeCancel" });
        cancelled.push(a.agentId);
        if (++i === 1) killpoint("scope.cancel.mid");
      }
      return { cancelled, affected: order.map((a) => a.agentId) };
    },

    /** verify / merge records (ADR-016 step 2): start is idempotent by id; same id + other params = conflict. */
    async startOp(c, params: { opId: string; kind: "verify" | "merge"; paramsHash: string; data: Record<string, unknown> }) {
      const get = async () => { const r = await c.db.execute("SELECT * FROM ops WHERE op_id = ?", params.opId); return r.length ? opRow(r[0]) : null; };
      const have = await get();
      if (have) {
        if (have.paramsHash !== params.paramsHash) fail("conflict", `${params.opId} already exists with different parameters`);
        return { created: false, op: have };
      }
      let created = false;
      await c.db.transaction(async (tx: RawAccess) => {
        const again = await tx.execute("SELECT params_hash FROM ops WHERE op_id = ?", params.opId);
        if (again.length) { if (again[0]!.params_hash !== params.paramsHash) fail("conflict", `${params.opId} already exists with different parameters`); return; }
        const now = Date.now();
        await tx.execute("INSERT INTO ops (op_id, kind, params_hash, state, data, result, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, NULL, ?, ?)",
          params.opId, params.kind, params.paramsHash, JSON.stringify(params.data), now, now);
        await addEvent(tx, params.kind === "verify" ? "VERIFY_STARTED" : "MERGE_STARTED", (params.data.agentId as string) ?? null, { id: params.opId, ...params.data }, `start-${params.opId}`);
        created = true;
      }, { name: "scopeStartOp" });
      return { created, op: (await get())! };
    },

    async finishOp(c, params: { opId: string; state: "passed" | "failed" | "merged"; result: Record<string, unknown> }) {
      const r = await c.db.execute("SELECT * FROM ops WHERE op_id = ?", params.opId);
      if (!r.length) fail("not_found", `${params.opId} not found`);
      const op = opRow(r[0]);
      if (op.state !== "running") return op;
      const type = op.kind === "verify" ? (params.state === "passed" ? "VERIFY_PASSED" : "VERIFY_FAILED") : params.state === "merged" ? "MERGED" : "MERGE_FAILED";
      await c.db.transaction(async (tx: RawAccess) => {
        await tx.execute("UPDATE ops SET state = ?, result = ?, updated_at = ? WHERE op_id = ? AND state = 'running'", params.state, JSON.stringify(params.result), Date.now(), params.opId);
        await addEvent(tx, type, (op.data.agentId as string) ?? null, { id: params.opId, ...params.result }, `finish-${params.opId}`);
      }, { name: "scopeFinishOp" });
      return opRow((await c.db.execute("SELECT * FROM ops WHERE op_id = ?", params.opId))[0]);
    },

    async getOp(c, params: { opId: string }) {
      const r = await c.db.execute("SELECT * FROM ops WHERE op_id = ?", params.opId);
      return r.length ? opRow(r[0]) : null;
    },

    /** Merges into a protected target wait for the operator: running → awaiting_approval (idempotent). */
    async parkOp(c, params: { opId: string; reason: string }) {
      await c.db.transaction(async (tx: RawAccess) => {
        const r = await tx.execute("SELECT * FROM ops WHERE op_id = ?", params.opId);
        if (!r.length) fail("not_found", `${params.opId} not found`);
        const op = opRow(r[0]);
        if (op.state !== "running") return;
        await tx.execute("UPDATE ops SET state = 'awaiting_approval', updated_at = ? WHERE op_id = ? AND state = 'running'", Date.now(), params.opId);
        await addEvent(tx, "MERGE_AWAITING_APPROVAL", (op.data.agentId as string) ?? null, { id: params.opId, target: op.data.target, ref: op.data.ref, reason: params.reason }, `park-${params.opId}`);
      }, { name: "scopeParkOp" });
      return opRow((await c.db.execute("SELECT * FROM ops WHERE op_id = ?", params.opId))[0]);
    },

    /** The operator's decision on a parked merge: approve → running again (the merge then runs), deny → failed. */
    async decideOp(c, params: { opId: string; approve: boolean; by: string; reason?: string }) {
      let decided = false;
      await c.db.transaction(async (tx: RawAccess) => {
        const r = await tx.execute("SELECT * FROM ops WHERE op_id = ?", params.opId);
        if (!r.length) fail("not_found", `${params.opId} not found`);
        const op = opRow(r[0]);
        if (op.state !== "awaiting_approval") return;
        const now = Date.now();
        if (params.approve) {
          await tx.execute("UPDATE ops SET state = 'running', updated_at = ? WHERE op_id = ? AND state = 'awaiting_approval'", now, params.opId);
          await addEvent(tx, "MERGE_APPROVED", (op.data.agentId as string) ?? null, { id: params.opId, by: params.by }, `approve-${params.opId}`);
        } else {
          const result = { merged: false, status: "denied", by: params.by, ...(params.reason ? { reason: params.reason } : {}) };
          await tx.execute("UPDATE ops SET state = 'failed', result = ?, updated_at = ? WHERE op_id = ? AND state = 'awaiting_approval'", JSON.stringify(result), now, params.opId);
          await addEvent(tx, "MERGE_DENIED", (op.data.agentId as string) ?? null, { id: params.opId, ...result }, `deny-${params.opId}`);
        }
        decided = true;
      }, { name: "scopeDecideOp" });
      return { decided, op: opRow((await c.db.execute("SELECT * FROM ops WHERE op_id = ?", params.opId))[0]) };
    },

    /** Ops in a state (e.g. merges awaiting approval), oldest first. */
    async listOps(c, params: { state?: string; kind?: string } = {}) {
      const rows = await c.db.execute("SELECT * FROM ops ORDER BY created_at");
      return rows.map(opRow).filter((o: ScopeOp) => (!params.state || o.state === params.state) && (!params.kind || o.kind === params.kind));
    },

    // ---- ADR-016 step 3: task board with leases ----
    async taskAdd(c, params: { taskId: string; title: string; data?: unknown; after?: string[]; key?: string; paramsHash: string }) {
      const get = async (db: any) => { const r = await db.execute("SELECT * FROM board_tasks WHERE task_id = ?", params.taskId); return r.length ? rowToTask(r[0]) : null; };
      let created = false;
      await c.db.transaction(async (tx: RawAccess) => {
        const have = await tx.execute("SELECT params_hash FROM board_tasks WHERE task_id = ?", params.taskId);
        if (have.length) { if (have[0]!.params_hash !== params.paramsHash) fail("conflict", `task ${params.taskId} already exists with different parameters`); return; }
        const after = [...new Set(params.after ?? [])];
        const all = (await tx.execute("SELECT task_id, after_ids FROM board_tasks")) as any[];
        const known = new Set(all.map((r) => r.task_id as string));
        const missing = after.filter((d) => d !== params.taskId && !known.has(d));
        if (missing.length) fail("not_found", `--after: unknown task(s) ${missing.join(", ")}`);
        const graph = new Map<string, string[]>(all.map((r) => [r.task_id as string, r.after_ids ? JSON.parse(r.after_ids) : []]));
        graph.set(params.taskId, after);
        const cycle = findCycle(graph);
        if (cycle) fail("cycle", `--after would create a dependency cycle: ${cycle.join(" -> ")}`);
        const now = Date.now();
        await tx.execute("INSERT INTO board_tasks (task_id, title, data, status, holder, epoch, lease_until, result, idem_key, params_hash, created_at, updated_at, after_ids) VALUES (?, ?, ?, 'open', NULL, 0, 0, NULL, ?, ?, ?, ?, ?)",
          params.taskId, params.title, params.data === undefined ? null : JSON.stringify(params.data), params.key ?? null, params.paramsHash, now, now, after.length ? JSON.stringify(after) : null);
        await addEvent(tx, "TASK_ADDED", null, { taskId: params.taskId, title: params.title, ...(after.length ? { after } : {}) }, `task-add-${params.taskId}`);
        created = true;
      }, { name: "scopeTaskAdd" });
      return { created, task: (await get(c.db))! };
    },

    async taskClaim(c, params: { holder: string; taskId?: string; leaseMs: number; key?: string; paramsHash: string }) {
      let out: Record<string, unknown> = {};
      await c.db.transaction(async (tx: RawAccess) => {
        const prev = await replay(tx, params.key, params.paramsHash);
        if (prev) { out = prev; return; }
        const now = Date.now();
        let t: BoardTask | null;
        if (params.taskId) {
          const r = await tx.execute("SELECT * FROM board_tasks WHERE task_id = ?", params.taskId);
          if (!r.length) fail("not_found", `task ${params.taskId} not found`);
          t = rowToTask(r[0]);
          const ok = claimable(t, now);
          if (!ok.ok) fail("lease_held", ok.why);
          const done = new Set(((await tx.execute("SELECT task_id FROM board_tasks WHERE status = 'done'")) as any[]).map((x) => x.task_id as string));
          const b = blockers(t, done);
          if (b.length) fail("blocked", `task ${t.taskId} is blocked by ${b.join(", ")} (not done yet)`);
        } else {
          t = pickNext((await tx.execute("SELECT * FROM board_tasks ORDER BY created_at, task_id")).map(rowToTask), now);
          if (!t) { out = { claimed: false, task: null }; return; }
        }
        const take = claimable(t, now);
        const takeover = take.ok ? take.takeover : null;
        const epoch = t.epoch + 1, until = now + params.leaseMs;
        await tx.execute("UPDATE board_tasks SET status = 'claimed', holder = ?, epoch = ?, lease_until = ?, updated_at = ? WHERE task_id = ? AND epoch = ?",
          params.holder, epoch, until, now, t.taskId, t.epoch);
        killpoint("board.claim.mid");
        if (takeover) await addEvent(tx, "TASK_LEASE_EXPIRED", null, { taskId: t.taskId, holder: takeover.holder, epoch: takeover.epoch }, `task-expired-${t.taskId}-${takeover.epoch}`);
        await addEvent(tx, "TASK_CLAIMED", null, { taskId: t.taskId, holder: params.holder, epoch, leaseUntil: until, ...(takeover ? { takeoverFrom: takeover.holder } : {}) }, `task-claim-${t.taskId}-${epoch}`);
        out = { claimed: true, taskId: t.taskId, holder: params.holder, epoch, leaseUntil: until, takeover: takeover ?? null };
        await remember(tx, params.key, "claim", params.paramsHash, out);
      }, { name: "scopeTaskClaim" });
      killpoint("board.claim.after.before_reply");
      return out;
    },

    async taskRenew(c, params: { taskId: string; holder: string; epoch: number; leaseMs: number }) {
      let out: Record<string, unknown> = {};
      await c.db.transaction(async (tx: RawAccess) => {
        const r = await tx.execute("SELECT * FROM board_tasks WHERE task_id = ?", params.taskId);
        if (!r.length) fail("not_found", `task ${params.taskId} not found`);
        const f = fence(rowToTask(r[0]), params.holder, params.epoch);
        if (!f.ok) fail(f.code, f.why);
        const until = Date.now() + params.leaseMs;
        await tx.execute("UPDATE board_tasks SET lease_until = ?, updated_at = ? WHERE task_id = ? AND epoch = ?", until, Date.now(), params.taskId, params.epoch);
        out = { taskId: params.taskId, holder: params.holder, epoch: params.epoch, leaseUntil: until };
      }, { name: "scopeTaskRenew" });
      return out; // renewals are not events: they'd flood the log
    },

    async taskFinish(c, params: { taskId: string; holder: string; epoch: number; outcome: "done" | "released"; result?: unknown; key?: string; paramsHash: string }) {
      let out: Record<string, unknown> = {};
      await c.db.transaction(async (tx: RawAccess) => {
        const prev = await replay(tx, params.key, params.paramsHash);
        if (prev) { out = prev; return; }
        const r = await tx.execute("SELECT * FROM board_tasks WHERE task_id = ?", params.taskId);
        if (!r.length) fail("not_found", `task ${params.taskId} not found`);
        const t = rowToTask(r[0]);
        // Same holder+epoch repeating done/release without a key: already applied, report it.
        if (t.epoch === params.epoch && t.holder === params.holder && ((params.outcome === "done" && t.status === "done"))) { out = { taskId: t.taskId, status: t.status, epoch: t.epoch, replayed: true }; return; }
        const f = fence(t, params.holder, params.epoch);
        if (!f.ok) fail(f.code, f.why);
        const now = Date.now();
        if (params.outcome === "done") {
          await tx.execute("UPDATE board_tasks SET status = 'done', result = ?, lease_until = 0, updated_at = ? WHERE task_id = ? AND epoch = ?", params.result === undefined ? null : JSON.stringify(params.result), now, t.taskId, t.epoch);
          await addEvent(tx, "TASK_DONE", null, { taskId: t.taskId, holder: params.holder, epoch: t.epoch, ...(params.result === undefined ? {} : { result: params.result }) }, `task-done-${t.taskId}`);
        } else {
          await tx.execute("UPDATE board_tasks SET status = 'open', holder = NULL, lease_until = 0, updated_at = ? WHERE task_id = ? AND epoch = ?", now, t.taskId, t.epoch);
          await addEvent(tx, "TASK_RELEASED", null, { taskId: t.taskId, holder: params.holder, epoch: t.epoch }, `task-release-${t.taskId}-${t.epoch}`);
        }
        out = { taskId: t.taskId, status: params.outcome === "done" ? "done" : "open", epoch: t.epoch };
        await remember(tx, params.key, params.outcome, params.paramsHash, out);
      }, { name: "scopeTaskFinish" });
      return out;
    },

    async taskGet(c, params: { taskId: string }) {
      const r = await c.db.execute("SELECT * FROM board_tasks WHERE task_id = ?", params.taskId);
      return r.length ? rowToTask(r[0]) : null;
    },

    async taskList(c, params: { status?: string }) {
      const rows = params.status
        ? await c.db.execute("SELECT * FROM board_tasks WHERE status = ? ORDER BY created_at, task_id", params.status)
        : await c.db.execute("SELECT * FROM board_tasks ORDER BY created_at, task_id");
      const now = Date.now();
      const done = new Set(((await c.db.execute("SELECT task_id FROM board_tasks WHERE status = 'done'")) as any[]).map((x) => x.task_id as string));
      return rows.map(rowToTask).map((t: ScopeTask) => ({ ...t, expired: t.status === "claimed" && t.leaseUntil <= now, blockedBy: t.status === "done" ? [] : blockers(t, done) }));
    },

    // ---- ADR-016 step 3: blackboard (versioned kv) ----
    async kvWrite(c, params: { k: string; value: unknown; expect?: number; writer?: string; key?: string; paramsHash: string; del?: boolean }) {
      if (!params.del && valueBytes(params.value) > KV_MAX_BYTES) fail("too_large", `kv ${params.k}: value is ${valueBytes(params.value)} bytes, cap is ${KV_MAX_BYTES}`);
      let out: Record<string, unknown> = {};
      await c.db.transaction(async (tx: RawAccess) => {
        const prev = await replay(tx, params.key, params.paramsHash);
        if (prev) { out = prev; return; }
        const r = await tx.execute("SELECT version, deleted FROM kv WHERE k = ?", params.k);
        const cur = r.length ? Number(r[0]!.version) : 0;
        if (params.del && (!r.length || Number(r[0]!.deleted) === 1) && params.expect === undefined) { out = { k: params.k, version: cur, ok: true, deleted: true, noop: true }; return; }
        if (params.expect !== undefined && !casOk(cur, params.expect)) fail("cas_mismatch", `cas ${params.k}: version is ${cur}, expected ${params.expect}`);
        const version = cur + 1, now = Date.now();
        await tx.execute("INSERT INTO kv (k, v, version, writer, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, version = excluded.version, writer = excluded.writer, updated_at = excluded.updated_at, deleted = excluded.deleted",
          params.k, JSON.stringify(params.del ? null : (params.value ?? null)), version, params.writer ?? null, now, params.del ? 1 : 0);
        killpoint("kv.cas.mid");
        await addEvent(tx, params.del ? "KV_DELETE" : params.expect === undefined ? "KV_PUT" : "KV_CAS", null, { k: params.k, version, ...(params.writer ? { writer: params.writer } : {}) }, `kv-${params.k}-${version}`);
        out = { k: params.k, version, ok: true, ...(params.del ? { deleted: true } : {}) };
        await remember(tx, params.key, "kv", params.paramsHash, out);
      }, { name: "scopeKvWrite" });
      killpoint("kv.cas.after.before_reply");
      return out;
    },

    async kvGet(c, params: { k: string }) {
      const r = await c.db.execute("SELECT * FROM kv WHERE k = ?", params.k);
      return r.length ? kvRow(r[0]) : null;
    },

    async kvList(c, params: { prefix?: string; all?: boolean }) {
      const p = params.prefix ?? "";
      const rows = await c.db.execute(`SELECT * FROM kv WHERE substr(k, 1, ?) = ? ${params.all ? "" : "AND deleted = 0"} ORDER BY k`, p.length, p);
      return rows.map(kvRow);
    },

    async getAgent(c, params: { agentId: string }) {
      const r = await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", params.agentId);
      return r.length ? rowToAgent(r[0]) : null;
    },

    async listAgents(c, _p: Record<string, never>) {
      return (await c.db.execute("SELECT * FROM agents_v2 ORDER BY created_at, agent_id")).map(rowToAgent);
    },

    async getEvents(c, params: { since?: number }) {
      const rows = await c.db.execute("SELECT * FROM scope_events WHERE seq > ? ORDER BY seq", params.since ?? 0);
      return rows.map((r: any) => ({ seq: Number(r.seq), at: Number(r.at), type: r.type as string, agentId: (r.agent_id as string | null) ?? null, data: JSON.parse(r.data) }));
    },
  }),

  /**
   * What a working agent is doing now (harness.v1 Agent.activity), written by its runner at most once a second. Kept on
   * the agent row, not in the event log (it is not a state change), and only while the agent runs. Not traced: it would
   * add a span a second per agent to the run's trace.
   */
  async setActivity(c, params: { agentId: string; activity: StoredActivity | null }) {
    const a = params.activity;
    const v = a && (ACTIVITY_KINDS as readonly string[]).includes(a.kind) ? JSON.stringify({ kind: a.kind, n: Math.max(1, Math.min(9999, Math.floor(Number(a.n) || 1))), at: Number(a.at) || Date.now() }) : null;
    await c.db.execute("UPDATE agents_v2 SET activity = ? WHERE agent_id = ? AND status IN ('pending','running')", v, params.agentId);
    return { ok: true };
  },
  },
});
