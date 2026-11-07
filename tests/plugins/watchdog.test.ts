// The watchdog built-in (docs/spec/plugin-api.md §15.5, §16.4) on the test kit's context, with the kernel's services
// faked and the clock set by the test: what counts as progress (files changed, as a checkpoint or as the runner's
// `worked`, an agent under it spawned or ended, the end of a verification or approval it waited on) and what doesn't
// (tool calls, a job's end), `stalled` at stalledAfterMs and a stop at stopAfterMs (both from the last progress) saying
// what it saw, progress clearing the notice, waiting (a job, a check, an approval, a foreground command, up to a limit
// for a command) holding the clock, an agent with agents of its own judged through them, its memory across a restart
// (the time the daemon was down doesn't count), its one timer, its config refused when the stop comes before the notice
// and warned about when the notice would come before progress can show. The same against a daemon:
// tests/scenarios/watchdog.test.ts.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testkit } from "../../packages/plugin/src/testkit";
import { PluginError } from "../../packages/plugin/src/errors";
import type { Agent, Job, JobSpec, Principal } from "../../packages/plugin/src/shapes";
import type { AgentChange } from "../../packages/plugin/src/hooks";
import type { StorageService } from "../../packages/plugin/src/context";
import { configWarning, manifest, plugin, stalledDetail, watchdog, watchdogPlugin, type WatchdogConfig, type WatchdogOptions } from "../../src/plugins/watchdog";
import { pluginStore, storageService } from "../../src/plugins/storage";

const MIN = 60_000;
const T0 = Date.parse("2026-11-06T10:00:00.000Z");
const CFG: WatchdogConfig = { stalledAfterMs: 15 * MIN, stopAfterMs: 45 * MIN, everyMs: MIN };
const RUN = "run-wd1";
let now = T0;
const at = (ms: number) => { now = T0 + ms; setSystemTime(new Date(now)); };
beforeEach(() => at(0));
afterEach(() => setSystemTime());

/** The kernel, faked: agents by id, the notices and cancels asked for, the plugin's timers. */
function kernel() {
  const agents = new Map<string, Agent>();
  const notices: Array<{ agentId: string; notice: { kind: string; detail: string } | null }> = [];
  const cancels: Array<{ agentId: string; reason: string }> = [];
  const timers: Array<{ spec: JobSpec; key?: string | undefined; jobId: string; state: Job["state"] }> = [];
  const agent = (id: string, parent: string | null = null, status: Agent["status"] = "running"): Agent => {
    const a: Agent = { id, runId: RUN, parent, depth: parent ? 1 : 0, profile: "worker", status, text: "", task: "t", provider: "claude", model: null, effort: null, updatedAt: null };
    agents.set(id, a);
    return a;
  };
  const job = (t: (typeof timers)[number]): Job => ({ jobId: t.jobId, plugin: "watchdog", spec: t.spec, state: t.state, startedAt: new Date(T0).toISOString(), endedAt: null, result: null, reason: null });
  const services = {
    agents: {
      get: async (_run: string, id: string) => { const a = agents.get(id); if (!a) throw new PluginError("not_found", `agent ${id} not found`); return a; },
      notice: async (_run: string, agentId: string, notice: { kind: string; detail: string } | null) => { notices.push({ agentId, notice }); },
      cancel: async (_run: string, agentId: string, reason: string) => { cancels.push({ agentId, reason }); const a = agents.get(agentId); if (a) a.status = "cancelled"; },
    },
    jobs: {
      start: async (spec: JobSpec, o?: { key?: string }) => {
        const had = timers.find((t) => t.key === o?.key);
        if (had) return job(had);
        const t = { spec, key: o?.key, jobId: `job-${timers.length + 1}aaaaaa`, state: "running" as const };
        timers.push(t);
        return job(t);
      },
      list: async () => timers.filter((t) => t.state === "running").map(job),
      cancel: async (jobId: string) => { const t = timers.find((x) => x.jobId === jobId)!; t.state = "killed"; return job(t); },
    },
  };
  return { agents, notices, cancels, timers, agent, services };
}

async function boot(k: ReturnType<typeof kernel>, o: { cfg?: Partial<WatchdogConfig>; storage?: StorageService; options?: WatchdogOptions } = {}) {
  const root = join(mkdtempSync(join(tmpdir(), "capcomd-wd-")), "storage");
  const storage = o.storage ?? storageService(pluginStore("watchdog", root));
  const fake = testkit.fakeContext(manifest, { ...CFG, ...o.cfg }, { services: { ...k.services, storage } as never });
  const w = watchdog(fake.ctx as never, o.options);
  await w.start();
  const changed = (a: Agent, change: AgentChange, principal?: Principal) => fake.fire("agent.changed", { agent: a, change }, principal ? { principal } : {});
  return { fake, w, storage, changed, tick: async () => { await w.tick(); await w.flushed(); } };
}

const ckpt = (): AgentChange => ({ kind: "checkpointed", files: 1, commit: "a".repeat(40), at: new Date(now).toISOString() });
const step = (): AgentChange => ({ kind: "step", step: { kind: "Bash", n: 1, startedAt: new Date(now).toISOString(), endedAt: new Date(now).toISOString() } });
const started = (): AgentChange => ({ kind: "started", machine: null, attempt: 1 });
/** The runner's report: its files changed, and/or it waits on a command started at `commandAt` (ms from T0). */
const worked = (o: { files?: boolean; commandAt?: number } = {}): AgentChange => ({ kind: "worked", files: o.files ?? false, command: o.commandAt === undefined ? null : { since: new Date(T0 + o.commandAt).toISOString() }, at: new Date(now).toISOString() });
const kinds = (k: ReturnType<typeof kernel>) => k.notices.map((n) => `${n.agentId}:${n.notice?.kind ?? "cleared"}`);

describe("the watchdog", () => {
  test("no change to its files: stalled at 15 min, cleared by progress, stopped at 45 min, said once on the run's stream", async () => {
    const k = kernel();
    const a = k.agent("agt-w1");
    const { changed, tick, fake } = await boot(k);
    await changed(a, started());
    at(5 * MIN); await changed(a, ckpt());
    // Tool calls alone are activity, not progress.
    for (const m of [10, 15, 19]) { at(m * MIN); await changed(a, step()); await tick(); }
    expect(k.notices).toEqual([]);
    at(20 * MIN); await tick();
    expect(k.notices).toEqual([{ agentId: "agt-w1", notice: { kind: "stalled", detail: stalledDetail(15 * MIN, CFG, { steps: 3, commandMs: null }) } }]);
    // What it saw: no progress, and the three steps it took meanwhile.
    expect(k.notices[0]!.notice!.detail).toBe("no progress for 15 min: no file change seen, no agent of its own started or ended, no check or approval it waited on finished; it finished 3 tool steps meanwhile; the watchdog stops it after 45 min without progress");
    // Raised once, however long it stays quiet.
    at(21 * MIN); await tick();
    expect(k.notices).toHaveLength(1);
    // Its files change: the notice goes, the clock starts again.
    at(22 * MIN); await changed(a, ckpt());
    await Bun.sleep(0);
    expect(kinds(k)).toEqual(["agt-w1:stalled", "agt-w1:cleared"]);
    at(22 * MIN + 15 * MIN - 1); await tick();
    expect(k.notices).toHaveLength(2);
    at(37 * MIN); await tick();
    expect(kinds(k)).toEqual(["agt-w1:stalled", "agt-w1:cleared", "agt-w1:stalled"]);
    at(66 * MIN); await tick();
    expect(k.cancels).toEqual([]);
    at(67 * MIN); await tick();
    expect(k.cancels).toEqual([{ agentId: "agt-w1", reason: "no progress for 45 min: no file change seen, no agent of its own started or ended, no check or approval it waited on finished; it finished no tool step meanwhile" }]);
    expect(fake.emitted()).toEqual([{ type: "plugin.watchdog.stopped", stream: RUN, data: { agentId: "agt-w1", quietMs: 45 * MIN, stalledAt: new Date(T0 + 37 * MIN).toISOString() } }]);
    // It ends (cancelled): forgotten; nothing more about it.
    await changed({ ...a, status: "cancelled" }, { kind: "ended", status: "cancelled", result: null });
    at(90 * MIN); await tick();
    expect(k.cancels).toHaveLength(1);
    expect(fake.emitted()).toHaveLength(1);
  });

  test("an agent with agents of its own is judged through them: their progress is its, their end too", async () => {
    const k = kernel();
    const p = k.agent("agt-p"), c1 = k.agent("agt-c1", "agt-p"), c2 = k.agent("agt-c2", "agt-p");
    const { changed, tick } = await boot(k);
    await changed(p, started());
    at(1 * MIN); await changed(c1, { kind: "spawned" }); await changed(c1, started());
    await changed(c2, { kind: "spawned" }); await changed(c2, started());
    // c1 keeps changing files; c2 doesn't: c2 alone stalls (at 16 min) and is stopped (at 46), its parent is never judged.
    for (let m = 2; m <= 48; m += 2) {
      at(m * MIN); await changed(c1, ckpt()); await tick();
      expect(kinds(k)).toEqual(m < 16 ? [] : ["agt-c2:stalled"]);
      expect(k.cancels.map((c) => c.agentId)).toEqual(m < 46 ? [] : ["agt-c2"]);
    }
    await changed({ ...c2, status: "cancelled" }, { kind: "ended", status: "cancelled", result: null });
    // c1 hands back at 50 min: the planner's clock starts there, and it is judged on its own from then on.
    at(50 * MIN); await changed({ ...c1, status: "done" }, { kind: "ended", status: "done", result: null });
    at(64 * MIN); await tick();
    expect(kinds(k)).toEqual(["agt-c2:stalled"]);
    at(65 * MIN); await tick();
    expect(kinds(k)).toEqual(["agt-c2:stalled", "agt-p:stalled"]);
  });

  test("waiting on a job, a verification, an approval or a paused agent under it holds the clock; a check's or approval's end is progress", async () => {
    const k = kernel();
    const p = k.agent("agt-p"), c = k.agent("agt-c", "agt-p");
    const { changed, tick, fake } = await boot(k);
    await changed(p, started()); await changed(c, { kind: "spawned" }); await changed(c, started());
    const exec: Job = { jobId: "job-x1aaaaaa", plugin: null, spec: { kind: "exec", runId: RUN, owner: { agentId: "agt-c" }, cmd: ["npm test"], label: "tests" }, state: "running", startedAt: new Date(now).toISOString(), endedAt: null, result: null, reason: null };
    await fake.fire("job.changed", { job: exec, change: { kind: "started" } });
    at(40 * MIN); await tick();
    expect(k.notices).toEqual([]);
    at(41 * MIN); await fake.fire("job.changed", { job: { ...exec, state: "done" }, change: { kind: "ended", state: "done" } });
    at(55 * MIN); await tick();
    expect(k.notices).toEqual([]);
    // A verification it asked for (its principal), then an approval it waits on.
    const agentC: Principal = { kind: "agent", agentId: "agt-c", runId: RUN };
    const v = { vfyId: "vfy-1", runId: RUN, ref: "agt-c", target: "main", check: null, state: "running" as const, tested: null, passed: null, reasons: [] };
    await fake.fire("verify.changed", { verification: v, change: { kind: "started" } }, { principal: agentC });
    at(95 * MIN); await tick();
    expect(k.notices).toEqual([]);
    await fake.fire("verify.changed", { verification: { ...v, state: "passed", passed: true }, change: { kind: "finished", passed: true } }, { principal: agentC });
    const ap = { approvalId: "apr-1", runId: RUN, agentId: "agt-c", kind: "merge" as const, question: "Merge?", subject: {}, status: "pending" as const, requestedAt: new Date(now).toISOString(), expiresAt: null };
    await fake.fire("approval.changed", { approval: ap, change: { kind: "requested" } });
    at(300 * MIN); await tick();
    expect(k.notices).toEqual([]);
    await fake.fire("approval.changed", { approval: { ...ap, status: "approved" }, change: { kind: "decided", decision: { approvalId: "apr-1", status: "approved", decidedBy: null, decidedAt: new Date(now).toISOString(), reason: null } } });
    // Paused (a usage limit) for hours: neither it nor its parent stalls; resumed, its clock starts again.
    at(301 * MIN); await changed({ ...c, status: "paused" }, { kind: "paused", by: "quota" });
    k.agents.get("agt-c")!.status = "paused";
    at(600 * MIN); await tick();
    expect(k.notices).toEqual([]);
    k.agents.get("agt-c")!.status = "running";
    await changed(c, { kind: "resumed", by: "capcomd" });
    at(614 * MIN); await tick();
    expect(k.notices).toEqual([]);
    at(615 * MIN); await tick();
    expect(kinds(k)).toEqual(["agt-c:stalled"]);
  });

  test("across a restart: it remembers what it knew, and the time the daemon was down doesn't count", async () => {
    const k = kernel();
    const a = k.agent("agt-r1"), gone = k.agent("agt-gone");
    const first = await boot(k);
    await first.changed(a, started()); await first.changed(gone, started());
    at(10 * MIN); await first.tick();
    await first.w.flushed();
    // Down for two hours; meanwhile one agent ended where nobody told the watchdog.
    k.agents.delete("agt-gone");
    at(130 * MIN);
    const second = await boot(k, { storage: first.storage });
    expect([...second.w.watched.keys()].sort()).toEqual([`${RUN}/agt-gone`, `${RUN}/agt-r1`]);
    at(134 * MIN); await second.tick();
    expect(k.notices).toEqual([]);
    at(135 * MIN); await second.tick();
    expect(kinds(k)).toEqual(["agt-r1:stalled"]);
    expect([...second.w.watched.keys()]).toEqual([`${RUN}/agt-r1`]);
    // Its one timer: kept by its key across the restart; another interval's is stopped.
    expect(k.timers.map((t) => [t.key, t.spec, t.state])).toEqual([["clock-60000", { kind: "timer", runId: null, owner: { plugin: true }, label: "watchdog clock", everyMs: MIN }, "running"]]);
    await boot(k, { storage: first.storage, cfg: { everyMs: 30_000 } });
    expect(k.timers.map((t) => [t.key, t.state])).toEqual([["clock-60000", "killed"], ["clock-30000", "running"]]);
  });

  test("its own clock's fire makes it look; stopAfterMs 0 never stops; a stop before the notice is refused", async () => {
    const k = kernel();
    const a = k.agent("agt-z1");
    const root = mkdtempSync(join(tmpdir(), "capcomd-wd-"));
    const fake = testkit.fakeContext(manifest, { ...CFG, stopAfterMs: 0 }, { services: { ...k.services, storage: storageService(pluginStore("watchdog", root)) } as never });
    await testkit.load(fake, watchdogPlugin({ showsWork: async () => true }) as never);
    await fake.fire("agent.changed", { agent: a, change: started() });
    at(500 * MIN);
    const clock = k.timers[0]!;
    await fake.fire("job.changed", { job: { jobId: clock.jobId, plugin: "watchdog", spec: clock.spec, state: "running", startedAt: new Date(T0).toISOString(), endedAt: null, result: null, reason: null }, change: { kind: "fired", n: 1 } });
    for (let i = 0; i < 50 && !k.notices.length; i++) await Bun.sleep(5);
    expect(k.notices).toEqual([{ agentId: "agt-z1", notice: { kind: "stalled", detail: "no progress for 500 min: no file change seen, no agent of its own started or ended, no check or approval it waited on finished; it finished no tool step meanwhile" } }]);
    expect(k.cancels).toEqual([]);
    await fake.dispose();
    const bad = testkit.fakeContext(manifest, { ...CFG, stopAfterMs: 10 * MIN }, { services: k.services as never });
    await expect(testkit.load(bad, plugin as never)).rejects.toThrow(/stopAfterMs is 600000: it must be 0 \(never stop\) or more than stalledAfterMs \(900000\)/);
  });

  test("an agent whose work never shows as files changing (a reviewer, a report, an orchestrate agent) isn't judged", async () => {
    const k = kernel();
    const rev = k.agent("agt-rev"), wrk = k.agent("agt-wrk");
    const asked: string[] = [];
    let answering = false;
    const showsWork = async (_run: string, id: string) => { asked.push(id); if (!answering) throw new PluginError("unavailable", "no engine"); return id !== "agt-rev"; };
    const { changed, tick } = await boot(k, { options: { showsWork } });
    await changed(rev, started()); await changed(wrk, started());
    // The kernel didn't answer: nobody is judged this time, and it is asked again at the next look.
    at(16 * MIN); await tick();
    expect(asked).toEqual(["agt-rev", "agt-wrk"]);
    expect(k.notices).toEqual([]);
    answering = true;
    at(17 * MIN); await tick();
    expect(kinds(k)).toEqual(["agt-wrk:stalled"]);
    at(46 * MIN); await tick();
    expect(k.cancels.map((c) => c.agentId)).toEqual(["agt-wrk"]);
    // Asked once each: the reviewer stays unjudged however long it reads.
    at(300 * MIN); await tick();
    expect(asked).toEqual(["agt-rev", "agt-wrk", "agt-rev", "agt-wrk"]);
    expect(kinds(k)).toEqual(["agt-wrk:stalled"]);
    expect(k.cancels.map((c) => c.agentId)).toEqual(["agt-wrk"]);
  });

  test("while the kernel's own notice shows, stalled isn't raised over it; the stop still comes", async () => {
    const k = kernel();
    const a = k.agent("agt-n1");
    const { changed, tick } = await boot(k);
    const kernelNotice = (kind: "idle" | "spinning" | null) => changed(a, { kind: "notice", notice: kind ? { kind, detail: "x" as never, at: new Date(now).toISOString() } : null });
    await changed(a, started());
    at(5 * MIN); await kernelNotice("idle");
    at(20 * MIN); await tick();
    expect(k.notices).toEqual([]);
    // The kernel clears its own: the watchdog's comes at its next look.
    at(25 * MIN); await kernelNotice(null);
    at(26 * MIN); await tick();
    expect(kinds(k)).toEqual(["agt-n1:stalled"]);
    // The kernel raises another over it: not raised back over that one.
    at(27 * MIN); await kernelNotice("spinning");
    at(28 * MIN); await tick();
    at(40 * MIN); await tick();
    expect(kinds(k)).toEqual(["agt-n1:stalled"]);
    at(45 * MIN); await tick();
    expect(k.cancels.map((c) => c.agentId)).toEqual(["agt-n1"]);
  });

  test("its files changing between checkpoints is progress: an editing agent isn't flagged under a 90 s limit, a silent one is", async () => {
    const k = kernel();
    const ed = k.agent("agt-ed"), quiet = k.agent("agt-quiet");
    const cfg = { stalledAfterMs: 90_000, stopAfterMs: 300_000, everyMs: 10_000 };
    const { changed, tick, fake } = await boot(k, { cfg });
    expect(fake.logs().filter((l) => l.level === "warn")).toEqual([]);
    await changed(ed, started()); await changed(quiet, started());
    // No checkpoint in five minutes (they come every 10): the editor's runner says its files changed every 30 s.
    for (let s = 10; s <= 300; s += 10) {
      at(s * 1000);
      if (s % 30 === 0) await changed(ed, worked({ files: true }));
      await tick();
    }
    expect(kinds(k)).toEqual(["agt-quiet:stalled"]);
    expect(k.notices[0]!.notice!.detail).toBe("no progress for 90 s: no file change seen, no agent of its own started or ended, no check or approval it waited on finished; it finished no tool step meanwhile; the watchdog stops it after 5 min without progress");
    expect(k.cancels.map((c) => c.agentId)).toEqual(["agt-quiet"]);
    // A report with no file change in it (a command, already gone) isn't progress.
    at(330_000); await changed(ed, worked({ commandAt: 329_000 }));
    at(400_000); await tick();
    expect(kinds(k)).toEqual(["agt-quiet:stalled", "agt-ed:stalled"]);
  });

  test("a foreground command holds the clock while it runs, for up to stalledAfterMs; one that hangs is flagged saying so", async () => {
    const k = kernel();
    const short = k.agent("agt-short"), hung = k.agent("agt-hung");
    const { changed, tick } = await boot(k);
    await changed(short, started()); await changed(hung, started());
    // Both quiet for 10 min, then each starts a command: the short one's runs 12 min, the hung one's never ends.
    for (let s = 10 * 60; s <= 40 * 60; s += 30) {
      at(s * 1000);
      if (s <= 22 * 60) await changed(short, worked({ commandAt: 10 * MIN }));
      await changed(hung, worked({ commandAt: 10 * MIN }));
      if (s % 60 === 0) await tick();
      // 26 min after it started (12 of them in its command), the short one isn't flagged: its command's time didn't count.
      if (s === 26 * 60) expect(kinds(k)).toEqual([]);
      // Nor the hung one at 29 min: 15 min of its command didn't count, and 10 before it plus 4 after are 14.
      if (s === 29 * 60) expect(kinds(k)).toEqual(["agt-short:stalled"]);
    }
    // The short one: quiet 10 min before its command and 5 after it (at 27 min); the hung one at 30 min, saying why.
    expect(kinds(k)).toEqual(["agt-short:stalled", "agt-hung:stalled"]);
    expect(k.notices[0]!.notice!.detail).toBe("no progress for 15 min: no file change seen, no agent of its own started or ended, no check or approval it waited on finished; it finished no tool step meanwhile; the watchdog stops it after 45 min without progress");
    expect(k.notices[1]!.notice!.detail).toBe("no progress for 15 min: no file change seen, no agent of its own started or ended, no check or approval it waited on finished; it finished no tool step meanwhile; it has been waiting on one command for 20 min; the watchdog stops it after 45 min without progress");
    // Its files changing while the command runs is progress, as ever: the notice goes.
    at(41 * MIN); await changed(hung, worked({ files: true, commandAt: 10 * MIN }));
    await Bun.sleep(0);
    expect(kinds(k)).toEqual(["agt-short:stalled", "agt-hung:stalled", "agt-hung:cleared"]);
  });

  test("a job's end isn't progress, but the time it ran doesn't count, even across a restart", async () => {
    const k = kernel();
    const a = k.agent("agt-j1");
    const first = await boot(k);
    await first.changed(a, started());
    const exec: Job = { jobId: "job-q1aaaaaa", plugin: null, spec: { kind: "exec", runId: RUN, owner: { agentId: "agt-j1" }, cmd: ["ls"], label: "quick" }, state: "running", startedAt: new Date(now).toISOString(), endedAt: null, result: null, reason: null };
    // A quick one at 10 min (half a minute): the clock moves on by that half minute, no more.
    at(10 * MIN); await first.fake.fire("job.changed", { job: exec, change: { kind: "started" } });
    at(10.5 * MIN); await first.fake.fire("job.changed", { job: { ...exec, state: "done" }, change: { kind: "ended", state: "done" } });
    at(15.4 * MIN); await first.tick();
    expect(k.notices).toEqual([]);
    at(15.5 * MIN); await first.tick();
    expect(kinds(k)).toEqual(["agt-j1:stalled"]);
    // A longer one, from 20 min, across two hours with the daemon down: the time it ran while the daemon was up doesn't
    // count, once.
    const b = k.agent("agt-j2");
    at(16 * MIN); await first.changed(b, started());
    const long: Job = { ...exec, jobId: "job-l1aaaaaa", spec: { ...exec.spec, owner: { agentId: "agt-j2" } } as JobSpec };
    at(20 * MIN); await first.fake.fire("job.changed", { job: long, change: { kind: "started" } });
    at(25 * MIN); await first.tick(); await first.w.flushed();
    at(145 * MIN);
    const second = await boot(k, { storage: first.storage });
    at(150 * MIN); await second.fake.fire("job.changed", { job: { ...long, state: "done" }, change: { kind: "ended", state: "done" } });
    // 4 min quiet before it: stalled 11 min after it ended, not sooner.
    at(160.9 * MIN); await second.tick();
    expect(kinds(k)).toEqual(["agt-j1:stalled"]);
    at(161 * MIN); await second.tick();
    expect(kinds(k)).toEqual(["agt-j1:stalled", "agt-j2:stalled"]);
  });

  test("a stall limit shorter than progress takes to show is warned about, not refused", async () => {
    expect(configWarning({ stalledAfterMs: 60_000 })).toBeNull();
    expect(configWarning({ stalledAfterMs: 59_999 })).toBe("plugins.watchdog.stalledAfterMs is 59999: below 60000, how long an agent's progress (its files changing, a command it waits on) may take to show, so an agent that is working may be flagged");
    const k = kernel();
    const { fake } = await boot(k, { cfg: { stalledAfterMs: 30_000, stopAfterMs: 0 } });
    expect(fake.logs().filter((l) => l.level === "warn").map((l) => l.message)).toEqual([configWarning({ stalledAfterMs: 30_000 })!]);
  });

  test("it loads and disposes cleanly, and answers every hook it declares", async () => {
    await testkit.loadDispose(manifest, plugin as never);
    await testkit.hookContract(manifest, plugin as never);
  });
});
