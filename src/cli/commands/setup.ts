// `capcomd setup`: from install to a working setup in one guided pass, and `capcomd setup --check` to verify it.
//   0. demo      try it locally with fake agents (no accounts), optional
//   1. accounts  boxd key (made with the logged-in boxd CLI, or given; validated; kept in the OS keychain),
//                env snapshot, Claude/Codex logins, doctor
//   2. project   repository, target branch, PR or direct merges, a default check, worker/reviewer/planner profiles
//   3. agent     the capcomd plugin (MCP tools and skills) for Claude Code and Codex, and a prompt to try
//   4. service   the engine as a background service
// Each step also runs alone (`capcomd setup project`). Without a terminal, or with --yes, prompts take their
// defaults and flags, so agents and scripts can run setup too. Settings land in ~/.capcomd/config.json (user)
// and <project>/.capcomd/config.json; the boxd key never sits in a file unless there is no keychain and you agree.
import { spawnSync } from "child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, hostname, tmpdir } from "os";
import { dirname, join } from "path";
import { capcomdHome } from "../../utils/home";
import { selfArgv } from "../../utils/self";
import { ORCHESTRATION_SKILL } from "../../utils/assets";
import { projectConfigPath, readConfig, userConfigPath, writeConfig } from "../../config/store";
import { keychainGet, keychainKind, keychainSet } from "../../config/keychain";
import { prompter, type Prompter } from "../prompt";

export interface Step { step: string; ok: boolean; detail: string; hint?: string }
type Values = Record<string, unknown>;

/** Run this CLI as a subprocess (inheriting the terminal for interactive steps like a login). */
/** process.env with `extra` on top; an `undefined` value removes the variable. */
function envWith(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const e: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e as Record<string, string>;
}
function self(args: string[], o: { env?: Record<string, string | undefined>; inherit?: boolean; cwd?: string } = {}) {
  const [cmd, ...argv] = selfArgv(...args);
  const r = spawnSync(cmd!, argv, { env: envWith(o.env), cwd: o.cwd, stdio: o.inherit ? "inherit" : "pipe", encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const json = (s: string): any => { try { return JSON.parse(s.trim().split("\n").pop() ?? ""); } catch { return null; } };
const sh = (cmd: string, args: string[], cwd?: string) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8" }); return { code: r.status ?? 1, out: (r.stdout ?? "").trim() }; };

// ── pure helpers (tested) ─────────────────────────────────────────────────────────────────────
/** git@github.com:o/r.git → https://github.com/o/r.git (VMs clone over https with a per-push credential). */
export function httpsRemote(url: string): string {
  const m = /^git@([^:]+):(.+?)(\.git)?$/.exec(url.trim());
  if (m) return `https://${m[1]}/${m[2]}.git`;
  const s = /^ssh:\/\/git@([^/]+)\/(.+?)(\.git)?$/.exec(url.trim());
  return s ? `https://${s[1]}/${s[2]}.git` : url.trim();
}
/** owner/repo for a GitHub remote, else null. */
export function githubRepoOf(url: string): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(\.git)?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
/** A test command from the project's files: package.json "test" (bun or npm), else null. */
export function suggestCheck(dir: string): string | null {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return null;
  try {
    const p = JSON.parse(readFileSync(pj, "utf8"));
    const usesBun = existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"));
    if (p.scripts?.test) return usesBun ? "bun run test" : "npm test";
    return usesBun ? "bun test" : null;
  } catch { return null; }
}

// ── steps ─────────────────────────────────────────────────────────────────────────────────────
/** 0. A real run on a private engine with fake agents: no accounts, about a minute. */
export async function demoStep(log: (s: string) => void): Promise<Step> {
  const home = mkdtempSync(join(tmpdir(), "capcomd-demo-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { CAPCOMD_HOME: home, CAPCOMD_NO_CONFIG: "1", CAPCOMD_SANDBOX: "fake", CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_ENDPOINT: `http://127.0.0.1:${port}`, CAPCOMD_ENGINE_DATA: join(home, "engine"), CAPCOMD_REPO: undefined, CAPCOMD_AGENTS_FILE: join(home, "agents.json") };
  const engine = Bun.spawn(selfArgv("serve", "--port", String(port)), { env: envWith(env), stdout: "ignore", stderr: "ignore" });
  try {
    log("  starting a private engine with fake agents…");
    let run = "";
    for (let i = 0; i < 60 && !run; i++) { run = json(self(["run", "new", "--budget", "usd=1,turns=50", "--label", "demo", "--json"], { env }).stdout)?.runId ?? ""; if (!run) await Bun.sleep(1000); }
    if (!run) return { step: "demo", ok: false, detail: "the local engine didn't start", hint: "Run `capcomd serve` yourself and look at its output." };
    const ids: string[] = [];
    for (const t of ["write the parser", "write the tests", "write the docs"]) ids.push(json(self(["spawn", run, "--task", t, "--key", t.split(" ")[2]!, "--budget", "usd=0.2,turns=10", "--json"], { env }).stdout)?.agentId);
    log(`  run ${run}: 3 agents in parallel…`);
    const aw = json(self(["await", run, ...ids, "--timeout-ms", "60000", "--json"], { env }).stdout);
    const done = (aw?.agents ?? []).filter((a: any) => a.status === "done").length;
    log(self(["tree", run], { env }).stdout.split("\n").map((l) => `    ${l}`).join("\n"));
    return { step: "demo", ok: done === 3, detail: `${done}/3 fake agents finished in a real (local) run` };
  } finally {
    engine.kill();
    await engine.exited.catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}

async function validBoxdKey(key: string): Promise<boolean> {
  try {
    const { BoxdProvider } = await import("../../providers/boxd");
    const p = new BoxdProvider({ apiKey: key, keepaliveMs: 0, dbPath: ":memory:" } as any);
    try { await p.list("relay-"); return true; } finally { await (p as any).close?.(); }
  } catch { return false; }
}

export interface BoxdOrg { id: string; name: string; active: boolean }
export interface BoxdCli { installed: boolean; loggedIn: boolean; user?: string; orgs: BoxdOrg[] }
/** The boxd CLI binary (CAPCOMD_BOXD_CLI overrides it, for tests). */
const boxdBin = () => process.env.CAPCOMD_BOXD_CLI ?? "boxd";
/** The JSON object in a boxd CLI's output (it may print an update notice first). */
function boxdJson(out: string): any {
  const i = out.indexOf("{");
  try { return i >= 0 ? JSON.parse(out.slice(i)) : null; } catch { return null; }
}

/** Is the boxd CLI installed, and is someone logged in (`boxd auth --json`)? */
export function boxdCli(): BoxdCli {
  const r = spawnSync(boxdBin(), ["auth", "--json"], { encoding: "utf8", timeout: 20_000 });
  if (r.error) return { installed: false, loggedIn: false, orgs: [] };
  const j = r.status === 0 ? boxdJson(r.stdout ?? "") : null;
  if (!j?.user_id) return { installed: true, loggedIn: false, orgs: [] };
  return { installed: true, loggedIn: true, user: j.display_name ?? j.user_id, orgs: (j.orgs ?? []).map((o: any) => ({ id: String(o.id), name: String(o.name ?? o.id), active: !!o.active })) };
}

/** A key just for capcomd, made with the logged-in boxd CLI: named, fenced to one org, revocable on its own. */
export function boxdKeyName(): string {
  return `capcomd-${hostname().split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "host"}`;
}
function mintBoxdKey(name: string, org: string): { key: string } | { error: string } {
  const r = spawnSync(boxdBin(), ["auth", "keys", "create", name, "--org", org, "--json"], { encoding: "utf8", timeout: 30_000 });
  const j = r.status === 0 ? boxdJson(r.stdout ?? "") : null;
  if (typeof j?.api_key === "string" && j.api_key) return { key: j.api_key };
  return { error: (r.stderr || r.stdout || "no output").trim().split("\n").pop()!.slice(0, 200) };
}

/** Make a key with the boxd CLI when it's logged in; otherwise say exactly what the person has to do. */
async function keyFromBoxdCli(p: Prompter, v: Values): Promise<{ key: string; from: string } | Step> {
  const cli = boxdCli();
  const paste = "or paste an existing key when setup asks (interactive)";
  if (!cli.installed) return { step: "boxd key", ok: false, detail: "no boxd key, and the boxd CLI isn't installed", hint: `Install it (\`curl -fsSL https://boxd.sh/downloads/install.sh | sh\`), run \`boxd auth login\`, then run setup again; ${paste}, or export BOXD_API_KEY.` };
  if (!cli.loggedIn) return { step: "boxd key", ok: false, detail: "no boxd key, and the boxd CLI isn't logged in", hint: `Run \`boxd auth login\` (opens a browser), then run setup again; ${paste}, or export BOXD_API_KEY.` };
  const wanted = typeof v.org === "string" ? v.org : undefined;
  let org = wanted ? cli.orgs.find((o) => o.id === wanted || o.name === wanted) : cli.orgs.find((o) => o.active) ?? (cli.orgs.length === 1 ? cli.orgs[0] : undefined);
  if (wanted && !org) return { step: "boxd key", ok: false, detail: `you're not in a boxd org named ${wanted}`, hint: `Your orgs: ${cli.orgs.map((o) => o.name).join(", ")}. Pass one with --org.` };
  if (!org && p.interactive && cli.orgs.length) {
    const id = await p.choose("Which boxd org should capcomd's VMs run in?", cli.orgs.map((o) => ({ value: o.id, label: o.name })), cli.orgs[0]!.id);
    org = cli.orgs.find((o) => o.id === id);
  }
  if (!org) return { step: "boxd key", ok: false, detail: "you're in several boxd orgs and none is active", hint: `Pick one with --org (${cli.orgs.map((o) => o.name).join(", ")}), or \`boxd auth switch\`.` };
  const name = boxdKeyName();
  if (!(await p.confirm(`Create a boxd API key "${name}" for capcomd in org "${org.name}" (as ${cli.user})?`, true))) return { step: "boxd key", ok: false, detail: "no key created", hint: "Export BOXD_API_KEY, or run setup again and let it create one." };
  const m = mintBoxdKey(name, org.id);
  if ("error" in m) return { step: "boxd key", ok: false, detail: `boxd couldn't create a key: ${m.error}`, hint: "Try `boxd auth keys create capcomd` yourself and export BOXD_API_KEY." };
  return { key: m.key, from: `created "${name}" in ${org.name}; revoke with \`boxd auth keys rm ${name}\`` };
}

/**
 * 1a. The boxd key: from the environment or the keychain; else made with the logged-in boxd CLI (a key just for
 * capcomd, never shown); else pasted. Validated, then kept in the OS keychain.
 */
export interface KeyDeps { validate: (key: string) => Promise<boolean>; kcGet: () => string | null; kcSet: (key: string) => void; kcKind: () => string | null }
const realKeyDeps: KeyDeps = { validate: validBoxdKey, kcGet: () => keychainGet(), kcSet: (k) => keychainSet(k), kcKind: () => keychainKind() };

export async function boxdKeyStep(p: Prompter, v: Values, deps: KeyDeps = realKeyDeps): Promise<Step> {
  const validBoxdKey = deps.validate;
  let key = process.env.BOXD_API_KEY ?? "";
  let from = key ? "environment" : "";
  if (!key) { const k = deps.kcGet(); if (k) { key = k; from = "keychain"; } }
  if (key && !(await validBoxdKey(key))) {
    if (from === "environment") return { step: "boxd key", ok: false, detail: "BOXD_API_KEY was rejected by boxd", hint: "Check it with `boxd auth keys list`, or unset it and run setup again to create one." };
    key = ""; from = ""; // a stale keychain key: replace it
  }
  if (!key) {
    const made = await keyFromBoxdCli(p, v);
    if ("key" in made) { key = made.key; from = made.from; }
    else {
      if (!p.interactive) return made;
      key = await p.secret(`boxd API key (bxd_…). ${made.detail}; ${made.hint}`);
      from = "entered";
    }
    if (!(await validBoxdKey(key))) return { step: "boxd key", ok: false, detail: `the key (${from}) was rejected by boxd`, hint: "Check it with `boxd auth keys list`, or create a new one." };
  }
  process.env.BOXD_API_KEY = key;
  let stored = from === "keychain" ? "keychain" : "";
  if (!stored && v["no-store"] !== true) {
    const kc = deps.kcKind();
    if (kc && await p.confirm(`Keep the key in the ${kc === "macos" ? "macOS Keychain" : "Secret Service"}?`, true)) { deps.kcSet(key); stored = "keychain"; }
    // A key setup just created exists nowhere else: without a keychain it goes to the 0600 file rather than be lost.
    else if (!kc && (from.startsWith("created") || (p.interactive && await p.confirm(`No OS keychain found. Store the key in ${join(capcomdHome(), "credentials")} (readable only by you)?`, false)))) {
      mkdirSync(capcomdHome(), { recursive: true });
      writeFileSync(join(capcomdHome(), "credentials"), JSON.stringify({ BOXD_API_KEY: key }) + "\n", { mode: 0o600 });
      stored = "file";
    }
  }
  writeConfig(userConfigPath(), { env: { CAPCOMD_SANDBOX: "boxd" }, ...(stored ? { boxdKey: stored as "keychain" | "file" } : {}) });
  return { step: "boxd key", ok: true, detail: `valid (${from})${stored ? `, kept in the ${stored}` : ", not stored: export BOXD_API_KEY in each shell"}` };
}

/** 1b-d. The env snapshot, agent logins (plan or API key) and doctor. */
export async function agentAccountsStep(p: Prompter, v: Values, log: (s: string) => void): Promise<Step[]> {
  const steps: Step[] = [];
  const env = { CAPCOMD_SANDBOX: "boxd" };
  log("  building the agent environment snapshot (once; skipped when current)…");
  const b = self(["env", "build"], { env, inherit: p.interactive });
  steps.push({ step: "env snapshot", ok: b.code === 0, detail: b.code === 0 ? "ready" : "env build failed", ...(b.code ? { hint: "Run `capcomd env build` to see why." } : {}) });
  if (b.code) return steps;
  const which = String(v.agents ?? await p.choose("Which coding agents?", [{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }, { value: "claude,codex", label: "Both" }], "claude"));
  const agents = which.split(",").map((s) => s.trim()).filter((a) => a === "claude" || a === "codex");
  const status = json(self(["auth", "status", "--json"], { env }).stdout)?.profiles ?? [];
  for (const a of agents) {
    const id = a === "claude" ? "claude-code" : "codex";
    const keyVar = a === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    const auth = String(v.auth ?? await p.choose(`${a === "claude" ? "Claude Code" : "Codex"}: log in with`, [{ value: "subscription", label: a === "claude" ? "my Claude plan" : "my ChatGPT plan" }, { value: "apikey", label: `an API key (${keyVar})` }], "subscription"));
    ((v as any)._auths ??= {})[a] = auth; // the profiles (project step) use the login chosen here
    if (auth === "apikey") {
      if (!process.env[keyVar]) { steps.push({ step: `${a} login`, ok: false, detail: `${keyVar} is not set`, hint: `Export ${keyVar}, then \`capcomd secrets sync\`.` }); continue; }
      const s = self(["secrets", "sync"], { env });
      steps.push({ step: `${a} login`, ok: s.code === 0, detail: s.code === 0 ? `API key stored as a boxd host-bound secret` : "secrets sync failed" });
      continue;
    }
    const have = status.find((x: any) => x.agent === id);
    if (have?.present && have.valid !== false && v["relogin"] !== true) { steps.push({ step: `${a} login`, ok: true, detail: `already logged in (${have.store})` }); continue; }
    if (!p.interactive) { steps.push({ step: `${a} login`, ok: false, detail: "not logged in", hint: `Run \`capcomd auth login ${a}\` in a terminal (it opens a browser login).` }); continue; }
    log(`  logging in ${a} with your plan (a browser window or a code to enter)…`);
    const l = self(["auth", "login", a], { env, inherit: true });
    steps.push({ step: `${a} login`, ok: l.code === 0, detail: l.code === 0 ? "logged in" : "login didn't finish", ...(l.code ? { hint: `Retry with \`capcomd auth login ${a}\`.` } : {}) });
  }
  log("  checking each agent inside a VM (doctor)…");
  const d = self(["doctor", "--strict"], { env, inherit: p.interactive });
  steps.push({ step: "doctor", ok: d.code === 0, detail: d.code === 0 ? "every agent answered from a VM" : "an agent didn't work", ...(d.code ? { hint: "Run `capcomd doctor` for details." } : {}) });
  writeConfig(userConfigPath(), { env: { CAPCOMD_SANDBOX: "boxd" } });
  (v as any)._agents = agents;
  return steps;
}

/** 2. The project: repository, target, merge mode, a default check and reviewer, and the agent profiles. */
export async function projectStep(p: Prompter, v: Values, cwd = process.cwd()): Promise<Step[]> {
  const root = sh("git", ["rev-parse", "--show-toplevel"], cwd);
  const dir = root.code === 0 ? root.out : cwd;
  const origin = sh("git", ["remote", "get-url", "origin"], dir).out;
  const repo = httpsRemote(String(v.repo ?? await p.ask("Repository the agents work on", origin)));
  if (!repo) return [{ step: "project", ok: false, detail: "no repository", hint: "Run setup inside a git checkout, or pass --repo <url>." }];
  const head = sh("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir).out.replace(/^origin\//, "");
  const gh = githubRepoOf(repo);
  const ghOk = !!gh && sh("gh", ["auth", "status"]).code === 0;
  const mode = String(v.mode ?? await p.choose("How should verified work land?", [{ value: "pr", label: "as a pull request merged by capcomd (GitHub)" }, { value: "direct", label: "pushed directly to the target branch" }], ghOk ? "pr" : "direct"));
  const target = String(v.target ?? await p.ask("Target branch (agent merges into protected branches like main wait for `capcomd approve`)", head || "main"));
  const check = String(v.check ?? await p.ask("The check every change must pass (a command; empty for none)", suggestCheck(dir) ?? ""));
  const cfgPath = join(dir, ".capcomd", "config.json");
  const agents: string[] = (v as any)._agents ?? String(v.agents ?? "claude").split(",");
  const provider = agents.includes("claude") ? "claude" : "codex";
  const authOf = (a: string) => String((v as any)._auths?.[a] ?? v.auth ?? "subscription");
  // No turn, time or money limits on the profiles (ADR-019): agents work as long as they make progress. A plan
  // login is already paid for; with an API key, a cap per run is asked once (empty: no limit).
  let cap: string | null = null;
  if (agents.some((a) => authOf(a) === "apikey")) {
    const raw = String(v.budget ?? await p.ask("Your agents bill an API key. Cap the spend per run, in USD (empty for no limit)", "")).trim();
    if (raw && raw !== "none") {
      const usd = Number(raw.replace(/^usd=/, ""));
      if (!(usd > 0)) return [{ step: "project", ok: false, detail: `"${raw}" isn't an amount in USD`, hint: "Pass --budget 20 (USD per run), or leave it empty for no limit." }];
      cap = `usd=${usd}`;
    }
  }
  writeConfig(cfgPath, {
    env: { CAPCOMD_REPO: repo, CAPCOMD_MERGE_MODE: mode, CAPCOMD_MERGE_TARGET: target, ...(gh ? { CAPCOMD_GITHUB_REPO: gh } : {}) },
    run: { ...(check ? { checks: { unit: check } } : {}), reviewer: "reviewer" },
    ...(cap ? { driver: { ...readConfig(cfgPath).driver, maxRunBudget: cap } } : {}),
  });
  // Profiles: one worker per chosen agent, a read-only reviewer, a planner that may spawn workers.
  const auth = authOf(provider);
  const af = join(dir, ".capcomd", "agents.json");
  const workers = agents.map((a) => (a === provider ? "worker" : `${a}-worker`));
  const profiles: Array<[string, Record<string, unknown>]> = [
    ...agents.map((a, i): [string, Record<string, unknown>] => [workers[i]!, { provider: a, auth: authOf(a) }]),
    ["reviewer", { provider, auth, allowedTools: ["Read", "Glob", "Grep", "LS", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(cat:*)", "Bash(ls:*)", ...(check ? [`Bash(${check.split(" ").slice(0, 2).join(" ")}:*)`] : [])] }],
    // No fan-out limits either: the planner may spawn workers as it sees fit (set children.* to bound it).
    ["planner", { provider, auth, children: { allowSpawn: true, allowedChildProfiles: workers } }],
  ];
  const made: string[] = [], kept: string[] = [];
  for (const [name, spec] of profiles) {
    const r = self(["agents", "add", name, "--spec", JSON.stringify(spec)], { env: { CAPCOMD_AGENTS_FILE: af } });
    (r.code === 0 ? made : kept).push(name);
  }
  return [
    { step: "project", ok: true, detail: `${repo} → ${target} (${mode})${check ? `, check unit='${check}'` : ""}, reviewer on${cap ? `, spend capped at ${cap} per run` : ""}; saved to ${cfgPath}` },
    { step: "profiles", ok: true, detail: `${made.length ? `added ${made.join(", ")}` : "none added"}${kept.length ? `; kept existing ${kept.join(", ")}` : ""} (${af})` },
  ];
}

/** Where the capcomd plugin comes from: this repository's marketplace (CAPCOMD_PLUGIN_MARKETPLACE: a path, for tests). */
export const pluginMarketplace = () => process.env.CAPCOMD_PLUGIN_MARKETPLACE ?? "MarvinAmador7/capcomd";
const claudeBin = () => process.env.CAPCOMD_CLAUDE_CLI ?? "claude";
const codexBin = () => process.env.CAPCOMD_CODEX_CLI ?? "codex";
const runs = (cmd: string) => { const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 15_000 }); return !r.error && r.status === 0; };
const legacySkill = () => join(homedir(), ".claude", "skills", "capcomd-orchestration");

/** Is the capcomd plugin installed and enabled in Claude Code? */
export function claudePluginInstalled(): boolean {
  const r = spawnSync(claudeBin(), ["plugin", "list", "--json"], { encoding: "utf8", timeout: 30_000 });
  if (r.error || r.status !== 0) return false;
  try { return (JSON.parse(r.stdout) as any[]).some((x) => String(x.id).startsWith("capcomd@") && x.enabled !== false); } catch { return false; }
}

/**
 * 3. capcomd in your agents: the plugin (the MCP tools and the orchestration and setup skills) for Claude Code and
 * Codex. Without either CLI, the orchestration skill for Claude Code and the line that registers the MCP server.
 */
export async function agentIntegrationStep(p: Prompter, v: Values): Promise<Step[]> {
  if (v["no-skill"] === true || v["no-plugin"] === true) return [{ step: "agent plugin", ok: true, detail: "skipped" }];
  const source = pluginMarketplace();
  const steps: Step[] = [];
  const hasClaude = runs(claudeBin()), hasCodex = runs(codexBin());
  const tryIt = `Then ask your agent: "Use capcomd to fix the failing tests: one worker per file, each verified and reviewed, then merged."`;
  if (hasClaude && await p.confirm("Install the capcomd plugin in Claude Code (MCP tools and skills)?", true)) {
    const r = spawnSync(claudeBin(), ["plugin", "install", "capcomd", "--marketplace", source, "--json"], { encoding: "utf8", timeout: 300_000 });
    const out: any = json(r.stdout ?? "");
    const ok = r.status === 0 && (out?.outcome === "ok" || claudePluginInstalled());
    // The plugin carries the skill now; an older copy setup made would load twice.
    if (ok && existsSync(join(legacySkill(), "SKILL.md"))) rmSync(legacySkill(), { recursive: true, force: true });
    steps.push(ok
      ? { step: "claude plugin", ok, detail: `installed capcomd@capcomd (from ${source}). Restart Claude Code, or run /reload-plugins. ${tryIt}` }
      : { step: "claude plugin", ok, detail: `install failed: ${(out?.message ?? r.stderr ?? r.stdout ?? "").toString().trim().slice(0, 200)}`, hint: `In Claude Code: \`/plugin install capcomd --marketplace ${source}\`.` });
  }
  if (hasCodex && await p.confirm("Add the capcomd plugin marketplace to Codex?", true)) {
    const r = spawnSync(codexBin(), ["plugin", "marketplace", "add", source], { encoding: "utf8", timeout: 300_000 });
    const ok = r.status === 0 || /already/i.test(`${r.stdout}${r.stderr}`);
    steps.push(ok
      ? { step: "codex plugin", ok, detail: `marketplace added (${source}): install capcomd from /plugins in Codex. ${tryIt}` }
      : { step: "codex plugin", ok, detail: `marketplace add failed: ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`, hint: `Run \`codex plugin marketplace add ${source}\`, then install capcomd from /plugins.` });
  }
  if (steps.length) return steps;
  // No plugin host: the skill alone (agents with a shell use the CLI), and how to register the MCP server.
  if (!(await p.confirm("No Claude Code or Codex CLI found. Install the capcomd skill for Claude Code anyway?", true))) return [{ step: "agent skill", ok: true, detail: "skipped" }];
  mkdirSync(legacySkill(), { recursive: true });
  writeFileSync(join(legacySkill(), "SKILL.md"), ORCHESTRATION_SKILL);
  return [{ step: "agent skill", ok: true, detail: `skill installed in ${legacySkill()}; for the MCP tools: \`claude mcp add capcomd -- capcomd mcp\`. ${tryIt}` }];
}

/** 4. The engine as a background service. */
export async function serviceStep(p: Prompter, v: Values): Promise<Step> {
  if (v["no-service"] === true || !(v.service === true || await p.confirm("Run the capcomd engine in the background (starts at login)?", true))) return { step: "engine", ok: true, detail: "not installed as a service: run `capcomd serve` when you need it" };
  const S = await import("./service");
  const r: any = await S.serviceInstall({});
  return { step: "engine", ok: !!r.running, detail: r.running ? `background service on :${r.port} (${r.path})` : `service installed but not answering yet; see ${r.log}`, ...(r.running ? {} : { hint: "Check `capcomd service status`." }) };
}

/** `capcomd setup --check`: what's configured and working, without changing anything. */
export async function checkSetup(cwd = process.cwd()): Promise<Step[]> {
  const out: Step[] = [];
  const user = readConfig(userConfigPath());
  const projPath = projectConfigPath(cwd);
  const proj = readConfig(projPath);
  // Settings count wherever they come from: the config files (applied to the environment at startup) or the environment.
  const sandbox = process.env.CAPCOMD_SANDBOX ?? process.env.RELAY_SANDBOX;
  out.push({ step: "user config", ok: !!sandbox, detail: `sandbox ${sandbox ?? "unset"}${user.env?.CAPCOMD_SANDBOX ? ` (${userConfigPath()})` : sandbox ? " (environment)" : ""}`, ...(sandbox ? {} : { hint: "Run `capcomd setup`." }) });
  const keyFrom = process.env.BOXD_API_KEY ? (user.boxdKey === "keychain" && keychainGet() === process.env.BOXD_API_KEY ? "keychain" : "environment") : null;
  out.push({ step: "boxd key", ok: !!keyFrom && (await validBoxdKey(process.env.BOXD_API_KEY!)), detail: keyFrom ? `from the ${keyFrom}` : "none", ...(keyFrom ? {} : { hint: "Run `capcomd setup accounts`." }) });
  const auth = json(self(["auth", "status", "--json"]).stdout)?.profiles ?? [];
  for (const a of auth) out.push({ step: `${a.agent} login`, ok: !!a.present && a.valid !== false, detail: a.detail ?? (a.present ? a.store : "not logged in") });
  const repo = process.env.CAPCOMD_REPO ?? proj.env?.CAPCOMD_REPO;
  const target = proj.run?.target ?? process.env.CAPCOMD_MERGE_TARGET ?? proj.env?.CAPCOMD_MERGE_TARGET ?? "main";
  out.push({ step: "project", ok: !!repo, detail: repo ? `${repo} → ${target}${projPath ? ` (${projPath})` : " (environment)"}` : "no .capcomd/config.json here or above", ...(repo ? {} : { hint: "Run `capcomd setup project` in your repository." }) });
  const plugin = runs(claudeBin()) && claudePluginInstalled();
  const skill = existsSync(join(legacySkill(), "SKILL.md"));
  out.push({ step: "agent plugin", ok: plugin || skill, detail: plugin ? "capcomd plugin in Claude Code (MCP tools and skills)" : skill ? "Claude Code skill only (no MCP tools)" : "not installed", ...(plugin ? {} : { hint: `Run \`capcomd setup agent\`, or in Claude Code: \`/plugin install capcomd --marketplace ${pluginMarketplace()}\`.` }) });
  const S = await import("./service");
  // The engine this CLI talks to (CAPCOMD_ENDPOINT), not only the service's default port.
  const { localPort } = await import("../../core/engine-start");
  const st: any = await S.serviceStatus({ port: localPort() ?? undefined });
  out.push({ step: "engine", ok: st.running, detail: st.running ? `running on :${st.port}${st.installed ? " (service)" : ""}` : `not running${st.installed ? " (service installed)" : ""}`, ...(st.running ? {} : { hint: "`capcomd service install`, or `capcomd serve`." }) });
  return out;
}

export function formatSteps(steps: Step[]): string {
  return steps.map((s) => `  ${s.ok ? "✓" : "✗"} ${s.step.padEnd(16)} ${s.detail}${s.hint && !s.ok ? `\n      → ${s.hint}` : ""}`).join("\n");
}

/** The whole wizard (or one part: demo | accounts | project | agent | service). */
export async function setup(part: string | undefined, v: Values, log: (s: string) => void = (s) => console.log(s)): Promise<Step[]> {
  const p = prompter({ yes: v.yes === true });
  const all = !part || part === "all";
  const steps: Step[] = [];
  const section = (t: string) => log(`\n── ${t}`);
  if (part === "demo" || (all && v["skip-demo"] !== true && (v.demo === true || await p.confirm("Try capcomd locally first (fake agents, no accounts, about a minute)?", p.interactive)))) {
    section("Try it locally");
    steps.push(await demoStep(log));
    if (part === "demo") return steps;
    if (p.interactive && !(await p.confirm("Continue with the real setup (boxd, Claude/Codex logins, your repository)?", true))) return steps;
  }
  if (all || part === "accounts") {
    section("Accounts");
    const k = await boxdKeyStep(p, v);
    steps.push(k);
    if (k.ok) steps.push(...(await agentAccountsStep(p, v, log)));
    if (!k.ok && all) return steps;
  }
  if (all || part === "project") { section("Project"); steps.push(...(await projectStep(p, v))); }
  if (all || part === "agent") { section("Agent integration"); steps.push(...(await agentIntegrationStep(p, v))); }
  if (all || part === "service") { section("Engine"); steps.push(await serviceStep(p, v)); }
  return steps;
}
