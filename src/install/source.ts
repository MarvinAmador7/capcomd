// Where an installable package comes from (plugin API §4.8, ADR-024 §2.5): `<owner/repo>[#<name>][@<ref>]`, a GitHub
// repository, or the same suffixes on any git URL or a local repository path (`/srv/plugins.git#slack@v1`). The name
// picks one package among several in the repository; the ref is a branch, a tag or a commit (default: the remote's HEAD).
import { resolve } from "node:path";

export interface PackageSource {
  /** What the operator wrote, a local path made absolute: kept in LOCK so `update` fetches from the same place. */
  spec: string;
  /** The repository's URL or absolute path, as host git fetches it (src/merge/host-git.ts: never a remote's name). */
  remote: string;
  /** The package's name in the repository, when the spec names one. */
  name: string | null;
  /** The branch, tag or commit; null: the remote's HEAD. */
  ref: string | null;
}

const GITHUB = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*[./]$)[A-Za-z0-9._/-]{1,200}$/;

export class SourceError extends Error {
  constructor(message: string) { super(message); this.name = "SourceError"; }
}

/** Parse a package source; `cwd` resolves a relative local path. */
export function parseSource(spec: string, cwd = process.cwd()): PackageSource {
  const s = spec.trim();
  if (!s || s.startsWith("-") || /[\s\0]/.test(s)) throw new SourceError(`not a package source: ${JSON.stringify(spec).slice(0, 200)}`);
  let rest = s, ref: string | null = null, name: string | null = null;
  // `@ref` is the last `@` after every `/`, `#` and `:` (so `git@github.com:o/r.git` has none).
  const at = rest.lastIndexOf("@");
  if (at > Math.max(rest.lastIndexOf("/"), rest.lastIndexOf("#"), rest.lastIndexOf(":"))) {
    ref = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!REF.test(ref)) throw new SourceError(`not a branch, tag or commit: ${JSON.stringify(ref).slice(0, 200)}`);
  }
  const hash = rest.lastIndexOf("#");
  if (hash >= 0) {
    name = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
    if (!NAME.test(name)) throw new SourceError(`not a package name: ${JSON.stringify(name).slice(0, 80)} (lowercase letters, digits and -)`);
  }
  if (!rest) throw new SourceError(`no repository in ${JSON.stringify(spec).slice(0, 200)}`);
  // `where`: the repository as the spec keeps it (owner/repo for GitHub, else the URL or the absolute path).
  let remote: string, where: string;
  if (/^(https?|ssh|git|file):\/\//i.test(rest) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(rest)) remote = where = rest;
  else if (rest.startsWith("/") || rest.startsWith("./") || rest.startsWith("../") || rest === "." || rest === "..") remote = where = resolve(cwd, rest);
  else if (GITHUB.test(rest) && !rest.startsWith(".")) { where = rest.replace(/\.git$/, ""); remote = `https://github.com/${where}.git`; }
  else throw new SourceError(`not a repository: ${JSON.stringify(rest).slice(0, 200)} (owner/repo, a git URL, or a local path)`);
  if (/^(ext|fd)::/i.test(remote)) throw new SourceError(`refusing the ${remote.split("::")[0]} transport`);
  return { spec: formatSource({ remote: where, name, ref }), remote, name, ref };
}

/** A spec from its parts. */
export const formatSource = (s: Pick<PackageSource, "remote" | "name" | "ref">): string => `${s.remote}${s.name ? `#${s.name}` : ""}${s.ref ? `@${s.ref}` : ""}`;
