// Regression for gate-3 run-1 seed 35 (merge.before_cas:1): the killed engine host
// lingered ~2 min inside process.exit() (rivetkit's native shutdown), and its runner
// reconnected to the restarted engine. The resume then got tunnel_message_timeout /
// no_responders and was SIGKILLed. A killpoint must be a real crash (SIGKILL, immediate).
import { describe, expect, test } from "bun:test";
import { randomKillpoint } from "./harness";
import { survive } from "./survive";

describe("chaos regression: seed 35", () => {
  test("seed 35 still maps to merge.before_cas:1", () => {
    expect(randomKillpoint(35)).toEqual({ killpoint: "merge.before_cas", iteration: 1 });
  });

  test("killpoint dies by SIGKILL at once, even if an exit hook would block", async () => {
    const script = `
      process.on("exit", () => { const t = Date.now(); while (Date.now() - t < 10000) {} });
      const { killpoint } = await import("${process.cwd()}/src/utils/killpoint.ts");
      killpoint("merge.before_cas");
      console.log("still alive");`;
    const started = Date.now();
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, RELAY_KILLPOINT: "merge.before_cas:1", CAPCOMD_KILLPOINT: "merge.before_cas:1" },
      stdout: "pipe", stderr: "pipe",
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    expect(proc.signalCode).toBe("SIGKILL");
    expect(out).not.toContain("still alive");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("merge.before_cas:1 survives kill + cold restart (all invariants hold)", async () => {
    const r = await survive("merge.before_cas", 1, true);
    expect(r.error).toBeUndefined();
    expect(r.killed).toBe(true);
    expect(r.ok).toBe(true);
  }, 300_000);
});
