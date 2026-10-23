// The primitives for a "driver": the user's own agent orchestrating through `capcomd mcp` (ADR-018 §3, §4).
// A driver runs the swarm (runs, spawns, waits, verifies, merges, the board and kv) but the gates stay the
// human's: checks, the reviewer and protected branches come from the project's config, approvals for protected
// branches are a person's by default, and nothing widens a profile. Agents' text reaches the driver fenced.
import { RelayError } from "../core/errors";
import { client } from "../core/relay";
import * as O from "../primitives/ops";
import * as S from "../primitives/state";
import { parseBudget, TERMINAL_AGENT, type Budget } from "../primitives/policy";
import { fence } from "../subagents/results";

/** The driver's name in records it writes (kv writer, task holder, message sender, approver). */
export const DRIVER = "driver";
/** kv keys the orchestrator owns: a driver reads them, never writes them (same list as in-VM agents). */
const RESERVED_KV = ["_", "approval/", "recipe/", "handoff/"];
/** Waits return before a client's tool timeout (Codex defaults to 60s); the caller asks again. */
export const WAIT_DEFAULT_MS = 25_000;
export const WAIT_MAX_MS = 55_000;

const deny = (message: string, hint: string): never => { throw new RelayError("usage", message, hint, { code: "forbidden" }); };
const waitMs = (v: unknown) => Math.min(Math.max(Number(v ?? WAIT_DEFAULT_MS) || WAIT_DEFAULT_MS, 1000), WAIT_MAX_MS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An agent's record for the driver: text the agent wrote is fenced (data, never instructions). */
export function agentView(a: any) {
  const v: any = { ...a };
  if (v.result) {
    const r = { ...v.result };
    for (const k of ["summary", "error", "claim"]) if (typeof r[k] === "string") r[k] = fence(v.agentId, r[k]);
    v.result = r;
  }
  // A failing notice quotes the agent's own error output.
  if (v.notice) { v.notice = { ...v.notice, detail: fence(v.agentId, String(v.notice.detail)) }; v.stuck = v.notice.detail; }
  return v;
}

async function policy() {
  return (await import("../config/store")).driverPolicy();
}

// ── runs ──────────────────────────────────────────────────────────────────────────────────────────

export async function runNew(a: { budget?: string; label?: string; key?: string; target?: string; targetFrom?: string }) {
  let budget: Budget;
  try { budget = parseBudget(a.budget ?? ""); } catch (e) { throw new RelayError("usage", `budget: ${(e as Error).message}`, "Pass units, e.g. budget: \"usd=5,turns=200,wallSeconds=3600\"."); }
  const p = await policy();
  if (p.maxRunBudget) {
    const cap = parseBudget(p.maxRunBudget) as Record<string, number>;
    const over = Object.entries(cap).filter(([u, max]) => (budget as Record<string, number>)[u] === undefined || (budget as Record<string, number>)[u]! > max);
    if (over.length) deny(`budget ${a.budget ?? "(none)"} is over this project's cap per run (${p.maxRunBudget})`, `Ask for at most ${p.maxRunBudget} (every capped unit must be given); the cap is driver.maxRunBudget in .capcomd/config.json.`);
  }
  // Gates come from the project (`capcomd setup`), never from the driver.
  const d = process.env.CAPCOMD_NO_CONFIG ? {} : (await import("../config/store")).runDefaults();
  if (a.target !== undefined) {
    const { isProtectedBranch } = await import("../utils/protected");
    if (isProtectedBranch(a.target) && a.target !== d.target) deny(`target ${a.target} is a protected branch`, "Leave target unset (the project's target applies), or name a staging branch, e.g. capcomd/<topic>, with targetFrom: \"main\".");
  }
  const target = a.target ?? d.target;
  const r = await O.runNew({ budget, label: a.label, key: a.key, checks: d.checks ?? {}, ...(d.reviewer ? { reviewer: d.reviewer } : {}), ...(target ? { target } : {}), ...(a.targetFrom ? { targetFrom: a.targetFrom } : {}) });
  return { ...r, gates: { checks: Object.keys(d.checks ?? {}), reviewer: d.reviewer ?? null, target: target ?? null }, next: "Spawn agents with capcomd_spawn; give each a check name from gates.checks." };
}

export async function runs(a: { limit?: number }) {
  const rows = O.recentRuns(Math.min(Number(a.limit ?? 10), 50));
  const c = client();
  const out = [];
  for (const r of rows) {
    const agents = await c.scope.getOrCreate([r.runId]).listAgents({}).catch(() => null);
    const counts: Record<string, number> = {};
    for (const x of agents ?? []) counts[x.status] = (counts[x.status] ?? 0) + 1;
    out.push({ ...r, agents: counts, pendingApprovals: (await O.pendingMerges(r.runId)).map((m) => m.taskId) });
  }
  return { runs: out };
}

export async function tree(a: { runId: string; root?: string }) {
  const t: any = await O.treeOf(a.runId, a.root);
  return { ...t, pendingApprovals: await O.pendingMerges(a.runId) };
}

export async function inspect(a: { runId: string; agent: string; tail?: number }) {
  const r: any = await O.inspectAgent(a.runId, a.agent, { logTail: Math.min(Number(a.tail ?? 50), 500) });
  return { ...r, result: agentView({ agentId: a.agent, result: r.result }).result, logs: (r.logs ?? []).map((l: any) => ({ ...l, line: fence(a.agent, l.line).text })) };
}

// ── agents ────────────────────────────────────────────────────────────────────────────────────────

export async function spawn(a: { runId: string; task: string; profile?: string; key?: string; budget?: string; check?: string; report?: boolean; children?: Record<string, unknown> }) {
  let budget: Budget | undefined;
  try { budget = a.budget ? parseBudget(a.budget) : undefined; } catch (e) { throw new RelayError("usage", `budget: ${(e as Error).message}`, "Units: usd, turns, wallSeconds, e.g. \"usd=1,turns=40\"."); }
  // No `operator`: a driver's spawn may only narrow the profile, like any parent.
  const r = await O.spawnAgent({ runId: a.runId, task: a.task, profile: a.profile, key: a.key, ...(budget ? { budget } : {}), ...(a.check ? { check: a.check } : {}), ...(a.report ? { report: true } : {}), ...(a.children ? { grant: a.children as any } : {}) });
  return { ...agentView(r), next: `Wait with capcomd_await {runId: "${a.runId}", agents: ["${r.agentId}"]}.` };
}

/**
 * Bounded wait: returns when all (or any) are done, when one of them looks stuck (ADR-019 §2: a notice raised while
 * waiting), or after timeoutMs with what's still pending.
 */
export async function awaitAgents(a: { runId: string; agents: string[]; mode?: "all" | "any"; timeoutMs?: number }) {
  if (!a.agents?.length) throw new RelayError("usage", "agents required", "Pass the agent ids capcomd_spawn returned.");
  const r: any = await O.awaitAgents(a.runId, a.agents, { timeoutMs: waitMs(a.timeoutMs), any: a.mode === "any", notices: true });
  const rows: any[] = r.agents ?? [];
  const pending = rows.filter((x) => !TERMINAL_AGENT.has(x.status)).map((x) => x.agentId);
  const done = rows.filter((x) => !pending.includes(x.agentId)).map(agentView);
  const notices = ((r.notices ?? []) as Array<{ agentId: string; kind: string; detail: string }>).map((n) => ({ ...n, detail: fence(n.agentId, n.detail) }));
  return {
    done, pending, ...(r.first ? { first: agentView(r.first) } : {}), ...(notices.length ? { notices } : {}),
    next: notices.length
      ? `${notices.map((n) => `${n.agentId} looks ${n.kind}: ${n.detail}`).join("; ")}. It keeps running (it is stopped, work kept, only if its profile sets a stuck window). Look with capcomd_inspect, cancel it with capcomd_cancel, or call capcomd_await again.`
      : pending.length && !(a.mode === "any" && done.length) ? `Still running; call capcomd_await again for ${pending.join(", ")} (the agents keep working between calls).` : "Verify finished work with capcomd_verify.",
  };
}

export async function send(a: { runId: string; to: string; body: string; key?: string }) {
  const r = await client().scope.getOrCreate([a.runId]).sendMessage({ to: a.to, from: DRIVER, body: a.body, ...(a.key ? { key: `${DRIVER}:${a.key}` } : {}) });
  return { runId: a.runId, to: a.to, ...r };
}

export async function cancel(a: { runId: string; agent?: string; reason?: string }) {
  return O.cancelAgents(a.runId, a.agent, a.reason);
}

export async function resume(a: { runId: string; agent?: string }) {
  return O.resumeAgents(a.runId, a.agent);
}

export async function grant(a: { runId: string; agent?: string; budget: string; key?: string }) {
  let add: Budget;
  try { add = parseBudget(a.budget); } catch (e) { throw new RelayError("usage", `budget: ${(e as Error).message}`, "Units: usd, turns, wallSeconds, e.g. \"usd=1,turns=20\"."); }
  if (!a.agent) {
    // A driver raises the run's budget only within the project's cap per run, like run_new.
    const p = await policy();
    if (p.maxRunBudget) {
      const cap = parseBudget(p.maxRunBudget) as Record<string, number>;
      const cur = ((await O.budgetShow(a.runId)).budget ?? {}) as Record<string, number>;
      const over = Object.entries(add).filter(([u, n]) => cap[u] !== undefined && (cur[u] ?? 0) + n > cap[u]!);
      if (over.length) deny(`raising the run's budget by ${a.budget} goes over this project's cap per run (${p.maxRunBudget})`, "Ask the user to raise driver.maxRunBudget in .capcomd/config.json, or to run `capcomd grant <runId> --budget …` themselves.");
    }
  }
  return O.grantBudget(a.runId, { ...(a.agent ? { agentId: a.agent } : {}), add, by: DRIVER, ...(a.key ? { key: `${DRIVER}:${a.key}` } : {}) });
}

// ── gates ─────────────────────────────────────────────────────────────────────────────────────────

/** Race a long operation against the wait; on timeout it keeps running here, and the same call picks it up. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  const timer = sleep(ms).then(() => ({ done: false as const }));
  return Promise.race([work.then((value) => ({ done: true as const, value })), timer]);
}

export async function verify(a: { runId: string; ref: string; check?: string; acceptance?: unknown; key?: string; timeoutMs?: number }) {
  // Checks are named by the operator, the reviewer is the run's: a driver picks a check, never writes one.
  const id = O.verifyIdFor(a.runId, a.ref, a.key);
  const work = O.verifyRef({ runId: a.runId, ref: a.ref, ...(a.check ? { check: a.check } : {}), ...(a.acceptance !== undefined ? { acceptance: a.acceptance } : {}), ...(a.key ? { key: a.key } : {}) });
  work.catch(() => {}); // a timed-out call leaves it running; its error reaches the next call
  const r = await bounded(work, waitMs(a.timeoutMs));
  if (!r.done) return { id, state: "running", next: `The checks (then the review, if the run has a reviewer) are still running; call capcomd_verify again with the same ref${a.key ? " and key" : ""}.` };
  const v: any = r.value;
  return { ...v, next: v.state === "passed" ? `Merge with capcomd_merge {runId: "${a.runId}", ref: "${a.ref}", require: "${v.id}"}.` : "Not merged: send the failure to the agent (capcomd_send) or spawn a fix with it in the task." };
}

export async function merge(a: { runId: string; ref: string; require: string; key?: string; timeoutMs?: number }) {
  if (!a.require) throw new RelayError("usage", "require is needed: the id of a passing capcomd_verify of this ref", "Call capcomd_verify first.");
  const work = O.mergeRef({ runId: a.runId, ref: a.ref, require: a.require, ...(a.key ? { key: a.key } : {}), requestApproval: true });
  work.catch(() => {});
  const r = await bounded(work, waitMs(a.timeoutMs));
  if (!r.done) return { state: "running", next: "The merge re-runs the checks on the latest target; call capcomd_merge again with the same arguments." };
  const m: any = r.value;
  if (m.state === "awaiting_approval") return { ...m, next: `${m.target ?? "The target"} is protected: a person approves with \`capcomd approve ${a.runId} ${m.id}\` (or in the TUI). Tell the user; check later with capcomd_tree.` };
  return m;
}

export async function approve(a: { runId: string; merge: string; deny?: boolean; reason?: string }) {
  const p = await policy();
  if ((p.approvals ?? "human") !== "client-confirmed") {
    deny("approving merges into protected branches is left to a person in this project", `Ask the user to run \`capcomd approve ${a.runId} ${a.merge}\`${a.deny ? " --deny" : ""} (or approve in the TUI). A project can allow agents to approve with driver.approvals: "client-confirmed" in .capcomd/config.json.`);
  }
  return O.decideMerge(a.runId, a.merge, { approve: !a.deny, by: DRIVER, ...(a.reason ? { reason: a.reason } : {}) });
}

// ── shared state ──────────────────────────────────────────────────────────────────────────────────

export async function task(a: { runId: string; action: string; title?: string; task?: string; epoch?: number; leaseMs?: number; after?: string[]; data?: unknown; result?: unknown; status?: string; key?: string }) {
  const key = a.key ? `${DRIVER}:${a.key}` : undefined;
  switch (a.action) {
    case "add": return S.taskAdd(a.runId, { title: String(a.title ?? ""), data: a.data, after: a.after, key });
    case "list": return { tasks: (await S.taskList(a.runId, a.status)).tasks };
    case "show": return S.taskGet(a.runId, String(a.task));
    case "claim": return S.taskClaim(a.runId, { holder: DRIVER, taskId: a.task, leaseMs: a.leaseMs, key });
    case "renew": return S.taskRenew(a.runId, { taskId: String(a.task), holder: DRIVER, epoch: Number(a.epoch), leaseMs: a.leaseMs });
    case "release": return S.taskFinish(a.runId, { taskId: String(a.task), holder: DRIVER, epoch: Number(a.epoch), outcome: "released", key });
    case "done": return S.taskFinish(a.runId, { taskId: String(a.task), holder: DRIVER, epoch: Number(a.epoch), outcome: "done", result: a.result, key });
  }
  throw new RelayError("usage", `task action ${a.action}?`, "add|list|show|claim|renew|release|done");
}

export async function kv(a: { runId: string; action: string; k?: string; value?: unknown; expect?: number; prefix?: string; key?: string }) {
  const k = String(a.k ?? "");
  if (a.action !== "get" && a.action !== "list" && RESERVED_KV.some((p) => k.startsWith(p))) deny(`kv key "${k}" is reserved for the orchestrator`, `Don't write keys starting with ${RESERVED_KV.join(", ")}.`);
  const tag = (v: any) => (v && v.writer && v.writer !== DRIVER ? { ...v, untrusted: true } : v);
  const key = a.key ? `${DRIVER}:${a.key}` : undefined;
  switch (a.action) {
    case "get": return tag(await S.kvGet(a.runId, k));
    case "list": return { items: ((await S.kvList(a.runId, a.prefix)).entries as any[]).map(tag) };
    case "put": return S.kvWrite(a.runId, { k, value: a.value, writer: DRIVER, key });
    case "cas": return S.kvWrite(a.runId, { k, value: a.value, expect: Number(a.expect), writer: DRIVER, key });
    case "del": return S.kvWrite(a.runId, { k, value: null, del: true, writer: DRIVER, ...(a.expect !== undefined ? { expect: Number(a.expect) } : {}) });
  }
  throw new RelayError("usage", `kv action ${a.action}?`, "get|put|cas|del|list");
}

export async function budget(a: { runId: string; agent?: string }) {
  return O.budgetShow(a.runId, a.agent);
}

// ── discover ──────────────────────────────────────────────────────────────────────────────────────

export async function setup() {
  const { checkSetup } = await import("../cli/commands/setup");
  const steps = await checkSetup();
  const d = process.env.CAPCOMD_NO_CONFIG ? {} : (await import("../config/store")).runDefaults();
  const p = await policy();
  return {
    ready: steps.every((s) => s.ok), steps,
    gates: { checks: d.checks ?? {}, reviewer: d.reviewer ?? null, target: d.target ?? null },
    driver: { approvals: p.approvals ?? "human", maxRunBudget: p.maxRunBudget ?? null },
    next: steps.every((s) => s.ok) ? "Start with capcomd_run_new." : "Ask the user to run `capcomd setup` in this repository (or `capcomd setup --yes` for the defaults).",
  };
}

export async function profiles() {
  const { agentsFilePath, readAgentsFile } = await import("../agents/profiles");
  const { readiness } = await import("../cli/commands/agents");
  const f = readAgentsFile(agentsFilePath());
  return { default: f.default ?? null, profiles: Object.entries(f.agents).map(([name, s]) => ({ name, provider: s.provider, auth: s.auth, model: s.model ?? null, canSpawn: !!(s as any).children?.allowSpawn, ...readiness(name, s) })) };
}
