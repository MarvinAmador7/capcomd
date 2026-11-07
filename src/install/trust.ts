// The operator's trust in a project's packages (plugin API §4.8; ADR-024 decision 4): opening a repository must not run
// its code on the host, nor put its text in an agent's prompt as the user's, until the operator has looked at that
// content once. Trust is given to one content hash (src/install/lock.ts `hashTree`) of one package at one place (its
// directory, made real), so a changed file, or the same package copied elsewhere, needs trusting again. Kept in
// <capcomd home>/trust.json (0600), which no project can write. The CLI and the daemon both change it (a read, then a
// write of the whole file), so each change holds trust.json.lock while it does.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RelayError } from "../core/errors";
import { capcomdHome } from "../utils/home";

type Env = Record<string, string | undefined>;
export const TRUST_SCHEMA = "capcomd.trust/v1";

export interface TrustEntry {
  /** What is trusted: `plugin`, or a profile's text (ADR-024 step 7). */
  kind: string;
  name: string;
  /** The package's directory, made real. */
  where: string;
  hash: string;
  at: string;
  /** Who trusted it: `operator` (the CLI on the host) or `client:<id>`. */
  by: string;
  /** The daemon wrote its `plugin.trusted` event for it (it audits trust the first time it acts on it). */
  announced?: boolean;
}

export const trustPath = (env: Env = process.env) => join(capcomdHome(env), "trust.json");
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

function read(env: Env): TrustEntry[] {
  const p = trustPath(env);
  if (!existsSync(p)) return [];
  try {
    const d = JSON.parse(readFileSync(p, "utf8")) as { schema?: unknown; entries?: unknown };
    return d.schema === TRUST_SCHEMA && Array.isArray(d.entries) ? (d.entries as TrustEntry[]).filter((e) => e && typeof e.where === "string" && typeof e.hash === "string") : [];
  } catch { return []; }
}

function write(env: Env, entries: TrustEntry[]) {
  const p = trustPath(env);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  // A name no one can guess, created exclusively: a file or a link already there is never written through.
  const tmp = `${p}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  let made = false;
  try {
    writeFileSync(tmp, JSON.stringify({ schema: TRUST_SCHEMA, entries }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    made = true;
    renameSync(tmp, p);
  } catch (e) {
    if (made || (e as NodeJS.ErrnoException).code !== "EEXIST") rmSync(tmp, { force: true });
    throw e;
  }
  chmodSync(p, 0o600);
}

/** How long a change waits for another one to finish, and when a lock is left over (no change holds it that long). */
export const TRUST_LOCK = { waitMs: 5_000, staleMs: 30_000 };

/** Another change held trust.json.lock past TRUST_LOCK.waitMs: nothing was changed. */
export class TrustLockedError extends RelayError {
  constructor(message: string) { super("conflict", message, "Run it again once the other change is done.", { code: "locked", retryable: true }); }
}

const gone = (pid: unknown) => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
};

/**
 * `change` with trust.json.lock held: created exclusively, holding this process's pid and a token of its own, removed
 * after. A lock whose process is gone, or older than TRUST_LOCK.staleMs, is left over: it is moved aside and removed
 * when it is still the one judged left over (a fresh lock taken in between is put back). Waits TRUST_LOCK.waitMs for
 * another change, then throws TrustLockedError.
 */
function locked<T>(env: Env, change: () => T): T {
  const p = `${trustPath(env)}.lock`;
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const me = JSON.stringify({ pid: process.pid, token: randomBytes(8).toString("hex") });
  const deadline = Date.now() + TRUST_LOCK.waitMs;
  for (;;) {
    try { writeFileSync(p, me, { flag: "wx", mode: 0o600 }); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    let text: string, age: number;
    try { text = readFileSync(p, "utf8"); age = Date.now() - lstatSync(p).mtimeMs; } catch { continue; /* released meanwhile */ }
    let pid: unknown = null;
    try { pid = (JSON.parse(text) as { pid?: unknown }).pid; } catch { /* still being written */ }
    if (gone(pid) || age > TRUST_LOCK.staleMs) {
      const aside = `${p}.${process.pid}-${randomBytes(6).toString("hex")}.stale`;
      try { renameSync(p, aside); } catch { continue; }
      let moved = "";
      try { moved = readFileSync(aside, "utf8"); } catch { /* removed meanwhile */ }
      if (moved !== text) try { linkSync(aside, p); } catch { /* another lock is there now */ }
      rmSync(aside, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new TrustLockedError(`${trustPath(env)} is being changed by another capcomd (process ${typeof pid === "number" ? pid : "?"}, ${p}), so nothing was changed`);
    Bun.sleepSync(5 + Math.floor(Math.random() * 10));
  }
  try { return change(); } finally {
    try { if (readFileSync(p, "utf8") === me) unlinkSync(p); } catch { /* taken as left over */ }
  }
}

const same = (e: TrustEntry, kind: string, where: string) => e.kind === kind && e.where === where;

/** `trusted` when the operator trusted exactly this hash here; `changed` when they trusted another (the content changed
 *  since: a changed hash resets trust); else `untrusted`. */
export function trustState(kind: string, dir: string, hash: string, env: Env = process.env): { state: "trusted" | "changed" | "untrusted"; entry: TrustEntry | null } {
  const e = read(env).find((x) => same(x, kind, real(dir))) ?? null;
  return { state: !e ? "untrusted" : e.hash === hash ? "trusted" : "changed", entry: e };
}

/** Trust `hash` for the package at `dir` (replacing what was trusted there before). */
export function recordTrust(o: { kind: string; name: string; dir: string; hash: string; by: string }, env: Env = process.env): TrustEntry {
  const where = real(o.dir);
  const entry: TrustEntry = { kind: o.kind, name: o.name, where, hash: o.hash, at: new Date().toISOString(), by: o.by, announced: false };
  locked(env, () => write(env, [...read(env).filter((e) => !same(e, o.kind, where)), entry]));
  return entry;
}

/** Forget the trust given to the package at `dir`; true when there was one. */
export function revokeTrust(kind: string, dir: string, env: Env = process.env): boolean {
  const where = real(dir);
  return locked(env, () => {
    const all = read(env);
    const kept = all.filter((e) => !same(e, kind, where));
    if (kept.length === all.length) return false;
    write(env, kept);
    return true;
  });
}

/**
 * Mark the entry the daemon audited: the entry, or null when it was marked already (or is gone). While another change
 * holds the lock past TRUST_LOCK.waitMs it is null too and the entry stays unmarked, for the next time the daemon acts
 * on it: the audit waits, the plugin doesn't.
 */
export function announce(kind: string, dir: string, hash: string, env: Env = process.env): TrustEntry | null {
  const where = real(dir);
  try {
    return locked(env, () => {
      const all = read(env);
      const e = all.find((x) => same(x, kind, where) && x.hash === hash);
      if (!e || e.announced) return null;
      e.announced = true;
      write(env, all);
      return e;
    });
  } catch (e) {
    if (e instanceof TrustLockedError) return null;
    throw e;
  }
}
