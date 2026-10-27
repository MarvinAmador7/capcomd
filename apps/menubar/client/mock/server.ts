// Mock capcomd harness API on a 0600 Unix socket.
// Contract: MarvinAmador7/capcomd PR #40 (lifecycle events) — openapi/capcomd.json, docs/events.md. Check with validate.ts.
// Routes: GET /v1/health (no token), /v1/runs, /v1/runs/:runId, /v1/runs/:runId/agents, /v1/runs/:runId/lifecycle?after=
//         (404 for an unknown run), /v1/events?scope&after, GET /v1/streams/:scope/events[?feed=lifecycle] (SSE),
//         POST /v1/approvals/:approvalId/decision (Idempotency-Key required). With SETTINGS=<scene> (settings.ts): also
//         GET /v1/logins, /v1/environments, /v1/service, /v1/run-options and their capabilities in /v1/health.
// SSE frames per contract: `id: <seq>` / `event: <type>` / `data: <envelope>`; `event: stream.reset` {snapshotSeq, reason}
//   then snapshot.run / agents / approvals / steps / threads / snapshot.end {snapshotSeq}, then live from snapshotSeq+1;
//   `: heartbeat` comment every HEARTBEAT_MS (default 15000).
// Script per server lifetime on run-demo: conn #1 sends 1..12, then reset(overflow, snapshotSeq 12) + snapshot, then live 13..22
//   and is dropped abruptly; conn #2 deliberately re-sends its Last-Event-ID seq (exercise dedupe) and finishes at 30.
//   Any Last-Event-ID below COMPACTED_BELOW gets reset(compacted) with a snapshot at head.
// Test-only scopes: run-silent sends nothing at all (no heartbeat) to exercise the client's dead-socket timeout;
//   daemon sends a compacted reset with the head snapshot (approvals carry requestedBy/subject), then heartbeats only.
// Lifecycle feed (run-demo?feed=lifecycle), projected like src/api/lifecycle.ts: run.created, agent.spawned, agent.started
//   (from status_changed→running), approval.*, each with data.cause; run.started {cause, agentId} shares agt-1's start seq.
//   Shared-seq groups go out in ONE enqueue and only the group's LAST frame carries `id:`.
//   Script: lifecycle conn #1 (no Last-Event-ID) sends snapshot.run/agents/approvals + snapshot.end (`id: 1`), then seq 2, then
//   only the first frame of the seq-4 group (agent.started, no id) and drops. Conn #2 resumes from Last-Event-ID 2, so the whole
//   seq-4 group is re-sent; the client must deliver run.started (and agent.started) exactly once. Then heartbeats only.
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { settingsCaps, settingsRoute, settingsRunOptions, settingsScene } from "./settings";
const sock = process.argv[2] ?? process.env.SOCK ?? "/tmp/harness.sock";
const TOKEN = process.env.TOKEN ?? "test-token";
// SETTINGS=<scene> (settings.ts) adds the Settings routes, run-options and their capabilities; unset, none of them.
const settings = process.env.SETTINGS ? settingsScene(process.env.SETTINGS) : null;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 15000);
const RESET_AFTER = 12, DROP_AFTER = 22, COMPACTED_BELOW = 3, RUN = "run-demo", PRJ = "prj-demo", GOAL = "ship transport spike";
const T0 = Date.UTC(2026, 9, 25, 6, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString(); // contract: UTC, exactly 3 ms digits
const err = (status: number, code: string, message: string, extra: object = {}) => Response.json({ code, message, ...extra }, { status });

// Fixture: 30 durable events using only docs/events.md types and their required payload fields.
const fixture: any[] = [];
// Envelope `text`: daemon-written plain sentence (mirrors src/api/describe.ts for the types used here).
const describe = (type: string, d: any, agentId: string | null) => {
  const a = agentId ? `Agent ${agentId}` : "The run";
  switch (type) {
    case "run.created": return "Run created.";
    case "agent.spawned": return `${a} was started${d.parent ? ` by ${d.parent}` : ""}${d.profile ? ` as ${d.profile}` : ""}.`;
    case "agent.status_changed": return `${a} is now ${d.status}.`;
    case "approval.requested": return `Waiting for your approval (${d.kind}).`;
    case "approval.decided": return `Approval ${d.status}.`;
    default: return type.replace(/[._]/g, " ") + ".";
  }
};
const push = (type: string, entity: string, agentId: string | null, data: any) => {
  const seq = fixture.length + 1, ms = T0 + seq * 1000;
  fixture.push({ v: 1, id: `evt_${seq}`, scope: RUN, seq, entity, entitySeq: fixture.filter(e => e.entity === entity).length + 1,
    type, typeVersion: 1, durability: "durable", ts: iso(ms), epochMs: ms, projectId: PRJ, runId: RUN, agentId, text: describe(type, data, agentId), data });
};
push("run.created", RUN, null, { runId: RUN, budget: {}, label: "demo", goal: GOAL });
for (let i = 1; fixture.length < 30; i++) {
  const a = `agt-${i}`;
  push("agent.spawned", a, a, { parent: i === 1 ? null : "agt-1", depth: i === 1 ? 0 : 1, profile: i === 1 ? "planner" : "worker",
    budget: {}, limits: {}, agent: {}, task: `Task ${i}`, key: i === 1 ? null : `task-${i}`, operator: false });
  for (const s of ["pending", "running"]) if (fixture.length < 30) push("agent.status_changed", a, a, { agentId: a, status: s });
  if (fixture.length < 30) push("approval.requested", `apr-${i}`, a, { approvalId: `apr-${i}`, kind: "merge",
    question: `Merge task ${i} into main?`, requestedBy: { agentId: a, runId: RUN }, subject: { target: "main", ref: `fix/task-${i}` }, expiresAt: null });
  if (fixture.length < 30) push("approval.decided", `apr-${i}`, a, { approvalId: `apr-${i}`, status: "approved",
    decidedBy: { clientId: "cli", principal: "marvin" }, decidedAt: iso(T0), reason: null });
}
const TOTAL = fixture.length;

// Lifecycle projection of the fixture (mirrors src/api/lifecycle.ts for the types the fixture has).
const lifecycle: any[] = [];
{
  let started = false;
  for (const e of fixture) {
    if (e.type === "run.created") lifecycle.push({ ...e, data: { ...e.data, cause: "created" } });
    else if (e.type === "agent.spawned") lifecycle.push({ ...e, data: { ...e.data, cause: "spawned" } });
    else if (e.type === "agent.status_changed" && e.data.status === "running") {
      lifecycle.push({ ...e, type: "agent.started", text: `Agent ${e.agentId} started.`, data: { cause: "started" } });
      if (!started) {
        started = true;
        lifecycle.push({ ...e, id: `evt_${RUN}_${e.seq}_run.started`, entity: RUN, entitySeq: 2, type: "run.started", text: "The run started.",
          agentId: e.agentId, data: { cause: "started", agentId: e.agentId } });
      }
    } else if (e.type === "approval.requested") lifecycle.push({ ...e, data: { ...e.data, cause: "approval_needed" } });
    else if (e.type === "approval.decided") lifecycle.push({ ...e, data: { ...e.data, cause: e.data.status } });
  }
}
/** Lifecycle envelopes with seq > after, grouped by shared seq (in order). */
const lifecycleGroups = (after: number) => {
  const groups: any[][] = [];
  for (const e of lifecycle.filter(e => e.seq > after)) {
    const g = groups.at(-1);
    if (g && g[0].seq === e.seq) g.push(e); else groups.push([e]);
  }
  return groups;
};
const LC_SNAPSHOT = 1, LC_CUT_SEQ = 4;

// State at seq s, in the contract's snapshot.* shapes.
const runBody = { id: RUN, projectId: PRJ, label: "demo", state: "running", goal: GOAL, repo: "/tmp/demo-repo", createdAt: iso(T0 + 1000) };
const agentNode = (e: any, status: string, updatedMs: number) => ({ id: e.agentId, runId: RUN, parent: e.data.parent, depth: e.data.depth,
  profile: e.data.profile, status, text: `${e.data.profile} is ${status}`, task: e.data.task, taskAttachment: null, result: null, updatedAt: iso(updatedMs) });
const agentsAt = (s: number) => {
  const agents = new Map<string, any>();
  for (const e of fixture.slice(0, s)) {
    if (e.type === "agent.spawned") agents.set(e.agentId, agentNode(e, "pending", e.epochMs));
    if (e.type === "agent.status_changed") { const a = agents.get(e.data.agentId); a.status = e.data.status; a.text = `${a.profile} is ${e.data.status}`; a.updatedAt = e.ts; }
  }
  return [...agents.values()];
};
const snapshotFrames = (s: number) => {
  const ev = fixture.slice(0, s), approvals = new Map<string, any>();
  for (const e of ev) {
    if (e.type === "approval.requested") approvals.set(e.data.approvalId, { approvalId: e.data.approvalId, kind: e.data.kind, status: "pending", question: e.data.question,
      requestedBy: e.data.requestedBy, subject: e.data.subject });
    if (e.type === "approval.decided") approvals.delete(e.data.approvalId);
  }
  return [
    ["snapshot.run", { run: runBody }],
    ["snapshot.agents", { agents: agentsAt(s) }],
    ["snapshot.approvals", { approvals: [...approvals.values()] }],
    ["snapshot.steps", { steps: ev.slice(-200) }],
    ["snapshot.threads", { messages: [] }],
    ["snapshot.end", { snapshotSeq: s }],
  ] as const;
};

const decisions = new Map<string, any>();
const idem = new Map<string, { body: string; res: any }>();
let conns = 0, lcConns = 0; const log: string[] = [];
if (existsSync(sock)) unlinkSync(sock);
const sse = (id: number | null, event: string, data: unknown) =>
  (id !== null ? `id: ${id}\n` : "") + `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
/** One shared-seq group as a single string: only the LAST frame carries `id:` (like sendGroups in src/api/server.ts). */
const group = (g: any[]) => g.map((e, i) => sse(i === g.length - 1 ? e.seq : null, e.type, e)).join("");

Bun.serve({
  unix: sock,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url), p = url.pathname;
    if (p === "/v1/health") return Response.json({ ok: true, api: "harness.v1", version: "mock-pr40", ...(settings ? { capabilities: settingsCaps(settings) } : {}) });
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return err(401, "unauthorized", "missing or invalid bearer token");
    if (settings) {
      const r = settingsRoute(p, settings);
      if (r) return r;
      if (p === "/v1/run-options") return Response.json(settingsRunOptions(settings));
    }
    if (p === "/__log") return Response.json({ conns, log });
    if (p === "/v1/runs") return Response.json([runBody]);
    if (p === `/v1/runs/${RUN}`) return Response.json(runBody);
    if (p === `/v1/runs/${RUN}/agents`) return Response.json(agentsAt(TOTAL));
    if (p === `/v1/runs/${RUN}/lifecycle`) { const after = Number(url.searchParams.get("after") ?? 0); return Response.json(lifecycle.filter(e => e.seq > after)); }
    if (/^\/v1\/runs\/[^/]+(\/agents|\/lifecycle)?$/.test(p)) return err(404, "not_found", "no such run");
    if (p === "/v1/events") { const after = Number(url.searchParams.get("after") ?? 0); return Response.json(fixture.filter(e => e.scope === url.searchParams.get("scope") && e.seq > after)); }

    const m = p.match(/^\/v1\/approvals\/(apr-[A-Za-z0-9]+)\/decision$/);
    if (m && req.method === "POST") {
      const key = req.headers.get("idempotency-key");
      if (key === null || key.length < 8 || key.length > 200) return err(422, "invalid", "Idempotency-Key header required (8-200 chars)");
      const body: any = await req.json();
      if (body?.decision !== "approve" && body?.decision !== "deny") return err(422, "invalid", "decision must be approve or deny");
      if (!fixture.some(e => e.type === "approval.requested" && e.data.approvalId === m[1])) return err(404, "not_found", "no such approval");
      // Same key+body replays; same key+other body 409 idempotency_conflict; new key on a decided approval 409 already_decided.
      const k = `${TOKEN}:${key}`, prior = idem.get(k);
      if (prior) return prior.body === JSON.stringify(body) ? Response.json(prior.res) : err(409, "idempotency_conflict", "key reused with a different body");
      const preDecided = fixture.find(e => e.type === "approval.decided" && e.data.approvalId === m[1]);
      const existing = decisions.get(m[1]) ?? (preDecided ? { approvalId: m[1], ...preDecided.data } : undefined);
      if (existing) return err(409, "already_decided", "approval already decided", { decision: existing });
      const res = { approvalId: m[1], status: body.decision === "approve" ? "approved" : "denied",
        decidedBy: { clientId: "menubar", principal: "marvin" }, decidedAt: iso(Date.now()), reason: body.reason ?? null };
      decisions.set(m[1], res); idem.set(k, { body: JSON.stringify(body), res });
      return Response.json(res);
    }

    const s = p.match(/^\/v1\/streams\/([^/]+)\/events$/);
    if (!s) return err(404, "not_found", "no such route");
    const scope = s[1];
    if (!/^(daemon|prj-[A-Za-z0-9_-]+|run-[A-Za-z0-9_-]+)$/.test(scope)) return err(422, "invalid", "bad scope");
    const feed = url.searchParams.get("feed");
    if (feed !== null && feed !== "lifecycle") return err(422, "invalid", "feed must be lifecycle");
    if (feed === "lifecycle" && !scope.startsWith("run-")) return err(422, "invalid", "lifecycle feed is for run scopes");
    const enc = new TextEncoder();
    const headers = { "content-type": "text/event-stream", "cache-control": "no-cache" };
    if (scope === "run-silent") return new Response(new ReadableStream({ start() {} }), { headers });
    let hb: ReturnType<typeof setInterval> | undefined;
    const startHeartbeat = (c: ReadableStreamDefaultController) => { hb = setInterval(() => { try { c.enqueue(enc.encode(": heartbeat\n\n")); } catch { clearInterval(hb); } }, HEARTBEAT_MS); };
    if (scope === "daemon") return new Response(new ReadableStream({ start(c) {
      c.enqueue(enc.encode(sse(null, "stream.reset", { snapshotSeq: TOTAL, reason: "compacted" })));
      for (const [name, d] of snapshotFrames(TOTAL)) c.enqueue(enc.encode(sse(null, name, d)));
      startHeartbeat(c);
    }, cancel() { clearInterval(hb); } }), { headers });
    if (scope !== RUN) return new Response(new ReadableStream({ start: startHeartbeat, cancel() { clearInterval(hb); } }), { headers });
    if (feed === "lifecycle") {
      const n = ++lcConns, lastId = req.headers.get("last-event-id"), after = Number(lastId ?? 0);
      log.push(`lc${n} after=${lastId === null ? "none" : after}`);
      return new Response(new ReadableStream({
        async start(c) {
          startHeartbeat(c);
          const snapshot = (at: number) => {
            const ev = fixture.slice(0, at), approvals = new Map<string, any>();
            for (const e of ev) {
              if (e.type === "approval.requested") approvals.set(e.data.approvalId, { approvalId: e.data.approvalId, kind: e.data.kind, status: "pending",
                question: e.data.question, requestedBy: e.data.requestedBy, subject: e.data.subject });
              if (e.type === "approval.decided") approvals.delete(e.data.approvalId);
            }
            c.enqueue(enc.encode(sse(null, "snapshot.run", { run: runBody }) + sse(null, "snapshot.agents", { agents: agentsAt(at) })
              + sse(null, "snapshot.approvals", { approvals: [...approvals.values()] }) + sse(at, "snapshot.end", { snapshotSeq: at })));
          };
          let from = after;
          if (lastId === null) { snapshot(LC_SNAPSHOT); from = LC_SNAPSHOT; }
          else if (after > TOTAL) { c.enqueue(enc.encode(sse(null, "stream.reset", { snapshotSeq: TOTAL, reason: "compacted" }))); snapshot(TOTAL); from = TOTAL; }
          for (const g of lifecycleGroups(from)) {
            await Bun.sleep(5);
            if (n === 1 && g[0].seq === LC_CUT_SEQ) {   // cut mid-group: first frame (no id) only, then the socket dies
              c.enqueue(enc.encode(sse(null, g[0].type, g[0]))); await Bun.sleep(5);
              clearInterval(hb); c.error(new Error("simulated drop mid-group")); return;
            }
            c.enqueue(enc.encode(group(g)));
          }
        },
        cancel() { clearInterval(hb); },
      }), { headers });
    }

    const n = ++conns;
    const lastId = req.headers.get("last-event-id");
    const after = Number(lastId ?? url.searchParams.get("after") ?? 0);
    log.push(`conn${n} after=${after}`);
    return new Response(new ReadableStream({
      async start(c) {
        startHeartbeat(c);
        const finish = () => { clearInterval(hb); c.close(); };
        const reset = (snapshotSeq: number, reason: string) => {
          c.enqueue(enc.encode(sse(null, "stream.reset", { snapshotSeq, reason })));
          for (const [name, d] of snapshotFrames(snapshotSeq)) c.enqueue(enc.encode(sse(null, name, d)));
        };
        let from = after + 1;
        if (lastId !== null && after < COMPACTED_BELOW) { reset(TOTAL, "compacted"); return finish(); }
        if (n > 1 && after > 0) from = after; // re-send the cursor's frame: client must dedupe
        for (let q = from; q <= TOTAL; q++) {
          await Bun.sleep(5);
          c.enqueue(enc.encode(sse(q, fixture[q - 1].type, fixture[q - 1])));
          if (n === 1 && q === RESET_AFTER) reset(q, "overflow");
          if (n === 1 && q === DROP_AFTER) { clearInterval(hb); c.error(new Error("simulated drop")); return; }
        }
        finish();
      },
      cancel() { clearInterval(hb); },
    }), { headers });
  },
});
chmodSync(sock, 0o600);
console.log(`listening unix:${sock} (${TOTAL} events)`);
