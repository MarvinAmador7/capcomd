// ADR-016 primitives, step 1: one scope actor per run. It holds the agent tree, the
// idempotency keys and the primitive event log. Every spawn and cancel is a single
// transaction, so children limits and the budget carve can't be raced, and a crash
// either leaves the whole spawn or none of it.
import { actor, UserError } from "rivetkit";
import { db } from "rivetkit/db";
import { traceActions } from "../utils/tracing-simple";
import { killpoint } from "../utils/killpoint";
import { checkSpawn, TERMINAL_AGENT, type AgentRow, type AgentStatus, type Limits } from "../primitives/policy";
import type { AgentSpec } from "../agents/profiles";

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
    budgetUsd: Number(r.budget_usd),
    spentUsd: Number(r.spent_usd),
    result: r.result ? JSON.parse(r.result) : null,
    key: (r.idem_key as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    driver: (r.driver as string | null) ?? null,
    driverUntil: Number(r.driver_until ?? 0),
  };
}
export type ScopeAgent = ReturnType<typeof rowToAgent>;

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
        CREATE TABLE IF NOT EXISTS agents (
          agent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent TEXT, depth INTEGER NOT NULL,
          profile TEXT, ref TEXT, spec TEXT, limits TEXT NOT NULL, task TEXT NOT NULL, contract TEXT,
          status TEXT NOT NULL, budget_usd REAL NOT NULL, spent_usd REAL NOT NULL DEFAULT 0,
          result TEXT, idem_key TEXT UNIQUE, params_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, driver TEXT, driver_until INTEGER
        )`);
      await database.execute(`
        CREATE TABLE IF NOT EXISTS scope_events (
          seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, agent_id TEXT,
          data TEXT NOT NULL, idem_key TEXT NOT NULL UNIQUE
        )`);
    },
  }),

  actions: traceActions("scope", {
    async init(c, params: { runId: string; budgetUsd: number; label?: string; paramsHash: string }) {
      const have = await c.db.execute("SELECT v FROM scope_meta WHERE k = 'init'");
      if (have.length) {
        const prev = JSON.parse(have[0]!.v as string);
        if (prev.paramsHash !== params.paramsHash) fail("conflict", `run ${params.runId} already exists with different parameters (budget $${prev.budgetUsd})`);
        return { runId: params.runId, created: false, budgetUsd: prev.budgetUsd as number };
      }
      await c.db.transaction(async (tx) => {
        await tx.execute("INSERT OR IGNORE INTO scope_meta (k, v) VALUES ('init', ?)", JSON.stringify({ budgetUsd: params.budgetUsd, label: params.label ?? null, paramsHash: params.paramsHash, createdAt: Date.now() }));
        await addEvent(tx, "RUN_NEW", null, { budgetUsd: params.budgetUsd, label: params.label ?? null }, `run-new`);
      }, { name: "scopeInit" });
      return { runId: params.runId, created: true, budgetUsd: params.budgetUsd };
    },

    async getScope(c, _p: Record<string, never>) {
      const have = await c.db.execute("SELECT v FROM scope_meta WHERE k = 'init'");
      if (!have.length) return null;
      const meta = JSON.parse(have[0]!.v as string);
      const roots = (await c.db.execute("SELECT * FROM agents WHERE parent IS NULL")).map(rowToAgent);
      const spent = (await c.db.execute("SELECT COALESCE(SUM(spent_usd),0) AS s FROM agents"))[0]?.s ?? 0;
      const held = roots.reduce((a, r) => a + (TERMINAL_AGENT.has(r.status) ? r.spentUsd : r.budgetUsd), 0);
      return { budgetUsd: meta.budgetUsd as number, label: meta.label as string | null, createdAt: meta.createdAt as number, spentUsd: Number(spent), unallocatedUsd: Math.max(0, meta.budgetUsd - held) };
    },

    async spawn(
      c,
      params: {
        runId: string; agentId: string; key?: string; paramsHash: string; parent?: string | null;
        profile: string | null; ref: string | null; spec: Record<string, unknown> | null;
        task: string; contract?: Record<string, unknown> | null; budgetUsd?: number; operator?: boolean;
      }
    ) {
      const existing = await c.db.execute("SELECT * FROM agents WHERE agent_id = ?", params.agentId);
      if (existing.length) {
        const a = existing[0]!;
        if (a.params_hash !== params.paramsHash) fail("conflict", `--key already used for ${params.agentId} with different parameters`);
        return { created: false, agent: rowToAgent(a) };
      }
      const meta = await c.db.execute("SELECT v FROM scope_meta WHERE k = 'init'");
      if (!meta.length) fail("not_found", `run ${params.runId} not found (create it with capcomd run new)`);
      const runBudget = JSON.parse(meta[0]!.v as string).budgetUsd as number;

      let out: ScopeAgent | null = null;
      let created = false;
      await c.db.transaction(async (tx) => {
        const again = await tx.execute("SELECT * FROM agents WHERE agent_id = ?", params.agentId);
        if (again.length) {
          if (again[0]!.params_hash !== params.paramsHash) fail("conflict", `--key already used for ${params.agentId} with different parameters`);
          out = rowToAgent(again[0]); return;
        }
        const get = async (id: string) => { const r = await tx.execute("SELECT * FROM agents WHERE agent_id = ?", id); return r.length ? rowToAgent(r[0]) : null; };
        let parent: ScopeAgent | null = null;
        if (params.parent) {
          parent = await get(params.parent);
          if (!parent) fail("not_found", `parent agent ${params.parent} not found in ${params.runId}`);
        }
        const ancestors: ScopeAgent[] = [];
        for (let a = parent; a; a = a.parent ? await get(a.parent) : null) ancestors.push(a);
        const all = (await tx.execute("SELECT agent_id, parent FROM agents")) as any[];
        const kids = new Map<string, string[]>();
        for (const r of all) if (r.parent) kids.set(r.parent, [...(kids.get(r.parent) ?? []), r.agent_id]);
        const countDesc = (id: string): number => (kids.get(id) ?? []).reduce((n, k) => n + 1 + countDesc(k), 0);
        const siblings = (params.parent
          ? await tx.execute("SELECT * FROM agents WHERE parent = ?", params.parent)
          : await tx.execute("SELECT * FROM agents WHERE parent IS NULL")).map(rowToAgent);
        const d = checkSpawn({
          parent: parent as AgentRow | null, ancestors: ancestors as AgentRow[], descendantCounts: ancestors.map((a) => countDesc(a.agentId)),
          siblings: siblings as AgentRow[], childProfile: params.profile, childSpec: (params.spec as unknown as AgentSpec) ?? null,
          requestedBudgetUsd: params.budgetUsd, runBudgetUsd: runBudget, operator: params.operator,
        });
        if (!d.ok) fail(d.code, d.error);
        if (!d.ok) return;
        const now = Date.now();
        await tx.execute(
          `INSERT INTO agents (agent_id, run_id, parent, depth, profile, ref, spec, limits, task, contract, status, budget_usd, spent_usd, result, idem_key, params_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, ?, ?, ?, ?)`,
          params.agentId, params.runId, params.parent ?? null, d.depth, params.profile, params.ref,
          params.spec ? JSON.stringify(params.spec) : null, JSON.stringify(d.limits), params.task,
          params.contract ? JSON.stringify(params.contract) : null, d.budgetUsd, params.key ?? null, params.paramsHash, now, now
        );
        killpoint("scope.spawn.mid");
        await addEvent(tx, "AGENT_SPAWNED", params.agentId, {
          parent: params.parent ?? null, depth: d.depth, profile: params.profile, budgetUsd: d.budgetUsd, limits: d.limits,
          agent: params.spec, task: params.task.slice(0, 500), key: params.key ?? null, operator: !!params.operator,
        }, `spawn-${params.agentId}`);
        out = await get(params.agentId);
        created = true;
      }, { name: "scopeSpawn" });
      return { created, agent: out! as ScopeAgent };
    },

    /** Driver lease: one live driver per agent; a stale lease (crashed CLI) can be taken over. */
    async claimDriver(c, params: { agentId: string; driver: string; ttlMs: number }) {
      const r = await c.db.execute("SELECT * FROM agents WHERE agent_id = ?", params.agentId);
      if (!r.length) fail("not_found", `agent ${params.agentId} not found`);
      const a = rowToAgent(r[0]);
      if (TERMINAL_AGENT.has(a.status)) return { ok: false, agent: a };
      const now = Date.now();
      if (a.driver && a.driver !== params.driver && a.driverUntil > now) return { ok: false, agent: a };
      await c.db.transaction(async (tx) => {
        await tx.execute("UPDATE agents SET driver = ?, driver_until = ?, status = CASE WHEN status = 'pending' THEN 'running' ELSE status END, updated_at = ? WHERE agent_id = ? AND status NOT IN ('done','failed','cancelled')",
          params.driver, now + params.ttlMs, now, params.agentId);
        if (a.status === "pending") await addEvent(tx, "AGENT_STARTED", params.agentId, {}, `start-${params.agentId}`);
      }, { name: "scopeClaim" });
      return { ok: true, agent: rowToAgent((await c.db.execute("SELECT * FROM agents WHERE agent_id = ?", params.agentId))[0]) };
    },

    async finish(c, params: { agentId: string; status: "done" | "failed"; result: Record<string, unknown>; spentUsd?: number }) {
      const r = await c.db.execute("SELECT * FROM agents WHERE agent_id = ?", params.agentId);
      if (!r.length) fail("not_found", `agent ${params.agentId} not found`);
      const a = rowToAgent(r[0]);
      if (TERMINAL_AGENT.has(a.status)) return { changed: false, agent: a };
      await c.db.transaction(async (tx) => {
        await tx.execute("UPDATE agents SET status = ?, result = ?, spent_usd = ?, driver = NULL, driver_until = 0, updated_at = ? WHERE agent_id = ?",
          params.status, JSON.stringify(params.result), Math.min(a.budgetUsd, params.spentUsd ?? 0), Date.now(), params.agentId);
        await addEvent(tx, params.status === "done" ? "AGENT_DONE" : "AGENT_FAILED", params.agentId, { result: params.result, spentUsd: params.spentUsd ?? 0 }, `finish-${params.agentId}`);
      }, { name: "scopeFinish" });
      return { changed: true, agent: rowToAgent((await c.db.execute("SELECT * FROM agents WHERE agent_id = ?", params.agentId))[0]) };
    },

    /**
     * Cancel an agent and all its descendants (or the whole run when agentId is omitted).
     * Each agent is cancelled in its own transaction, in pre-order (target first, then its subtree),
     * so a crash mid-way leaves a prefix that the retried (idempotent) call completes.
     */
    async cancel(c, params: { agentId?: string; reason?: string }) {
      const all = (await c.db.execute("SELECT * FROM agents")).map(rowToAgent);
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
        await c.db.transaction(async (tx) => {
          await tx.execute("UPDATE agents SET status = 'cancelled', driver = NULL, driver_until = 0, updated_at = ? WHERE agent_id = ? AND status NOT IN ('done','failed','cancelled')", Date.now(), a.agentId);
          await addEvent(tx, "AGENT_CANCELLED", a.agentId, { reason: params.reason ?? null, by: params.agentId ?? "run" }, `cancel-${a.agentId}`);
        }, { name: "scopeCancel" });
        cancelled.push(a.agentId);
        if (++i === 1) killpoint("scope.cancel.mid");
      }
      return { cancelled, affected: order.map((a) => a.agentId) };
    },

    async getAgent(c, params: { agentId: string }) {
      const r = await c.db.execute("SELECT * FROM agents WHERE agent_id = ?", params.agentId);
      return r.length ? rowToAgent(r[0]) : null;
    },

    async listAgents(c, _p: Record<string, never>) {
      return (await c.db.execute("SELECT * FROM agents ORDER BY created_at, agent_id")).map(rowToAgent);
    },

    async getEvents(c, params: { since?: number }) {
      const rows = await c.db.execute("SELECT * FROM scope_events WHERE seq > ? ORDER BY seq", params.since ?? 0);
      return rows.map((r: any) => ({ seq: Number(r.seq), at: Number(r.at), type: r.type as string, agentId: (r.agent_id as string | null) ?? null, data: JSON.parse(r.data) }));
    },
  }),
});
