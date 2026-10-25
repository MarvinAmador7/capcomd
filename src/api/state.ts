// Durable harness state (Axiom review of #38): decision idempotency keys + decisions survive a daemon restart, and
// daemon/project stream seqs are assigned once per run at first sight and never reused, so Last-Event-ID resume is
// stable across deleted runs and equal createdAt timestamps. One small JSON file, written atomically (tmp + rename), 0600.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capcomdHome } from "../utils/home";
import type { StoredKey } from "./idempotency";

export type HarnessStateData = { keys: Record<string, StoredKey>; decisions: Record<string, Record<string, unknown>>; runSeq: Record<string, number>; nextSeq: number };
export const defaultStatePath = () => join(capcomdHome(), "harness-state.json");

export function harnessState(path: string | null = defaultStatePath()) {
	let d: HarnessStateData = { keys: {}, decisions: {}, runSeq: {}, nextSeq: 1 };
	if (path && existsSync(path)) try { d = { ...d, ...JSON.parse(readFileSync(path, "utf8")) }; } catch { /* corrupt: start fresh */ }
	const save = () => {
		if (!path) return;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 });
		renameSync(tmp, path);
	};
	return {
		key: (kid: string) => d.keys[kid],
		decision: (id: string) => d.decisions[id],
		/** Record decision and its key together in one write. */
		recordDecision(kid: string, k: StoredKey, decision: Record<string, unknown>) { d.decisions[k.approvalId] = decision; d.keys[kid] = k; save(); },
		/** Stable seq for each run; unseen runs get fresh seqs in (createdAt, id) order. */
		seqs(runs: Array<{ id: string; createdAt?: string | null }>): Map<string, number> {
			const fresh = runs.filter((r) => d.runSeq[r.id] === undefined).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
			for (const r of fresh) d.runSeq[r.id] = d.nextSeq++;
			if (fresh.length) save();
			return new Map(runs.map((r) => [r.id, d.runSeq[r.id]!]));
		},
	};
}
export type HarnessState = ReturnType<typeof harnessState>;
