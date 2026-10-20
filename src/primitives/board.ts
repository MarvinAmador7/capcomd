// ADR-016 step 3: shared-state rules, kept pure so they're unit-tested apart from the actor.
// Task board: a claim is a lease with a fencing epoch. Every claim bumps the epoch; renew,
// release and done must present the (holder, epoch) they were granted. A lease past its
// deadline can be taken by anyone (the epoch bump fences the old holder out); until someone
// takes it, the old holder may still renew or finish (the epoch still matches).
// Blackboard: versioned keys; cas compares the version (0 = must not exist).
export type TaskStatus = "open" | "claimed" | "done";
export interface BoardTask {
  taskId: string; title: string; data: unknown; status: TaskStatus;
  holder: string | null; epoch: number; leaseUntil: number; result: unknown;
  /** Dependencies: this task is blocked until every one of these is done. */
  after?: string[];
}
export const DEFAULT_LEASE_MS = 60_000;
export const MAX_LEASE_MS = 24 * 3600_000;

export function leaseMs(v: unknown): number {
  const n = v === undefined || v === null ? DEFAULT_LEASE_MS : Number(v);
  if (!Number.isFinite(n) || n < 100 || n > MAX_LEASE_MS) throw new Error(`lease must be 100ms..24h, got ${String(v)}`);
  return Math.round(n);
}

/** Can `holder` claim this task now? Expired claims are claimable (that's the takeover). */
export function claimable(t: BoardTask, now: number): { ok: true; takeover: { holder: string; epoch: number } | null } | { ok: false; why: string } {
  if (t.status === "done") return { ok: false, why: `task ${t.taskId} is done` };
  if (t.status === "open") return { ok: true, takeover: null };
  if (t.leaseUntil <= now) return { ok: true, takeover: { holder: t.holder ?? "?", epoch: t.epoch } };
  return { ok: false, why: `task ${t.taskId} is held by ${t.holder} (epoch ${t.epoch}) until ${new Date(t.leaseUntil).toISOString()}` };
}

/** Fencing for renew/release/done: the caller must hold the current epoch. */
export function fence(t: BoardTask, holder: string, epoch: number): { ok: true } | { ok: false; code: "lease_lost" | "not_claimed"; why: string } {
  if (t.status !== "claimed") return { ok: false, code: "not_claimed", why: `task ${t.taskId} is ${t.status}` };
  if (t.epoch !== epoch || t.holder !== holder) {
    return { ok: false, code: "lease_lost", why: `task ${t.taskId} lease lost: now held by ${t.holder} at epoch ${t.epoch} (you: ${holder} epoch ${epoch})` };
  }
  return { ok: true };
}

/** Deps not yet done (empty = ready). `done` is the set of done task ids. */
export function blockers(t: BoardTask, done: Set<string>): string[] {
  return (t.after ?? []).filter((d) => !done.has(d));
}

/**
 * Cycle check for a dependency graph (id -> after[]). Returns one cycle as a path
 * [a, b, …, a], or null. Used when adding a task so a cycle can never be created.
 */
export function findCycle(graph: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1); stack.push(id);
    for (const d of graph.get(id) ?? []) { const c = visit(d); if (c) return c; }
    stack.pop(); state.set(id, 2);
    return null;
  };
  for (const id of graph.keys()) { const c = visit(id); if (c) return c; }
  return null;
}

/** Order for "claim any": oldest open unblocked task first, then the longest-expired claim. */
export function pickNext(tasks: BoardTask[], now: number): BoardTask | null {
  const done = new Set(tasks.filter((t) => t.status === "done").map((t) => t.taskId));
  const ready = tasks.filter((t) => claimable(t, now).ok && blockers(t, done).length === 0);
  ready.sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1) || a.leaseUntil - b.leaseUntil);
  return ready[0] ?? null;
}

export const KV_KEY = /^[A-Za-z0-9._:/-]{1,200}$/;
export function checkKey(k: string): string {
  if (!KV_KEY.test(k)) throw new Error(`blackboard key must match ${KV_KEY} (got ${JSON.stringify(k)})`);
  return k;
}
/** cas: expect is the version you read (0 = key must not exist). */
export function casOk(current: number, expect: number): boolean { return current === expect; }

export const DEFAULT_KV_MAX_BYTES = 64 * 1024;
/** Size of a kv value as stored (UTF-8 JSON). */
export function valueBytes(v: unknown): number { return Buffer.byteLength(JSON.stringify(v ?? null), "utf8"); }
