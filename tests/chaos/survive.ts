import { Engine, runClient, sleep } from "./engine";
import { auditRun } from "./invariants";

export async function releasePort(): Promise<void> {
  const proc = Bun.spawn(["lsof", "-nP", "-iTCP:6420", "-sTCP:LISTEN", "-t"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  for (const part of text.split(/\s+/)) {
    const pid = Number(part);
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  await sleep(200);
}

export async function wipeEngineData(): Promise<void> {
  await releasePort();
  const { rm } = await import("fs/promises");
  await rm(`${(await import("os")).homedir()}/.rivetkit/var/engine`, { recursive: true, force: true });
}

export async function survive(killpoint: string, count: number, requireKill: boolean): Promise<{
  ok: boolean;
  error?: string;
  killed: boolean;
}> {
  const runId = `chaos-${killpoint.replace(/\./g, "-")}-n${count}-${Date.now()}`;
  const engine = new Engine(`${killpoint}-${count}-${runId}`);
  const started = Date.now();
  const mark = (label: string) => {
    console.log(`    ${label} +${Date.now() - started}ms`);
  };
  await wipeEngineData();
  mark("wiped");

  try {
    await engine.start(`${killpoint}:${count}`);
    mark("engine-up");
    const first = await runClient(runId);
    mark(`first-client exit=${first.code} killed=${engine.sawKill}`);
    const killed =
      engine.sawKill ||
      first.output.includes("[KILLPOINT]") ||
      (await Bun.file(engine.logPath).text().catch(() => "")).includes("[KILLPOINT]");

    if (first.code === 0 && !killed) {
      const report = await auditRun(runId);
      if (requireKill) {
        return { ok: false, killed: false, error: "killpoint never fired" };
      }
      if (!report.ok) {
        return { ok: false, killed: false, error: report.violations.join("; ") };
      }
      return { ok: true, killed: false };
    }

    await engine.stop();
    mark("stopped-after-kill");
    await engine.start(null);
    mark("engine-restarted");
    const second = await runClient(runId);
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

    const report = await auditRun(runId);
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
