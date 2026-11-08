#!/usr/bin/env node
// ADR-017: capcomd inside an agent VM. Dependency-free (runs on the VM's node). It never talks
// to the network: each call is a request file in $CAPCOMD_RPC_DIR/req that the orchestrator
// answers over boxd's authenticated exec channel. Authority = the token in $CAPCOMD_TOKEN_FILE.
// Output is always JSON. Exit: 0 ok, 1 error, 2 usage, 75 retry later (backpressure).
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const DIR = process.env.CAPCOMD_RPC_DIR || "/tmp/capcomd-rpc";
const TOKEN_FILE = process.env.CAPCOMD_TOKEN_FILE || join(DIR, "token");
const RPC_TIMEOUT = Number(process.env.CAPCOMD_RPC_TIMEOUT_MS || 120000);
const AWAIT_POLL = Number(process.env.CAPCOMD_AWAIT_POLL_MS || 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRANSIENT = new Set(["unavailable", "engine_unreachable", "internal"]);

/** One logical call. Transient failures (orchestrator restarting, engine blip) are retried with
 *  the SAME request id, which the orchestrator uses as the idempotency key for writes. */
async function call(op, args = {}) {
  const id = `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
  const deadline = Date.now() + RPC_TIMEOUT;
  let r, wait = 500;
  for (;;) {
    r = await callOnce(id, op, args, Math.max(1000, deadline - Date.now()));
    if (r.ok || !TRANSIENT.has(r.error?.code) || Date.now() > deadline) return r;
    await sleep(wait); wait = Math.min(wait * 2, 5000);
  }
}

async function callOnce(id, op, args, timeoutMs) {
  mkdirSync(join(DIR, "req"), { recursive: true });
  mkdirSync(join(DIR, "res"), { recursive: true });
  const token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "";
  const tmp = join(DIR, "req", `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify({ id, token, op, args }));
  renameSync(tmp, join(DIR, "req", `${id}.json`));
  const res = join(DIR, "res", `${id}.json`);
  const deadline = Date.now() + timeoutMs;
  let wait = 50;
  while (Date.now() < deadline) {
    if (existsSync(res)) {
      try { const r = JSON.parse(readFileSync(res, "utf8")); rmSync(res, { force: true }); return r; } catch { /* partial; retry */ }
    }
    await sleep(wait); wait = Math.min(wait * 2, 500);
  }
  return { id, ok: false, error: { code: "unavailable", message: `no answer from the orchestrator in ${timeoutMs}ms`, hint: "Retry with the same --key; the orchestrator may be restarting." } };
}

/**
 * Block until the agents finish (or any, for wait-any), or one of them looks stuck: a notice raised while waiting
 * (ADR-019 §2) returns early, as `notices`. Polls; the orchestrator refuses deadlocks.
 */
async function awaitLoop(op, args) {
  const deadline = Date.now() + Number(args.timeoutMs ?? 30 * 60000);
  let seen = null;
  for (;;) {
    const r = await call(op, args);
    if (!r.ok || r.result.done) return r;
    const now = new Map((r.result.notices ?? []).map((n) => [n.agentId, n.at]));
    const fresh = seen ? (r.result.notices ?? []).filter((n) => seen.get(n.agentId) !== n.at) : [];
    seen = now;
    if (fresh.length) { await call(op, { ...args, end: true }); return { ok: true, result: { ...r.result, notices: fresh } }; }
    if (Date.now() > deadline) { await call(op, { ...args, end: true }); return { ok: true, result: { ...r.result, timeout: true } }; }
    await sleep(AWAIT_POLL);
  }
}

/** verify answers "running" while a review is in progress: poll with the same key until it settles. */
async function verifyLoop(args) {
  const deadline = Date.now() + 2 * 60 * 60000;
  for (;;) {
    const r = await call("verify", args);
    if (!r.ok || r.result?.state !== "running" || Date.now() > deadline) return r;
    await sleep(Math.max(AWAIT_POLL, 2000));
  }
}

/** check answers "running" (with its id) while the checks run: poll that id until it settles. */
async function checkLoop(args) {
  const deadline = Date.now() + 2 * 60 * 60000;
  let r = await call("check", args);
  while (r.ok && r.result?.state === "running" && r.result.id && Date.now() <= deadline) {
    await sleep(Math.max(AWAIT_POLL, 2000));
    r = await call("check", { id: r.result.id });
  }
  return r;
}

async function followEvents(args, emit) {
  let after = Number(args.after ?? 0);
  const deadline = Date.now() + Number(args.timeoutMs ?? 10 * 60000);
  for (;;) {
    const r = await call("events", { after, limit: 500 });
    if (!r.ok) return r;
    for (const e of r.result.events) { emit(e); after = e.seq; if (args.until && e.type === args.until) return { ok: true, result: { end: "until", seq: after } }; }
    if (!args.follow) return { ok: true, result: { end: "page", seq: after } };
    if (Date.now() > deadline) return { ok: true, result: { end: "timeout", seq: after } };
    await sleep(AWAIT_POLL);
  }
}

// ── argv → (op, args) ─────────────────────────────────────────────────────────────────────
function parse(argv) {
  const pos = [], fl = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (v === undefined) { const n = argv[i + 1]; if (n !== undefined && !n.startsWith("--")) { v = n; i++; } else v = "true"; }
    if (k in fl) fl[k] = [].concat(fl[k], v); else fl[k] = v;
  }
  return { pos, fl };
}
const json = (s, what) => { if (s === undefined) return undefined; try { return JSON.parse(s); } catch { const e = new Error(`${what}: invalid JSON`); e.usage = true; throw e; } };
const arr = (v) => (v === undefined ? [] : [].concat(v));
function usage(msg) { const e = new Error(msg); e.usage = true; throw e; }

export const HELP = `capcomd (in-VM) — orchestrate child agents. All output is JSON.
  title "<2-4 lowercase words>"   name your tab (what you're working on); title <agt> "…" names a child; title --run "…" (the planner) names the run
  spawn --task T [--title "…"] [--profile P] [--key K] [--budget usd=1,turns=20,wallSeconds=600] [--check NAME] [--report] [--continue agt]
        (--report: read-only; the child's final message is its result, nothing is pushed)
        (--continue: start from a finished child's work, its branch or last checkpoint, e.g. one stopped at a limit)
        [--children.maxChildren=N --children.maxDepth=N --children.maxTotalDescendants=N
         --children.allowedChildProfiles=a,b --children.budgetShare=0.5] [--contract JSON]
  await <agt…> [--timeout-ms N]   wait-any <agt…> [--timeout-ms N]
  status [agt…]   tree [--root agt]   inspect <agt> [--tail N]   logs <agt> [--tail N]
  cancel <agt> [--reason R]   send <agt|parent> <text> [--key K]   inbox [--after N]
  handoff --task T [--profile P] [--context JSON]
  events [--follow] [--after N | --since-seq N] [--until TYPE] [--timeout-ms N]
  budget [show]   grant <agt> --budget usd=1,turns=20 [--key K]  (more for a child, from what you have left)   heartbeat [note]
  result --summary S [--artifact name=ref]… [--data JSON]
  task add --title T [--data JSON] [--after tsk,…] [--key K] | list [--status S] | show <tsk>
       | claim [tsk] [--lease-ms N] | renew|release|done <tsk> --epoch E [--result JSON]
  kv get <k> | put <k> <json> [--key K] | cas <k> <json> --expect V | del <k> [--expect V] | list [--prefix P]
  verify --ref <agt> [--acceptance JSON] [--key K]  (uses the check pinned at spawn)   merge --ref <agt> --require <vfy> [--key K]
  fetch [branch…]   the latest branches into your checkout as origin/<branch> (e.g. the target after a merge), to read with git log/show/diff
  check [agt|branch] [--check NAME]   the run's checks on that branch's commit as it is, in a sandbox (default: the run's
        target, i.e. the combined code after the merges); prints pass/fail and the output. Merges nothing.
  job start [--label L] [--foreground-ms N] [--timeout-ms N] -- <cmd…>   run a long command in the background: it
        answers with its result when it ends within the foreground wait, else "running" and its result comes to you
        as a message (capcomd inbox). One word with spaces runs with sh -c.
  job output <job> [--tail BYTES]   job list   job kill <job> [--reason R]
  mcp   (serve these as MCP tools over stdio)`;

export function toCall(argv) {
  // `job start … -- <cmd…>`: everything after `--` is the command, untouched.
  const dd = argv.indexOf("--");
  const rest = dd >= 0 ? argv.slice(dd + 1) : [];
  if (dd >= 0) argv = argv.slice(0, dd);
  const { pos, fl } = parse(argv);
  const cmd = pos.shift();
  const key = fl.key;
  const timeoutMs = fl["timeout-ms"] !== undefined ? Number(fl["timeout-ms"]) : undefined;
  switch (cmd) {
    case "spawn": {
      if (!fl.task) usage("spawn needs --task");
      const children = {};
      for (const [k, v] of Object.entries(fl)) if (k.startsWith("children.")) children[k.slice(9)] = v;
      const set = {};
      for (const s of arr(fl.set)) { const [k, v] = String(s).split(/=(.*)/s); set[k] = isNaN(Number(v)) ? v : Number(v); }
      return { op: "spawn", args: { task: fl.task, ...(fl.title !== undefined ? { title: String(fl.title) } : {}), profile: fl.profile, key, budget: fl.budget, check: fl.check, ...(fl.report !== undefined ? { report: true } : {}), ...(fl.continue ? { continue: fl.continue } : {}), contract: json(fl.contract, "--contract"), ...(Object.keys(children).length ? { children } : {}), ...(Object.keys(set).length ? { set } : {}) } };
    }
    case "await": case "wait-any": if (!pos.length) usage(`${cmd} needs agent ids`); return { op: cmd, args: { agents: pos, timeoutMs }, loop: true };
    case "status": return { op: "status", args: pos.length ? { agents: pos } : {} };
    case "tree": return { op: "tree", args: { root: fl.root ?? pos[0] } };
    case "inspect": case "logs": if (!pos[0]) usage(`${cmd} needs an agent id`); return { op: cmd, args: { agent: pos[0], tail: fl.tail } };
    case "cancel": if (!pos[0]) usage("cancel needs an agent id"); return { op: "cancel", args: { agent: pos[0], reason: fl.reason } };
    case "send": if (pos.length < 2) usage("send <agt|parent> <text>"); return { op: "send", args: { to: pos[0], body: pos.slice(1).join(" "), key } };
    case "inbox": return { op: "inbox", args: { after: fl.after } };
    case "handoff": if (!fl.task) usage("handoff needs --task"); return { op: "handoff", args: { task: fl.task, profile: fl.profile, context: json(fl.context, "--context") } };
    case "events": return { op: "events", args: { follow: fl.follow === "true", after: fl.after ?? fl["since-seq"], until: fl.until, timeoutMs }, events: true };
    case "budget": return { op: "budget", args: {} };
    case "grant": if (!pos[0] || !fl.budget) usage("grant <agt> --budget usd=…,turns=…,wallSeconds=…"); return { op: "grant", args: { agent: pos[0], budget: fl.budget, key } };
    case "heartbeat": return { op: "heartbeat", args: { note: pos.join(" ") || undefined } };
    case "title": {
      // title "login redirect" (yourself) | title <agt> "…" (a child) | title --run "…" (the planner names the run)
      const agent = /^agt-/.test(pos[0] ?? "") ? pos.shift() : undefined;
      const words = pos.join(" ").trim() || (typeof fl.run === "string" && fl.run !== "true" ? fl.run : "");
      if (!words) usage('title "<2-4 lowercase words>": name what you\'re working on, e.g. capcomd title "login redirect"');
      return { op: "title", args: { title: words, ...(agent ? { agent } : {}), ...(fl.run !== undefined ? { run: true } : {}), key } };
    }
    case "result": return { op: "result", args: { summary: fl.summary ?? pos.join(" "), artifacts: arr(fl.artifact).map((a) => { const [name, ref] = String(a).split(/=(.*)/s); return { name, ref: ref ?? name }; }), data: json(fl.data, "--data") } };
    case "task": {
      const action = pos.shift();
      if (action === "add") return { op: "task", args: { action, title: fl.title, data: json(fl.data, "--data"), after: fl.after ? String(fl.after).split(",") : undefined, key } };
      if (action === "list") return { op: "task", args: { action, status: fl.status } };
      if (action === "show") return { op: "task", args: { action, task: pos[0] } };
      if (action === "claim") return { op: "task", args: { action, task: pos[0], leaseMs: fl["lease-ms"] !== undefined ? Number(fl["lease-ms"]) : undefined, key } };
      if (["renew", "release", "done"].includes(action)) return { op: "task", args: { action, task: pos[0], epoch: Number(fl.epoch), leaseMs: fl["lease-ms"] !== undefined ? Number(fl["lease-ms"]) : undefined, result: json(fl.result, "--result"), key } };
      return usage("task add|list|show|claim|renew|release|done");
    }
    case "kv": {
      const action = pos.shift();
      if (action === "get" || action === "del") return { op: "kv", args: { action, k: pos[0], ...(fl.expect !== undefined ? { expect: Number(fl.expect) } : {}) } };
      if (action === "put") return { op: "kv", args: { action, k: pos[0], value: json(pos[1], "value"), key } };
      if (action === "cas") return { op: "kv", args: { action, k: pos[0], value: json(pos[1], "value"), expect: Number(fl.expect), key } };
      if (action === "list") return { op: "kv", args: { action, prefix: fl.prefix } };
      return usage("kv get|put|cas|del|list");
    }
    case "verify": {
      if (!fl.ref) usage("verify needs --ref <agt>");
      // Polled until done (a review takes minutes), so the key must be stable across polls.
      const vkey = key ?? `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const extra = { ...(fl.checks !== undefined ? { checks: fl.checks } : {}), ...(fl["review-profile"] !== undefined ? { reviewProfile: fl["review-profile"] } : {}), ...(fl["judge-profile"] !== undefined ? { judgeProfile: fl["judge-profile"] } : {}) }; // forwarded so the orchestrator refuses them loudly
      return { op: "verify", args: { ref: fl.ref, check: fl.check, acceptance: json(fl.acceptance, "--acceptance"), key: vkey, ...extra }, verifyLoop: true };
    }
    case "merge": if (!fl.ref || !fl.require) usage("merge needs --ref <agt> --require <vfy>"); return { op: "merge", args: { ref: fl.ref, require: fl.require, key } };
    case "fetch": return { op: "fetch", args: { refs: pos, dir: checkout() } };
    case "job": {
      const action = pos.shift();
      if (action === "start") {
        const cmd = rest.length ? rest : pos;
        if (!cmd.length) usage("job start needs a command: capcomd job start -- npm test");
        return { op: "job.start", args: { cmd, ...jobStartArgs(), ...(fl.label !== undefined ? { label: fl.label } : {}), ...(fl["foreground-ms"] !== undefined ? { foregroundMs: Number(fl["foreground-ms"]) } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(key !== undefined ? { key } : {}) } };
      }
      if (action === "output") { if (!pos[0]) usage("job output needs a job id"); return { op: "job.output", args: { job: pos[0], ...(fl.tail !== undefined ? { tail: Number(fl.tail) } : {}) } }; }
      if (action === "list") return { op: "job.list", args: {} };
      if (action === "kill") { if (!pos[0]) usage("job kill needs a job id"); return { op: "job.kill", args: { job: pos[0], ...(fl.reason !== undefined ? { reason: fl.reason } : {}) } }; }
      return usage(`job ${action ?? ""}? start|output|list|kill`);
    }
    case "check": {
      const ref = fl.ref ?? pos[0];
      // --checks is forwarded so the orchestrator refuses it loudly.
      return { op: "check", args: { ...(ref ? { ref } : {}), ...(fl.id ? { id: fl.id } : {}), ...(fl.check !== undefined ? { check: fl.check } : {}), ...(fl.checks !== undefined ? { checks: fl.checks } : {}), ...(key !== undefined ? { key } : {}) }, checkLoop: true };
    }
  }
  return usage(cmd ? `unknown command ${cmd}` : "no command");
}

/** Where a job runs and the PATH it gets: this shell's (its foreground wait is kept inside one call's time). */
function jobStartArgs() {
  return { cwd: process.cwd(), ...(process.env.PATH ? { path: process.env.PATH } : {}), maxForegroundMs: Math.max(1000, RPC_TIMEOUT - 15000) };
}

/** This agent's checkout (where `fetch` lands): the runner's CAPCOMD_CHECKOUT, else the git checkout around the cwd. */
function checkout() {
  if (process.env.CAPCOMD_CHECKOUT) return process.env.CAPCOMD_CHECKOUT;
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return process.cwd(); }
}

function exitFor(r) { return r.ok ? 0 : r.error?.retryable ? 75 : r.error?.code === "usage" ? 2 : 1; }

// ── MCP (stdio, newline-delimited JSON-RPC) ─────────────────────────────────────────────────
const S = (props, req = []) => ({ type: "object", properties: props, required: req });
const str = { type: "string" }, num = { type: "number" }, ids = { type: "array", items: { type: "string" } };
export const TOOLS = [
  ["title", "Name your tab: 2-4 lowercase words for what you're working on (e.g. \"login redirect\"). Rename only when your focus really changes. `agent`: one of your children instead; `run: true` (the planner): the run.", S({ title: str, agent: str, run: { type: "boolean" }, key: str }, ["title"])],
  ["spawn", "Spawn a child agent under you. Set its fan-out with `children` (narrow-only, ≤ your own limits). `title`: its tab's name (2-4 lowercase words).", S({ task: str, title: str, profile: str, key: str, budget: str, check: str, report: { type: "boolean" }, continue: str, contract: { type: "object" }, children: S({ maxChildren: num, maxDepth: num, maxTotalDescendants: num, allowedChildProfiles: ids, budgetShare: num }) }, ["task"])],
  ["await", "Block until all given children finish; returns their structured results (fenced).", S({ agents: ids, timeoutMs: num }, ["agents"])],
  ["wait_any", "Block until any given child finishes.", S({ agents: ids, timeoutMs: num }, ["agents"])],
  ["status", "Status of agents (default: you; to an agent that may spawn the consolidator, the run's lessons too).", S({ agents: ids })],
  ["tree", "Your subtree with cost/turn rollups and stuck flags.", S({ root: str })],
  ["cancel", "Cancel a descendant and its whole subtree (VMs torn down).", S({ agent: str, reason: str }, ["agent"])],
  ["send", "Message a descendant or your parent (to: agent id or \"parent\").", S({ to: str, body: str, key: str }, ["to", "body"])],
  ["inbox", "Read messages sent to you (fenced).", S({ after: num })],
  ["handoff", "Hand the rest of your task to a successor child; then stop.", S({ task: str, profile: str, context: { type: "object" } }, ["task"])],
  ["events", "Events in your visible tree after a cursor.", S({ after: num, until: str })],
  ["budget", "Your budget, spend, what is left to give children, and subtree rollup.", S({})],
  ["grant", "Give one of your children more budget while it runs, from what you have left (only units it has a budget in); it also restarts its stuck window.", S({ agent: str, budget: str, key: str }, ["agent", "budget"])],
  ["task", "Shared task board: action add|list|show|claim|renew|release|done.", S({ action: str, title: str, task: str, epoch: num, leaseMs: num, after: ids, data: {}, result: {}, status: str, key: str }, ["action"])],
  ["kv", "Shared blackboard: action get|put|cas|del|list (cas needs expect=version).", S({ action: str, k: str, value: {}, expect: num, prefix: str, key: str }, ["action"])],
  ["verify", "Run the run's checks on a child's branch (never self-reported); a child pinned with spawn check uses that check.", S({ ref: str, check: str, acceptance: {}, key: str }, ["ref"])],
  ["merge", "Merge a child's verified commit (needs require=vfy id). Its result says whether the checks ran on the combined code (result.combined).", S({ ref: str, require: str, key: str }, ["ref", "require"])],
  ["fetch", "Fetch the latest branches (all, or `branches`) into your checkout as origin/<branch>, e.g. the target after a merge; read them with git log/show/diff, or `git switch --detach origin/<branch>` and the file tools. Changes no code.", S({ branches: ids })],
  ["check", "Run the run's checks on a branch's commit as it is (ref: a branch or a child's agent id; default: the run's target, i.e. the combined code after the merges), in a sandbox: the full output and pass/fail (result.pass, result.text, result.checks.output). Merges and reviews nothing; how you know the combined code works without running it yourself. Identical checks of one commit are shared.", S({ ref: str, check: str, key: str })],
  ["job_start", "Run a long command (tests, a build, a server) in the background in your machine. It answers with the result when the command ends within `foregroundMs` (default: your profile's, 60 s), else state \"running\" and a job id: the result then comes to you as a message. `cmd`: a shell line, or argv.", S({ cmd: { anyOf: [str, ids] }, label: str, foregroundMs: num, timeoutMs: num, key: str }, ["cmd"])],
  ["job_output", "The output of one of your background jobs so far (or its result once it ended).", S({ job: str, tail: num }, ["job"])],
  ["job_list", "Your background jobs, newest first, with their state.", S({})],
  ["job_kill", "Stop one of your background jobs (SIGTERM, then SIGKILL after 5 s).", S({ job: str, reason: str }, ["job"])],
  ["inspect", "Everything about one agent: record, children, awaits, VM, logs, events.", S({ agent: str, tail: num }, ["agent"])],
  ["logs", "Tail an agent's logs (fenced).", S({ agent: str, tail: num }, ["agent"])],
  ["heartbeat", "Report progress (keeps you from being flagged stuck).", S({ note: str })],
  ["result", "Declare your structured result before you exit: summary, artifacts, data.", S({ summary: str, artifacts: { type: "array", items: S({ name: str, ref: str }) }, data: {} }, ["summary"])],
].map(([name, description, inputSchema]) => ({ name: `capcomd_${name}`, description, inputSchema }));

/** The tools this agent's token lets it call (an agent that may not spawn sees no spawn, verify or merge tool). Its claims
 *  are readable, not secret (only the signature is checked, by the orchestrator, which refuses an op outside them all
 *  the same); without a token yet, every tool. */
export function toolsFor(token) {
  let ops = null;
  try { const c = JSON.parse(Buffer.from(String(token ?? "").trim().split(".")[1] ?? "", "base64url").toString("utf8")); if (Array.isArray(c.ops)) ops = new Set(c.ops); } catch { /* not a token: every tool */ }
  if (!ops) return TOOLS;
  return TOOLS.filter((t) => ops.has(t.name.replace(/^capcomd_/, "").replace("wait_any", "wait-any").replace(/^job_/, "job.")));
}

async function mcp() {
  let buf = "";
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === undefined) continue; // notification
      if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "capcomd", version: "1" } } });
      else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: toolsFor(existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8") : "") } });
      else if (m.method === "tools/call") {
        const name = String(m.params?.name ?? "").replace(/^capcomd_/, "").replace("wait_any", "wait-any").replace(/^job_/, "job.");
        const a0 = m.params?.arguments ?? {};
        const args = name === "fetch" ? { refs: [].concat(a0.branches ?? []), dir: checkout() } : name === "job.start" ? { ...a0, ...jobStartArgs() } : a0;
        const r = name === "await" || name === "wait-any" ? await awaitLoop(name, args) : name === "verify" ? await verifyLoop({ ...args, key: args.key ?? `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }) : name === "check" ? await checkLoop(args) : await call(name, args);
        send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(r.ok ? r.result : r.error) }], isError: !r.ok } });
      } else if (m.method === "ping") send({ jsonrpc: "2.0", id: m.id, result: {} });
      else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
    }
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") { console.log(HELP); return 0; }
  if (argv[0] === "mcp") { await mcp(); return null; }
  let c;
  try { c = toCall(argv); } catch (e) { console.log(JSON.stringify({ ok: false, error: { code: "usage", message: e.message } })); return 2; }
  let r;
  if (c.events) r = await followEvents(c.args, (e) => console.log(JSON.stringify({ event: e })));
  else r = c.loop ? await awaitLoop(c.op, c.args) : c.verifyLoop ? await verifyLoop(c.args) : c.checkLoop ? await checkLoop(c.args) : await call(c.op, c.args);
  console.log(JSON.stringify(r.ok ? { ok: true, ...(r.result && typeof r.result === "object" ? r.result : { result: r.result }) } : { ok: false, error: r.error }));
  return exitFor(r);
}

// Run directly (not imported): compared as real paths, since a temp dir behind a symlink (macOS's /var) resolves
// differently in import.meta.url than in argv.
const isMain = () => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } };
if (isMain() || process.argv[1]?.endsWith("/capcomd")) {
  main().then((code) => { if (code !== null) process.exit(code); }, (e) => { console.log(JSON.stringify({ ok: false, error: { code: "internal", message: String(e?.message ?? e) } })); process.exit(1); });
}
