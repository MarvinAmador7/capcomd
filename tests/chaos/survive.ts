import { Engine, assertPrivate, assertPrivatePort, runClient, sleep, pidsListening, type EngineOpts } from "./engine";
import { auditRun } from "./invariants";

export async function releasePort(port: number): Promise<void> {
  assertPrivatePort(port, "releasePort"); // it SIGKILLs whatever listens there
  let killed = false;
  for (const pid of await pidsListening(port)) {
    killed = true;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  // Wait for the listener to actually go away instead of a fixed sleep.
  if (killed) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await pidsListening(port)).length > 0) await sleep(25);
  }
}

export async function wipeEngineData(opts: EngineOpts = {}): Promise<void> {
  // Never a default: serve's default data dir is the user's real one (<capcomd home>/engine/<port>, with its backups).
  assertPrivate(opts, "wipeEngineData");
  await releasePort(opts.port!);
  const { rm } = await import("fs/promises");
  const dir = opts.dataDir!;
  await rm(dir, { recursive: true, force: true });
}

function repoAudit(opts: EngineOpts) {
  return opts.repo && opts.dataDir ? { bare: `${opts.dataDir}/git/origin.git`, target: "trunk" } : undefined;
}

/** Fresh bare repo per case with a seeded `trunk` (the merge target). */
export async function seedRepo(opts: EngineOpts): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("fs");
  const { Git } = await import("../../src/merge/git");
  const bare = `${opts.dataDir}/git/origin.git`;
  const seed = `${opts.dataDir}/git/seed`;
  mkdirSync(bare, { recursive: true });
  mkdirSync(seed, { recursive: true });
  await new Git(bare).ok(["init", "-q", "--bare", "-b", "trunk"]);
  const g = new Git(seed);
  await g.ok(["init", "-q", "-b", "trunk"]);
  writeFileSync(`${seed}/README.md`, "chaos fixture\n");
  await g.ok(["add", "."]);
  await g.ok(["commit", "-q", "-m", "seed"]);
  await g.ok(["push", "-q", bare, "trunk"]);
}

/** Per-phase wall times of one survive() case, in ms. */
export interface Phases {
  wipe: number;
  engineUp: number;
  firstClient: number;
  stop: number;
  restart: number;
  resume: number;
  audit: number;
}

export async function survive(killpoint: string, count: number, requireKill: boolean, opts: EngineOpts = {}, quiet = false): Promise<{
  ok: boolean;
  error?: string;
  killed: boolean;
  phases: Partial<Phases>;
}> {
  const { port } = assertPrivate(opts, "survive");
  const runId = `chaos-${killpoint.replace(/\./g, "-")}-n${count}-${Date.now()}-p${port}`;
  const engine = new Engine(`${killpoint}-${count}-${runId}`, opts);
  const endpoint = `http://127.0.0.1:${port}`;
  const started = Date.now();
  const phases: Partial<Phases> = {};
  let last = started;
  const mark = (label: string, phase?: keyof Phases) => {
    const now = Date.now();
    if (phase) phases[phase] = now - last;
    last = now;
    if (!quiet) console.log(`    ${label} +${now - started}ms`);
  };
  const result = await surviveInner();
  return { ...result, phases };

  async function surviveInner(): Promise<{ ok: boolean; error?: string; killed: boolean }> {
  await wipeEngineData(opts);
  if (opts.repo) await seedRepo(opts);
  mark("wiped", "wipe");

  try {
    await engine.start(`${killpoint}:${count}`);
    mark("engine-up", "engineUp");
    const first = await runClient(runId, opts);
    mark(`first-client exit=${first.code} killed=${engine.sawKill}`, "firstClient");
    const killed =
      engine.sawKill ||
      first.output.includes("[KILLPOINT]") ||
      (await Bun.file(engine.logPath).text().catch(() => "")).includes("[KILLPOINT]");

    if (first.code === 0 && !killed) {
      const report = await auditRun(runId, endpoint, repoAudit(opts));
      mark("audited", "audit");
      if (requireKill) {
        return { ok: false, killed: false, error: "killpoint never fired" };
      }
      if (!report.ok) {
        return { ok: false, killed: false, error: report.violations.join("; ") };
      }
      return { ok: true, killed: false };
    }

    await engine.stop();
    mark("stopped-after-kill", "stop");
    await engine.start(null);
    mark("engine-restarted", "restart");
    const second = await runClient(runId, opts);
    mark("resumed", "resume");
    if (second.code !== 0 || !second.output.includes("✓ Run completed successfully")) {
      return {
        ok: false,
        killed,
        error: `resume failed (${second.code}): ${second.output.slice(-600)}`,
      };
    }
    if (requireKill && !killed && !engine.sawKill) {
      return { ok: false, killed: false, error: "killpoint never fired" };
    }

    const report = await auditRun(runId, endpoint, repoAudit(opts));
    mark("audited", "audit");
    if (!report.ok) {
      return {
        ok: false,
        killed: true,
        error: `invariants: ${report.violations.join("; ")} checks=${JSON.stringify(report.checks)}`,
      };
    }
    const missing = Object.entries(report.checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (missing.length > 0) {
      return { ok: false, killed: true, error: `unchecked invariants: ${missing.join(",")}` };
    }
    return { ok: true, killed: true };
  } catch (error) {
    return {
      ok: false,
      killed: engine.sawKill,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await engine.stop();
    } catch (error) {
      console.log(`    cleanup error: ${error instanceof Error ? error.message : error}`);
    }
  }
}
}
