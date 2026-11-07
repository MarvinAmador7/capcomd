// The jobs service without an engine (docs/spec/plugin-api.md §16.2, src/jobs/): a job's process in a machine (here
// this host, as a scripted agent's), the daemon's plugin timers (fired on schedule, re-armed from their records, a
// missed fire fired once, idempotent by key, cancelled), `ctx.jobs` refused outside the daemon, and the Docker sweep as
// sandbox-docker's own timer. A run's jobs (records in its kv, the agent's message) are tests/scenarios/jobs.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Candidate } from "../../packages/plugin/src/host/host";
import type { PluginContext, PluginModule } from "../../packages/plugin/src/context";
import type { HookCall } from "../../packages/plugin/src/hooks";
import { PluginError } from "../../packages/plugin/src/errors";
import { launch, look, signal, tails, type JobMachine } from "../../src/jobs/machine";
import { fitJobRecord } from "../../src/jobs/record";
import { valueBytes } from "../../src/primitives/board";
import { jobLimits, jobMessage, resetJobs, resumeTimers, useDaemonEvents, type JobRecord } from "../../src/jobs/service";
import { kernelHost } from "../../src/plugins/host";
import { useHooks } from "../../src/plugins/hooks";
import { useSandboxHost } from "../../src/plugins/sandboxes";
import { sandboxDocker, SWEEP_EVERY_MS } from "../../src/plugins/builtin/sandbox-docker";
import { stateDir } from "../../src/utils/home";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => { resetJobs(); useHooks(null); useSandboxHost(null); useDaemonEvents(null); });

function hostMachine(): JobMachine {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-jobs-m-"));
  return {
    runId: "run-t", agentId: "agt-t", dir: join(dir, "jobs"), cwd: dir, node: Bun.which("node") ?? "node",
    exec: (cmd, o) => new Promise((done) => execFile(cmd[0]!, cmd.slice(1), { cwd: o.cwd, timeout: o.timeoutMs, encoding: "utf8" }, (e, stdout, stderr) => done({ code: e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : 1) : 0, stdout, stderr }))),
  };
}
async function until<T>(f: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await sleep(50); }
}

describe("a job's process in its machine (src/jobs/machine.ts)", () => {
  test("it runs detached, its output and exit code land in its directory, and a look reports each", async () => {
    const m = hostMachine();
    await launch(m, "job-aaaaaa1", { cmd: ["echo out-1; echo err-1 >&2; sleep 0.5; echo out-2; exit 3"], cwd: m.cwd });
    await launch(m, "job-aaaaaa2", { cmd: ["printf", "%s|", "a b", "$HOME"], cwd: m.cwd, env: { CAPCOMD_X: "1" } });
    expect((await look(m, ["job-aaaaaa1"])).get("job-aaaaaa1")?.state).toBe("running");
    const s = await until(async () => { const x = (await look(m, ["job-aaaaaa1", "job-aaaaaa2", "job-nothere"])); return x.get("job-aaaaaa1")?.state === "exited" && x.get("job-aaaaaa2")?.state === "exited" ? x : null; });
    expect(s.get("job-aaaaaa1")).toMatchObject({ state: "exited", code: 3, out: 12, err: 6, killed: null });
    expect((s.get("job-aaaaaa1") as { at: number }).at).toBeGreaterThan(Date.now() - 10_000);
    expect(s.get("job-nothere")).toEqual({ state: "gone", why: "its files are gone from its machine" });
    expect(await tails(m, "job-aaaaaa1", 1000, 1000)).toEqual({ stdout: "out-1\nout-2\n", stderr: "err-1\n", truncated: false });
    expect(await tails(m, "job-aaaaaa1", 6, 1000)).toEqual({ stdout: "out-2\n", stderr: "err-1\n", truncated: true });
    // argv runs without a shell: nothing is expanded.
    expect((await tails(m, "job-aaaaaa2", 100, 100)).stdout).toBe("a b|$HOME|");
  });

  test("a signal stops its whole process group, noting why; a runner that died without an exit code is gone", async () => {
    const m = hostMachine();
    const pidFile = join(m.cwd, "child.pid");
    await launch(m, "job-bbbbbb1", { cmd: [`sleep 300 & echo $! > ${pidFile}; wait`], cwd: m.cwd });
    await until(async () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim());
    const child = Number(readFileSync(pidFile, "utf8"));
    await signal(m, "job-bbbbbb1", "TERM", "by agt-t: done with it");
    const s = await until(async () => { const x = (await look(m, ["job-bbbbbb1"])).get("job-bbbbbb1"); return x?.state === "exited" ? x : null; });
    expect(s).toMatchObject({ state: "exited", code: 143, killed: "by agt-t: done with it" });
    // The sleep it started went with it.
    await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } }, 5000);

    await launch(m, "job-bbbbbb2", { cmd: ["sleep 300"], cwd: m.cwd });
    const rpid = await until(async () => { try { return Number(readFileSync(join(m.dir, "job-bbbbbb2", "rpid"), "utf8")) || null; } catch { return null; } });
    const pid = await until(async () => { try { return Number(readFileSync(join(m.dir, "job-bbbbbb2", "pid"), "utf8")) || null; } catch { return null; } });
    process.kill(rpid, "SIGKILL");
    expect(await until(async () => { const x = (await look(m, ["job-bbbbbb2"])).get("job-bbbbbb2"); return x?.state === "gone" ? x : null; })).toEqual({ state: "gone", why: "its process is gone, with no exit code (its machine restarted?)" });
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  });

  test("a machine without the node it names refuses to start one", async () => {
    const m = { ...hostMachine(), node: "/nonexistent/node" };
    await expect(launch(m, "job-cccccc1", { cmd: ["true"], cwd: m.cwd })).rejects.toThrow(/no node in this machine/);
  });

  test("a runner that doesn't start is a failed start, not a job that looks like it runs forever", async () => {
    // A "node" that runs nothing: the runner never writes its pid.
    const m = { ...hostMachine(), node: "/usr/bin/true" };
    await expect(launch(m, "job-cccccc2", { cmd: ["sleep 1"], cwd: m.cwd })).rejects.toThrow(/the job's runner didn't start/);
  }, 15_000);
});

describe("limits and messages", () => {
  test("a profile's jobs block, else CAPCOMD_JOBS_*, else the defaults (5 s foreground for orchestrate)", () => {
    expect(jobLimits(null)).toEqual({ max: 8, foregroundMs: 60_000, afterTurnMs: 1_800_000 });
    expect(jobLimits({ toolMode: "orchestrate" }).foregroundMs).toBe(5_000);
    expect(jobLimits({ jobs: { max: 2, foregroundMs: 1000 } })).toEqual({ max: 2, foregroundMs: 1000, afterTurnMs: 1_800_000 });
    process.env.CAPCOMD_JOBS_MAX = "3";
    try { expect(jobLimits(null).max).toBe(3); } finally { delete process.env.CAPCOMD_JOBS_MAX; }
  });

  test("a settled record fits the kv's 64 KB: its output's tails lose their oldest part, the longer one first", () => {
    const max = 64 * 1024;
    const rec = (stdout: string, stderr: string) => ({ jobId: "job-fit1", plugin: null, spec: { kind: "exec", runId: "run-t", owner: { agentId: "agt-t" }, cmd: [`: ${"c".repeat(16_000)}`], label: "big" }, state: "done", startedAt: "2026-11-05T10:00:00.000Z", endedAt: "2026-11-05T10:01:00.000Z", result: { code: 0, stdout, stderr, truncated: false }, reason: null, by: "agt-t", timeoutMs: null, paramsHash: "h" });
    // 48 KB of lines of quotes (each " is two bytes in JSON, each newline two) and 16 KB of stderr, under a 16 KB cmd.
    const out = `${'"x"\n'.repeat(12 * 1024 - 1)}last-line\n`, err = "e".repeat(16 * 1024);
    const big = rec(out, err);
    expect(valueBytes(big)).toBeGreaterThan(max);
    const fit = fitJobRecord(big, max);
    expect(valueBytes(fit)).toBeLessThanOrEqual(max);
    expect(valueBytes(fit)).toBeGreaterThan(max - 16);
    expect(fit.result).toMatchObject({ code: 0, stderr: err, truncated: true });
    expect(out.endsWith(fit.result.stdout)).toBe(true);
    expect(fit.result.stdout).toEndWith('"x"\nlast-line\n');
    expect(fit.spec).toEqual(big.spec);
    // One that fits is stored as it is; a cut never leaves half a character.
    const small = rec("ok\n", "");
    expect(fitJobRecord(small, max)).toBe(small);
    const emoji = fitJobRecord(rec("😀".repeat(20_000), ""), max);
    expect(valueBytes(emoji)).toBeLessThanOrEqual(max);
    expect(emoji.result.stdout).toMatch(/^(😀)+$/u);
  });

  test("the message an agent gets says how its job ended, with the end of its output", () => {
    const r = { jobId: "job-k1", plugin: null, spec: { kind: "exec", runId: "run-t", owner: { agentId: "agt-t" }, cmd: ["npm test"], label: "tests" }, state: "failed", startedAt: "2026-11-05T10:00:00.000Z", endedAt: "2026-11-05T10:00:42.000Z", result: { code: 1, stdout: `${"x".repeat(9000)}\n1 failing\n`, stderr: "", truncated: false }, reason: null, by: "agt-t", timeoutMs: null, paramsHash: "h" } as JobRecord;
    const text = jobMessage(r);
    expect(text).toStartWith("Your background job job-k1 (tests) failed (exit 1) after 42 s.");
    expect(text).toContain("1 failing");
    expect(text.length).toBeLessThan(5000);
    expect(text).toEndWith("All of its output: capcomd job output job-k1");
  });
});

/** A test plugin that listens to job.changed and hands its context out. */
function recorder(told: HookCall<"job.changed">[], got: (ctx: PluginContext) => void, name = "tick-test"): Candidate {
  return {
    source: "builtin",
    manifest: { schema: "capcomd.plugin/v1", name, version: "1.0.0", description: "Listens to jobs.", apiVersion: 1, engines: { capcomd: ">=0.0.0" }, entry: { runtime: "in-process", module: "./index.ts" }, scopes: ["read", "steer"], contributes: { hooks: { "job.changed": {} } } },
    module: { activate(ctx) { got(ctx); ctx.hooks.on("job.changed", (call) => { told.push(call); }); } } as PluginModule<never>,
  };
}

describe("a plugin's timers (ctx.jobs, the daemon's records)", () => {
  test("everyMs fires on schedule until `until`; `at` fires once; started and ended are on the daemon stream", async () => {
    const told: HookCall<"job.changed">[] = [], events: Array<{ type: string; data: Record<string, unknown> }> = [];
    useDaemonEvents((e) => { events.push(e); });
    let ctx!: PluginContext;
    const host = kernelHost({ log: false, jobs: true });
    useHooks(host.hooks);
    await host.start([recorder(told, (c) => { ctx = c; })]);
    const now = Date.now();
    const every = await ctx.jobs.start({ kind: "timer", runId: null, owner: { plugin: true }, label: "tick", everyMs: 1000, until: new Date(now + 2500).toISOString() });
    const once = await ctx.jobs.start({ kind: "timer", runId: null, owner: { plugin: true }, label: "once", at: new Date(now + 300).toISOString() });
    expect(every).toMatchObject({ plugin: "tick-test", state: "running", result: { fired: 0 } });
    expect(every.jobId).toMatch(/^job-/);
    const ended = await ctx.jobs.wait(every.jobId, { timeoutMs: 10_000 });
    expect(ended).toMatchObject({ state: "done", result: { fired: 2 } });
    expect((await ctx.jobs.get(once.jobId))).toMatchObject({ state: "done", result: { fired: 1 } });
    await host.hooks.idle();
    const of = (id: string) => told.filter((c) => c.payload.job.jobId === id).map((c) => c.payload.change);
    expect(of(every.jobId)).toEqual([{ kind: "started" }, { kind: "fired", n: 1 }, { kind: "fired", n: 2 }, { kind: "ended", state: "done" }]);
    expect(of(once.jobId)).toEqual([{ kind: "started" }, { kind: "fired", n: 1 }, { kind: "ended", state: "done" }]);
    expect(told[0]!.principal).toEqual({ kind: "plugin", name: "tick-test", scopes: [] });
    expect(events.filter((e) => e.data.jobId === every.jobId).map((e) => e.type)).toEqual(["job.started", "job.ended"]);
    expect(events.find((e) => e.type === "job.started")!.data).toEqual({ jobId: every.jobId, kind: "timer", owner: "plugin", label: "tick", plugin: "tick-test" });
    expect((await ctx.jobs.list({})).map((j) => j.jobId).sort()).toEqual([every.jobId, once.jobId].sort());
    await host.stop();
  }, 20_000);

  test("idempotent by key; a missed fire fires once when the daemon re-arms it; cancel ends it killed", async () => {
    const told: HookCall<"job.changed">[] = [];
    let ctx!: PluginContext;
    const host = kernelHost({ log: false, jobs: true });
    useHooks(host.hooks);
    await host.start([recorder(told, (c) => { ctx = c; })]);
    const spec = { kind: "timer", runId: null, owner: { plugin: true }, label: "hourly", everyMs: 3_600_000 } as const;
    const a = await ctx.jobs.start(spec, { key: "hourly" });
    expect((await ctx.jobs.start(spec, { key: "hourly" })).jobId).toBe(a.jobId);
    await expect(ctx.jobs.start({ ...spec, everyMs: 60_000 }, { key: "hourly" })).rejects.toMatchObject({ code: "conflict" });
    // The daemon was down when it should have fired: its record says so, and re-arming fires it once, now.
    resetJobs();
    const file = join(stateDir(), "jobs", `${a.jobId}.json`);
    const rec = JSON.parse(readFileSync(file, "utf8")) as JobRecord;
    writeFileSync(file, JSON.stringify({ ...rec, nextAt: Date.now() - 7_200_000 }));
    expect(await resumeTimers()).toBeGreaterThanOrEqual(1);
    await until(async () => told.some((c) => c.payload.job.jobId === a.jobId && c.payload.change.kind === "fired"));
    await sleep(300);
    expect(told.filter((c) => c.payload.job.jobId === a.jobId && c.payload.change.kind === "fired").length).toBe(1);
    const next = JSON.parse(readFileSync(file, "utf8")) as JobRecord;
    expect(next.fired).toBe(1);
    expect(next.nextAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await ctx.jobs.cancel(a.jobId, "not needed")).toMatchObject({ state: "killed", reason: "by the tick-test plugin: not needed" });
    expect(await ctx.jobs.start(spec, { key: "hourly" })).toMatchObject({ jobId: a.jobId, state: "killed" });
    await host.stop();
  }, 20_000);

  test("one owner (§16.2 rule 8): a plugin can't get, wait on or cancel another plugin's timer, nor list it", async () => {
    let a!: PluginContext, b!: PluginContext;
    const host = kernelHost({ log: false, jobs: true });
    useHooks(host.hooks);
    await host.start([recorder([], (c) => { a = c; }, "plugin-a"), recorder([], (c) => { b = c; }, "plugin-b")]);
    const spec = { kind: "timer", runId: null, owner: { plugin: true }, label: "hourly", everyMs: 3_600_000 } as const;
    const theirs = await b.jobs.start(spec, { key: "hourly" });
    const ours = await a.jobs.start(spec, { key: "hourly" });
    expect(ours.jobId).not.toBe(theirs.jobId);
    // To plugin A, B's timer is a job that doesn't exist: the same answer as an id nobody made.
    const missing = { code: "not_found", message: `job ${theirs.jobId} not found` };
    await expect(a.jobs.get(theirs.jobId)).rejects.toMatchObject(missing);
    await expect(a.jobs.cancel(theirs.jobId, "mine now")).rejects.toMatchObject(missing);
    await expect(a.jobs.wait(theirs.jobId, { timeoutMs: 100 })).rejects.toMatchObject(missing);
    await expect(a.jobs.get("job-nobodymadethis")).rejects.toMatchObject({ code: "not_found" });
    expect((await a.jobs.list({})).map((j) => j.jobId)).toEqual([ours.jobId]);
    // B's timer runs on, and B still reaches it; A reaches its own.
    expect(await b.jobs.get(theirs.jobId)).toMatchObject({ plugin: "plugin-b", state: "running" });
    expect(await a.jobs.cancel(ours.jobId, "done")).toMatchObject({ state: "killed", reason: "by the plugin-a plugin: done" });
    expect(await b.jobs.cancel(theirs.jobId, "done")).toMatchObject({ state: "killed", reason: "by the plugin-b plugin: done" });
    await host.stop();
  });

  test("a run job's pointer says when it settled and goes a day later (§16.2 rule 6)", async () => {
    const dir = join(stateDir(), "jobs");
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "job-prunedpointer1.run"), recent = join(dir, "job-keptpointer1.run");
    writeFileSync(old, JSON.stringify({ runId: "run-gone", kind: "exec", endedAt: Date.now() - 25 * 3_600_000 }));
    writeFileSync(recent, JSON.stringify({ runId: "run-gone", kind: "exec", endedAt: Date.now() - 3_600_000 }));
    await resumeTimers();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    rmSync(recent);
  });

  test("checked: a timer fires at most once a second, an exec job is an agent's, a run-owned one isn't made yet", async () => {
    let ctx!: PluginContext;
    const host = kernelHost({ log: false, jobs: true });
    useHooks(host.hooks);
    await host.start([recorder([], (c) => { ctx = c; })]);
    await expect(ctx.jobs.start({ kind: "timer", runId: null, owner: { plugin: true }, label: "fast", everyMs: 10 })).rejects.toMatchObject({ code: "invalid", message: "everyMs is at least 1000" });
    await expect(ctx.jobs.start({ kind: "timer", runId: null, owner: { plugin: true }, label: "never" })).rejects.toMatchObject({ code: "invalid" });
    await expect(ctx.jobs.start({ kind: "timer", runId: null, owner: { run: true }, label: "x", everyMs: 1000 })).rejects.toMatchObject({ code: "invalid", message: "only a plugin's timer lives outside a run" });
    await expect(ctx.jobs.start({ kind: "exec", runId: "run-x", owner: { run: true }, cmd: ["true"], label: "x" })).rejects.toMatchObject({ code: "unsupported" });
    await host.stop();
  });

  test("outside the daemon a plugin has no jobs: unsupported", async () => {
    let ctx!: PluginContext;
    const host = kernelHost({ log: false });
    await host.start([recorder([], (c) => { ctx = c; })]);
    await expect(ctx.jobs.start({ kind: "timer", runId: null, owner: { plugin: true }, label: "x", everyMs: 1000 })).rejects.toBeInstanceOf(PluginError);
    await expect(ctx.jobs.list({})).rejects.toMatchObject({ code: "unsupported" });
    await host.stop();
  });
});

describe("the Docker sweep is sandbox-docker's own timer (§15.1, §16.2)", () => {
  test("the daemon's plugin sets one timer (kept across restarts by its key), sweeps at once, and again when it fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-jobs-docker-"));
    const calls = join(dir, "calls");
    const bin = join(dir, "docker");
    writeFileSync(bin, `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\nexit 0\n`);
    chmodSync(bin, 0o755);
    const saved = { bin: process.env.CAPCOMD_DOCKER_BIN, sandbox: process.env.CAPCOMD_SANDBOX };
    process.env.CAPCOMD_DOCKER_BIN = bin;
    process.env.CAPCOMD_SANDBOX = "docker";
    const sweeps = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((l) => l.startsWith("ps ")).length : 0);
    try {
      const start = async () => {
        const host = kernelHost({ log: false, jobs: true });
        useHooks(host.hooks);
        await host.start([{ source: "builtin", manifest: sandboxDocker.manifest, module: sandboxDocker.module as Candidate["module"] }]);
        useSandboxHost(host);
        expect(host.get("sandbox-docker")?.state).toBe("active");
        return host;
      };
      let host = await start();
      await until(async () => sweeps() >= 1);
      const timers = () => readdirSync(join(stateDir(), "jobs")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(stateDir(), "jobs", f), "utf8")) as JobRecord).filter((r) => r.plugin === "sandbox-docker");
      expect(timers()).toHaveLength(1);
      const t = timers()[0]!;
      expect(t).toMatchObject({ state: "running", by: "plugin:sandbox-docker", spec: { kind: "timer", runId: null, owner: { plugin: true }, label: "sweep idle containers", everyMs: SWEEP_EVERY_MS } });
      // The daemon restarts: the same timer (its key), not a second one; its fire sweeps again.
      await host.stop();
      resetJobs();
      host = await start();
      await until(async () => sweeps() >= 2);
      expect(timers().map((r) => r.jobId)).toEqual([t.jobId]);
      const file = join(stateDir(), "jobs", `${t.jobId}.json`);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), nextAt: Date.now() - 1 }));
      resetJobs();
      await resumeTimers();
      await until(async () => sweeps() >= 3);
      expect(timers()[0]!.fired).toBe(1);
      await host.stop();
    } finally {
      for (const [k, v] of [["CAPCOMD_DOCKER_BIN", saved.bin], ["CAPCOMD_SANDBOX", saved.sandbox]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }, 30_000);
});

