// GET /v1/runs/{runId}/files: the files a run's agents changed, with lines added/removed. Each agent's latest work
// (its pushed commit, else its latest checkpoint) comes from the run's event log, so the answer and its `asOf` seq
// agree; the numbers are `git diff --numstat` of that commit against where its branch left the run's target, read
// from a bare mirror of the run's repository on the daemon host (fetched only for commits it doesn't have yet).
// A diff is computed once per (commit, base) and kept in memory: both are immutable.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../merge/git";
import { APPROVAL_FILES_MAX, FILES_AGENTS_MAX, FILES_MAX } from "./contract";
import { dottedType, isoTs } from "./envelope";
import type { RawEvent } from "./source";

export { FILES_AGENTS_MAX, FILES_MAX };

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange" | "unknown";
export type FileStat = { path: string; oldPath: string | null; status: FileStatus; added: number | null; removed: number | null };
export type FileChange = FileStat & { agentId: string };
/** An agent's latest work as the event log records it. */
export type WorkTip = { agentId: string; sha: string; ref: string | null; from: "commit" | "checkpoint"; seq: number; targetBefore: string | null };
export type FileSource = { agentId: string; from: "commit" | "checkpoint"; sha: string; base: string | null; files: number | null; error: string | null };
export type RunRepo = { remote: string; target: string; workdir: string };
export type RunFiles = { runId: string; asOf: number; computedAt: string; target: string | null; files: FileChange[]; total: number; truncated: boolean; sources: FileSource[] };

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// Refs and branch names reach git as arguments: plain names only (no leading dash, no `..`, no specials).
const SAFE_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const typeOf = (t: string) => { if (!/^[A-Z]/.test(t)) return t; try { return dottedType(t); } catch { return t; } };

/** Fold the event log into each agent's latest work: the newest checkpoint or pushed commit, whichever came last. */
export function workTips(evs: RawEvent[]): WorkTip[] {
	const tips = new Map<string, WorkTip>();
	const before = new Map<string, string>();
	for (const e of evs) {
		if (!e.agentId) continue;
		const t = typeOf(e.type), d = e.data ?? {};
		if (t === "agent.checkpointed" && typeof d.sha === "string" && SHA.test(d.sha)) {
			const ref = typeof d.ref === "string" && d.ref.startsWith("refs/") && SAFE_NAME.test(d.ref) ? d.ref : null;
			tips.set(e.agentId, { agentId: e.agentId, sha: d.sha, ref, from: "checkpoint", seq: e.seq, targetBefore: null });
		} else if (t === "agent.done" || t === "agent.failed" || t === "agent.paused") {
			const r = (d.result ?? {}) as Record<string, unknown>;
			if (typeof r.commit !== "string" || !SHA.test(r.commit)) continue;
			const ref = typeof r.branch === "string" && SAFE_NAME.test(r.branch) ? `refs/heads/${r.branch}` : null;
			tips.set(e.agentId, { agentId: e.agentId, sha: r.commit, ref, from: "commit", seq: e.seq, targetBefore: null });
		} else if (t === "merge.succeeded" && typeof d.targetBefore === "string" && SHA.test(d.targetBefore)) {
			before.set(e.agentId, d.targetBefore);
		}
	}
	return [...tips.values()].map((w) => ({ ...w, targetBefore: before.get(w.agentId) ?? null }));
}

const STATUS: Record<string, FileStatus> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "typechange" };

/** `git diff --numstat -z` + `--name-status -z` (rename detection on) → one row per file. Binary files: null counts. */
export function parseDiff(numstat: string, nameStatus: string): FileStat[] {
	const status = new Map<string, { s: FileStatus; old: string | null }>();
	const ns = nameStatus.split("\0");
	for (let i = 0; i < ns.length - 1;) {
		const code = ns[i++]!;
		if (!code) continue;
		const s = STATUS[code[0]!] ?? "unknown";
		if (code[0] === "R" || code[0] === "C") { const old = ns[i++]!, path = ns[i++]!; status.set(path, { s, old }); }
		else status.set(ns[i++]!, { s, old: null });
	}
	const out: FileStat[] = [];
	const nm = numstat.split("\0");
	for (let i = 0; i < nm.length - 1;) {
		const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(nm[i++]!);
		if (!m) continue;
		let path = m[3]!, oldPath: string | null = null;
		if (!path) { oldPath = nm[i++]!; path = nm[i++]!; }
		const st = status.get(path);
		out.push({ path, oldPath: oldPath ?? st?.old ?? null, status: st?.s ?? (oldPath ? "renamed" : "unknown"), added: m[1] === "-" ? null : Number(m[1]), removed: m[2] === "-" ? null : Number(m[2]) });
	}
	return out;
}

type Diff = { base: string; files: FileStat[] } | { error: string };

/**
 * A bare mirror of one repository, kept next to capcomd's merge clones (its workdir). Never a source of truth: it only
 * holds the commits it was asked about (kept under refs/keep/<sha>) and the target branch. One git operation at a time.
 */
export class FilesMirror {
	readonly dir: string;
	private lock: Promise<unknown> = Promise.resolve();
	private diffs = new Map<string, { at: number; d: Diff }>();
	static readonly CACHE_MAX = 2000;
	static readonly ERROR_TTL_MS = 60_000;
	/** Each fetch from the remote is killed after this; after one times out, the rest of that request skips the remote. */
	static readonly FETCH_TIMEOUT_MS = 20_000;
	private now: () => number;
	private fetchTimeoutMs: number;
	private env: Record<string, string>;
	constructor(readonly remote: string, workdir: string, o: { now?: () => number; fetchTimeoutMs?: number; env?: Record<string, string> } = {}) {
		this.dir = join(workdir, createHash("sha1").update(remote).digest("hex").slice(0, 12), "_files.git");
		this.now = o.now ?? Date.now;
		this.fetchTimeoutMs = o.fetchTimeoutMs ?? FilesMirror.FETCH_TIMEOUT_MS;
		this.env = o.env ?? {};
	}

	private serial<T>(f: () => Promise<T>): Promise<T> {
		const p = this.lock.then(f, f);
		this.lock = p.catch(() => {});
		return p;
	}

	private async git(): Promise<Git> {
		const git = new Git(this.dir, this.env);
		if (!existsSync(join(this.dir, "HEAD"))) {
			mkdirSync(this.dir, { recursive: true });
			await git.ok(["init", "-q", "--bare"]);
			await git.ok(["remote", "add", "origin", this.remote]);
		}
		return git;
	}

	/** A regular file (no tree, symlink or submodule) of one agent's latest work, at most WORKSPACE_FILE_MAX_BYTES. */
	readFile(tip: WorkTip, path: string): Promise<WorkspaceFile> {
		return this.serial(async () => readFileFrom(await this.git().catch(() => null), this.dir, this.env, tip, path));
	}

	/** Diff each tip against its base; tips already diffed come from memory without touching git. */
	diff(tips: WorkTip[], target: string): Promise<Map<string, Diff>> {
		const key = (w: WorkTip) => `${target}\0${w.sha}\0${w.targetBefore ?? ""}`;
		const out = new Map<string, Diff>();
		const known = (w: WorkTip) => {
			const c = this.diffs.get(key(w));
			return c && ("files" in c.d || this.now() - c.at < FilesMirror.ERROR_TTL_MS) ? c.d : null;
		};
		const pending = () => tips.filter((w) => { const d = known(w); if (d) out.set(w.agentId, d); return !d; });
		if (!pending().length) return Promise.resolve(out);
		return this.serial(async () => {
			// A request queued behind another may find its tips answered meanwhile (a diff, or a fresh error such as a timeout).
			const todo = pending();
			if (!todo.length) return out;
			let git: Git;
			try { git = await this.git(); } catch { for (const w of todo) out.set(w.agentId, { error: "could not open a local mirror of the run's repository" }); return out; }
			// Network calls are bounded; once one times out the remote is treated as unreachable for the rest of this request.
			let stuck = false;
			const fetch = async (...args: string[]) => {
				if (stuck) return false;
				const r = await git.run(["fetch", "-q", "--no-tags", "origin", ...args], { timeoutMs: this.fetchTimeoutMs });
				if (r.timedOut) stuck = true;
				return r.code === 0;
			};
			const TIMED_OUT = "fetching from the remote timed out";
			const targetRef = `refs/remotes/origin/${target}`;
			const targetOk = SAFE_NAME.test(target) && (await fetch(`+refs/heads/${target}:${targetRef}`));
			const has = async (sha: string) => (await git.run(["cat-file", "-e", `${sha}^{commit}`])).code === 0;
			const missing: WorkTip[] = [];
			for (const w of todo) if (!(await has(w.sha))) missing.push(w);
			const keep = (sha: string) => `refs/keep/${sha}`;
			if (missing.length) {
				const specs = missing.filter((w) => w.ref).map((w) => `+${w.ref}:${keep(w.sha)}-fetched`);
				if (!specs.length || !(await fetch(...specs)))
					for (const w of missing) {
						// One at a time: a deleted branch or checkpoint ref must not fail the others. Last resort: the commit itself.
						if (w.ref && (await fetch(`+${w.ref}:${keep(w.sha)}-fetched`))) continue;
						await fetch(w.sha);
					}
			}
			const mergeBase = async (a: string, b: string) => { const r = await git.run(["merge-base", a, b]); return r.code === 0 ? r.stdout.trim() || null : null; };
			for (const w of todo) {
				const d = await (async (): Promise<Diff> => {
					if (!(await has(w.sha))) return { error: stuck ? TIMED_OUT : "its commit is not on the remote any more (branch or checkpoint deleted)" };
					// Keep it reachable: the branch or checkpoint ref may be deleted after a merge.
					await git.run(["update-ref", keep(w.sha), w.sha]);
					let base: string | null = null;
					if (w.targetBefore && (await has(w.targetBefore))) base = await mergeBase(w.sha, w.targetBefore);
					if (!base) {
						if (!targetOk) return { error: stuck ? TIMED_OUT : `target branch ${target} not found on the remote` };
						const mb = await mergeBase(w.sha, targetRef);
						if (!mb) return { error: `no common history with ${target}` };
						base = mb;
						if (mb === w.sha) {
							// Already in the target with no recorded merge: the merge commit that brought it in tells where it started.
							const m = (await git.run(["rev-list", "--ancestry-path", "--merges", "--reverse", `${w.sha}..${targetRef}`])).stdout.split("\n")[0]?.trim();
							base = m ? await mergeBase(w.sha, `${m}^1`) : null;
							if (!base) return { error: `already in ${target} by fast-forward; where it started is not known` };
						}
					}
					const args = ["-c", "core.quotepath=off", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", "-z"];
					const [num, names] = await Promise.all([git.run([...args, "--numstat", base, w.sha]), git.run([...args, "--name-status", base, w.sha])]);
					if (num.code !== 0 || names.code !== 0) return { error: "git diff failed" };
					return { base, files: parseDiff(num.stdout, names.stdout) };
				})();
				for (const [k] of [...this.diffs].slice(0, Math.max(0, this.diffs.size - FilesMirror.CACHE_MAX + 1))) this.diffs.delete(k);
				this.diffs.set(key(w), { at: this.now(), d });
				out.set(w.agentId, d);
			}
			await git.run(["for-each-ref", "--format=delete %(refname)", "refs/keep/"]).then((r) => {
				const stale = r.stdout.split("\n").filter((l) => l.endsWith("-fetched"));
				return stale.length ? git.run(["update-ref", "--stdin"], { input: `${stale.join("\n")}\n` }) : null;
			});
			return out;
		});
	}
}

/** GET …/workspace: a file of an agent's latest work, read from the mirror (never from the VM, which may be gone). */
export const WORKSPACE_FILE_MAX_BYTES = 5 * 1024 * 1024;
export type WorkspaceFile = { bytes: Uint8Array; path: string; sha: string } | { error: "not_found" | "too_large" | "unavailable"; message: string };

/** Bytes of `git cat-file blob <oid>` (Git.run decodes text; a blob may be an image). */
async function blobBytes(dir: string, oid: string, env: Record<string, string>): Promise<Uint8Array | null> {
	const p = Bun.spawn(["git", "cat-file", "blob", oid], { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
	const [buf, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), p.exited]);
	return code === 0 ? new Uint8Array(buf) : null;
}

async function readFileFrom(git: Git | null, dir: string, env: Record<string, string>, tip: WorkTip, path: string): Promise<WorkspaceFile> {
	{
		if (!git) return { error: "unavailable", message: "could not open a local mirror of the run's repository" };
		const has = async () => (await git.run(["cat-file", "-e", `${tip.sha}^{commit}`])).code === 0;
		if (!(await has())) {
			const fetched = tip.ref ? (await git.run(["fetch", "-q", "--no-tags", "origin", `+${tip.ref}:refs/keep/${tip.sha}-fetched`], { timeoutMs: FilesMirror.FETCH_TIMEOUT_MS })).code === 0 : false;
			if (!fetched) await git.run(["fetch", "-q", "--no-tags", "origin", tip.sha], { timeoutMs: FilesMirror.FETCH_TIMEOUT_MS });
			if (!(await has())) return { error: "unavailable", message: "the agent's work is not on the remote (yet)" };
			await git.run(["update-ref", `refs/keep/${tip.sha}`, tip.sha]);
		}
		// Exactly this path, as a regular file: no trees (no listing), no symlinks, no submodules.
		const ls = await git.run(["-c", "core.quotepath=off", "ls-tree", "-z", "--long", tip.sha, "--", path]);
		const m1 = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t([\s\S]*?)\0/.exec(ls.stdout);
		if (ls.code !== 0 || !m1 || m1[5] !== path) return { error: "not_found", message: `${path} is not in the agent's latest work` };
		if (m1[2] !== "blob" || (m1[1] !== "100644" && m1[1] !== "100755")) return { error: "not_found", message: `${path} is not a regular file` };
		if (Number(m1[4]) > WORKSPACE_FILE_MAX_BYTES) return { error: "too_large", message: `${path} is larger than ${WORKSPACE_FILE_MAX_BYTES / (1024 * 1024)} MB` };
		const bytes = await blobBytes(dir, m1[3]!, env);
		return bytes ? { bytes, path, sha: tip.sha } : { error: "unavailable", message: "git cat-file failed" };
	}
}

const mirrors = new Map<string, FilesMirror>();
const mirrorKey = (repo: RunRepo) => `${repo.workdir}\0${repo.remote}`;
export const mirrorFor = (repo: RunRepo) => {
	let m = mirrors.get(mirrorKey(repo));
	if (!m) mirrors.set(mirrorKey(repo), (m = new FilesMirror(repo.remote, repo.workdir)));
	return m;
};
/** Tests: serve a repository from this mirror (e.g. one with a short fetch timeout). */
export const useMirror = (repo: RunRepo, m: FilesMirror) => { mirrors.set(mirrorKey(repo), m); };

/** A merge approval's diff (merge.approval_requested `diff`, the approval's subject): the files with the most changed lines
 *  first (then by path), at most APPROVAL_FILES_MAX; the totals count every file (binaries have no line counts). */
export type ApprovalDiff = { files: Array<{ path: string; status: FileStatus; added: number | null; removed: number | null }>; filesTotal: number; added: number; removed: number };
export function summarizeDiff(files: FileStat[]): ApprovalDiff {
	const size = (f: FileStat) => (f.added ?? 0) + (f.removed ?? 0);
	const top = [...files].sort((a, b) => size(b) - size(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, APPROVAL_FILES_MAX);
	return {
		files: top.map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed })),
		filesTotal: files.length,
		added: files.reduce((n, f) => n + (f.added ?? 0), 0),
		removed: files.reduce((n, f) => n + (f.removed ?? 0), 0),
	};
}
/** The diff of a merge about to be parked for approval: the verified commit against where its branch left the target, read
 *  from the run's mirror like GET …/files. Null when it can't be read (no commit, the remote unreachable): the approval
 *  then goes out without files rather than waiting on git. */
export async function approvalDiff(repo: RunRepo, w: { agentId: string | null; sha: string | null; branch: string }): Promise<ApprovalDiff | null> {
	if (!w.sha || !SHA.test(w.sha) || !SAFE_NAME.test(w.branch)) return null;
	const tip: WorkTip = { agentId: w.agentId ?? "merge", sha: w.sha, ref: `refs/heads/${w.branch}`, from: "commit", seq: 0, targetBefore: null };
	const d = (await mirrorFor(repo).diff([tip], repo.target)).get(tip.agentId);
	return d && "files" in d ? summarizeDiff(d.files) : null;
}

/** The response of GET /v1/runs/{runId}/files. */
export async function runFiles(o: { runId: string; events: RawEvent[]; repo: RunRepo | null; agentId?: string; limit?: number; now?: () => number }): Promise<RunFiles> {
	const limit = Math.min(o.limit ?? FILES_MAX, FILES_MAX);
	const asOf = o.events.at(-1)?.seq ?? 0;
	let tips = workTips(o.events).filter((w) => !o.agentId || w.agentId === o.agentId);
	const agentsCut = tips.length > FILES_AGENTS_MAX;
	tips = tips.sort((a, b) => b.seq - a.seq).slice(0, FILES_AGENTS_MAX);
	const diffs = o.repo ? await mirrorFor(o.repo).diff(tips, o.repo.target) : new Map<string, Diff>();
	const rows: FileChange[] = [];
	const sources: FileSource[] = tips.map((w) => {
		const d = diffs.get(w.agentId) ?? { error: "no repository is configured for this run" };
		if ("files" in d) for (const f of d.files) rows.push({ ...f, agentId: w.agentId });
		return { agentId: w.agentId, from: w.from, sha: w.sha, base: "base" in d ? d.base : null, files: "files" in d ? d.files.length : null, error: "error" in d ? d.error : null };
	});
	rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
	sources.sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
	return { runId: o.runId, asOf, computedAt: isoTs((o.now ?? Date.now)()), target: o.repo?.target ?? null, files: rows.slice(0, limit), total: rows.length, truncated: agentsCut || rows.length > limit, sources };
}
