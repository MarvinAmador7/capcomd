// ADR-017 scenarios: coordination patterns, driven by scripted agents through in-VM capcomd.
// Each asserts outcome + trajectory (scope event order) + rollups.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { world, newRun, spawnRoot, waitAll, types, agentsOf, inOrder, WORKER, type World } from "./harness";

let w: World;
let worker: string;
beforeAll(async () => { w = await world("coord"); worker = w.script("worker", WORKER); }, 120_000);
afterAll(async () => { await w?.stop(); });

const child = (env: string) => `$($S/json script="${env} ${"$"}W")`; // contract JSON for a worker with env
const PRE = () => `W=${JSON.stringify(worker)}\n`;
async function trunkFiles() { await w.repo.seed.ok(["fetch", "-q", "origin"]); return (await w.repo.seed.ok(["ls-tree", "-r", "--name-only", "origin/trunk"])).split("\n").filter(Boolean); }
async function rootDone(run: string, root: string) {
  const aw = await waitAll(w, run, [root]);
  if (aw.agents[0].status !== "done") console.log((await w.cj(["tree", run])).stdout.slice(0, 3000), JSON.stringify(await types(w, run)),JSON.stringify(aw.agents[0], null, 1), JSON.stringify((await w.cj(["logs", run, root])).j?.lines?.map((l: any) => l.line), null, 1));
  return aw.agents[0];
}

test("single loop: one worker, structured result, no host secrets in its env", async () => {
  const run = await newRun(w);
  const s = w.script("single", `env | sort | sed 's/=.*//' | tr '\\n' ' '; echo\nFILE=src/single.txt CONTENT=single SPENT=4 ${worker}`);
  const id = await spawnRoot(w, run, "worker", s);
  const a = await rootDone(run, id);
  expect(a.status).toBe("done");
  expect(a.result).toMatchObject({ summary: "wrote src/single.txt", branch: `capcomd/${run}/${id}`, verification: null });
  expect(a.result.commit).toMatch(/^[0-9a-f]{40}$/);
  const envLine = (await w.cj(["logs", run, id])).j.lines.find((l: any) => l.line.includes("CAPCOMD_RPC_DIR"))?.line ?? "";
  expect(envLine).toContain("CAPCOMD_RPC_DIR");
  for (const secret of ["CAPCOMD_ENDPOINT", "CAPCOMD_RPC_KEY", "CAPCOMD_REPO", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "BOXD_API_KEY", "GIT_"]) expect(envLine).not.toContain(secret);
  expect(inOrder(await types(w, run), ["RUN_NEW", "AGENT_SPAWNED", "AGENT_STARTED", "KV_PUT", "TOKEN_REVOKED", "AGENT_DONE"])).toBe(true);
  const t = (await w.cj(["tree", run])).j;
  expect(t.totals).toMatchObject({ agents: 1, turns: 4 });
}, 120_000);

test("fan-out/fan-in: 3 workers, verify each, merge all; rollups sum the tree", async () => {
  const run = await newRun(w);
  const p = w.script("fanout", PRE() + `
ids=""
for f in a b c; do
  id=$(capcomd spawn --profile worker --task "write $f" --key $f --budget turns=10 --children.maxChildren=0 --contract "${child("FILE=src/$f.txt CONTENT=content-$f SPENT=3")}" | $S/jget agentId)
  ids="$ids $id"
done
capcomd await $ids > $HOME/aw.json || exit 1
merged=0
for id in $ids; do
  v=$(capcomd verify --ref $id --key v-$id)
  if [ "$(echo "$v" | $S/jget result.pass)" = true ]; then capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m-$id >/dev/null && merged=$((merged+1)); fi
done
capcomd result --summary "merged $merged of 3" --data "$($S/json merged=$merged spent='{"turns":2}')" >/dev/null
[ $merged = 3 ]`);
  const root = await spawnRoot(w, run, "planner", p, { contract: { checks: "test -d src" } });
  const a = await rootDone(run, root);
  expect(a.status).toBe("done");
  expect(a.result.summary).toBe("merged 3 of 3");
  expect(await trunkFiles()).toEqual(expect.arrayContaining(["src/a.txt", "src/b.txt", "src/c.txt"]));
  const ty = await types(w, run);
  expect(ty.filter((t) => t === "AGENT_SPAWNED").length).toBe(4);
  expect(ty.filter((t) => t === "VERIFY_PASSED").length).toBe(3);
  expect(ty.filter((t) => t === "MERGED").length).toBe(3);
  expect(inOrder(ty, ["AGENT_SPAWNED", "AGENT_SPAWNED", "AGENT_DONE", "VERIFY_PASSED", "MERGED", "AGENT_DONE"])).toBe(true);
  const t = (await w.cj(["tree", run])).j;
  expect(t.totals).toMatchObject({ agents: 4, turns: 11 }); // 3×3 + 2
  expect(t.tree[0].rollup).toMatchObject({ agents: 4, turns: 11 });
  const kids = (await agentsOf(run)).filter((x: any) => x.parent === root);
  for (const k of kids) expect(k.result.verification).toMatchObject({ pass: true });
}, 120_000);

test("supervisor/worker: failed child is inspected and retried", async () => {
  const run = await newRun(w);
  const p = w.script("supervisor", PRE() + `
try() { capcomd spawn --profile worker --task "job (attempt $1)" --key try$1 --contract "$2" | $S/jget agentId; }
id=$(try 1 "${child("EXIT=3")}")
st=$(capcomd await $id | $S/jget agents.0.status)
echo "attempt 1: $st"
capcomd logs $id | grep -q "failing on purpose" || { echo "no failure log"; exit 1; }
[ "$st" = failed ] || exit 1
id2=$(try 2 "${child("FILE=src/retry.txt CONTENT=ok")}")
st2=$(capcomd await $id2 | $S/jget agents.0.status)
capcomd result --summary "attempt1=$st attempt2=$st2" >/dev/null
[ "$st2" = done ]`);
  const root = await spawnRoot(w, run, "planner", p);
  const a = await rootDone(run, root);
  expect(a.status).toBe("done");
  expect(a.result.summary).toBe("attempt1=failed attempt2=done");
  const kids = (await agentsOf(run)).filter((x: any) => x.parent === root);
  expect(kids.map((k: any) => k.status).sort()).toEqual(["done", "failed"]);
  expect(kids.find((k: any) => k.status === "failed").result.exitCode).toBe(3);
  expect(inOrder(await types(w, run), ["AGENT_SPAWNED", "AGENT_SPAWNED", "AGENT_FAILED", "AGENT_SPAWNED", "AGENT_DONE", "AGENT_DONE"])).toBe(true);
}, 120_000);

const CRITIC = (maxRounds: number) => PRE() + `
round=0; landed=no
while [ $round -lt ${maxRounds} ]; do
  round=$((round+1))
  content=draft-$round; [ $round -ge 3 ] && content=GOOD-$round
  out=$(capcomd spawn --profile worker --task "write c.txt, round $round" --key r$round --budget turns=10 --contract "${child("FILE=src/c.txt CONTENT=$content SPENT=10")}")
  id=$(echo "$out" | $S/jget agentId)
  if [ "$id" = undefined ] || [ -z "$id" ]; then echo "spawn refused: $(echo "$out" | $S/jget error.message)"; break; fi
  capcomd await $id >/dev/null
  v=$(capcomd verify --ref $id --key v$round)
  if [ "$(echo "$v" | $S/jget result.pass)" = true ]; then capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" >/dev/null && landed=yes; break; fi
  capcomd send $id "round $round failed verification; next round" >/dev/null
done
capcomd result --summary "rounds=$round landed=$landed" >/dev/null
[ $landed = yes ]`;

test("critic loop: rework until verify passes", async () => {
  const run = await newRun(w);
  const root = await spawnRoot(w, run, "planner", w.script("critic", CRITIC(5)), { contract: { checks: "grep -q GOOD src/c.txt" } });
  const a = await rootDone(run, root);
  expect(a.status).toBe("done");
  expect(a.result.summary).toBe("rounds=3 landed=yes");
  const ty = await types(w, run);
  expect(ty.filter((t) => t === "VERIFY_FAILED").length).toBe(2);
  expect(inOrder(ty, ["VERIFY_FAILED", "MESSAGE_SENT", "VERIFY_FAILED", "MESSAGE_SENT", "VERIFY_PASSED", "MERGED"])).toBe(true);
}, 120_000);

test("critic loop: budget runs out before verify passes", async () => {
  const run = await newRun(w, "turns=25"); // round 1 carves 10 of 12 (25 × 0.5); round 2 has (25−10) × 0.5 = 7 < 10 → refused
  const root = await spawnRoot(w, run, "planner", w.script("critic-broke", CRITIC(5)), { contract: { checks: "grep -q GOOD src/c.txt" } });
  const a = await rootDone(run, root);
  expect(a.status).toBe("failed"); // the script exits 1: nothing landed
  expect(a.result.summary).toBe("rounds=2 landed=no");
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  expect(logs).toMatch(/spawn refused: requested 10 turns exceeds/);
  expect((await types(w, run)).filter((t) => t === "MERGED").length).toBe(0);
  const b = (await w.cj(["budget", "show", run, root])).j;
  expect(b.available.turns).toBeLessThan(20);
}, 120_000);

test("best-of-n + judge: first verified candidate merges, losers are cancelled (their VMs torn down)", async () => {
  const run = await newRun(w);
  const p = w.script("bestofn", PRE() + `
a=$(capcomd spawn --profile worker --task cand-a --key a --contract "${child("FILE=src/best.txt CONTENT=a-wrong SLEEP=0")}" | $S/jget agentId)
b=$(capcomd spawn --profile worker --task cand-b --key b --contract "${child("FILE=src/best.txt CONTENT=b-GOOD SLEEP=1")}" | $S/jget agentId)
c=$(capcomd spawn --profile worker --task cand-c --key c --contract "${child("FILE=src/best.txt CONTENT=c-slow SLEEP=60")}" | $S/jget agentId)
pending="$a $b $c"; winner=""
while [ -z "$winner" ] && [ -n "$pending" ]; do
  first=$(capcomd wait-any $pending | $S/jget agents | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).find(x=>["done","failed","cancelled"].includes(x.status));console.log(a.agentId)})')
  pending=$(echo $pending | tr ' ' '\\n' | grep -v "^$first$" | tr '\\n' ' ')
  v=$(capcomd verify --ref $first --key v-$first)
  if [ "$(echo "$v" | $S/jget result.pass)" = true ]; then capcomd merge --ref $first --require "$(echo "$v" | $S/jget id)" >/dev/null && winner=$first; fi
done
for l in $pending; do capcomd cancel $l --reason "lost best-of-n" >/dev/null; done
capcomd result --summary "winner=$winner" --data "$($S/json winner=$winner b=$b c=$c)" >/dev/null
[ "$winner" = "$b" ]`);
  const root = await spawnRoot(w, run, "planner", p, { contract: { checks: "grep -q GOOD src/best.txt" } });
  const a = await rootDone(run, root);
  expect(a.status).toBe("done");
  const { b, c } = a.result.data;
  expect(a.result.data.winner).toBe(b);
  const all = await agentsOf(run);
  expect(all.find((x: any) => x.agentId === c).status).toBe("cancelled");
  const ins = (await w.cj(["inspect", run, c])).j;
  expect(["destroyed", "draining", null]).toContain(ins.vm?.state ?? null);
  const ty = await types(w, run);
  expect(inOrder(ty, ["VERIFY_FAILED", "VERIFY_PASSED", "MERGED", "AGENT_CANCELLED", "AGENT_DONE"])).toBe(true);
}, 120_000);

test("nested planner depth 2: planner → lead (granted 2 children) → 2 workers; rollups + trace parenting", async () => {
  const run = await newRun(w);
  const lead = w.script("lead", PRE() + `
x=$(capcomd spawn --profile worker --task "x of $CAPCOMD_TASK" --key x --contract "${child("FILE=src/n-$CAPCOMD_AGENT_ID-x.txt CONTENT=x SPENT=2")}" | $S/jget agentId)
y=$(capcomd spawn --profile worker --task "y of $CAPCOMD_TASK" --key y --contract "${child("FILE=src/n-$CAPCOMD_AGENT_ID-y.txt CONTENT=y SPENT=2")}" | $S/jget agentId)
capcomd await $x $y >/dev/null || exit 1
capcomd result --summary "lead done" --data "$($S/json spent='{"turns":1}')" >/dev/null`);
  const p = w.script("nested", `
L=$($S/json script=${JSON.stringify(lead)})
l=$(capcomd spawn --profile lead --task "module A" --key lead --children.maxChildren=2 --children.maxDepth=1 --contract "$L" | $S/jget agentId)
capcomd await $l >/dev/null || exit 1
capcomd tree > $HOME/tree.json
capcomd result --summary "depth2 ok" --data "$($S/json lead=$l spent='{"turns":1}')" >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  const a = await rootDone(run, root);
  expect(a.status).toBe("done");
  const all = await agentsOf(run);
  expect(all.map((x: any) => x.depth).sort()).toEqual([0, 1, 2, 2]);
  const leadRow = all.find((x: any) => x.depth === 1);
  expect(leadRow.limits).toMatchObject({ maxChildren: 2, maxDepth: 1 });
  const t = (await w.cj(["tree", run])).j;
  expect(t.tree[0].rollup).toMatchObject({ agents: 4, turns: 6 });
  expect(t.tree[0].children[0].rollup).toMatchObject({ agents: 3, turns: 5 });
  // trace parenting: every agent.run span's parent is its parent agent's span
  const tf = join(w.env.CAPCOMD_TRACE_DIR!, `${run}.ndjson`);
  expect(existsSync(tf)).toBe(true);
  const spans = readFileSync(tf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((s: any) => s.name === "agent.run");
  const byAgent = new Map(spans.map((s: any) => [s.attributes["agent.id"], s]));
  for (const x of all) {
    const s: any = byAgent.get(x.agentId);
    expect(s).toBeTruthy();
    if (x.parent) expect(s.parentSpanId).toBe((byAgent.get(x.parent) as any).spanId);
  }
}, 120_000);

test("handoff: a lead hands its task to a successor; the lead's result is the successor's", async () => {
  const run = await newRun(w);
  const p = w.script("handoff", PRE() + `
capcomd heartbeat "context gathered; handing off" >/dev/null
capcomd handoff --task "finish the job" --profile worker --context '{"notes":"use src/h.txt"}' > $HOME/h.json
cat $HOME/h.json`);
  // the successor is a worker whose default script writes src/<id>.txt
  const root = await spawnRoot(w, run, "lead", p);
  const a = await rootDone(run, root);
  expect(a.status).toBe("done");
  expect(a.result.handoffTo).toMatch(/^agt-/);
  expect(a.result.branch).toBe(`capcomd/${run}/${a.result.handoffTo}`);
  const succ = (await agentsOf(run)).find((x: any) => x.agentId === a.result.handoffTo);
  expect(succ.contract).toMatchObject({ handoffFrom: root, context: { notes: "use src/h.txt" } });
  expect(inOrder(await types(w, run), ["AGENT_SPAWNED", "AGENT_STARTED", "AGENT_SPAWNED", "KV_PUT", "AGENT_DONE", "AGENT_DONE"])).toBe(true);
}, 120_000);

test("blackboard: 3 peers increment a shared counter with kv cas (no lost updates)", async () => {
  const run = await newRun(w);
  const peer = w.script("peer", `
i=0
while [ $i -lt 30 ]; do
  i=$((i+1))
  cur=$(capcomd kv get counter); v=$(echo "$cur" | $S/jget version); n=$(echo "$cur" | $S/jget value.n); [ "$n" = undefined ] || [ "$n" = null ] && n=0
  out=$(capcomd kv cas counter "{\\"n\\":$((n+1))}" --expect $v) && { echo "won at try $i"; break; }
done
capcomd result --summary "incremented after $i tries" >/dev/null`);
  const p = w.script("board-planner", `
P=$($S/json script=${JSON.stringify(peer)})
ids=""
for k in 1 2 3; do ids="$ids $(capcomd spawn --profile worker --task "peer $k" --key p$k --contract "$P" | $S/jget agentId)"; done
capcomd await $ids >/dev/null || exit 1
n=$(capcomd kv get counter | $S/jget value.n)
capcomd result --summary "counter=$n" >/dev/null
[ "$n" = 3 ]`);
  const root = await spawnRoot(w, run, "planner", p);
  const a = await rootDone(run, root);
  expect(a.status).toBe("done");
  expect(a.result.summary).toBe("counter=3");
  const ty = await types(w, run);
  expect(ty.filter((t) => t === "KV_CAS").length).toBe(3);
  // a peer's kv write is visible to the others tagged as untrusted (written by another agent)
  const kv = (await w.cj(["kv", "get", run, "counter"])).j;
  expect(kv.version).toBe(3);
}, 120_000);

test("task board: deps + lease takeover from a crashed worker, fenced epochs", async () => {
  const run = await newRun(w);
  const crasher = w.script("crasher", `capcomd task claim --lease-ms 300 > $HOME/c.json; cat $HOME/c.json; echo "crashing while holding the lease"; exit 0`);
  const finisher = w.script("finisher", `
done=""
while :; do
  c=$(capcomd task claim) || break
  t=$(echo "$c" | $S/jget taskId); e=$(echo "$c" | $S/jget epoch)
  [ "$t" = undefined ] && break
  capcomd task done $t --epoch $e --result "{\\"by\\":\\"$CAPCOMD_AGENT_ID\\"}" >/dev/null && done="$done $t@$e"
done
capcomd result --summary "done:$done" >/dev/null`);
  const p = w.script("taskboard", `
t1=$(capcomd task add --title build --key t1 | $S/jget task.taskId)
t2=$(capcomd task add --title test --key t2 --after $t1 | $S/jget task.taskId)
blocked=$(capcomd task claim $t2 | $S/jget error.message)
echo "claim t2 early: $blocked"
c=$(capcomd spawn --profile worker --task crash --key crash --contract "$($S/json script=${JSON.stringify(crasher)})" | $S/jget agentId)
capcomd await $c >/dev/null
sleep 0.5
f=$(capcomd spawn --profile worker --task finish --key fin --contract "$($S/json script=${JSON.stringify(finisher)})" | $S/jget agentId)
capcomd await $f >/dev/null
s=$(capcomd task list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tasks.map(t=>t.title+"="+t.status+"@"+t.epoch).join(",")))')
capcomd result --summary "$s" --data "$($S/json t1=$t1 t2=$t2 blocked="$blocked")" >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  const a = await rootDone(run, root);
  expect(a.status).toBe("done");
  expect(a.result.data.blocked).toMatch(/blocked|after|depends/i);
  expect(a.result.summary).toBe("build=done@2,test=done@1");
  const ty = await types(w, run);
  expect(inOrder(ty, ["TASK_ADDED", "TASK_ADDED", "TASK_CLAIMED", "TASK_LEASE_EXPIRED", "TASK_CLAIMED", "TASK_DONE", "TASK_CLAIMED", "TASK_DONE"])).toBe(true);
}, 120_000);
