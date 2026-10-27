// GET /v1/runs/{runId}/files: agents' work from the event log, numstat against where each branch left the target.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunFiles } from "../../src/api/contract";
import { addClient, loadClients } from "../../src/api/clients";
import { FilesMirror, parseDiff, runFiles, useMirror, workTips } from "../../src/api/run-files";
import { harnessApp } from "../../src/api/server";
import { memorySource, type RawEvent } from "../../src/api/source";
import { harnessState } from "../../src/api/state";

const root = mkdtempSync(join(tmpdir(), "run-files-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: root };
function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], { cwd, env });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}
const write = (dir: string, f: string, body: string | Uint8Array) => writeFileSync(join(dir, f), body);
const lines = (n: number, tag = "l") => Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n") + "\n";

// remote (bare) ← work clone. main: a.txt, old.txt, logo.bin. Then agent branches, a checkpoint ref and merges.
const remote = join(root, "remote.git");
const work = join(root, "work");
git(root, "init", "-q", "--bare", "-b", "main", remote);
git(root, "clone", "-q", remote, work);
git(work, "checkout", "-q", "-b", "main");
write(work, "a.txt", lines(5));
write(work, "old.txt", lines(20, "o"));
write(work, "logo.bin", new Uint8Array([0, 1, 2, 3, 0, 255]));
git(work, "add", "-A"); git(work, "commit", "-q", "-m", "base"); git(work, "push", "-q", "origin", "main");
const base = git(work, "rev-parse", "HEAD");

// a1 (done): edits a.txt (+2 −1), adds new.ts, renames old.txt, changes the binary.
git(work, "checkout", "-q", "-b", "capcomd/run-1/a1", base);
write(work, "a.txt", lines(5).replace("l2\n", "x\ny\n"));
write(work, "new.ts", "export const n = 1;\n");
git(work, "mv", "old.txt", "renamed.txt");
write(work, "logo.bin", new Uint8Array([0, 9, 9, 0]));
git(work, "add", "-A"); git(work, "commit", "-q", "-m", "a1"); git(work, "push", "-q", "origin", "capcomd/run-1/a1");
const a1 = git(work, "rev-parse", "HEAD");

// a2 (running): only a checkpoint, pushed to refs/capcomd/checkpoints/a2.
git(work, "checkout", "-q", "-b", "a2-work", base);
write(work, "b.md", lines(3, "b"));
git(work, "add", "-A"); git(work, "commit", "-q", "-m", "ckpt");
const a2 = git(work, "rev-parse", "HEAD");
git(work, "push", "-q", "origin", `${a2}:refs/capcomd/checkpoints/a2`);

// main moves on (unrelated): the diff base stays where each branch left it.
git(work, "checkout", "-q", "main");
write(work, "other.txt", "x\n");
git(work, "add", "-A"); git(work, "commit", "-q", "-m", "main moves"); git(work, "push", "-q", "origin", "main");

// a3: merged into main with a merge commit (no recorded targetBefore).
git(work, "checkout", "-q", "-b", "capcomd/run-1/a3", base);
write(work, "c.txt", lines(4, "c"));
git(work, "add", "-A"); git(work, "commit", "-q", "-m", "a3"); git(work, "push", "-q", "origin", "capcomd/run-1/a3");
const a3 = git(work, "rev-parse", "HEAD");
git(work, "checkout", "-q", "main"); git(work, "merge", "-q", "--no-ff", "-m", "merge a3", a3); git(work, "push", "-q", "origin", "main");

// a4: fast-forwarded into main; a5: same, without the recorded targetBefore.
const before4 = git(work, "rev-parse", "main");
git(work, "checkout", "-q", "-b", "capcomd/run-1/a4", before4);
write(work, "d.txt", lines(2, "d"));
git(work, "add", "-A"); git(work, "commit", "-q", "-m", "a4"); git(work, "push", "-q", "origin", "capcomd/run-1/a4");
const a4 = git(work, "rev-parse", "HEAD");
git(work, "checkout", "-q", "main"); git(work, "merge", "-q", "--ff-only", a4); git(work, "push", "-q", "origin", "main");

let seq = 0;
const ev = (type: string, agentId: string | null, data: Record<string, unknown>): RawEvent => ({ seq: ++seq, at: 1792900500000 + seq, type, agentId, data });
const events: RawEvent[] = [
	ev("RUN_NEW", null, { budget: {}, label: "demo" }),
	ev("AGENT_CHECKPOINT", "a1", { ref: "refs/capcomd/checkpoints/a1", sha: "1".repeat(40), at: 1, reason: "spend", files: 1 }),
	ev("AGENT_DONE", "a1", { result: { branch: "capcomd/run-1/a1", commit: a1 }, spent: {}, budget: {} }),
	ev("AGENT_CHECKPOINT", "a2", { ref: "refs/capcomd/checkpoints/a2", sha: a2, at: 2, reason: "interval", files: 1 }),
	ev("AGENT_DONE", "a3", { result: { branch: "capcomd/run-1/a3", commit: a3 }, spent: {}, budget: {} }),
	ev("AGENT_DONE", "a4", { result: { branch: "capcomd/run-1/a4", commit: a4 }, spent: {}, budget: {} }),
	ev("MERGED", "a4", { id: "mrg-4", merged: true, sha: a4, how: "ff", already: false, mode: "direct", targetBefore: before4 }),
	ev("AGENT_DONE", "rev", { result: { verdict: "pass", branch: null, commit: null }, spent: {}, budget: {} }),
	ev("AGENT_FAILED", "gone", { result: { branch: "capcomd/run-1/gone", commit: "e".repeat(40) }, spent: {}, budget: {} }),
];
const repo = { remote, target: "main", workdir: join(root, "mirror") };

describe("workTips", () => {
	test("newest work per agent: a pushed commit replaces a checkpoint; reviewers and bad shas have none", () => {
		const t = workTips(events);
		expect(t.map((w) => [w.agentId, w.from])).toEqual([["a1", "commit"], ["a2", "checkpoint"], ["a3", "commit"], ["a4", "commit"], ["gone", "commit"]]);
		expect(t.find((w) => w.agentId === "a1")).toMatchObject({ sha: a1, ref: "refs/heads/capcomd/run-1/a1" });
		expect(t.find((w) => w.agentId === "a4")!.targetBefore).toBe(before4);
		const odd = workTips([
			{ seq: 1, at: 0, type: "agent.checkpointed", agentId: "x", data: { sha: "--upload-pack=evil", ref: "refs/x" } },
			{ seq: 2, at: 0, type: "agent.done", agentId: "y", data: { result: { commit: "a".repeat(40), branch: "--force" } } },
		]);
		expect(odd).toEqual([{ agentId: "y", sha: "a".repeat(40), ref: null, from: "commit", seq: 2, targetBefore: null }]);
	});
});

describe("parseDiff", () => {
	test("numstat + name-status, renames and binaries", () => {
		const num = "2\t1\ta.txt\0-\t-\tlogo.bin\x000\t0\t\0old.txt\0renamed.txt\x001\t0\tnew file.ts\0";
		const names = "M\0a.txt\0M\0logo.bin\0R100\0old.txt\0renamed.txt\0A\0new file.ts\0";
		expect(parseDiff(num, names)).toEqual([
			{ path: "a.txt", oldPath: null, status: "modified", added: 2, removed: 1 },
			{ path: "logo.bin", oldPath: null, status: "modified", added: null, removed: null },
			{ path: "renamed.txt", oldPath: "old.txt", status: "renamed", added: 0, removed: 0 },
			{ path: "new file.ts", oldPath: null, status: "added", added: 1, removed: 0 },
		]);
		expect(parseDiff("", "")).toEqual([]);
	});
});

describe("runFiles", () => {
	test("each agent's work against where its branch left the target", async () => {
		const r = await runFiles({ runId: "run-1", events, repo, now: () => 1792900600000 });
		expect(RunFiles.parse(r)).toBeTruthy();
		expect(r).toMatchObject({ runId: "run-1", asOf: seq, computedAt: "2026-10-25T03:56:40.000Z", target: "main", truncated: false, total: 7 });
		expect(r.files.map((f) => [f.agentId, f.path, f.status, f.added, f.removed, f.oldPath])).toEqual([
			["a1", "a.txt", "modified", 2, 1, null],
			["a2", "b.md", "added", 3, 0, null],
			["a3", "c.txt", "added", 4, 0, null],
			["a4", "d.txt", "added", 2, 0, null],
			["a1", "logo.bin", "modified", null, null, null],
			["a1", "new.ts", "added", 1, 0, null],
			["a1", "renamed.txt", "renamed", 0, 0, "old.txt"],
		]);
		const src = Object.fromEntries(r.sources.map((s) => [s.agentId, s]));
		expect(src.a1).toMatchObject({ from: "commit", sha: a1, base, files: 4, error: null });
		expect(src.a2).toMatchObject({ from: "checkpoint", sha: a2, base, files: 1 });
		expect(src.a3).toMatchObject({ base, files: 1, error: null });
		expect(src.a4).toMatchObject({ base: before4, files: 1 });
		expect(src.gone).toMatchObject({ files: null, base: null });
		expect(src.gone!.error).toContain("not on the remote");
	});
	test("a fast-forward merge with no recorded base says so instead of guessing", async () => {
		const evs = events.filter((e) => e.type !== "MERGED");
		const r = await runFiles({ runId: "run-1", events: evs, repo: { ...repo, workdir: join(root, "mirror-ff") }, agentId: "a4" });
		expect(r.files).toEqual([]);
		expect(r.sources[0]!.error).toContain("fast-forward");
	});
	test("limit cuts rows and says so; agentId filters", async () => {
		const r = await runFiles({ runId: "run-1", events, repo, limit: 2 });
		expect(r.files.length).toBe(2);
		expect(r).toMatchObject({ truncated: true, total: 7 });
		const one = await runFiles({ runId: "run-1", events, repo, agentId: "a2" });
		expect(one.files.map((f) => f.path)).toEqual(["b.md"]);
		expect(one.sources.map((s) => s.agentId)).toEqual(["a2"]);
	});
	test("no repository: sources explain, no rows", async () => {
		const r = await runFiles({ runId: "run-1", events, repo: null });
		expect(r).toMatchObject({ target: null, files: [], total: 0, truncated: false });
		expect(r.sources.every((s) => s.error === "no repository is configured for this run")).toBe(true);
	});
	test("a diffed commit is answered from memory, even when the remote is gone", async () => {
		const m = new FilesMirror(remote, join(root, "mirror-cache"));
		const tips = workTips(events).filter((w) => w.agentId === "a1");
		const first = await m.diff(tips, "main");
		const moved = join(root, "remote-moved.git");
		renameSync(remote, moved);
		try {
			expect(await m.diff(tips, "main")).toEqual(first);
		} finally { renameSync(moved, remote); }
	});
});

describe("a remote that never answers", () => {
	// ssh "connects" to a command that sleeps: no network needed, and git waits on it forever.
	const sleep = `47.${String(process.pid).padStart(7, "0")}`;
	const hang = { GIT_SSH_COMMAND: `sleep ${sleep} #` };
	const slow = { remote: "ssh://capcomd.invalid/repo.git", target: "main", workdir: join(root, "mirror-slow") };
	// Still running? (the dot escaped: pgrep takes a regex)
	const stuck = (pattern: string) => Bun.spawnSync(["pgrep", "-f", pattern.replace(/\./g, "\\.")]).stdout.toString().trim();
	test("Git.run kills git and its children at the deadline", async () => {
		const { Git } = await import("../../src/merge/git");
		const dir = join(root, "timeout-repo");
		git(root, "init", "-q", "--bare", dir);
		const t0 = Date.now();
		const p = new Git(dir, hang).run(["fetch", "-q", slow.remote, "main"], { timeoutMs: 1000 });
		await Bun.sleep(400);
		expect(stuck(`sleep ${sleep}`)).not.toBe(""); // the stub "ssh" is hanging
		const r = await p;
		expect(Date.now() - t0).toBeLessThan(3000);
		expect(r).toMatchObject({ code: 124, timedOut: true });
		await Bun.sleep(200);
		expect(stuck(`sleep ${sleep}`)).toBe("");
	});
	test("the route answers within the timeout, a concurrent request isn't held up, and the next comes from memory", async () => {
		useMirror(slow, new FilesMirror(slow.remote, slow.workdir, { fetchTimeoutMs: 1000, env: hang }));
		const path = join(root, "clients-slow.json");
		const token = addClient("reader", ["read"], path).token;
		const run = { id: "run-2", projectId: null, label: null, state: "running", goal: null, repo: slow.remote, createdAt: "2026-10-25T07:00:00.000Z" };
		const agents = ["s1", "s2"].map((id) => ({ id, runId: "run-2", parent: null, depth: 0, profile: null, status: "done" as const, text: "", task: null, taskAttachment: null, result: null, updatedAt: null, activity: null, workspace: null, provider: null, model: null }));
		const evs: RawEvent[] = [
			{ seq: 1, at: 1, type: "AGENT_DONE", agentId: "s1", data: { result: { branch: "capcomd/run-2/s1", commit: "a".repeat(40) } } },
			{ seq: 2, at: 2, type: "AGENT_CHECKPOINT", agentId: "s2", data: { ref: "refs/capcomd/checkpoints/s2", sha: "b".repeat(40), at: 2, reason: "x", files: 1 } },
		];
		const app = harnessApp({ source: memorySource({ runs: [run], agents: { "run-2": agents }, events: { "run-2": evs }, repos: { "run-2": slow } }), clients: () => loadClients(path), state: harnessState(null) });
		const get = async () => { const t0 = Date.now(); const res = await app.request("/v1/runs/run-2/files", { headers: { authorization: `Bearer ${token}` } }); return { ms: Date.now() - t0, status: res.status, body: RunFiles.parse(await res.json()) }; };
		// Four bounded fetches would be ~4 s; one timeout ends the request's use of the remote.
		const [a, b] = await Promise.all([get(), get()]);
		for (const r of [a, b]) {
			expect(r.status).toBe(200);
			expect(r.ms).toBeLessThan(2500);
			expect(r.body.files).toEqual([]);
			expect(r.body.sources.map((s) => s.error)).toEqual(["fetching from the remote timed out", "fetching from the remote timed out"]);
		}
		const c = await get();
		expect(c.ms).toBeLessThan(300);
		expect(c.body.sources[0]!.error).toBe("fetching from the remote timed out");
		await Bun.sleep(200);
		expect(stuck(`sleep ${sleep}`)).toBe("");
	});
});

describe("GET /v1/runs/{runId}/files", () => {
	const path = join(root, "clients.json");
	const token = addClient("reader", ["read"], path).token;
	const run = { id: "run-1", projectId: null, label: "demo", state: "running", goal: null, repo: remote, createdAt: "2026-10-25T07:00:00.000Z" };
	const agent = (id: string) => ({ id, runId: "run-1", parent: null, depth: 0, profile: null, status: "done" as const, text: "", task: null, taskAttachment: null, result: null, updatedAt: null, activity: null, workspace: null, provider: null, model: null });
	const app = harnessApp({
		source: memorySource({ runs: [run], agents: { "run-1": ["a1", "a2", "a3", "a4", "rev", "gone"].map(agent) }, events: { "run-1": events }, repos: { "run-1": { ...repo, workdir: join(root, "mirror-http") } } }),
		clients: () => loadClients(path), state: harnessState(null),
	});
	const get = (p: string) => app.request(p, { headers: { authorization: `Bearer ${token}` } });
	test("200 with the contract shape", async () => {
		const res = await get("/v1/runs/run-1/files?limit=3");
		expect(res.status).toBe(200);
		const body = RunFiles.parse(await res.json());
		expect(body.files.length).toBe(3);
		expect(body).toMatchObject({ asOf: seq, truncated: true, total: 7 });
		const a2only = RunFiles.parse(await (await get("/v1/runs/run-1/files?agentId=a2")).json());
		expect(a2only.files.map((f) => [f.path, f.added, f.removed])).toEqual([["b.md", 3, 0]]);
	});
	test("unknown run or agent: 404; bad limit: 422", async () => {
		expect((await get("/v1/runs/run-nope/files")).status).toBe(404);
		expect((await get("/v1/runs/run-1/files?agentId=zzz")).status).toBe(404);
		expect((await get("/v1/runs/run-1/files?limit=501")).status).toBe(422);
	});
});
