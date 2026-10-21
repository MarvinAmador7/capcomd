// ADR-017: the orchestrator side of in-VM capcomd. Every request carries a capability token;
// authority comes only from the token and the scope's limits, never from request text, so a
// prompt-injected agent can at most use what its own token already grants.
//
// Scopes: WRITE ops (spawn, cancel, send, verify, merge, handoff) touch only the caller's own
// subtree. READ ops (status, await, tree, inspect, logs, events) may also see the caller's
// parent's subtree (its siblings), so peers can coordinate and await-cycles can be detected.
// Agent-authored text in responses (results, messages, logs) is fenced.
import { redactShapes } from "../agents/redact";
import { RelayError } from "../core/errors";
import { client } from "../core/relay";
import * as O from "../primitives/ops";
import * as S from "../primitives/state";
import { TERMINAL_AGENT, parseBudget } from "../primitives/policy";
import type { ScopeAgent } from "../actors/scope";
import { verifyToken, type Claims, type Op } from "./token";
import { capText, fence, MESSAGE_MAX_BYTES, normalizeResult, subtree, type Truncation } from "./results";

export interface RpcRequest { id: string; token: string; op: string; args?: Record<string, any> }
export type RpcResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { code: string; reason?: string; message: string; hint?: string; retryable?: boolean } };

const RESERVED_KV = ["_", "approval/", "recipe/", "handoff/"];
const RESPONSE_MAX_BYTES = 256 * 1024;
/** Hold an in-VM verify this long before answering "running" (below the CLI's 120s RPC timeout). */
const VERIFY_HOLD_MS = Number(process.env.CAPCOMD_VERIFY_HOLD_MS ?? 90_000);

const deny = (message: string, hint = "Your token only covers your own subtree and the ops your parent granted."): never => {
  throw new RelayError("conflict", message, hint, { code: "forbidden" });
};

export interface RpcContext { runId: string; agentId: string; onCall?: (op: string, ok: boolean) => void }

export async function handleRpc(req: RpcRequest, ctx: RpcContext): Promise<RpcResponse> {
  const id = String(req?.id ?? "?");
  try {
    const claims = await authorize(req, ctx);
    // Never store a capability token (or other known secret shapes) an agent pasted into its args.
    let result = await dispatch(claims, req.op as Op, redactShapes(req.args ?? {}), id);
    const js = JSON.stringify(result ?? null);
    if (Buffer.byteLength(js) > RESPONSE_MAX_BYTES) result = { truncated: [{ field: "response", bytes: Buffer.byteLength(js), kept: 0 }], hint: "Response too large; narrow the query (e.g. --tail, --limit, a subtree root)." };
    ctx.onCall?.(req.op, true);
    return { id, ok: true, result };
  } catch (e) {
    ctx.onCall?.(String(req?.op), false);
    const r = e instanceof RelayError ? e : null;
    return { id, ok: false, error: r ? { code: r.code, ...(r.reason ? { reason: r.reason } : {}), message: r.message, hint: r.hint, ...(r.retryable ? { retryable: true } : {}) } : { code: "internal", message: String((e as Error)?.message ?? e).slice(0, 500) } };
  }
}

async function authorize(req: RpcRequest, ctx: RpcContext): Promise<Claims> {
  const v = verifyToken(req.token);
  if (!v.ok) throw new RelayError("conflict", `token rejected: ${v.reason}`, v.reason === "expired" ? "The orchestrator refreshes tokens while you run; retry once." : "Use the token in $CAPCOMD_TOKEN_FILE unmodified.", { code: "unauthorized" });
  const c = v.claims;
  // The spool is per agent: a token minted for another agent or run is refused here.
  if (c.run !== ctx.runId || c.sub !== ctx.agentId) throw new RelayError("conflict", "token does not belong to this agent", "Use your own token.", { code: "unauthorized" });
  const s = client().scope.getOrCreate([c.run]);
  if ((await s.isRevoked({ jti: c.jti })).revoked) throw new RelayError("conflict", "token revoked", "Your capabilities were revoked by the operator.", { code: "unauthorized" });
  const me: ScopeAgent | null = await s.getAgent({ agentId: c.sub });
  if (!me || TERMINAL_AGENT.has(me.status)) throw new RelayError("conflict", `agent ${c.sub} is ${me?.status ?? "gone"}; its token is dead`, "Stop: you were cancelled or already finished.", { code: "unauthorized" });
  if (!c.ops.includes(req.op as Op)) deny(`op "${req.op}" is not in your token (${c.ops.join(", ")})`, req.op === "spawn" ? "Your profile/parent did not grant children.allowSpawn." : undefined);
  s.heartbeat({ agentId: c.sub }).catch(() => {});
  return c;
}

async function scopeAgents(runId: string): Promise<ScopeAgent[]> { return client().scope.getOrCreate([runId]).listAgents({}); }

/** Write scope = own subtree; with `strict`, excluding the caller itself. */
async function assertWritable(c: Claims, target: string, strict = false) {
  const all = await scopeAgents(c.run);
  const own = subtree(all, c.sub);
  if (!own.has(target) || (strict && target === c.sub)) deny(`${target} is outside your subtree (${c.sub})`);
}
async function readable(c: Claims): Promise<{ all: ScopeAgent[]; ids: Set<string>; me: ScopeAgent }> {
  const all = await scopeAgents(c.run);
  const me = all.find((a) => a.agentId === c.sub)!;
  const ids = me.parent ? new Set([...subtree(all, me.parent)]) : subtree(all, c.sub);
  return { all, ids, me };
}
async function assertReadable(c: Claims, targets: string[]) {
  const { ids } = await readable(c);
  for (const t of targets) if (!ids.has(t)) deny(`${t} is not visible to ${c.sub} (only your subtree and your siblings')`);
}

/** Agent view for another agent: its result text is fenced; the caller's own record is not. */
function agentFor(c: Claims, a: ScopeAgent) {
  const v: any = O.view(a);
  if (a.agentId !== c.sub && v.result) {
    const r = { ...v.result };
    for (const k of ["summary", "error", "claim"]) if (typeof r[k] === "string") r[k] = fence(a.agentId, r[k]);
    v.result = r;
  }
  delete v.limits?.allowedChildProfiles?.__proto__;
  return v;
}

function ids(args: Record<string, any>, key = "agents"): string[] {
  const v = args[key] ?? args.agent;
  const list = Array.isArray(v) ? v : v ? [v] : [];
  if (!list.length) throw new RelayError("usage", `${key} required`, "Pass one or more agent ids (agt-…).");
  return list.map(String);
}

async function dispatch(c: Claims, op: Op, args: Record<string, any>, reqId: string): Promise<unknown> {
  const run = c.run;
  // Writes are idempotent per request: the CLI retries a transient failure with the same id.
  if (args.key === undefined && ["spawn", "send", "verify", "merge", "task"].includes(op)) args = { ...args, key: `r:${reqId}` };
  const s = client().scope.getOrCreate([run]);
  switch (op) {
    case "spawn": {
      // Parent is always the caller; never operator; contracts can't carry host-side checks.
      const contract = { ...(args.contract ?? {}) };
      delete contract.checks; delete contract.orphansPolicyOverride; delete contract.review; // review mode is verify's alone
      const a = await O.spawnAgent({
        runId: run, parent: c.sub, task: String(args.task ?? ""), profile: args.profile, key: args.key ? `${c.sub}:${args.key}` : undefined,
        budget: args.budget !== undefined ? parseBudget(args.budget) : undefined, contract, grant: args.children, operator: false,
        overrides: args.set ? { set: args.set } : undefined, ...(args.check !== undefined ? { check: String(args.check) } : {}), ...(args.report === true || args.report === "true" ? { report: true } : {}),
      });
      return { agentId: a.agentId, status: a.status, depth: a.depth, budget: a.budget, limits: a.limits, created: a.created };
    }
    case "status": {
      const targets = args.agents || args.agent ? ids(args) : [c.sub];
      await assertReadable(c, targets);
      return { agents: (await Promise.all(targets.map((t) => O.getAgentOrThrow(run, t)))).map((a) => agentFor(c, a)) };
    }
    case "await":
    case "wait-any": {
      // Non-blocking: the in-VM client polls. Each poll re-registers the await edges, which is
      // where a cycle (or awaiting an ancestor) is refused as a deadlock.
      const targets = ids(args);
      await assertReadable(c, targets);
      if (args.end) { await s.awaitEnd({ waiter: c.sub }); return { ended: true }; }
      const agents = await O.peekAgents(run, targets);
      const live = agents.filter((a) => !TERMINAL_AGENT.has(a.status)).map((a) => a.agentId);
      const doneNow = op === "wait-any" ? live.length < targets.length : live.length === 0;
      if (doneNow) await s.awaitEnd({ waiter: c.sub });
      else await s.awaitBegin({ waiter: c.sub, targets: live }).catch(O.asRelay);
      return { done: doneNow, agents: agents.map((a) => agentFor(c, a)) };
    }
    case "tree": {
      const root = args.root ? String(args.root) : c.sub;
      await assertReadable(c, [root]);
      return O.treeOf(run, root);
    }
    case "cancel": {
      const t = ids(args)[0]!;
      await assertWritable(c, t, true);
      return O.cancelAgents(run, t, `by ${c.sub}: ${String(args.reason ?? "").slice(0, 200)}`);
    }
    case "send": {
      const { me } = await readable(c);
      let to = String(args.to ?? "");
      if (to === "parent") to = me.parent ?? deny("you have no parent agent (you were spawned by the operator)");
      if (to !== me.parent) await assertWritable(c, to, true);
      const tr: Truncation[] = [];
      const body = capText(String(args.body ?? ""), MESSAGE_MAX_BYTES, "body", tr);
      return { ...(await s.sendMessage({ to, from: c.sub, body, ...(args.key ? { key: `${c.sub}:${args.key}` } : {}) })), ...(tr.length ? { truncated: tr } : {}) };
    }
    case "inbox": {
      const msgs = await s.inbox({ agentId: c.sub, after: Number(args.after ?? 0) });
      return { messages: msgs.map((m: any) => ({ seq: m.seq, from: m.from, at: m.at, body: fence(m.from, m.body) })) };
    }
    case "handoff": {
      // Hand the rest of my task to a successor child; my result becomes its result.
      const a = await O.spawnAgent({
        runId: run, parent: c.sub, task: String(args.task ?? ""), profile: args.profile, key: `${c.sub}:handoff`,
        contract: { handoffFrom: c.sub, context: args.context ?? null }, grant: args.children,
      });
      await S.kvWrite(run, { k: `handoff/${c.sub}`, value: { to: a.agentId, at: Date.now() }, writer: c.sub, key: `${c.sub}:handoff-kv` });
      return { handoffTo: a.agentId, status: a.status, note: "Exit now; your result will be your successor's result." };
    }
    case "events": {
      const { ids: vis } = await readable(c);
      const evs = (await s.getEvents({ since: Number(args.after ?? 0) })).filter((e: any) => e.agentId && vis.has(e.agentId));
      const limit = Math.min(Number(args.limit ?? 200), 1000);
      return { events: evs.slice(0, limit).map((e: any) => ({ seq: e.seq, ts: new Date(e.at).toISOString(), epochMs: e.at, at: e.at, type: e.type, agentId: e.agentId ?? null, data: e.agentId === c.sub ? e.data : redactEvent(e) })), more: evs.length > limit };
    }
    case "budget": return O.budgetShow(run, c.sub);
    case "inspect": {
      const t = ids(args)[0]!;
      await assertReadable(c, [t]);
      const r: any = await O.inspectAgent(run, t, { logTail: Number(args.tail ?? 50) });
      if (t !== c.sub) { r.logs = r.logs.map((l: any) => ({ ...l, line: fence(t, l.line).text })); r.result = agentFor(c, await O.getAgentOrThrow(run, t)).result; r.events = r.events.map(redactEvent); delete r.contract?.checks; }
      return r;
    }
    case "logs": {
      const t = ids(args)[0]!;
      await assertReadable(c, [t]);
      const r = await O.agentLogs(run, t, Math.min(Number(args.tail ?? 200), 2000));
      return t === c.sub ? r : { ...r, lines: r.lines.map((l: any) => ({ ...l, line: fence(t, l.line).text })) };
    }
    case "heartbeat": { await s.heartbeat({ agentId: c.sub, note: args.note ? String(args.note) : undefined }); return { ok: true }; }
    case "result": {
      const r = normalizeResult(args);
      await S.kvWrite(run, { k: `_result/${c.sub}`, value: r, writer: c.sub });
      return { recorded: true, ...(r.truncated ? { truncated: r.truncated } : {}) };
    }
    case "kv": {
      const action = String(args.action ?? "get"), k = String(args.k ?? "");
      if (action !== "get" && action !== "list" && RESERVED_KV.some((p) => k.startsWith(p))) deny(`kv key "${k}" is reserved for the orchestrator`, `Don't write keys starting with ${RESERVED_KV.join(", ")}.`);
      const tag = (v: any) => (v && v.writer && v.writer !== c.sub ? { ...v, untrusted: true } : v);
      if (action === "get") return tag(await S.kvGet(run, k));
      if (action === "list") return { items: ((await S.kvList(run, args.prefix, !!args.all)).entries as any[]).filter((v) => !String(v.k).startsWith("_")).map(tag) };
      if (action === "put") return S.kvWrite(run, { k, value: args.value, writer: c.sub, key: args.key ? `${c.sub}:${args.key}` : undefined });
      if (action === "cas") return S.kvWrite(run, { k, value: args.value, expect: Number(args.expect), writer: c.sub, key: args.key ? `${c.sub}:${args.key}` : undefined });
      if (action === "del") return S.kvWrite(run, { k, value: null, del: true, writer: c.sub, ...(args.expect !== undefined ? { expect: Number(args.expect) } : {}) });
      throw new RelayError("usage", `kv action ${action}?`, "get|put|cas|del|list");
    }
    case "task": {
      const action = String(args.action ?? "list");
      const holder = c.sub; // a VM agent can only hold leases as itself
      const key = args.key ? `${c.sub}:${args.key}` : undefined;
      if (action === "add") return S.taskAdd(run, { title: String(args.title ?? ""), data: args.data, after: args.after, key });
      if (action === "list") return { tasks: (await S.taskList(run, args.status)).tasks };
      if (action === "show") return S.taskGet(run, String(args.task));
      if (action === "claim") return S.taskClaim(run, { holder, taskId: args.task, leaseMs: args.leaseMs, key });
      if (action === "renew") return S.taskRenew(run, { taskId: String(args.task), holder, epoch: Number(args.epoch), leaseMs: args.leaseMs });
      if (action === "done" || action === "release") return S.taskFinish(run, { taskId: String(args.task), holder, epoch: Number(args.epoch), outcome: action === "done" ? "done" : "released", result: args.result, key });
      throw new RelayError("usage", `task action ${action}?`, "add|list|show|claim|renew|release|done");
    }
    case "verify": {
      if (args.reviewProfile !== undefined || args.judgeProfile !== undefined) deny("in-VM verify cannot choose a reviewer: the operator sets it per run (`run new --reviewer P`)", "Verify with just --ref; the run's reviewer, if any, reviews every verification.");
      if (args.checks !== undefined) deny("in-VM verify cannot set --checks: test commands come only from the operator", "Pin one of the run's operator-named checks when spawning (`capcomd spawn … --check NAME`; `capcomd kv get _checks` lists them), then verify with just --ref.");
      const ref = String(args.ref ?? "");
      if (!ref.startsWith("agt-")) deny("in-VM verify takes a child agent id, not a branch");
      await assertWritable(c, ref, true);
      // Checks never come from the VM: the operator-named check pinned to the child at spawn, else
      // the run's root contract (operator-set), else the repo's test command. A pin can't be swapped
      // after the fact (no shopping for an easier check once one fails).
      const pinned = (await O.getAgentOrThrow(run, ref)).contract?.check as string | undefined;
      if (args.check !== undefined && String(args.check) !== pinned) {
        deny(pinned ? `${ref} was pinned to check "${pinned}" at spawn; it can't be verified with "${args.check}"` : `${ref} has no pinned check; named checks are pinned at spawn`,
          pinned ? "Verify with just --ref: it uses the pinned check." : "Spawn the child with --check NAME, then verify with just --ref.");
      }
      const key = args.key ? `${c.sub}:${args.key}` : undefined;
      // A poll of a verification that already finished gets its record at once (one lookup, not the
      // whole verify path, which can outlast a short hold and would answer "running" forever).
      const done = await O.finishedVerify(run, O.verifyIdFor(run, ref, key));
      if (done) return done;
      // A review takes minutes, longer than one RPC: answer "running" after VERIFY_HOLD_MS; the CLI polls
      // with the same key, and the in-flight verify is shared (never re-run) until it finishes.
      const p = O.verifyRef({ runId: run, ref, ...(pinned ? { check: pinned } : { checks: await operatorChecks(c) }), acceptance: args.acceptance, key, reviewParent: c.sub });
      p.catch(() => {}); // a later poll gets the error
      const held = await Promise.race([p, new Promise((r) => setTimeout(() => r(null), VERIFY_HOLD_MS))]);
      return held ?? { id: O.verifyIdFor(run, ref, key), kind: "verify", state: "running", ref };
    }
    case "merge": {
      const ref = String(args.ref ?? "");
      if (!ref.startsWith("agt-")) deny("in-VM merge takes a child agent id, not a branch");
      await assertWritable(c, ref, true);
      if (!args.require) throw new RelayError("usage", "merge needs --require <vfyId>", "Verify the child first: capcomd verify --ref <agt>.");
      // A protected target parks the merge (awaiting_approval) for the operator; merge again with the same key to check.
      return O.mergeRef({ runId: run, ref, require: String(args.require), operator: false, requestApproval: true, key: args.key ? `${c.sub}:${args.key}` : undefined });
    }
  }
  throw new RelayError("usage", `unknown op ${op}`, "See `capcomd help` inside the VM.");
}

/** The checks command an operator set on the caller's top-level ancestor (RPC spawns strip it). */
async function operatorChecks(c: Claims): Promise<string | undefined> {
  const all = await scopeAgents(c.run);
  const byId = new Map(all.map((a) => [a.agentId, a]));
  let a = byId.get(c.sub);
  while (a?.parent) a = byId.get(a.parent);
  const v = a?.contract?.checks;
  return typeof v === "string" ? v : undefined;
}

function redactEvent(e: any) {
  const d = { ...(e.data ?? {}) };
  if (d.result && typeof d.result === "object") {
    const r = { ...d.result };
    for (const k of ["summary", "error", "claim"]) if (typeof r[k] === "string") r[k] = fence(e.agentId, r[k]);
    d.result = r;
  }
  if (typeof d.task === "string") d.task = fence("operator-or-parent", d.task).text;
  return { ...e, data: d };
}
