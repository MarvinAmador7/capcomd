// ADR-017 scenarios: limits, refusals, deadlocks, backpressure. The parent sets each child's
// fan-out at spawn time (narrow-only); everything here is enforced by the orchestrator.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { world, newRun, spawnRoot, waitAll, types, agentsOf, inOrder, WORKER, type World } from "./harness";

let w: World;
let worker: string;
beforeAll(async () => { w = await world("limits"); worker = w.script("worker", WORKER); }, 120_000);
afterAll(async () => { await w?.stop(); });

const child = (env: string) => `$($S/json script="${env} ${"$"}W")`;
const PRE = () => `W=${JSON.stringify(worker)}\n`;
async function finished(run: string, id: string) {
  const a = (await waitAll(w, run, [id])).agents[0];
  if (!["done"].includes(a.status)) console.log(JSON.stringify(a.result), JSON.stringify((await w.cj(["logs", run, id])).j?.lines?.map((l: any) => l.line)));
  return a;
}
const logText = async (run: string, id: string) => (await w.cj(["logs", run, id])).j.lines.map((l: any) => l.line).join("\n");

test("budget exhaustion mid-tree: a lead's second worker can't be carved; rollups show the spend", async () => {
  const run = await newRun(w, "turns=40");
  const lead = w.script("lead-broke", PRE() + `
a=$(capcomd spawn --profile worker --task one --key one --budget turns=10 --contract "${child("SPENT=10")}" | $S/jget agentId)
capcomd await $a >/dev/null
out=$(capcomd spawn --profile worker --task two --key two --budget turns=10 --contract "${child("SPENT=10")}"); rc=$?
echo "second spawn rc=$rc $out"
capcomd budget > $HOME/b.json
capcomd result --summary "rc=$rc $(echo "$out" | $S/jget error.message)" --data "$(cat $HOME/b.json)" >/dev/null`);
  const p = w.script("planner-broke", `
l=$(capcomd spawn --profile lead --task lead --key lead --children.maxChildren=2 --contract "$($S/json script=${JSON.stringify(lead)})" | $S/jget agentId)
capcomd await $l >/dev/null
capcomd result --summary "lead=$(capcomd status $l | $S/jget agents.0.result.summary.text)" >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  expect((await finished(run, root)).status).toBe("done");
  const all = await agentsOf(run);
  const leadRow = all.find((x: any) => x.depth === 1);
  expect(leadRow.budget.turns).toBe(20); // 40 × budgetShare 0.5
  expect(leadRow.result.summary).toMatch(/^rc=1 requested 10 turns exceeds 5 turns available from agt-/);
  expect(leadRow.result.data).toMatchObject({ budget: { turns: 20 }, available: { turns: 10 } });
  const t = (await w.cj(["tree", run])).j;
  expect(t.totals).toMatchObject({ agents: 3, turns: 10 });
  expect(inOrder(await types(w, run), ["AGENT_SPAWNED", "AGENT_SPAWNED", "AGENT_SPAWNED", "AGENT_DONE", "AGENT_DONE", "AGENT_DONE"])).toBe(true);
}, 120_000);

test("parent grants child maxChildren=2; the child's 3rd concurrent spawn is refused (backpressure), then succeeds after wait-any", async () => {
  const run = await newRun(w);
  const lead = w.script("lead-3", PRE() + `
a=$(capcomd spawn --profile worker --task a --key a --contract "${child("SLEEP=2")}" | $S/jget agentId)
b=$(capcomd spawn --profile worker --task b --key b --contract "${child("SLEEP=2")}" | $S/jget agentId)
out=$(capcomd spawn --profile worker --task c --key c --contract "${child("SLEEP=0")}"); rc=$?
echo "third: rc=$rc $out"
reason=$(echo "$out" | $S/jget error.reason)
capcomd wait-any $a $b >/dev/null
c=$(capcomd spawn --profile worker --task c --key c --contract "${child("SLEEP=0")}" | $S/jget agentId)
capcomd await $a $b $c >/dev/null
capcomd result --summary "rc=$rc reason=$reason retried=$c" >/dev/null`);
  const p = w.script("planner-grant2", `
l=$(capcomd spawn --profile lead --task lead --key lead --children.maxChildren=2 --children.maxDepth=1 --contract "$($S/json script=${JSON.stringify(lead)})" | $S/jget agentId)
capcomd await $l >/dev/null
capcomd result --summary "ok" --data "$($S/json lead=$l)" >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  expect((await finished(run, root)).status).toBe("done");
  const all = await agentsOf(run);
  const leadRow = all.find((x: any) => x.depth === 1);
  expect(leadRow.limits.maxChildren).toBe(2);
  expect(leadRow.result.summary).toMatch(/^rc=75 reason=backpressure retried=agt-/);
  expect(all.filter((x: any) => x.parent === leadRow.agentId).length).toBe(3);
  expect(await logText(run, leadRow.agentId)).toContain("children.maxChildren=2 reached");
}, 120_000);

test("parent tries to grant above its own ceiling: refused (not clamped), for each limit", async () => {
  const run = await newRun(w);
  const p = w.script("planner-overgrant", `
try() { out=$(capcomd spawn --profile lead --task over --key "$1" "$2" --contract '{"script":"true"}'); echo "$1 rc=$? $(echo "$out" | $S/jget error.message)"; }
try kids --children.maxChildren=9
try depth --children.maxDepth=2
try total --children.maxTotalDescendants=50
try prof --children.allowedChildProfiles=worker,planner
try share --children.budgetShare=0.9
ok=$(capcomd spawn --profile lead --task fine --key fine --children.maxChildren=3 --contract '{"script":"capcomd result --summary fine"}' | $S/jget agentId)
capcomd await $ok >/dev/null
capcomd result --summary "ok=$ok" >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  expect((await finished(run, root)).status).toBe("done");
  const logs = await logText(run, root);
  expect(logs).toMatch(/kids rc=1 grant children\.maxChildren=9 exceeds the ceiling 3/);
  expect(logs).toMatch(/depth rc=1 grant children\.maxDepth=2 exceeds the ceiling 1/);
  expect(logs).toMatch(/total rc=1 grant children\.maxTotalDescendants=50 exceeds the ceiling 6/);
  expect(logs).toMatch(/prof rc=1 grant children\.allowedChildProfiles=planner exceeds/);
  expect(logs).toMatch(/share rc=1 grant children\.budgetShare=0\.9 exceeds the ceiling 0\.5/);
  const all = await agentsOf(run);
  expect(all.length).toBe(2); // only the planner and the in-ceiling lead exist
  expect((await types(w, run)).filter((t) => t === "AGENT_SPAWNED").length).toBe(2);
}, 120_000);

test("spawn refused when allowSpawn=false: no spawn op in the worker's token; operator --parent also refused", async () => {
  const run = await newRun(w);
  const s = w.script("worker-spawns", `out=$(capcomd spawn --profile worker --task sneaky); echo "rc=$? $out"; capcomd result --summary "$(echo "$out" | $S/jget error.reason)" >/dev/null`);
  const id = await spawnRoot(w, run, "worker", s);
  const a = await finished(run, id);
  expect(a.status).toBe("done");
  expect(a.result.summary).toBe("forbidden");
  expect(await logText(run, id)).toMatch(/rc=1 .*op \\"spawn\\" is not in your token/);
  const op = await w.cj(["spawn", run, "--profile", "worker", "--task", "x", "--parent", id]);
  expect(op.code).not.toBe(0);
  expect(op.j.error.message).toMatch(/is done|allowSpawn=false/);
  expect((await agentsOf(run)).length).toBe(1);
}, 120_000);

test("await deadlock: sibling await cycle and awaiting an ancestor are both refused", async () => {
  const run = await newRun(w);
  const peer = w.script("peer-await", `
while :; do t=$(capcomd kv get "peer/$ROLE" | $S/jget value.id); [ "$t" != null ] && [ "$t" != undefined ] && break; sleep 0.2; done
[ "$ROLE" = b ] && sleep 1
out=$(capcomd await $t --timeout-ms 30000); rc=$?
echo "await $t rc=$rc"
capcomd result --summary "rc=$rc reason=$(echo "$out" | $S/jget error.reason)" --data "$($S/json msg="$(echo "$out" | $S/jget error.message)")" >/dev/null`);
  const p = w.script("planner-deadlock", `
a=$(capcomd spawn --profile lead --task a --key a --contract "$($S/json script="ROLE=a ${peer}")" | $S/jget agentId)
b=$(capcomd spawn --profile lead --task b --key b --contract "$($S/json script="ROLE=b ${peer}")" | $S/jget agentId)
u=$(capcomd spawn --profile lead --task up --key up --contract "$($S/json script="ROLE=up ${peer}")" | $S/jget agentId)
capcomd kv put peer/a "{\\"id\\":\\"$b\\"}" >/dev/null; capcomd kv put peer/b "{\\"id\\":\\"$a\\"}" >/dev/null; capcomd kv put peer/up "{\\"id\\":\\"$CAPCOMD_AGENT_ID\\"}" >/dev/null
capcomd await $a $b $u >/dev/null
capcomd result --summary "a=$(capcomd status $a | $S/jget agents.0.result.summary.text | tr '\\n' ' ') b=$(capcomd status $b | $S/jget agents.0.result.summary.text | tr '\\n' ' ')" --data "$($S/json a=$a b=$b u=$u)" >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  const r = await finished(run, root);
  expect(r.status).toBe("done");
  const all = await agentsOf(run);
  const by = (id: string) => all.find((x: any) => x.agentId === id);
  const { a, b, u } = r.result.data;
  expect(by(b).result.summary).toBe("rc=1 reason=deadlock"); // b registers second: closes the cycle
  expect(by(b).result.data.msg).toContain(`await cycle ${b} → ${a} → ${b}`);
  expect(by(a).result.summary).toMatch(/^rc=0 reason=(undefined)?$/); // a's await completes once b gives up
  expect(by(u).result.summary).toBe("rc=1 reason=deadlock");
  expect(by(u).result.data.msg).toContain("awaits its ancestor");
  const ty = await types(w, run);
  expect(ty.filter((t) => t === "DEADLOCK_DETECTED").length).toBe(1);
  expect(inOrder(ty, ["AGENT_SPAWNED", "AGENT_SPAWNED", "DEADLOCK_DETECTED", "AGENT_DONE", "AGENT_DONE"])).toBe(true);
}, 120_000);

test("runaway fan-out: 10 spawns against maxChildren=4 are throttled by backpressure; never more than 4 live", async () => {
  const run = await newRun(w);
  const p = w.script("runaway", PRE() + `
live=""; spawned=0; refused=0; i=0
while [ $spawned -lt 10 ]; do
  i=$((i+1)); [ $i -gt 200 ] && break
  out=$(capcomd spawn --profile worker --task "w$spawned" --key "w$spawned" --budget usd=0.1,turns=2,wallSeconds=120 --contract "${child("SLEEP=1 SPENT=1")}"); rc=$?
  if [ $rc = 0 ]; then live="$live $(echo "$out" | $S/jget agentId)"; spawned=$((spawned+1));
  elif [ $rc = 75 ]; then refused=$((refused+1)); capcomd wait-any $live >/dev/null; live=$(capcomd status $live | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).agents.filter(a=>!["done","failed","cancelled"].includes(a.status)).map(a=>a.agentId).join(" ")))');
  else echo "unexpected rc=$rc $out"; exit 1; fi
done
[ -n "$live" ] && capcomd await $live >/dev/null
capcomd result --summary "spawned=$spawned refused=$refused" --data "$($S/json refused=$refused)" >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  const r = await finished(run, root);
  expect(r.status).toBe("done");
  expect(r.result.summary).toMatch(/^spawned=10 refused=\d+$/);
  expect(r.result.data.refused).toBeGreaterThan(0);
  // trajectory: live children never exceed the limit
  const evs = (await (await import("./harness")).trajectory(w, run)).filter((e) => e.agentId !== root);
  let liveN = 0, max = 0;
  for (const e of evs) { if (e.type === "AGENT_SPAWNED") liveN++; if (["AGENT_DONE", "AGENT_FAILED", "AGENT_CANCELLED"].includes(e.type)) liveN--; max = Math.max(max, liveN); }
  expect(max).toBeLessThanOrEqual(4);
  expect(max).toBe(4);
  expect((await w.cj(["tree", run])).j.totals).toMatchObject({ agents: 11, turns: 10 });
}, 180_000);
