// Subscription auth profiles with fake CLIs in a host-exec FakeProvider.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "fs";
import { PassThrough } from "stream";
import { tmpdir } from "os";
import { join } from "path";
import { FakeProvider } from "../../src/providers/fake";
import { loadAgentConfig, credentialModeFor } from "../../src/agents/config";
import { TokenFilter, AUTH_SHAPES } from "../../src/auth/interactive";
import { authLogin, authStatus, authLogout } from "../../src/auth/login";
import { readAuthLedger, writeAuthLedger, authSnapshotName } from "../../src/auth/profiles";
import { runAgent } from "../../src/agents/runner";
import { claudeAdapter, codexAdapter } from "../../src/agents/adapters";
import { runPreflight } from "../../src/core/preflight";
import { secretsSync } from "../../src/env/secrets";
import { envBuild } from "../../src/env/build";
import { doctor, formatDoctor } from "../../src/env/doctor";
import { bareRepo } from "../merge/gitfixture";
import { taskBranch } from "../../src/merge/config";

const TOKEN = "sk-ant-oat01-FAKEOAUTHTOKEN_abcdefghijklmnopqrstuvwxyz0123456789-XYZ";
const FAKE_CLAUDE = new URL("./fake-claude-login.sh", import.meta.url).pathname;
const FAKE_CODEX = new URL("./fake-codex-login.sh", import.meta.url).pathname;
const ENV_SNAP = "capcomd-env-2f1eed2b11c528fc";

function setup(agent: "claude-code" | "codex", over: Record<string, string> = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "capcomd-auth-"));
  const ledger = join(workdir, "auths.json");
  const log: any[] = [];
  const p = new FakeProvider({ hostExec: true, log });
  const cfg = loadAgentConfig({ CAPCOMD_AGENT: agent, CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_BIN: agent === "codex" ? FAKE_CODEX : FAKE_CLAUDE, CAPCOMD_CREDENTIALS: "auto", ...over });
  const home = join(workdir, "home");
  mkdirSync(home, { recursive: true });
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
    expect(loadAgentConfig({ CAPCOMD_AGENT: "codex", CAPCOMD_AUTH_LEDGER: led }).egress).toEqual(expect.arrayContaining(["chatgpt.com", "auth.openai.com"]));
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
