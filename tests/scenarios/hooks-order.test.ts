// Plugin API step 2 (docs/spec/plugin-api.md §17.2, §6.6): the kernel fires its hooks from their sites. The daemon
// carries a recording plugin (tests/plugins/fixtures/hook-recorder, loaded through CAPCOMD_TEST_PLUGINS) that listens
// to every hook, allows everything and writes each call to a file; a scripted planner spawns one worker, verifies it
// and merges it from its VM (calls the daemon serves). The calls come in the kernel's order, the run ends as it would
// with no plugin, and a hook whose kernel site isn't there yet (jobs, triggers) never fires.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { world, newRun, spawnRoot, waitAll, WORKER, type World } from "./harness";
import type { Recorded } from "../plugins/fixtures/hook-recorder/index";

const RECORDER = join(import.meta.dir, "..", "plugins", "fixtures", "hook-recorder");
let w: World;
let logDir: string | undefined;
let log: string;
beforeAll(async () => {
  logDir = mkdtempSync(join(tmpdir(), "capcomd-hooks-order-"));
  log = join(logDir, "hooks.ndjson");
  w = await world("hooks-order", { CAPCOMD_TEST_PLUGINS: RECORDER, CAPCOMD_TEST_HOOK_LOG: log, NODE_ENV: "test" });
  // The engine answers a little before the daemon has loaded its plugins and opened its API (daemon.started).
  for (let i = 0; i < 300 && !calls().some((c) => c.hook === "daemon.started"); i++) await sleep(100);
}, 120_000);
afterAll(async () => {
  try { await w?.stop(); } finally { if (logDir) rmSync(logDir, { recursive: true, force: true }); }
});

const calls = (): Recorded[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Recorded) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("hooks order: one agent, one verify, one merge, as the kernel makes them", async () => {
  const run = await newRun(w);
  const worker = w.script("worker", WORKER);
  const planner = w.script("planner", `W=${JSON.stringify(worker)}
id=$(capcomd spawn --profile worker --task "write a" --key a --budget turns=5 --children.maxChildren=0 --contract "$($S/json script="FILE=src/a.txt CONTENT=a $W")" | $S/jget agentId)
echo "child=$id"
capcomd await $id >/dev/null || exit 1
v=$(capcomd verify --ref $id --key v-a)
echo "verify pass=$(echo "$v" | $S/jget result.pass) id=$(echo "$v" | $S/jget id)"
capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m-a | $S/jget state
capcomd result --summary done >/dev/null`);
  const root = await spawnRoot(w, run, "planner", planner);
  const done = (await waitAll(w, run, [root], 120_000)).agents[0];
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  // Allowing everything changes nothing: the verify passes and the merge lands.
  expect(logs).toContain("verify pass=true");
  expect(logs).toMatch(/^merged$/m);
  const child = /child=(agt-\S+)/.exec(logs)![1]!;
  const vfy = /verify pass=true id=(vfy-\S+)/.exec(logs)![1]!;
  // The observe calls after the merge (merge.changed landed, the run's end) are told as their actions answer.
  for (let i = 0; i < 50 && !calls().some((c) => c.hook === "merge.changed" && c.change === "landed"); i++) await sleep(100);

  const all = calls();
  const at = (pred: (c: Recorded) => boolean, what: string) => { const i = all.findIndex(pred); if (i < 0) console.log(JSON.stringify(all, null, 1)); expect(`${what}: ${i >= 0}`).toBe(`${what}: true`); return i; };
  const of = (hook: string, subject?: string, change?: string) => (c: Recorded) => c.hook === hook && (subject === undefined || c.subject === subject) && (change === undefined || c.change === change);

  // The daemon's own start, once, before anything else.
  expect(all[0]!.hook).toBe("daemon.started");
  expect(all.filter((c) => c.hook === "daemon.started").length).toBe(1);

  // The run (created by `capcomd run new` against the daemon's scope) and the root's own changes are told too.
  at((c) => c.hook === "run.changed" && c.runId === run && c.change === "created", "run.changed created");
  at(of("agent.changed", root, "spawned"), "the root's agent.changed spawned");

  // One agent, spawned from the planner's VM: who asked is that agent, and the kernel's order holds.
  const resolved = at(of("profile.resolved", "worker"), "profile.resolved");
  const spawning = at(of("agent.spawning", "worker"), "agent.spawning");
  const spawned = at(of("agent.changed", child, "spawned"), "agent.changed spawned");
  const preparing = at(of("agent.preparing", child), "agent.preparing");
  const ensuring = at((c) => c.hook === "sandbox.ensuring" && c.agentId === child, "sandbox.ensuring");
  const ready = at((c) => c.hook === "sandbox.changed" && c.agentId === child && c.change === "ready", "sandbox.changed ready");
  const started = at(of("agent.changed", child, "started"), "agent.changed started");
  const ended = at(of("agent.changed", child, "ended"), "agent.changed ended");
  // The resolved profile: the run's agents file is the project's layer (ADR-024 §2.3), a v1 entry is version 1.
  expect(all[resolved]!.profile).toEqual({ name: "worker", version: 1, source: "project" });
  // The agent then carries it (Agent.profileVersion, profileSource), and its pinned spec names it (PinnedSpec.profile).
  for (const i of [spawned, preparing, started, ended]) expect(all[i]!.profile).toEqual({ name: "worker", version: 1, source: "project" });
  expect(all[spawning]!.principal).toBe("agent");
  expect(all[spawning]!.agentId).toBe(child);
  expect(resolved).toBeLessThan(spawning);
  expect(spawning).toBeLessThan(spawned);
  expect(spawned).toBeLessThan(preparing);
  expect(started).toBeLessThan(ensuring);
  expect(preparing).toBeLessThan(ensuring);
  expect(ensuring).toBeLessThan(ready);
  expect(ready).toBeLessThan(ended);
  expect(all[preparing]!.key).toBe(`agent.preparing:${child}/e1:1`);

  // One verify: started, the plugins' starting gate, the checks, the plugins' judges, finished.
  const vStarted = at(of("verify.changed", vfy, "started"), "verify.changed started");
  const vStarting = at(of("verify.starting", vfy), "verify.starting");
  const vChecked = at(of("verify.changed", vfy, "checked"), "verify.changed checked");
  const vJudging = at(of("verify.judging", vfy), "verify.judging");
  const vJudged = at(of("verify.changed", vfy, "judged"), "verify.changed judged");
  const vFinished = at(of("verify.changed", vfy, "finished"), "verify.changed finished");
  expect(ended).toBeLessThan(vStarted);
  expect([vStarted, vStarting, vChecked, vJudging, vJudged, vFinished]).toEqual([...[vStarted, vStarting, vChecked, vJudging, vJudged, vFinished]].sort((a, b) => a - b));
  expect(all[vStarting]!.key).toBe(`verify.starting:${vfy}:1`);
  expect(all.filter(of("verify.starting", vfy)).length).toBe(1);
  expect(all.filter(of("verify.judging", vfy)).length).toBe(1);

  // One merge: requested, the plugins' landing gate under the target's lock, landed.
  const mRequested = at((c) => c.hook === "merge.changed" && c.change === "requested", "merge.changed requested");
  const mrg = all[mRequested]!.subject!;
  const landing = at(of("merge.landing", mrg), "merge.landing");
  const landed = at(of("merge.changed", mrg, "landed"), "merge.changed landed");
  expect(vFinished).toBeLessThan(mRequested);
  expect(mRequested).toBeLessThan(landing);
  expect(landing).toBeLessThan(landed);
  expect(all[landing]!.key).toBe(`merge.landing:${mrg}:1`);
  expect(all.filter(of("merge.landing", mrg)).length).toBe(1);

  // Nothing parked, nothing to decide; no job or trigger exists yet (§17.2 steps 7 and 10).
  for (const h of ["approval.deciding", "approval.changed", "job.changed", "trigger.admitting", "trigger.changed"]) expect(all.filter((c) => c.hook === h).length).toBe(0);
  // Every call was made in the daemon, about this run (but the daemon's start and machines a restart forgot).
  expect(all.filter((c) => c.runId && c.runId !== run).length).toBe(0);

  // Each change names who caused it (§3.2, §6.1), never just the operator: the root was spawned from the host (the
  // operator); the child's spawn and start are the planner's, its own end is its own; the planner asked for the verify
  // and the merge from its VM, so their changes are the planner's too.
  expect(all[at(of("agent.changed", root, "spawned"), "the root's agent.changed spawned")]!.principal).toBe("operator");
  for (const [i, what] of [[spawned, "spawned"], [started, "started"], [ended, "ended"], [vStarted, "verify started"], [vFinished, "verify finished"], [mRequested, "merge requested"], [landed, "merge landed"]] as const)
    expect(`${what}: ${all[i]!.principal}`).toBe(`${what}: agent`);
}, 180_000);
