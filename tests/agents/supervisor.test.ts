// ADR-019 §1, §3: the in-VM supervisor runs the agent, reports heartbeats to its outbox, and checkpoints the workspace
// without touching the agent's working tree, index or history. Run directly with node against a scratch repo.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Git } from "../../src/merge/git";

const SUPERVISOR = new URL("../../src/agents/supervisor.mjs", import.meta.url).pathname;

async function setup(agent: string, o: { checkpointEveryMs?: number; input?: boolean; jobs?: boolean; reportTree?: true | "progress"; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-sup-"));
  const repo = join(dir, "repo");
  const g = new Git(dir);
  await g.ok(["init", "-q", "-b", "main", repo]);
  const r = new Git(repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  await r.ok(["add", "-A"]);
  await r.ok(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
  const jsonl = join(dir, "agent.jsonl"), outbox = join(dir, "outbox.jsonl");
  writeFileSync(join(dir, "agent.sh"), `JSONL=${jsonl}\n${agent}\n`);
  writeFileSync(join(dir, "sup.json"), JSON.stringify({
    script: join(dir, "agent.sh"), dir, repo, jsonl, outbox, ref: "refs/capcomd/checkpoints/agt-1", agentId: "agt-1",
    heartbeatMs: 150, checkpointEveryMs: o.checkpointEveryMs ?? 400,
    ...(o.input ? { input: { prompt: join(dir, "prompt.txt"), inbox: join(dir, "inbox.jsonl") } } : {}),
    ...(o.jobs ? { jobs: join(dir, "jobs") } : {}),
    ...(o.reportTree ? { reportTree: o.reportTree } : {}),
  }));
  if (o.input) writeFileSync(join(dir, "prompt.txt"), "do the thing");
  const run = async () => {
    const p = Bun.spawn(["node", SUPERVISOR, join(dir, "sup.json")], { cwd: repo, stdout: "pipe", stderr: "pipe", ...(o.env ? { env: { ...process.env, ...o.env } } : {}) });
    const code = await p.exited;
    const reports = readFileSync(outbox, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    return { code, reports };
  };
  return { dir, repo, r, run };
}

test("heartbeats while the agent runs, a checkpoint of its changes, and its exit code passed through", async () => {
  const s = await setup(`echo '{"e":1}' >> $JSONL; echo two >> a.txt; echo new > b.txt; sleep 1; echo '{"e":2}' >> $JSONL; exit 3`);
  const { code, reports } = await s.run();
  expect(code).toBe(3);
  const types = reports.map((x) => x.type);
  expect(types[0]).toBe("start");
  expect(types.at(-1)).toBe("exit");
  expect(types.filter((t) => t === "heartbeat").length).toBeGreaterThanOrEqual(3);
  expect(reports.at(-1)).toMatchObject({ code: 3, events: 2 });
  const cps = reports.filter((x) => x.type === "checkpoint");
  expect(cps.length).toBe(1); // later intervals saw the same tree: no new checkpoint
  expect(cps[0]).toMatchObject({ reason: "interval", files: 2 });
  // The checkpoint holds the work; the agent's tree, index and history are as it left them.
  const ref = (await s.r.ok(["rev-parse", "refs/capcomd/checkpoints/agt-1"])).trim();
  expect(ref).toBe(cps[0].sha);
  expect(await s.r.ok(["show", `${ref}:b.txt`])).toBe("new");
  expect(await s.r.ok(["show", `${ref}:a.txt`])).toBe("one\ntwo");
  expect((await s.r.ok(["rev-list", "--count", "HEAD"])).trim()).toBe("1");
  expect((await s.r.ok(["diff", "--cached", "--name-only"])).trim()).toBe("");
  expect((await s.r.run(["status", "--porcelain"])).stdout.split("\n").filter(Boolean).sort()).toEqual([" M a.txt", "?? b.txt"]);
}, 30_000);

test("a commit by the agent is checkpointed at once, not at the next interval", async () => {
  const s = await setup(`echo x > c.txt; git add c.txt; git -c user.name=a -c user.email=a@a commit -qm agent; sleep 1`, { checkpointEveryMs: 0 });
  const { code, reports } = await s.run();
  expect(code).toBe(0);
  const cps = reports.filter((x) => x.type === "checkpoint");
  expect(cps.map((c) => c.reason)).toEqual(["commit"]);
  expect((await s.r.ok(["rev-parse", `${cps[0].sha}^`])).trim()).toBe((await s.r.ok(["rev-parse", "HEAD"])).trim());
}, 30_000);

test("progress (plugin API §16.4): heartbeats carry the workspace's tree, a new one as files change; less often where hashing is slow", async () => {
  const s = await setup(`sleep 0.5; echo two >> a.txt; sleep 1.5; echo new > b.txt; sleep 1.5`, { checkpointEveryMs: 0, reportTree: "progress" });
  const { reports } = await s.run();
  // (A heartbeat 150 ms apart may skip it: hashing this small checkout takes more than a twentieth of that.)
  const trees = reports.filter((x) => x.type === "heartbeat" && typeof x.tree === "string").map((x) => x.tree);
  // HEAD's, then with a.txt changed, then with b.txt too: what the runner reads as its files changing.
  expect([...new Set(trees)]).toHaveLength(3);
  // A git that takes 0.2 s a call: hashing takes over half a second, so the next one waits 20 times that.
  const bin = join(s.dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 0.2\nexec ${Bun.which("git")} "$@"\n`, { mode: 0o755 });
  const slow = await setup(`sleep 2`, { checkpointEveryMs: 0, reportTree: "progress", env: { PATH: `${bin}:${process.env.PATH}` } });
  const beats = (await slow.run()).reports.filter((x) => x.type === "heartbeat");
  expect(beats.length).toBeGreaterThanOrEqual(3);
  expect(beats.filter((x) => typeof x.tree === "string")).toHaveLength(1);
  // `reportTree: true` (no change in the workspace, ADR-019 §2) hashes it at every heartbeat, however slow.
  const every = await setup(`sleep 2`, { checkpointEveryMs: 0, reportTree: true, env: { PATH: `${bin}:${process.env.PATH}` } });
  const all = (await every.run()).reports.filter((x) => x.type === "heartbeat");
  expect(all.length).toBeGreaterThanOrEqual(2);
  expect(all.every((x) => typeof x.tree === "string")).toBe(true);
}, 30_000);

test("an untouched workspace makes no checkpoint", async () => {
  const s = await setup(`sleep 1`);
  const { reports } = await s.run();
  expect(reports.filter((x) => x.type === "checkpoint")).toEqual([]);
}, 30_000);

test("input: the prompt and each inbox message go to the CLI's stdin; after a result with nothing new, stdin closes", async () => {
  // A CLI that logs what it reads, answers the first message after a second (letting a message arrive meanwhile),
  // then answers each later one, and exits when its input ends.
  const s = await setup(`IFS= read -r p; echo "$p" > seen.txt; sleep 1; echo '{"type":"result"}' >> $JSONL
while IFS= read -r m; do echo "$m" >> seen.txt; echo '{"type":"result"}' >> $JSONL; done; exit 0`, { input: true, checkpointEveryMs: 0 });
  setTimeout(() => writeFileSync(join(s.dir, "inbox.jsonl"), JSON.stringify({ seq: 7, text: "also this" }) + "\n"), 300);
  const { code, reports } = await s.run();
  expect(code).toBe(0); // it ended: the supervisor closed its input after the last result
  const seen = readFileSync(join(s.repo, "seen.txt"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(seen).toEqual([
    { type: "user", message: { role: "user", content: "do the thing" } },
    { type: "user", message: { role: "user", content: "also this" } },
  ]);
  expect(reports.filter((x) => x.type === "delivered")).toEqual([expect.objectContaining({ seq: 7 })]);
}, 30_000);

test("jobs: its input stays open while a background job runs and until the job's result message reaches it", async () => {
  // A CLI that answers each message at once, and exits when its input ends; a job of its runs (a live runner, no exit
  // code) when its first turn ends.
  const s = await setup(`IFS= read -r p; echo "$p" > seen.txt; echo '{"type":"result"}' >> $JSONL
while IFS= read -r m; do echo "$m" >> seen.txt; echo '{"type":"result"}' >> $JSONL; done; exit 0`, { input: true, checkpointEveryMs: 0, jobs: true });
  const job = join(s.dir, "jobs", "job-ktest1");
  mkdirSync(job, { recursive: true });
  const runner = Bun.spawn(["sleep", "30"]);
  writeFileSync(join(job, "rpid"), String(runner.pid));
  const t0 = Date.now();
  // The job ends after 2.5 s; its result message comes 1.5 s later (capcomd's poll and delivery).
  setTimeout(() => { writeFileSync(join(job, "exit"), "0"); runner.kill(); }, 2500);
  setTimeout(() => writeFileSync(join(s.dir, "inbox.jsonl"), JSON.stringify({ seq: 3, from: "job-ktest1", text: "your job finished" }) + "\n"), 4000);
  const { code, reports } = await s.run();
  expect(code).toBe(0);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(4000);
  const seen = readFileSync(join(s.repo, "seen.txt"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(seen.map((m) => m.message.content)).toEqual(["do the thing", "your job finished"]);
  // Its heartbeats said a job ran, then none.
  const beats = reports.filter((x) => x.type === "heartbeat").map((x) => x.jobs);
  expect(beats).toContain(1);
  expect(beats.at(-1)).toBe(0);
}, 30_000);

test("jobs: no wait for a job capcomd marked quiet, nor for one whose runner never started", async () => {
  const s = await setup(`IFS= read -r p; echo "$p" > seen.txt; echo '{"type":"result"}' >> $JSONL
while IFS= read -r m; do echo "$m" >> seen.txt; echo '{"type":"result"}' >> $JSONL; done; exit 0`, { input: true, checkpointEveryMs: 0, jobs: true });
  // One ended just now that answered its caller in the foreground (quiet: no message comes); one launched a minute ago
  // whose runner never wrote its pid.
  const quick = join(s.dir, "jobs", "job-kquiet1"), stale = join(s.dir, "jobs", "job-kstale1");
  for (const d of [quick, stale]) mkdirSync(d, { recursive: true });
  writeFileSync(join(quick, "exit"), `0:${Date.now()}`);
  writeFileSync(join(quick, "quiet"), "");
  writeFileSync(join(stale, "spec.json"), "{}");
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(stale, "spec.json"), old, old);
  const t0 = Date.now();
  const { code, reports } = await s.run();
  expect(code).toBe(0);
  expect(Date.now() - t0).toBeLessThan(10_000);
  expect(reports.filter((x) => x.type === "heartbeat").map((x) => x.jobs).every((n) => n === 0)).toBe(true);
}, 30_000);
