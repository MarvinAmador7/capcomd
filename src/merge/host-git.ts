// The one way capcomd runs git that talks to a remote (docs/spec/plugin-api.md §11.7). Three rules:
//
//  1. Credentials never enter a sandbox. An agent's VM or container is agent-editable (its checkout, its .git/config,
//     its hooks, its HOME, its PATH, and every process running there, which can read another process's environment),
//     so no git command run in one carries a credential. Objects move between a sandbox and the remote through the host:
//     git bundles, made and read in the sandbox without credentials, and fetched or pushed here (src/merge/transfer.ts).
//  2. On the host, a fetch, push or ls-remote runs only in a repository capcomd made for it (a host repo: marked at
//     `git init`, its own config and hooks checked before every call) or in no repository at all, always against the
//     remote's URL as capcomd knows it, never a remote name a config could redirect. A host repo that fails the check
//     (a setting capcomd never writes, a hook that wasn't there at init, alternates) is refused; the callers that own
//     disposable clones start them over.
//  3. A sandbox's commits are hostile data (docs/spec/plugin-api.md §11.7 item 5). They reach the host only as a bundle
//     (receiveBundle: its header and refs checked, `git bundle verify`, its objects through git's object checks into a
//     quarantine, symlinks into `.git` and `.gitmodules` tricks refused, and only then into the mirror), and every git
//     command in a host repo runs under HOST_POLICY (hostGit): no hooks, no fsmonitor, no submodules, no symlinks or
//     `.git` look-alikes written out, no transport for local work, and for local work none of the user's git settings
//     (their filters, merge and diff drivers, global hooks), only their commit signing ones. Git never runs in a
//     directory a sandbox made.
//
// `tests/unit/host-git-lint.test.ts` fails when a network git command is spelled anywhere else.
import { createHash } from "crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { ForgeRemoteCredential } from "../../packages/plugin/src/seams";
import { Git, type GitPolicy, type GitResult, type GitRunOptions } from "./git";

/** The git subcommands that talk to a remote. */
export const NETWORK_OPS = ["fetch", "push", "ls-remote", "clone", "pull"] as const;

/** The protocols host git may use: never `ext::` (it runs a command) or `fd::`. */
const ALLOWED_PROTOCOLS = "file:git:http:https:ssh";

/** Where a host repo keeps its marker, in its git dir. */
const MARKER = "capcomd-host-repo.json";
interface Marker { schema: 1; hooks: Record<string, string> }

// ---- the policy every host repo's git runs under ---------------------------------------------------------------------

/**
 * `-c` settings for every git command in a host repo (they beat every config file and GIT_CONFIG_COUNT). A host repo
 * holds commits a sandbox made, so nothing git can run or follow by itself may act on them: no hooks (the user's global
 * `core.hooksPath` included, so a pre-commit or pre-push hook never runs the sandbox's code), no fsmonitor, no
 * submodules, symlinks written as plain files and no `.git` look-alike written out (CVE-2024-32002 and the like), no
 * transport (a network command's GIT_ALLOW_PROTOCOL lifts it for the plain protocols), no LFS filter.
 */
const POLICY_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["submodule.recurse", "false"],
  ["fetch.recurseSubmodules", "false"],
  ["push.recurseSubmodules", "no"],
  ["core.symlinks", "false"],
  ["core.protectHFS", "true"],
  ["core.protectNTFS", "true"],
  ["protocol.allow", "never"],
  ["filter.lfs.process", ""],
  ["filter.lfs.smudge", ""],
  ["filter.lfs.clean", ""],
  ["filter.lfs.required", "false"],
];
const POLICY_ARGS = POLICY_CONFIG.flatMap(([k, v]) => ["-c", `${k}=${v}`]);

/** Variables that point git at another repository, object store, index or template: never inherited by a host repo's git. */
const REPO_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_QUARANTINE_PATH", "GIT_TEMPLATE_DIR", "GIT_EXTERNAL_DIFF"];
/** And for local work, the user's own settings: their config files and any passed in the environment. */
const CONFIG_VARS = ["GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"];

/** The user's commit signing settings (`user.signingkey`, `commit.gpgsign`, `gpg.*`), the only ones local work keeps:
 *  capcomd's own commits are signed as before (CAPCOMD_SIGN_COMMITS, or the user's `commit.gpgsign`). Read outside any
 *  repository once per set of config locations. */
let signing: { key: string; args: string[] } | null = null;
function signingArgs(): string[] {
  const src = process.env;
  const key = JSON.stringify(Object.keys(src).filter((k) => k === "HOME" || k === "XDG_CONFIG_HOME" || k.startsWith("GIT_CONFIG")).sort().map((k) => [k, src[k]]));
  if (signing?.key === key) return signing.args;
  const cwd = nowhere();
  let ceiling = dirname(cwd);
  try { ceiling = realpathSync(ceiling); } catch { /* as given */ }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && !REPO_VARS.includes(k)) env[k] = v;
  const r = Bun.spawnSync(["git", "config", "--null", "--get-regexp", "^(user\\.signingkey|commit\\.gpgsign|gpg\\..+)$"], { cwd, env: { ...env, GIT_CEILING_DIRECTORIES: ceiling }, stdout: "pipe", stderr: "ignore" });
  const args: string[] = [];
  if (r.exitCode === 0) for (const e of r.stdout.toString().split("\0")) {
    const nl = e.indexOf("\n");
    if (nl > 0) args.push("-c", `${e.slice(0, nl)}=${e.slice(nl + 1)}`);
  }
  signing = { key, args };
  return args;
}

/** How a host repo's git runs (Git's `policy`). */
export const HOST_POLICY: GitPolicy = {
  args: (network) => network ? POLICY_ARGS : [...POLICY_ARGS, ...signingArgs()],
  inherit: (env, network) => {
    const out = { ...env };
    for (const k of network ? REPO_VARS : [...REPO_VARS, ...CONFIG_VARS]) delete out[k];
    return out;
  },
  // Local work reads no system or global config (GIT_CONFIG_GLOBAL needs git 2.32; POLICY_CONFIG covers the settings
  // that run things on older ones), fetches nothing lazily (git 2.44+) and smudges no LFS file.
  env: (network): Record<string, string> => network ? {} : { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_LFS_SKIP_SMUDGE: "1" },
};

/** Git in a host repo (or a worktree of one), under HOST_POLICY. */
export function hostGit(dir: string, extraEnv: Record<string, string> = {}): Git {
  return new Git(dir, extraEnv, HOST_POLICY);
}

/** `git` under HOST_POLICY: itself when it is, else the same repository with it. */
export function asHostGit(git: Git): Git {
  return git.policy === HOST_POLICY ? git : hostGit(git.cwd, git.extraEnv);
}

export class HostRepoRefused extends Error {
  constructor(readonly dir: string, readonly why: string[]) {
    super(`capcomd won't run credentialed git in ${dir}: ${why.join("; ")}`);
    this.name = "HostRepoRefused";
  }
}

/** The local and worktree settings a host repo may have: what `git init`, `git remote add`, a fetch (a partial one too)
 *  and `git worktree add` write. Anything else (a credential helper, `url.*.insteadOf`, `core.sshCommand`,
 *  `core.fsmonitor`, `core.hooksPath`, `include.path`, `http.*`, a remote's `uploadpack`/`receivepack`/`proxy`, …) was put
 *  there by something other than capcomd. */
const ALLOWED_KEY = /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|extensions\.(objectformat|refstorage|partialclone)|remote\.[^\n]+\.(url|fetch|promisor|partialclonefilter))$/;

const hooksOf = (gitDir: string): Record<string, string> => {
  const dir = join(gitDir, "hooks");
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".sample")) continue;
    const p = join(dir, f);
    try { out[f] = statSync(p).isFile() ? createHash("sha256").update(readFileSync(p)).digest("hex") : "dir"; } catch { out[f] = "?"; }
  }
  return out;
};

const gitDirOf = (dir: string): string => existsSync(join(dir, ".git")) ? join(dir, ".git") : dir;

/** The repository's common git dir: `<dir>/.git` or a bare `<dir>` (no git needed), else what git says. */
async function commonDir(git: Git): Promise<string | null> {
  const dot = join(git.cwd, ".git");
  try {
    if (statSync(dot).isDirectory() && existsSync(join(dot, "HEAD"))) return dot;
  } catch {
    if (existsSync(join(git.cwd, "HEAD")) && existsSync(join(git.cwd, "objects")) && existsSync(join(git.cwd, "config"))) return git.cwd;
  }
  const r = await git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Make `dir` a host repo: `git init` (bare or not) and the marker that records its hooks as git made them. */
export async function initHostRepo(dir: string, o: { bare?: boolean } = {}): Promise<Git> {
  mkdirSync(dir, { recursive: true });
  const git = hostGit(dir);
  await git.ok(["init", "-q", ...(o.bare ? ["--bare"] : [])]);
  const gd = gitDirOf(dir);
  writeFileSync(join(gd, MARKER), JSON.stringify({ schema: 1, hooks: hooksOf(gd) } satisfies Marker));
  return git;
}

/** A directory capcomd made with initHostRepo (its marker is there): cheap, no git. */
export function isHostRepo(dir: string): boolean {
  return existsSync(join(gitDirOf(dir), MARKER));
}

/** Why `git`'s repository can't be trusted with credentials, or [] when it can. */
export async function hostRepoProblems(repo: Git): Promise<string[]> {
  const git = asHostGit(repo);
  const gd = await commonDir(git);
  if (!gd) return ["not a git repository"];
  const why: string[] = [];
  let marker: Marker | null = null;
  try { marker = JSON.parse(readFileSync(join(gd, MARKER), "utf8")); } catch { /* below */ }
  if (!marker || marker.schema !== 1) return ["capcomd didn't make it (no host-repo marker)"];
  const cfg = await git.run(["config", "--list", "--show-scope", "--null"]);
  if (cfg.code !== 0) why.push(`its config can't be read: ${cfg.stderr.trim().slice(0, 200)}`);
  // `--null --show-scope`: "<scope>\0<key>\n<value>\0", repeated (includes followed, so an included file's settings
  // show up as the including scope's).
  const parts = cfg.stdout.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]!;
    if (scope !== "local" && scope !== "worktree") continue;
    const key = parts[i + 1]!.split("\n")[0]!.toLowerCase();
    if (scope === "worktree" || !ALLOWED_KEY.test(key)) why.push(`${scope} setting ${key}`);
  }
  const now = hooksOf(gd);
  for (const h of new Set([...Object.keys(now), ...Object.keys(marker.hooks ?? {})])) if (now[h] !== marker.hooks?.[h]) why.push(`hook ${h} changed since capcomd made it`);
  if (existsSync(join(gd, "objects", "info", "alternates"))) why.push("objects/info/alternates");
  return [...new Set(why)];
}

/** A remote as capcomd knows it: a URL or a path, never a remote's name (which a repository's config resolves). */
export function assertRemoteUrl(remote: string): void {
  if (!remote || /^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith("-")) throw new Error(`not a repository URL or path: ${JSON.stringify(remote).slice(0, 200)}`);
  // `ext::<command>` and `fd::` transports run things: never (GIT_ALLOW_PROTOCOL refuses them too).
  if (/^(ext|fd)::/i.test(remote)) throw new Error(`refusing the ${remote.split("::")[0]} transport`);
}

/** A URL with a credential in it (`https://user:token@…`, `https://token@…`, any `user:password@`): capcomd neither keeps
 *  nor fetches one (an ssh user such as `ssh://git@host/…` is not a credential). */
export function inlineCredential(remote: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)@/i.exec(remote.trim());
  return !!m && (/^https?$/i.test(m[1]!) || m[2]!.includes(":"));
}

// ---- credentials -------------------------------------------------------------------------------------------------

/** The active forges' credential for `remote` (docs/spec/plugin-api.md §7.4 `remoteCredential`), or null. */
const forgeCredential = async (remote: string): Promise<ForgeRemoteCredential | null> => (await import("../plugins/forges")).remoteCredentialFor(remote);

/**
 * The origin a forge's credential applies to, as git's config names it (`https://github.com`), when it is one and
 * `remote` is on it: both https, the same host and port, no user in either, no path in the credential's. Else null.
 */
export function credentialOrigin(cred: Pick<ForgeRemoteCredential, "origin">, remote: string): string | null {
  let o: URL, r: URL;
  try { o = new URL(cred.origin); r = new URL(remote.trim()); } catch { return null; }
  if (o.protocol !== "https:" || r.protocol !== "https:") return null;
  if (o.username || o.password || r.username || r.password || o.search || o.hash || (o.pathname !== "/" && o.pathname !== "")) return null;
  if (!o.host || o.host !== r.host) return null;
  return `https://${o.host}`;
}

/** A value the git credential protocol reads line by line: one line, no NUL. */
const oneLine = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 8192 && !/[\r\n\0]/.test(s);

/**
 * The environment host git gets for `remote`: no prompts, only the plain protocols, and, for an https remote whose
 * forge has the user's credential for it (§7.4 `remoteCredential`; forge-github: the user's GitHub token for
 * https://github.com), that credential as the only credential helper for the remote's origin, kept in this one process's
 * environment, never in a file or a URL. The helper list is reset first: git hands a credential that worked to every
 * helper in the list to `store`, so with the user's own helpers still listed (macOS git's system config lists
 * `osxkeychain`) the token would be saved in their keychain or credential store, and a saved copy, once the token
 * changes, would be offered first and fail. Without one, or for another remote, the user's own helpers apply. The forge
 * supplies data only: the helper is built here, and a credential for another origin than the remote's is ignored.
 */
export async function hostCredentialEnv(remote: string, source: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS };
  if (!/^https:\/\//i.test(remote.trim())) return env;
  const cred = await forgeCredential(remote).catch(() => null);
  const origin = cred ? credentialOrigin(cred, remote) : null;
  if (!cred || !origin || !oneLine(cred.username) || !oneLine(cred.password)) return env;
  const n = Number(source.GIT_CONFIG_COUNT ?? 0) || 0;
  return {
    ...env,
    CAPCOMD_GIT_USERNAME: cred.username,
    CAPCOMD_GIT_TOKEN: cred.password,
    GIT_CONFIG_COUNT: String(n + 2),
    // An empty helper clears the helpers listed before it (system, global, local) for the origin.
    [`GIT_CONFIG_KEY_${n}`]: `credential.${origin}.helper`,
    [`GIT_CONFIG_VALUE_${n}`]: "",
    [`GIT_CONFIG_KEY_${n + 1}`]: `credential.${origin}.helper`,
    // printf, not echo: sh's echo (macOS, dash) expands backslash escapes, so a password with `\n` in it would add lines
    // (`host=…`) to git's credential and `\c` would cut it short. `%s` writes the values as they are.
    [`GIT_CONFIG_VALUE_${n + 1}`]: `!f() { test "$1" = get || exit 0; printf 'username=%s\\npassword=%s\\n' "$CAPCOMD_GIT_USERNAME" "$CAPCOMD_GIT_TOKEN"; }; f`,
  };
}

// ---- running it --------------------------------------------------------------------------------------------------

export type RemoteGitOptions = Pick<GitRunOptions, "timeoutMs" | "signal" | "input" | "env" | "stallMs" | "onProgress"> & {
  /**
   * A fetch receives every pack with index-pack (`fetch.unpackLimit=1`), never unpack-objects: under git's unpack limit
   * (100 objects) unpack-objects writes no progress while a big object arrives, so a fetch bounded by `stallMs` would be
   * killed while it is still moving. index-pack reports the bytes received every second.
   */
  indexPack?: boolean;
};

/**
 * A network git command (`fetch`, `push`, `ls-remote`) against `remote` (its URL, which must be in `args`), in
 * `git`'s repository, which must be a host repo that passes hostRepoProblems: else HostRepoRefused.
 */
export async function remoteGit(git: Git, args: string[], remote: string, o: RemoteGitOptions = {}): Promise<GitResult> {
  const op = args[0] ?? "";
  if (!(NETWORK_OPS as readonly string[]).includes(op) || op === "clone" || op === "pull") throw new Error(`remoteGit runs fetch, push or ls-remote, not ${op}`);
  assertRemoteUrl(remote);
  if (!args.includes(remote)) throw new Error(`remoteGit needs the remote's URL in its arguments (git ${op})`);
  const host = asHostGit(git);
  const why = await hostRepoProblems(host);
  if (why.length) throw new HostRepoRefused(git.cwd, why);
  const { indexPack, ...run } = o;
  return host.run([...(indexPack && op === "fetch" ? ["-c", "fetch.unpackLimit=1"] : []), ...args], { ...run, network: true, env: { ...(await hostCredentialEnv(remote)), ...(o.env ?? {}) } });
}

/** A directory in no repository (git finds none above it), where a command that needs no repository runs. */
function nowhere(): string {
  const dir = join(tmpdir(), `capcomd-git-nowhere-${process.getuid?.() ?? 0}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `git ls-remote <remote> …` outside any repository: no repository's config is read. */
export async function lsRemote(remote: string, rest: string[], o: RemoteGitOptions = {}): Promise<GitResult> {
  assertRemoteUrl(remote);
  const cwd = nowhere();
  let ceiling = dirname(cwd);
  try { ceiling = realpathSync(ceiling); } catch { /* as given */ }
  return hostGit(cwd).run(["ls-remote", ...rest.filter((a) => a.startsWith("-")), remote, ...rest.filter((a) => !a.startsWith("-"))], {
    ...o, network: true, env: { ...(await hostCredentialEnv(remote)), GIT_CEILING_DIRECTORIES: ceiling, ...(o.env ?? {}) },
  });
}

/** The remote's default branch (`ls-remote --symref <remote> HEAD`), or null when it doesn't say. */
export async function remoteDefaultBranch(remote: string, o: RemoteGitOptions = {}): Promise<string | null> {
  const r = await lsRemote(remote, ["--symref", "HEAD"], o);
  if (r.code !== 0) return null;
  return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout)?.[1] ?? null;
}

// ---- a sandbox's bundle ------------------------------------------------------------------------------------------

/** A sandbox's bundle the host won't take, and why (for the agent and its driver: what to change). */
export class BundleRefused extends Error {
  constructor(readonly why: string) { super(why); this.name = "BundleRefused"; }
}

/** A ref name the host takes from a bundle: `refs/` and plain path components (no control character, space, `..`,
 *  leading dot, `.lock`, `@{`), at most 255 bytes. */
export function isSafeRefName(r: string): boolean {
  if (r.length > 255 || !/^refs\/[A-Za-z0-9._/-]+$/.test(r) || r.includes("..") || r.includes("@{")) return false;
  return r.split("/").every((c) => !!c && !c.startsWith(".") && !c.endsWith(".") && !c.endsWith(".lock"));
}

/** The longest bundle header the host reads: a ref and a few hundred prerequisites are a few kilobytes. */
const MAX_HEADER = 1024 * 1024;
const show = (s: string) => JSON.stringify(s.length > 120 ? `${s.slice(0, 120)}…` : s);

export interface BundleHeader { version: 2 | 3; format: "sha1" | "sha256"; prerequisites: string[]; refs: Array<{ oid: string; name: string }>; packOffset: number }

/** A bundle file's header (v2, or v3 with only `@object-format`), checked line by line: else BundleRefused. */
export function readBundleHeader(file: string): BundleHeader {
  const fd = openSync(file, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(Math.min(MAX_HEADER + 4, statSync(file).size));
    readSync(fd, buf, 0, buf.length, 0);
  } finally { closeSync(fd); }
  const end = buf.indexOf("\n\n");
  if (end < 0) throw new BundleRefused(buf.length > MAX_HEADER ? "its header is over 1 MiB" : "it isn't a git bundle (no end to its header)");
  if (buf.subarray(end + 2, end + 6).toString("latin1") !== "PACK") throw new BundleRefused("it isn't a git bundle (no pack after its header)");
  const lines = buf.subarray(0, end).toString("latin1").split("\n");
  const version = lines[0] === "# v2 git bundle" ? 2 : lines[0] === "# v3 git bundle" ? 3 : null;
  if (!version) throw new BundleRefused(`it isn't a git bundle v2 or v3 (${show(lines[0] ?? "")})`);
  let format: "sha1" | "sha256" = "sha1";
  const prerequisites: string[] = [], refs: Array<{ oid: string; name: string }> = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("@")) {
      const cap = /^@object-format=(sha1|sha256)$/.exec(line);
      if (version !== 3 || !cap) throw new BundleRefused(`it asks for ${show(line)}, which capcomd doesn't take`);
      format = cap[1] as "sha1" | "sha256";
      continue;
    }
    const pre = /^-([0-9a-f]{40}|[0-9a-f]{64})(?: [^\0]*)?$/.exec(line);
    if (pre) { prerequisites.push(pre[1]!); continue; }
    const ref = /^([0-9a-f]{40}|[0-9a-f]{64}) (.*)$/s.exec(line);
    if (!ref) throw new BundleRefused(`its header has a line that isn't a ref or a prerequisite: ${show(line)}`);
    if (!isSafeRefName(ref[2]!)) throw new BundleRefused(`it has a ref named ${show(ref[2]!)}: not a plain ref name (a control character, a space, "..", a leading dot or ".lock")`);
    refs.push({ oid: ref[1]!, name: ref[2]! });
  }
  const len = format === "sha1" ? 40 : 64;
  if ([...prerequisites, ...refs.map((r) => r.oid)].some((o) => o.length !== len)) throw new BundleRefused(`its object names aren't ${format}`);
  return { version, format, prerequisites, refs, packOffset: end + 2 };
}

/** `file` from `offset` to its end, a MiB at a time (Bun's `Bun.file(f).slice(n)` loses its offset as a process's
 *  stdin). */
function fileFrom(file: string, offset: number): { stream: ReadableStream<Uint8Array>; close: () => void } {
  let fd: number | null = openSync(file, "r");
  let pos = offset;
  const close = () => { if (fd !== null) { closeSync(fd); fd = null; } };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (fd === null) return c.close();
      const b = new Uint8Array(1024 * 1024);
      const n = readSync(fd, b, 0, b.length, pos);
      if (n <= 0) { close(); c.close(); return; }
      pos += n;
      c.enqueue(b.subarray(0, n));
    },
    cancel: close,
  });
  return { stream, close };
}

/** A path component git would take for `.git` (any case, HFS's ignorable characters, NTFS's trailing dots and spaces
 *  and its 8.3 name), or for `.gitmodules`. */
const IGNORABLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g;
const norm = (c: string) => c.toLowerCase().replace(IGNORABLE, "").replace(/[. ]+$/, "");
const isDotGit = (c: string) => { const n = norm(c); return n === ".git" || n === "git~1"; };
const isDotGitmodules = (c: string) => { const n = norm(c); return n === ".gitmodules" || /^gi7eba~\d$/.test(n) || n === "gitmod~1"; };

/** Settings git's object checks treat as errors on a sandbox's objects (the rest are git's defaults: `.gitmodules` and
 *  `.gitattributes` errors, broken objects). All known to git since 2.6. */
const FSCK_ERRORS = "hasdotgit=error,hasdot=error,hasdotdot=error,fullpathname=error,emptyname=error";

/** Why a new commit's tree can't come in, or null: a symlink whose target goes through `.git` (a hook planted through
 *  it, CVE-2024-32002's shape), or a `.gitmodules` with a control character in a value (CVE-2025-48384: a path ending
 *  in a carriage return), a path or URL that reads as an option, a path out of the tree or into `.git`, or a command. */
async function treeProblem(git: Git, sha: string, env: Record<string, string>): Promise<string | null> {
  const log = await git.run(["log", "--format=", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "--root", "-m", sha, "--not", "--all"], { env });
  if (log.code !== 0) return `git log failed: ${log.stderr.trim().slice(0, 300)}`;
  const links = new Map<string, string>(), modules = new Map<string, string>();
  const parts = log.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const meta = parts[i]!.replace(/^\n+/, "");
    if (!meta.startsWith(":")) continue;
    const [, dstMode, , dst, status] = meta.slice(1).split(" ");
    const path = parts[++i] ?? "";
    if (status === "D" || !dst || /^0+$/.test(dst)) continue;
    if (dstMode === "120000") links.set(dst, path);
    else if (isDotGitmodules(path.split("/").pop() ?? "") && /^100(644|755)$/.test(dstMode ?? "")) modules.set(dst, path);
  }
  for (const [blob, path] of links) {
    const t = await git.run(["cat-file", "blob", blob], { env });
    if (t.code !== 0) return `its symlink ${show(path)} can't be read`;
    if (t.stdout.split(/[\\/]/).some(isDotGit)) return `its symlink ${show(path)} points into .git (${show(t.stdout)}), which could plant a hook`;
  }
  for (const [blob, path] of modules) {
    const c = await git.run(["config", `--blob=${blob}`, "--null", "--list"], { env });
    if (c.code !== 0) return `its ${show(path)} isn't a git config file git can read`;
    for (const e of c.stdout.split("\0").filter(Boolean)) {
      const nl = e.indexOf("\n");
      const key = nl < 0 ? e : e.slice(0, nl), value = nl < 0 ? "" : e.slice(nl + 1);
      if (/[\x00-\x1f\x7f]/.test(key + value)) return `its ${show(path)} has a control character in ${show(key)} (a carriage return in a submodule path is CVE-2025-48384)`;
      if (!/^submodule\..+\.(path|url|update)$/.test(key)) continue;
      if (value.startsWith("-")) return `its ${show(path)} has ${show(key)} = ${show(value)}, which git would read as an option`;
      if (key.endsWith(".update") && value.startsWith("!")) return `its ${show(path)} has ${show(key)} = ${show(value)}, a command`;
      if (key.endsWith(".path") && (value.startsWith("/") || value.split(/[\\/]/).some((c) => c === ".." || isDotGit(c)))) return `its ${show(path)} has ${show(key)} = ${show(value)}, out of the tree or into .git`;
    }
  }
  return null;
}

/**
 * A sandbox's bundle `file` (it should hold one ref, `ref`) into the host repo `git`, at `into`: refused (BundleRefused)
 * unless its header is a plain bundle's with exactly that ref, `git bundle verify` takes it, git's object checks pass
 * on every object in it (FSCK_ERRORS; `index-pack --strict`, on every git version, where `fetch.fsckObjects` skips
 * bundles before git 2.48), and no new commit has a tree treeProblem refuses. The objects go into a quarantine first
 * and into the repository only when all of that passed; no transport, hook or filter runs. `missing`: the repository
 * lacks a commit the bundle builds on (a bundle of everything may do).
 */
export async function receiveBundle(repo: Git, file: string, o: { ref: string; into: string }): Promise<{ ok: true; sha: string } | { ok: false; missing: boolean; detail: string }> {
  if (!file.startsWith("/") || !file.endsWith(".bundle")) throw new Error(`not a bundle file: ${file}`);
  if (!isSafeRefName(o.into)) throw new Error(`not a ref: ${o.into}`);
  const git = asHostGit(repo);
  const why = await hostRepoProblems(git);
  if (why.length) throw new HostRepoRefused(git.cwd, why);
  const gd = await commonDir(git);
  if (!gd) throw new HostRepoRefused(git.cwd, ["not a git repository"]);

  const h = readBundleHeader(file);
  const names = h.refs.map((r) => r.name);
  if (names.length !== 1 || names[0] !== o.ref) throw new BundleRefused(`it should hold ${o.ref} alone, and it holds ${names.length ? names.map(show).join(", ") : "no ref"}`);
  const format = (await git.run(["rev-parse", "--show-object-format"])).stdout.trim() || "sha1";
  if (format !== h.format) throw new BundleRefused(`its objects are ${h.format} and the host's repository's are ${format}`);
  const sha = h.refs[0]!.oid;

  if (h.prerequisites.length) {
    const have = await git.run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: h.prerequisites.join("\n") + "\n" });
    const lacks = h.prerequisites.filter((p) => !have.stdout.includes(`${p} commit`));
    if (lacks.length) return { ok: false, missing: true, detail: `the repository lacks ${lacks.length} commit(s) the bundle builds on (${lacks[0]!.slice(0, 12)}…)` };
  }
  const v = await git.run(["bundle", "verify", file]);
  if (v.code !== 0) {
    const text = (v.stderr || v.stdout).trim();
    if (/lacks these prerequisite|prerequisite/i.test(text)) return { ok: false, missing: true, detail: text.slice(-400) };
    throw new BundleRefused(`git bundle verify: ${text.slice(-400)}`);
  }

  const q = join(gd, "xfer", `quarantine-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const packDir = join(q, "pack");
  mkdirSync(packDir, { recursive: true });
  const pack = fileFrom(file, h.packOffset);
  try {
    const ix = await git.run(["index-pack", "--stdin", "--fix-thin", `--strict=${FSCK_ERRORS}`, "-o", join(packDir, "in.idx"), join(packDir, "in.pack")], { stdin: pack.stream });
    if (ix.code !== 0) {
      const text = ix.stderr.trim();
      if (/unresolved delta|did not receive expected object|missing/i.test(text) && !/fsck error/i.test(text)) return { ok: false, missing: true, detail: text.slice(-400) };
      throw new BundleRefused(`git's object checks failed: ${text.slice(-400)}`);
    }
    const name = /^(?:pack|keep)\t([0-9a-f]+)$/m.exec(ix.stdout)?.[1];
    if (!name) throw new BundleRefused(`git index-pack said ${show(ix.stdout.trim())}`);
    const qenv = { GIT_ALTERNATE_OBJECT_DIRECTORIES: q };
    if ((await git.run(["cat-file", "-t", sha], { env: qenv })).stdout.trim() !== "commit") throw new BundleRefused(`its ref ${o.ref} isn't a commit`);
    const bad = await treeProblem(git, sha, qenv);
    if (bad) throw new BundleRefused(bad);
    // Into the repository: the pack, its reverse index, then its index (git finds a pack by its index).
    const dest = join(gd, "objects", "pack");
    mkdirSync(dest, { recursive: true });
    for (const ext of ["pack", "rev", "idx"]) {
      const from = join(packDir, `in.${ext}`);
      if (existsSync(from)) renameSync(from, join(dest, `pack-${name}.${ext}`));
    }
    const u = await git.run(["update-ref", o.into, sha]);
    if (u.code !== 0) return { ok: false, missing: false, detail: `git update-ref failed: ${u.stderr.trim().slice(0, 300)}` };
    return { ok: true, sha };
  } finally {
    pack.close();
    rmSync(q, { recursive: true, force: true });
  }
}

/** Where a host repo for `remote` named `name` lives under `workdir` (one folder per remote). */
export function hostRepoDir(workdir: string, remote: string, name: string): string {
  return join(workdir, createHash("sha1").update(remote).digest("hex").slice(0, 12), name.replace(/[^a-zA-Z0-9._-]/g, "_"));
}
