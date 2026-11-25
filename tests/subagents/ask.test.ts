// ADR-026 §4 (capability agents.ask): ask and stop.
//
// Through a real agent CLI (fake claude in a host-exec FakeProvider, the in-VM capcomd and the supervisor feeding its
// stdin): an agent asks (`capcomd ask … --recommend …`) and its turn ends at once, holding nothing; the question goes to
// its parent (whose `await --wake` returns on it) or, at the root, to the user as an approval of kind question; the
// answer (a plain message, `capcomd answer`, or the approval decided with an answer) is appended to the thread and wakes
// the same conversation. A parent that can't decide passes it up to the user. Then, on the scope actor and the RPC
// directly: a person's answer wins over an agent's, a child's message to an asked parent isn't its answer, a blocking
// await returns on a question, a cancelled agent's question is withdrawn, and what an agent may answer.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";
import { addClient, loadClients } from "../../src/api/clients";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { lifecycleEvents } from "../../src/api/lifecycle";
import { approvalIdFor } from "../../src/api/source";

let engine: Engine;
let env: Record<string, string>;
let app: ReturnType<typeof harnessApp>;
let token = "";
let dir = "";
const runs: string[] = [];
const saved = { ...process.env };

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  dir = mkdtempSync(join(tmpdir(), "capcomd-ask-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    lead: { provider: "claude", auth: "apikey", maxTurns: 40, children: { allowSpawn: true, maxDepth: 2, maxChildren: 2, allowedChildProfiles: ["lead", "worker"] } },
    worker: { provider: "claude", auth: "apikey", maxTurns: 20 },
  } }));
  env = {
    ...r.env,
    CAPCOMD_HOME: join(dir, "home"),
    CAPCOMD_HARNESS_SOCKET: join(dir, "home", "harness.sock"),
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_VM_RPC_POLL_MS: "200",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    CAPCOMD_RPC_KEY: `ask-${Math.random()}`,
    ANTHROPIC_API_KEY: "sk-ant-api03-ASKSTOP-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
    CAPCOMD_MESSAGE_FALLBACK_MS: "600000",
  };
  Object.assign(process.env, env); // the engine (actors) inherits process.env
  const port = await testPort();
  engine = new Engine("ask", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
  const clients = join(dir, "clients.json");
  token = addClient("desktop", ["read", "steer", "approve"], clients).token;
  app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), state: harnessState(null), pollMs: 100 });
}, 120_000);

afterAll(async () => {
  const mine = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString().split("\n").filter((l) => (dir && l.includes(dir)) || runs.some((r) => l.includes(`/${r}/`))).map((l) => Number(l.trim().split(/\s+/)[0]));
  for (const pid of mine) if (pid > 1 && pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};
const scope = async (run: string) => (await import("../../src/core/relay")).client().scope.getOrCreate([run]);
const events = async (run: string, type?: string) => ((await (await scope(run)).getEvents({})) as any[]).filter((e) => !type || e.type === type);
const newRun = async () => { const run = (await cj(["run", "new"])).j?.runId as string; runs.push(run); return run; };
const awaitOne = async (run: string, id: string) => (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
/** What the fake CLI wrote in the agent's stable directory (`${workdir}/<agentId>/`, the parent of its checkout). */
const seen = (id: string, f: string) => { const p = join(dir, "vm", id, f); return existsSync(p) ? readFileSync(p, "utf8") : ""; };
const lastJson = (s: string) => JSON.parse(s.trim().split("\n").filter(Boolean).pop()!);
/** Until `pred` holds of the agent's record (an attempt ending, a continued one starting), at most `ms`. */
async function until(run: string, id: string, pred: (a: any) => boolean, ms = 90_000) {
  const t = Date.now();
  for (;;) {
    const a = await (await scope(run)).getAgent({ agentId: id });
    if (a && pred(a)) return a;
    if (Date.now() - t > ms) throw new Error(`${id} never got there: ${JSON.stringify({ status: a?.status, epoch: a?.epoch, asked: a?.asked })}`);
    await Bun.sleep(150);
  }
}
const api = (p: string, init?: RequestInit) => app.request(p, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) } });

test("a root agent asks and stops: the question is the user's approval; a plain message answers it and continues the same session", async () => {
  const run = await newRun();
  const id = (await cj(["spawn", run, "--profile", "worker", "--task", "[ask] ship the request limiter", "--key", "root"])).j?.agentId;
  // Its turn ended at once, changing nothing: not a failure, it asked.
  const first = await awaitOne(run, id);
  expect(first).toMatchObject({ status: "done", result: { asked: expect.stringMatching(/^qst-/) } });
  const asked = lastJson(seen(id, "ask-out.txt"));
  expect(asked).toMatchObject({ ok: true, to: "user", state: "open" });
  expect(asked.hint).toContain("End your turn now");
  const a = await (await scope(run)).getAgent({ agentId: id });
  expect(a!.asked).toMatchObject({ questionId: asked.asked, to: null, question: "Ship the limiter at 100 or 500 req/min?", recommend: "100 req/min",
    options: ["100 req/min", "500 req/min"], why: "The docs set the free tier at 100.", holds: "write tests" });
  expect((await events(run, "AGENT_ASKED"))[0]).toMatchObject({ agentId: id, data: { questionId: asked.asked, to: null, recommend: "100 req/min" } });
  // The user's approval of kind question, with the card's parts; the agent shows it (Agent.asked).
  const approvalId = approvalIdFor(run, asked.asked);
  const pending = await rivetSource().approvals(run);
  expect(pending).toEqual([expect.objectContaining({ approvalId, kind: "question", question: "Ship the limiter at 100 or 500 req/min?", requestedBy: { agentId: id, runId: run },
    subject: expect.objectContaining({ questionId: asked.asked, to: null, why: "The docs set the free tier at 100.", holds: "write tests",
      options: [{ label: "100 req/min", recommended: true }, { label: "500 req/min", recommended: false }] }) })]);
  const shown = (await rivetSource().agents(run))!.find((x: any) => x.id === id) as any;
  expect(shown.asked).toMatchObject({ questionId: asked.asked, approvalId, to: null, recommend: "100 req/min" });
  const lc = lifecycleEvents(run, await events(run) as any);
  expect(lc.find((e) => e.type === "agent.asked")).toMatchObject({ data: { cause: "asked", questionId: asked.asked } });
  expect(lc.find((e) => e.type === "approval.requested")).toMatchObject({ data: { approvalId, kind: "question", cause: "approval_needed" } });
  // §9.4: a plain message is its answer: it continues, in the same conversation (its session resumed).
  const sent = await cj(["send", run, id, "500 req/min", "--key", "answer"]);
  expect(sent.j).toMatchObject({ continued: true, epoch: 2 });
  const second = await until(run, id, (x) => x.epoch === 2 && x.status === "done");
  expect(second.result?.summary).toBe("fixed sum");
  const argv = seen(id, "argv.txt").split("\n");
  expect(argv[argv.indexOf("--resume") + 1]).toMatch(/^[0-9a-f-]{36}$/);
  expect(seen(id, "prompt-seen.txt")).toContain("500 req/min");
  const q = await (await scope(run)).getQuestion({ questionId: asked.asked });
  expect(q).toMatchObject({ state: "answered", answer: "500 req/min", answeredBy: "operator" });
  expect(second.asked).toBeNull();
  expect((await events(run, "AGENT_ANSWERED"))[0]).toMatchObject({ agentId: id, data: { questionId: asked.asked, by: "operator", recommended: false, replaces: null } });
  expect(await rivetSource().approvals(run)).toEqual([]);
  const decided = lifecycleEvents(run, await events(run) as any).find((e) => e.type === "approval.decided");
  expect(decided).toMatchObject({ data: { approvalId, status: "answered", answer: "500 req/min", recommended: false, cause: "answered" } });
}, 180_000);

test("a worker asks its parent: the parent's await --wake returns on the question, and its answer continues the same conversation", async () => {
  const run = await newRun();
  const parent = (await cj(["spawn", run, "--profile", "lead", "--task", "[ask-parent] split it", "--key", "p"])).j?.agentId;
  const done = await awaitOne(run, parent);
  expect(done?.status).toBe("done");
  // Woken twice: by the question, then (it waited on the child again after answering) by the child's end.
  const woken = (await events(run, "AGENT_WOKEN")).filter((e) => e.agentId === parent);
  expect(woken).toHaveLength(2);
  expect(woken[1].data.text).toMatch(/^agt-\S+ ended: done$/);
  expect(woken[0].data.text).toMatch(/^agt-\S+ asked a question \(qst-\S+\) and stopped until it is answered$/);
  const kid = woken[0].data.text.split(" ")[0];
  // The wake-up carried the question, its recommendation and how to answer; the parent took the recommendation.
  const heard = (await (await scope(run)).inbox({ agentId: parent })).map((m: any) => m.body).join("\n");
  expect(heard).toContain("Ship the limiter at 100 or 500 req/min? Recommended: 100 req/min (The docs set the free tier at 100.)");
  expect(heard).toContain("capcomd answer qst-");
  const answered = lastJson(seen(parent, "answer-out.txt"));
  expect(answered).toMatchObject({ ok: true, agentId: kid, answer: "100 req/min", recommended: true });
  // The child continues with the answer (warm if its CLI was still open, else its saved session resumed) and finishes.
  const child = await until(run, kid, (x) => x.status === "done" && !x.asked && x.result?.summary === "fixed sum");
  expect(seen(parent, "rewait.txt")).toContain('"wakeState":"armed"');
  const said = `${seen(kid, "prompt-seen.txt")}\n${seen(kid, "messages.txt")}`;
  expect(said).toContain(`Answer to your question ${answered.answered} from ${parent}: 100 req/min`);
  expect(said).toContain("Their note: the docs win");
  if (child.epoch > 1) expect(seen(kid, "argv.txt")).toContain("--resume");
  expect(await (await scope(run)).getQuestion({ questionId: answered.answered })).toMatchObject({ state: "answered", answeredBy: parent, note: "the docs win" });
  // Asked of an agent, the question was the user's approval too (the user can always answer).
  const lc = lifecycleEvents(run, await events(run) as any);
  expect(lc.find((e) => e.type === "approval.decided")).toMatchObject({ data: { status: "answered", recommended: true, decidedBy: { clientId: parent } } });
}, 180_000);

test("a parent that can't decide passes it up to the user; the user's answer (the approval, decided) continues the asker", async () => {
  const run = await newRun();
  const parent = (await cj(["spawn", run, "--profile", "lead", "--task", "[ask-parent][pass-up] split it", "--key", "p"])).j?.agentId;
  expect((await awaitOne(run, parent))?.status).toBe("done");
  const passed = (await events(run, "AGENT_QUESTION_PASSED"))[0];
  expect(passed).toMatchObject({ data: { from: parent, to: null } });
  const kid = passed.agentId;
  const qid = passed.data.questionId;
  expect(lastJson(seen(parent, "answer-out.txt"))).toMatchObject({ ok: true, to: null });
  const approvalId = approvalIdFor(run, qid);
  expect((await rivetSource().approvals(run))[0]).toMatchObject({ approvalId, kind: "question", subject: { to: null, passedBy: [parent] } });
  await until(run, kid, (x) => x.status === "done" && !!x.asked);
  // A deny is no answer; an answer without its text is refused.
  expect((await api(`/v1/approvals/${approvalId}/decision`, { method: "POST", headers: { "idempotency-key": "deny-it-1" }, body: JSON.stringify({ decision: "deny" }) })).status).toBe(422);
  expect((await api(`/v1/approvals/${approvalId}/decision`, { method: "POST", headers: { "idempotency-key": "empty-it-1" }, body: JSON.stringify({ decision: "answer" }) })).status).toBe(422);
  const res = await api(`/v1/approvals/${approvalId}/decision`, { method: "POST", headers: { "idempotency-key": "answer-it-1" }, body: JSON.stringify({ decision: "answer", answer: "500 req/min", reason: "Our biggest client already does 300." }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ approvalId, status: "answered", answer: "500 req/min", recommended: false, reason: "Our biggest client already does 300." });
  // Decided once: the same key replays, a new one is 409.
  expect((await api(`/v1/approvals/${approvalId}/decision`, { method: "POST", headers: { "idempotency-key": "answer-it-2" }, body: JSON.stringify({ decision: "approve" }) })).status).toBe(409);
  const child = await until(run, kid, (x) => x.epoch === 2 && x.status === "done");
  expect(child.result?.summary).toBe("fixed sum");
  const prompt = seen(kid, "prompt-seen.txt");
  expect(prompt).toContain(`Answer to your question ${qid} from the user: 500 req/min`);
  expect(prompt).toContain("Their note: Our biggest client already does 300.");
}, 180_000);

// ── the scope actor and the RPC directly ─────────────────────────────────────────────────────────────
const O = () => import("../../src/primitives/ops");
const rpc = async (run: string, agentId: string, op: string, args: Record<string, unknown>, ops?: string[]) => {
  const { mint, ALL_OPS } = await import("../../src/subagents/token");
  const { handleRpc } = await import("../../src/subagents/rpc");
  const { token } = mint({ run, sub: agentId, ops: (ops ?? [...ALL_OPS]) as any });
  return handleRpc({ id: `t-${Math.random().toString(36).slice(2)}`, token, op, args }, { runId: run, agentId }) as Promise<any>;
};
/** A planner P with its lead L, and L's worker W; none started (pending agents can ask: the RPC checks the token). */
const tree = async (run: string) => {
  const sp = (key: string, parent?: string, profile = "lead") => O().then((o) => o.spawnAgent({ runId: run, task: `[steady] ${key}`, key, profile, start: false, ...(parent ? { parent } : {}) }).then((x) => x.agentId));
  const P = await sp("P");
  const L = await sp("L", P);
  return { P, L, W: await sp("W", L, "worker") };
};
const ASK = { question: "Which limit?", recommend: "100 req/min", options: ["500 req/min", "100 req/min"], why: "the docs", holds: "tests" };

test("one open question per agent; what it may answer; a person's answer wins; a child's message isn't its parent's answer", async () => {
  const run = await newRun();
  const s = await scope(run);
  const { P, L, W } = await tree(run);
  // A question needs its recommendation; a worker's token has ask, not answer.
  expect((await rpc(run, W, "ask", { question: "Which?" })).error.message).toMatch(/recommend/);
  const asked = await rpc(run, W, "ask", ASK);
  expect(asked).toMatchObject({ ok: true, result: { to: L, state: "open" } });
  const qid = asked.result.asked;
  // The recommended one first, no repeats.
  expect((await s.getQuestion({ questionId: qid }))!.options).toEqual(["100 req/min", "500 req/min"]);
  expect((await rpc(run, W, "ask", { ...ASK, question: "Another?" })).error.message).toMatch(/already asked/);
  // Its parent, not idle, was told in its mailbox (it waited on nothing).
  expect((await s.inbox({ agentId: L })).at(-1)).toMatchObject({ from: W });
  expect((await s.inbox({ agentId: L })).at(-1)!.body).toContain(`${W} asked you a question (${qid})`);
  // Only an ancestor may answer it: not the asker, not a sibling's subtree.
  const { LEAF_OPS } = await import("../../src/subagents/token");
  expect((await rpc(run, W, "answer", { question: qid, answer: "x" }, [...LEAF_OPS])).error.message).toMatch(/not in your token/);
  expect((await rpc(run, W, "answer", { question: qid, answer: "x" })).error.message).toMatch(/outside your subtree/);
  // Passing up is the addressee's (L's) alone; the grandparent may answer it all the same.
  expect((await rpc(run, P, "answer", { question: qid, up: true })).error.message).toMatch(/isn't yours to pass up/);
  const byP = await rpc(run, P, "answer", { agent: W, recommended: true });
  expect(byP).toMatchObject({ ok: true, result: { answered: qid, answer: "100 req/min", recommended: true } });
  // A person's answer replaces it; then no agent can answer.
  const user = await s.answerQuestion({ questionId: qid, by: "client:desk", answer: "500 req/min", note: "big client" });
  expect(user.question).toMatchObject({ state: "answered", answeredBy: "client:desk", answer: "500 req/min" });
  expect((await s.inbox({ agentId: W })).at(-1)!.body).toContain(`Answer to your question ${qid} from the user (it replaces ${P}'s answer: go by this one): 500 req/min`);
  const ans = (await events(run, "AGENT_ANSWERED")).filter((e) => e.data.questionId === qid);
  expect(ans.map((e) => [e.data.by, e.data.replaces, e.data.recommended])).toEqual([[P, null, true], ["client:desk", P, false]]);
  expect((await rpc(run, L, "answer", { question: qid, answer: "100 req/min" })).error.code).toBe("conflict");
  expect((await s.getAgent({ agentId: W }))!.asked).toBeNull();
  // L asks P; a message from L's own child W to L is just a message, not its answer.
  const lq = (await rpc(run, L, "ask", { question: "Merge now?", recommend: "yes" })).result.asked;
  await s.sendMessage({ to: L, from: W, body: "done with my part" });
  expect((await s.getQuestion({ questionId: lq }))!.state).toBe("open");
  await s.sendMessage({ to: L, from: P, body: "yes, merge it" });
  expect(await s.getQuestion({ questionId: lq })).toMatchObject({ state: "answered", answeredBy: P, answer: "yes, merge it" });
}, 60_000);

test("a blocking await returns on a question; a cancelled agent's question is withdrawn", async () => {
  const run = await newRun();
  const s = await scope(run);
  const { L, W } = await tree(run);
  expect((await rpc(run, L, "await", { agents: [W] })).result.asked).toBeUndefined();
  // The host's await (a driver's capcomd_await) returns on a question asked while it waits.
  const host = (await O()).awaitAgents(run, [W], { timeoutMs: 30_000, notices: true });
  await Bun.sleep(500);
  const qid = (await rpc(run, W, "ask", ASK)).result.asked;
  expect((await host as any).asked).toEqual([{ agentId: W, questionId: qid, question: "Which limit?" }]);
  // The in-VM await sees it too (its client returns on a new one).
  const r = await rpc(run, L, "await", { agents: [W] });
  expect(r.result).toMatchObject({ done: false, asked: [{ agentId: W, questionId: qid }] });
  expect(JSON.stringify(r.result.asked[0].question)).toContain("Which limit?");
  await (await O()).cancelAgents(run, W, "test");
  expect(await s.getQuestion({ questionId: qid })).toMatchObject({ state: "withdrawn" });
  expect((await events(run, "AGENT_QUESTION_WITHDRAWN"))[0]).toMatchObject({ agentId: W, data: { questionId: qid, reason: "cancelled" } });
  expect(await rivetSource().approvals(run)).toEqual([]);
  expect((await s.answerQuestion({ questionId: qid, by: "client:x", answer: "late" }).catch((e: any) => e)).message).toMatch(/withdrawn/);
}, 60_000);

test("the thread is the record: a fresh client reads each question and what became of it from GET …/thread alone", async () => {
  const run = await newRun();
  const s = await scope(run);
  const { P, L, W } = await tree(run);
  // A client that saw none of it live: a new app on the same daemon, reading only the thread routes.
  const fresh = harnessApp({ source: rivetSource(), clients: () => loadClients(join(dir, "clients.json")), state: harnessState(null), pollMs: 100 });
  const read = async (agent: string, tail = false) => {
    const res = await fresh.request(`/v1/runs/${run}/agents/${agent}/thread${tail ? "/tail" : ""}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    return ((await res.json()) as any).items.filter((i: any) => i.kind === "question");
  };
  // W asks L: one open question item in W's thread, its card's parts on it; L's thread has the same question, placed
  // when it was asked, saying who asked.
  const qid = (await rpc(run, W, "ask", ASK)).result.asked;
  let [it] = await read(W);
  expect(it).toMatchObject({ id: `itm-${W}-question-${qid}`, rev: 1, agentId: W, kind: "question", status: "done", format: "blocks/1",
    text: "Asked: Which limit? · recommended: 100 req/min",
    question: { questionId: qid, asker: W, state: "open", question: "Which limit?", to: L, passedBy: [], why: "the docs", holds: "tests",
      options: [{ label: "100 req/min", recommended: true }, { label: "500 req/min", recommended: false }], answer: null, recommended: null, by: null, decidedAt: null } });
  expect(it.internal).toBe(false);
  let [atL] = await read(L);
  expect(atL).toMatchObject({ id: `itm-${L}-asked-${qid}`, rev: 1, agentId: L, kind: "question", text: `${W} asked: Which limit? · recommended: 100 req/min`,
    question: { questionId: qid, asker: W, state: "open", to: L, passedBy: [], why: "the docs", holds: "tests" } });
  expect(atL.at).toBe(it.question.askedAt);
  expect(await read(P)).toEqual([]);
  // The message that delivered it to L is bookkeeping (the item shows it): marked internal, never a thread item; the
  // question item is not bookkeeping, with or without internal=true.
  const get = async (path: string) => { const res = await fresh.request(path, { headers: { authorization: `Bearer ${token}` } }); expect(res.status).toBe(200); return (await res.json()) as any; };
  const messages = async () => (await get(`/v1/runs/${run}/messages`)) as any[];
  const delivered = (await messages()).filter((m) => m.to === L && m.from === W);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ internal: true });
  expect(delivered[0].text).toContain(qid);
  for (const q of ["", "?internal=true"]) {
    const items = (await get(`/v1/runs/${run}/agents/${L}/thread${q}`)).items as any[];
    expect(items.filter((i) => i.kind === "question")).toMatchObject([{ id: `itm-${L}-asked-${qid}`, internal: false }]);
    expect(items.some((i) => String(i.text).includes("asked you a question"))).toBe(false);
  }
  // Passed up by L: the same items, a new rev, asked of P now; P's thread has it from now on.
  expect(await rpc(run, L, "answer", { question: qid, up: true })).toMatchObject({ ok: true });
  [it] = await read(W);
  expect(it).toMatchObject({ rev: 2, question: { state: "open", to: P, passedBy: [L] } });
  [atL] = await read(L);
  expect(atL).toMatchObject({ rev: 2, question: { state: "open", to: P, passedBy: [L] } });
  expect(atL.at).toBe(it.question.askedAt);   // still where it was asked
  let [atP] = await read(P);
  expect(atP).toMatchObject({ id: `itm-${P}-asked-${qid}`, rev: 1, agentId: P, question: { asker: W, state: "open", to: P, passedBy: [L] } });
  expect(Date.parse(atP.at)).toBeGreaterThanOrEqual(Date.parse(it.question.askedAt));
  // P answers, not the recommendation, with a note: one state in every thread that has it, one item per thread.
  expect(await rpc(run, P, "answer", { question: qid, answer: "500 req/min", note: "our biggest client does 300" })).toMatchObject({ ok: true, result: { recommended: false } });
  [it] = await read(W);
  expect(it).toMatchObject({ rev: 3, text: "Asked: Which limit? · answered: 500 req/min (not the recommendation) · note: our biggest client does 300",
    question: { state: "answered", answer: "500 req/min", recommended: false, by: P, note: "our biggest client does 300", replaces: null, reason: null } });
  expect(Date.parse(it.question.decidedAt)).toBeGreaterThanOrEqual(Date.parse(it.question.askedAt));
  for (const [agent, rev] of [[L, 3], [P, 2]] as const) {
    const items = await read(agent);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ id: `itm-${agent}-asked-${qid}`, rev, question: { asker: W, state: "answered", answer: "500 req/min", by: P, recommended: false } });
  }
  // The user's answer replaces P's: every thread says so at once. The tail serves the same.
  await s.answerQuestion({ questionId: qid, by: "client:desk", answer: "100 req/min" });
  [it] = await read(W, true);
  expect(it).toMatchObject({ rev: 4, question: { state: "answered", answer: "100 req/min", recommended: true, by: "client:desk", note: null, replaces: P } });
  [atP] = await read(P, true);
  expect(atP).toMatchObject({ rev: 3, question: { state: "answered", answer: "100 req/min", by: "client:desk", replaces: P } });
  expect((await read(L))[0]).toMatchObject({ rev: 4, question: { state: "answered", by: "client:desk" } });
  // Passed all the way up to the user: the root's thread (P's, the one the user reads) has it, asked of nobody now.
  const q2 = (await rpc(run, W, "ask", { question: "Second?", recommend: "a" })).result.asked;
  expect(await rpc(run, L, "answer", { question: q2, up: true })).toMatchObject({ ok: true });
  expect(await rpc(run, P, "answer", { question: q2, up: true })).toMatchObject({ ok: true });
  const of = async (agent: string, q: string) => (await read(agent)).filter((i: any) => i.question.questionId === q);
  for (const agent of [L, P]) expect(await of(agent, q2)).toMatchObject([{ id: `itm-${agent}-asked-${q2}`, question: { state: "open", to: null, passedBy: [L, P] } }]);
  expect(await of(W, q2)).toMatchObject([{ question: { to: null } }]);
  await s.answerQuestion({ questionId: q2, by: "client:desk", recommended: true });
  expect(await of(P, q2)).toMatchObject([{ question: { state: "answered", by: "client:desk", answer: "a" } }]);
  // L asks P, then L is cancelled: its question reads as withdrawn, not gone, in its thread and in P's.
  const lq = (await rpc(run, L, "ask", { question: "Merge now?", recommend: "yes" })).result.asked;
  await (await O()).cancelAgents(run, L, "test");
  const [w] = await of(L, lq);
  expect(w).toMatchObject({ id: `itm-${L}-question-${lq}`, rev: 2, text: "Asked: Merge now? · withdrawn: its agent was cancelled",
    question: { questionId: lq, state: "withdrawn", reason: "cancelled", answer: null, by: null } });
  expect(w.question.decidedAt).not.toBeNull();
  expect(await of(P, lq)).toMatchObject([{ id: `itm-${P}-asked-${lq}`, rev: 2, text: `${L} asked: Merge now? · withdrawn: its agent was cancelled`, question: { state: "withdrawn" } }]);
  // Every message capcomd wrote to carry a question or its answer is bookkeeping; a plain message stays as it was.
  await s.sendMessage({ to: L, from: "operator", body: "plain words" });
  const all = await messages();
  const carried = all.filter((m) => [qid, q2, lq].some((q) => String(m.text).includes(q)));
  expect(carried.length).toBeGreaterThanOrEqual(6);   // delivered to L, P (passed), and the answers worded by capcomd
  expect(carried.every((m) => m.internal === true)).toBe(true);
  expect(all.find((m) => m.text === "plain words")?.internal).toBeUndefined();
  // A conversation rebuilt from the thread keeps the decision (it isn't bookkeeping).
  const { threadPrompt } = await import("../../src/agents/continue");
  const c = (await s.continuation({ agentId: W }))!;
  const prompt = threadPrompt({ agentId: W, branch: "b", target: "main" }, { ...c, messages: [] } as any);
  expect(prompt).toContain("you asked: Which limit? (you recommended: 100 req/min); the user answered: 100 req/min");
  expect(threadPrompt({ agentId: P, branch: "b", target: "main" }, { ...(await s.continuation({ agentId: P }))!, messages: [] } as any))
    .toContain(`${W} asked you: Which limit? (they recommended: 100 req/min); the user answered: 100 req/min (it replaced your answer)`);
  expect(threadPrompt({ agentId: L, branch: "b", target: "main" }, { ...(await s.continuation({ agentId: L }))!, messages: [] } as any))
    .toContain(`${W} asked you: Which limit? (they recommended: 100 req/min); the user answered: 100 req/min`);
  expect(threadPrompt({ agentId: L, branch: "b", target: "main" }, { ...(await s.continuation({ agentId: L }))!, messages: [] } as any))
    .toContain("you asked: Merge now? (you recommended: yes); the question was withdrawn");
}, 60_000);
