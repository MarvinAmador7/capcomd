// Git objects between a sandbox and the remote, through the host (docs/spec/plugin-api.md §11.7): the sandbox never
// holds a credential. Fetches go remote → the host's mirror (a host repo, src/merge/host-git.ts) → a bundle → the
// sandbox's checkout; pushes go the other way: a bundle the sandbox makes of the commit → the mirror → the remote, by
// its URL. In the sandbox git only makes and reads bundle files (no network, no credentials), so whatever an agent
// planted in its checkout, its HOME or its PATH sees no token and can't redirect where the host pushes.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Git } from "./git";
import { fetchBundle, HostRepoRefused, hostRepoDir, initHostRepo, isHostRepo, remoteGit } from "./host-git";
import { withTargetLock } from "./lock";
import { withSpan } from "../utils/tracing-simple";

/** The `git.<op>` span a sandbox's git command made before (docs/integration-agents.md: a run's trace has `git.push`
 *  spans), now that the host runs it: `git.via: "host"` says so. */
export function gitSpan<T>(op: string, ref: string | undefined, fn: () => Promise<T>): Promise<T> {
  return withSpan(`git.${op}`, { "git.operation": op, ...(ref ? { "git.ref": ref } : {}), "git.via": "host" }, () => fn());
}

/** A command in the sandbox (no credentials), and its file transfer. */
export interface SandboxGit {
  exec(cmd: string[], o?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  upload(path: string, data: Uint8Array): Promise<void>;
  /** Needed for pushes only. */
  download?(path: string): Promise<Uint8Array>;
}

/** The run's repository as the host reaches it: its URL and where capcomd keeps its host repos. */
export interface HostRemote { remote: string; workdir: string }

export class TransferError extends Error {
  constructor(message: string, readonly kind: "remote" | "sandbox" | "refused" = "remote") { super(message); this.name = "TransferError"; }
}

const HEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const tail = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().slice(-400);
/** The biggest bundle the host takes from a sandbox (CAPCOMD_BUNDLE_MAX_BYTES, default 4 GiB). */
const MAX_BUNDLE = () => Number(process.env.CAPCOMD_BUNDLE_MAX_BYTES ?? 4 * 1024 ** 3);
let seq = 0;
const uniq = () => `${process.pid}-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function isBranchName(b: string): boolean {
  return BRANCH.test(b) && !b.includes("..") && !b.endsWith(".lock") && !b.endsWith("/") && !b.includes("//") && !b.includes("@{");
}

/** The host's mirror of `h.remote`: a bare host repo, made on first use (or when `fresh`, over what was there). Every
 *  network call in it checks it first (remoteGit); fetchMirror starts it over when that check fails. */
export async function mirror(h: HostRemote, o: { fresh?: boolean } = {}): Promise<Git> {
  const dir = hostRepoDir(h.workdir, h.remote, "_mirror");
  if (!o.fresh && existsSync(join(dir, "HEAD")) && isHostRepo(dir)) return new Git(dir);
  rmSync(dir, { recursive: true, force: true });
  return initHostRepo(dir, { bare: true });
}

const withMirrorLock = <T>(h: HostRemote, fn: () => Promise<T>) => withTargetLock(join(h.workdir, "locks"), h.remote, "\0mirror", fn);

/** The mirror, fetched (under its lock), and the commits pinned at temporary refs, so a concurrent prune can't take
 *  them away before they are bundled. A mirror that fails the host repo check is started over, once. */
async function fetchedMirror(h: HostRemote, branches: "all" | string[], o: { ref?: string; tmpRef: string; timeoutMs?: number }) {
  return withMirrorLock(h, async () => {
    let m = await mirror(h);
    let r: Awaited<ReturnType<typeof fetchMirror>>;
    try { r = await fetchMirror(h, m, branches, o); } catch (e) {
      if (!(e instanceof HostRepoRefused)) throw e;
      m = await mirror(h, { fresh: true });
      r = await fetchMirror(h, m, branches, o);
    }
    const pins = Object.values(r.heads).map((sha, i) => ({ ref: `${o.tmpRef}/h${i}`, sha }));
    if (r.ref) pins.push({ ref: `${o.tmpRef}/ref`, sha: r.ref });
    if (pins.length) await m.ok(["update-ref", "--stdin"], { input: pins.map((p) => `update ${p.ref} ${p.sha}`).join("\n") + "\n" });
    return { m, ...r, pins: pins.map((p) => p.ref) };
  });
}

/** Where each branch is on the remote, fetched into the mirror (all branches, pruned, or `branches`). */
async function fetchMirror(h: HostRemote, m: Git, branches: "all" | string[], o: { ref?: string; tmpRef: string; timeoutMs?: number }): Promise<{ heads: Record<string, string>; ref?: string }> {
  const timeoutMs = o.timeoutMs ?? 600_000;
  const specs = branches === "all" ? ["+refs/heads/*:refs/remotes/origin/*"] : branches.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`);
  if (specs.length) {
    const f = await remoteGit(m, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", ...(branches === "all" ? ["--prune"] : []), h.remote, ...specs], h.remote, { timeoutMs });
    if (f.code !== 0) throw new TransferError(`git fetch from ${h.remote} failed${f.timedOut ? " (timed out)" : ""}: ${tail(f)}`);
  }
  let ref: string | undefined;
  if (o.ref) {
    // A commit the mirror already has needs no round trip; else the ref (or commit) is fetched by name.
    const have = HEX.test(o.ref) && (await m.run(["cat-file", "-e", `${o.ref}^{commit}`])).code === 0;
    if (have) ref = o.ref;
    else {
      const f = await remoteGit(m, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", h.remote, `+${o.ref}:${o.tmpRef}/ref`], h.remote, { timeoutMs });
      if (f.code !== 0) throw new TransferError(`git fetch ${o.ref} from ${h.remote} failed${f.timedOut ? " (timed out)" : ""}: ${tail(f)}`);
      ref = (await m.ok(["rev-parse", `${o.tmpRef}/ref^{commit}`])).trim();
    }
  }
  const pattern = branches === "all" ? ["refs/remotes/origin/"] : branches.map((b) => `refs/remotes/origin/${b}`);
  const heads: Record<string, string> = {};
  if (pattern.length) {
    const l = await m.ok(["for-each-ref", "--format=%(objectname) %(refname)", ...pattern]);
    for (const line of l.split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (!sha || !name?.startsWith("refs/remotes/origin/")) continue;
      const b = name.slice("refs/remotes/origin/".length);
      if (b !== "HEAD" && (branches === "all" || branches.includes(b))) heads[b] = sha;
    }
  }
  if (branches !== "all") for (const b of branches) if (!heads[b]) throw new TransferError(`no branch ${b} on ${h.remote}`);
  return { heads, ...(ref ? { ref } : {}) };
}

/** The commits among `shas` the mirror has (one `cat-file --batch-check`). */
async function mirrorHas(m: Git, shas: string[]): Promise<string[]> {
  const list = [...new Set(shas.filter((s) => HEX.test(s)))];
  if (!list.length) return [];
  const r = await m.run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: list.join("\n") + "\n" });
  return r.stdout.split("\n").map((l) => l.trim().split(" ")).filter(([, t]) => t === "commit").map(([s]) => s!);
}

export interface SendRequest {
  /** The branches to bring as refs/remotes/origin/<b>: every one (pruning the rest) or these. */
  branches: "all" | string[];
  /** One more ref or commit to bring (a checkpoint ref, a stopped agent's branch, a commit): its sha is answered. */
  ref?: string;
  /** With `branches: "all"` in a fresh repository: set up `origin` and check out this branch tracking it (a clone). */
  checkout?: string;
  timeoutMs?: number;
}
export interface SendResult { heads: Record<string, string>; ref?: string; bytes: number }

/**
 * Remote → the sandbox's repository `dir` (made with `git init` first when `fresh`): the host fetches into its mirror,
 * makes a bundle of what the sandbox doesn't have yet, uploads it, and the sandbox reads it and sets the refs the host
 * names. The sandbox's `origin` stays the remote's URL, without credentials.
 */
export function sendToSandbox(h: HostRemote, s: SandboxGit, dir: string, req: SendRequest, o: { fresh?: boolean } = {}): Promise<SendResult> {
  return gitSpan(o.fresh ? "clone" : "fetch", req.ref, () => send(h, s, dir, req, o));
}

async function send(h: HostRemote, s: SandboxGit, dir: string, req: SendRequest, o: { fresh?: boolean }): Promise<SendResult> {
  if (req.branches !== "all") for (const b of req.branches) if (!isBranchName(b)) throw new TransferError(`not a branch name: ${JSON.stringify(b).slice(0, 200)}`, "refused");
  if (req.ref !== undefined && !(HEX.test(req.ref) || /^refs\/[A-Za-z0-9._/-]+$/.test(req.ref)) ) throw new TransferError(`not a ref: ${JSON.stringify(req.ref).slice(0, 200)}`, "refused");
  const id = uniq();
  const tmpRef = `refs/capcomd/xfer/${id}`;
  const sx = (script: string, timeoutMs = 600_000) => s.exec(["sh", "-c", script], { timeoutMs });
  // A fresh repository (a clone), or what the sandbox has already (its remote-tracking refs and HEAD), to leave out of
  // the bundle.
  const theirs = o.fresh
    ? await sx(`rm -rf ${sq(dir)} && mkdir -p ${sq(dir)} && cd ${sq(dir)} && git init -q && git remote add origin ${sq(h.remote)}`)
    : await sx(`cd ${sq(dir)} && git rev-parse --git-dir >/dev/null && { git for-each-ref --format='%(objectname) %(refname)' refs/remotes/origin/; git rev-parse -q --verify HEAD; true; }`);
  if (theirs.code !== 0) throw new TransferError(o.fresh ? `git init in the sandbox failed: ${tail(theirs)}` : `${dir} in the sandbox isn't a git checkout: ${tail(theirs)}`, "sandbox");
  const theirRefs = new Map<string, string>();
  const theirShas: string[] = [];
  for (const line of theirs.stdout.split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (!sha || !HEX.test(sha)) continue;
    theirShas.push(sha);
    if (name?.startsWith("refs/remotes/origin/")) theirRefs.set(name.slice("refs/remotes/origin/".length), sha);
  }
  const files: string[] = [];
  let got: Awaited<ReturnType<typeof fetchedMirror>> | null = null;
  try {
    got = await fetchedMirror(h, req.branches, { ...(req.ref ? { ref: req.ref } : {}), tmpRef, ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}) });
    const m = got.m;
    const want = [...new Set([...Object.values(got.heads), ...(got.ref ? [got.ref] : [])])];
    const known = new Set(await mirrorHas(m, theirShas));
    let bytes = 0;
    const missing = want.filter((x) => !known.has(x));
    const bundleTo = async (negatives: string[]) => {
      const file = join(m.cwd, "xfer", `out-${id}.bundle`);
      mkdirSync(join(m.cwd, "xfer"), { recursive: true });
      files.push(file);
      const b = await m.run(["bundle", "create", "-q", file, "--stdin"], { input: [...got!.pins, ...negatives.map((n) => `^${n}`)].join("\n") + "\n" });
      if (b.code !== 0) {
        if (/empty bundle/i.test(b.stderr)) return null;
        throw new TransferError(`git bundle create failed: ${tail(b)}`);
      }
      return file;
    };
    const into = `/tmp/capcomd-in-${id}.bundle`;
    if (req.checkout && !got.heads[req.checkout]) throw new TransferError(`no branch ${req.checkout} on ${h.remote}`);
    const heads = got.heads, ref = got.ref;
    // In the sandbox: read the bundle into temporary refs, set the refs the host names (its branch names, quoted), drop
    // the temporary ones; for a clone, check out the branch tracking origin.
    const apply = async (file: string | null) => {
      const lines: string[] = [];
      for (const [b, sha] of Object.entries(heads)) lines.push(`update refs/remotes/origin/${b} ${sha}`);
      if (req.branches === "all") for (const b of theirRefs.keys()) if (b !== "HEAD" && !heads[b]) lines.push(`delete refs/remotes/origin/${b}`);
      if (ref) lines.push(`update refs/capcomd/fetched ${ref}`);
      const fetch = file ? `git fetch -q --no-tags --no-write-fetch-head ${sq(into)} ${sq(`refs/capcomd/xfer/${id}/*:refs/capcomd/in/${id}/*`)} && ` : "";
      const checkout = req.checkout ? ` && git symbolic-ref refs/remotes/origin/HEAD ${sq(`refs/remotes/origin/${req.checkout}`)} && git checkout -q -B ${sq(req.checkout)} --track ${sq(`origin/${req.checkout}`)}` : "";
      return sx(`cd ${sq(dir)} || exit 1
${fetch}printf '%s\\n' ${lines.map(sq).join(" ")} | git update-ref --stdin${checkout}; rc=$?
[ -z ${sq(file ?? "")} ] || git for-each-ref --format='delete %(refname)' ${sq(`refs/capcomd/in/${id}/`)} | git update-ref --stdin; rm -f ${sq(into)}; exit $rc`);
    };
    let file = missing.length ? await bundleTo([...known]) : null;
    if (file) { const data = readFileSync(file); bytes = data.length; await s.upload(into, data); }
    let r = await apply(file);
    // The sandbox didn't have what its refs said (an agent can point them anywhere): everything, without prerequisites.
    if (r.code !== 0 && file && /prerequisite|missing|bad object|not a valid object/i.test(r.stderr + r.stdout)) {
      file = await bundleTo([]);
      if (file) { const data = readFileSync(file); bytes = data.length; await s.upload(into, data); }
      r = await apply(file);
    }
    if (r.code !== 0) throw new TransferError(`reading the fetched branches into ${dir} in the sandbox failed: ${tail(r)}`, "sandbox");
    return { heads, ...(ref ? { ref } : {}), bytes };
  } finally {
    for (const f of files) rmSync(f, { force: true });
    if (got?.pins.length) await got.m.run(["update-ref", "--stdin"], { input: got.pins.map((p) => `delete ${p}`).join("\n") + "\n" }).catch(() => {});
  }
}

/** Remote → a plain directory in the sandbox: `branch`'s tree as a tar (`git archive` from the mirror), no history,
 *  no .git (what a shallow clone was for: a lockfile and its dependencies). Answers the commit. */
export async function sendTree(h: HostRemote, s: SandboxGit, dir: string, branch: string): Promise<string> {
  if (!isBranchName(branch)) throw new TransferError(`not a branch name: ${JSON.stringify(branch).slice(0, 200)}`, "refused");
  const id = uniq();
  const got = await fetchedMirror(h, [branch], { tmpRef: `refs/capcomd/xfer/${id}` });
  const sha = got.heads[branch]!;
  await got.m.run(["update-ref", "--stdin"], { input: got.pins.map((p) => `delete ${p}`).join("\n") + "\n" }).catch(() => {});
  await unpackTree(got.m, s, dir, sha, id, branch);
  return sha;
}

/**
 * Remote → a plain directory in the sandbox at one commit, as sendTree does a branch's tip: a context bundle (a brain,
 * ADR-025 §6.2) at the commit its brief cites. The host's mirror fetches the commit by name when it hasn't got it; a
 * remote that won't serve a commit by name is fetched at `branch`, which must have it.
 */
export async function sendTreeAt(h: HostRemote, s: SandboxGit, dir: string, commit: string, o: { branch?: string | null } = {}): Promise<string> {
  if (!HEX.test(commit)) throw new TransferError(`not a commit: ${JSON.stringify(commit).slice(0, 200)}`, "refused");
  if (o.branch != null && !isBranchName(o.branch)) throw new TransferError(`not a branch name: ${JSON.stringify(o.branch).slice(0, 200)}`, "refused");
  const id = uniq();
  const tmpRef = `refs/capcomd/xfer/${id}`;
  let got: Awaited<ReturnType<typeof fetchedMirror>>;
  try { got = await fetchedMirror(h, [], { ref: commit, tmpRef }); } catch (e) {
    if (!o.branch || !(e instanceof TransferError)) throw e;
    got = await fetchedMirror(h, [o.branch], { ref: commit, tmpRef });
  }
  try {
    if (got.ref !== commit) throw new TransferError(`the host's copy of ${h.remote} has ${String(got.ref).slice(0, 12)}, not ${commit.slice(0, 12)}`, "refused");
    await unpackTree(got.m, s, dir, commit, id, commit.slice(0, 12));
    return commit;
  } finally {
    await got.m.run(["update-ref", "--stdin"], { input: got.pins.map((p) => `delete ${p}`).join("\n") + "\n" }).catch(() => {});
  }
}

/** `sha`'s tree from the mirror `m`, as a tar (`git archive`), unpacked into `dir` in the sandbox (made anew). */
async function unpackTree(m: Git, s: SandboxGit, dir: string, sha: string, id: string, what: string): Promise<void> {
  const proc = Bun.spawn(["git", "archive", "--format=tar", sha], { cwd: m.cwd, stdout: "pipe", stderr: "pipe" });
  const [tar, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new TransferError(`git archive ${what} failed: ${err.trim().slice(-300)}`);
  const at = `/tmp/capcomd-tree-${id}.tar`;
  await s.upload(at, new Uint8Array(tar));
  const r = await s.exec(["sh", "-c", `rm -rf ${sq(dir)} && mkdir -p ${sq(dir)} && tar -xf ${sq(at)} -C ${sq(dir)}; rc=$?; rm -f ${sq(at)}; exit $rc`], { timeoutMs: 600_000 });
  if (r.code !== 0) throw new TransferError(`unpacking ${what} in the sandbox failed: ${tail(r)}`, "sandbox");
}

export interface PushRequest {
  /** The commit in the sandbox's repository to push. */
  sha: string;
  /** The ref on the remote it goes to (`refs/heads/<b>`, `refs/capcomd/checkpoints/<agent>`). */
  ref: string;
  /** Lease: the commit the remote ref must be at (null: it must not exist); absent with `force`: overwrite. */
  expect?: string | null;
  force?: boolean;
  /** Branches whose commits the sandbox has from the host (the target, its branch): left out of the bundle. */
  near?: string[];
  timeoutMs?: number;
  /** The `git.ref` its `git.push` span carries (default `<sha>:<ref>`). */
  spanRef?: string;
}

/**
 * The sandbox's commit `sha` (in `dir`) → the remote's `ref`: the sandbox bundles it (without credentials, leaving
 * out what the mirror has), the host downloads the bundle into its mirror, checks the commit is the one asked for,
 * and pushes it from there to the remote's URL with a lease. Nothing in the sandbox's checkout is read but the bundle.
 */
export function pushFromSandbox(h: HostRemote, s: SandboxGit, dir: string, p: PushRequest): Promise<{ porcelain: string; bytes: number }> {
  return gitSpan("push", p.spanRef ?? `${p.sha}:${p.ref}`, () => push(h, s, dir, p));
}

async function push(h: HostRemote, s: SandboxGit, dir: string, p: PushRequest): Promise<{ porcelain: string; bytes: number }> {
  if (!HEX.test(p.sha)) throw new TransferError(`not a commit: ${JSON.stringify(p.sha).slice(0, 100)}`, "refused");
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(p.ref) || p.ref.includes("..")) throw new TransferError(`not a ref: ${JSON.stringify(p.ref).slice(0, 200)}`, "refused");
  if (!s.download) throw new TransferError("this sandbox can't hand files to the host", "sandbox");
  const id = uniq();
  const tmpRef = `refs/capcomd/xfer/${id}/in`;
  const m = await withMirrorLock(h, () => mirror(h));
  const sx = (script: string, timeoutMs = 600_000) => s.exec(["sh", "-c", script], { timeoutMs });
  let bytes = 0;
  const local: string[] = [];
  try {
    if ((await m.run(["cat-file", "-e", `${p.sha}^{commit}`])).code !== 0) {
      // Leave out what the mirror has: the branches named, then the most recent others.
      const near = new Set((p.near ?? []).filter(isBranchName).map((b) => `refs/remotes/origin/${b}`));
      const all = (await m.run(["for-each-ref", "--sort=-committerdate", "--format=%(objectname) %(refname)", "refs/remotes/origin/"])).stdout.split("\n").map((l) => l.trim().split(" "));
      const negs = [...new Set([...all.filter(([, n]) => near.has(n!)), ...all.slice(0, 200)].map(([x]) => x ?? "").filter((x) => HEX.test(x)))];
      const out = `/tmp/capcomd-out-${id}.bundle`;
      const negFile = `${out}.not`;
      const bundle = async (withNegs: boolean) => {
        await s.upload(negFile, new TextEncoder().encode((withNegs ? negs : []).join("\n") + "\n"));
        // In the sandbox: the commits it has among those, as exclusions; the commit at a temporary ref, bundled.
        const r = await sx(`cd ${sq(dir)} || exit 1
git cat-file --batch-check='%(objectname) %(objecttype)' < ${sq(negFile)} | awk '$2=="commit"{print "^"$1}' > ${sq(`${negFile}.ok`)}
git update-ref ${sq(`refs/capcomd/out/${id}`)} ${sq(p.sha)} || exit 3
{ echo ${sq(`refs/capcomd/out/${id}`)}; cat ${sq(`${negFile}.ok`)}; } | git bundle create -q ${sq(out)} --stdin; rc=$?
git update-ref -d ${sq(`refs/capcomd/out/${id}`)}; rm -f ${sq(negFile)} ${sq(`${negFile}.ok`)}
[ $rc = 0 ] || exit $rc
wc -c < ${sq(out)}`);
        if (r.code !== 0) throw new TransferError(`bundling ${p.sha.slice(0, 12)} in the sandbox failed: ${tail(r)}`, "sandbox");
        const size = Number(r.stdout.trim().split("\n").pop());
        if (!(size > 0) || size > MAX_BUNDLE()) throw new TransferError(`the sandbox's bundle of ${p.sha.slice(0, 12)} is ${size} bytes (at most ${MAX_BUNDLE()})`, "refused");
        const data = await s.download!(out);
        await sx(`rm -f ${sq(out)}`).catch(() => {});
        if (data.length > MAX_BUNDLE()) throw new TransferError(`the sandbox's bundle is ${data.length} bytes (at most ${MAX_BUNDLE()})`, "refused");
        const file = join(m.cwd, "xfer", `in-${id}.bundle`);
        mkdirSync(join(m.cwd, "xfer"), { recursive: true });
        writeFileSync(file, data);
        local.push(file);
        bytes = data.length;
        return file;
      };
      const read = (file: string) => fetchBundle(m, file, `+refs/capcomd/out/${id}:${tmpRef}`);
      let f = await read(await bundle(true));
      // The mirror lacks a commit the sandbox left out (a ref there pointed somewhere else): everything, then.
      if (f.code !== 0) f = await read(await bundle(false));
      if (f.code !== 0) throw new TransferError(`the host couldn't read the sandbox's bundle: ${tail(f)}`);
      const got = (await m.ok(["rev-parse", `${tmpRef}^{commit}`])).trim();
      if (got !== p.sha) throw new TransferError(`the sandbox's bundle holds ${got.slice(0, 12)}, not ${p.sha.slice(0, 12)}`, "refused");
    }
    const lease = p.expect !== undefined ? [`--force-with-lease=${p.ref}:${p.expect ?? ""}`] : p.force ? ["--force"] : [];
    const push = await remoteGit(m, ["push", "--porcelain", ...lease, h.remote, `${p.sha}:${p.ref}`], h.remote, { timeoutMs: p.timeoutMs ?? 600_000 });
    if (push.code !== 0) throw new TransferError(`git push to ${h.remote} failed${push.timedOut ? " (timed out)" : ""}: ${(push.stdout + push.stderr).trim().slice(-500)}`);
    return { porcelain: push.stdout, bytes };
  } finally {
    for (const f of local) rmSync(f, { force: true });
    await m.run(["update-ref", "-d", tmpRef]).catch(() => {});
  }
}
