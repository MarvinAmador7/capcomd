// ADR-022 "Changing the workflow": an agent in flight when capcomd is upgraded to a workflow of another shape resumes
// and finishes. The drill: agent A runs (fake claude in a host-exec FakeProvider, its "VM" outlives the daemon) under
// shape 1; the engine host dies and comes back with the next shape (CAPCOMD_WORKFLOW_DRILL=1: a new top-level step,
// and a new step in every drive-loop iteration, both behind getVersion gates); A replays its shape-1 history, never
// runs the new top-level step, and finishes; agent B, started after the upgrade, runs shape 2. No history divergence.
// The control (the same change without the gates): workflow-upgrade-control.test.ts.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { sleep } from "../helpers/engine";
import { workflowEngine } from "./workflow-engine";

const w = workflowEngine("wf-upgrade", { worker: { provider: "claude", auth: "apikey", maxTurns: 20 } });
const scope = async (run: string) => (await import("../../src/core/relay")).client().scope.getOrCreate([run]);
const shape2Logged = async (run: string, id: string) =>
  ((await (await scope(run)).getLogs({ agentId: id, tail: 500 })) as any[]).some((l) => l.stream === "workflow" && l.line.includes("workflow shape 2"));

test("upgrade drill: an agent in flight on shape 1 finishes after the engine comes back with shape 2; a new one runs shape 2", async () => {
  const logFrom = existsSync(w.engine.logPath) ? readFileSync(w.engine.logPath, "utf8").length : 0; // the log file outlives runs
  const run = (await w.cj(["run", "new"])).j?.runId;
  expect(run).toMatch(/^run-/);
  const a = (await w.cj(["spawn", run, "--profile", "worker", "--task", "[hold:90] make the failing test pass", "--key", "a"])).j?.agentId;
  const hold = join(w.vm, a, "hold.log");
  for (let i = 0; i < 150 && !existsSync(hold); i++) await sleep(200);
  expect(existsSync(hold)).toBe(true); // A is mid-workflow (its run is in flight, the workflow in its watch phase)

  // Upgrade: the engine host dies and comes back running the next workflow shape.
  await w.engine.stop();
  process.env.CAPCOMD_WORKFLOW_DRILL = "1";
  await w.engine.start(null);

  const b = (await w.cj(["spawn", run, "--profile", "worker", "--task", "write the docs", "--key", "b"])).j?.agentId;
  const doneA = await w.untilStatus(run, a, "done", 150_000);
  const doneB = await w.untilStatus(run, b, "done", 120_000);
  expect(doneA.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(doneB.result?.commit).toMatch(/^[0-9a-f]{40}$/);
  // A kept its version: the new top-level step never ran for it; B, started after the upgrade, ran it.
  expect(await shape2Logged(run, a)).toBe(false);
  expect(await shape2Logged(run, b)).toBe(true);
  // A's run was in flight at the restart: it ran once more (stopped first), then finished, without a recorded failure.
  expect(readFileSync(hold, "utf8").trim().split("\n")).toEqual(["start", "stopped", "start", "finished"]);
  const events = (await w.cj(["events", run])).stdout;
  expect(events).not.toContain('"DRIVE_FAILED"');
  // No workflow diverged from its history.
  expect(readFileSync(w.engine.logPath, "utf8").slice(logFrom)).not.toMatch(/HistoryDivergedError|was not visited/);
}, 360_000);
