// Plugin API §9, §17.2 step 9, through a real daemon: a user's plugin (<home>/plugins/proc-gate, the proc-gate fixture)
// runs out of process as a merge.landing gate. The daemon starts it, it opens its session and stream, and its answers
// decide merges the daemon runs. The chaos killpoints, each with the audit "gate denied, nothing landed":
//  - plugin.process.crash: the plugin's process dies with the gate call in flight: the merge is denied (crashed),
//    nothing lands, and the process is started again (a new session) and judges the next merge;
//  - plugin.hook.mid: the daemon dies with the gate call in flight: nothing lands; after the restart the same merge is
//    asked again (the same idempotency key, of the new process) and denied.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { world, waitAll, trajectory, WORKER, type World } from "./harness";

import { PROC_GATE_COMMAND, putProcGate } from "../plugins/fixtures/proc-gate";
const home = process.env.CAPCOMD_HOME!;
const pluginDir = join(home, "plugins", "proc-gate");
const data = join(home, "state", "plugins", "proc-gate");
let w: World;
let worker: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frames = () => (existsSync(join(data, "frames.ndjson")) ? readFileSync(join(data, "frames.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const landings = (mrg: string) => frames().filter((f) => f.hook === "merge.landing" && f.subject === mrg);
const session = () => { try { return JSON.parse(readFileSync(join(data, "opened.json"), "utf8")).session as string; } catch { return null; } };
const control = (c: object) => writeFileSync(join(data, "control.json"), JSON.stringify(c));
const until = async (what: () => boolean | Promise<boolean>, ms = 60_000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await what()) return; throw new Error("timed out"); };
const filesOn = async (branch: string) => {
  await w.repo.seed.ok(["fetch", "-q", "origin"]);
  return (await w.repo.seed.ok(["ls-tree", "-r", "--name-only", `origin/${branch}`])).split("\n");
};
const newRun = async (key: string) => (await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `${key}-${Date.now()}`])).j.runId as string;
async function verified(run: string, key: string) {
  const sp = await w.cj(["spawn", run, "--profile", "worker", "--task", `write ${key}`, "--key", key, "--contract", JSON.stringify({ script: `FILE=src/${key}.txt CONTENT=${key} ${worker}` })]);
  const id = sp.j.agentId as string;
  expect((await waitAll(w, run, [id])).agents[0].status).toBe("done");
  const v = (await w.cj(["verify", run, "--ref", id, "--checks", `test -f src/${key}.txt`, "--key", `v-${key}`])).j;
  expect(v.state).toBe("passed");
  return { id, vfy: v.id as string };
}
const mergeOf = (run: string, v: { id: string; vfy: string }, key: string) => w.cj(["merge", run, "--ref", v.id, "--require", v.vfy, "--key", `m-${key}`]);

beforeAll(async () => {
  mkdirSync(pluginDir, { recursive: true });
  await putProcGate(pluginDir);
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({
    schema: "capcomd.plugin/v1", name: "proc-gate", version: "1.0.0", description: "proc-gate, as a user's plugin", apiVersion: 1, engines: { capcomd: ">=0.0.0" },
    entry: { runtime: "process", command: PROC_GATE_COMMAND }, scopes: ["read", "steer"], contributes: { hooks: { "merge.landing": {}, "run.changed": {} }, events: ["answered"] },
  }));
  mkdirSync(data, { recursive: true });
  control({});
  w = await world("plugin-process", {}, { killpoint: "plugin.process.crash" });
  worker = w.script("worker", WORKER);
  await until(() => session() !== null);
}, 180_000);
afterAll(async () => {
  try { await w?.stop(); } finally { rmSync(pluginDir, { recursive: true, force: true }); }
});

test("the user's plugin runs out of process: listed active, its gate denies a merge, nothing lands", async () => {
  const listed = (await w.cj(["plugins", "list"])).j.plugins.find((p: { name: string }) => p.name === "proc-gate");
  expect(listed).toMatchObject({ runtime: "process", source: "user", state: "active", hooks: ["merge.landing", "run.changed"] });
  // The first gate call is the killpoint's (plugin.process.crash): the process dies with it in flight.
  const run = await newRun("crash");
  const first = session();
  const v = await verified(run, "a");
  const m = (await mergeOf(run, v, "a")).j;
  expect(m).toMatchObject({ state: "failed" });
  expect(JSON.stringify(m)).toContain("plugin:proc-gate");
  expect(await filesOn("trunk")).not.toContain("src/a.txt");
  const denied = (await trajectory(w, run)).filter((e) => e.type === "PLUGIN_GATE_DENIED");
  expect(denied.map((e) => e.data)).toEqual([expect.objectContaining({ plugin: "proc-gate", hook: "merge.landing", entity: m.id, decision: "deny", reason: expect.stringContaining("(crashed)") })]);
  // Started again, with a new session, and it judges the next merge: denied by its own answer this time.
  await until(() => session() !== first);
  const v2 = await verified(run, "b");
  const m2 = (await mergeOf(run, v2, "b")).j;
  expect(m2).toMatchObject({ state: "failed" });
  expect(JSON.stringify(m2)).toContain("the process gate lands nothing");
  expect(await filesOn("trunk")).not.toContain("src/b.txt");
  // Allowed, the merge lands: the gate decides, nothing else.
  control({ "merge.landing": "allow" });
  const v3 = await verified(run, "c");
  expect((await mergeOf(run, v3, "c")).j).toMatchObject({ state: "merged" });
  expect(await filesOn("trunk")).toContain("src/c.txt");
  expect(landings(m2.id)).toHaveLength(1);
}, 300_000);

test("the daemon dies with a gate call in flight (plugin.hook.mid): nothing lands; asked again after the restart, the gate denies", async () => {
  control({});
  await w.restart(500, "plugin.hook.mid");
  await until(async () => (await w.cj(["plugins", "list"])).j?.plugins?.find((p: { name: string }) => p.name === "proc-gate")?.state === "active");
  const run = await newRun("mid");
  const v = await verified(run, "d");
  const before = session();
  const lost = await mergeOf(run, v, "d");
  await until(() => w.killed());
  expect(lost.j?.state).not.toBe("merged");
  expect(await filesOn("trunk")).not.toContain("src/d.txt");
  await w.restart(500);
  await until(() => session() !== before);
  const m = (await mergeOf(run, v, "d")).j;
  expect(m).toMatchObject({ state: "failed" });
  expect(JSON.stringify(m)).toContain("the process gate lands nothing");
  expect(await filesOn("trunk")).not.toContain("src/d.txt");
  // The decision the crash cut off was asked again with its idempotency key (§6.7): the daemon died right after sending
  // it, so the old process may never have read it; every ask of it the plugin saw carries the one key.
  const asked = landings(m.id);
  expect(asked.length).toBeGreaterThanOrEqual(1);
  expect([...new Set(asked.map((f) => f.key))]).toEqual([`merge.landing:${m.id}:1`]);
}, 300_000);
