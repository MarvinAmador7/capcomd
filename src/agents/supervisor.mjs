#!/usr/bin/env node
// ADR-019 §1, §3: the in-VM supervisor. It runs next to the agent CLI (run.sh starts it when the VM has node), and
// reports up through an outbox the engine drains: heartbeats while it is alive, and checkpoints of the workspace.
// Dependency-free, like vm-cli.mjs. Config (JSON file, argv[2]):
//   { script, dir, repo, jsonl, outbox, ref, agentId, heartbeatMs, checkpointEveryMs, input? }
// It never pushes: the agent must not hold push credentials, so the engine pushes the checkpoint ref it reports.
// With `input` ({ prompt, inbox }), the agent CLI reads user messages on stdin (claude --input-format stream-json):
// the supervisor sends the prompt, then each message the engine appends to `inbox`, and closes stdin once the agent
// has finished (a result) with nothing sent since, which ends the CLI.
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";

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
let lastTree = null, lastHead = null;
function checkpoint(reason) {
  try {
    const head = git(["rev-parse", "HEAD"]);
    const idx = { GIT_INDEX_FILE: `${cfg.dir}/checkpoint.index` };
    git(["read-tree", head], idx);
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
      const buf = Buffer.alloc(Math.min(size - from, 1 << 20));
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
      report("delivered", { seq: m.seq ?? null });
    }
    [lines, outRead] = tail(cfg.jsonl, outRead);
    if (lines.some((l) => { try { return JSON.parse(l).type === "result"; } catch { return false; } })) resultAt = Date.now();
    // Finished, and nothing sent since: end its input so it exits. A message sent before that result but not yet
    // read is still in the pipe: the CLI reads it, answers, and then sees the end.
    if (resultAt && sentAt <= resultAt && Date.now() - resultAt >= 1000) { closed = true; try { child.stdin.end(); } catch {} }
  }, 500);
}

const beat = setInterval(() => {
  sample();
  report("heartbeat", { events, lastEventAt });
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
