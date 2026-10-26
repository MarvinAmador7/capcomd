// UI-state mock for design fidelity work: serves a fixed scene (runs, agents, approvals, steps) so the menu bar app can
// be put next to the mockups in apps/menubar/design. Unlike server.ts (the scripted contract fixture the store tests
// use), nothing here drops, resets or replays: every stream sends one snapshot and then heartbeats.
//
//   SCENARIO=panel TOKEN=… bun scenarios.ts /tmp/capcomd-ui.sock
//   swift run CapcomdMenuBar -capcomd.socketPath /tmp/capcomd-ui.sock     (argument domain: nothing is persisted)
//
// Scenes: panel (tree-card-v3.png). The daemon snapshot carries agents and their agent.spawned envelopes too, so the
// store's rebuild picks up repo/key (scope chips, suffixes) without a run stream; lifecycle feeds re-send the same
// state per run. Repos ride in `agent.spawned.data.agent.repo` (the contract leaves `agent` open).
import { chmodSync, existsSync, unlinkSync } from "node:fs";

const sock = process.argv[2] ?? process.env.SOCK ?? "/tmp/capcomd-ui.sock";
const TOKEN = process.env.TOKEN ?? "test-token";
const SCENARIO = process.env.SCENARIO ?? "panel";
const NOW = Date.now(), min = 60_000, iso = (ms: number) => new Date(ms).toISOString();

type AgentSpec = { id: string; parent?: string; profile: string; status: string; repo?: string; key?: string; text?: string; ago: number };
type ApprovalSpec = { id: string; agentId: string; question: string; ref: string; target: string };
type RunSpec = { id: string; projectId: string; goal: string; state: string; startedAgo: number; lastAgo: number; agents: AgentSpec[]; approvals?: ApprovalSpec[] };

const scenes: Record<string, RunSpec[]> = {
  // tree-card-v3.png: approval-tinted card with a nested tree, a quiet running card, one finished project.
  panel: [
    { id: "run-mk32", projectId: "prj-matchkey", goal: "Migrate matchkey to v3.2", state: "running", startedAgo: 6.25 * min, lastAgo: 0.1 * min,
      agents: [
        { id: "agt-pl01", profile: "planner", status: "running", ago: 6.2 * min },
        { id: "agt-wk01", parent: "agt-pl01", profile: "worker", status: "done", repo: "matchkey", key: "task-7a10", ago: 6 * min },
        { id: "agt-ld01", parent: "agt-pl01", profile: "lead", status: "running", repo: "ids/v1", key: "task-1b2c", ago: 5.5 * min },
        { id: "agt-wk02", parent: "agt-ld01", profile: "worker", status: "running", repo: "ids/v1", key: "task-d3ce", ago: 5 * min },
        { id: "agt-wk04", parent: "agt-wk02", profile: "worker", status: "done", repo: "ids/v1", key: "task-90ab", ago: 4 * min },
        { id: "agt-wk03", parent: "agt-ld01", profile: "worker", status: "running", repo: "ids/v1", key: "task-4423", ago: 4.5 * min },
        { id: "agt-cr01", parent: "agt-pl01", profile: "critic", status: "pending", repo: "addriva", key: "task-c0de", ago: 4.4 * min },
      ],
      approvals: [{ id: "apr-mk1", agentId: "agt-wk03", question: "Merge backfill into main?", ref: "fix/backfill", target: "main" }] },
    { id: "run-pr01", projectId: "prj-billing", goal: "Fix proration rounding in billing", state: "running", startedAgo: 2 * min, lastAgo: 0.5 * min,
      agents: [{ id: "agt-pl02", profile: "planner", status: "running", repo: "relay", ago: 2 * min }] },
    { id: "run-av01", projectId: "prj-addriva", goal: "Launch Addriva Verify docs", state: "completed", startedAgo: 30 * min, lastAgo: 26 * min,
      agents: [{ id: "agt-pl03", profile: "planner", status: "done", repo: "addriva", ago: 30 * min }] },
  ],
};
const runs = scenes[SCENARIO];
if (!runs) { console.error(`unknown SCENARIO ${SCENARIO}; one of ${Object.keys(scenes).join(", ")}`); process.exit(2); }

// Envelopes in seq order across all runs (run.created, agent.spawned, approval.requested).
let seq = 0;
const envelopes: any[] = [];
const env = (r: RunSpec, type: string, entity: string, agentId: string | null, ms: number, data: any) =>
  envelopes.push({ v: 1, id: `evt_${++seq}`, scope: r.id, seq, entity, entitySeq: 1, type, typeVersion: 1, durability: "durable",
    ts: iso(ms), epochMs: ms, projectId: r.projectId, runId: r.id, agentId, data });
for (const r of runs) {
  env(r, "run.created", r.id, null, NOW - r.startedAgo, { runId: r.id, budget: {}, label: null, goal: r.goal });
  for (const a of r.agents) env(r, "agent.spawned", a.id, a.id, NOW - a.ago, { parent: a.parent ?? null, depth: depthOf(r, a), profile: a.profile,
    budget: {}, limits: {}, agent: a.repo ? { repo: a.repo } : {}, task: null, key: a.key ?? null, operator: false });
  for (const p of r.approvals ?? []) env(r, "approval.requested", p.id, p.agentId, NOW - r.lastAgo, { approvalId: p.id, kind: "merge", question: p.question,
    requestedBy: { agentId: p.agentId, runId: r.id }, subject: { ref: p.ref, target: p.target }, expiresAt: null });
  env(r, "run.started", r.id, null, NOW - r.lastAgo, { cause: "started" });   // bumps lastEventMs to the run's recency
}
function depthOf(r: RunSpec, a: AgentSpec): number { let d = 0, p = a.parent; while (p) { d++; p = r.agents.find(x => x.id === p)?.parent; } return d; }
const HEAD = seq;

const runBody = (r: RunSpec) => ({ id: r.id, projectId: r.projectId, label: null, state: r.state, goal: r.goal, repo: null, createdAt: iso(NOW - r.startedAgo) });
const agentBody = (r: RunSpec, a: AgentSpec) => ({ id: a.id, runId: r.id, parent: a.parent ?? null, depth: depthOf(r, a), profile: a.profile, status: a.status,
  text: a.text ?? null, task: null, taskAttachment: null, result: null, updatedAt: iso(NOW - a.ago) });
const approvalBody = (r: RunSpec, p: ApprovalSpec) => ({ approvalId: p.id, kind: "merge", status: decided.has(p.id) ? decided.get(p.id).status : "pending",
  question: p.question, requestedBy: { agentId: p.agentId, runId: r.id }, subject: { ref: p.ref, target: p.target } });
const decided = new Map<string, any>();

const sse = (id: number | null, event: string, data: unknown) => (id !== null ? `id: ${id}\n` : "") + `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
/** A full snapshot of `rs`, ending at HEAD. */
const snapshot = (rs: RunSpec[]) =>
  sse(null, "stream.reset", { snapshotSeq: HEAD, reason: "compacted" })
  + rs.map(r => sse(null, "snapshot.run", { run: runBody(r) })).join("")
  + sse(null, "snapshot.agents", { agents: rs.flatMap(r => r.agents.map(a => agentBody(r, a))) })
  + sse(null, "snapshot.approvals", { approvals: rs.flatMap(r => (r.approvals ?? []).map(p => approvalBody(r, p))) })
  + sse(null, "snapshot.steps", { steps: envelopes.filter(e => rs.some(r => r.id === e.runId)) })
  + sse(null, "snapshot.threads", { messages: [] })
  + sse(HEAD, "snapshot.end", { snapshotSeq: HEAD });

const err = (status: number, code: string, message: string) => Response.json({ code, message }, { status });
if (existsSync(sock)) unlinkSync(sock);
Bun.serve({
  unix: sock,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url), p = url.pathname;
    if (p === "/v1/health") return Response.json({ ok: true, api: "harness.v1", version: `mock-ui-${SCENARIO}` });
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return err(401, "unauthorized", "missing or invalid bearer token");
    if (p === "/v1/runs") return Response.json(runs.map(runBody));
    const m = p.match(/^\/v1\/approvals\/([A-Za-z0-9_-]+)\/decision$/);
    if (m && req.method === "POST") {
      const body: any = await req.json();
      if (decided.has(m[1])) return Response.json({ code: "already_decided", message: "approval already decided", decision: decided.get(m[1]) }, { status: 409 });
      const res = { approvalId: m[1], status: body?.decision === "deny" ? "denied" : "approved", decidedBy: { clientId: "menubar", principal: "you" },
        decidedAt: iso(Date.now()), reason: null };
      decided.set(m[1], res);
      return Response.json(res);
    }
    const s = p.match(/^\/v1\/streams\/([^/]+)\/events$/);
    if (!s) return err(404, "not_found", "no such route");
    const scope = s[1], picked = scope === "daemon" ? runs : runs.filter(r => r.id === scope);
    let hb: ReturnType<typeof setInterval> | undefined;
    return new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(snapshot(picked)));
        hb = setInterval(() => { try { c.enqueue(new TextEncoder().encode(": heartbeat\n\n")); } catch { clearInterval(hb); } }, 15_000);
      },
      cancel() { clearInterval(hb); },
    }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  },
});
chmodSync(sock, 0o600);
console.log(`scenario ${SCENARIO}: ${runs.length} runs, ${HEAD} events on unix:${sock}`);
