// What a package's files are, and what they were when it was installed (plugin API §4.8, ADR-024 §2.5): every file's
// sha256 and mode, and one content hash over them all, which trust is given to (src/install/trust.ts) and `update`
// compares. `LOCK` beside the package records where it came from (source, commit) and that tree; it is the one file the
// hash leaves out. A link is hashed as its target and must stay inside the package; nothing else is skipped (a file a
// package's command can reach is a file its hash covers).
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const LOCK_FILE = "LOCK";
export const LOCK_SCHEMA = "capcomd.lock/v1";
/** A package bigger than this is refused: it's not something to hash at every daemon start. */
export const TREE_LIMITS = { files: 5000, bytes: 100 * 1024 * 1024 } as const;

/** A file's entry: its sha256, and its mode as git writes it (100644, 100755, 120000 for a link). */
export interface TreeFile { sha256: string; mode: "100644" | "100755" | "120000" }
export interface Tree { files: Record<string, TreeFile>; hash: string }

export interface Lock {
  schema: typeof LOCK_SCHEMA;
  /** What the package is: a plugin, a profile (ADR-024 §7 step 7). */
  kind: string;
  name: string;
  version: string | null;
  /** The source as `install` was given it (`owner/repo#name@ref`, a local path made absolute). */
  source: string;
  /** The repository fetched, the ref asked for (null: its HEAD), the commit it named, and where the package is in it. */
  remote: string;
  ref: string | null;
  commit: string;
  path: string;
  installedAt: string;
  files: Record<string, TreeFile>;
  hash: string;
}

export class TreeError extends Error {
  constructor(message: string) { super(message); this.name = "TreeError"; }
}

/** `path` (relative to `root`, `/`-separated) is inside `root`. */
export const inside = (root: string, path: string): boolean => {
  const rel = relative(resolve(root), resolve(root, path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** The content hash of a file list: sha256 over its entries sorted by path. */
export function treeHash(files: Record<string, TreeFile>): string {
  const h = createHash("sha256");
  for (const p of Object.keys(files).sort()) h.update(`${p}\0${files[p]!.mode}\0${files[p]!.sha256}\n`);
  return `sha256:${h.digest("hex")}`;
}

/**
 * Every file under `dir` but its top-level LOCK, hashed. Refuses a link that leaves the directory (absolute, or `..`
 * past its root), anything that is neither a file, a directory nor a link, and a tree over TREE_LIMITS.
 */
export function hashTree(dir: string): Tree {
  const root = resolve(dir);
  const files: Record<string, TreeFile> = {};
  let bytes = 0, count = 0;
  const walk = (rel: string) => {
    const abs = rel ? join(root, rel) : root;
    for (const e of readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${e}` : e;
      if (!rel && e === LOCK_FILE) continue;
      const p = join(abs, e);
      const st = lstatSync(p);
      if (++count > TREE_LIMITS.files) throw new TreeError(`more than ${TREE_LIMITS.files} files`);
      if (st.isDirectory()) { walk(r); continue; }
      if (st.isSymbolicLink()) {
        const target = readlinkSync(p);
        if (isAbsolute(target) || !inside(root, join(dirname(r), target))) throw new TreeError(`${r} links outside the package (${target})`);
        files[r] = { sha256: createHash("sha256").update(target).digest("hex"), mode: "120000" };
        continue;
      }
      if (!st.isFile()) throw new TreeError(`${r} is not a file, a directory or a link`);
      if ((bytes += st.size) > TREE_LIMITS.bytes) throw new TreeError(`more than ${TREE_LIMITS.bytes / 1024 / 1024} MB`);
      files[r] = { sha256: createHash("sha256").update(readFileSync(p)).digest("hex"), mode: st.mode & 0o111 ? "100755" : "100644" };
    }
  };
  walk("");
  return { files, hash: treeHash(files) };
}

/** What changed from `a` to `b`, by path. */
export function diffTrees(a: Record<string, TreeFile>, b: Record<string, TreeFile>): { added: string[]; removed: string[]; changed: string[] } {
  const added = Object.keys(b).filter((p) => !(p in a)).sort();
  const removed = Object.keys(a).filter((p) => !(p in b)).sort();
  const changed = Object.keys(b).filter((p) => p in a && (a[p]!.sha256 !== b[p]!.sha256 || a[p]!.mode !== b[p]!.mode)).sort();
  return { added, removed, changed };
}

export function readLock(dir: string): Lock | null {
  try {
    const l = JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8")) as Lock;
    return l && l.schema === LOCK_SCHEMA && typeof l.hash === "string" && l.files && typeof l.files === "object" ? l : null;
  } catch { return null; }
}

export function writeLock(dir: string, lock: Lock): void {
  const tmp = join(dir, `.${LOCK_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(lock, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, join(dir, LOCK_FILE));
}

/** A package as it is on disk against its LOCK: `null` when it has none; `modified` lists what changed since. */
export function lockState(dir: string): { lock: Lock; hash: string; modified: boolean; diff: ReturnType<typeof diffTrees> } | { lock: Lock; error: string } | null {
  const lock = readLock(dir);
  if (!lock) return null;
  try {
    const t = hashTree(dir);
    return { lock, hash: t.hash, modified: t.hash !== lock.hash, diff: diffTrees(lock.files, t.files) };
  } catch (e) { return { lock, error: (e as Error).message }; }
}
