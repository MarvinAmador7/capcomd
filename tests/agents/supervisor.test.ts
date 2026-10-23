// ADR-019 §1, §3: the in-VM supervisor runs the agent, reports heartbeats to its outbox, and checkpoints the workspace
// without touching the agent's working tree, index or history. Run directly with node against a scratch repo.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Git } from "../../src/merge/git";

const SUPERVISOR = new URL("../../src/agents/supervisor.mjs", import.meta.url).pathname;

async function setup(agent: string, o: { checkpointEveryMs?: number } = {}) {
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
  }));
  const run = async () => {
    const p = Bun.spawn(["node", SUPERVISOR, join(dir, "sup.json")], { cwd: repo, stdout: "pipe", stderr: "pipe" });
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

test("an untouched workspace makes no checkpoint", async () => {
  const s = await setup(`sleep 1`);
  const { reports } = await s.run();
  expect(reports.filter((x) => x.type === "checkpoint")).toEqual([]);
}, 30_000);
