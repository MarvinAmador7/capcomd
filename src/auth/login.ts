// `capcomd auth login|status|logout` (ADR-015 §5): plan logins for Claude Code / Codex.
import type { SandboxProvider } from "../providers/sandbox";
import type { EnvPlatform, SnapshotInfo } from "../env/platform";
import type { AgentConfig } from "../agents/config";
import { BASE_EGRESS } from "../agents/config";
import { adapterFor } from "../agents/adapters";
import type { AgentAdapter } from "../agents/types";
import { agentHome, agentPath, detectScript, parseDetect, sq } from "../agents/runner";
import { Redactor } from "../agents/redact";
import { AUTH_SHAPES, CLAUDE_TOKEN, bridge, hasInteractive, type InteractiveSession } from "./interactive";
import { CLAUDE_TOKEN_SECRET, authSnapshotName, readAuthLedger, writeAuthLedger, type AuthProfile, type ProfileAgent } from "./profiles";

type P = SandboxProvider & EnvPlatform & { streamExec?: any; secretDelete?: (n: string) => Promise<void> };

export interface LoginOptions {
  cfg: AgentConfig;
  envSnapshot: string;
  ledgerPath?: string;
  /** auto: boxd secret for the claude token when allowed, else the snapshot. */
  store?: "auto" | "secret" | "snapshot";
  stdout?: (s: string) => void;
  stdin?: NodeJS.ReadStream | null;
  log?: (s: string) => void;
  loginTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
}
export interface LoginResult { profile: AuthProfile; verified: boolean; loginMs: number; totalMs: number }

export const parseAgentArg = (a: string | undefined): ProfileAgent => {
  if (a === "claude" || a === "claude-code") return "claude-code";
  if (a === "codex") return "codex";
  throw new Error("usage: capcomd auth login|status|logout claude|codex");
};

async function bootVm(p: P, a: AgentAdapter, snapshot: string, purpose: string, t0: number) {
  const { id } = await p.ensure({ idemKey: `capcomd-${purpose}-${a.kind}-${t0}`, isolated: true, ttlSeconds: 1800, egressAllow: [...BASE_EGRESS, ...a.loginEgress], labels: { purpose }, fromSnapshot: snapshot });
  await p.waitReady(id, 120_000);
  return id;
}

async function findBin(p: P, id: string, a: AgentAdapter, cfg: AgentConfig, env: Record<string, string>) {
  if (cfg.agentBin) return cfg.agentBin;
  const d = parseDetect((await p.exec(id, ["sh", "-c", detectScript(a)], { env })).stdout);
  if (!d.bin) throw new Error(`${a.bin} is not installed in the env snapshot; run \`capcomd env build\``);
  return d.bin;
}

/** Headless check that the login works ("ok" from the model). Never prints credentials. */
export async function verifyLogin(p: P, id: string, a: AgentAdapter, cfg: AgentConfig, bin: string): Promise<{ ok: boolean; detail: string }> {
  const home = agentHome(cfg);
  const env = { PATH: agentPath(home), HOME: home };
  const chk = (await p.exec(id, ["sh", "-c", a.subscriptionCheck(home, sq)], { env })).stdout;
  if (!/secret|file/.test(chk)) return { ok: false, detail: "no login present in the VM" };
  const res = await p.exec(id, ["sh", "-c", `${a.subscriptionPrelude(home, sq)}; cd /tmp && ${a.verifyCommand(bin, sq)}`], { env, timeoutMs: 120_000 });
  const r = new Redactor([]);
  if (res.code === 0 && /\bok\b/i.test(res.stdout)) return { ok: true, detail: `${a.kind} answered via plan login (${chk.trim().split("\n").join("+")})` };
  return { ok: false, detail: `verify failed (exit ${res.code}): ${r.text((res.stderr || res.stdout).replace(/\s+/g, " ")).slice(-300)}` };
}

export async function authLogin(p: P, agent: ProfileAgent, o: LoginOptions): Promise<LoginResult> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const log = o.log ?? (() => {});
  const a = adapterFor(agent);
  const home = agentHome(o.cfg);
  const env = { PATH: agentPath(home), HOME: home, CODEX_HOME: `${home}/.codex`, TERM: "xterm-256color" };
  if (!hasInteractive(p)) throw new Error("this sandbox has no interactive exec (need boxd streamExec)");
  const id = await bootVm(p, a, o.envSnapshot, "auth-login", t0);
  log(`login vm ready from ${o.envSnapshot} (${now() - t0}ms)`);
  try {
    const bin = await findBin(p, id, a, o.cfg, env);
    if (agent === "codex") {
      // File store so the login lands in $CODEX_HOME/auth.json (and thus in the snapshot).
      await p.exec(id, ["sh", "-c", `mkdir -p "$CODEX_HOME" && f="$CODEX_HOME/config.toml" && { grep -q '^cli_auth_credentials_store' "$f" 2>/dev/null || printf 'cli_auth_credentials_store = "file"\\n' >> "$f"; }`], { env });
    }
    // 1. Interactive login, streamed to this terminal; tokens are captured and masked.
    const t1 = now();
    const session: InteractiveSession = await (p as any).streamExec(id, a.loginCommand(bin), { env, tty: true, cols: 500, rows: 50 });
    const { code, tokens } = await bridge(session, { patterns: AUTH_SHAPES, stdout: o.stdout, stdin: o.stdin, timeoutMs: o.loginTimeoutMs ?? 15 * 60_000 });
    const loginMs = now() - t1;
    if (code !== 0) throw new Error(`${a.loginCommand("").join(" ").trim()} exited ${code}; login not completed`);

    // 2. Store the credential.
    let store: AuthProfile["store"] = "snapshot";
    if (agent === "claude-code") {
      const token = tokens.find((t) => CLAUDE_TOKEN.test(t));
      if (!token) throw new Error("claude setup-token finished but no token was seen in its output");
      const want = o.store ?? "auto";
      if (want !== "snapshot") {
        try {
          await p.secretSet(CLAUDE_TOKEN_SECRET, token, { domains: ["api.anthropic.com"], scope: "private" });
          store = "secret";
          log(`token stored as boxd host-bound secret ${CLAUDE_TOKEN_SECRET} (api.anthropic.com)`);
        } catch (e) {
          if (want === "secret") throw new Error(`boxd secrets unavailable (${new Redactor([token]).text(String((e as Error)?.message ?? e)).slice(0, 160)})`);
          log("boxd secrets unavailable for this key (org-scoped keys need a member credential); keeping the token in the private auth snapshot");
        }
      }
      if (store === "snapshot") {
        await p.exec(id, ["sh", "-c", `mkdir -p ${sq(`${home}/.capcomd-auth`)} && chmod 700 ${sq(`${home}/.capcomd-auth`)}`], { env });
        await p.upload(id, `${home}/.capcomd-auth/claude.env`, new TextEncoder().encode(`export CLAUDE_CODE_OAUTH_TOKEN='${token}'\n`));
        await p.exec(id, ["sh", "-c", `chmod 600 ${sq(`${home}/.capcomd-auth/claude.env`)}`], { env });
      }
    } else {
      // Only booleans leave the VM.
      const shape = (await p.exec(id, ["sh", "-c", `node -e 'const j=JSON.parse(require("fs").readFileSync(process.env.CODEX_HOME+"/auth.json","utf8"));console.log(JSON.stringify({mode:j.auth_mode??null,refresh:!!(j.tokens&&j.tokens.refresh_token)}))' 2>/dev/null || echo '{}'`], { env })).stdout.trim();
      let s: any = {}; try { s = JSON.parse(shape.split("\n").pop() || "{}"); } catch {}
      if (!s.refresh) throw new Error(`codex login left no usable auth.json (auth_mode=${s.mode ?? "?"})`);
      log(`auth.json present (auth_mode=${s.mode}, refresh token: yes)`);
    }

    // 3. Verify with a real headless call.
    const v = await verifyLogin(p, id, a, o.cfg, bin);
    log(v.detail);
    if (!v.ok) throw new Error(`login verification failed: ${v.detail}`);

    // 4. Scrub shell history only (auth files stay), then snapshot.
    await p.exec(id, ["sh", "-c", `rm -f ${sq(home)}/.bash_history ${sq(home)}/.zsh_history ${sq(home)}/.node_repl_history /root/.bash_history /root/.zsh_history 2>/dev/null; history -c 2>/dev/null; true`], { env });
    const l = readAuthLedger(o.ledgerPath);
    const old = l[agent];
    let snapshot: string | undefined;
    if (store === "snapshot") {
      snapshot = authSnapshotName(agent, o.envSnapshot);
      if (await p.snapshotGet(snapshot)) await p.snapshotDelete(snapshot);
      await p.snapshotCreate(id, snapshot);
      const deadline = now() + 15 * 60_000;
      let st: SnapshotInfo | null = null;
      while ((st = await p.snapshotGet(snapshot))?.status !== "ready") {
        if (st?.status === "failed" || now() > deadline) throw new Error(`auth snapshot ${snapshot} ${st?.status ?? "missing"}`);
        await new Promise((r) => setTimeout(r, o.pollMs ?? 3000));
      }
      log(`auth profile snapshot ${snapshot} ready (private to your boxd account)`);
    }
    if (old?.snapshot && old.snapshot !== snapshot) await p.snapshotDelete(old.snapshot).catch(() => {});
    const profile: AuthProfile = { agent, snapshot, store, method: agent === "claude-code" ? "setup-token" : "device-auth", env: o.envSnapshot, createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), verified: true };
    writeAuthLedger({ ...l, [agent]: profile }, o.ledgerPath);
    return { profile, verified: true, loginMs, totalMs: now() - t0 };
  } finally {
    await p.destroy(id).catch(() => {});
  }
}

export interface StatusLine { agent: ProfileAgent; present: boolean; snapshot?: string; store?: string; snapshotStatus?: string; valid?: boolean; detail: string }

export async function authStatus(p: P, cfg: AgentConfig, o: { ledgerPath?: string; verify?: boolean; agents?: ProfileAgent[] } = {}): Promise<StatusLine[]> {
  const l = readAuthLedger(o.ledgerPath);
  const out: StatusLine[] = [];
  for (const agent of o.agents ?? (["claude-code", "codex"] as ProfileAgent[])) {
    const prof = l[agent];
    if (!prof) { out.push({ agent, present: false, detail: `no profile (capcomd auth login ${agent === "codex" ? "codex" : "claude"})` }); continue; }
    const line: StatusLine = { agent, present: true, snapshot: prof.snapshot, store: prof.store, detail: "" };
    const boot = prof.snapshot ?? prof.env;
    if (prof.snapshot) {
      const st = await p.snapshotGet(prof.snapshot);
      line.snapshotStatus = st?.status ?? "missing";
      if (!st) { line.valid = false; line.detail = "snapshot missing; run auth login again"; out.push(line); continue; }
    }
    if (o.verify === false) { line.detail = `not verified (last ok ${prof.verifiedAt ?? "never"})`; out.push(line); continue; }
    const a = adapterFor(agent);
    const id = await bootVm(p, a, boot, "auth-status", Date.now());
    try {
      const home = agentHome(cfg);
      const bin = await findBin(p, id, a, cfg, { PATH: agentPath(home), HOME: home });
      const v = await verifyLogin(p, id, a, cfg, bin);
      line.valid = v.ok; line.detail = v.detail;
      writeAuthLedger({ ...readAuthLedger(o.ledgerPath), [agent]: { ...prof, verified: v.ok, verifiedAt: new Date().toISOString() } }, o.ledgerPath);
    } finally { await p.destroy(id).catch(() => {}); }
    out.push(line);
  }
  return out;
}

export async function authLogout(p: P, agent: ProfileAgent, o: { ledgerPath?: string } = {}): Promise<string[]> {
  const l = readAuthLedger(o.ledgerPath);
  const prof = l[agent];
  const removed: string[] = [];
  if (prof?.snapshot) { await p.snapshotDelete(prof.snapshot).catch((e) => { if (!/not.?found/i.test(String(e?.message))) throw e; }); removed.push(prof.snapshot); }
  if (prof?.store === "secret" && p.secretDelete) { await p.secretDelete(CLAUDE_TOKEN_SECRET).catch(() => {}); removed.push(`secret ${CLAUDE_TOKEN_SECRET}`); }
  delete l[agent];
  writeAuthLedger(l, o.ledgerPath);
  return removed;
}
