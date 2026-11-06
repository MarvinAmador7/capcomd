// The operator's trust in a project's packages (plugin API §4.8; ADR-024 decision 4): opening a repository must not run
// its code on the host, nor put its text in an agent's prompt as the user's, until the operator has looked at that
// content once. Trust is given to one content hash (src/install/lock.ts `hashTree`) of one package at one place (its
// directory, made real), so a changed file, or the same package copied elsewhere, needs trusting again. Kept in
// <capcomd home>/trust.json (0600), which no project can write.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ schema: TRUST_SCHEMA, entries }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
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
  write(env, [...read(env).filter((e) => !same(e, o.kind, where)), entry]);
  return entry;
}

/** Forget the trust given to the package at `dir`; true when there was one. */
export function revokeTrust(kind: string, dir: string, env: Env = process.env): boolean {
  const where = real(dir);
  const all = read(env);
  const kept = all.filter((e) => !same(e, kind, where));
  if (kept.length === all.length) return false;
  write(env, kept);
  return true;
}

/** Mark the entry the daemon audited: the entry, or null when it was marked already (or is gone). */
export function announce(kind: string, dir: string, hash: string, env: Env = process.env): TrustEntry | null {
  const where = real(dir);
  const all = read(env);
  const e = all.find((x) => same(x, kind, where) && x.hash === hash);
  if (!e || e.announced) return null;
  e.announced = true;
  write(env, all);
  return e;
}
