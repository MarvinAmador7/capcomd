// `capcomd auth login|status|logout` (ADR-015 §5): plan logins for Claude Code, Codex and fx (a Vercel or Grok login).
import type { SandboxProvider } from "../providers/sandbox";
import { isSecretPlatform, type SecretPlatform, type SnapshotPlatform, type SnapshotInfo } from "../env/platform";
import type { AgentConfig } from "../agents/config";
import { BASE_EGRESS } from "../agents/config";
import { adapterFor } from "../agents/adapters";
import type { AgentAdapter } from "../agents/types";
import { agentHome, agentPath, detectScript, detectedUsable, installedBin, installScript, parseDetect, sq } from "../agents/runner";
import { Redactor } from "../agents/redact";
import { AUTH_SHAPES, CLAUDE_TOKEN, bridge, hasInteractive, type InteractiveSession } from "./interactive";
import { CLAUDE_TOKEN_SECRET, PROFILE_AGENTS, authSnapshotName, readAuthLedger, writeAuthLedger, type AuthProfile, type ProfileAgent } from "./profiles";

type P = SandboxProvider & SnapshotPlatform & Partial<SecretPlatform> & { streamExec?: any };

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
  /** Which of the provider's plan logins (`describe().logins`: fx's vercel or grok); absent: its first. */
  login?: string;
}
export interface LoginResult { profile: AuthProfile; verified: boolean; loginMs: number; totalMs: number }

export const parseAgentArg = (a: string | undefined): ProfileAgent => {
  if (a === "claude" || a === "claude-code") return "claude-code";
  if (a === "codex") return "codex";
  if (a === "fx") return "fx";
  throw new Error("usage: capcomd auth login|status|logout claude|codex|fx");
};
/** The agent's name on the command line (`capcomd auth login <name>`). */
export const cliName = (agent: ProfileAgent) => (agent === "claude-code" ? "claude" : agent);

/**
 * Which of an agent's plan logins to make (`capcomd auth login fx grok`): the named one, else the first it offers;
 * undefined for a CLI with a single login. A login capcomd can't make headless (`refused`) is refused here, before any
 * machine starts, with the provider's reason and what to use instead.
 */
export function parseLoginArg(agent: ProfileAgent, name: string | undefined): string | undefined {
  const logins = adapterFor(agent).logins;
  if (!logins) {
    if (name !== undefined) throw new Error(`${cliName(agent)} has one plan login: run \`capcomd auth login ${cliName(agent)}\``);
    return undefined;
  }
  const l = name === undefined ? logins.find((x) => !x.refused) : logins.find((x) => x.name === name);
  if (!l) throw new Error(`${cliName(agent)} has no login ${JSON.stringify(name)}: one of ${logins.filter((x) => !x.refused).map((x) => x.name).join(", ")}`);
  if (l.refused) throw new Error(l.refused);
  return l.name;
}
/** The hosts a login VM for this login reaches besides BASE_EGRESS: the named login's, else the provider's. */
export function loginEgressFor(a: AgentAdapter, login?: string): string[] {
  return (login ? a.logins?.find((l) => l.name === login)?.egress : undefined) ?? a.loginEgress;
}
/** The login's name for people ("Vercel", "Grok"), for a provider with several. */
export const loginLabel = (a: AgentAdapter, login?: string) => (login ? a.logins?.find((l) => l.name === login)?.label ?? login : undefined);
/** The login command as people know it (`fx login grok`), without the environment it runs with. */
const shownLogin = (a: AgentAdapter, login?: string) => { const argv = a.loginCommand(a.bin, login); return argv.slice(Math.max(0, argv.indexOf(a.bin))).join(" "); };

/** Boots a login VM, recorded as capcomd's own (a login) until `destroyVm`, so it never reads as left behind. */
const releases = new Map<string, () => void>();
export async function bootVm(p: P, a: AgentAdapter, snapshot: string, purpose: string, t0: number, egress: string[] = a.loginEgress) {
  const idemKey = `capcomd-${purpose}-${a.kind}-${t0}`;
  const { recordJobMachine } = await import("../providers/machines");
  const { sandboxName } = await import("../providers/registry");
  let place: string | null = null;
  try { place = sandboxName(); } catch { /* unknown: recorded as such */ }
  const release = recordJobMachine({ idemKey, sandbox: place, kind: "login", purpose, agent: a.kind, ttlSeconds: 1800 });
  try {
    // A release-archive CLI (fx) the image lacks is installed in the VM (findBin): its release host too.
    const archive = a.install ? Object.values(a.install.assets).map((x) => new URL(x.url).host) : [];
    const { id } = await p.ensure({ idemKey, isolated: true, ttlSeconds: 1800, egressAllow: [...new Set([...BASE_EGRESS, ...egress, ...archive])], labels: { purpose }, fromSnapshot: snapshot });
    releases.set(id, release);
    await p.waitReady(id, 120_000);
    return id;
  } catch (e) {
    release();
    throw e;
  }
}
export async function destroyVm(p: P, id: string) {
  await p.destroy(id).catch(() => {});
  releases.get(id)?.();
  releases.delete(id);
}

/** The CLI in the VM. One installed from a release archive (fx) that the image lacks, or has at another version, is
 *  installed here at its pin, as an agent's VM does when it starts, so a login doesn't wait on `capcomd env build`. */
export async function findBin(p: P, id: string, a: AgentAdapter, cfg: AgentConfig, env: Record<string, string>) {
  if (cfg.agentBin) return cfg.agentBin;
  const home = agentHome(cfg);
  const d = parseDetect((await p.exec(id, ["sh", "-c", detectScript(a, home)], { env })).stdout);
  if (detectedUsable(a, cfg, d)) return d.bin!;
  if (!a.install) {
    if (d.bin) return d.bin;
    throw new Error(`${a.bin} is not installed in the env snapshot; run \`capcomd env build\``);
  }
  const res = await p.exec(id, ["sh", "-c", installScript(cfg, home, a)], { env, timeoutMs: 600_000 });
  if (res.code !== 0) throw new Error(`${a.bin} ${a.pinnedVersion(cfg)} couldn't be installed in the login VM (exit ${res.code}): ${new Redactor([]).text((res.stderr || res.stdout).replace(/\s+/g, " ")).slice(-300)}`);
  return installedBin(a, home);
}

/** Headless check that the login works ("ok" from the model). Never prints credentials. */
export async function verifyLogin(p: P, id: string, a: AgentAdapter, cfg: AgentConfig, bin: string): Promise<{ ok: boolean; detail: string }> {
  const home = agentHome(cfg);
  const env = { PATH: agentPath(home), HOME: home };
  const chk = (await p.exec(id, ["sh", "-c", a.subscriptionCheck(home, sq)], { env })).stdout;
  if (!/secret|file/.test(chk)) return { ok: false, detail: "no login present in the VM" };
  const res = await p.exec(id, ["sh", "-c", `${a.subscriptionPrelude(home, sq)}; cd /tmp && ${a.verifyCommand(bin, sq, cfg.model)}`], { env, timeoutMs: 120_000 });
  const r = new Redactor([]);
  if (res.code === 0 && /\bok\b/i.test(res.stdout)) return { ok: true, detail: `${a.kind} answered via plan login (${chk.trim().split("\n").join("+")})` };
  const out = r.text((res.stderr || res.stdout).replace(/\s+/g, " "));
  // The login worked; the account behind it won't pay for this model (an AI Gateway with no credit, a Token Pass that
  // covers only its featured models). Say so, and how to pick another model, rather than leave only the provider's text.
  const billing = /insufficient_funds|Token Pass|credit balance/i.test(out)
    ? ` The login itself worked: the account won't pay for ${cfg.model ? `the model ${cfg.model}` : `${a.bin}'s default model`}. Add credit there, or run on a model it covers (CAPCOMD_AGENT_MODEL or the profile's \`model\`; on a Vercel Token Pass, one of its featured models) and log in again.`
    : "";
  return { ok: false, detail: `verify failed (exit ${res.code}): ${out.slice(-300)}${billing}` };
}

export async function authLogin(p: P, agent: ProfileAgent, o: LoginOptions): Promise<LoginResult> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const log = o.log ?? (() => {});
  const a = adapterFor(agent);
  // A login capcomd can't make (fx's ChatGPT one) is refused before any machine starts.
  const login = parseLoginArg(agent, o.login);
  const home = agentHome(o.cfg);
  const env = { PATH: agentPath(home), HOME: home, CODEX_HOME: `${home}/.codex`, TERM: "xterm-256color" };
  if (!hasInteractive(p)) throw new Error("this sandbox has no interactive exec (need boxd streamExec)");
  const id = await bootVm(p, a, o.envSnapshot, "auth-login", t0, loginEgressFor(a, login));
  log(`login vm ready from ${o.envSnapshot} (${now() - t0}ms)`);
  try {
    const bin = await findBin(p, id, a, o.cfg, env);
    if (agent === "codex") {
      // File store so the login lands in $CODEX_HOME/auth.json (and thus in the snapshot).
      await p.exec(id, ["sh", "-c", `mkdir -p "$CODEX_HOME" && f="$CODEX_HOME/config.toml" && { grep -q '^cli_auth_credentials_store' "$f" 2>/dev/null || printf 'cli_auth_credentials_store = "file"\\n' >> "$f"; }`], { env });
    }
    // 1. Interactive login, streamed to this terminal; tokens are captured and masked.
    const t1 = now();
    const session: InteractiveSession = await (p as any).streamExec(id, a.loginCommand(bin, login), { env, tty: true, cols: 500, rows: 50 });
    const { code, tokens } = await bridge(session, { patterns: AUTH_SHAPES, stdout: o.stdout, stdin: o.stdin, timeoutMs: o.loginTimeoutMs ?? 15 * 60_000 });
    const loginMs = now() - t1;
    if (code !== 0) throw new Error(`${shownLogin(a, login)} exited ${code}; login not completed`);

    // 2. Store the credential.
    let store: AuthProfile["store"] = "snapshot";
    if (agent === "claude-code") {
      const token = tokens.find((t) => CLAUDE_TOKEN.test(t));
      if (!token) throw new Error("claude setup-token finished but no token was seen in its output");
      const want = o.store ?? "auto";
      if (want === "secret" && !isSecretPlatform(p)) throw new Error("this sandbox provider has no host-bound secrets; keep the token in the auth snapshot (CAPCOMD_AUTH_STORE=snapshot)");
      if (want !== "snapshot" && isSecretPlatform(p)) {
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
    } else if (agent === "codex") {
      // Only booleans leave the VM.
      const shape = (await p.exec(id, ["sh", "-c", `node -e 'const j=JSON.parse(require("fs").readFileSync(process.env.CODEX_HOME+"/auth.json","utf8"));console.log(JSON.stringify({mode:j.auth_mode??null,refresh:!!(j.tokens&&j.tokens.refresh_token)}))' 2>/dev/null || echo '{}'`], { env })).stdout.trim();
      let s: any = {}; try { s = JSON.parse(shape.split("\n").pop() || "{}"); } catch {}
      if (!s.refresh) throw new Error(`codex login left no usable auth.json (auth_mode=${s.mode ?? "?"})`);
      log(`auth.json present (auth_mode=${s.mode}, refresh token: yes)`);
    } else if (a.loginCheck) {
      // The CLI's own word on the login (fx: `fx status --json`): only its boolean leaves the VM.
      const seen = (await p.exec(id, ["sh", "-c", `${a.subscriptionPrelude(home, sq)}; ${a.loginCheck(bin, sq)}`], { env })).stdout.trim().split("\n").pop() ?? "";
      let loggedIn = false;
      try { loggedIn = JSON.parse(seen)?.loggedIn === true; } catch { /* not its line: no login */ }
      if (!loggedIn) throw new Error(`${shownLogin(a, login)} finished but ${a.bin} sees no login; nothing was saved`);
      log(`${a.bin} sees the login${login ? ` (${loginLabel(a, login)})` : ""}`);
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
    const method: AuthProfile["method"] = agent === "claude-code" ? "setup-token" : login === "grok" ? "browser-code" : "device-auth";
    const profile: AuthProfile = { agent, snapshot, store, method, ...(login ? { login } : {}), env: o.envSnapshot, createdAt: new Date().toISOString(), verifiedAt: new Date().toISOString(), verified: true };
    writeAuthLedger({ ...l, [agent]: profile }, o.ledgerPath);
    return { profile, verified: true, loginMs, totalMs: now() - t0 };
  } finally {
    await destroyVm(p, id);
  }
}

export interface StatusLine {
  agent: ProfileAgent; present: boolean; snapshot?: string; store?: string; snapshotStatus?: string; valid?: boolean; detail: string;
  /** Which of the provider's plan logins it is (fx: vercel or grok). */
  login?: string;
}

/** Each plan login's state. Unasked: Claude Code's and Codex's always (as before), another agent's (fx) when it has one. */
export async function authStatus(p: P, cfg: AgentConfig, o: { ledgerPath?: string; verify?: boolean; agents?: ProfileAgent[] } = {}): Promise<StatusLine[]> {
  const l = readAuthLedger(o.ledgerPath);
  const out: StatusLine[] = [];
  for (const agent of o.agents ?? PROFILE_AGENTS.filter((a) => a === "claude-code" || a === "codex" || l[a])) {
    const prof = l[agent];
    if (!prof) { out.push({ agent, present: false, detail: `no profile (capcomd auth login ${cliName(agent)})` }); continue; }
    const line: StatusLine = { agent, present: true, snapshot: prof.snapshot, store: prof.store, ...(prof.login ? { login: prof.login } : {}), detail: "" };
    const label = loginLabel(adapterFor(agent), prof.login);
    const boot = prof.snapshot ?? prof.env;
    if (prof.snapshot) {
      const st = await p.snapshotGet(prof.snapshot);
      line.snapshotStatus = st?.status ?? "missing";
      if (!st) { line.valid = false; line.detail = "snapshot missing; run auth login again"; out.push(line); continue; }
    }
    if (o.verify === false) { line.detail = `${label ? `${label} login, ` : ""}not verified (last ok ${prof.verifiedAt ?? "never"})`; out.push(line); continue; }
    const a = adapterFor(agent);
    const id = await bootVm(p, a, boot, "auth-status", Date.now(), loginEgressFor(a, prof.login));
    try {
      const home = agentHome(cfg);
      const bin = await findBin(p, id, a, cfg, { PATH: agentPath(home), HOME: home });
      const v = await verifyLogin(p, id, a, cfg, bin);
      line.valid = v.ok; line.detail = label ? `${label} login: ${v.detail}` : v.detail;
      writeAuthLedger({ ...readAuthLedger(o.ledgerPath), [agent]: { ...prof, verified: v.ok, verifiedAt: new Date().toISOString() } }, o.ledgerPath);
    } finally { await destroyVm(p, id); }
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
