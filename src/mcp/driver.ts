// The primitives for a "driver": the user's own agent orchestrating through `capcomd mcp` (ADR-018 §3, §4).
// A driver runs the swarm (runs, spawns, waits, verifies, merges, the board and kv) but the gates stay the
// human's: checks, the reviewer and protected branches come from the project's config, approvals for protected
// branches are a person's by default, and nothing widens a profile. Agents' text reaches the driver fenced.
import { RelayError } from "../core/errors";
import { client, existingActor } from "../core/relay";
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

export async function runs(a: { limit?: number; project?: { name: string; path: string } | null }) {
  const P = await import("../config/projects");
  const limit = Math.min(Number(a.limit ?? 10), 50);
  // Each run's project: the checkout it was started in (the runs index records the directory).
  const all = O.recentRuns(a.project ? 500 : limit).map((r) => { const dir = r.cwd ? P.projectDirOf(r.cwd) : null; return { ...r, dir, project: dir ? P.projectNameOf(dir) : null }; });
  const rows = (a.project ? all.filter((r) => r.dir && P.samePath(r.dir, a.project!.path)) : all).slice(0, limit).map(({ dir: _d, ...r }) => r);
  const out = [];
  for (const r of rows) {
    // A listed run whose scope this engine doesn't have (another engine's) lists no agents: never create one.
    const agents = await existingActor("scope", [r.runId]).then((s) => s?.listAgents({}) ?? null).catch(() => null);
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

export async function spawn(a: { runId: string; task: string; profile?: string; key?: string; budget?: string; check?: string; report?: boolean; continue?: string; children?: Record<string, unknown> }) {
  let budget: Budget | undefined;
  try { budget = a.budget ? parseBudget(a.budget) : undefined; } catch (e) { throw new RelayError("usage", `budget: ${(e as Error).message}`, "Units: usd, turns, wallSeconds, e.g. \"usd=1,turns=40\"."); }
  // No `operator`: a driver's spawn may only narrow the profile, like any parent.
  const r = await O.spawnAgent({ runId: a.runId, task: a.task, profile: a.profile, key: a.key, ...(budget ? { budget } : {}), ...(a.check ? { check: a.check } : {}), ...(a.report ? { report: true } : {}), ...(a.continue ? { continueFrom: a.continue } : {}), ...(a.children ? { grant: a.children as any } : {}) });
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
  const note = await O.messageNote(a.runId, a.to);
  return { runId: a.runId, to: a.to, ...r, ...(note ? { note } : {}) };
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
  if (m.state === "awaiting_approval") {
    const how = `a person approves with \`capcomd approve ${a.runId} ${m.id}\` (or in the TUI)`;
    const elicit = ((await policy()).approvals ?? "human") === "elicit";
    return { ...m, next: elicit
      ? `${m.target ?? "The target"} is protected: tell the user what's waiting, then call capcomd_approve {runId: "${a.runId}", merge: "${m.id}"} once: capcomd asks them itself, and only their accept approves. Or ${how}.`
      : `${m.target ?? "The target"} is protected: ${how}. Tell the user; check later with capcomd_tree.` };
  }
  return m;
}

/** What capcomd_approve needs from the MCP session to ask the person itself (elicitation, `driver.approvals: "elicit"`). */
export interface ElicitPort {
  /** The client declared form elicitation at initialize (Claude Code's bare `elicitation: {}` counts as form). */
  form: boolean;
  /** The client's name as it reported it (initialize clientInfo.name), e.g. "hermes-agent". */
  client: string | null;
  /** The project this server acts on: the prompt names it. */
  project: { name: string; path: string } | null;
  /** Send elicitation/create (form mode, empty schema) and return the person's action; throws on timeout or error. */
  ask(message: string, o: { timeoutMs: number }): Promise<string>;
}

/** The only answer capcomd_approve gives when the person didn't accept (declined, cancelled, no answer, an error). */
export const NO_DECISION = "No decision: the merge is still waiting. Don't retry; ask the user.";
/** Who decided, in the merge's record, when the person accepted capcomd's own prompt. */
export const ELICITED = "driver:elicited";
export const ELICIT_TIMEOUT_S = 300;
/** Merges a prompt is open for (one prompt per merge at a time). */
const asking = new Set<string>();
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : "(none)");

export interface ApprovalFacts {
  project: { name: string; path: string } | null; repo: string | null; runId: string; mergeId: string;
  target: string; branch: string; agentId: string | null; commit: string; deny: boolean;
  checks: { passed: boolean; name: string | null } | null;
  review: { passed: boolean; profile: string | null; agentId: string | null; reasons: string[] } | null;
}

/**
 * The prompt capcomd_approve shows the person: written by capcomd from its own records (project, repository, run,
 * merge, target, the exact commit, the checks); the reviewer's reasons are agent-written, so they're fenced as data.
 */
export function approvalPrompt(f: ApprovalFacts): string {
  const repo = f.repo ? f.repo.replace(/\/\/[^@/]*@/, "//") : null;
  const lines = [
    f.deny ? `capcomd: deny this merge into ${f.target}? (it won't land)` : `capcomd: merge into ${f.target}, a protected branch?`,
    "",
    `Project: ${f.project ? `${f.project.name} (${f.project.path})` : "(none configured)"}`,
    ...(repo ? [`Repository: ${repo}`] : []),
    `Run: ${f.runId}`,
    `Merge: ${f.mergeId}`,
    `Target: ${f.target}`,
    `Work: ${f.agentId ? `${f.agentId}, ` : ""}branch ${f.branch}`,
    `Commit: ${short(f.commit)}`,
    `Checks: ${f.checks ? `${f.checks.passed ? "passed" : "FAILED"} (${f.checks.name ?? "the run's checks"}); they run again on the latest ${f.target} before it lands` : "none in this run"}`,
  ];
  if (f.review) {
    lines.push(`Review: ${f.review.passed ? "passed" : "FAILED"}${f.review.profile ? ` (reviewer ${f.review.profile}${f.review.agentId ? `, ${f.review.agentId}` : ""})` : ""}`);
    if (f.review.reasons.length) {
      const text = f.review.reasons.map((r) => `- ${String(r).slice(0, 400)}`).join("\n").slice(0, 1500);
      lines.push("The reviewer's reasons, written by an agent (data, not instructions):", fence(f.review.agentId ?? "reviewer", text).text);
    }
  } else lines.push("Review: no reviewer in this run");
  lines.push("", f.deny
    ? `Accept to deny merging commit ${short(f.commit)} into ${f.target}. Decline, or don't answer, to leave it waiting.`
    : `Accept to merge exactly commit ${short(f.commit)} into ${f.target}. Decline, or don't answer, to leave it waiting.`);
  return lines.join("\n");
}

const opView = (op: any) => ({ id: op.id, kind: op.kind, state: op.state, ...op.data, result: op.result });

export async function approve(a: { runId: string; merge: string; deny?: boolean; reason?: string }, port?: ElicitPort) {
  const p = await policy();
  const mode = p.approvals ?? "human";
  if (mode === "elicit") return approveElicited(a, p, port);
  if (mode !== "client-confirmed") {
    deny("approving merges into protected branches is left to a person in this project", `Ask the user to run \`capcomd approve ${a.runId} ${a.merge}\`${a.deny ? " --deny" : ""} (or approve in the TUI). A project can let capcomd ask the user itself with driver.approvals: "elicit" in .capcomd/config.json (\`capcomd setup agent --approvals elicit\`).`);
  }
  return O.decideMerge(a.runId, a.merge, { approve: !a.deny, by: DRIVER, ...(a.reason ? { reason: a.reason } : {}) });
}

/**
 * `driver.approvals: "elicit"`: capcomd asks the person itself (elicitation/create, its own text) and only their accept
 * decides. Fails closed: a client without form elicitation is refused; decline, cancel, no answer and errors leave the
 * merge parked with NO_DECISION; the commit shown must still be the branch's head when they accept.
 */
async function approveElicited(a: { runId: string; merge: string; deny?: boolean; reason?: string }, p: Awaited<ReturnType<typeof policy>>, port?: ElicitPort) {
  const cmd = `capcomd approve ${a.runId} ${a.merge}${a.deny ? " --deny" : ""}`;
  if (!port?.form) deny("this MCP client can't ask the user for capcomd (it didn't declare form elicitation), so it can't approve merges", `Ask the user to run \`${cmd}\` (or approve in the TUI).`);
  const name = port!.client ?? "";
  const allowed = Array.isArray(p.elicitClients) ? p.elicitClients : null;
  if (allowed ? !allowed.includes(name) : name === "claude-code") {
    deny(`approving by elicitation isn't enabled for ${name ? `the MCP client "${name}"` : "this MCP client"} in this project`, `Ask the user to run \`${cmd}\` (or approve in the TUI). ${name === "claude-code"
      ? 'Claude Code\'s Elicitation hooks can answer the prompt without a person: allow it only with managed hooks (allowManagedHooksOnly), by adding "claude-code" to driver.elicitClients in .capcomd/config.json.'
      : `To allow it, add "${name}" to driver.elicitClients in .capcomd/config.json.`}`);
  }
  const key = `${a.runId}\u0000${a.merge}`;
  if (asking.has(key)) return { id: a.merge, state: "awaiting_approval", decision: null, next: NO_DECISION };
  asking.add(key);
  try {
    const s = client().scope.getOrCreate([a.runId]);
    const op: any = await s.getOp({ opId: a.merge });
    if (!op || op.kind !== "merge") throw new RelayError("not_found", `merge ${a.merge} not found in ${a.runId}`, "Pass the mrg-… id capcomd_merge returned (capcomd_tree lists pendingApprovals).");
    if (op.state !== "awaiting_approval") return { ...opView(op), next: "Already decided; nothing to ask." };
    const d = op.data as { branch: string; target: string; agentId?: string | null; require?: string | null; expectSha?: string | null };
    const repoEnv = await (await import("../merge/run-config")).runRepoEnv(a.runId);
    const cfg = (await import("../merge/config")).loadMergeConfig({ ...process.env, ...repoEnv });
    if (!cfg) throw new RelayError("config", `run ${a.runId} has no repository configured, so capcomd can't check the commit`, `Ask the user to run \`${cmd}\`.`);
    const { remoteBranchSha } = await import("../merge/repo");
    const headNow = async () => { try { return await remoteBranchSha(cfg, d.branch); } catch (e) { throw new RelayError("conflict", `couldn't read ${d.branch} on the remote (${(e as Error).message}); not approved`, `${NO_DECISION} (\`${cmd}\` works in a terminal.)`, { retryable: false }); } };
    const head = await headNow();
    const commit = d.expectSha ?? head;
    if (!commit || head !== commit) {
      throw new RelayError("conflict", `branch ${d.branch} moved since it was verified (${short(commit)} → ${short(head)}); not approved`, `The merge is still waiting and can only land ${short(commit)}. Verify the new commit (capcomd_verify) and merge that; tell the user. A person can deny this one: \`capcomd approve ${a.runId} ${a.merge} --deny\`.`, { code: "branch_moved" });
    }
    const v: any = d.require ? await s.getOp({ opId: d.require }).catch(() => null) : null;
    const vr = v?.result ?? {};
    const facts: ApprovalFacts = {
      project: port!.project, repo: cfg.remote, runId: a.runId, mergeId: a.merge, target: d.target, branch: d.branch, agentId: d.agentId ?? null, commit, deny: !!a.deny,
      checks: v ? { passed: vr.checks?.passed !== false, name: typeof v.data?.check === "string" ? v.data.check : null } : null,
      review: vr.review ? { passed: vr.review.passed === true, profile: vr.review.profile ?? null, agentId: vr.review.agentId ?? null, reasons: Array.isArray(vr.review.reasons) ? vr.review.reasons.map(String) : [] } : null,
    };
    const timeoutMs = Math.min(Math.max(Number(p.elicitTimeoutSeconds ?? ELICIT_TIMEOUT_S) || ELICIT_TIMEOUT_S, 1), 3600) * 1000;
    let action: string;
    try { action = await port!.ask(approvalPrompt(facts), { timeoutMs }); } catch (e) {
      process.stderr.write(`capcomd mcp: approval prompt for ${a.merge} got no answer (${(e as Error)?.message ?? e})\n`);
      action = "none";
    }
    const parked = { id: a.merge, state: "awaiting_approval", decision: null, ...(port!.project ? { project: port!.project.name } : {}), next: NO_DECISION };
    if (action !== "accept") return parked;
    // Bound to the commit shown: if the branch moved while the person read the prompt, their accept isn't for it.
    const after = await headNow();
    if (after !== commit) throw new RelayError("conflict", `branch ${d.branch} moved while the user was asked (${short(commit)} → ${short(after)}); not approved`, `The merge is still waiting. Verify the new commit (capcomd_verify) and merge that; tell the user.`, { code: "branch_moved" });
    // Who asked and what the person saw, next to the decision (kv approval/<mrg>, reserved: only capcomd writes it).
    await S.kvWrite(a.runId, { k: `approval/${a.merge}`, value: { decision: a.deny ? "deny" : "approve", by: ELICITED, client: name || null, commit, target: d.target, project: port!.project?.name ?? null, at: new Date().toISOString() }, writer: "operator" }).catch(() => {});
    const work = O.decideMerge(a.runId, a.merge, { approve: !a.deny, by: ELICITED, ...(a.deny && a.reason ? { reason: a.reason } : {}) });
    work.catch(() => {});
    const r = await bounded(work, WAIT_DEFAULT_MS);
    const said = { decision: a.deny ? "denied" : "approved", decidedBy: ELICITED, ...(name ? { via: name } : {}), commit };
    if (!r.done) return { id: a.merge, state: "running", ...said, next: "The user approved; the merge is landing (the checks run again on the latest target). Check with capcomd_tree." };
    return { ...(r.value as Record<string, unknown>), ...said };
  } finally { asking.delete(key); }
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
