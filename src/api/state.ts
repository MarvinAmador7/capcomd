// Durable harness state (Axiom review of #38): decision idempotency keys + decisions survive a daemon restart, and
// daemon/project stream seqs are assigned once per run at first sight and never reused, so Last-Event-ID resume is
// stable across deleted runs and equal createdAt timestamps. One small JSON file, written atomically (tmp + rename), 0600.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capcomdHome } from "../utils/home";
import type { StoredKey } from "./idempotency";

export const KEY_TTL_MS = 24 * 60 * 60 * 1000;
type StampedKey = StoredKey & { at?: number };
export type HarnessStateData = { keys: Record<string, StampedKey>; decisions: Record<string, Record<string, unknown>>; runSeq: Record<string, number>; nextSeq: number };
export const defaultStatePath = () => join(capcomdHome(), "harness-state.json");

/** Cleanup (Axiom follow-up to #38): idempotency keys expire after 24h; seqs of deleted runs are dropped, but nextSeq is a
 * high-water mark so a seq is never reused. Runs on load, on every write, and on key lookup. */
export function harnessState(path: string | null = defaultStatePath(), opts: { now?: () => number; keyTtlMs?: number } = {}) {
	const now = opts.now ?? Date.now, ttl = opts.keyTtlMs ?? KEY_TTL_MS;
	let d: HarnessStateData = { keys: {}, decisions: {}, runSeq: {}, nextSeq: 1 };
	if (path && existsSync(path)) try { d = { ...d, ...JSON.parse(readFileSync(path, "utf8")) }; } catch { /* corrupt: start fresh */ }
	const pruneKeys = () => {
		let changed = false;
		const t = now();
		for (const [kid, k] of Object.entries(d.keys)) {
			if (typeof k.at !== "number") { k.at = t; changed = true; } // legacy key: start its 24h clock now
			else if (t - k.at >= ttl) { delete d.keys[kid]; changed = true; }
		}
		return changed;
	};
	const save = () => {
		pruneKeys();
		if (!path) return;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
		renameSync(tmp, path);
	};
	{
		const maxSeq = Math.max(0, ...Object.values(d.runSeq));
		const fixSeq = !(d.nextSeq > maxSeq);
		if (fixSeq) d.nextSeq = maxSeq + 1;
		if (pruneKeys() || fixSeq) save();
	}
	return {
		key(kid: string): StoredKey | undefined {
			const k = d.keys[kid];
			if (k && typeof k.at === "number" && now() - k.at >= ttl) { save(); return undefined; }
			return k;
		},
		decision: (id: string) => d.decisions[id],
		/** Record decision and its key together in one write. */
		recordDecision(kid: string, k: StoredKey & { approvalId: string }, decision: Record<string, unknown>) { d.decisions[k.approvalId] = decision; d.keys[kid] = { ...k, at: now() }; save(); },
		/** Record an outcome under its key (runs.create); kept 24h like every key. */
		recordKey(kid: string, k: StoredKey) { d.keys[kid] = { ...k, at: now() }; save(); },
		/** Stable seq for each run; unseen runs get fresh seqs in (createdAt, id) order. Never prunes: an empty or partial
		 * `runs` list (source hiccup, slow actor) must not lose seqs. Only runDeleted() drops one; nextSeq never goes down. */
		seqs(runs: Array<{ id: string; createdAt?: string | null }>): Map<string, number> {
			const fresh = runs.filter((r) => d.runSeq[r.id] === undefined).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
			for (const r of fresh) d.runSeq[r.id] = d.nextSeq++;
			if (fresh.length) save();
			return new Map(runs.map((r) => [r.id, d.runSeq[r.id]!]));
		},
		/** Run ids that hold a seq. */
		knownRuns: () => Object.keys(d.runSeq),
		/** Confirmed deletion (a run.deleted lifecycle event was seen): drop the run's seq. The seq is never reused. */
		runDeleted(runId: string) { if (d.runSeq[runId] !== undefined) { delete d.runSeq[runId]; save(); } },
	};
}
export type HarnessState = ReturnType<typeof harnessState>;
