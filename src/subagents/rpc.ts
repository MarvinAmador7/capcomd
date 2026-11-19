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
import { HOST_CONTRACT_KEYS } from "../plugins/hooks";
import { client } from "../core/relay";
import * as O from "../primitives/ops";
import * as S from "../primitives/state";
import { TERMINAL_AGENT, parseBudget } from "../primitives/policy";
import type { ScopeAgent } from "../actors/scope";
import { verifyToken, type Claims, type Op } from "./token";
import { capText, fence, MESSAGE_MAX_BYTES, normalizeResult, subtree, type Truncation } from "./results";
import type { JobMachine } from "../jobs/machine";
import { WAKE_MAX_MS } from "../actors/wakes";
import { noteOpWake } from "../primitives/wake-sweep";

/** `holdMs`: how long the caller still waits for this answer, less a margin for the spool's round trip (the CLI sends it;
 *  a verify or check is held no longer than that, so a retry with little time left isn't answered after it gave up). */
export interface RpcRequest { id: string; token: string; op: string; args?: Record<string, any>; holdMs?: number }
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
  /** How long a verify or check is held before it answers "running": VERIFY_HOLD_MS, or less when the caller says so. */
  holdMs?: number;
}

/** The engine call under a long verify gave up waiting (the HTTP request timed out) while the verification goes on in
 *  the verifier: not an error of the verification, so the poll answers "running" and the next one attaches again. */
const transportTimeout = (e: unknown): boolean => {
  const x = e as { name?: string; message?: string } | null;
  return /HTTP request error/.test(String(x?.message ?? "")) && /TimeoutError|timed out/i.test(String(x?.message ?? ""));
};

export async function handleRpc(req: RpcRequest, ctx: RpcContext): Promise<RpcResponse> {
  const id = String(req?.id ?? "?");
  try {
    const claims = await authorize(req, ctx);
    // Never store a capability token (or other known secret shapes) an agent pasted into its args.
    const asked = typeof req?.holdMs === "number" ? req.holdMs : NaN;
    const holdMs = Number.isFinite(asked) && asked >= 0 ? Math.min(VERIFY_HOLD_MS, asked) : VERIFY_HOLD_MS;
    let result = await dispatch(claims, req.op as Op, redactShapes(req.args ?? {}), id, { ...ctx, holdMs });
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
  if (args.key === undefined && ["spawn", "send", "verify", "merge", "task", "grant", "title", "job.start", "wake"].includes(op)) args = { ...args, key: `r:${reqId}` };
  const s = client().scope.getOrCreate([run]);
  switch (op) {
    case "spawn": {
      // Parent is always the caller; never operator; contracts can't carry host-side checks.
      const contract = { ...(args.contract ?? {}) };
      for (const k of Object.keys(HOST_CONTRACT_KEYS)) delete contract[k]; // review mode is verify's alone; from is --continue's
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
      const agents = await Promise.all(targets.map((t) => O.getAgentOrThrow(run, t)));
      // ADR-025 §5.2: an agent that may spawn the consolidator sees, with its own status, what the run holds for the
      // project's memory (counts and the consolidators' states, no lesson's text): when to spawn it, and whether to.
      const me = agents.find((a) => a.agentId === c.sub);
      const { CONSOLIDATOR_PROFILE } = await import("../context/consolidate");
      if (me?.limits.allowSpawn && me.limits.allowedChildProfiles.includes(CONSOLIDATOR_PROFILE)) {
        const C = await import("../context/consolidator");
        const l = await C.runLessons(run);
        return { agents: agents.map((a) => agentFor(c, a)), lessons: { ...l, text: C.lessonsText(l) } };
      }
      return { agents: agents.map((a) => agentFor(c, a)) };
    }
    case "await":
    case "wait-any": {
      // Non-blocking: the in-VM client polls. Each poll re-registers the await edges, which is
      // where a cycle (or awaiting an ancestor) is refused as a deadlock.
      const targets = ids(args);
      await assertReadable(c, targets);
      // ADR-026 §3: `await … --wake` doesn't wait: the agent ends its turn and is woken when they end.
      if (isWake(args)) return armWake(c, reqId, { kind: "agents", agents: targets, mode: op === "wait-any" ? "any" : "all" }, args, { agents: targets });
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
      const sent = await s.sendMessage({ to, from: c.sub, body, ...(args.key ? { key: `${c.sub}:${args.key}` } : {}) });
      // ADR-026 §1: an idle child continues with the message as its next turn.
      const note = (sent as { continued?: boolean }).continued ? O.continuedNote(to) : await O.messageNote(run, to);
      return { ...sent, ...(tr.length ? { truncated: tr } : {}), ...(note ? { note } : {}) };
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
      // An empty call (a tool called before its schema was read gives `{}`) would record nothing, or erase a result.
      if (!r.summary.trim() && !r.artifacts.length && r.data === undefined) throw new RelayError("usage", "result needs a summary (or artifacts or data): nothing was recorded", "capcomd result --summary \"<what you did, what you checked, what is left>\" [--data JSON]");
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
      // ADR-026 §3: `verify --wake` holds nothing: it starts the verification and arms a wake on its end.
      const wake = isWake(args);
      if (wake) await assertWakeable(c);
      // A review takes minutes, longer than one RPC: answer "running" after VERIFY_HOLD_MS; the CLI polls
      // with the same key, and the in-flight verify is shared (never re-run) until it finishes.
      const p = O.verifyRef({ runId: run, ref, ...(pinned ? { check: pinned } : { checks: await operatorChecks(c) }), acceptance: args.acceptance, key, reviewParent: c.sub });
      p.catch(() => {}); // a later poll gets the error
      if (wake) {
        const id = O.verifyIdFor(run, ref, key);
        // Its op record is written as it starts: wait for that (a moment), so the wake's arming sees it. A verify that
        // fails before it has one (its child has no branch) answers with that failure.
        for (let i = 0; i < 100 && !(await s.getOp({ opId: id })); i++) {
          const early = await Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise<null>((r) => setTimeout(() => r(null), 100))]);
          if (early && "e" in early) throw early.e;
          if (early && "v" in early) return early.v;
        }
        return armWake(c, reqId, { kind: "op", op: id }, { ...args, key: undefined }, { id, kind: "verify", state: "running", ref });
      }
      const held = await Promise.race([p.catch((e) => { if (transportTimeout(e)) return null; throw e; }), new Promise((r) => setTimeout(() => r(null), ctx.holdMs ?? VERIFY_HOLD_MS))]);
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
        return holdCheck(id, done, ctx.holdMs);
      }
      const ref = args.ref !== undefined && String(args.ref).trim() ? String(args.ref).trim() : undefined;
      let pinned = false;
      if (ref?.startsWith("agt-")) { await assertReadable(c, [ref]); pinned = typeof (await O.getAgentOrThrow(run, ref)).contract?.check === "string"; }
      const oc = args.check === undefined && !pinned ? await operatorChecks(c) : undefined;
      if (isWake(args)) await assertWakeable(c);
      const { id, done } = await O.startCheck({
        runId: run, ...(ref ? { ref } : {}), ...(args.check !== undefined ? { check: String(args.check) } : oc ? { checks: oc } : {}),
        ...(args.key !== undefined ? { key: String(args.key) } : {}), askedBy: c.sub,
      });
      // ADR-026 §3: `check --wake` holds nothing: the check runs on, and its end wakes the agent.
      if (isWake(args)) { done.catch(() => {}); return armWake(c, reqId, { kind: "op", op: id }, { ...args, key: undefined }, { id, kind: "check", state: "running" }); }
      return holdCheck(id, done, ctx.holdMs);
    }
    case "wake": {
      // ADR-026 §3: `capcomd wake --op ID | --agents a,b [--all] | --events T,… [--agent agt] [--after SEQ] | --in 5m | --at ISO [--note …]`.
      if (args.cancel) {
        const w = await s.wakeCancel({ agentId: c.sub, wakeId: String(args.cancel) });
        if (!w) throw new RelayError("not_found", `${String(args.cancel).slice(0, 80)} isn't one of your wakes`, "capcomd wake --list shows yours.");
        return { wake: wakeView(w) };
      }
      if (args.list === true || args.list === "true") return { wakes: (await s.wakeList({ agentId: c.sub })).map(wakeView) };
      const list = (v: unknown) => [].concat(v as any).flatMap((x: unknown) => String(x).split(",")).map((x) => x.trim()).filter(Boolean);
      // Only what the agent may see (its subtree and its siblings', as status, events and inspect): an op of one of them
      // (or one it asked for itself), those agents, events about them.
      if (args.op !== undefined) {
        const id = String(args.op);
        const o = await s.getOp({ opId: id });
        if (!o) throw new RelayError("not_found", `${id.slice(0, 80)} not found in this run`, "Pass a vfy-/chk-/mrg- id that verify, check or merge returned.");
        await assertOpVisible(c, o);
        return armWake(c, reqId, { kind: "op", op: id }, args, {});
      }
      if (args.agents !== undefined) {
        const agents = list(args.agents);
        await assertReadable(c, agents);
        return armWake(c, reqId, { kind: "agents", agents, mode: args.all === true || args.all === "true" ? "all" : "any" }, args, {});
      }
      if (args.events !== undefined) {
        const { me } = await readable(c);
        if (args.agent !== undefined) await assertReadable(c, [String(args.agent)]);
        return armWake(c, reqId, { kind: "events", types: list(args.events), ...(args.agent !== undefined ? { agent: String(args.agent) } : {}), after: Number(args.after ?? 0) || 0, within: me.parent ?? c.sub }, args, {});
      }
      return armWake(c, reqId, { kind: "timer" }, args, {});
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
 * `capcomd job start -- <cmd>` and its siblings (plugin API §16.2): background work in the caller's own machine, or with
 * `--run` in the run's job machine (it outlives the agent, until the run ends). A start waits `--foreground-ms` (else
 * the agent's jobs.foregroundMs) and answers `done`/`failed` with the result, or `running`: its result then arrives as a
 * message. An agent sees and stops only its own jobs (and the run's it started). An orchestrate agent runs nothing
 * (§16.1), so it starts none.
 */
async function jobOp(c: Claims, op: Op, args: Record<string, any>, ctx: RpcContext) {
  const J = await import("../jobs/service");
  // Its own: the jobs it owns, and the run-owned ones it started (`--run`).
  const own = async (id: unknown) => {
    const jobId = String(id ?? "");
    const j = await J.ownJobOf(jobId, c.run, c.sub);
    if (!j) throw new RelayError("not_found", `job ${jobId.slice(0, 80)} isn't one of yours`, "capcomd job list shows your jobs.");
    return j;
  };
  if (op === "job.list") return { jobs: (await J.listJobs({ runId: c.run, of: c.sub })).map(jobView) };
  if (op === "job.kill") { const j = await own(args.job); return jobView(await J.cancelJob(j.jobId, `by ${c.sub}${args.reason ? `: ${String(args.reason).slice(0, 200)}` : ""}`, { runId: c.run, byOwner: true })); }
  if (op === "job.output") {
    const j = await own(args.job);
    const tail = Math.min(Math.max(Number(args.tail ?? 16_384) || 16_384, 1), 64 * 1024);
    const running = j.state === "running" || j.state === "stopping";
    const live = !running ? null : (await J.liveOutput(j, tail)) ?? (ctx.jobs && "agentId" in j.spec.owner ? await (await import("../jobs/machine")).tails(ctx.jobs, j.jobId, tail, tail).catch(() => null) : null);
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
  // `--run`: the run's job, in the run's job machine: it outlives this agent. Its own folder and PATH there, not this
  // shell's (the agent's checkout isn't in that machine).
  const ofRun = args.run === true;
  const cwd = !ofRun && typeof args.cwd === "string" && args.cwd.startsWith("/") ? args.cwd : undefined;
  // The agent's PATH, so the job finds what its shell does (its npm, its tools).
  const env = !ofRun && typeof args.path === "string" && args.path.length < 4096 ? { PATH: args.path } : undefined;
  const fg = args.foregroundMs !== undefined ? Number(args.foregroundMs) : undefined;
  if (fg !== undefined && !(Number.isInteger(fg) && fg >= 0)) throw new RelayError("usage", "--foreground-ms is a whole number of milliseconds", "e.g. --foreground-ms 1000.");
  const timeoutMs = args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined;
  const j = await J.startJob({ kind: "exec", runId: c.run, owner: ofRun ? { run: true } : { agentId: c.sub }, cmd, label: label || "job", ...(cwd ? { cwd } : {}), ...(env ? { env } : {}), ...(fg !== undefined ? { foregroundMs: fg } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
    { by: c.sub, machine: ctx.jobs, ...(args.key ? { key: `${c.sub}:${args.key}` } : {}), ...(Number(args.maxForegroundMs) > 0 ? { foregroundCapMs: Number(args.maxForegroundMs) } : {}) });
  const v = jobView(j);
  if (j.state !== "running") return v;
  const more = `capcomd job output ${j.jobId} shows its output so far; capcomd job kill ${j.jobId} stops it.`;
  return { ...v, hint: ofRun ? `Still running, in the run's job machine: it keeps running after you finish, until the run ends (or its timeout). Its result reaches you as a message while you run. ${more}` : `Still running: its result arrives as a message (capcomd inbox). ${more}` };
}

/** A job as the agent that owns it reads it: its own words are its own (not fenced). */
function jobView(j: import("../../packages/plugin/src/shapes").Job) {
  const res = j.result && "code" in j.result ? j.result : null;
  return {
    jobId: j.jobId, state: j.state, label: j.spec.label, startedAt: j.startedAt, endedAt: j.endedAt, reason: j.reason,
    ...("run" in j.spec.owner ? { run: true } : {}), ...(j.spec.kind === "exec" ? { cmd: j.spec.cmd } : {}), ...(res ? { code: res.code, stdout: res.stdout, stderr: res.stderr, truncated: res.truncated } : {}),
  };
}

const isWake = (args: Record<string, any>) => args.wake === true || args.wake === "true";

/** A duration: "90s", "5m", "2h", "1500ms", or a bare number of seconds. */
export function parseDuration(v: unknown): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr)?\s*$/i.exec(String(v ?? ""));
  if (!m) return null;
  const n = Number(m[1]), u = (m[2] ?? "s").toLowerCase();
  return Math.round(n * (u === "ms" ? 1 : u === "s" || u === "sec" ? 1000 : u === "m" || u === "min" ? 60_000 : 3600_000));
}

/** An agent can be woken only when it reads messages while it runs: a Codex agent reads none after its prompt. */
async function assertWakeable(c: Claims) {
  const me = await O.getAgentOrThrow(c.run, c.sub);
  if ((me.spec as { provider?: string } | null)?.provider === "codex")
    throw new RelayError("usage", "a Codex agent can't be woken: it reads no message after its prompt, so its turn ending ends it", "Wait without --wake (capcomd await, verify, check), or poll capcomd inbox.");
}

/** An op the agent may wait on: one it asked for, or one about an agent it may see. */
async function assertOpVisible(c: Claims, op: { id: string; data: Record<string, unknown> }) {
  if (op.data.askedBy === c.sub) return;
  const about = typeof op.data.agentId === "string" ? op.data.agentId : typeof op.data.ref === "string" && op.data.ref.startsWith("agt-") ? op.data.ref : null;
  const { ids } = await readable(c);
  if (!about || !ids.has(about)) deny(`${op.id} is not visible to ${c.sub}: it is about an agent outside your subtree and your siblings'`, "Wait on the verify, check or merge ids your own calls returned.");
}

/** A wake as the agent that armed it reads it (its note is its own). */
function wakeView(w: import("../actors/wakes").WakeRow) {
  return { wake: w.wakeId, state: w.state, kind: w.filter.kind, filter: w.filter.kind === "events" ? { ...w.filter, within: undefined } : w.filter, at: w.at, note: w.note, createdAt: w.createdAt, firedAt: w.firedAt, reason: w.reason };
}

/**
 * ADR-026 §3: arm a wake for the caller (src/actors/wakes.ts) and answer at once. The agent's turn can end: the wake's
 * message reaches it as its next turn. `in` (a duration) or `at` (an ISO time or epoch ms) is the time (a check-in),
 * or an event wake's deadline (default and most WAKE_MAX_MS).
 */
async function armWake(c: Claims, reqId: string, filter: Record<string, any>, args: Record<string, any>, extra: Record<string, unknown>) {
  await assertWakeable(c);
  const inMs = args.inMs !== undefined ? Number(args.inMs) : args.in !== undefined ? parseDuration(args.in) : undefined;
  if (inMs === null || (inMs !== undefined && !(Number.isFinite(inMs) && inMs >= 0))) throw new RelayError("usage", `--in ${String(args.in).slice(0, 40)}: not a duration`, "e.g. --in 10m, --in 90s, --in 2h.");
  const atArg = args.at !== undefined ? (/^\d+$/.test(String(args.at)) ? Number(args.at) : Date.parse(String(args.at))) : undefined;
  const asked = atArg !== undefined ? atArg : inMs !== undefined ? Date.now() + inMs : undefined;
  if (asked !== undefined && !(Number.isFinite(asked) && asked > Date.now() - 1000)) throw new RelayError("usage", "a wake's time must be in the future", "--in 10m (from now) or --at <ISO time>.");
  if (filter.kind === "timer" && asked === undefined) throw new RelayError("usage", "wake needs what to wait for (--op, --agents, --events) or a time (--in, --at)", "e.g. capcomd wake --in 10m --note \"look at the deploy\".");
  const max = WAKE_MAX_MS();
  if (asked !== undefined && asked > Date.now() + max + 1000) throw new RelayError("usage", `a wake can be set at most ${Math.round(max / 3600_000)} hours ahead`, "Wake sooner and arm another one then if you still need to wait.");
  const at = Math.min(asked ?? Date.now() + max, Date.now() + max);
  // Idempotent: a retried call (the CLI retries a transient failure with the same request id) arms one wake; the same
  // wait armed again while it still waits is that wake (scope wakeArm).
  const key = args.key !== undefined ? `wake:${String(args.key)}` : `req:${reqId}`;
  const r: any = await client().scope.getOrCreate([c.run]).wakeArm({ agentId: c.sub, filter, at, note: args.note !== undefined ? String(args.note).slice(0, 2000) : null, ...(key ? { key } : {}) }).catch(O.asRelay);
  const w = r.wake;
  // An op it waits on is restarted when the daemon starts again (src/primitives/wake-sweep.ts): nobody polls it.
  if (filter.kind === "op" && w.state === "armed") noteOpWake(c.run);
  return {
    ...extra, wake: w.wakeId, wakeState: w.state, wakeKind: w.filter.kind, wakeAt: w.at,
    hint: w.state === "fired" ? "It already happened: the wake-up message is in your inbox (capcomd inbox), and reaches you as your next message."
      : "End your turn now (don't poll, sleep or wait in a tool call): the wake-up comes to you as a message when it happens, or at its time.",
  };
}

/** A check takes as long as the checks: answer "running" (with its id, which the CLI polls) after VERIFY_HOLD_MS. */
async function holdCheck(id: string, done: Promise<any>, holdMs = VERIFY_HOLD_MS) {
  done.catch(() => {}); // a later poll gets the error
  const held = await Promise.race([done.catch((e) => { if (transportTimeout(e)) return null; throw e; }), new Promise((r) => setTimeout(() => r(null), holdMs))]);
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
