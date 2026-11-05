// The one way capcomd runs git that talks to a remote (docs/spec/plugin-api.md §11.7). Two rules:
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
//
// `tests/unit/host-git-lint.test.ts` fails when a network git command is spelled anywhere else.
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Git, type GitResult } from "./git";

/** The git subcommands that talk to a remote. */
export const NETWORK_OPS = ["fetch", "push", "ls-remote", "clone", "pull"] as const;

/** The protocols host git may use: never `ext::` (it runs a command) or `fd::`. */
const ALLOWED_PROTOCOLS = "file:git:http:https:ssh";

/** Where a host repo keeps its marker, in its git dir. */
const MARKER = "capcomd-host-repo.json";
interface Marker { schema: 1; hooks: Record<string, string> }

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
  const git = new Git(dir);
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
export async function hostRepoProblems(git: Git): Promise<string[]> {
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

// ---- credentials -------------------------------------------------------------------------------------------------

let tokenCache: { at: number; token: string | null } | null = null;

/** A GitHub token for git over https to github.com: GITHUB_TOKEN / GH_TOKEN, else `gh auth token` (cached a minute). */
async function githubTokenForGit(): Promise<string | null> {
  const t = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (t) return t;
  if (tokenCache && Date.now() - tokenCache.at < 60_000) return tokenCache.token;
  let token: string | null = null;
  try {
    const proc = Bun.spawn([process.env.CAPCOMD_GH_CLI || "gh", "auth", "token"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) === 0 && out) token = out;
  } catch { /* no gh */ }
  tokenCache = { at: Date.now(), token };
  return token;
}

/**
 * The environment host git gets for `remote`: no prompts, only the plain protocols, and, for an https remote on
 * github.com, the user's GitHub token as the only credential helper for https://github.com, with the token in this one
 * process's environment, never in a file or a URL. The helper list is reset first: git hands a credential that worked to
 * every helper in the list to `store`, so with the user's own helpers still listed (macOS git's system config lists
 * `osxkeychain`) the token would be saved in their keychain or credential store, and a saved copy, once the token
 * changes, would be offered first and fail. Without a token, or for another remote, the user's own helpers apply.
 */
export async function hostCredentialEnv(remote: string, source: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS };
  if (!/^https:\/\/github\.com\//i.test(remote.trim())) return env;
  const token = await githubTokenForGit();
  if (!token) return env;
  const n = Number(source.GIT_CONFIG_COUNT ?? 0) || 0;
  return {
    ...env,
    CAPCOMD_GIT_TOKEN: token,
    GIT_CONFIG_COUNT: String(n + 2),
    // An empty helper clears the helpers listed before it (system, global, local) for https://github.com.
    [`GIT_CONFIG_KEY_${n}`]: "credential.https://github.com.helper",
    [`GIT_CONFIG_VALUE_${n}`]: "",
    [`GIT_CONFIG_KEY_${n + 1}`]: "credential.https://github.com.helper",
    [`GIT_CONFIG_VALUE_${n + 1}`]: '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$CAPCOMD_GIT_TOKEN"; }; f',
  };
}

// ---- running it --------------------------------------------------------------------------------------------------

export interface RemoteGitOptions { timeoutMs?: number; signal?: AbortSignal; input?: string; env?: Record<string, string> }

/**
 * A network git command (`fetch`, `push`, `ls-remote`) against `remote` (its URL, which must be in `args`), in
 * `git`'s repository, which must be a host repo that passes hostRepoProblems: else HostRepoRefused.
 */
export async function remoteGit(git: Git, args: string[], remote: string, o: RemoteGitOptions = {}): Promise<GitResult> {
  const op = args[0] ?? "";
  if (!(NETWORK_OPS as readonly string[]).includes(op) || op === "clone" || op === "pull") throw new Error(`remoteGit runs fetch, push or ls-remote, not ${op}`);
  assertRemoteUrl(remote);
  if (!args.includes(remote)) throw new Error(`remoteGit needs the remote's URL in its arguments (git ${op})`);
  const why = await hostRepoProblems(git);
  if (why.length) throw new HostRepoRefused(git.cwd, why);
  return git.run(args, { ...o, env: { ...(await hostCredentialEnv(remote)), ...(o.env ?? {}) } });
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
  return new Git(cwd).run(["ls-remote", ...rest.filter((a) => a.startsWith("-")), remote, ...rest.filter((a) => !a.startsWith("-"))], {
    ...o, env: { ...(await hostCredentialEnv(remote)), GIT_CEILING_DIRECTORIES: ceiling, ...(o.env ?? {}) },
  });
}

/** The remote's default branch (`ls-remote --symref <remote> HEAD`), or null when it doesn't say. */
export async function remoteDefaultBranch(remote: string, o: RemoteGitOptions = {}): Promise<string | null> {
  const r = await lsRemote(remote, ["--symref", "HEAD"], o);
  if (r.code !== 0) return null;
  return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout)?.[1] ?? null;
}

/** Read a bundle file capcomd wrote (a sandbox's commit) into a host repo: a local file, no remote, no credentials. */
export async function fetchBundle(git: Git, file: string, refspec: string): Promise<GitResult> {
  if (!file.startsWith("/") || !file.endsWith(".bundle")) throw new Error(`not a bundle file: ${file}`);
  const why = await hostRepoProblems(git);
  if (why.length) throw new HostRepoRefused(git.cwd, why);
  return git.run(["fetch", "-q", "--no-tags", "--no-write-fetch-head", file, refspec], { env: { GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file" } });
}

/** Where a host repo for `remote` named `name` lives under `workdir` (one folder per remote). */
export function hostRepoDir(workdir: string, remote: string, name: string): string {
  return join(workdir, createHash("sha1").update(remote).digest("hex").slice(0, 12), name.replace(/[^a-zA-Z0-9._-]/g, "_"));
}
