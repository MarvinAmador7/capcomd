// Subscription auth profiles with fake CLIs in a host-exec FakeProvider.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "fs";
import { PassThrough } from "stream";
import { tmpdir } from "os";
import { join } from "path";
import { FakeProvider } from "../../src/providers/fake";
import { loadAgentConfig, credentialModeFor, egressFor, BASE_EGRESS } from "../../src/agents/config";
import { TokenFilter, AUTH_SHAPES } from "../../src/auth/interactive";
import { authLogin, authStatus, authLogout } from "../../src/auth/login";
import { readAuthLedger, writeAuthLedger, authSnapshotName } from "../../src/auth/profiles";
import { runAgent } from "../../src/agents/runner";
import { adapterFor, claudeAdapter, codexAdapter } from "../../src/agents/adapters";
import { FX_CODEX_LOGIN_REFUSED } from "../../src/plugins/agent-fx";
import { runPreflight } from "../../src/core/preflight";
import { secretsSync } from "../../src/env/secrets";
import { envBuild } from "../../src/env/build";
import { doctor, formatDoctor } from "../../src/env/doctor";
import { bareRepo } from "../merge/gitfixture";
import { taskBranch } from "../../src/merge/config";
import { stubFx } from "../helpers/fx-stub";

const TOKEN = "sk-ant-oat01-FAKEOAUTHTOKEN_abcdefghijklmnopqrstuvwxyz0123456789-XYZ";
const FAKE_CLAUDE = new URL("./fake-claude-login.sh", import.meta.url).pathname;
const FAKE_CODEX = new URL("./fake-codex-login.sh", import.meta.url).pathname;
const FAKE_FX = new URL("./fake-fx-login.sh", import.meta.url).pathname;
const ENV_SNAP = "capcomd-env-2f1eed2b11c528fc";

function setup(agent: "claude-code" | "codex" | "fx", over: Record<string, string> = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "capcomd-auth-"));
  const ledger = join(workdir, "auths.json");
  const log: any[] = [];
  const p = new FakeProvider({ hostExec: true, log });
  const cfg = loadAgentConfig({ CAPCOMD_AGENT: agent, CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_BIN: agent === "codex" ? FAKE_CODEX : agent === "fx" ? FAKE_FX : FAKE_CLAUDE, CAPCOMD_CREDENTIALS: "auto", ...over });
  const home = join(workdir, "home");
  mkdirSync(home, { recursive: true });
  stubFx(home);
  return { p, cfg, workdir, ledger, home, log };
}
function terminal(input?: string) {
  const out: string[] = [];
  const stdin = new PassThrough() as any;
  if (input) setTimeout(() => stdin.write(input), 150);
  return { out, stdin, stdout: (s: string) => out.push(s) };
}

describe("token filter", () => {
  test("captures a token split across chunks and ANSI codes; never emits it", () => {
    const f = new TokenFilter(AUTH_SHAPES);
    let shown = "";
    for (const c of ["Open https://claude.ai/x\nPaste code > ", "\n\x1b[32mtoken:\x1b[0m sk-", "ant-oat01-FAKEOAUTH", "TOKEN_abcdefghijklmnopqrstuvwxyz0123456789-XYZ\nbye\n"]) shown += f.push(c);
    shown += f.flush();
    expect(shown).not.toContain("FAKEOAUTH");
    expect(shown).toContain("https://claude.ai/x");
    expect(shown).toContain("Paste code > ");
    expect(shown).toContain("[token captured — hidden]");
    expect(f.tokens).toEqual([TOKEN]);
  });
});

describe("capcomd auth login|status|logout", () => {
  test("claude: setup-token streamed, code typed through, token captured; org key → token kept in private auth snapshot", async () => {
    const s = setup("claude-code");
    s.p.secretsDenied = true; // org-scoped boxd key
    writeFileSync(join(s.home, ".bash_history"), "ls\n");
    const t = terminal("BROWSERCODE\n");
    const logs: string[] = [];
    const res = await authLogin(s.p as any, "claude-code", { cfg: s.cfg, envSnapshot: ENV_SNAP, ledgerPath: s.ledger, stdout: t.stdout, stdin: t.stdin, log: (l) => logs.push(l), pollMs: 1 });
    const shown = t.out.join("") + logs.join("\n");
    expect(shown).toContain("https://claude.ai/oauth/authorize");
    expect(shown).not.toContain("FAKEOAUTHTOKEN");
    expect(shown).toContain("org-scoped keys need a member credential");
    expect(res.profile).toMatchObject({ agent: "claude-code", store: "snapshot", method: "setup-token", snapshot: "capcomd-auth-claude-2f1eed2b11c528fc", verified: true });
    expect(res.profile.snapshot).toBe(authSnapshotName("claude-code", ENV_SNAP));
    expect(s.p.snapshots.get(res.profile.snapshot!)!.status).toBe("ready");
    const f = join(s.home, ".capcomd-auth/claude.env");
    expect(readFileSync(f, "utf8")).toContain(TOKEN);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(existsSync(join(s.home, ".bash_history"))).toBe(false);
    expect(readAuthLedger(s.ledger)["claude-code"]!.snapshot).toBe(res.profile.snapshot);
    expect(readFileSync(s.ledger, "utf8")).not.toContain("FAKEOAUTH");
    // The token never travelled in any exec's argv or env.
    expect(JSON.stringify(s.log)).not.toContain("FAKEOAUTHTOKEN");
    expect(await s.p.list("")).toEqual([]);
  }, 30_000);

  test("claude: boxd secrets allowed → token as host-bound secret, no auth snapshot", async () => {
    const s = setup("claude-code");
    const t = terminal("BROWSERCODE\n");
    const res = await authLogin(s.p as any, "claude-code", { cfg: s.cfg, envSnapshot: ENV_SNAP, ledgerPath: s.ledger, stdout: t.stdout, stdin: t.stdin, pollMs: 1 });
    expect(res.profile).toMatchObject({ store: "secret", snapshot: undefined });
    expect(s.p.secrets.get("CLAUDE_CODE_OAUTH_TOKEN")).toMatchObject({ value: TOKEN, domains: ["api.anthropic.com"], scope: "private" });
    expect(existsSync(join(s.home, ".capcomd-auth/claude.env"))).toBe(false);
    expect(s.p.snapshots.size).toBe(0);
    expect(await authLogout(s.p as any, "claude-code", { ledgerPath: s.ledger })).toEqual(["secret CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(s.p.secrets.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
  }, 30_000);

  test("claude: wrong code → login fails, nothing saved", async () => {
    const s = setup("claude-code");
    const t = terminal("nope\n");
    await expect(authLogin(s.p as any, "claude-code", { cfg: s.cfg, envSnapshot: ENV_SNAP, ledgerPath: s.ledger, stdout: t.stdout, stdin: t.stdin, pollMs: 1 })).rejects.toThrow("login not completed");
    expect(readAuthLedger(s.ledger)).toEqual({});
    expect(s.p.snapshots.size).toBe(0);
  }, 30_000);

  test("codex: device-auth with file store, auth.json checked by shape only, snapshot; status valid → invalid; logout", async () => {
    const s = setup("codex");
    const t = terminal();
    const logs: string[] = [];
    const res = await authLogin(s.p as any, "codex", { cfg: s.cfg, envSnapshot: ENV_SNAP, ledgerPath: s.ledger, stdout: t.stdout, stdin: t.stdin, log: (l) => logs.push(l), pollMs: 1 });
    const shown = t.out.join("") + logs.join("\n");
    expect(shown).toContain("ABCD-1234");
    expect(shown).not.toContain("rt_FAKEREFRESH");
    expect(shown).not.toMatch(/eyJhbGci/);
    expect(res.profile).toMatchObject({ agent: "codex", store: "snapshot", method: "device-auth", snapshot: "capcomd-auth-codex-2f1eed2b11c528fc" });
    expect(readFileSync(join(s.home, ".codex/config.toml"), "utf8")).toContain('cli_auth_credentials_store = "file"');
    expect((await authStatus(s.p as any, s.cfg, { ledgerPath: s.ledger, agents: ["codex"] }))[0]).toMatchObject({ present: true, valid: true });
    rmSync(join(s.home, ".codex/auth.json"));
    expect((await authStatus(s.p as any, s.cfg, { ledgerPath: s.ledger, agents: ["codex"] }))[0]).toMatchObject({ valid: false });
    const all = await authStatus(s.p as any, s.cfg, { ledgerPath: s.ledger, verify: false });
    expect(all.find((l) => l.agent === "claude-code")).toMatchObject({ present: false });
    expect(await authLogout(s.p as any, "codex", { ledgerPath: s.ledger })).toEqual([res.profile.snapshot!]);
    expect(s.p.snapshots.size).toBe(0);
    expect(readAuthLedger(s.ledger)).toEqual({});
  }, 30_000);
});

/** What the host got back from every exec in the login VMs (only booleans and "ok" may come out of a login). */
function seenFromVm(p: FakeProvider): string[] {
  const seen: string[] = [];
  const exec = p.exec.bind(p);
  (p as any).exec = async (...a: Parameters<FakeProvider["exec"]>) => { const r = await exec(...a); seen.push(r.stdout, r.stderr); return r; };
  return seen;
}

describe("capcomd auth login fx (fx's own Vercel and Grok logins)", () => {
  test("vercel (the default): fx's device code shown, its session snapshotted like codex's; only booleans leave the VM; status; logout", async () => {
    const s = setup("fx");
    const seen = seenFromVm(s.p);
    const t = terminal();
    const logs: string[] = [];
    const res = await authLogin(s.p as any, "fx", { cfg: s.cfg, envSnapshot: ENV_SNAP, ledgerPath: s.ledger, stdout: t.stdout, stdin: t.stdin, log: (l) => logs.push(l), pollMs: 1 });
    const shown = t.out.join("") + logs.join("\n");
    expect(shown).toContain("WXYZ-9876");
    expect(shown).toContain("Signed in to Vercel");
    expect(shown).not.toContain("vcr_FAKEREFRESH");
    expect(shown).not.toMatch(/eyJhbGci/);
    expect(logs).toContain("fx sees the login (Vercel)");
    expect(res.profile).toMatchObject({ agent: "fx", store: "snapshot", method: "device-auth", login: "vercel", snapshot: "capcomd-auth-fx-2f1eed2b11c528fc", verified: true });
    expect(s.p.snapshots.get(res.profile.snapshot!)!.status).toBe("ready");
    const f = join(s.home, ".fx/auth.json");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    // fx printed its URL instead of opening a browser (the fake exits 6 otherwise), in a VM that reached Vercel's hosts.
    const loginVm = [...s.p.egress.values()][0]!;
    expect(loginVm).toEqual([...new Set([...BASE_EGRESS, "vercel.com", "api.vercel.com", "ai-gateway.vercel.sh"])]);
    // `fx status --json` said more (a session field); the host only ever got its boolean, and "ok" from the verify call.
    expect(seen.join("\n")).not.toContain("vcr_FAKEREFRESH");
    expect(seen.join("\n")).toContain('{"loggedIn":true}');
    expect(readFileSync(s.ledger, "utf8")).not.toContain("FAKEREFRESH");
    expect(await s.p.list("")).toEqual([]);

    // Unasked, status lists fx once it has a login, and checks it in a VM that reaches the same hosts.
    const all = await authStatus(s.p as any, s.cfg, { ledgerPath: s.ledger });
    expect(all.map((l) => l.agent)).toEqual(["claude-code", "codex", "fx"]);
    expect(all[2]).toMatchObject({ present: true, valid: true, login: "vercel" });
    expect(all[2]!.detail).toStartWith("Vercel login: fx answered via plan login");
    rmSync(f);
    expect((await authStatus(s.p as any, s.cfg, { ledgerPath: s.ledger, agents: ["fx"] }))[0]).toMatchObject({ valid: false });
    expect(await authLogout(s.p as any, "fx", { ledgerPath: s.ledger })).toEqual([res.profile.snapshot!]);
    expect(readAuthLedger(s.ledger)).toEqual({});
    expect((await authStatus(s.p as any, s.cfg, { ledgerPath: s.ledger, verify: false })).map((l) => l.agent)).toEqual(["claude-code", "codex"]);
  }, 30_000);

  test("grok: the browser URL, then the code pasted through the terminal; Grok's hosts only; fx runs on its grok provider", async () => {
    const s = setup("fx");
    const t = terminal("XAI-CODE-123\n");
    const logs: string[] = [];
    const res = await authLogin(s.p as any, "fx", { cfg: s.cfg, envSnapshot: ENV_SNAP, ledgerPath: s.ledger, stdout: t.stdout, stdin: t.stdin, log: (l) => logs.push(l), pollMs: 1, login: "grok" });
    const shown = t.out.join("");
    expect(shown).toContain("https://auth.x.ai/oauth2/auth");
    expect(shown).toContain("Paste the code shown by xAI");
    expect(shown).not.toContain("xrt_FAKEREFRESH");
    expect(res.profile).toMatchObject({ agent: "fx", method: "browser-code", login: "grok", snapshot: "capcomd-auth-fx-2f1eed2b11c528fc" });
    expect(existsSync(join(s.home, ".fx/grok-auth.json"))).toBe(true);
    expect(existsSync(join(s.home, ".fx/auth.json"))).toBe(false);
    expect([...s.p.egress.values()][0]).toEqual([...new Set([...BASE_EGRESS, "auth.x.ai", "accounts.x.ai", "cli-chat-proxy.grok.com", "api.x.ai"])]);
    // The verify call ran fx on the provider the login signed in to (the fake answers only with that provider's login).
    expect(logs.join("\n")).toContain("fx answered via plan login");
  }, 30_000);

  test("grok: a wrong code → the login fails, nothing saved", async () => {
    const s = setup("fx");
    const t = terminal("nope\n");
    await expect(authLogin(s.p as any, "fx", { cfg: s.cfg, envSnapshot: ENV_SNAP, ledgerPath: s.ledger, stdout: t.stdout, stdin: t.stdin, pollMs: 1, login: "grok" })).rejects.toThrow("login not completed");
    expect(readAuthLedger(s.ledger)).toEqual({});
    expect(s.p.snapshots.size).toBe(0);
  }, 30_000);

  test("fx itself sees no login after it (its status says missing) → the login fails before anything is saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-fx-missing-"));
    const bin = join(dir, "fx");
    writeFileSync(bin, `#!/bin/sh\nFAKE_FX_STATUS=missing exec ${FAKE_FX} "$@"\n`);
    chmodSync(bin, 0o755);
    const s = setup("fx", { CAPCOMD_AGENT_BIN: bin });
    const t = terminal();
    await expect(authLogin(s.p as any, "fx", { cfg: s.cfg, envSnapshot: ENV_SNAP, ledgerPath: s.ledger, stdout: t.stdout, stdin: t.stdin, pollMs: 1 })).rejects.toThrow("fx login vercel finished but fx sees no login; nothing was saved");
    expect(readAuthLedger(s.ledger)).toEqual({});
    expect(s.p.snapshots.size).toBe(0);
    expect(await s.p.list("")).toEqual([]);
  }, 30_000);

  test("codex (fx's ChatGPT login): refused before any machine starts, pointing to capcomd's codex provider", async () => {
    const s = setup("fx");
    const t = terminal();
    let ensured = 0;
    const ensure = s.p.ensure.bind(s.p);
    (s.p as any).ensure = async (...a: Parameters<FakeProvider["ensure"]>) => { ensured++; return ensure(...a); };
    await expect(authLogin(s.p as any, "fx", { cfg: s.cfg, envSnapshot: ENV_SNAP, ledgerPath: s.ledger, stdout: t.stdout, stdin: t.stdin, pollMs: 1, login: "codex" })).rejects.toThrow(FX_CODEX_LOGIN_REFUSED);
    expect(ensured).toBe(0);
    expect(s.log).toEqual([]);
    expect(readAuthLedger(s.ledger)).toEqual({});
    // Claude Code and Codex have one login each: naming one is a usage error, also before anything starts.
    await expect(authLogin(s.p as any, "codex", { cfg: s.cfg, envSnapshot: ENV_SNAP, ledgerPath: s.ledger, stdout: t.stdout, stdin: t.stdin, pollMs: 1, login: "vercel" })).rejects.toThrow("codex has one plan login");
    expect(ensured).toBe(0);
  });

  test("an fx login boots agents from its snapshot; doctor checks it in subscription mode with the logins' hosts", async () => {
    const s = setup("fx");
    mkdirSync(join(s.home, ".fx"), { recursive: true });
    writeFileSync(join(s.home, ".fx/auth.json"), "{}");
    const rep = await doctor(s.p, { cfg: s.cfg, snapshot: ENV_SNAP, source: {}, modes: { fx: "subscription" }, snapshots: { fx: "capcomd-auth-fx-x" } });
    expect(rep.agents.find((x) => x.agent === "fx")).toMatchObject({ ok: true, credential: { mode: "subscription" }, from: "capcomd-auth-fx-x" });
    const vm = [...s.p.egress.values()].find((e) => e.includes("vercel.com"))!;
    expect(vm).toEqual(expect.arrayContaining(["vercel.com", "api.vercel.com", "ai-gateway.vercel.sh", "auth.x.ai", "cli-chat-proxy.grok.com", "api.x.ai"]));
    // A ledger with an fx login makes subscription fx's mode, as for codex.
    const led = join(s.workdir, "fx-auths.json");
    writeAuthLedger({ fx: { agent: "fx", store: "snapshot", snapshot: "capcomd-auth-fx-x", method: "device-auth", login: "vercel", env: ENV_SNAP, createdAt: "t" } }, led);
    expect(credentialModeFor("fx", { CAPCOMD_AUTH_LEDGER: led })).toBe("subscription");
    expect(() => credentialModeFor("fx", { CAPCOMD_AUTH_LEDGER: led, AI_GATEWAY_API_KEY: "vck_x" })).toThrow("both AI_GATEWAY_API_KEY and a subscription login");
    expect(adapterFor("fx").kind).toBe("fx");
  }, 30_000);
});

describe("subscription mode in workers, preflight, doctor", () => {
  const profileLedger = (dir: string) => {
    const path = join(dir, "auths.json");
    writeAuthLedger({ "claude-code": { agent: "claude-code", store: "snapshot", snapshot: "capcomd-auth-claude-x", method: "setup-token", env: ENV_SNAP, createdAt: "t" }, codex: { agent: "codex", store: "snapshot", snapshot: "capcomd-auth-codex-x", method: "device-auth", env: ENV_SNAP, createdAt: "t" } }, path);
    return path;
  };

  test("auth is exactly one of apikey|subscription; subscription inferred when only a login exists; preflight needs no API keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capcomd-sub-"));
    const led = profileLedger(dir);
    expect(credentialModeFor("claude-code", { CAPCOMD_AUTH_LEDGER: led })).toBe("subscription");
    // Exactly one of apikey / subscription: neither or both is a config error, never a fallback.
    expect(() => credentialModeFor("codex", { CAPCOMD_AUTH_LEDGER: join(dir, "none.json") })).toThrow("no credentials configured");
    expect(() => credentialModeFor("codex", { CAPCOMD_AUTH_LEDGER: led, OPENAI_API_KEY: "sk-proj-x" })).toThrow("both OPENAI_API_KEY and a subscription login");
    expect(credentialModeFor("codex", { CAPCOMD_AUTH_LEDGER: join(dir, "none.json"), OPENAI_API_KEY: "sk-proj-x" })).toBe("auto");
    expect(credentialModeFor("codex", { CAPCOMD_AUTH_LEDGER: led, OPENAI_API_KEY: "sk-proj-x", CAPCOMD_AUTH: "subscription" })).toBe("subscription");
    expect(credentialModeFor("codex", { CAPCOMD_AUTH_LEDGER: led, CAPCOMD_CREDENTIALS: "env" })).toBe("env");
    expect(loadAgentConfig({ CAPCOMD_AGENT: "codex", CAPCOMD_AUTH_LEDGER: led }).egress).toEqual(["*"]); // open by default
    expect(egressFor("codex", "subscription")).toEqual(expect.arrayContaining(["chatgpt.com", "auth.openai.com"])); // a profile that narrows it
    for (const agent of ["claude-code", "codex"]) {
      const r = await runPreflight({ CAPCOMD_SANDBOX: "boxd", CAPCOMD_AGENT: agent, BOXD_API_KEY: "bxd_x", CAPCOMD_AUTH_LEDGER: led }, { boxdList: async () => [], fetch: (async () => { throw new Error("must not call the API"); }) as any });
      expect(r.every((c) => c.ok)).toBe(true);
      expect(r[1]!.detail).toContain("subscription login");
    }
    const missing = await runPreflight({ CAPCOMD_SANDBOX: "boxd", CAPCOMD_AGENT: "codex", BOXD_API_KEY: "bxd_x", CAPCOMD_CREDENTIALS: "subscription", CAPCOMD_AUTH_LEDGER: join(dir, "none.json") }, { boxdList: async () => [] });
    expect(missing[1]).toMatchObject({ ok: false });
    expect(missing[1]!.detail).toContain("capcomd auth login codex");
  });

  for (const a of [claudeAdapter, codexAdapter]) {
    test(`${a.kind} worker on a plan login: API keys dropped, login loaded, cost reported as subscription`, async () => {
      const r = await bareRepo();
      const workdir = mkdtempSync(join(tmpdir(), "capcomd-subrun-"));
      const p = new FakeProvider({ hostExec: true });
      // Even with API-key placeholders in the VM, the plan login wins.
      await secretsSync(p, { ANTHROPIC_API_KEY: "sk-ant-api03-SHOULDNOTUSE-0123456789", OPENAI_API_KEY: "sk-proj-SHOULDNOTUSE-0123456789" });
      const home = join(workdir, "home");
      if (a.kind === "claude-code") { mkdirSync(join(home, ".capcomd-auth"), { recursive: true }); writeFileSync(join(home, ".capcomd-auth/claude.env"), `export CLAUDE_CODE_OAUTH_TOKEN='${TOKEN}'\n`); }
      else { mkdirSync(join(home, ".codex"), { recursive: true }); writeFileSync(join(home, ".codex/auth.json"), '{"auth_mode":"chatgpt"}'); }
      const { id } = await p.ensure({ idemKey: `sub-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: ["github.com"], labels: {} });
      await p.waitReady(id, 1000);
      const cfg = loadAgentConfig({ CAPCOMD_AGENT: a.kind, CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_BIN: new URL(`../agents/fake-${a.kind === "codex" ? "codex" : "claude"}.sh`, import.meta.url).pathname, CAPCOMD_AGENT_POLL_MS: "50", CAPCOMD_CREDENTIALS: "subscription" });
      const task = { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal: "make the failing test pass" };
      const res = await runAgent(a, p, id, task, cfg, {});
      expect(res).toMatchObject({ credentialMode: "subscription", billing: "subscription", costUsd: 0 });
      expect(res.notionalCostUsd!).toBeGreaterThan(0);
      const seen = readFileSync(join(workdir, "task-1-e1/authseen.txt"), "utf8").trim();
      expect(seen).toBe(a.kind === "codex" ? "codex_home=set apikey=" : "oauth=set apikey=");
      // No login present → clear error.
      const p2 = new FakeProvider({ hostExec: true });
      const v = await p2.ensure({ idemKey: "n", isolated: true, ttlSeconds: 60, egressAllow: ["github.com"], labels: {} }); await p2.waitReady(v.id, 1000);
      const err = await runAgent(a, p2, v.id, { ...task, epoch: 2 }, loadAgentConfig({ CAPCOMD_AGENT: a.kind, CAPCOMD_AGENT_WORKDIR: mkdtempSync(join(tmpdir(), "x-")), CAPCOMD_AGENT_BIN: "/bin/false", CAPCOMD_CREDENTIALS: "subscription" }), {}).catch((e) => e);
      expect(err.kind).toBe("credentials");
      expect(err.message).toContain("capcomd auth login");
    }, 30_000);
  }

  const fxWorker = async (login: "vercel" | "grok", over: Record<string, string> = {}) => {
    const r = await bareRepo();
    const workdir = mkdtempSync(join(tmpdir(), "capcomd-subrun-fx-"));
    const p = new FakeProvider({ hostExec: true });
    await secretsSync(p, { AI_GATEWAY_API_KEY: "vck_SHOULDNOTUSE_0123456789abcdef" });
    const home = join(workdir, "home");
    stubFx(home);
    mkdirSync(join(home, ".fx"), { recursive: true });
    writeFileSync(join(home, login === "grok" ? ".fx/grok-auth.json" : ".fx/auth.json"), '{"refresh_token":"rt_x"}');
    // The ledger says which login it is, as `capcomd auth login fx [grok]` recorded it.
    const ledger = join(workdir, "auths.json");
    writeAuthLedger({ fx: { agent: "fx", store: "snapshot", snapshot: "capcomd-auth-fx-x", method: login === "grok" ? "browser-code" : "device-auth", login, env: ENV_SNAP, createdAt: "t" } }, ledger);
    const { id } = await p.ensure({ idemKey: `sub-fx-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: ["github.com"], labels: {} });
    await p.waitReady(id, 1000);
    const fake = new URL("../agents/fake-fx.mjs", import.meta.url).pathname;
    chmodSync(fake, 0o755);
    const cfg = loadAgentConfig({ CAPCOMD_AGENT: "fx", CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_BIN: fake, CAPCOMD_AGENT_POLL_MS: "50", CAPCOMD_CREDENTIALS: "subscription", CAPCOMD_AUTH_LEDGER: ledger, ...over });
    expect(cfg.planLogin).toBe(login);
    const task = { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal: "make the failing test pass" };
    const res = await runAgent(adapterFor("fx"), p, id, task, cfg, {});
    const seen = JSON.parse(readFileSync(join(workdir, "task-1-e1/fx-seen.json"), "utf8"));
    return { res, seen, home };
  };

  test("fx worker on a Grok plan login: the AI Gateway key placeholder dropped, fx run on its grok provider from its own folder; a plan, so no cost", async () => {
    const { res, seen, home } = await fxWorker("grok");
    expect(res).toMatchObject({ credentialMode: "subscription", billing: "subscription", costUsd: 0 });
    expect(res.notionalCostUsd).toBeGreaterThan(0);
    expect(seen).toMatchObject({ key: null, oidc: null });
    expect(seen.env).toMatchObject({ FX_PROVIDER: "grok", FX_HOME: join(home, ".fx") });
  }, 30_000);

  test("fx worker on a Vercel login: the AI Gateway bills the team per token, so its cost counts and its budget holds, as on a key", async () => {
    const { res, seen } = await fxWorker("vercel");
    expect(res).toMatchObject({ credentialMode: "subscription", billing: "api" });
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.costUsd).toBe(res.notionalCostUsd!);
    expect(seen).toMatchObject({ key: null, oidc: null });
    expect(seen.env).toMatchObject({ FX_PROVIDER: "gateway" });
    const capped = await fxWorker("vercel", { CAPCOMD_AGENT_MAX_BUDGET_USD: "0.01" });
    expect(capped.res.stopReason).toBe("max_budget_usd");
  }, 30_000);

  test("doctor in subscription mode boots the auth snapshot and verifies the login (no API keys)", async () => {
    const s = setup("codex");
    mkdirSync(join(s.home, ".codex"), { recursive: true });
    writeFileSync(join(s.home, ".codex/auth.json"), '{"auth_mode":"chatgpt"}');
    const rep = await doctor(s.p, { cfg: s.cfg, snapshot: ENV_SNAP, source: {}, modes: { codex: "subscription" }, snapshots: { codex: "capcomd-auth-codex-x" } });
    const c = rep.agents.find((x) => x.agent === "codex")!;
    expect(c).toMatchObject({ ok: true, credential: { mode: "subscription" }, from: "capcomd-auth-codex-x" });
    expect(formatDoctor(rep)).toContain("auth=subscription (capcomd-auth-codex-x)");
    expect(rep.agents.find((x) => x.agent === "claude-code")!.from).toBe(ENV_SNAP);
  }, 30_000);

  test("secrets sync is optional: org-scoped key → unavailable, not an error", async () => {
    const p = new FakeProvider(); p.secretsDenied = true;
    const lines = await secretsSync(p, { ANTHROPIC_API_KEY: "sk-ant-api03-ORGKEY-0123456789abcdef" });
    expect(lines[0]).toMatchObject({ status: "unavailable" });
    expect(lines[0]!.detail).toContain("member credential");
    expect(JSON.stringify(lines)).not.toContain("ORGKEY");
  });

  test("env build with no repo skips the VM when the snapshot is up to date", async () => {
    const s = setup("codex");
    let boots = 0;
    const p = new Proxy(s.p, { get(t, k, r) { if (k === "ensure") return (...a: any[]) => { boots++; return (t as any).ensure(...a); }; const v = Reflect.get(t, k, r); return typeof v === "function" ? v.bind(t) : v; } }) as any;
    mkdirSync(join(s.home, "npm/bin"), { recursive: true });
    for (const b of ["claude", "codex"]) { writeFileSync(join(s.home, "npm/bin", b), "#!/bin/sh\necho 1.0.0\n"); Bun.spawnSync(["chmod", "+x", join(s.home, "npm/bin", b)]); }
    const led = join(s.workdir, "envs.json");
    const first = await envBuild(p, { cfg: s.cfg, ledgerPath: led, pollMs: 1 });
    expect(boots).toBe(1);
    const again = await envBuild(p, { cfg: s.cfg, ledgerPath: led, pollMs: 1 });
    expect(again).toMatchObject({ cached: true, name: first.name });
    expect(boots).toBe(1);
  }, 30_000);
});
