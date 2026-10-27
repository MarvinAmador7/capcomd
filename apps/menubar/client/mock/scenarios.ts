// UI-state mock for design fidelity work: serves a fixed scene (runs, agents, approvals, steps) so the menu bar app can
// be put next to the mockups in apps/menubar/design. Unlike server.ts (the scripted contract fixture the store tests
// use), nothing here drops, resets or replays: every stream sends one snapshot and then heartbeats.
//
//   SCENARIO=panel TOKEN=… bun scenarios.ts /tmp/capcomd-ui.sock
//   swift run CapcomdMenuBar -capcomd.socketPath /tmp/capcomd-ui.sock     (argument domain: nothing is persisted)
//
// Scenes: panel (tree-card-v3.png), finished (no active work: done/failed/stopped rows), run (view-activity/view-trace/drill-a2-*:
// trace spans, transcript, files and pause/resume/cancel for run-mk32). The daemon snapshot carries agents and their agent.spawned envelopes too, so the
// store's rebuild picks up repo/key (scope chips, suffixes) without a run stream; lifecycle feeds re-send the same
// state per run. Folders ride in `Agent.workspace` / `agent.spawned.data.workspace` (harness #46).
// The lead (agt-ld01) has a structured thread (threads.ts; THREAD=golden swaps in the daemon's golden session), and a
// steer to it gets a live reply on connections that asked for ?thread=1.
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { ThreadStore, goldenThread, leadThread, withDiff } from "./threads";

const sock = process.argv[2] ?? process.env.SOCK ?? "/tmp/capcomd-ui.sock";
const TOKEN = process.env.TOKEN ?? "test-token";
const SCENARIO = process.env.SCENARIO ?? "panel";
const NOW = Date.now(), min = 60_000, iso = (ms: number) => new Date(ms).toISOString();

type AgentSpec = { id: string; parent?: string; profile: string; provider?: "claude" | "codex"; status: string; repo?: string; key?: string; activity?: string; kind?: string; task?: string; ago: number };
type ApprovalSpec = { id: string; agentId: string; question: string; ref: string; target: string };
type SpanSpec = { id: string; parent?: string; name: string; from: number; took: number; error?: boolean; attrs?: Record<string, unknown> };   // from/took: seconds after the run started
type FileSpec = { path: string; status: string; added: number | null; removed: number | null; agentId: string };
type RunSpec = { id: string; projectId: string; goal: string; state: string; startedAgo: number; lastAgo: number; agents: AgentSpec[]; approvals?: ApprovalSpec[];
  spans?: SpanSpec[]; transcript?: Record<string, string[]>; files?: FileSpec[] };

const scenes: Record<string, RunSpec[]> = {
  // tree-card-v3.png: approval-tinted card with a nested tree, a quiet running card, one finished project.
  panel: [
    { id: "run-mk32", projectId: "prj-matchkey", goal: "Migrate matchkey to v3.2", state: "running", startedAgo: 6.25 * min, lastAgo: 0.1 * min,
      agents: [
        { id: "agt-pl01", profile: "planner", status: "running", ago: 6.2 * min },
        { id: "agt-wk01", parent: "agt-pl01", profile: "worker", status: "done", repo: "matchkey", key: "task-7a10", ago: 6 * min },
        { id: "agt-ld01", parent: "agt-pl01", profile: "lead", status: "running", repo: "ids/v1", key: "task-1b2c", activity: "Reading 4 files", ago: 5.5 * min },
        { id: "agt-wk02", parent: "agt-ld01", profile: "worker", status: "running", repo: "ids/v1", key: "task-d3ce", activity: "Writing parquet shards to R2", ago: 5 * min },
        { id: "agt-wk04", parent: "agt-wk02", profile: "worker", status: "done", repo: "ids/v1", key: "task-90ab", ago: 4 * min },
        { id: "agt-wk03", parent: "agt-ld01", profile: "worker", status: "running", repo: "ids/v1", key: "task-4423", ago: 4.5 * min },
        { id: "agt-cr01", parent: "agt-pl01", profile: "critic", status: "pending", repo: "addriva", key: "task-c0de", ago: 4.4 * min },
      ],
      approvals: [{ id: "apr-mk1", agentId: "agt-wk03", question: "Merge backfill into main?", ref: "fix/backfill", target: "main" }] },
    { id: "run-pr01", projectId: "prj-billing", goal: "Fix proration rounding in billing", state: "running", startedAgo: 2 * min, lastAgo: 0.5 * min,
      agents: [{ id: "agt-pl02", profile: "planner", status: "running", repo: "relay", activity: "Reading the proration module", ago: 2 * min }] },
    { id: "run-av01", projectId: "prj-addriva", goal: "Launch Addriva Verify docs", state: "completed", startedAgo: 30 * min, lastAgo: 26 * min,
      agents: [
        { id: "agt-pl03", profile: "planner", status: "done", repo: "addriva", ago: 30 * min },
        { id: "agt-wk05", parent: "agt-pl03", profile: "worker", status: "done", repo: "relay", key: "task-5e11", ago: 29 * min },
        { id: "agt-wk06", parent: "agt-pl03", profile: "worker", status: "done", repo: "docs", key: "task-6f22", ago: 29 * min },
      ] },
    // An earlier run of the matchkey project that finished: it must not appear in the card (finished runs leave it).
    { id: "run-mk31", projectId: "prj-matchkey", goal: "Migrate matchkey to v3.2", state: "completed", startedAgo: 120 * min, lastAgo: 100 * min,
      agents: [{ id: "agt-pl00", profile: "planner", status: "done", repo: "matchkey", ago: 120 * min }] },
  ],
  // view-activity / view-trace / drill-a2-*: one run seen from its drill-down.
  run: [
    { id: "run-mk32", projectId: "prj-matchkey", goal: "Migrate matchkey to v3.2", state: "running", startedAgo: 6.25 * min, lastAgo: 0.05 * min,
      agents: [
        { id: "agt-pl01", profile: "planner", status: "done", repo: "matchkey", activity: "Planned the work", kind: "plan", ago: 6 * min },
        { id: "agt-wk01", parent: "agt-pl01", profile: "worker", status: "done", repo: "ids/v1", key: "task-7a10", activity: "Read 4 files", kind: "read", ago: 5.8 * min },
        { id: "agt-ld01", parent: "agt-pl01", profile: "lead", status: "done", repo: "ids/v1", key: "task-1b2c", activity: "Started 2 sub-agents", kind: "spawn", ago: 5 * min },
        { id: "agt-wk02", parent: "agt-ld01", profile: "worker", status: "failed", repo: "ids/v1", key: "task-d3ce", activity: "Ran the tests", kind: "test", ago: 3 * min },
        { id: "agt-wk03", parent: "agt-ld01", profile: "worker", status: "running", repo: "ids/v1", key: "task-4423", activity: "Editing 3 files", kind: "edit", ago: 2 * min },
        { id: "agt-cr01", parent: "agt-pl01", profile: "critic", status: "pending", repo: "addriva", key: "task-c0de", task: "Validate row counts", ago: 1.5 * min },
        { id: "agt-cr02", parent: "agt-pl01", profile: "critic", status: "pending", repo: "matchkey", key: "task-c0df", task: "Commit to matchkey", ago: 1.4 * min },
      ],
      spans: [
        { id: "s1", name: "sandbox.ensure", from: 2, took: 6, attrs: { "sandbox.provider": "boxd" } },
        { id: "s1a", parent: "s1", name: "sandbox.waitReady", from: 3, took: 4 },
        { id: "s1b", parent: "s1", name: "actor.scope.kvGet", from: 4, took: 1 },
        { id: "s2", name: "agent.claude_code", from: 9, took: 33, attrs: { "agent.kind": "claude" } },
        { id: "s3", name: "transition.task", from: 40, took: 1 },
        { id: "s4", name: "agent.claude_code", from: 60, took: 62 },
        { id: "s5", name: "agent.claude_code", from: 130, took: 9, error: true, attrs: { "agent.error_kind": "timeout" } },
        { id: "s6", name: "agent.claude_code", from: 140, took: 12 },
        { id: "s7", name: "git.push", from: 160, took: 4, attrs: { "git.operation": "push", "git.ref": "fix/backfill" } },
        { id: "s8", name: "agent.claude_code", from: 180, took: 108 },
      ],
      transcript: { "agt-wk03": [
        "reading ids/v1/schema.json", "shard 116/256 ok  412k rows", "shard 117/256 ok  409k rows", "shard 118/256 ok  415k rows",
        "writing shard 119 \u2192 r2://matchkey/v3.2/part-0119.parquet" ] },
      files: [
        { path: "matchkey/v3.2/schema.json", status: "modified", added: 42, removed: 0, agentId: "agt-wk03" },
        { path: "ids/v1/join_addriva_id.sql", status: "modified", added: 18, removed: 3, agentId: "agt-wk03" },
        { path: "addriva/src/matchkey.ts", status: "modified", added: 7, removed: 7, agentId: "agt-wk02" },
      ] },
  ],
  // Nothing active: finished, failed and stopped projects as one-line rows (newest first, at most three).
  finished: [
    { id: "run-f1", projectId: "prj-f1", goal: "Launch Addriva Verify docs", state: "completed", startedAgo: 30 * min, lastAgo: 26 * min,
      agents: [{ id: "agt-f1", profile: "planner", status: "done", repo: "addriva", ago: 30 * min },
               { id: "agt-f2", parent: "agt-f1", profile: "worker", status: "done", repo: "docs", key: "task-a1b2", ago: 29 * min }] },
    { id: "run-f2", projectId: "prj-f2", goal: "Fix proration rounding in billing", state: "failed", startedAgo: 15 * min, lastAgo: 3 * min,
      agents: [{ id: "agt-f3", profile: "planner", status: "failed", repo: "relay", ago: 15 * min }] },
    { id: "run-f3", projectId: "prj-f3", goal: "Bump the docker base image", state: "cancelled", startedAgo: 9 * min, lastAgo: 8.5 * min,
      agents: [{ id: "agt-f4", profile: "planner", status: "cancelled", ago: 9 * min }] },
    { id: "run-f4", projectId: "prj-f4", goal: "An older project past the three-row cap", state: "completed", startedAgo: 300 * min, lastAgo: 290 * min,
      agents: [{ id: "agt-f5", profile: "planner", status: "done", ago: 300 * min }] },
  ],
};
const runs = scenes[SCENARIO];
if (!runs) { console.error(`unknown SCENARIO ${SCENARIO}; one of ${Object.keys(scenes).join(", ")}`); process.exit(2); }

// Envelopes in seq order across all runs (run.created, agent.spawned, approval.requested).
/** Which AI an agent runs on (Agent.provider / agent.spawned agent.provider): workers on Codex, the rest on Claude, a mixed team. */
const providerOf = (a: { profile: string; provider?: string }) => a.provider ?? (a.profile === "worker" ? "codex" : "claude");
const specOf = (a: { profile: string; provider?: string }) => {
  const provider = providerOf(a);
  return { provider, kind: provider === "claude" ? "claude-code" : "codex", model: provider === "claude" ? "claude-opus-5-5" : "gpt-5-codex" };
};
let seq = 0;
const envelopes: any[] = [];
const env = (r: RunSpec, type: string, entity: string, agentId: string | null, ms: number, data: any) =>
  envelopes.push({ v: 1, id: `evt_${++seq}`, scope: r.id, seq, entity, entitySeq: 1, type, typeVersion: 1, durability: "durable",
    ts: iso(ms), epochMs: ms, projectId: r.projectId, runId: r.id, agentId, data });
for (const r of runs) {
  env(r, "run.created", r.id, null, NOW - r.startedAgo, { runId: r.id, budget: {}, label: null, goal: r.goal });
  for (const a of r.agents) env(r, "agent.spawned", a.id, a.id, NOW - a.ago, { parent: a.parent ?? null, depth: depthOf(r, a), profile: a.profile,
    budget: {}, limits: {}, agent: specOf(a), task: a.task ?? null, key: a.key ?? null, operator: false, workspace: workspaceOf(a) });
  for (const p of r.approvals ?? []) env(r, "approval.requested", p.id, p.agentId, NOW - r.lastAgo, { approvalId: p.id, kind: "merge", question: p.question,
    requestedBy: { agentId: p.agentId, runId: r.id }, subject: { ref: p.ref, target: p.target }, expiresAt: null });
  env(r, "run.started", r.id, null, NOW - r.lastAgo, { cause: "started" });   // bumps lastEventMs to the run's recency
  const end = { completed: "run.completed", failed: "run.failed", cancelled: "run.cancelled" }[r.state];
  if (end) env(r, end, r.id, null, NOW - r.lastAgo, { cause: r.state });
}
/** harness #46 Agent.workspace: a folder like "ids/v1" is a sub-path of its repo; "matchkey" is a repo of its own. */
function workspaceOf(a: AgentSpec) {
  if (!a.repo) return null;
  const [repo, ...rest] = a.repo.split("/");
  return { repo: `/src/${repo}`, path: rest.length ? a.repo : null, label: a.repo };
}
function depthOf(r: RunSpec, a: AgentSpec): number { let d = 0, p = a.parent; while (p) { d++; p = r.agents.find(x => x.id === p)?.parent; } return d; }
const HEAD = seq;

const runBody = (r: RunSpec) => ({ id: r.id, projectId: r.projectId, label: null, state: r.state, goal: r.goal, repo: null, createdAt: iso(NOW - r.startedAgo) });
const agentBody = (r: RunSpec, a: AgentSpec) => ({ id: a.id, runId: r.id, parent: a.parent ?? null, depth: depthOf(r, a), profile: a.profile, status: a.status,
  text: `Agent ${a.id} is now ${a.status}.`, activity: a.activity ? { text: a.activity, kind: a.kind ?? "read", at: iso(NOW - a.ago) } : null,
  task: a.task ?? null, taskAttachment: null, result: null, workspace: workspaceOf(a), updatedAt: iso(NOW - a.ago),
  provider: providerOf(a), model: specOf(a).model });
const approvalBody = (r: RunSpec, p: ApprovalSpec) => ({ approvalId: p.id, kind: "merge", status: decided.has(p.id) ? decided.get(p.id).status : "pending",
  question: p.question, requestedBy: { agentId: p.agentId, runId: r.id }, subject: { ref: p.ref, target: p.target } });
const decided = new Map<string, any>();

// Agent threads: the lead's, plus the steer that opens it (snapshot.threads).
const threads = new ThreadStore(), leadRun = runs.find(r => r.agents.some(a => a.id === "agt-ld01")), T0 = NOW - 5 * min;
if (leadRun) for (const d of process.env.THREAD === "golden" ? goldenThread() : withDiff(leadThread(T0))) threads.write("agt-ld01", d);
const steers = leadRun ? [{ seq: 1, from: "operator", to: "agt-ld01", at: iso(T0), text: "Skip shards above 200 and keep it on the staging bucket.", attachment: null }] : [];
// A 1×1 png for attachment media.
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

const sse = (id: number | null, event: string, data: unknown) => (id !== null ? `id: ${id}\n` : "") + `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
/** A full snapshot of `rs`, ending at HEAD. */
const snapshot = (rs: RunSpec[]) =>
  sse(null, "stream.reset", { snapshotSeq: HEAD, reason: "compacted" })
  + rs.map(r => sse(null, "snapshot.run", { run: runBody(r) })).join("")
  + sse(null, "snapshot.agents", { agents: rs.flatMap(r => r.agents.map(a => agentBody(r, a))) })
  + sse(null, "snapshot.approvals", { approvals: rs.flatMap(r => (r.approvals ?? []).map(p => approvalBody(r, p))) })
  + sse(null, "snapshot.steps", { steps: envelopes.filter(e => rs.some(r => r.id === e.runId)) })
  + sse(null, "snapshot.threads", { messages: steers.filter(m => rs.some(r => r.agents.some(a => a.id === m.to))) })
  + sse(HEAD, "snapshot.end", { snapshotSeq: HEAD });

const err = (status: number, code: string, message: string) => Response.json({ code, message }, { status });
// Open run streams, so a POST can confirm itself with a live event.
const live = new Map<string, Set<ReadableStreamDefaultController>>();
let msgSeq = steers.length;   // message seqs continue after the snapshot's
const broadcast = (scope: string, e: any) => {
  for (const c of live.get(scope) ?? []) { try { c.enqueue(new TextEncoder().encode(sse(e.seq, e.type, e))); } catch { /* closed */ } }
};
// Connections that asked for ?thread=1, per scope: agent.thread_item_changed frames (ephemeral: no SSE id).
const liveThread = new Map<string, Set<ReadableStreamDefaultController>>();
const threadWrite = (run: RunSpec, agentId: string, d: any) => {
  const item = threads.write(agentId, d), ms = Date.now();
  const e = { v: 1, id: `evt_thr_${item.seq}`, scope: run.id, seq: HEAD, entity: agentId, entitySeq: 0, type: "agent.thread_item_changed", typeVersion: 1,
    durability: "ephemeral", ts: iso(ms), epochMs: ms, projectId: run.projectId, runId: run.id, agentId, data: { agentId, item } };
  for (const c of liveThread.get(run.id) ?? []) { try { c.enqueue(new TextEncoder().encode(sse(null, e.type, e))); } catch { /* closed */ } }
};
if (existsSync(sock)) unlinkSync(sock);
Bun.serve({
  unix: sock,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url), p = url.pathname;
    // CAPS=steer.skills,agent.pause advertises features the thread input checks for.
    if (p === "/v1/health") return Response.json({ ok: true, api: "harness.v1", version: `mock-ui-${SCENARIO}`,
      ...(process.env.CAPS ? { capabilities: process.env.CAPS.split(",") } : {}) });
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return err(401, "unauthorized", "missing or invalid bearer token");
    if (p === "/v1/skills") return Response.json([
      { name: "capcomd-orchestration", description: "Compose capcomd primitives into a plan: spawn, await, verify, merge.", source: "bundled" },
      { name: "migrate-matchkey", description: "Steps and checks for matchkey schema migrations.", source: "user" },
      { name: "validate-shards", description: "Null and row-count checks for parquet shards.", source: "user" },
    ]);
    // runs.options: who can drive a new run (its planner) and where its agents run. NO_CODEX=1 / NO_DOCKER=1 report
    // those unavailable, as a daemon would when codex isn't logged in or Docker isn't running.
    if (p === "/v1/run-options") return Response.json({
      drivers: [
        { provider: "claude", label: "Claude Code", model: "claude-opus-5-5", available: true, reason: null, default: true },
        { provider: "codex", label: "Codex", model: "gpt-5-codex", available: !process.env.NO_CODEX, reason: process.env.NO_CODEX ? "codex isn't logged in" : null, default: false },
      ],
      sandboxes: [
        { name: "docker", label: "Local", available: !process.env.NO_DOCKER, reason: process.env.NO_DOCKER ? "Docker isn't running" : null, default: false },
        { name: "boxd", label: "VM", available: true, reason: null, default: true },
      ],
    });
    const msg = p.match(/^\/v1\/runs\/([^/]+)\/agents\/([^/]+)\/messages$/);
    if (msg && req.method === "POST") {   // agents.send (harness #50): answers at once, confirms on the run stream a moment later
      if (!req.headers.get("idempotency-key")) return err(422, "invalid", "Idempotency-Key header (8-200 chars) is required");
      const body: any = await req.json().catch(() => null);
      if (typeof body?.body !== "string" || !body.body) return err(422, "invalid", "body must be {body: non-empty string}");
      const run = runs.find(r => r.id === msg[1]), agent = run?.agents.find(a => a.id === msg[2]);
      if (!run) return err(404, "not_found", `run ${msg[1]} not found`);
      if (!agent) return err(404, "not_found", `agent ${msg[2]} not found`);
      if (["done", "failed", "cancelled"].includes(agent.status)) return err(409, "conflict", `${agent.id} is ${agent.status}: nothing will read this message`);
      const mseq = ++msgSeq, ms = Date.now();
      setTimeout(() => broadcast(run.id, { v: 1, id: `evt_msg_${mseq}`, scope: run.id, seq: HEAD + mseq, entity: `msg-${mseq}`, entitySeq: 1, type: "message.sent",
        typeVersion: 1, durability: "durable", ts: iso(ms), epochMs: ms, projectId: run.projectId, runId: run.id, agentId: "operator",   // the sender, as scope.ts records it
        data: { from: "operator", to: agent.id, seq: mseq, text: body.body, bytes: body.body.length, ...(body.skills ? { skills: body.skills } : {}) } }), 1200);
      // The agent answers on its thread: a reply, then a tool call seen open and then done.
      const at = (dt: number) => new Date(Date.now() + dt).toISOString(), base = { rev: 1, durationMs: null, format: "blocks/1", redacted: false, tool: null, error: null, truncated: null, child: null };
      const say = { ...base, id: `itm-live-${mseq}-say`, kind: "say", status: "done", at: at(2500), text: "On it.", blocks: [{ t: "paragraph", children: [{ t: "text", text: "On it." }] }] };
      const call = { ...base, id: `itm-live-${mseq}-tool`, kind: "tool", status: "open", at: at(3500), text: "Run bun test", blocks: [],
        tool: { callId: `call-live-${mseq}`, name: "Bash", kind: "test", summary: "Run bun test", isError: false, args: "{\"command\": \"bun test\"}", output: null, files: [] } };
      setTimeout(() => threadWrite(run, agent.id, say), 2500);
      setTimeout(() => threadWrite(run, agent.id, call), 3500);
      setTimeout(() => threadWrite(run, agent.id, { ...call, rev: 2, status: "done", durationMs: 2300, tool: { ...call.tool, output: "42 pass\n0 fail" } }), 5800);
      return Response.json({ runId: run.id, to: agent.id, from: "operator", seq: mseq, note: null });
    }
    if (p === "/v1/runs" && req.method === "POST") {   // runs.create (harness #49): accepted, starts nothing here
      if (!req.headers.get("idempotency-key")) return err(422, "invalid", "Idempotency-Key header (8-200 chars) is required");
      const body: any = await req.json().catch(() => null);
      if (!body?.goal?.trim()) return err(422, "invalid", "goal is empty");
      if (body.driver !== undefined && !["claude", "codex"].includes(body.driver)) return err(422, "invalid", `unknown driver ${JSON.stringify(body.driver)}`);
      if (body.driver === "codex" && process.env.NO_CODEX) return err(422, "invalid", "codex can't drive this run: codex isn't logged in");
      if (body.sandbox !== undefined && !["docker", "boxd"].includes(body.sandbox)) return err(422, "invalid", `unknown sandbox ${JSON.stringify(body.sandbox)}`);
      if (body.sandbox === "docker" && process.env.NO_DOCKER) return err(422, "invalid", "can't run locally: Docker isn't running");
      console.log(`runs.create goal=${JSON.stringify(body.goal)} driver=${body.driver ?? "(default)"} sandbox=${body.sandbox ?? "(default)"}`);
      if (process.env.NO_REPO && !body.repo) return err(422, "invalid", "repo is required: this daemon has no default repository (CAPCOMD_REPO).");
      return Response.json({ id: `run-new${Date.now() % 100000}`, projectId: "prj-new", label: body.goal, state: "starting", goal: body.goal, repo: body.repo ?? "/src/matchkey", createdAt: iso(Date.now()) }, { status: 201 });
    }
    if (p === "/v1/runs") return Response.json(runs.map(runBody));
    const r1 = p.match(/^\/v1\/runs\/([^/]+)\/(trace|files)$/), run1 = r1 && runs.find(r => r.id === r1[1]);
    if (r1 && !run1) return err(404, "not_found", `run ${r1[1]} not found`);
    if (r1 && r1[2] === "trace") { const t0 = NOW - run1!.startedAgo; return Response.json((run1!.spans ?? []).map(sp => ({ traceId: "t-" + run1!.id, spanId: sp.id,
      parentSpanId: sp.parent ?? null, name: sp.name, start: iso(t0 + sp.from * 1000), end: iso(t0 + (sp.from + sp.took) * 1000), status: sp.error ? 2 : 1, attributes: sp.attrs ?? {} }))); }
    if (r1 && r1[2] === "files") { const f = run1!.files ?? []; return Response.json({ runId: run1!.id, asOf: HEAD, computedAt: iso(Date.now()), target: "main",
      files: f.map(x => ({ ...x, oldPath: null })), total: f.length, truncated: false, sources: [] }); }
    const tr = p.match(/^\/v1\/runs\/([^/]+)\/agents\/([^/]+)\/transcript$/);
    if (tr) { const lines = runs.find(r => r.id === tr[1])?.transcript?.[tr[2]] ?? []; const after = Number(url.searchParams.get("after") ?? 0);
      return Response.json({ items: lines.map((text, i) => ({ seq: i + 1, at: iso(Date.now() - (lines.length - i) * 2500), stream: "stdout", text })).filter(x => x.seq > after), next: null }); }
    const th = p.match(/^\/v1\/runs\/([^/]+)\/agents\/([^/]+)\/thread$/);
    if (th) return Response.json(threads.page(th[2], Number(url.searchParams.get("after") ?? 0), Math.min(500, Number(url.searchParams.get("limit") ?? 100))));
    if (/^\/v1\/runs\/[^/]+\/attachments\/[^/]+\/content$/.test(p)) return new Response(PNG, { headers: { "content-type": "image/png", "x-content-type-options": "nosniff" } });
    if (/^\/v1\/runs\/[^/]+\/agents\/[^/]+\/workspace$/.test(p)) return err(404, "not_found", "not in the agent's latest work");
    const actl = p.match(/^\/v1\/runs\/([^/]+)\/agents\/([^/]+)\/(pause|resume)$/);
    if (actl && req.method === "POST") {   // harness #68: one agent and its subtree; the lifecycle confirms it a moment later
      if (!req.headers.get("idempotency-key")) return err(422, "invalid", "Idempotency-Key header (8-200 chars) is required");
      const run = runs.find(r => r.id === actl[1]), agent = run?.agents.find(a => a.id === actl[2]);
      if (!run) return err(404, "not_found", `run ${actl[1]} not found`);
      if (!agent) return err(404, "not_found", `agent ${actl[2]} not found`);
      const want = actl[3] === "pause" ? "running" : "paused";
      if (agent.status !== want) return err(409, "conflict", actl[3] === "pause" ? `nothing in ${agent.id}'s subtree is running to pause` : `nothing in ${agent.id}'s subtree is paused`);
      const type = actl[3] === "pause" ? "agent.paused" : "agent.resumed", ms = Date.now() + 1500;
      setTimeout(() => {
        agent.status = actl[3] === "pause" ? "paused" : "running";
        broadcast(run.id, { v: 1, id: `evt_${type}_${ms}`, scope: run.id, seq: HEAD + 500 + (++msgSeq), entity: agent.id, entitySeq: 1, type, typeVersion: 1,
          durability: "durable", ts: iso(ms), epochMs: ms, projectId: run.projectId, runId: run.id, agentId: agent.id, data: { agentId: agent.id, by: "client:menubar" } });
      }, 1500);
      return Response.json({ runId: run.id, agentId: agent.id, action: actl[3], changed: [], pending: [agent.id] });
    }
    const ctl = p.match(/^\/v1\/runs\/([^/]+)\/(pause|resume|cancel)$/);
    if (ctl && req.method === "POST") {
      if (!req.headers.get("idempotency-key")) return err(422, "invalid", "Idempotency-Key header (8-200 chars) is required");
      const r = runs.find(x => x.id === ctl[1]); if (!r) return err(404, "not_found", `run ${ctl[1]} not found`);
      return Response.json({ runId: r.id, action: ctl[2], changed: [], pending: r.agents.filter(a => a.status === "running").map(a => a.id) });
    }
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
    let hb: ReturnType<typeof setInterval> | undefined, stream: ReadableStreamDefaultController | undefined;
    return new Response(new ReadableStream({
      start(c) {
        if (!live.has(scope)) live.set(scope, new Set()); live.get(scope)!.add(c);
        if (url.searchParams.get("thread") === "1") { if (!liveThread.has(scope)) liveThread.set(scope, new Set()); liveThread.get(scope)!.add(c); }
        stream = c;
        c.enqueue(new TextEncoder().encode(snapshot(picked)));
        hb = setInterval(() => { try { c.enqueue(new TextEncoder().encode(": heartbeat\n\n")); } catch { clearInterval(hb); } }, 15_000);
      },
      cancel() { clearInterval(hb); if (stream) { live.get(scope)?.delete(stream); liveThread.get(scope)?.delete(stream); } },
    }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  },
});
chmodSync(sock, 0o600);
console.log(`scenario ${SCENARIO}: ${runs.length} runs, ${HEAD} events on unix:${sock}`);

// MOMENTS=1: a scripted live run for the identity moments. 4 s after start (then every 30 s, with a fresh id), a run is
// created and its planner spawns a lead, two workers and a critic about 300 ms apart ("meet your team"); 9 s later it
// completes (the cheer).
if (process.env.MOMENTS) {
  let n = 0, s = HEAD + 10_000;
  const cycle = () => {
    const rid = `run-mom${++n}`, pid = `prj-mom${n}`;
    const ev = (type: string, entity: string, agentId: string | null, data: any) => {
      const ms = Date.now();
      const e = { v: 1, id: `evt_m_${++s}`, scope: rid, seq: s, entity, entitySeq: 1, type, typeVersion: 1, durability: "durable", ts: iso(ms), epochMs: ms,
        projectId: pid, runId: rid, agentId, data };
      broadcast("daemon", e); broadcast(rid, e);
    };
    const team = [["agt-m0", null, "planner"], ["agt-m1", "agt-m0", "lead"], ["agt-m2", "agt-m0", "worker"], ["agt-m3", "agt-m0", "worker"], ["agt-m4", "agt-m0", "critic"]]
      .map(([id, parent, profile]) => ({ id: `${id}-${n}`, parent: parent ? `${parent}-${n}` : null, profile }));
    ev("run.created", rid, null, { runId: rid, budget: {}, label: null, goal: "Ship the matchkey dashboard" });
    ev("run.started", rid, null, { cause: "started" });
    team.forEach((a, i) => setTimeout(() => {
      ev("agent.spawned", a.id, a.id, { parent: a.parent, depth: a.parent ? 1 : 0, profile: a.profile, budget: {}, limits: {}, agent: specOf(a as { profile: string }), task: null, key: null, operator: false,
        workspace: { repo: "/src/matchkey", path: null, label: "matchkey" } });
      ev("agent.started", a.id, a.id, {});
    }, 200 + i * 300));
    setTimeout(() => {
      for (const a of team) ev("agent.done", a.id, a.id, { result: { summary: "done" } });
      ev("run.completed", rid, null, { cause: "completed" });
    }, 9_000);
  };
  setTimeout(cycle, 4_000); setInterval(cycle, 30_000);
}
