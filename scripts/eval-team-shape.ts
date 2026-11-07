#!/usr/bin/env bun
// The team-shape eval: a real Claude Code driver (`claude -p`) gets the tinycalc request and plans a team through
// capcomd; the agents it spawns are scripted fakes, so only the driver uses a model. Afterwards it prints the shape
// the driver chose: the tree, peak agents at once against the slots, the phases on the critical path, whether the
// consumers started against the stubs, the wall time and the driver's cost. See DEVELOPMENT.md, "Team-shape eval".
//
//   bun scripts/eval-team-shape.ts [--ref origin/main] [--model sonnet] [--port 6491] [--keep]
//
// --ref R runs capcomd as it is at git ref R (its skill, MCP server and `capcomd setup` profiles), extracted with
// `git archive` into the scratch folder; without it, this checkout. Everything lives in one scratch folder (engine
// data, CAPCOMD_HOME, the bare repo, the project, the plugin copy), deleted at the end unless --keep. It never uses
// ~/.capcomd, the daemon on :6420, Docker or the Claude Code config: the plugin is loaded with --plugin-dir (a copy
// with no MCP server of its own) and the server with --mcp-config --strict-mcp-config.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { reapUnder } from "./reap";

const { values: a } = parseArgs({
  options: {
    ref: { type: "string" }, model: { type: "string", default: "sonnet" }, port: { type: "string", default: "6491" },
    "worker-seconds": { type: "string", default: "45" }, "max-turns": { type: "string", default: "200" },
    "timeout-min": { type: "string", default: "35" }, slots: { type: "string", default: "7" },
    keep: { type: "boolean", default: false }, claude: { type: "string", default: process.env.CLAUDE_BIN ?? "claude" },
    work: { type: "string" }, out: { type: "string" }, analyze: { type: "string" },
  },
});
const ROOT = resolve(import.meta.dir, "..");
// --analyze DIR: print the report of a kept run (its session.ndjson, events.json and meta.json) without running one.
if (a.analyze) { report(resolve(a.analyze)); process.exit(0); }
const PORT = Number(a.port);
// The engine takes the port, the next one and port+10: keep two evals at least 20 apart.
if ([6420, 6421, 6430].some((p) => [PORT, PORT + 1, PORT + 10].includes(p))) throw new Error("6420 is the user's daemon: pick another --port");
// The folder is deleted at the end and whatever runs from it is killed: never one that holds anything already.
if (a.work && existsSync(a.work) && readdirSync(a.work).length) throw new Error(`--work ${a.work} isn't empty: the eval deletes its work folder at the end, so give it a new one`);
const WORK = a.work ? resolve(a.work) : mkdtempSync(join(process.env.CAPCOMD_EVAL_TMP ?? tmpdir(), "capcomd-eval-"));
mkdirSync(WORK, { recursive: true });
const log = (s: string) => console.error(`[eval ${a.ref ?? "checkout"}] ${s}`);
const sh = (cmd: string[], o: { cwd?: string; env?: Record<string, string> } = {}) => {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: o.cwd, env: { ...process.env, ...o.env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};

// ── 1. the capcomd under test ────────────────────────────────────────────────────────────────────
let TREE = ROOT;
if (a.ref) {
  TREE = join(WORK, "tree");
  mkdirSync(TREE);
  const tar = spawnSync("sh", ["-c", `git -C ${JSON.stringify(ROOT)} archive ${a.ref} | tar -x -C ${JSON.stringify(TREE)}`]);
  if (tar.status !== 0) throw new Error(`git archive ${a.ref} failed: ${tar.stderr}`);
  symlinkSync(join(ROOT, "node_modules"), join(TREE, "node_modules"));
}
const CLI = join(TREE, "src", "cli", "index.ts");
// The plugin as Claude Code loads it, minus its own MCP server (that would launch the installed capcomd).
const PLUGIN = join(WORK, "plugin", "capcomd");
cpSync(join(TREE, "plugins", "capcomd"), PLUGIN, { recursive: true });
const manifest = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8"));
delete manifest.mcpServers;
writeFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2));
rmSync(join(PLUGIN, "mcp"), { recursive: true, force: true });
rmSync(join(PLUGIN, ".codex-plugin"), { recursive: true, force: true });

// ── 2. the scripted agents ───────────────────────────────────────────────────────────────────────
const S = join(WORK, "scripts");
mkdirSync(S);
const W = Number(a["worker-seconds"]);
// A worker: works for a while, then its result names a file its (fake) commit adds.
writeFileSync(join(S, "worker.sh"), `#!/bin/sh
sleep ${W}
f="work/$CAPCOMD_AGENT_ID.md"
capcomd result --summary "Done: the task is implemented with tests; bun test and the typecheck pass." --data "{\\"file\\":{\\"path\\":\\"$f\\",\\"content\\":\\"placeholder for $CAPCOMD_AGENT_ID\\"}}" >/dev/null
`);
// A lead (any profile that may spawn): splits its part between two helpers, verifies and merges each, then reports.
writeFileSync(join(S, "lead.sh"), `#!/bin/sh
get() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];console.log(v??"")})' "$1"; }
sleep 5
ids=""
for n in 1 2; do
  for try in 1 2 3 4 5 6 7 8 9 10; do
    out=$(capcomd spawn --profile worker --task "Helper $n of 2 for: $CAPCOMD_TASK" --title "helper $n" --key h$n) && break
    [ -n "$ids" ] && capcomd wait-any $ids >/dev/null; sleep 2
  done
  ids="$ids $(echo "$out" | get agentId)"
done
capcomd await $ids >/dev/null
landed=0
for id in $ids; do
  v=$(capcomd verify --ref $id --key v-$id)
  if [ "$(echo "$v" | get result.pass)" = true ]; then capcomd merge --ref $id --require "$(echo "$v" | get id)" --key m-$id >/dev/null && landed=$((landed+1)); fi
done
capcomd result --summary "Lead: split the part between 2 helpers; $landed of 2 verified and merged." >/dev/null
`);
// The project's reviewer: reads for a few seconds, then passes.
writeFileSync(join(S, "reviewer.sh"), `#!/bin/sh
sleep 8
capcomd result --summary "Reviewed: correct, tested, nothing to change." --data '{"passed":true,"reasons":["does what the task asks, with tests"]}' >/dev/null
`);

// ── 3. the repository and the project ────────────────────────────────────────────────────────────
const BARE = join(WORK, "tinycalc.git");
const PROJECT = join(WORK, "tinycalc");
const HOME = join(WORK, "home");
mkdirSync(HOME);
sh(["git", "init", "-q", "--bare", "-b", "main", BARE]);
mkdirSync(PROJECT);
sh(["git", "init", "-q", "-b", "main"], { cwd: PROJECT });
writeFileSync(join(PROJECT, "README.md"), "# tinycalc\n");
mkdirSync(join(PROJECT, "test"));
writeFileSync(join(PROJECT, "test", "smoke.test.ts"), `import { expect, test } from "bun:test";\ntest("repo", () => expect(1 + 1).toBe(2));\n`);
sh(["git", "add", "."], { cwd: PROJECT });
sh(["git", "-c", "user.name=eval", "-c", "user.email=eval@example.com", "commit", "-q", "-m", "init"], { cwd: PROJECT });
sh(["git", "remote", "add", "origin", BARE], { cwd: PROJECT });
sh(["git", "push", "-q", "origin", "main", "main:dev"], { cwd: PROJECT });
sh(["git", "fetch", "-q", "origin"], { cwd: PROJECT });

const common: Record<string, string> = {
  CAPCOMD_HOME: HOME, CAPCOMD_ENDPOINT: `http://127.0.0.1:${PORT}`, CAPCOMD_SANDBOX: "fake", CAPCOMD_SPAWN_EXEC: "script",
  CAPCOMD_SCRIPT_WORKER: `sh ${join(S, "worker.sh")}`, CAPCOMD_SCRIPT_LEAD: `sh ${join(S, "lead.sh")}`, CAPCOMD_SCRIPT_PLANNER: `sh ${join(S, "lead.sh")}`,
  CAPCOMD_SCRIPT_REVIEWER: `sh ${join(S, "reviewer.sh")}`, CAPCOMD_SCRIPT_VM_DIR: join(WORK, "vms"), CAPCOMD_WORKDIR: join(WORK, "merge-work"),
  CAPCOMD_FAKE_MEMORY_MB: String(Number(a.slots) * 1024), CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_NO_ENGINE_AUTOSTART: "1",
  CAPCOMD_NO_DEPRECATION_WARNINGS: "1", GIT_SSH_COMMAND: "false",
};
// The project as `capcomd setup project` of this version writes it (its profiles are part of what's evaluated).
sh(["bun", CLI, "setup", "project", "--yes", "--mode", "direct", "--target", "dev", "--check", "bun test", "--agents", "claude", "--repo", BARE, "--json"], { cwd: PROJECT, env: common });
// Profile files since ADR-024 §7 step 9; an older --ref writes agents.json.
const profilesDir = join(PROJECT, ".capcomd", "profiles");
log(`profiles: ${(existsSync(profilesDir) ? readdirSync(profilesDir).map((f) => f.replace(/\.yaml$/, "")) : Object.keys(JSON.parse(readFileSync(join(PROJECT, ".capcomd", "agents.json"), "utf8")).agents)).join(", ")}`);

// ── 4. the engine ────────────────────────────────────────────────────────────────────────────────
// The engine's own log (its actors' errors with their real text) is kept with the run, for --keep.
const engineLog = openSync(join(WORK, "engine.log"), "a");
const engine = spawn("bun", [CLI, "serve", "--port", String(PORT)], {
  cwd: WORK, detached: true, stdio: ["ignore", engineLog, engineLog],
  // CAPCOMD_AGENT=fake: a scripted agent's push names no profile, and the project's default profile (a real Claude
  // worker) would otherwise run against the fake machine.
  env: { ...process.env, ...common, CAPCOMD_AGENT: "fake", CAPCOMD_ENGINE_DATA: join(WORK, "engine"), CAPCOMD_HARNESS_SOCKET: join(WORK, "harness.sock"), CAPCOMD_NO_CONFIG: "1" },
});
let driver: ReturnType<typeof spawn> | null = null;
const stopAll = () => {
  if (driver?.pid) { try { process.kill(-driver.pid, "SIGKILL"); } catch {} }
  if (engine.pid) { try { process.kill(-engine.pid, "SIGTERM"); } catch {} }
};
process.on("SIGINT", () => { stopAll(); process.exit(130); });
process.on("SIGTERM", () => { stopAll(); process.exit(143); });
const probe = spawnSync("bun", [join(ROOT, "tests", "helpers", "ready-probe.ts"), String(PORT)], { encoding: "utf8", env: { ...process.env, CAPCOMD_READY_DEADLINE_MS: "240000" } });
if (probe.status !== 0) {
  stopAll();
  await new Promise((r) => setTimeout(r, 3000));
  reapUnder(WORK);
  if (!a.keep) rmSync(WORK, { recursive: true, force: true });
  throw new Error(`engine not ready: ${probe.stderr}`);
}
log(`engine on :${PORT}, work ${WORK}`);

// ── 5. the driver ────────────────────────────────────────────────────────────────────────────────
const PROMPT = `Use capcomd to help me build tinycalc, a small expression language in TypeScript on Bun. It should have: arithmetic with + - * / ^ %, unary minus and parentheses, with the usual precedence (^ is right-associative); variables (\`let x = 2 * 3\`) and a few builtins: min, max, sqrt, abs, round; helpful errors that show the line with a caret under the problem; a pretty-printer that only adds the parentheses it needs, so parsing its output gives back the same tree; a CLI (\`bun run src/cli.ts "1 + 2 * x"\`) and an interactive REPL. A new repo for it is ready: ${PROJECT} (this folder), whose origin is the local repository ${BARE}, with one commit on main and a \`dev\` branch; build it there, with tests and a typecheck, on the \`dev\` branch. Split the work so as much as possible happens in parallel, and keep each piece small. Get the shared pieces in first so everyone builds on the same thing. I want the parser and the pretty-printer reviewed carefully, and proper end-to-end tests at the end. Keep me posted while it runs. When it's done, show me what landed, how the team was organized, how long it took and what it cost, and anything that felt rough.`;
// The same note for every version: the environment is a simulation, so the driver plans and runs the team as usual
// and doesn't stop at missing cloud logins or try to repair placeholder commits.
const NOTE = `This session is a rehearsal of capcomd on this machine: the agents capcomd runs here are simulated. They take about as long as real ones, and their commits hold placeholder files instead of code. capcomd_setup reports the boxd key, agent logins and plugin as missing; that is expected here, everything you need works. Treat a passing capcomd_verify as that part being done, and don't inspect or redo the agents' code. There is no person to answer questions during the session: decide yourself and carry on.`;
const mcpConfig = join(WORK, "mcp.json");
writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { capcomd: { command: "bun", args: [CLI, "mcp"], env: { ...common, CAPCOMD_PROJECT_DIR: PROJECT, PATH: process.env.PATH ?? "" } } } }));
const args = ["-p", PROMPT, "--model", a.model!, "--plugin-dir", PLUGIN, "--mcp-config", mcpConfig, "--strict-mcp-config",
  "--tools", "Skill,ToolSearch,TodoWrite", "--allowedTools", "mcp__capcomd__*", "Skill", "ToolSearch", "TodoWrite", "--permission-mode", "dontAsk",
  "--append-system-prompt", NOTE, "--max-turns", a["max-turns"]!, "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources", "project"];
const t0 = Date.now();
const transcript: Array<{ at: number; msg: any }> = [];
const transcriptFile = join(WORK, "session.ndjson");
await new Promise<void>((done) => {
  driver = spawn(a.claude!, args, { cwd: PROJECT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CAPCOMD_HOME: HOME, CAPCOMD_ENDPOINT: common.CAPCOMD_ENDPOINT! } });
  const timer = setTimeout(() => { log("timeout: stopping the driver"); try { process.kill(-driver!.pid!, "SIGKILL"); } catch {} }, Number(a["timeout-min"]) * 60_000);
  let buf = "";
  driver.stdout!.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const msg = JSON.parse(line); transcript.push({ at: Date.now(), msg }); } catch {}
    }
  });
  let err = "";
  driver.stderr!.on("data", (d) => { err += d; });
  driver.on("exit", (code) => { clearTimeout(timer); if (code) log(`driver exited ${code}: ${err.slice(-500)}`); done(); });
});
writeFileSync(transcriptFile, transcript.map((t) => JSON.stringify({ at: t.at, ...t.msg })).join("\n"));
const wallSeconds = Math.round((Date.now() - t0) / 1000);
// The run's events, from the engine, before it stops.
const runIdOf = (r: any) => (r && typeof r === "object" && typeof r.runId === "string" && /^run-/.test(r.runId) ? r.runId : null);
const parsed = transcript.flatMap((t) => (t.msg.message?.content ?? []).filter((c: any) => c.type === "tool_result")).map((c: any) => { try { return JSON.parse(Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? "").join("") : String(c.content ?? "")); } catch { return null; } });
const runId = parsed.map(runIdOf).find(Boolean) as string | undefined;
const cj = (args: string[]) => { const r = spawnSync("bun", [CLI, ...args, "--json"], { cwd: PROJECT, encoding: "utf8", env: { ...process.env, ...common } }); try { return JSON.parse(r.stdout.trim().split("\n").pop()!); } catch { return null; } };
const events: any[] = [];
if (runId) { let cursor: string | null = null; for (let i = 0; i < 50; i++) { const p = cj(["events", runId, "--limit", "500", ...(cursor ? ["--cursor", cursor] : [])]); events.push(...(p?.events ?? [])); cursor = p?.nextCursor ?? null; if (!cursor) break; } }
writeFileSync(join(WORK, "events.json"), JSON.stringify(events));
writeFileSync(join(WORK, "meta.json"), JSON.stringify({ version: a.ref ?? "checkout", model: a.model, slots: Number(a.slots), wallSeconds, runId: runId ?? null }));
report(WORK);

// ── 7. cleanup ───────────────────────────────────────────────────────────────────────────────────
stopAll();
await new Promise((r) => setTimeout(r, 3000));
// The engine's own child (rivet-engine) and any scripted agent still running, by their scratch paths (not this process,
// whose command line names the folder too when --work does).
reapUnder(WORK);
if (!a.keep) rmSync(WORK, { recursive: true, force: true });
else log(`kept ${WORK}`);
process.exit(0);

// ── the report ───────────────────────────────────────────────────────────────────────────────────
function report(dir: string) {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const transcript = readFileSync(join(dir, "session.ndjson"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ev: any[] = JSON.parse(readFileSync(join(dir, "events.json"), "utf8"));
  const uses = transcript.flatMap((m: any) => (m.message?.content ?? []).filter((c: any) => c.type === "tool_use").map((c: any) => ({ at: m.at as number, name: String(c.name), input: c.input ?? {}, id: c.id })));
  const results = new Map<string, any>();
  for (const m of transcript) for (const c of m.message?.content ?? []) if (c.type === "tool_result") {
    const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? "").join("") : String(c.content ?? "");
    try { results.set(c.tool_use_id, JSON.parse(text)); } catch { results.set(c.tool_use_id, text); }
  }
  const short = (n: string) => n.replace(/^mcp__capcomd__/, "");
  const final = transcript.find((m: any) => m.type === "result");

  // The tree and each agent's time running (started → done/failed/cancelled), from the run's events.
  type A = { id: string; parent: string | null; profile: string; title: string; status: string; started?: number; ended?: number; review: boolean };
  const agents = new Map<string, A>();
  for (const e of ev) {
    const id = e.agentId as string | null; const d = e.event ?? {};
    if (!id) continue;
    if (e.type === "AGENT_SPAWNED") agents.set(id, { id, parent: d.parent ?? null, profile: d.profile ?? "?", title: String(d.title ?? ""), status: "pending", review: d.review === true });
    const x = agents.get(id); if (!x) continue;
    if (e.type === "AGENT_TITLED" && d.title) x.title = String(d.title);
    if (e.type === "AGENT_STARTED" && x.started === undefined) { x.started = e.at; x.status = "running"; }
    if (/^AGENT_(DONE|FAILED|CANCELLED)$/.test(e.type)) { x.ended = e.at; x.status = e.type.slice(6).toLowerCase(); }
  }
  // verify's reviewers are spawned by capcomd under the agent they review; the driver's own critics are its children.
  const verifyReviewer = (x: A) => x.review;
  const team = [...agents.values()].filter((x) => !verifyReviewer(x));
  const depthOf = (x: A): number => (x.parent && agents.get(x.parent) ? 1 + depthOf(agents.get(x.parent)!) : 1);
  const peak = (xs: A[]) => {
    const pts: Array<[number, number]> = [];
    for (const x of xs) if (x.started !== undefined) { pts.push([x.started, 1]); pts.push([x.ended ?? Number.MAX_SAFE_INTEGER, -1]); }
    pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let cur = 0, max = 0; for (const [, d] of pts) { cur += d; max = Math.max(max, cur); } return max;
  };
  const runSpan = (() => { const ts = [...agents.values()].flatMap((x) => [x.started, x.ended]).filter((t): t is number => typeof t === "number"); return ts.length ? Math.round((Math.max(...ts) - Math.min(...ts)) / 1000) : 0; })();

  // The driver's spawns in order, by phase: a new phase starts after a merge landed.
  const spawns = uses.filter((u) => short(u.name) === "capcomd_spawn").map((u) => ({ ...u, result: results.get(u.id) }));
  const merges = uses.filter((u) => short(u.name) === "capcomd_merge" && results.get(u.id)?.state === "merged");
  let phase = 0, last = 0;
  const rows = spawns.map((s) => {
    if (phase === 0 || merges.some((m) => m.at > last && m.at < s.at)) phase++;
    last = s.at;
    return { phase, profile: String(s.input.profile ?? "(default)"), children: s.input.children ?? null, title: String(s.input.title ?? ""), task: String(s.input.task ?? "").slice(0, 70).replace(/\s+/g, " "), ok: !!s.result?.agentId, error: s.result?.error?.message as string | undefined };
  });
  const phaseOf = (re: RegExp) => rows.find((r) => r.ok && re.test(`${r.title} ${r.task}`))?.phase ?? null;
  const P = { contract: phaseOf(/contract|foundation|scaffold|shared|types|interface|skeleton/i), parser: phaseOf(/pars/i), evaluator: phaseOf(/eval/i), printer: phaseOf(/print/i), cli: phaseOf(/\bcli\b|repl/i), e2e: phaseOf(/end.to.end|e2e/i) };
  const out = {
    version: meta.version, model: meta.model, runId: meta.runId, wallSeconds: meta.wallSeconds, runSeconds: runSpan, costUsd: final?.total_cost_usd ?? null, turns: final?.num_turns ?? null,
    skillLoaded: uses.some((u) => u.name === "Skill" && /orchestration/.test(JSON.stringify(u.input))),
    depth: team.length ? Math.max(...team.map(depthOf)) : 0, agents: team.length, verifyReviewers: agents.size - team.length,
    peakTeam: peak(team), peakAll: peak([...agents.values()]), slots: meta.slots,
    phases: rows.length ? Math.max(...rows.map((r) => r.phase)) : 0, phaseOf: P, consumersOnStubs: P.cli !== null && P.parser !== null ? P.cli <= P.parser : null,
    leads: rows.filter((r) => r.ok && Number((r.children as any)?.maxChildren ?? 0) > 0).length, leafGrants: rows.filter((r) => r.ok && r.children && Number((r.children as any).maxChildren ?? 0) === 0).length,
    driverSpawns: rows.length, refusedSpawns: rows.filter((r) => !r.ok).length, merged: merges.length,
    toolCalls: Object.fromEntries(Object.entries(uses.reduce((m: Record<string, number>, u) => ((m[short(u.name)] = (m[short(u.name)] ?? 0) + 1), m), {})).sort((x, y) => y[1] - x[1])),
  };
  const kids = (id: string | null) => team.filter((x) => x.parent === id);
  const print = (x: A, pre = "") => { console.log(`${pre}${x.profile}: ${x.title} [${x.status}]`); for (const c of kids(x.id)) print(c, pre + "  "); };
  console.log(`\n=== team shape: ${out.version} (${out.model}) ===`);
  for (const x of kids(null)) print(x);
  console.log("\ndriver spawns (phase · profile · children · title/task):");
  for (const r of rows) console.log(`  ${r.phase} · ${r.profile} · ${r.children ? JSON.stringify(r.children) : "-"} · ${r.title || r.task}${r.ok ? "" : `  REFUSED: ${r.error}`}`);
  console.log(`\n${JSON.stringify(out, null, 2)}`);
  if (final?.result) console.log(`\nfinal message (first 1500 chars):\n${String(final.result).slice(0, 1500)}`);
  if (a.out) writeFileSync(a.out, JSON.stringify({ ...out, spawns: rows }, null, 2));
}
