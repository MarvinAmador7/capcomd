// ADR-026 §7 against a real engine, with scripted agents driving the in-VM capcomd: a worker's typed hand-back
// (`capcomd result --handback`, handback@1) is checked before it is recorded (a payload that doesn't fit is refused,
// field by field, and nothing is recorded), reaches its parent's `await` as fields (fenced: untrusted, with its author)
// and its parent's thread as a card (`child.handback`); a prose hand-back still works as before; a reviewer's verdict is
// recorded as review-verdict@1 and its card carries the findings. And an agent's bookkeeping in its thread is recorded
// but internal: GET …/thread and …/thread/tail leave it out unless asked, and a conversation rebuilt from the thread
// leaves it out.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { world, spawnRoot, waitAll, agentsOf, WORKER, type World } from "../scenarios/harness";
import { addClient, loadClients } from "../../src/api/clients";
import { ThreadPage, ThreadTail } from "../../src/api/contract";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { threadBuilder } from "../../packages/agent-thread/src/index";

let w: World;
let app: ReturnType<typeof harnessApp>;
let token = "";

const HANDBACK = {
  status: "done", outcome: "added the parser",
  changed: [{ path: "src/parse.ts", what: "new" }],
  checked: [{ check: "bun test", result: "passed", note: "12 pass" }, { check: "the CLI by hand", result: "not run" }],
  risks: ["dates before 1970 are not handled"], decide: ["keep the old parser behind a flag?"],
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-typed-"));
  // Scripted reviewer: review-verdict@1's findings in its declared result; GOOD passes.
  const reviewer = join(dir, "reviewer.sh");
  writeFileSync(reviewer, `#!/bin/sh
case "$CAPCOMD_TASK" in
  *GOOD*) capcomd result --summary "fine" --data '{"passed": true, "findings": []}' >/dev/null ;;
  *) capcomd result --summary "no" --data '{"passed": false, "findings": [{"severity": "blocker", "file": "src/b.txt", "line": 1, "text": "writes the wrong content"}, {"text": "no test", "severity": "minor"}]}' >/dev/null ;;
esac
`);
  chmodSync(reviewer, 0o755);
  w = await world("typed", { CAPCOMD_SCRIPT_REVIEWER: `sh ${reviewer}`, CAPCOMD_VERIFY_HOLD_MS: "100" });
  const clients = join(dir, "clients.json");
  token = addClient("menubar", ["read"], clients).token;
  app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), state: harnessState(null), pollMs: 100 });
}, 120_000);
afterAll(async () => { await w?.stop(); });

const get = async (p: string) => (await app.request(p, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<any>;
const scope = async (run: string) => (await import("../../src/core/relay")).client().scope.getOrCreate([run]);
const logsOf = async (run: string, id: string) => ((await w.cj(["logs", run, id])).j?.lines ?? []).map((l: any) => l.line).join("\n");

test("a typed hand-back: refused until it fits, then recorded; the parent's await reads its fields, its thread a card; prose still works", async () => {
  const typed = w.script("typed-worker", `
r=$(capcomd result --handback '{"status": "finished", "outcome": "", "changed": ["src/parse.ts"], "notes": "x"}'); echo "bad rc=$? $r"
r=$(capcomd result --handback '{oops'); echo "notjson rc=$? $r"
capcomd result --handback '${JSON.stringify(HANDBACK)}' >/dev/null && echo "typed ok"`);
  const prose = w.script("prose-worker", `capcomd result --summary "Done: wrote the docs.
- Changed: \\\`docs/a.md\\\`." >/dev/null`);
  const run = (await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `typed-${Date.now()}`])).j.runId as string;
  const p = w.script("typed-planner", `
a=$(capcomd spawn --profile worker --task "parse dates" --key typed --contract "$($S/json script="${typed}")" | $S/jget agentId)
b=$(capcomd spawn --profile worker --task "write the docs" --key prose --contract "$($S/json script="${prose}")" | $S/jget agentId)
capcomd kv put awaited "$(capcomd await $a $b)" >/dev/null
capcomd kv put ids "$($S/json a=$a b=$b)" >/dev/null
capcomd result --summary done >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  const done = (await waitAll(w, run, [root], 90_000)).agents[0];
  expect(done.status).toBe("done");
  const s = await scope(run);
  const ids = (await s.kvGet({ k: "ids" }))!.value as { a: string; b: string };

  // Refused, nothing recorded, each field to fix said; not JSON says so too. Then the good one went through.
  const logs = await logsOf(run, ids.a);
  expect(logs).toMatch(/bad rc=2 /);
  const bad = JSON.parse(/bad rc=2 (.*)/.exec(logs)![1]!);
  expect(bad.ok).toBe(false);
  expect(bad.error.reason).toBe("invalid_payload");
  expect(bad.error.message).toBe(`the hand-back doesn't fit handback@1, so nothing was recorded: notes: not a field here (fields: status, outcome, changed, checked, risks, decide); status: must be one of "done", "partly", "blocked"; outcome: must not be empty; changed[0]: must be an object, not a string`);
  expect(bad.error.hint).toContain(`--handback '{"status": "done"`);
  expect(logs).toMatch(/notjson rc=2 .*the hand-back isn't JSON: nothing was recorded/);
  expect(logs).toContain("typed ok");

  // The child's record: the typed fields as sent, and its prose form as the summary.
  const agents = await agentsOf(run);
  const a = agents.find((x: any) => x.agentId === ids.a)!, b = agents.find((x: any) => x.agentId === ids.b)!;
  expect((a.result as any).typed).toEqual({ schema: "handback@1", value: HANDBACK });
  expect((a.result as any).summary).toBe([
    "Done: added the parser.", "- Changed: `src/parse.ts` (new).", "- Checked: bun test: passed (12 pass); the CLI by hand: not run.",
    "- Risk: dates before 1970 are not handled", "- Decide: keep the old parser behind a flag?",
  ].join("\n"));
  expect((b.result as any).typed).toBeUndefined();
  expect((b.result as any).summary).toBe("Done: wrote the docs.\n- Changed: `docs/a.md`.");

  // The parent's await: the fields, fenced (untrusted, with their author); the prose child as before.
  const awaited = (await s.kvGet({ k: "awaited" }))!.value as any;
  const ra = awaited.agents.find((x: any) => x.agentId === ids.a).result, rb = awaited.agents.find((x: any) => x.agentId === ids.b).result;
  expect(ra.typed).toMatchObject({ schema: "handback@1", untrusted: true, from: ids.a, value: HANDBACK });
  expect(ra.summary.text).toContain("<<<untrusted:");
  expect(rb.typed).toBeUndefined();
  expect(rb.summary.text).toContain("Done: wrote the docs.");

  // The parent's thread: a card with the typed fields; the prose child's card as before.
  const items = ThreadPage.parse(await get(`/v1/runs/${run}/agents/${root}/thread?after=0`)).items.filter((i) => i.kind === "handoff");
  const ca = items.find((i) => i.child?.agentId === ids.a)!, cb = items.find((i) => i.child?.agentId === ids.b)!;
  expect(ca.child!.handback as unknown).toEqual({ ...HANDBACK, changed: [{ path: "src/parse.ts", what: "new" }], checked: [HANDBACK.checked[0], { ...HANDBACK.checked[1], note: null }] });
  expect(ca.text).toStartWith("Done: added the parser.");
  expect(cb.child!.handback).toBeUndefined();
  expect(cb.text).toStartWith("Done: wrote the docs.");
}, 120_000);

test("a reviewer's verdict is review-verdict@1: recorded typed, its card carries the findings", async () => {
  const worker = w.script("rv-worker", WORKER);
  const r = await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `rv-${Date.now()}`, "--checks-set", "ok=test -d src", "--reviewer", "reviewer"]);
  const run = r.j.runId as string;
  const p = w.script("rv-planner", `
b=$(capcomd spawn --profile worker --task "write BAD b" --key b --check ok --contract "$($S/json script="FILE=src/b.txt CONTENT=b ${worker}")" | $S/jget agentId)
capcomd await $b >/dev/null
v=$(capcomd verify --ref $b --key v-b); echo "verdict pass=$(echo "$v" | $S/jget result.pass)"
capcomd result --summary done >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  expect((await waitAll(w, run, [root], 120_000)).agents[0].status).toBe("done");
  expect(await logsOf(run, root)).toContain("verdict pass=false");
  const reviewer = (await agentsOf(run)).find((x: any) => x.profile === "reviewer")! as any;
  const findings = [{ severity: "blocker", file: "src/b.txt", line: 1, text: "writes the wrong content" }, { text: "no test", severity: "minor" }];
  expect(reviewer.result.typed).toEqual({ schema: "review-verdict@1", value: { passed: false, findings } });
  // The verdict's reasons are the same findings, as lines (what the verify gate and older clients read).
  expect(reviewer.result.verdict).toEqual({ passed: false, reasons: ["src/b.txt:1: writes the wrong content", "no test"] });
  const card = ThreadPage.parse(await get(`/v1/runs/${run}/agents/${root}/thread?after=0`)).items.find((i) => i.kind === "handoff" && i.child?.agentId === reviewer.agentId)!;
  expect(card.child!.verdict as unknown).toEqual({ passed: false, reasons: ["src/b.txt:1: writes the wrong content", "no test"], findings: [findings[0], { text: "no test", severity: "minor", file: null, line: null }] });
}, 150_000);

test("bookkeeping is recorded but internal: the thread routes leave it out unless asked; a rebuilt conversation leaves it out", async () => {
  const run = (await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `bk-${Date.now()}`])).j.runId as string;
  const id = await spawnRoot(w, run, "worker", w.script("bk-worker", WORKER));
  await waitAll(w, run, [id], 60_000);
  // Its CLI's thread, as the runner writes it (packages/agent-thread's builder): a wake, a poll, a retried request, work.
  const b = threadBuilder({ cli: "claude", idPrefix: `itm-${id}-bk`, now: () => Date.now() });
  const tool = (cid: string, name: string, input: unknown) => [{ type: "assistant", message: { id: `m-${cid}`, content: [{ type: "tool_use", id: cid, name, input }] } }, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: cid, content: "{}" }] } }];
  const events = [
    { type: "assistant", message: { id: "m-1", content: [{ type: "text", text: "Starting the parser." }] } },
    ...tool("w", "Bash", { command: "capcomd wake --in 10m --note 'look at CI'" }),
    ...tool("s", "mcp__capcomd__capcomd_inbox", {}),
    { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10 },
    ...tool("t", "Bash", { command: "bun test" }),
    { type: "assistant", message: { id: "m-2", content: [{ type: "text", text: "The parser works." }] } },
  ];
  const drafts = new Map<string, any>();
  for (const e of events) for (const d of b.event(e)) drafts.set(d.id, d);
  const s = await scope(run);
  await s.putItems({ agentId: id, items: [...drafts.values()] });
  // A daemon note can be bookkeeping too (a scheduler's line), and is recorded the same way.
  await s.threadNote({ agentId: id, id: `itm-${id}-sched-1`, text: "check-in booked for 12:40", internal: true });

  const shown = ThreadPage.parse(await get(`/v1/runs/${run}/agents/${id}/thread?after=0`)).items;
  expect(shown.map((i) => i.text)).toEqual(["Starting the parser.", "Run bun test", "The parser works."]);
  expect(shown.every((i) => i.internal === false)).toBe(true);
  const all = ThreadPage.parse(await get(`/v1/runs/${run}/agents/${id}/thread?after=0&internal=true`)).items;
  expect(all.filter((i) => i.internal).map((i) => i.text)).toEqual(["Run capcomd wake --in 10m --note 'look at CI'", all.find((i) => i.tool?.name === "mcp__capcomd__capcomd_inbox")!.text, "Retrying the model request (attempt 1 of 10)", "check-in booked for 12:40"]);
  const tail = ThreadTail.parse(await get(`/v1/runs/${run}/agents/${id}/thread/tail?limit=2`));
  expect(tail.items.map((i) => i.text)).toEqual(["Run bun test", "The parser works."]);
  expect(ThreadTail.parse(await get(`/v1/runs/${run}/agents/${tail.items[0]!.agentId}/thread/tail?limit=2&before=${tail.before}`)).items.map((i) => i.text)).toEqual(["Starting the parser."]);
  expect(ThreadTail.parse(await get(`/v1/runs/${run}/agents/${id}/thread/tail?limit=50&internal=1`)).items).toHaveLength(7);
  // The thread a conversation is rebuilt from (ADR-026 §5 path 4): what it did and said, not how it waited.
  const cont = await s.continuation({ agentId: id });
  expect(cont!.items.map((i: any) => i.text).reverse()).toEqual(["Starting the parser.", "Run bun test", "The parser works."]);
}, 90_000);
