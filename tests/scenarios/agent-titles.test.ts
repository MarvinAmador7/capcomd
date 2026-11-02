// Agent titles (capability agents.title), driven by scripted agents through in-VM capcomd: a planner names its tab,
// gives its child a title at spawn and names the run; the child names itself; refusals come back as sentences (a
// rename too soon, a bad title, a rename of someone else, a child naming the run). Then the user's title (PUT …/title)
// sticks over the parent's later rename, and clearing it (DELETE) reveals that rename.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { world, newRun, spawnRoot, waitAll, trajectory, WORKER, type World } from "./harness";
import { addClient, loadClients } from "../../src/api/clients";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";

let w: World;
let worker: string;
let app: ReturnType<typeof harnessApp>;
let token = "";
beforeAll(async () => {
  w = await world("titles");
  worker = w.script("worker", WORKER);
  const clients = join(w.dir, "clients.json");
  token = addClient("desktop", ["read", "steer"], clients).token;
  app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), state: harnessState(null), pollMs: 100 });
}, 120_000);
afterAll(async () => { await w?.stop(); });

const call = async (method: string, p: string, body?: unknown) => (await app.request(p, {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(method === "GET" ? {} : { "idempotency-key": `k-${Math.random()}` }) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})).json() as Promise<any>;
const titleOf = async (run: string, id: string) => ((await call("GET", `/v1/runs/${run}/agents`)) as any[]).find((a) => a.id === id);
async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (ok(v) || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 150)); }
}
/** Lines a scripted agent printed (its stdout lands in its logs). */
const said = async (run: string, id: string) => ((await w.cj(["logs", run, id])).j?.lines ?? []).map((l: any) => String(l.line)).join("\n");

test("planner and child name tabs from their VMs; the user's title sticks over a later rename; clearing reveals it", async () => {
  const run = await newRun(w);
  const go = join(w.dir, "go"), parentGo = join(w.dir, "parent-go");
  // Bounded waits on the test's signal files (30 s at most).
  const wait = (f: string) => `i=0; while [ ! -f ${JSON.stringify(f)} ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done`;
  const child = w.script("titled-child", `
echo "self: $(capcomd title "Login  Redirect")"
out=$(capcomd title "$PARENT" "hijack the parent"); echo "parent: $out exit=$?"
out=$(capcomd title --run "child run"); echo "run: $out exit=$?"
${wait(go)}
${worker}`);
  const planner = w.script("titled-planner", `
echo "self: $(capcomd title "plan login fix")"
out=$(capcomd title "plan again"); echo "soon: $out exit=$?"
out=$(capcomd title "one two three four five"); echo "bad: $out exit=$?"
id=$(capcomd spawn --profile worker --task "fix the login redirect" --title "Auth Fix" --key c1 --contract "$($S/json script="PARENT=$CAPCOMD_AGENT_ID FILE=src/login.txt sh ${child.slice(3)}")" | $S/jget agentId)
echo "child: $id"
out=$(capcomd spawn --profile worker --task "x" --title "a b c d e" --key c2); echo "badspawn: $out exit=$?"
echo "run: $(capcomd title --run "login fixes")"
out=$(capcomd title agt-nope "x"); echo "nobody: $out exit=$?"
${wait(parentGo)}
echo "later: $(capcomd title $id "redirect loop")"
touch ${JSON.stringify(go)}
capcomd await $id >/dev/null
capcomd result --summary "named" >/dev/null`);
  const root = await spawnRoot(w, run, "planner", planner, { task: "Goal: fix the login redirect" });

  // The child exists with its parent's title, then names itself.
  const kid = await until(async () => ((await call("GET", `/v1/runs/${run}/agents`)) as any[]).find((a) => a.parent === root), (a) => a?.titleSource === "self");
  expect(kid).toMatchObject({ title: "login redirect", titleSource: "self" });
  // The user renames it in an app: it sticks.
  expect(await call("PUT", `/v1/runs/${run}/agents/${kid.id}/title`, { title: "My Tab" })).toMatchObject({ title: "my tab", titleSource: "user", changed: true });
  writeFileSync(parentGo, "");
  // The parent renames it later: recorded, not shown, and the parent hears so.
  await until(() => said(run, root), (s) => s.includes("later:"));
  const p = await said(run, root);
  const later = JSON.parse(/later: (\{.*\})/.exec(p)![1]!);
  expect(later).toMatchObject({ ok: true, title: "my tab", titleSource: "user", shown: false, changed: true });
  expect(later.note).toContain("their title stays on its tab");
  expect(await titleOf(run, kid.id)).toMatchObject({ title: "my tab", titleSource: "user" });

  const done = await waitAll(w, run, [root]);
  expect(done.agents[0].status).toBe("done");
  expect(existsSync(go)).toBe(true);

  // Clearing the user's title reveals the latest agent-set one (the parent's).
  expect(await call("DELETE", `/v1/runs/${run}/agents/${kid.id}/title`)).toMatchObject({ title: "redirect loop", titleSource: "parent", changed: true });
  expect(await titleOf(run, kid.id)).toMatchObject({ title: "redirect loop", titleSource: "parent" });
  expect(await titleOf(run, root)).toMatchObject({ title: "plan login fix", titleSource: "self" });

  // What each agent heard.
  expect(JSON.parse(/self: (\{.*\})/.exec(p)![1]!)).toMatchObject({ ok: true, title: "plan login fix", shown: true });
  expect(p).toMatch(/soon: .*"code":"conflict","reason":"rate_limited".* exit=1/);
  expect(p).toContain("rename at most once every 30 s");
  // Each refusal is one sentence, and the exit code says what kind (2: usage, 1: refused).
  expect(p).toMatch(/bad: .*a title is 1 to 4 words, not 5.* exit=2/);
  expect(p).toMatch(/badspawn: .*--title: a title is 1 to 4 words.* exit=2/);
  expect(p).toMatch(/nobody: .*not found.* exit=1/);
  expect(JSON.parse(/run: (\{.*\})/.exec(p)![1]!)).toMatchObject({ ok: true, title: "login fixes", changed: true });
  const c = await said(run, kid.id);
  expect(JSON.parse(/self: (\{.*\})/.exec(c)![1]!)).toMatchObject({ ok: true, title: "login redirect", titleSource: "self", shown: true });
  expect(c).toMatch(/parent: .*is not your child.* exit=1/);
  expect(c).toMatch(/run: .*only the run's planner names the run.* exit=1/);

  // The trail: spawned with its parent's title (agent.titled by parent, at spawn), then self, user, parent (hidden), cleared.
  const titled = (await trajectory(w, run, (e) => e.type === "AGENT_TITLED" && e.agentId === kid.id)).map((e) => [e.data.by, e.data.title, e.data.shown, e.data.setBy]);
  expect(titled).toEqual([
    ["parent", "auth fix", true, root],
    ["self", "login redirect", true, kid.id],
    ["user", "my tab", true, "user"],
    ["parent", "redirect loop", false, root],
    ["cleared", "redirect loop", true, "user"],
  ]);
  const spawned = (await trajectory(w, run, (e) => e.type === "AGENT_SPAWNED" && e.agentId === kid.id))[0]!;
  expect(spawned.data).toMatchObject({ title: "auth fix", titleSource: "parent" });
  // The planner named the run: Run.title from it (the run has no label of its own), and run.titled once.
  const r = ((await call("GET", "/v1/runs")) as any[]).find((x) => x.id === run);
  expect(r).toMatchObject({ title: "login fixes", titleSource: "agent" });
  expect((await trajectory(w, run, (e) => e.type === "RUN_TITLED")).map((e) => e.data)).toEqual([{ title: "login fixes", setBy: root }]);
}, 180_000);
