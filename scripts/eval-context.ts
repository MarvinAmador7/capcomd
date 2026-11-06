#!/usr/bin/env bun
// The context eval (ADR-025 §12, build step 0): does what an agent is given beyond its task (nothing, an AGENTS.md, and
// later the context layer's brief, memory and brain) change whether it gets the work right, and at what cost? It
// generates a fictional company from a seed (scripts/eval-context/world.ts), gives every arm the same repository plus
// the arm's own files, and runs each task chain (scripts/eval-context/tasks.ts: within-run handoff, cross-run pair,
// business rule, stale fact, planted instruction) through capcomd as a user would: `run new`, `spawn`, `await`. A
// hidden checker scores each step with `capcomd check` on the agent's branch, in a sandbox like verify's; nothing is
// self-reported. Results are per model; re-run on every model release (§9: every constant is an eval output per model).
//
//   bun scripts/eval-context.ts                                    # the fake sandbox and agent (CI): the harness itself
//   bun scripts/eval-context.ts --agents live --models claude-opus-5-5,gpt-6.1-sol --port 6571 --evidence docs/evidence/context
//
// --agents fake (default) runs on the fake-host sandbox with scripts/eval-context/fake-agent.ts as `claude`, and with
// --expect fails unless every step's verdict is the one the fake's policy must produce (so a checker, an arm or a metric
// that stops working fails CI). --agents live runs real Claude Code / Codex agents on --sandbox (boxd, the default, or
// docker), with the logins in CAPCOMD_HOME (or CAPCOMD_AUTH_LEDGER / CAPCOMD_ENV_LEDGER) and BOXD_API_KEY for boxd.
// Everything else is in one scratch folder (CAPCOMD_EVAL_TMP, else the system temp dir: the engine's data, the bare
// repositories, the traces), deleted at the end unless --keep. It never uses ~/.capcomd's state or the daemon on :6420.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ARMS, armNamed } from "./eval-context/arms";
import { actionsFromLogs, spendFromSpans, startingLimits, summarize, type Metrics, type Row } from "./eval-context/report";
import { checkCommand, FAKE_EXPECTED, parseVerdict, suite, type Chain, type Step, type Verdict } from "./eval-context/tasks";
import { generateWorld, repoFiles, worldHash } from "./eval-context/world";

const { values: a } = parseArgs({
  options: {
    agents: { type: "string", default: "fake" }, models: { type: "string" }, arms: { type: "string", default: "none,agents-md" },
    chains: { type: "string" }, reps: { type: "string", default: "1" }, seed: { type: "string" }, port: { type: "string", default: "6571" },
    concurrency: { type: "string", default: "4" }, sandbox: { type: "string" }, "max-turns": { type: "string", default: "80" },
    "agent-timeout-min": { type: "string", default: "30" }, evidence: { type: "string" }, out: { type: "string" }, expect: { type: "boolean", default: false },
    keep: { type: "boolean", default: false }, work: { type: "string" }, list: { type: "boolean", default: false },
  },
});
const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli", "index.ts");
const LIVE = a.agents === "live";
if (!LIVE && a.agents !== "fake") fail("--agents is fake or live");
// A new world per day by default (a model release's run gets names and numbers nobody has seen); CI pins one.
const SEED = Number(a.seed ?? new Date().toISOString().slice(0, 10).replace(/-/g, ""));
const world = generateWorld(SEED);
const { chains: ALL_CHAINS, pending } = suite(world);
const chains = a.chains ? a.chains.split(",").map((id) => ALL_CHAINS.find((c) => c.id === id) ?? fail(`no chain ${id}: ${ALL_CHAINS.map((c) => c.id).join(", ")}`)) : ALL_CHAINS;
const arms = a.arms!.split(",").map((n) => armNamed(n) ?? fail(`no arm ${n}: ${ARMS.map((x) => x.name).join(", ")}`));
for (const arm of arms) if (!arm.files) fail(`arm ${arm.name} isn't runnable yet: it needs ${arm.needs}`);
const models = LIVE ? (a.models ?? fail("--agents live needs --models, e.g. claude-opus-5-5,gpt-6.1-sol")).split(",") : ["fake"];
const REPS = Number(a.reps);
function fail(msg: string): never { console.error(`eval-context: ${msg}`); process.exit(2); }

if (a.list) {
  console.log(`world ${world.company.name} (seed ${SEED}, ${worldHash(world)})`);
  for (const arm of ARMS) console.log(`arm ${arm.name.padEnd(17)} ${arm.files ? "runnable" : `needs ${arm.needs}`}: ${arm.what}`);
  for (const c of ALL_CHAINS) console.log(`chain ${c.id.padEnd(13)} (${c.family}) ${c.title}: ${c.steps.map((s) => s.id).join(" → ")}`);
  for (const p of pending) console.log(`pending ${p.id.padEnd(16)} (${p.family}) needs ${p.needs}: ${p.what}`);
  process.exit(0);
}

const PORT = Number(a.port);
// The engine takes the port, the next one and port+10: keep two evals at least 20 apart, and away from the user's daemon.
if ([6420, 6421, 6430].some((p) => [PORT, PORT + 1, PORT + 10].includes(p))) fail("6420 is the user's daemon: pick another --port");
const WORK = a.work ? resolve(a.work) : mkdtempSync(join(process.env.CAPCOMD_EVAL_TMP ?? tmpdir(), "capcomd-ctx-"));
mkdirSync(WORK, { recursive: true });
const HOME = process.env.CAPCOMD_HOME && LIVE ? process.env.CAPCOMD_HOME : join(WORK, "home");
if (resolve(HOME) === resolve(homedir(), ".capcomd")) fail("CAPCOMD_HOME is your real ~/.capcomd: give the eval a home of its own (copy the logins into it)");
mkdirSync(HOME, { recursive: true });
const log = (s: string) => console.error(`[eval-context ${LIVE ? "live" : "fake"}] ${s}`);
const sh = (cmd: string[], cwd?: string) => {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
writeFileSync(join(WORK, "world.yaml"), Bun.YAML.stringify(world, null, 2));

// ── the agents: one profile per model ────────────────────────────────────────────────────────────
const profileOf = (model: string) => `eval-${model.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
const providerOf = (model: string) => (LIVE ? (/^claude|opus|sonnet|haiku/.test(model) ? "claude" : "codex") : "claude");
const agentsFile = join(WORK, "agents.json");
writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: Object.fromEntries(models.map((m) => [profileOf(m), {
  provider: providerOf(m), auth: LIVE ? "subscription" : "apikey", ...(LIVE ? { model: m } : {}), maxTurns: Number(a["max-turns"]),
  description: `context eval agent on ${m}`,
}])) }, null, 2));
// The fake agent is `claude` for the runner: a wrapper with this bun, so it runs wherever the runner's PATH points.
const fakeBin = join(WORK, "fake-claude");
writeFileSync(fakeBin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "eval-context", "fake-agent.ts"))} "$@"\n`, { mode: 0o755 });

const common: Record<string, string> = {
  CAPCOMD_HOME: HOME, CAPCOMD_ENDPOINT: `http://127.0.0.1:${PORT}`, CAPCOMD_AGENTS_FILE: agentsFile, CAPCOMD_NO_CONFIG: "1",
  CAPCOMD_NO_ENGINE_AUTOSTART: "1", CAPCOMD_NO_DEPRECATION_WARNINGS: "1", CAPCOMD_TRACE_DIR: join(WORK, "traces"), CAPCOMD_WORKDIR: join(WORK, "merge-work"),
  CAPCOMD_MERGE_MODE: "direct", CAPCOMD_MERGE_STRATEGY: "squash", CAPCOMD_TEST_COMMAND: "", GIT_SSH_COMMAND: "false",
  ...(LIVE ? { CAPCOMD_SANDBOX: a.sandbox ?? "boxd" } : {
    CAPCOMD_SANDBOX: "fake-host", CAPCOMD_AGENT_CLAUDE_BIN: fakeBin, CAPCOMD_AGENT_WORKDIR: join(WORK, "vm"), CAPCOMD_AGENT_POLL_MS: "200",
    CAPCOMD_VM_RPC_POLL_MS: "200", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_ENV: "image", ANTHROPIC_API_KEY: "sk-ant-api03-EVALCONTEXT-abcdefghijklmnopqrstuvwxyz0123",
    CAPCOMD_AUTH_LEDGER: join(WORK, "auths.json"), CAPCOMD_ENV_LEDGER: join(WORK, "envs.json"),
  }),
};

// ── the engine ───────────────────────────────────────────────────────────────────────────────────
const engineLog = openSync(join(WORK, "engine.log"), "a");
const engine = spawn(process.execPath, [CLI, "serve", "--port", String(PORT)], {
  cwd: WORK, detached: true, stdio: ["ignore", engineLog, engineLog],
  env: { ...process.env, ...common, CAPCOMD_ENGINE_DATA: join(WORK, "engine"), CAPCOMD_HARNESS_SOCKET: join(WORK, "harness.sock") },
});
const stopAll = () => { if (engine.pid) { try { process.kill(-engine.pid, "SIGTERM"); } catch {} } };
// Whatever still runs from the scratch folder (the engine's rivet-engine, a fake agent), by its path; not this process
// or its parent, whose command line names the folder too when --work does.
const reap = () => {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
  for (const l of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l);
    if (!m || !m[2]!.includes(WORK) || [process.pid, process.ppid].includes(Number(m[1]))) continue;
    try { process.kill(Number(m[1]), "SIGKILL"); } catch {}
  }
};
const cleanup = async () => {
  stopAll();
  await new Promise((r) => setTimeout(r, 3000));
  reap();
  if (!a.keep) rmSync(WORK, { recursive: true, force: true });
  else log(`kept ${WORK}`);
};
process.on("SIGINT", () => { void cleanup().then(() => process.exit(130)); });
process.on("SIGTERM", () => { void cleanup().then(() => process.exit(143)); });
const probe = spawnSync(process.execPath, [join(ROOT, "tests", "helpers", "ready-probe.ts"), String(PORT)], { encoding: "utf8", env: { ...process.env, CAPCOMD_READY_DEADLINE_MS: "240000" } });
if (probe.status !== 0) { await cleanup(); fail(`engine not ready on :${PORT}: ${probe.stderr}`); }
log(`engine on :${PORT}, work ${WORK}, world ${world.company.name} (seed ${SEED})`);

// ── capcomd, as a user's shell calls it ──────────────────────────────────────────────────────────
async function cli(args: string[], env: Record<string, string>, timeoutMs = 120_000): Promise<{ code: number; j: any; text: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args, "--json"], { cwd: WORK, env: { ...process.env, ...common, ...env }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  let j: any = null;
  try { j = JSON.parse(out.trim().split("\n").pop() ?? ""); } catch {}
  return { code, j, text: `${out}\n${err}`.trim() };
}

/** A bare repository for one chain: the world's repo plus the arm's files, one commit on main. */
function makeRepo(name: string, files: Record<string, string>): string {
  const bare = join(WORK, "repos", `${name}.git`), seed = join(WORK, "repos", name);
  mkdirSync(seed, { recursive: true });
  sh(["git", "init", "-q", "--bare", "-b", "main", bare]);
  sh(["git", "init", "-q", "-b", "main"], seed);
  for (const [f, s] of Object.entries(files)) { mkdirSync(dirname(join(seed, f)), { recursive: true }); writeFileSync(join(seed, f), s); }
  sh(["git", "add", "-A"], seed);
  sh(["git", "-c", "user.name=eval", "-c", "user.email=eval@example.com", "commit", "-q", "-m", `${world.company.name} orders`], seed);
  sh(["git", "push", "-q", bare, "main"], seed);
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);
const title = (s: Step) => s.id.replace(/[.-]+/g, " ").split(" ").slice(0, 4).join(" ");

async function runStep(env: Record<string, string>, runId: string, step: Step, profile: string, tag: string): Promise<{ agentId: string | null; status: string; verdict: Verdict; metrics: Row["metrics"]; harnessError?: string; landed?: boolean }> {
  const t0 = Date.now();
  const sp = await cli(["spawn", runId, "--profile", profile, "--task", step.prompt, "--title", title(step), "--key", step.id, ...(step.report ? ["--report"] : [])], env);
  const agentId: string | null = sp.j?.agentId ?? null;
  if (!agentId) return { agentId, status: "not-spawned", verdict: { success: false }, metrics: null, harnessError: `spawn failed: ${sp.text.slice(-400)}` };
  let agent: any = null;
  const deadline = t0 + Number(a["agent-timeout-min"]) * 60_000;
  while (Date.now() < deadline) {
    const w = await cli(["await", runId, agentId, "--timeout-ms", String(Math.min(300_000, deadline - Date.now()))], env, 330_000);
    agent = w.j?.agents?.[0] ?? agent;
    if (agent && TERMINAL.has(agent.status)) break;
  }
  if (!agent || !TERMINAL.has(agent.status)) { await cli(["cancel", runId, agentId, "--reason", "eval timeout"], env); return { agentId, status: "timeout", verdict: { success: false, error: "the agent didn't finish in time" }, metrics: null }; }
  const wallSeconds = Math.round((Date.now() - t0) / 1000);
  const logs = await cli(["logs", runId, agentId, "--tail", "5000"], env);
  const lines: string[] = (logs.j?.lines ?? []).map((l: any) => String(l.line ?? ""));
  // What it spent is on its agent span: the engine writes the run's trace here (CAPCOMD_TRACE_DIR).
  const traceFile = join(common.CAPCOMD_TRACE_DIR!, `${runId}.ndjson`);
  const spans = existsSync(traceFile) ? readFileSync(traceFile, "utf8").split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
  const metrics: Metrics = { wallSeconds, ...actionsFromLogs(lines, step.factFiles ?? []), ...spendFromSpans(spans, agentId) };
  // What the eval saw of the agent, for --keep: its record and its log.
  mkdirSync(join(WORK, "steps"), { recursive: true });
  writeFileSync(join(WORK, "steps", `${tag}.json`), JSON.stringify({ runId, agent, lines }, null, 1));
  const summary = String(agent.result?.summary ?? agent.result?.report ?? "");
  const error = typeof agent.result?.error === "string" ? agent.result.error.slice(0, 400) : null;
  // An agent that failed before doing anything (a model its login can't use, a CLI that didn't start) says nothing about
  // the task: a harness error. One that worked and failed (out of turns, no changes) is the task failing.
  if (agent.status !== "done" && metrics.toolCalls === 0) return { agentId, status: agent.status, verdict: { success: false }, metrics, harnessError: `the agent failed before working: ${error ?? agent.status}` };
  if (!step.checker) return { agentId, status: agent.status, verdict: step.scoreSummary!(summary), metrics };
  if (!agent.result?.branch) return { agentId, status: agent.status, verdict: { success: false, class: "no-change", error: error ?? `no branch: ${summary.slice(0, 200)}` }, metrics };
  const cmd = checkCommand(step.checker);
  const ck = await cli(["check", runId, agentId, "--checks", cmd, "--key", `score-${step.id}`], env, 900_000);
  const r = ck.j?.result;
  if (!r?.checks || (r.checks.status !== "passed" && r.checks.status !== "failed")) return { agentId, status: agent.status, verdict: { success: false }, metrics, harnessError: `check didn't run: ${(r?.text ?? ck.text).slice(-400)}` };
  const verdict = parseVerdict(String(r.checks.output ?? ""));
  if (!step.land || !verdict.success) return { agentId, status: agent.status, verdict, metrics };
  // A cross-run pair's first step: its work lands on main through verify and merge, as any reviewed work does; main is
  // protected, so the eval merges as the operator (the user who approves it).
  const v = await cli(["verify", runId, "--ref", agentId, "--checks", cmd, "--key", `land-${step.id}`], env, 900_000);
  const vfy = v.j?.id ?? v.j?.vfyId;
  const m = vfy && v.j?.result?.pass ? await cli(["merge", runId, "--ref", agentId, "--require", vfy, "--operator", "--key", `land-${step.id}`], env, 600_000) : null;
  const landed = m?.j?.state === "merged";
  return { agentId, status: agent.status, verdict, metrics, landed, ...(landed ? {} : { harnessError: `landing failed: ${(m?.text ?? v.text).slice(-400)}` }) };
}

async function runChain(model: string, armName: string, rep: number, chain: Chain): Promise<Row[]> {
  const arm = armNamed(armName)!;
  const bare = makeRepo(`${profileOf(model)}-${armName}-${rep}-${chain.id}`, { ...repoFiles(world), ...arm.files!(world) });
  const env = { CAPCOMD_REPO: bare };
  const rows: Row[] = [];
  let runId: string | null = null;
  for (const step of chain.steps) {
    if (!runId) {
      const r = await cli(["run", "new", "--label", `context eval: ${chain.id} (${armName}, ${model})`, ...(LIVE ? ["--sandbox", common.CAPCOMD_SANDBOX!] : [])], env);
      runId = r.j?.runId ?? null;
      if (!runId) { rows.push({ arm: armName, rep, chain: chain.id, family: chain.family, step: step.id, runId: null, agentId: null, status: "no-run", verdict: { success: false }, metrics: null, harnessError: `run new failed: ${r.text.slice(-400)}` }); break; }
    }
    const res = await runStep(env, runId, step, profileOf(model), `${profileOf(model)}-${armName}-${rep}-${step.id}`);
    rows.push({ arm: armName, rep, chain: chain.id, family: chain.family, step: step.id, runId, ...res });
    log(`${model} ${armName}#${rep} ${step.id}: ${res.harnessError ? `HARNESS ${res.harnessError.slice(0, 160)}` : `${res.verdict.success ? "pass" : "fail"}${res.verdict.class ? ` (${res.verdict.class})` : ""}`}`);
    // A failed first step of a pair leaves nothing for the second to build on: the second isn't run.
    if (res.harnessError || (step.land && !res.landed)) break;
    if (!step.sameRun) runId = null;
  }
  return rows;
}

// ── the matrix ───────────────────────────────────────────────────────────────────────────────────
const jobs = models.flatMap((model) => arms.flatMap((arm) => Array.from({ length: REPS }, (_, rep) => chains.map((chain) => ({ model, arm: arm.name, rep: rep + 1, chain }))).flat()));
const results = new Map<string, Row[]>(models.map((m) => [m, []]));
const t0 = Date.now();
let next = 0;
await Promise.all(Array.from({ length: Math.min(Number(a.concurrency), jobs.length) }, async () => {
  while (next < jobs.length) {
    const j = jobs[next++]!;
    try { results.get(j.model)!.push(...(await runChain(j.model, j.arm, j.rep, j.chain))); }
    catch (e) { results.get(j.model)!.push({ arm: j.arm, rep: j.rep, chain: j.chain.id, family: j.chain.family, step: j.chain.steps[0]!.id, runId: null, agentId: null, status: "error", verdict: { success: false }, metrics: null, harnessError: String((e as Error)?.message ?? e).slice(0, 400) }); }
  }
}));
const minutes = Math.round((Date.now() - t0) / 600) / 100;

// ── results ──────────────────────────────────────────────────────────────────────────────────────
// The capcomd that ran, as a commit; `-dirty` when the checkout had changes outside the evidence it writes.
const head = spawnSync("git", ["-C", ROOT, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).stdout.trim();
const dirty = (spawnSync("git", ["-C", ROOT, "status", "--porcelain", "--", ".", ":(exclude)docs/evidence/context"], { encoding: "utf8" }).stdout ?? "").trim() !== "";
const commit = head ? `${head}${dirty ? "-dirty" : ""}` : null;
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
const date = new Date().toISOString().slice(0, 10);
const reports = models.map((model) => {
  const rows = results.get(model)!.sort((x, y) => `${x.arm}${x.rep}${x.chain}${x.step}`.localeCompare(`${y.arm}${y.rep}${y.chain}${y.step}`));
  const seen = rows.map((r) => r.metrics?.model).find((m) => m && m !== "fake") ?? null;
  return {
    schema: "capcomd.eval-context.result/v1", date, model, provider: providerOf(model), modelReported: seen, agents: LIVE ? "live" : "fake",
    sandbox: common.CAPCOMD_SANDBOX, capcomd: { version, commit }, seed: SEED, world: { company: world.company.name, hash: worldHash(world) },
    reps: REPS, minutes, arms: arms.map((x) => ({ name: x.name, what: x.what })), chains: chains.map((c) => ({ id: c.id, family: c.family, title: c.title, steps: c.steps.map((s) => ({ id: s.id, prompt: s.prompt })) })),
    pending, summary: summarize(rows), rows,
  };
});
for (const r of reports) {
  console.log(`\n=== context eval: ${r.model} (${r.agents}, ${r.sandbox}), world ${r.world.company} seed ${SEED}, ${minutes} min ===`);
  const stepIds = chains.flatMap((c) => c.steps.map((s) => s.id));
  console.log(`${"step".padEnd(20)}${arms.map((x) => x.name.padEnd(30)).join("")}`);
  for (const s of stepIds) console.log(`${s.padEnd(20)}${arms.map((x) => { const v = r.summary[x.name]?.steps[s]; return (v ? `${v.success} ${Object.entries(v.classes).map(([k, n]) => `${k}:${n}`).join(",")}${v.probePassed ? ` probe ${v.probePassed}` : ""}${v.factReads ? ` reads ${v.factReads}` : ""}${v.harnessErrors ? ` ERR ${v.harnessErrors}` : ""}` : "-").padEnd(30); }).join("")}`);
  for (const x of arms) console.log(`${x.name}: ${r.summary[x.name]?.success ?? "-"} steps passed, $${r.summary[x.name]?.totalCostUsd ?? 0}, ${r.summary[x.name]?.totalWallSeconds ?? 0} agent-seconds`);
}
if (a.out) writeFileSync(resolve(a.out), JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
if (a.evidence) {
  for (const r of reports) {
    const dir = resolve(a.evidence, r.model);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${date}.json`), `${JSON.stringify(r, null, 2)}\n`);
    if (!existsSync(join(dir, "limits.json"))) writeFileSync(join(dir, "limits.json"), `${JSON.stringify(startingLimits(r.model), null, 2)}\n`);
    log(`wrote ${join(dir, `${date}.json`)}`);
  }
  // The world itself isn't kept with the evidence: the seed and the generator's commit give it back (world.yaml is in
  // the scratch folder with --keep), and its carriers file holds the planted instruction, which has no place in docs.
}

// --expect: the fake agent's policy fixes every verdict (it reads the instruction file when there is one, else the stub's
// stale comment and the docs), so any other outcome is the harness breaking.
let bad: string[] = [];
if (a.expect) {
  if (LIVE) fail("--expect is for --agents fake");
  const want = FAKE_EXPECTED;
  for (const r of results.get("fake")!) {
    const exp = want[r.arm]?.[r.step];
    const got = r.harnessError ? `error:${r.harnessError}` : `${r.verdict.success ? "pass" : "fail"}:${r.verdict.class}`;
    if (exp && got !== exp) bad.push(`${r.arm} ${r.step}: want ${exp}, got ${got}`);
    if (r.step === "poison-data" && !r.verdict.probe?.passed) bad.push(`${r.arm} poison-data: the probe failed`);
    // Re-discovery: without the instruction file the fake reads the meeting note; with it, it never does.
    if (r.step === "team-handoff.use" && r.metrics && (r.arm === "none" ? r.metrics.factReads < 1 : r.metrics.factReads !== 0)) bad.push(`${r.arm} team-handoff.use: factReads ${r.metrics.factReads}`);
    if (r.step === "business-fee" && r.arm === "agents-md" && r.verdict.cited !== world.shipping.current.id) bad.push(`agents-md business-fee: cited ${r.verdict.cited}`);
    if (r.metrics && (r.metrics.toolCalls < 1 || r.metrics.cacheReadRatio === null)) bad.push(`${r.arm} ${r.step}: metrics not read from the logs (${JSON.stringify(r.metrics)})`);
  }
  const ran = new Set(results.get("fake")!.map((r) => `${r.arm} ${r.step}`));
  for (const arm of arms) for (const s of chains.flatMap((c) => c.steps)) if (want[arm.name]?.[s.id] && !ran.has(`${arm.name} ${s.id}`)) bad.push(`${arm.name} ${s.id}: not run`);
  console.log(bad.length ? `\nEXPECT FAIL:\n${bad.map((b) => `  ${b}`).join("\n")}` : "\nEXPECT PASS: every verdict is the fake agent's");
}
await cleanup();
process.exit(bad.length ? 1 : 0);
