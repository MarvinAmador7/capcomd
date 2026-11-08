// Fetching a package out of a git repository (plugin API §4.8, ADR-024 §2.5) without running anything from it: the
// host fetches the ref into a host repo of its own (src/merge/host-git.ts, the one place network git runs, §11.7),
// lists the commit's tree, picks the package's directory, and writes that directory's blobs out itself, one by one.
// No checkout, no hooks, no filters, no submodules; a link that leaves the directory is refused, and so is a tree over
// TREE_LIMITS.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { Git } from "../merge/git";
import { hostRepoDir, hostRepoProblems, initHostRepo, isHostRepo, remoteGit } from "../merge/host-git";
import { TREE_LIMITS, inside, linkInside } from "./lock";
import type { PackageSource } from "./source";

/** A file of the fetched commit's tree. */
export interface TreeEntry { mode: string; type: string; sha: string; path: string }

export class FetchError extends Error {
  constructor(message: string) { super(message); this.name = "FetchError"; }
}

const FETCHED = "refs/capcomd/package";
const TIMEOUT_MS = 120_000;

/** The host repo `remote` is fetched into, made (again) when it isn't a clean one (§11.7). */
async function hostRepo(workdir: string, remote: string): Promise<Git> {
  const dir = hostRepoDir(workdir, remote, "repo.git");
  if (isHostRepo(dir) && !(await hostRepoProblems(new Git(dir))).length) return new Git(dir);
  const { rmSync } = await import("node:fs");
  rmSync(dir, { recursive: true, force: true });
  return initHostRepo(dir, { bare: true });
}

/** Read blobs by sha with one `git cat-file --batch`: the bytes as they are (a package may hold binary files). */
function blobs(git: Git, shas: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!shas.length) return out;
  const r = spawnSync("git", ["cat-file", "--batch"], { cwd: git.cwd, input: shas.join("\n") + "\n", maxBuffer: TREE_LIMITS.bytes * 2, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0 || !r.stdout) throw new FetchError(`reading the package's files failed: ${String(r.stderr ?? "").trim().slice(0, 300)}`);
  const buf = r.stdout as Buffer;
  let at = 0;
  for (const sha of shas) {
    const nl = buf.indexOf(10, at);
    const [got, type, size] = buf.subarray(at, nl).toString("utf8").split(" ");
    if (got !== sha || type !== "blob") throw new FetchError(`git returned ${type ?? "nothing"} for ${sha}`);
    const n = Number(size);
    out.set(sha, buf.subarray(nl + 1, nl + 1 + n));
    at = nl + 1 + n + 1;
  }
  return out;
}

/**
 * Fetch `source` (its ref, else the remote's HEAD) and write the package directory `pick` chooses from the commit's
 * tree into `into` (which must not exist yet). `pick` gets every path of the tree and a reader for small files (the
 * manifests it looks at); it returns the package's directory in the repository (`""` for the root), or throws.
 */
export async function fetchPackage(source: PackageSource, o: {
  workdir: string; into: string;
  pick(paths: string[], read: (path: string) => string | null): string;
}): Promise<{ commit: string; path: string }> {
  const git = await hostRepo(o.workdir, source.remote);
  const want = source.ref ?? "HEAD";
  const refspec = `+${want}:${FETCHED}`;
  let r = await remoteGit(git, ["fetch", "-q", "--no-tags", "--depth=1", source.remote, refspec], source.remote, { timeoutMs: TIMEOUT_MS });
  // A server (or a local path) that can't do a shallow fetch of this ref: the whole history then.
  if (r.code !== 0 && !r.timedOut) r = await remoteGit(git, ["fetch", "-q", "--no-tags", source.remote, refspec], source.remote, { timeoutMs: TIMEOUT_MS });
  if (r.code !== 0) throw new FetchError(`fetching ${want} from ${source.remote} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 400)}`);
  const commit = (await git.ok(["rev-parse", "--verify", `${FETCHED}^{commit}`])).trim();
  const listed = await git.ok(["ls-tree", "-r", "-z", "--full-tree", commit]);
  const entries: TreeEntry[] = listed.split("\0").filter(Boolean).map((l) => {
    const tab = l.indexOf("\t");
    const [mode, type, sha] = l.slice(0, tab).split(" ");
    return { mode: mode!, type: type!, sha: sha!, path: l.slice(tab + 1) };
  });
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const read = (path: string): string | null => {
    const e = byPath.get(path);
    if (!e || e.type !== "blob" || e.mode === "120000") return null;
    return blobs(git, [e.sha]).get(e.sha)?.subarray(0, 1024 * 1024).toString("utf8") ?? null;
  };
  const dir = o.pick(entries.map((e) => e.path), read).replace(/\/+$/, "");
  const prefix = dir ? `${dir}/` : "";
  const mine = entries.filter((e) => !dir || e.path.startsWith(prefix));
  if (mine.length > TREE_LIMITS.files) throw new FetchError(`the package has more than ${TREE_LIMITS.files} files`);
  const sub = mine.find((e) => e.type === "commit");
  if (sub) throw new FetchError(`${sub.path} is a submodule: a package carries its own files`);
  const data = blobs(git, [...new Set(mine.map((e) => e.sha))]);
  let bytes = 0;
  mkdirSync(o.into, { recursive: false, mode: 0o755 });
  for (const e of mine) {
    const rel = e.path.slice(prefix.length);
    if (!rel || rel.split("/").some((s) => s === ".." || s === "." || s === ".git")) throw new FetchError(`${e.path}: not a path a package may hold`);
    const to = join(o.into, rel);
    mkdirs(o.into, rel, e.path);
    const body = data.get(e.sha)!;
    if ((bytes += body.length) > TREE_LIMITS.bytes) throw new FetchError(`the package is more than ${TREE_LIMITS.bytes / 1024 / 1024} MB`);
    if (e.mode === "120000") {
      const target = body.toString("utf8");
      if (isAbsolute(target) || !inside(o.into, posix.join(posix.dirname(rel), target))) throw new FetchError(`${e.path} links outside the package (${target})`);
      try { symlinkSync(target, to); } catch { throw clash(e.path); }
    } else {
      // `wx`: never over something already written (a path that names it again in another case or normalization).
      try { writeFileSync(to, body, { flag: "wx" }); } catch { throw clash(e.path); }
      chmodSync(to, e.mode === "100755" ? 0o755 : 0o644);
    }
  }
  // Read as the filesystem reads them, once all are written: a link may go through another the package holds.
  for (const e of mine) if (e.mode === "120000" && !linkInside(o.into, e.path.slice(prefix.length))) throw new FetchError(`${e.path} links outside the package (${data.get(e.sha)!.toString("utf8")}, through another of its links)`);
  return { commit, path: dir };
}

const clash = (path: string) => new FetchError(`${path} names a file the package already has (paths that differ only in case or normalization)`);

/**
 * The directories of `rel` under `into`, made one at a time, through none of the package's own links. A filesystem
 * that ignores case or normalization (macOS) reads `p/D` for `p/d`: a link written earlier must not take a later path
 * out of the package, where the link's own check (its target, taken literally) can't see it.
 */
function mkdirs(into: string, rel: string, path: string) {
  let at = into;
  for (const part of rel.split("/").slice(0, -1)) {
    at = join(at, part);
    let st;
    try { st = lstatSync(at); } catch { mkdirSync(at, { mode: 0o755 }); continue; }
    if (!st.isDirectory()) throw new FetchError(`${path} goes through ${st.isSymbolicLink() ? "a link" : "a file"} of the package (paths that differ only in case or normalization)`);
  }
}

/** A short, stable folder name for something keyed by a path (a project's directory). */
export const keyOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
