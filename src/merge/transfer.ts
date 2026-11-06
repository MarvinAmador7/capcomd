// Git objects between a sandbox and the remote, through the host (docs/spec/plugin-api.md §11.7): the sandbox never
// holds a credential. Fetches go remote → the host's mirror (a host repo, src/merge/host-git.ts) → a bundle → the
// sandbox's checkout; pushes go the other way: a bundle the sandbox makes of the commit → the mirror → the remote, by
// its URL. In the sandbox git only makes and reads bundle files (no network, no credentials), so whatever an agent
// planted in its checkout, its HOME or its PATH sees no token and can't redirect where the host pushes.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { Git } from "./git";
import { fetchBundle, HostRepoRefused, hostRepoDir, initHostRepo, isHostRepo, remoteGit } from "./host-git";
import { withTargetLock } from "./lock";
import { addSpanEvent, setSpanAttributes, withSpan, type SimpleSpan } from "../utils/tracing-simple";

/** The `git.<op>` span a sandbox's git command made before (docs/integration-agents.md: a run's trace has `git.push`
 *  spans), now that the host runs it: `git.via: "host"` says so. */
export function gitSpan<T>(op: string, ref: string | undefined, fn: (span: SimpleSpan) => Promise<T>): Promise<T> {
  return withSpan(`git.${op}`, { "git.operation": op, ...(ref ? { "git.ref": ref } : {}), "git.via": "host" }, (span) => fn(span));
}

/**
 * Where a long transfer is, reported while it runs: `fetch` (the host's mirror from the remote: git's own progress
 * line), `upload` (a bundle or tree, host → sandbox) or `download` (the sandbox's bundle → host), with the bytes moved
 * and the total when known. A report comes at most every CAPCOMD_TRANSFER_PROGRESS_SECONDS (default 15), and one with
 * `done` when a phase that was reported ends, so a quick transfer says nothing and a 20-minute one is never silent.
 */
export interface TransferProgress { phase: "fetch" | "upload" | "download"; bytes: number; total: number | null; ms: number; done: boolean; line?: string }
export type OnTransferProgress = (p: TransferProgress) => void;

const PROGRESS_EVERY_MS = () => Number(process.env.CAPCOMD_TRANSFER_PROGRESS_SECONDS ?? 15) * 1000;
/** How long the mirror's fetch may go without progress before it fails (CAPCOMD_GIT_STALL_SECONDS, default 300). */
export const STALL_MS = () => Number(process.env.CAPCOMD_GIT_STALL_SECONDS ?? 300) * 1000;
/** The mirror's fetch's overall cap, however it progresses (CAPCOMD_GIT_FETCH_MAX_SECONDS, default 3 hours). */
export const FETCH_MAX_MS = () => Number(process.env.CAPCOMD_GIT_FETCH_MAX_SECONDS ?? 3 * 3600) * 1000;
/** How much of a file is in memory, and in one provider upload or download, at a time (CAPCOMD_TRANSFER_CHUNK_BYTES,
 *  default 8 MiB). */
const CHUNK = () => Math.max(64 * 1024, Number(process.env.CAPCOMD_TRANSFER_CHUNK_BYTES ?? 8 * 1024 ** 2));
/** How long the sandbox may take to read a bundle: 10 minutes, or 2 s per MB of a bigger one (git indexes the pack). */
const applyMs = (bytes: number) => Math.max(600_000, Math.ceil(bytes / 1024 ** 2) * 2000);

type Report = (bytes: number, o?: { done?: boolean; line?: string }) => void;
/** A phase's reporter: to `onProgress` and as a `git.progress` event on the transfer's span, throttled (see above). */
function reporter(phase: TransferProgress["phase"], total: number | null, span: SimpleSpan | undefined, onProgress: OnTransferProgress | undefined): Report {
  const t0 = Date.now();
  let last = t0, said = false;
  return (bytes, o = {}) => {
    const now = Date.now();
    if (o.done ? !said && now - t0 < PROGRESS_EVERY_MS() : now - last < PROGRESS_EVERY_MS()) return;
    last = now;
    said = true;
    const p: TransferProgress = { phase, bytes, total, ms: now - t0, done: !!o.done, ...(o.line ? { line: o.line } : {}) };
    if (span) addSpanEvent(span, "git.progress", { "git.phase": phase, "git.bytes": bytes, ...(total !== null ? { "git.total_bytes": total } : {}), "git.ms": p.ms, "git.done": p.done, ...(o.line ? { "git.line": o.line.slice(0, 200) } : {}) });
    onProgress?.(p);
  };
}

const mb = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MB`;
const took = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
/** One line for a log (an agent's, engine.log, `env build`'s): `what` names the transfer ("git clone"). */
export function progressLine(what: string, p: TransferProgress): string {
  if (p.phase === "fetch") return `${what}: the host is fetching the repository into its mirror${p.done ? `, done in ${took(p.ms)}` : `: ${p.line ?? "…"} (${took(p.ms)})`}`;
  const dir = p.phase === "upload" ? "to the sandbox" : "from the sandbox";
  const rate = p.ms > 0 ? ` at ${(p.bytes / 1024 ** 2 / (p.ms / 1000)).toFixed(2)} MB/s` : "";
  if (p.done) return `${what}: ${p.phase === "upload" ? "uploaded" : "downloaded"} ${mb(p.bytes)} ${dir} in ${took(p.ms)}${rate}`;
  const of = p.total ? ` of ${mb(p.total)} (${Math.floor((p.bytes / p.total) * 100)}%)` : "";
  return `${what}: ${p.phase === "upload" ? "uploading" : "downloading"} ${mb(p.bytes)}${of} ${dir}, ${took(p.ms)}${rate}`;
}

/**
 * A host file → `to` in the sandbox, read from disk a chunk at a time (never whole in memory): one upload when it fits
 * in a chunk, else each chunk as its own file, joined in the sandbox. Answers its size.
 */
async function uploadFile(s: SandboxGit, file: string, to: string, report: Report): Promise<number> {
  const size = statSync(file).size;
  const chunk = CHUNK();
  if (size <= chunk) {
    await s.upload(to, readFileSync(file));
    report(size, { done: true });
    return size;
  }
  const parts = `${to}.parts`;
  const mk = await s.exec(["sh", "-c", `rm -rf ${sq(parts)} && mkdir -p ${sq(parts)}`]);
  if (mk.code !== 0) throw new TransferError(`making ${parts} in the sandbox failed: ${tail(mk)}`, "sandbox");
  const fd = openSync(file, "r");
  try {
    for (let off = 0, n = 0; off < size; off += chunk, n++) {
      const data = new Uint8Array(Math.min(chunk, size - off));
      readSync(fd, data, 0, data.length, off);
      await s.upload(`${parts}/${String(n).padStart(6, "0")}`, data);
      report(off + data.length);
    }
  } finally { closeSync(fd); }
  const join_ = await s.exec(["sh", "-c", `cat ${sq(parts)}/* > ${sq(to)}; rc=$?; rm -rf ${sq(parts)}; [ $rc = 0 ] && [ "$(wc -c < ${sq(to)} | tr -d ' ')" = ${size} ]`], { timeoutMs: 600_000 });
  if (join_.code !== 0) throw new TransferError(`joining the ${size}-byte upload in the sandbox failed: ${tail(join_)}`, "sandbox");
  report(size, { done: true });
  return size;
}

/** `from` in the sandbox (`size` bytes) → `file` on the host, a chunk at a time, as uploadFile does the other way: the
 *  sandbox splits it, the host downloads and appends each part. */
async function downloadFile(s: SandboxGit, from: string, file: string, size: number, report: Report): Promise<number> {
  const chunk = CHUNK();
  if (size <= chunk) {
    const data = await s.download!(from);
    writeFileSync(file, data);
    report(data.length, { done: true });
    return data.length;
  }
  const parts = `${from}.parts`;
  const sp = await s.exec(["sh", "-c", `rm -rf ${sq(parts)} && mkdir -p ${sq(parts)} && split -b ${chunk} -a 6 ${sq(from)} ${sq(`${parts}/p.`)} && ls ${sq(parts)}`], { timeoutMs: 600_000 });
  if (sp.code !== 0) throw new TransferError(`splitting ${from} in the sandbox failed: ${tail(sp)}`, "sandbox");
  writeFileSync(file, new Uint8Array(0));
  let got = 0;
  try {
    for (const name of sp.stdout.split("\n").map((l) => l.trim()).filter((l) => /^p\.[a-z]+$/.test(l)).sort()) {
      const data = await s.download!(`${parts}/${name}`);
      got += data.length;
      if (got > MAX_BUNDLE()) throw new TransferError(`the sandbox's bundle is over ${MAX_BUNDLE()} bytes`, "refused");
      appendFileSync(file, data);
      report(got);
    }
  } finally {
    await s.exec(["sh", "-c", `rm -rf ${sq(parts)}`]).catch(() => {});
  }
  report(got, { done: true });
  return got;
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
async function fetchedMirror(h: HostRemote, branches: "all" | string[], o: FetchOptions) {
  return withMirrorLock(h, async () => {
    let m = await mirror(h);
    let r: Awaited<ReturnType<typeof fetchMirror>>;
    try { r = await fetchMirror(h, m, branches, o); } catch (e) {
      if (!(e instanceof HostRepoRefused)) throw e;
      m = await mirror(h, { fresh: true });
      r = await fetchMirror(h, m, branches, o);
    }
    o.report?.(0, { done: true });
    const pins = Object.values(r.heads).map((sha, i) => ({ ref: `${o.tmpRef}/h${i}`, sha }));
    if (r.ref) pins.push({ ref: `${o.tmpRef}/ref`, sha: r.ref });
    if (pins.length) await m.ok(["update-ref", "--stdin"], { input: pins.map((p) => `update ${p.ref} ${p.sha}`).join("\n") + "\n" });
    return { m, ...r, pins: pins.map((p) => p.ref) };
  });
}

/** How the mirror's fetch is bounded and watched: `timeoutMs` caps it (default FETCH_MAX_MS), a stall (STALL_MS without
 *  progress) ends it sooner, and `report` hears git's progress. */
interface FetchOptions { ref?: string; tmpRef: string; timeoutMs?: number; report?: Report }

/** A mirror fetch that hit its cap says so (a stall's stderr says it made no progress). */
const ended = (f: { timedOut?: boolean; stalled?: boolean }) => f.timedOut && !f.stalled ? " (timed out)" : "";

/** Where each branch is on the remote, fetched into the mirror (all branches, pruned, or `branches`). */
async function fetchMirror(h: HostRemote, m: Git, branches: "all" | string[], o: FetchOptions): Promise<{ heads: Record<string, string>; ref?: string }> {
  // A big first fetch is slow but moving: it runs while git reports progress, up to the cap.
  const bound = { timeoutMs: o.timeoutMs ?? FETCH_MAX_MS(), stallMs: STALL_MS(), ...(o.report ? { onProgress: (line: string) => o.report!(0, { line }) } : {}) };
  const specs = branches === "all" ? ["+refs/heads/*:refs/remotes/origin/*"] : branches.map((b) => `+refs/heads/${b}:refs/remotes/origin/${b}`);
  if (specs.length) {
    const f = await remoteGit(m, ["fetch", "--progress", "--no-tags", "--no-write-fetch-head", ...(branches === "all" ? ["--prune"] : []), h.remote, ...specs], h.remote, bound);
    if (f.code !== 0) throw new TransferError(`git fetch from ${h.remote} failed${ended(f)}: ${tail(f)}`);
  }
  let ref: string | undefined;
  if (o.ref) {
    // A commit the mirror already has needs no round trip; else the ref (or commit) is fetched by name.
    const have = HEX.test(o.ref) && (await m.run(["cat-file", "-e", `${o.ref}^{commit}`])).code === 0;
    if (have) ref = o.ref;
    else {
      const f = await remoteGit(m, ["fetch", "--progress", "--no-tags", "--no-write-fetch-head", h.remote, `+${o.ref}:${o.tmpRef}/ref`], h.remote, bound);
      if (f.code !== 0) throw new TransferError(`git fetch ${o.ref} from ${h.remote} failed${ended(f)}: ${tail(f)}`);
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
  /** With `fresh`: a repository in the sandbox (a project template's checkout) whose objects the new one borrows, so
   *  only what it lacks is sent. Ignored when it isn't a git checkout there. */
  seed?: string;
  /** Caps the mirror's fetch (default FETCH_MAX_MS; a stall ends it sooner either way). */
  timeoutMs?: number;
  /** Hears a long fetch and upload as they go (TransferProgress). */
  onProgress?: OnTransferProgress;
}
export interface SendResult { heads: Record<string, string>; ref?: string; bytes: number }

/**
 * Remote → the sandbox's repository `dir` (made with `git init` first when `fresh`): the host fetches into its mirror,
 * makes a bundle of what the sandbox doesn't have yet, uploads it from disk a chunk at a time, and the sandbox reads it
 * and sets the refs the host names. The sandbox's `origin` stays the remote's URL, without credentials. Its span says
 * how many bytes went (`git.bytes`) and carries the progress reports.
 */
export function sendToSandbox(h: HostRemote, s: SandboxGit, dir: string, req: SendRequest, o: { fresh?: boolean } = {}): Promise<SendResult> {
  return gitSpan(o.fresh ? "clone" : "fetch", req.ref, async (span) => {
    const res = await send(h, s, dir, req, o, span);
    setSpanAttributes(span, { "git.bytes": res.bytes });
    return res;
  });
}

async function send(h: HostRemote, s: SandboxGit, dir: string, req: SendRequest, o: { fresh?: boolean }, span?: SimpleSpan): Promise<SendResult> {
  if (req.branches !== "all") for (const b of req.branches) if (!isBranchName(b)) throw new TransferError(`not a branch name: ${JSON.stringify(b).slice(0, 200)}`, "refused");
  if (req.ref !== undefined && !(HEX.test(req.ref) || /^refs\/[A-Za-z0-9._/-]+$/.test(req.ref)) ) throw new TransferError(`not a ref: ${JSON.stringify(req.ref).slice(0, 200)}`, "refused");
  const id = uniq();
  const tmpRef = `refs/capcomd/xfer/${id}`;
  const sx = (script: string, timeoutMs = 600_000) => s.exec(["sh", "-c", script], { timeoutMs });
  // A fresh repository (a clone), or what the sandbox has already (its remote-tracking refs and HEAD), to leave out of
  // the bundle.
  // A fresh repository may borrow a seed's objects (git alternates): what the seed's remote-tracking refs and HEAD
  // reach is then left out of the bundle too (marked `seed`, so they aren't taken for this repository's own refs).
  const seed = o.fresh && req.seed ? ` && if [ -d ${sq(`${req.seed}/.git/objects`)} ]; then echo ${sq(`${req.seed}/.git/objects`)} > .git/objects/info/alternates && { git -C ${sq(req.seed)} for-each-ref --format='%(objectname) seed' refs/remotes/origin/; git -C ${sq(req.seed)} rev-parse -q --verify HEAD; true; }; fi` : "";
  const theirs = o.fresh
    ? await sx(`rm -rf ${sq(dir)} && mkdir -p ${sq(dir)} && cd ${sq(dir)} && git init -q && git remote add origin ${sq(h.remote)}${seed}`)
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
    got = await fetchedMirror(h, req.branches, { ...(req.ref ? { ref: req.ref } : {}), tmpRef, ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}), report: reporter("fetch", null, span, req.onProgress) });
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
    const apply = async (file: string | null, bytes = 0) => {
      const lines: string[] = [];
      for (const [b, sha] of Object.entries(heads)) lines.push(`update refs/remotes/origin/${b} ${sha}`);
      if (req.branches === "all") for (const b of theirRefs.keys()) if (b !== "HEAD" && !heads[b]) lines.push(`delete refs/remotes/origin/${b}`);
      if (ref) lines.push(`update refs/capcomd/fetched ${ref}`);
      const fetch = file ? `git fetch -q --no-tags --no-write-fetch-head ${sq(into)} ${sq(`refs/capcomd/xfer/${id}/*:refs/capcomd/in/${id}/*`)} && ` : "";
      const checkout = req.checkout ? ` && git symbolic-ref refs/remotes/origin/HEAD ${sq(`refs/remotes/origin/${req.checkout}`)} && git checkout -q -B ${sq(req.checkout)} --track ${sq(`origin/${req.checkout}`)}` : "";
      return sx(`cd ${sq(dir)} || exit 1
${fetch}printf '%s\\n' ${lines.map(sq).join(" ")} | git update-ref --stdin${checkout}; rc=$?
[ -z ${sq(file ?? "")} ] || git for-each-ref --format='delete %(refname)' ${sq(`refs/capcomd/in/${id}/`)} | git update-ref --stdin; rm -f ${sq(into)}; exit $rc`, applyMs(bytes));
    };
    const upload = (file: string) => uploadFile(s, file, into, reporter("upload", statSync(file).size, span, req.onProgress));
    let file = missing.length ? await bundleTo([...known]) : null;
    if (file) bytes = await upload(file);
    let r = await apply(file, bytes);
    // The sandbox didn't have what its refs said (an agent can point them anywhere): everything, without prerequisites.
    if (r.code !== 0 && file && /prerequisite|missing|bad object|not a valid object/i.test(r.stderr + r.stdout)) {
      file = await bundleTo([]);
      if (file) bytes = await upload(file);
      r = await apply(file, bytes);
    }
    if (r.code !== 0) throw new TransferError(`reading the fetched branches into ${dir} in the sandbox failed: ${tail(r)}`, "sandbox");
    return { heads, ...(ref ? { ref } : {}), bytes };
  } finally {
    for (const f of files) rmSync(f, { force: true });
    if (got?.pins.length) await got.m.run(["update-ref", "--stdin"], { input: got.pins.map((p) => `delete ${p}`).join("\n") + "\n" }).catch(() => {});
  }
}

/**
 * What a sandbox holding `have` (a project template's branch tips) would receive now: the bytes of the bundle of every
 * branch less those, and how many commits `target` gained. The host fetches its mirror for it.
 */
export async function deltaSince(h: HostRemote, have: string[], target: string): Promise<{ bytes: number; behind: number | null }> {
  const id = uniq();
  const got = await fetchedMirror(h, "all", { tmpRef: `refs/capcomd/xfer/${id}` });
  const file = join(got.m.cwd, "xfer", `delta-${id}.bundle`);
  try {
    const known = await mirrorHas(got.m, have);
    mkdirSync(join(got.m.cwd, "xfer"), { recursive: true });
    const b = await got.m.run(["bundle", "create", "-q", file, "--stdin"], { input: [...got.pins, ...known.map((n) => `^${n}`)].join("\n") + "\n" });
    const bytes = b.code === 0 ? statSync(file).size : /empty bundle/i.test(b.stderr) ? 0 : -1;
    if (bytes < 0) throw new TransferError(`git bundle create failed: ${tail(b)}`);
    const tip = got.heads[target];
    const count = tip ? await got.m.run(["rev-list", "--count", tip, ...known.map((n) => `^${n}`)]) : null;
    return { bytes, behind: count && count.code === 0 ? Number(count.stdout.trim()) : null };
  } finally {
    rmSync(file, { force: true });
    await got.m.run(["update-ref", "--stdin"], { input: got.pins.map((p) => `delete ${p}`).join("\n") + "\n" }).catch(() => {});
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

/** `sha`'s tree from the mirror `m`, as a tar (`git archive` into a file), uploaded from disk and unpacked into `dir` in
 *  the sandbox (made anew). */
async function unpackTree(m: Git, s: SandboxGit, dir: string, sha: string, id: string, what: string): Promise<void> {
  mkdirSync(join(m.cwd, "xfer"), { recursive: true });
  const file = join(m.cwd, "xfer", `tree-${id}.tar`);
  try {
    const a = await m.run(["archive", "--format=tar", "-o", file, sha]);
    if (a.code !== 0) throw new TransferError(`git archive ${what} failed: ${tail(a)}`);
    const at = `/tmp/capcomd-tree-${id}.tar`;
    await uploadFile(s, file, at, () => {});
    const r = await s.exec(["sh", "-c", `rm -rf ${sq(dir)} && mkdir -p ${sq(dir)} && tar -xf ${sq(at)} -C ${sq(dir)}; rc=$?; rm -f ${sq(at)}; exit $rc`], { timeoutMs: 600_000 });
    if (r.code !== 0) throw new TransferError(`unpacking ${what} in the sandbox failed: ${tail(r)}`, "sandbox");
  } finally { rmSync(file, { force: true }); }
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
  /** Hears a long download of the sandbox's bundle as it goes (TransferProgress). */
  onProgress?: OnTransferProgress;
}

/**
 * The sandbox's commit `sha` (in `dir`) → the remote's `ref`: the sandbox bundles it (without credentials, leaving
 * out what the mirror has), the host downloads the bundle into its mirror (a chunk at a time), checks the commit is the
 * one asked for, and pushes it from there to the remote's URL with a lease. Nothing in the sandbox's checkout is read
 * but the bundle.
 */
export function pushFromSandbox(h: HostRemote, s: SandboxGit, dir: string, p: PushRequest): Promise<{ porcelain: string; bytes: number }> {
  return gitSpan("push", p.spanRef ?? `${p.sha}:${p.ref}`, async (span) => {
    const res = await push(h, s, dir, p, span);
    setSpanAttributes(span, { "git.bytes": res.bytes });
    return res;
  });
}

async function push(h: HostRemote, s: SandboxGit, dir: string, p: PushRequest, span?: SimpleSpan): Promise<{ porcelain: string; bytes: number }> {
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
        const file = join(m.cwd, "xfer", `in-${id}.bundle`);
        mkdirSync(join(m.cwd, "xfer"), { recursive: true });
        local.push(file);
        try { bytes = await downloadFile(s, out, file, size, reporter("download", size, span, p.onProgress)); } finally { await sx(`rm -f ${sq(out)}`).catch(() => {}); }
        if (bytes > MAX_BUNDLE()) throw new TransferError(`the sandbox's bundle is ${bytes} bytes (at most ${MAX_BUNDLE()})`, "refused");
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
