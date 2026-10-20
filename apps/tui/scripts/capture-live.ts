/**
 * Real capcomd run for live-mode testing (no LLM: scripted agents via the scenario harness).
 * Starts an engine, runs planner → {lead → reviewer sub-agent, flaky worker that fails, critic},
 * follows it with the TUI's followLive() *while it runs*, and records the raw
 * `capcomd inspect --json --follow` stream to fixtures/live-scope/inspect.ndjson.
 *   bun scripts/capture-live.ts      (needs the repo root's node_modules)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKER, newRun, spawnRoot, waitAll, world } from "../../../tests/scenarios/harness";
import { followLive } from "../src/adapters/source";
import { flattenAgents } from "../src/adapters/tree";

const w = await world("tui-live");
try {
  const worker = w.script("w", WORKER);
  const child = (env: string) => `$($S/json script="${env} ${"$"}W")`;
  const builder = w.script("builder", `W=${JSON.stringify(worker)}
set -e
sleep 1
r=$(capcomd spawn --profile worker --task review --key review --children.maxChildren=0 --contract "${child("SLEEP=2 SPENT=4 SUMMARY=reviewed")}" | $S/jget agentId)
capcomd heartbeat "waiting for review" >/dev/null
capcomd await "$r" --timeout-ms 60000 >/dev/null || true
capcomd result --summary "built" --data "$($S/json spent="$($S/json turns=6)")" >/dev/null`);
  const planner = w.script("planner", `W=${JSON.stringify(worker)}
set -e
b=$(capcomd spawn --profile lead --task build --key build --children.maxChildren=2 --children.maxDepth=1 --contract "$($S/json script='${builder}')" | $S/jget agentId)
f=$(capcomd spawn --profile worker --task flaky --key flaky --children.maxChildren=0 --contract "${child("SLEEP=1 EXIT=3")}" | $S/jget agentId)
c=$(capcomd spawn --profile critic --task critique --key critic --children.maxChildren=0 --contract "${child("SLEEP=3 SPENT=2 SUMMARY=lgtm")}" | $S/jget agentId)
capcomd await "$b" "$f" "$c" --timeout-ms 60000 >/dev/null || true
capcomd result --summary "planned" >/dev/null`);

  const run = await newRun(w);
  const frames: Array<{ t: number; agents: string[]; events: number; seq?: number }> = [];
  const t0 = Date.now();
  const stop = followLive(run, (d) => frames.push({ t: Date.now() - t0, agents: flattenAgents(d.agents).map((a) => `${a.agentId}:${a.status}`), events: d.events.length, seq: d.events.at(-1)?.seq }), { retryMs: 300, env: { ...w.env, PWD: w.dir }, cwd: w.dir, onError: (e) => console.error("followLive:", e) });
  // Independent raw recording of the same stream for the fixture.
  const rec = Bun.spawn(["bun", join(import.meta.dir, "../../../src/cli/index.ts"), "inspect", run, "--json", "--follow", "--timeout-ms", "40000", "--until", "never.happens"], { stdout: "pipe", cwd: w.dir, env: { ...process.env, ...w.env, PWD: w.dir } });
  const root = await spawnRoot(w, run, "planner", planner);
  const aw = await waitAll(w, run, [root]);
  await Bun.sleep(2500);
  // Final snapshot (has the complete trace), then stop following.
  const snap = (await w.cj(["inspect", run])).stdout.trim().split("\n").pop()!;
  stop(); rec.kill();
  const raw = await new Response(rec.stdout).text();
  const dir = join(import.meta.dir, "../fixtures/live-scope");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "inspect.ndjson"), raw.trim() + "\n" + snap + "\n");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ runId: run, source: "real: scripted capcomd run via tests/scenarios/harness (scripts/capture-live.ts)", note: "inspect --follow stream recorded live, plus a final inspect snapshot" }, null, 2) + "\n");
  writeFileSync("/tmp/live-frames.json", JSON.stringify({ run, root: aw.agents?.[0], frames }, null, 2));
  console.log(`run ${run}: root ${aw.agents?.[0]?.status}; followLive frames=${frames.length}; last=${JSON.stringify(frames.at(-1))}`);
} finally {
  await w.stop();
}
