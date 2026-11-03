// A plan login on a place with snapshots but no host-bound secrets (Docker) is an image: the env image of its day plus
// the login's credential files. After `capcomd env build` makes a new env image, agents with that login would still
// boot from the old one (its CLIs, its warm template) until the user logs in again. `carryLogins` moves each such login
// onto the new env image instead: it reads only the login's credential files from the old login image, writes them
// into a container of the new env image and saves that as the new login image. The env image itself never holds a
// login (its own secret scan ran before it was saved, and nothing here writes to it). A login that can't be moved keeps
// working from its old image, and the result says what to run.
import type { SandboxProvider } from "../providers/sandbox";
import type { SnapshotInfo, SnapshotPlatform } from "../env/platform";
import type { AgentConfig } from "../agents/config";
import { adapterFor } from "../agents/adapters";
import { agentHome, agentPath, sq } from "../agents/runner";
import { Redactor } from "../agents/redact";
import { bootVm, destroyVm } from "./login";
import { authSnapshotName, readAuthLedger, writeAuthLedger, type AuthProfile, type ProfileAgent } from "./profiles";

type P = SandboxProvider & SnapshotPlatform;

/** The files a plan login keeps in the agent home: all that moves to a new env image (each only if present). */
export function loginFiles(agent: ProfileAgent, home: string): string[] {
  return agent === "claude-code"
    // `claude setup-token`'s token (capcomd writes it), and a `claude login`'s credentials when one is there.
    ? [`${home}/.capcomd-auth/claude.env`, `${home}/.claude/.credentials.json`]
    // `codex login`'s file store, and the config line that makes Codex read it.
    : [`${home}/.codex/auth.json`, `${home}/.codex/config.toml`];
}

const cliName = (agent: ProfileAgent) => (agent === "claude-code" ? "claude" : "codex");
/** What to run when a login couldn't be moved (it keeps working from its old image meanwhile). */
export const relogin = (agent: ProfileAgent, sandbox = "docker") => `capcomd auth login ${cliName(agent)} --sandbox ${sandbox}`;

export interface CarryResult {
  agent: ProfileAgent;
  /** moved: the login now boots from `to`; current: it already did; failed: it still boots from `from`. */
  status: "moved" | "current" | "failed";
  from: string | null;
  to: string | null;
  /** One line for the user (never a credential). */
  message: string;
  ms: number;
}

export interface CarryOptions {
  /** The env image the logins move to (the one `env build` just made or found current). */
  envSnapshot: string;
  cfg: AgentConfig;
  ledgerPath?: string;
  /** The place's name, for the command to run when a login can't be moved. */
  sandbox?: string;
  log?: (s: string) => void;
  pollMs?: number;
  now?: () => number;
}

/** The plan logins saved on another env image than `env` (only image logins: a boxd secret has none to move). */
export function loginsToCarry(env: string, profiles: AuthProfile[]): AuthProfile[] {
  return profiles.filter((p) => p.store === "snapshot" && !!p.snapshot && p.env !== env);
}

/** Moves every plan login saved on an older env image onto `o.envSnapshot`, one at a time. Never throws for a login. */
export async function carryLogins(p: P, o: CarryOptions): Promise<CarryResult[]> {
  const out: CarryResult[] = [];
  for (const prof of loginsToCarry(o.envSnapshot, Object.values(readAuthLedger(o.ledgerPath)))) out.push(await carryLogin(p, prof.agent, o));
  return out;
}

async function waitSnapshot(p: P, name: string, o: { pollMs?: number; now: () => number }): Promise<void> {
  const deadline = o.now() + 15 * 60_000;
  let st: SnapshotInfo | null = null;
  while ((st = await p.snapshotGet(name))?.status !== "ready") {
    if (st?.status === "failed" || o.now() > deadline) throw new Error(`login image ${name} ${st?.status ?? "missing"}`);
    await new Promise((r) => setTimeout(r, o.pollMs ?? 3000));
  }
}

/** Moves one plan login (see the module comment). The ledger changes only once the new login image is ready. */
export async function carryLogin(p: P, agent: ProfileAgent, o: CarryOptions): Promise<CarryResult> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const log = o.log ?? (() => {});
  const prof = readAuthLedger(o.ledgerPath)[agent];
  const res = (status: CarryResult["status"], message: string, to: string | null = null): CarryResult => ({ agent, status, from: prof?.snapshot ?? null, to, message, ms: now() - t0 });
  if (!prof?.snapshot || prof.store !== "snapshot") return res("current", `${cliName(agent)}: no login image to move`);
  if (prof.env === o.envSnapshot) return res("current", `plan login for ${cliName(agent)} is on ${o.envSnapshot} already`, prof.snapshot);
  const a = adapterFor(agent);
  const home = agentHome(o.cfg);
  const env = { PATH: agentPath(home), HOME: home };
  const target = authSnapshotName(agent, o.envSnapshot);
  // Errors from the provider are redacted to their shapes and cut short: never a credential in the message.
  const why = (e: unknown) => new Redactor([]).text(String((e as Error)?.message ?? e)).replace(/\s+/g, " ").slice(0, 300);
  const files = new Map<string, Uint8Array>();
  let made = false;
  try {
    if (!(await p.snapshotGet(prof.snapshot))) throw new Error(`its image ${prof.snapshot} is gone`);
    // 1. The credential files, read from a container of the old login image (only these leave it).
    const from = await bootVm(p, a, prof.snapshot, "auth-carry-read", t0);
    try {
      const wanted = loginFiles(agent, home);
      const present = (await p.exec(from, ["sh", "-c", wanted.map((f) => `[ -s ${sq(f)} ] && echo ${sq(f)}`).join("; ") + "; true"], { env })).stdout.split("\n").map((l) => l.trim()).filter((l) => wanted.includes(l));
      for (const f of present) files.set(f, await p.download(from, f));
    } finally { await destroyVm(p, from); }
    if (!files.size) throw new Error(`no login files in ${prof.snapshot}`);
    // 2. Written into a container of the new env image, private to the agent's user, and checked as the runner checks.
    const to = await bootVm(p, a, o.envSnapshot, "auth-carry-write", t0 + 1);
    try {
      const dirs = [...new Set([...files.keys()].map((f) => f.slice(0, f.lastIndexOf("/"))))];
      const mk = await p.exec(to, ["sh", "-c", dirs.map((d) => `mkdir -p ${sq(d)} && chmod 700 ${sq(d)}`).join(" && ")], { env });
      if (mk.code !== 0) throw new Error(`couldn't make the login's folders (exit ${mk.code})`);
      for (const [f, data] of files) await p.upload(to, f, data);
      const ch = await p.exec(to, ["sh", "-c", `chmod 600 ${[...files.keys()].map(sq).join(" ")}`], { env });
      if (ch.code !== 0) throw new Error(`couldn't make the login's files private (exit ${ch.code})`);
      if (!/file/.test((await p.exec(to, ["sh", "-c", a.subscriptionCheck(home, sq)], { env })).stdout)) throw new Error("the login isn't found in the new image");
      // 3. Saved as the new login image (a stale one of that name from an earlier try goes first).
      if (await p.snapshotGet(target)) await p.snapshotDelete(target);
      made = true;
      await p.snapshotCreate(to, target);
      await waitSnapshot(p, target, { pollMs: o.pollMs, now });
    } finally { await destroyVm(p, to); }
    // 4. The login boots from it now; then the old image goes (as `auth login` does when it replaces one).
    const l = readAuthLedger(o.ledgerPath);
    const cur = l[agent];
    if (!cur || cur.snapshot !== prof.snapshot) throw new Error("the login changed while it was being moved");
    writeAuthLedger({ ...l, [agent]: { ...cur, snapshot: target, env: o.envSnapshot, carriedFrom: prof.env, carriedAt: new Date().toISOString() } }, o.ledgerPath);
    if (prof.snapshot !== target) await p.snapshotDelete(prof.snapshot).catch((e) => log(`couldn't remove the old login image ${prof.snapshot}: ${why(e)}`));
    log(`plan login for ${cliName(agent)} moved to ${o.envSnapshot} (${target}, ${now() - t0}ms)`);
    return res("moved", `plan login for ${cliName(agent)} moved to the new environment (${target})`, target);
  } catch (e) {
    files.clear();
    // Nothing half-made is left as the login: a new image that isn't recorded is removed; the old one stays in use.
    if (made && readAuthLedger(o.ledgerPath)[agent]?.snapshot !== target) await p.snapshotDelete(target).catch(() => {});
    const msg = `plan login for ${cliName(agent)} couldn't be moved to ${o.envSnapshot} (${why(e)}); its agents still boot from ${prof.snapshot}. Run \`${relogin(agent, o.sandbox)}\` to log in on the new one`;
    log(msg);
    return res("failed", msg);
  } finally {
    files.clear();
  }
}
