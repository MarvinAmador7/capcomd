// ADR-022 "Changing the workflow", the control of the upgrade drill (workflow-upgrade.test.ts): the same change made
// without the getVersion gates (CAPCOMD_WORKFLOW_DRILL=ungated) makes an agent in flight run code of a shape it never
// started with.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { sleep } from "../helpers/engine";
import { workflowEngine } from "./workflow-engine";

const w = workflowEngine("wf-upgrade-control", { worker: { provider: "claude", auth: "apikey", maxTurns: 20 } });
const scope = async (run: string) => (await import("../../src/core/relay")).client().scope.getOrCreate([run]);
const shape2Logged = async (run: string, id: string) =>
  ((await (await scope(run)).getLogs({ agentId: id, tail: 500 })) as any[]).some((l) => l.stream === "workflow" && l.line.includes("workflow shape 2"));

test("control: the same change without the gates runs the new shape inside an agent that started under the old one", async () => {
  const run = (await w.cj(["run", "new"])).j?.runId;
  const c = (await w.cj(["spawn", run, "--profile", "worker", "--task", "[hold:90] control", "--key", "c"])).j?.agentId;
  const hold = join(w.vm, c, "hold.log");
  for (let i = 0; i < 150 && !existsSync(hold); i++) await sleep(200);
  expect(existsSync(hold)).toBe(true);
  await w.engine.stop();
  process.env.CAPCOMD_WORKFLOW_DRILL = "ungated";
  const logBefore = readFileSync(w.engine.logPath, "utf8").length;
  await w.engine.start(null);
  let ranNew = false;
  for (let i = 0; i < 120 && !ranNew; i++) { ranNew = await shape2Logged(run, c).catch(() => false); if (!ranNew) await sleep(500); }
  expect(ranNew).toBe(true);
  const diverged = /HistoryDivergedError|was not visited/.test(readFileSync(w.engine.logPath, "utf8").slice(logBefore));
  console.log(`  ungated upgrade: the in-flight agent ran shape-2 code${diverged ? " and its workflow diverged from its history" : ""}`);
  await w.cj(["cancel", run]);
}, 360_000);
