// ADR-024 §2.2 `permissions.report` against a plugin's agent.spawning patch (plugin API §6.6.6): a plugin may add
// contract keys, so `report: true` can come from a plugin as well as from the spawner. The daemon carries a test plugin
// (tests/plugins/fixtures/test-reporter, loaded through CAPCOMD_TEST_PLUGINS) that adds it while its switch file exists;
// a scripted lead spawns a profile whose permissions.report is false from its VM (the daemon resolves and checks the
// spawn, and fires the hook). With the plugin adding report the spawn is refused (report_not_allowed), as if the
// spawner had asked for it; with the plugin leaving the spawn alone, the same spawn runs.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { world, newRun, spawnRoot, waitAll, WORKER, type World } from "./harness";

const REPORTER = join(import.meta.dir, "..", "plugins", "fixtures", "test-reporter");
let w: World;
let switchDir: string | undefined;
let on: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  switchDir = mkdtempSync(join(tmpdir(), "capcomd-spawn-report-"));
  on = join(switchDir, "reporter-on");
  w = await world("spawn-report", { CAPCOMD_TEST_PLUGINS: REPORTER, CAPCOMD_TEST_REPORTER_ON: on, NODE_ENV: "test" });
  // The project's profiles (the `profiles/` next to the run's agents file), over the harness's agents.json ones.
  const dir = join(w.dir, "profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "critic.yaml"), ["name: critic", "extends: worker", "permissions: { report: false }"].join("\n") + "\n");
  writeFileSync(join(dir, "boss.yaml"), ["name: boss", "extends: planner", "children: { allowedChildProfiles: [critic] }"].join("\n") + "\n");
  // The engine answers a little before the daemon has loaded its plugins (`capcomd plugins list` says when it has).
  for (let i = 0; i < 300 && !(await w.cj(["plugins", "list"])).j?.plugins?.some((p: any) => p.name === "test-reporter" && p.state === "active"); i++) await sleep(100);
}, 120_000);
afterAll(async () => {
  try { await w?.stop(); } finally { if (switchDir) rmSync(switchDir, { recursive: true, force: true }); }
});

/** A lead that spawns a critic from its VM and says what came of it: the child's id, or the refusal's reason and message. */
async function lead(run: string, key: string) {
  const worker = w.script(`leaf-${key}`, WORKER);
  const boss = w.script(`boss-${key}`, `W=${JSON.stringify(worker)}
out=$(capcomd spawn --profile critic --task "check the sum helper" --key c --contract "$($S/json script="$W")" 2>/dev/null)
id=$(echo "$out" | $S/jget agentId)
if [ "\${id#agt-}" != "$id" ]; then echo "child=$id"; capcomd await $id >/dev/null || exit 1; else echo "refused=$(echo "$out" | $S/jget error.reason) message=$(echo "$out" | $S/jget error.message)"; fi
capcomd result --summary done >/dev/null`);
  const root = await spawnRoot(w, run, "boss", boss, { args: ["--key", key] });
  const done = (await waitAll(w, run, [root], 120_000)).agents[0];
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  return logs;
}

test("a plugin that adds report to a profile whose permissions.report is false: the spawn is refused; untouched, it runs", async () => {
  const run = await newRun(w);
  writeFileSync(on, "");
  try {
    expect(await lead(run, "with")).toContain("refused=report_not_allowed");
  } finally { rmSync(on, { force: true }); }
  const logs = await lead(run, "without");
  const child = /child=(agt-\S+)/.exec(logs)?.[1];
  expect(child).toMatch(/^agt-/);
  expect((await waitAll(w, run, [child!])).agents[0]).toMatchObject({ status: "done", profile: "critic" });
}, 240_000);

test("a check a plugin adds is looked up as the spawner's is: a name the run doesn't have refuses the spawn", async () => {
  const run = await newRun(w);
  writeFileSync(on, JSON.stringify({ check: "no-such-check" }));
  try {
    expect(await lead(run, "check")).toContain(`message=no check named "no-such-check" in ${run}`);
  } finally { rmSync(on, { force: true }); }
}, 240_000);

test("the spawner's own report is refused before anything else is checked or any plugin is asked", async () => {
  const run = await newRun(w);
  const r = await w.cj(["spawn", run, "--profile", "critic", "--task", "t", "--report", "--contract", JSON.stringify({ budget: "bogus" })]);
  expect(r.code).not.toBe(0);
  expect(r.j.error).toMatchObject({ code: "config", reason: "report_not_allowed" });
});
