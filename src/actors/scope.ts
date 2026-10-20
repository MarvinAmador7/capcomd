// ADR-016 primitives, step 1: one scope actor per run. It holds the agent tree, the
// idempotency keys and the primitive event log. Every spawn and cancel is a single
// transaction, so children limits and the budget carve can't be raced, and a crash
// either leaves the whole spawn or none of it.
import type { RawAccess } from "rivetkit/db";
import { actor, UserError } from "rivetkit";
import { db } from "rivetkit/db";
import { traceActions } from "../utils/tracing-simple";
import { killpoint } from "../utils/killpoint";
import { checkSpawn, TERMINAL_AGENT, UNITS, type AgentRow, type AgentStatus, type Budget, type Limits } from "../primitives/policy";
import type { AgentSpec } from "../agents/profiles";
import { casOk, claimable, fence, pickNext, type BoardTask } from "../primitives/board";

function rowToTask(r: any): BoardTask & { key: string | null; createdAt: number; updatedAt: number } {
  return {
    taskId: r.task_id as string, title: r.title as string, data: r.data ? JSON.parse(r.data) : null, status: r.status,
    holder: (r.holder as string | null) ?? null, epoch: Number(r.epoch), leaseUntil: Number(r.lease_until ?? 0),
    result: r.result ? JSON.parse(r.result) : null, key: (r.idem_key as string | null) ?? null,
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}
export type ScopeTask = ReturnType<typeof rowToTask>;
const kvRow = (r: any) => ({ k: r.k as string, value: JSON.parse(r.v), version: Number(r.version), writer: (r.writer as string | null) ?? null, updatedAt: Number(r.updated_at) });
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

async function addEvent(tx: any, type: string, agentId: string | null, data: Record<string, unknown>, idemKey: string) {
  const dup = await tx.execute("SELECT seq FROM scope_events WHERE idem_key = ?", idemKey);
  if (dup.length) return;
  const last = await tx.execute("SELECT COALESCE(MAX(seq), 0) AS s FROM scope_events");
  const seq = Number(last[0]?.s ?? 0) + 1;
  await tx.execute(
    "INSERT INTO scope_events (seq, at, type, agent_id, data, idem_key) VALUES (?, ?, ?, ?, ?, ?)",
    seq, Date.now(), type, agentId, JSON.stringify(data), idemKey
  );
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
      await database.execute(`CREATE TABLE IF NOT EXISTS idem (idem_key TEXT PRIMARY KEY, kind TEXT NOT NULL, params_hash TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL)`);
      await database.execute(`
        CREATE TABLE IF NOT EXISTS scope_events (
          seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, agent_id TEXT,
          data TEXT NOT NULL, idem_key TEXT NOT NULL UNIQUE
        )`);
    },
  }),

  actions: traceActions("scope", {
    async init(c, params: { runId: string; budget: Budget; label?: string; paramsHash: string }) {
      const have = await c.db.execute("SELECT v FROM scope_meta WHERE k = 'init'");
      if (have.length) {
        const prev = JSON.parse(have[0]!.v as string);
        if (prev.paramsHash !== params.paramsHash) fail("conflict", `run ${params.runId} already exists with different parameters (budget ${JSON.stringify(prev.budget)})`);
        return { runId: params.runId, created: false, budget: prev.budget as Budget };
      }
      await c.db.transaction(async (tx: RawAccess) => {
        await tx.execute("INSERT OR IGNORE INTO scope_meta (k, v) VALUES ('init', ?)", JSON.stringify({ budget: params.budget, label: params.label ?? null, paramsHash: params.paramsHash, createdAt: Date.now() }));
        await addEvent(tx, "RUN_NEW", null, { budget: params.budget, label: params.label ?? null }, `run-new`);
      }, { name: "scopeInit" });
      return { runId: params.runId, created: true, budget: params.budget };
    },

    async getScope(c, _p: Record<string, never>) {
      const have = await c.db.execute("SELECT v FROM scope_meta WHERE k = 'init'");
      if (!have.length) return null;
      const meta = JSON.parse(have[0]!.v as string);
      const all: ScopeAgent[] = (await c.db.execute("SELECT * FROM agents_v2")).map(rowToAgent);
      const roots = all.filter((a) => !a.parent);
      const spent: Budget = {}, unallocated: Budget = {};
      for (const u of UNITS) {
        const sp = all.reduce((x, a) => x + (a.spent[u] ?? 0), 0);
        if (sp) spent[u] = Math.round(sp * 1e6) / 1e6;
        if (meta.budget[u] === undefined) continue;
        const held = roots.reduce((x, r) => x + ((TERMINAL_AGENT.has(r.status) ? r.spent[u] : r.budget[u] ?? r.spent[u]) ?? 0), 0);
        unallocated[u] = Math.max(0, Math.round((meta.budget[u] - held) * 1e6) / 1e6);
      }
      return { budget: meta.budget as Budget, label: meta.label as string | null, createdAt: meta.createdAt as number, spent, unallocated };
    },

    async spawn(
      c,
      params: {
        runId: string; agentId: string; key?: string; paramsHash: string; parent?: string | null;
        profile: string | null; ref: string | null; spec: Record<string, unknown> | null;
        task: string; contract?: Record<string, unknown> | null; budget?: Budget; operator?: boolean;
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
        const all = (await tx.execute("SELECT agent_id, parent FROM agents_v2")) as any[];
        const kids = new Map<string, string[]>();
        for (const r of all) if (r.parent) kids.set(r.parent, [...(kids.get(r.parent) ?? []), r.agent_id]);
        const countDesc = (id: string): number => (kids.get(id) ?? []).reduce((n, k) => n + 1 + countDesc(k), 0);
        const siblings = (params.parent
          ? await tx.execute("SELECT * FROM agents_v2 WHERE parent = ?", params.parent)
          : await tx.execute("SELECT * FROM agents_v2 WHERE parent IS NULL")).map(rowToAgent);
        const d = checkSpawn({
          parent: parent as AgentRow | null, ancestors: ancestors as AgentRow[], descendantCounts: ancestors.map((a) => countDesc(a.agentId)),
          siblings: siblings as AgentRow[], childProfile: params.profile, childSpec: (params.spec as unknown as AgentSpec) ?? null,
          requested: params.budget, runBudget, operator: params.operator,
        });
        if (!d.ok) fail(d.code, d.error);
        if (!d.ok) return;
        const now = Date.now();
        await tx.execute(
          `INSERT INTO agents_v2 (agent_id, run_id, parent, depth, profile, ref, spec, limits, task, contract, status, budget, spent, result, idem_key, params_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '{}', NULL, ?, ?, ?, ?)`,
          params.agentId, params.runId, params.parent ?? null, d.depth, params.profile, params.ref,
          params.spec ? JSON.stringify(params.spec) : null, JSON.stringify(d.limits), params.task,
          params.contract ? JSON.stringify(params.contract) : null, JSON.stringify(d.budget), params.key ?? null, params.paramsHash, now, now
        );
        killpoint("scope.spawn.mid");
        await addEvent(tx, "AGENT_SPAWNED", params.agentId, {
          parent: params.parent ?? null, depth: d.depth, profile: params.profile, budget: d.budget, limits: d.limits,
          agent: params.spec, task: params.task.slice(0, 500), key: params.key ?? null, operator: !!params.operator,
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
      if (TERMINAL_AGENT.has(a.status)) return { ok: false, agent: a };
      const now = Date.now();
      if (a.driver && a.driver !== params.driver && a.driverUntil > now) return { ok: false, agent: a };
      await c.db.transaction(async (tx: RawAccess) => {
        await tx.execute("UPDATE agents_v2 SET driver = ?, driver_until = ?, status = CASE WHEN status = 'pending' THEN 'running' ELSE status END, updated_at = ? WHERE agent_id = ? AND status NOT IN ('done','failed','cancelled')",
          params.driver, now + params.ttlMs, now, params.agentId);
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
        await tx.execute("UPDATE agents_v2 SET status = ?, result = ?, spent = ?, driver = NULL, driver_until = 0, updated_at = ? WHERE agent_id = ?",
          params.status, JSON.stringify(params.result), JSON.stringify(params.spent ?? {}), Date.now(), params.agentId);
        await addEvent(tx, params.status === "done" ? "AGENT_DONE" : "AGENT_FAILED", params.agentId, { result: params.result, spent: params.spent ?? {}, budget: a.budget }, `finish-${params.agentId}`);
      }, { name: "scopeFinish" });
      return { changed: true, agent: rowToAgent((await c.db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", params.agentId))[0]) };
    },

    /**
     * Cancel an agent and all its descendants (or the whole run when agentId is omitted).
     * Each agent is cancelled in its own transaction, in pre-order (target first, then its subtree),
     * so a crash mid-way leaves a prefix that the retried (idempotent) call completes.
     */
    async cancel(c, params: { agentId?: string; reason?: string }) {
      const all: ScopeAgent[] = (await c.db.execute("SELECT * FROM agents_v2")).map(rowToAgent);
      const kids = new Map<string | null, ScopeAgent[]>();
      for (const a of all) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
      let targets: ScopeAgent[];
      if (params.agentId) {
        const t = all.find((a) => a.agentId === params.agentId);
        if (!t) fail("not_found", `agent ${params.agentId} not found`);
        targets = [t!];
      } else targets = kids.get(null) ?? [];
      const order: ScopeAgent[] = [];
      const walk = (a: ScopeAgent) => { order.push(a); for (const k of kids.get(a.agentId) ?? []) walk(k); };
      targets.forEach(walk);
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

    // ---- ADR-016 step 3: task board with leases ----
    async taskAdd(c, params: { taskId: string; title: string; data?: unknown; key?: string; paramsHash: string }) {
      const get = async (db: any) => { const r = await db.execute("SELECT * FROM board_tasks WHERE task_id = ?", params.taskId); return r.length ? rowToTask(r[0]) : null; };
      let created = false;
      await c.db.transaction(async (tx: RawAccess) => {
        const have = await tx.execute("SELECT params_hash FROM board_tasks WHERE task_id = ?", params.taskId);
        if (have.length) { if (have[0]!.params_hash !== params.paramsHash) fail("conflict", `task ${params.taskId} already exists with different parameters`); return; }
        const now = Date.now();
        await tx.execute("INSERT INTO board_tasks (task_id, title, data, status, holder, epoch, lease_until, result, idem_key, params_hash, created_at, updated_at) VALUES (?, ?, ?, 'open', NULL, 0, 0, NULL, ?, ?, ?, ?)",
          params.taskId, params.title, params.data === undefined ? null : JSON.stringify(params.data), params.key ?? null, params.paramsHash, now, now);
        await addEvent(tx, "TASK_ADDED", null, { taskId: params.taskId, title: params.title }, `task-add-${params.taskId}`);
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
        } else {
          t = pickNext((await tx.execute("SELECT * FROM board_tasks WHERE status != 'done' ORDER BY created_at, task_id")).map(rowToTask), now);
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
      return rows.map(rowToTask).map((t: ScopeTask) => ({ ...t, expired: t.status === "claimed" && t.leaseUntil <= now }));
    },

    // ---- ADR-016 step 3: blackboard (versioned kv) ----
    async kvWrite(c, params: { k: string; value: unknown; expect?: number; writer?: string; key?: string; paramsHash: string }) {
      let out: Record<string, unknown> = {};
      await c.db.transaction(async (tx: RawAccess) => {
        const prev = await replay(tx, params.key, params.paramsHash);
        if (prev) { out = prev; return; }
        const r = await tx.execute("SELECT version FROM kv WHERE k = ?", params.k);
        const cur = r.length ? Number(r[0]!.version) : 0;
        if (params.expect !== undefined && !casOk(cur, params.expect)) fail("cas_mismatch", `cas ${params.k}: version is ${cur}, expected ${params.expect}`);
        const version = cur + 1, now = Date.now();
        await tx.execute("INSERT INTO kv (k, v, version, writer, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, version = excluded.version, writer = excluded.writer, updated_at = excluded.updated_at",
          params.k, JSON.stringify(params.value ?? null), version, params.writer ?? null, now);
        killpoint("kv.cas.mid");
        await addEvent(tx, params.expect === undefined ? "KV_PUT" : "KV_CAS", null, { k: params.k, version, ...(params.writer ? { writer: params.writer } : {}) }, `kv-${params.k}-${version}`);
        out = { k: params.k, version, ok: true };
        await remember(tx, params.key, "kv", params.paramsHash, out);
      }, { name: "scopeKvWrite" });
      killpoint("kv.cas.after.before_reply");
      return out;
    },

    async kvGet(c, params: { k: string }) {
      const r = await c.db.execute("SELECT * FROM kv WHERE k = ?", params.k);
      return r.length ? kvRow(r[0]) : null;
    },

    async kvList(c, params: { prefix?: string }) {
      const p = params.prefix ?? "";
      const rows = await c.db.execute("SELECT * FROM kv WHERE substr(k, 1, ?) = ? ORDER BY k", p.length, p);
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
});
