// The `host` session store (ADR-026 §2): session objects as files under `stateDir()/sessions/` (the folder 0700, each
// file 0600), the source of truth. A key is the file's path under that folder.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { checkSessionKey, type SessionStore } from "../../packages/plugin/src/session-store";
import { stateDir } from "../utils/home";

/** Where the host keeps every run's sessions. */
export const sessionsRoot = () => join(stateDir(), "sessions");

/** `dir` and every folder between `root` and it, made 0700 (an existing one too: a session holds what the agent read). */
export function privateDirs(root: string, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let d = dir; ; d = dirname(d)) {
    try { chmodSync(d, 0o700); } catch { /* best effort */ }
    if (d === root || dirname(d) === d || !d.startsWith(root)) break;
  }
}

/** Every file under `dir`, as paths relative to `root` with `/` between segments. */
export function walk(root: string, dir: string): string[] {
  if (!existsSync(dir)) return [];
  const st = statSync(dir);
  if (st.isFile()) return [relative(root, dir).split(sep).join("/")];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(root, p));
    else if (e.isFile()) out.push(relative(root, p).split(sep).join("/"));
  }
  return out;
}

/** `root` (default: sessionsRoot(), read at each call): the folder the objects are kept in. */
export function hostSessionStore(root?: string): SessionStore {
  const base = () => root ?? sessionsRoot();
  return {
    describe: () => ({ name: "host", label: "This Mac", role: "primary", encrypted: false, where: base() }),
    available: async () => ({ ok: true }),
    async put(key, data) {
      checkSessionKey(key);
      const r = base(), file = join(r, key);
      privateDirs(r, dirname(file));
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, file);
    },
    async get(key) {
      checkSessionKey(key);
      const file = join(base(), key);
      try { return new Uint8Array(readFileSync(file)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    },
    async list(prefix) {
      checkSessionKey(prefix, true);
      const r = base();
      return walk(r, join(r, prefix)).filter((k) => !k.endsWith(".tmp") && k.startsWith(prefix));
    },
    async delete(prefix) {
      checkSessionKey(prefix, true);
      if (!prefix.replace(/\/$/, "")) throw new Error("a session store delete names a run, an agent or an object, never everything");
      rmSync(join(base(), prefix), { recursive: true, force: true });
    },
  };
}
