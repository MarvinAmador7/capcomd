import { Engine, runClient, sleep, pidsListening, type EngineOpts } from "./engine";
import { auditRun } from "./invariants";

export async function releasePort(port = 6420): Promise<void> {
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
  await releasePort(opts.port ?? 6420);
  const { rm } = await import("fs/promises");
  const dir = opts.dataDir ?? `${(await import("os")).homedir()}/.rivetkit/var/engine`;
  await rm(dir, { recursive: true, force: true });
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
  const runId = `chaos-${killpoint.replace(/\./g, "-")}-n${count}-${Date.now()}-p${opts.port ?? 6420}`;
  const engine = new Engine(`${killpoint}-${count}-${runId}`, opts);
  const endpoint = `http://127.0.0.1:${opts.port ?? 6420}`;
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
      const report = await auditRun(runId, endpoint);
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

    const report = await auditRun(runId, endpoint);
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
