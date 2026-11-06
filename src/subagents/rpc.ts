// ADR-017: the orchestrator side of in-VM capcomd. Every request carries a capability token;
// authority comes only from the token and the scope's limits, never from request text, so a
// prompt-injected agent can at most use what its own token already grants.
//
// Scopes: WRITE ops (spawn, cancel, send, verify, merge, handoff, grant) touch only the caller's own
// subtree; `title` names the caller itself or one of its own children (the planner: also the run). READ ops (status, await, tree, inspect, logs, events) may also see the caller's
// parent's subtree (its siblings), so peers can coordinate and await-cycles can be detected.
// Agent-authored text in responses (results, messages, logs) is fenced.
import { redactShapes } from "../agents/redact";
import { withSkills, type AttachedSkill } from "../agents/skills";
import { RelayError } from "../core/errors";
import { client } from "../core/relay";
import * as O from "../primitives/ops";
import * as S from "../primitives/state";
import { TERMINAL_AGENT, parseBudget } from "../primitives/policy";
import type { ScopeAgent } from "../actors/scope";
import { verifyToken, type Claims, type Op } from "./token";
import { capText, fence, MESSAGE_MAX_BYTES, normalizeResult, subtree, type Truncation } from "./results";
import type { JobMachine } from "../jobs/machine";

export interface RpcRequest { id: string; token: string; op: string; args?: Record<string, any> }
export type RpcResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { code: string; reason?: string; message: string; hint?: string; retryable?: boolean } };

const RESERVED_KV = ["_", "approval/", "recipe/", "handoff/"];
const RESPONSE_MAX_BYTES = 256 * 1024;
/** Hold an in-VM verify this long before answering "running" (below the CLI's 120s RPC timeout). */
const VERIFY_HOLD_MS = Number(process.env.CAPCOMD_VERIFY_HOLD_MS ?? 90_000);

const deny = (message: string, hint = "Your token only covers your own subtree and the ops your parent granted."): never => {
  throw new RelayError("conflict", message, hint, { code: "forbidden" });
};

export interface RpcContext {
  runId: string; agentId: string; onCall?: (op: string, ok: boolean) => void;
  /** A command in the caller's own machine (its VM, or this host for a scripted agent), without credentials, and a
   *  file put there: `fetch` brings the host's fetch in as a bundle (plugin API §11.7). */
  exec?: (cmd: string[], opts: { cwd?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
  upload?: (path: string, data: Uint8Array) => Promise<void>;
  /** The caller's machine as its background jobs run in it (plugin API §16.2; src/jobs/service.ts). */
  jobs?: JobMachine;
}

export async function handleRpc(req: RpcRequest, ctx: RpcContext): Promise<RpcResponse> {
  const id = String(req?.id ?? "?");
  try {
    const claims = await authorize(req, ctx);
    // Never store a capability token (or other known secret shapes) an agent pasted into its args.
    let result = await dispatch(claims, req.op as Op, redactShapes(req.args ?? {}), id, ctx);
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
  // A failing notice quotes the agent's own error output.
  if (a.agentId !== c.sub && v.notice) { v.notice = { ...v.notice, detail: fence(a.agentId, String(v.notice.detail)) }; v.stuck = v.notice.detail; }
  delete v.limits?.allowedChildProfiles?.__proto__;
  return v;
}

function ids(args: Record<string, any>, key = "agents"): string[] {
  const v = args[key] ?? args.agent;
  const list = Array.isArray(v) ? v : v ? [v] : [];
  if (!list.length) throw new RelayError("usage", `${key} required`, "Pass one or more agent ids (agt-…).");
  return list.map(String);
}

async function dispatch(c: Claims, op: Op, args: Record<string, any>, reqId: string, ctx: RpcContext): Promise<unknown> {
  const run = c.run;
  // Writes are idempotent per request: the CLI retries a transient failure with the same id.
  if (args.key === undefined && ["spawn", "send", "verify", "merge", "task", "grant", "title", "job.start"].includes(op)) args = { ...args, key: `r:${reqId}` };
  const s = client().scope.getOrCreate([run]);
  switch (op) {
    case "spawn": {
      // Parent is always the caller; never operator; contracts can't carry host-side checks.
      const contract = { ...(args.contract ?? {}) };
      delete contract.checks; delete contract.orphansPolicyOverride; delete contract.review; delete contract.from; // review mode is verify's alone; from is --continue's
      const a = await O.spawnAgent({
        runId: run, parent: c.sub, task: String(args.task ?? ""), profile: args.profile, key: args.key ? `${c.sub}:${args.key}` : undefined,
        budget: args.budget !== undefined ? parseBudget(args.budget) : undefined, contract, grant: args.children, operator: false,
        overrides: args.set ? { set: args.set } : undefined, ...(args.check !== undefined ? { check: String(args.check) } : {}), ...(args.report === true || args.report === "true" ? { report: true } : {}),
        ...(typeof args.continue === "string" && args.continue ? { continueFrom: args.continue } : {}),
        ...(args.title !== undefined ? { title: String(args.title) } : {}),
      });
      return { agentId: a.agentId, status: a.status, depth: a.depth, budget: a.budget, limits: a.limits, created: a.created, ...(a.title ? { title: a.title } : {}) };
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
      // ADR-019 §2: stuck notices on what's still running; the in-VM client returns on one raised while it waits.
      const notices = agents.filter((a) => a.status === "running" && a.notice).map((a) => ({ agentId: a.agentId, ...a.notice!, detail: fence(a.agentId, a.notice!.detail) }));
      return { done: doneNow, agents: agents.map((a) => agentFor(c, a)), ...(notices.length ? { notices } : {}) };
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
      const note = await O.messageNote(run, to);
      return { ...(await s.sendMessage({ to, from: c.sub, body, ...(args.key ? { key: `${c.sub}:${args.key}` } : {}) })), ...(tr.length ? { truncated: tr } : {}), ...(note ? { note } : {}) };
    }
    case "inbox": {
      const msgs = await s.inbox({ agentId: c.sub, after: Number(args.after ?? 0) });
      // Skills the sender attached come with the body, as a running agent gets them (runner messageText).
      return { messages: msgs.map((m: any) => ({ seq: m.seq, from: m.from, at: m.at, body: fence(m.from, withSkills(m.body, m.skills)), ...(m.skills?.length ? { skills: m.skills.map((x: AttachedSkill) => x.name) } : {}) })) };
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
    case "grant": {
      // More budget for one of the caller's own children, from what the caller has left (ADR-019 §4).
      const t = ids(args)[0]!;
      if ((await O.getAgentOrThrow(run, t)).parent !== c.sub) deny(`${t} is not your child: you can give budget only to agents you spawned`);
      let add;
      try { add = parseBudget(args.budget); } catch (e) { throw new RelayError("usage", `budget: ${(e as Error).message}`, "Units: usd, turns, wallSeconds, e.g. --budget usd=1,turns=20."); }
      return O.grantBudget(run, { agentId: t, add, by: c.sub, key: `${c.sub}:${args.key}` });
    }
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
    case "title": {
      // Capability agents.title: name your own tab, one of your children's, or (the planner) the run. Rate limited.
      const title = String(args.title ?? "");
      const key = `${c.sub}:${args.key}`;
      if (args.run === true || args.run === "true") {
        const { me } = await readable(c);
        if (me.parent || (me.contract as Record<string, unknown> | null)?.review) deny("only the run's planner names the run", "Name your own tab: capcomd title \"<2-4 words>\".");
        return O.setRunTitle(run, title, { setBy: c.sub, key });
      }
      const t = args.agent ? String(args.agent) : c.sub;
      if (t !== c.sub && (await O.getAgentOrThrow(run, t)).parent !== c.sub) deny(`${t} is not your child: you can name only yourself and the agents you spawned`);
      return O.setAgentTitle(run, t, title, { by: t === c.sub ? "self" : "parent", setBy: c.sub, key });
    }
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
    case "fetch": return fetchInto(ctx, args);
    case "job.start": case "job.output": case "job.list": case "job.kill": return jobOp(c, op, args, ctx);
    case "check": {
      // Plugin API §16.1: the run's checks on any ref's commit as it is (the target, a goal branch, a child's branch),
      // in a sandbox; it lands nothing, so any agent that may spawn may ask, orchestrate agents included. The command is
      // never the VM's: an operator-named check, else the one pinned to the agent checked, else the run's own.
      if (args.checks !== undefined) deny("in-VM check cannot set --checks: check commands come only from the operator", "Name one of the run's operator-named checks with --check NAME (`capcomd kv get _checks` lists them), or none for the run's own checks.");
      if (args.id !== undefined && args.ref === undefined) {
        const { id, done } = await O.startCheck({ runId: run, id: String(args.id) });
        return holdCheck(id, done);
      }
      const ref = args.ref !== undefined && String(args.ref).trim() ? String(args.ref).trim() : undefined;
      let pinned = false;
      if (ref?.startsWith("agt-")) { await assertReadable(c, [ref]); pinned = typeof (await O.getAgentOrThrow(run, ref)).contract?.check === "string"; }
      const oc = args.check === undefined && !pinned ? await operatorChecks(c) : undefined;
      const { id, done } = await O.startCheck({
        runId: run, ...(ref ? { ref } : {}), ...(args.check !== undefined ? { check: String(args.check) } : oc ? { checks: oc } : {}),
        ...(args.key !== undefined ? { key: String(args.key) } : {}), askedBy: c.sub,
      });
      return holdCheck(id, done);
    }
    case "merge": {
      const ref = String(args.ref ?? "");
      if (!ref.startsWith("agt-")) deny("in-VM merge takes a child agent id, not a branch");
      await assertWritable(c, ref, true);
      if (!args.require) throw new RelayError("usage", "merge needs --require <vfyId>", "Verify the child first: capcomd verify --ref <agt>.");
      // A protected target parks the merge (awaiting_approval) for the operator; merge again with the same key to check.
      return O.mergeRef({ runId: run, ref, require: String(args.require), operator: false, requestApproval: true, askedBy: c.sub, key: args.key ? `${c.sub}:${args.key}` : undefined });
    }
  }
  throw new RelayError("usage", `unknown op ${op}`, "See `capcomd help` inside the VM.");
}

/**
 * `capcomd job start -- <cmd>` and its siblings (plugin API §16.2): background work in the caller's own machine. A start
 * waits `--foreground-ms` (else the agent's jobs.foregroundMs) and answers `done`/`failed` with the result, or
 * `running`: its result then arrives as a message. An agent sees and stops only its own jobs. An orchestrate agent runs
 * nothing (§16.1), so it starts none.
 */
async function jobOp(c: Claims, op: Op, args: Record<string, any>, ctx: RpcContext) {
  const J = await import("../jobs/service");
  const own = async (id: unknown) => {
    const jobId = String(id ?? "");
    const j = await J.getJob(jobId, c.run).catch(() => null);
    if (!j || !("agentId" in j.spec.owner) || j.spec.owner.agentId !== c.sub) throw new RelayError("not_found", `job ${jobId.slice(0, 80)} isn't one of yours`, "capcomd job list shows your jobs.");
    return j;
  };
  if (op === "job.list") return { jobs: (await J.listJobs({ runId: c.run, agentId: c.sub })).map(jobView) };
  if (op === "job.kill") { const j = await own(args.job); return jobView(await J.cancelJob(j.jobId, `by ${c.sub}${args.reason ? `: ${String(args.reason).slice(0, 200)}` : ""}`, { runId: c.run, byOwner: true })); }
  if (op === "job.output") {
    const j = await own(args.job);
    const tail = Math.min(Math.max(Number(args.tail ?? 16_384) || 16_384, 1), 64 * 1024);
    const live = ctx.jobs && (j.state === "running" || j.state === "stopping") ? await (await import("../jobs/machine")).tails(ctx.jobs, j.jobId, tail, tail).catch(() => null) : null;
    const res = j.result && "code" in j.result ? j.result : null;
    const cut = (s: string) => (Buffer.byteLength(s) <= tail ? s : Buffer.from(s).subarray(-tail).toString("utf8"));
    return { jobId: j.jobId, state: j.state, ...(res ? { code: res.code } : {}), stdout: live?.stdout ?? cut(res?.stdout ?? ""), stderr: live?.stderr ?? cut(res?.stderr ?? ""), truncated: live?.truncated ?? res?.truncated ?? false };
  }
  // job.start
  if (!ctx.jobs) throw new RelayError("usage", "capcomd job works only in an agent's machine", "Run it from inside your VM.");
  const me = await O.getAgentOrThrow(c.run, c.sub);
  if ((me.spec as { toolMode?: string } | null)?.toolMode === "orchestrate") deny("an orchestrate agent runs nothing, in the background either (plugin API §16.1)", "Give the command to a helper you spawn, or read the results of `capcomd check`.");
  const cmd = Array.isArray(args.cmd) ? args.cmd.map(String) : typeof args.cmd === "string" ? [args.cmd] : [];
  if (!cmd.length) throw new RelayError("usage", "job start needs a command", "capcomd job start -- npm test");
  const label = String(args.label ?? cmd.join(" ")).replace(/\s+/g, " ").trim().slice(0, 200);
  const cwd = typeof args.cwd === "string" && args.cwd.startsWith("/") ? args.cwd : undefined;
  // The agent's PATH, so the job finds what its shell does (its npm, its tools).
  const env = typeof args.path === "string" && args.path.length < 4096 ? { PATH: args.path } : undefined;
  const fg = args.foregroundMs !== undefined ? Number(args.foregroundMs) : undefined;
  if (fg !== undefined && !(Number.isInteger(fg) && fg >= 0)) throw new RelayError("usage", "--foreground-ms is a whole number of milliseconds", "e.g. --foreground-ms 1000.");
  const timeoutMs = args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined;
  const j = await J.startJob({ kind: "exec", runId: c.run, owner: { agentId: c.sub }, cmd, label: label || "job", ...(cwd ? { cwd } : {}), ...(env ? { env } : {}), ...(fg !== undefined ? { foregroundMs: fg } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
    { by: c.sub, machine: ctx.jobs, ...(args.key ? { key: `${c.sub}:${args.key}` } : {}), ...(Number(args.maxForegroundMs) > 0 ? { foregroundCapMs: Number(args.maxForegroundMs) } : {}) });
  const v = jobView(j);
  return j.state === "running" ? { ...v, hint: `Still running: its result arrives as a message (capcomd inbox). capcomd job output ${j.jobId} shows its output so far; capcomd job kill ${j.jobId} stops it.` } : v;
}

/** A job as the agent that owns it reads it: its own words are its own (not fenced). */
function jobView(j: import("../../packages/plugin/src/shapes").Job) {
  const res = j.result && "code" in j.result ? j.result : null;
  return {
    jobId: j.jobId, state: j.state, label: j.spec.label, startedAt: j.startedAt, endedAt: j.endedAt, reason: j.reason,
    ...(j.spec.kind === "exec" ? { cmd: j.spec.cmd } : {}), ...(res ? { code: res.code, stdout: res.stdout, stderr: res.stderr, truncated: res.truncated } : {}),
  };
}

/** A check takes as long as the checks: answer "running" (with its id, which the CLI polls) after VERIFY_HOLD_MS. */
async function holdCheck(id: string, done: Promise<any>) {
  done.catch(() => {}); // a later poll gets the error
  const held = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), VERIFY_HOLD_MS))]);
  return held ?? { id, kind: "check", state: "running" };
}

const FETCH_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * `capcomd fetch [branch…]` (plugin API §16.1: an orchestrate agent sees everything): the host fetches the run's
 * repository (by its URL, with the host's git credentials) into its own mirror and hands the caller's checkout (`dir`,
 * which the in-VM CLI finds) the new commits as a bundle (§11.7): no credential reaches the VM, and nothing in the
 * checkout (its git settings, hooks or remotes) takes part in the fetch from the remote. A CLI sandbox that blocks a
 * fetch (codex) doesn't stop it either. Read-only for code: it moves only `refs/remotes/origin/*`. Answers each
 * fetched branch's commit, for `git log` / `git show origin/<branch>:<path>`.
 */
async function fetchInto(ctx: RpcContext, args: Record<string, any>) {
  if (!ctx.exec || !ctx.upload) throw new RelayError("usage", "capcomd fetch works only in an agent's VM", "Run `git fetch` yourself here.");
  const dir = String(args.dir ?? "");
  if (!dir.startsWith("/") || !/^[A-Za-z0-9._/-]+$/.test(dir) || dir.split("/").includes("..")) throw new RelayError("usage", `fetch needs your checkout's absolute path (got ${JSON.stringify(dir).slice(0, 200)})`, "Run it from inside your checkout.");
  const refs = (Array.isArray(args.refs) ? args.refs : args.ref !== undefined ? [args.ref] : []).map(String);
  for (const r of refs) if (!FETCH_REF.test(r) || r.includes("..") || r.endsWith(".lock")) throw new RelayError("usage", `not a branch name: ${JSON.stringify(r).slice(0, 200)}`, "Pass branch names, e.g. capcomd fetch main.");
  // The run's repository by its URL, fetched by the host into its mirror; the checkout gets a bundle. The fetch from
  // the remote never runs in the checkout, so its settings (a credential helper, url.*.insteadOf, hooks, …) can't
  // redirect it or see a credential.
  const cfg = (await import("../merge/config")).loadMergeConfig(await (await import("../merge/run-config")).runEnv(ctx.runId));
  if (!cfg?.remote) throw new RelayError("usage", "this run has no repository to fetch from", "Runs with a repository (CAPCOMD_REPO) can fetch.");
  const T = await import("../merge/transfer");
  try {
    await T.sendToSandbox({ remote: cfg.remote, workdir: cfg.workdir }, { exec: ctx.exec, upload: ctx.upload }, dir, { branches: refs.length ? refs : "all", timeoutMs: 300_000 });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (e instanceof T.TransferError && e.kind === "sandbox" && /isn't a git checkout/.test(msg)) throw new RelayError("usage", `${dir} isn't a git checkout`, "Run it from inside your checkout.");
    throw new RelayError("conflict", `git fetch failed: ${msg.slice(-500)}`, "Check the branch names (capcomd fetch with none fetches every branch).", { code: "failed" });
  }
  const l = await ctx.exec(["git", "for-each-ref", "--sort=-committerdate", "--count=50", "--format=%(refname:lstrip=3)%09%(objectname)%09%(subject)", ...(refs.length ? refs.map((r) => `refs/remotes/origin/${r}`) : ["refs/remotes/origin"])], { cwd: dir, timeoutMs: 60_000 });
  const branches = l.stdout.split("\n").filter((x) => x.trim()).map((x) => { const [branch, sha, ...s] = x.split("\t"); return { branch: branch!, ref: `origin/${branch}`, sha: sha!, subject: s.join("\t").slice(0, 200) }; }).filter((b) => b.branch !== "HEAD");
  return { fetched: true, branches, hint: "Read a branch without changing anything: git log origin/<branch>, git show origin/<branch>:<path>, git diff <a> <b>; or git switch --detach origin/<branch> to read it with the file tools." };
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
