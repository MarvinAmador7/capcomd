#!/usr/bin/env node
// ADR-019 §1, §3: the in-VM supervisor. It runs next to the agent CLI (run.sh starts it when the VM has node), and
// reports up through an outbox the engine drains: heartbeats while it is alive, and checkpoints of the workspace.
// Dependency-free, like vm-cli.mjs. Config (JSON file, argv[2]):
//   { script, dir, repo, jsonl, outbox, ref, agentId, heartbeatMs, checkpointEveryMs, checkpoints?, input?, reportTree?, jobs? }
// With `reportTree`, each heartbeat carries the workspace's tree hash (for "no change in the workspace", ADR-019 §2).
// With `jobs` (the agent's background jobs' directory, plugin API §16.2), each heartbeat says how many run, and the
// agent's input stays open while one runs or one ended whose result message hasn't reached it yet: the CLI is still
// there to read the result when it comes, and the agent keeps its slot.
// It never pushes: the agent must not hold push credentials, so the engine pushes the checkpoint ref it reports.
// With `input` ({ prompt, inbox }), the agent CLI reads user messages on stdin (claude --input-format stream-json):
// the supervisor sends the prompt, then each message the engine appends to `inbox`, and closes stdin once the agent
// has finished (a result) with nothing sent since, which ends the CLI.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
let seq = 0;
const report = (type, data = {}) => {
  try { appendFileSync(cfg.outbox, JSON.stringify({ seq: ++seq, at: Date.now(), type, ...data }) + "\n"); } catch {}
};

// The agent CLI's event stream: each new line is an event (what it is doesn't matter here).
let read = 0, events = 0, lastEventAt = Date.now();
function sample() {
  let size = 0;
  try { size = statSync(cfg.jsonl).size; } catch { return; }
  if (size <= read) return;
  const fd = openSync(cfg.jsonl, "r");
  try {
    const buf = Buffer.alloc(Math.min(size - read, 1 << 20));
    const n = readSync(fd, buf, 0, buf.length, read);
    read += n;
    for (let i = 0; i < n; i++) if (buf[i] === 10) events++;
  } finally { closeSync(fd); }
  lastEventAt = Date.now();
}

// A checkpoint snapshots the working tree without touching it: a temporary index, `add -A`, `write-tree`, and a
// commit on HEAD stored at cfg.ref. The agent's tree, index and history are unchanged.
const git = (args, env = {}) =>
  execFileSync("git", args, { cwd: cfg.repo, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// A temporary index of HEAD whose entries match the files on disk, so `add -A` hashes and writes only what changed.
// (Written again, every unchanged blob "freshens" the pack holding it: on a checkout from an image layer, the warm
// template, that copies the whole pack into the container.) `--refresh` exits 1 when files differ: that's expected.
function headIndex(idx, ref = "HEAD") {
  git(["read-tree", ref], idx);
  try { git(["update-index", "-q", "--refresh"], idx); } catch { /* changed files: add -A takes them */ }
}
let lastTree = null, lastHead = null;
function checkpoint(reason) {
  // `checkpoints: false` (an orchestrate agent, plugin API §16.1): its checkout is never committed, not even here.
  if (cfg.checkpoints === false) return;
  try {
    const head = git(["rev-parse", "HEAD"]);
    const idx = { GIT_INDEX_FILE: `${cfg.dir}/checkpoint.index` };
    headIndex(idx, head);
    git(["add", "-A"], idx);
    const tree = git(["write-tree"], idx);
    const headTree = git(["rev-parse", "HEAD^{tree}"]);
    lastHead = head;
    if (tree === lastTree || (lastTree === null && tree === headTree && reason !== "commit")) { lastTree = tree; return; }
    lastTree = tree;
    const sha = git(["-c", "user.name=capcomd", "-c", "user.email=capcomd@users.noreply.github.com", "commit-tree", tree, "-p", head, "-m", `checkpoint ${cfg.agentId} (${reason})`]);
    git(["update-ref", cfg.ref, sha]);
    const files = git(["diff", "--name-only", head, sha]).split("\n").filter(Boolean).length;
    report("checkpoint", { sha, head, reason, files, events });
  } catch (e) {
    report("error", { where: "checkpoint", message: String(e?.stderr || e?.message || e).slice(0, 300) });
  }
}

// The working tree as a tree hash (HEAD plus every change, untracked files included), without touching the index.
function workTree() {
  try {
    const idx = { GIT_INDEX_FILE: `${cfg.dir}/tree.index` };
    headIndex(idx);
    git(["add", "-A"], idx);
    return git(["write-tree"], idx);
  } catch { return undefined; }
}

// Its background jobs (src/jobs/machine.ts): running (a runner alive and no exit code yet), and ended ones whose result
// message hasn't been delivered (its `from` is the job id). One that ended more than JOB_GRACE_MS ago is let go: its
// message may never come (capcomd was down).
const JOB_GRACE_MS = 60_000, JOB_START_MS = 30_000;
const deliveredJobs = new Set();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readText = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
function jobs() {
  const out = { running: 0, waiting: 0 };
  if (!cfg.jobs) return out;
  let ids = [];
  try { ids = readdirSync(cfg.jobs).filter((f) => /^job-[A-Za-z0-9]+$/.test(f)); } catch { return out; }
  for (const id of ids) {
    const d = `${cfg.jobs}/${id}`;
    let ended = 0;
    try { ended = statSync(`${d}/exit`).mtimeMs; } catch { /* still running, or never started */ }
    // No message comes for one capcomd marked `quiet` (its caller had the result in the foreground), or one the agent
    // stopped itself (capcomd notes who stopped it in `killed`).
    if (ended) { if (!deliveredJobs.has(id) && !existsSync(`${d}/quiet`) && !/^by agt-/.test(readText(`${d}/killed`)) && Date.now() - ended < JOB_GRACE_MS) out.waiting++; continue; }
    let rpid = 0;
    try { rpid = Number(readFileSync(`${d}/rpid`, "utf8")); } catch { /* just launched */ }
    // No runner pid yet: just launched, unless that was a while ago (its runner never started).
    let launched = 0;
    try { launched = statSync(`${d}/spec.json`).mtimeMs; } catch { /* not even that */ }
    if (rpid ? alive(rpid) : Date.now() - launched < JOB_START_MS) out.running++;
  }
  return out;
}

// The baseline, before the agent starts: an unchanged tree isn't a checkpoint.
checkpoint("start");
const child = spawn("/bin/sh", [cfg.script], { stdio: [cfg.input ? "pipe" : "inherit", "inherit", "inherit"] });
report("start", { pid: process.pid, agentPid: child.pid });

// Messages in: one JSON line per user message on the CLI's stdin.
let feed = null;
if (cfg.input) {
  const say = (text) => { try { child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n"); } catch {} };
  child.stdin.on("error", () => {});
  say(readFileSync(cfg.input.prompt, "utf8"));
  let inboxRead = 0, outRead = 0, sentAt = Date.now(), resultAt = 0, closed = false;
  // Complete lines appended to `file` since `from`; returns [lines, new offset].
  const tail = (file, from) => {
    let size = 0;
    try { size = statSync(file).size; } catch { return [[], from]; }
    if (size <= from) return [[], from];
    const fd = openSync(file, "r");
    try {
      // Room for one whole message line (a 1 MB body plus its skills, JSON-escaped): a line is only read once complete.
      const buf = Buffer.alloc(Math.min(size - from, 8 << 20));
      const n = readSync(fd, buf, 0, buf.length, from);
      const text = buf.subarray(0, n).toString("utf8");
      const end = text.lastIndexOf("\n");
      if (end < 0) return [[], from];
      return [text.slice(0, end).split("\n"), from + Buffer.byteLength(text.slice(0, end + 1))];
    } finally { closeSync(fd); }
  };
  feed = setInterval(() => {
    if (closed) return;
    let lines;
    [lines, inboxRead] = tail(cfg.input.inbox, inboxRead);
    for (const l of lines) {
      let m;
      try { m = JSON.parse(l); } catch { continue; }
      if (typeof m.text !== "string") continue;
      say(m.text);
      sentAt = Date.now();
      if (typeof m.from === "string" && m.from.startsWith("job-")) deliveredJobs.add(m.from);
      report("delivered", { seq: m.seq ?? null });
    }
    [lines, outRead] = tail(cfg.jsonl, outRead);
    if (lines.some((l) => { try { return JSON.parse(l).type === "result"; } catch { return false; } })) resultAt = Date.now();
    // Finished, and nothing sent since: end its input so it exits. A message sent before that result but not yet
    // read is still in the pipe: the CLI reads it, answers, and then sees the end. Not while a job of its runs, or
    // the result of one is on its way: that message starts its next turn.
    if (resultAt && sentAt <= resultAt && Date.now() - resultAt >= 1000) {
      const j = jobs();
      if (!j.running && !j.waiting) { closed = true; try { child.stdin.end(); } catch {} }
    }
  }, 500);
}

const beat = setInterval(() => {
  sample();
  report("heartbeat", { events, lastEventAt, ...(cfg.reportTree ? { tree: workTree() } : {}), ...(cfg.jobs ? { jobs: jobs().running } : {}) });
  // The agent committed (claude and codex may): checkpoint the new HEAD now rather than at the next interval.
  try { const h = git(["rev-parse", "HEAD"]); if (lastHead && h !== lastHead) checkpoint("commit"); } catch {}
  // The engine asks for one (the file says why): the agent looks stuck (ADR-019 §2), so the work is safe before
  // anything else, or its spend passed another step of its budget (§3).
  const req = `${cfg.dir}/checkpoint.request`;
  if (existsSync(req)) {
    let why = "";
    try { why = readFileSync(req, "utf8").trim(); unlinkSync(req); } catch {}
    checkpoint(/^[a-z]{1,20}$/.test(why) ? why : "notice");
  }
}, cfg.heartbeatMs);
const every = cfg.checkpointEveryMs > 0 ? setInterval(() => checkpoint("interval"), cfg.checkpointEveryMs) : null;

child.on("exit", (code, signal) => {
  clearInterval(beat);
  if (feed) clearInterval(feed);
  if (every) clearInterval(every);
  sample();
  report("exit", { code, signal, events });
  process.exit(code ?? 128 + (signal === "SIGKILL" ? 9 : 15));
});
// A kill of the process group reaches the agent too; just don't die before it does.
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => { child.kill(s); });
