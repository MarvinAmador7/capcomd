// The machines ledger (ADR-021 §3): this capcomd's own record of every machine it creates, so the resources route lists
// (and Delete touches) only machines this capcomd made. A provider's list isn't enough: a boxd org lists every member's
// machines, and a second capcomd on the same Mac (another checkout, a test daemon) sees the same Docker containers, all
// with capcomd's prefix. A machine with the prefix that isn't in this ledger isn't listed at all.
//
// Two kinds of record. An agent's worker VM (src/actors/worker.ts): written before `provider.ensure`, removed once the
// worker has destroyed the machine (or the provider confirmed it gone); it stays until then, whatever happens to the
// process that wrote it. capcomd's own short jobs (the checks VM, `auth login` / `auth status`, `env build`,
// `env doctor`): the process that makes one records it first and removes the record once the machine is destroyed; as
// an *owner* such a record counts only while that process is alive and the machine's idle lifetime since it was made
// isn't up, so a job that crashed leaves a machine that reads as orphaned (and is deleted when its lifetime is up).
// Never the provider's labels, which a sandbox can forge.
//
// One file per machine (`<state>/machines/<name>.json`, 0600): processes add and remove their own without racing each
// other. A write is atomic (a temporary file renamed into place) and never throws: a machine whose record couldn't be
// written is simply never listed (nor deletable as left behind).
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../utils/home";
import { MACHINE_PREFIX } from "./sandbox";

type Env = Record<string, string | undefined>;

export type JobKind = "check" | "login" | "env_build" | "doctor";
export interface JobMachine {
	/** The machine's name at the provider (capcomd's prefix + a hash of its idempotency key). */
	name: string;
	/** The place it runs (a provider name). */
	sandbox: string;
	kind: JobKind;
	/** What exactly: checks, auth-login, auth-status, env-build, doctor. */
	purpose: string;
	/** check: the run (and task) whose checks run there. */
	runId: string | null;
	taskId: string | null;
	/** login: claude-code or codex. */
	agent: string | null;
	pid: number;
	createdAt: number;
	ttlSeconds: number;
}
/** An agent's worker VM: kept until the worker destroys the machine. */
export interface AgentMachine {
	name: string;
	sandbox: string;
	kind: "agent";
	/** The worker actor that made it (its key, as `client().worker.get(key)` takes it) and the run and agent it works for. */
	runId: string;
	agentId: string;
	workerKey: string[];
	pid: number;
	createdAt: number;
	ttlSeconds: number;
}
export type MachineRecord = JobMachine | AgentMachine;
/** What the ledger says about one machine: its record, or (a file that can't be read or parsed) only its name. */
export type LedgerEntry = { name: string; record: MachineRecord } | { name: string; record: null };

/** CAPCOMD_MACHINES_LEDGER (a directory) wins; else `<state>/machines`. */
export const machinesDir = (env: Env = process.env) => env.CAPCOMD_MACHINES_LEDGER || join(stateDir(env), "machines");

/** The name a provider gives the machine for an idempotency key (boxd's vmNameFor and Docker's container name). */
export function machineNameFor(idemKey: string, prefix = MACHINE_PREFIX): string {
	return `${prefix}${createHash("sha256").update(idemKey).digest("hex").slice(0, 16)}`;
}

const SAFE = /^[A-Za-z0-9._-]{1,128}$/;
const JOB_KINDS: readonly string[] = ["check", "login", "env_build", "doctor"];

/** Writes one record atomically (0600). Never throws; false when it couldn't be written. */
function writeRecord(rec: MachineRecord, env: Env): boolean {
	const dir = machinesDir(env);
	const file = join(dir, `${rec.name}.json`);
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
		renameSync(tmp, file);
		return true;
	} catch {
		try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
		return false;
	}
}

/** Removes a machine's record (it was destroyed, or the provider says it's gone). Never throws. */
export function forgetMachine(name: string, env: Env = process.env): void {
	if (!SAFE.test(name)) return;
	try { rmSync(join(machinesDir(env), `${name}.json`), { force: true }); } catch { /* best effort */ }
}

/**
 * Records a machine one of capcomd's jobs is about to make; call before `provider.ensure` (a record of a machine that
 * never came up is harmless), and call the returned release once it is destroyed. Never throws: a machine whose record
 * couldn't be written is never listed.
 */
export function recordJobMachine(m: { idemKey: string; sandbox: string | null | undefined; kind: JobKind; purpose: string; runId?: string | null; taskId?: string | null; agent?: string | null; ttlSeconds: number }, env: Env = process.env): () => void {
	const name = machineNameFor(m.idemKey);
	writeRecord({
		name, sandbox: m.sandbox ?? "unknown", kind: m.kind, purpose: m.purpose, runId: m.runId ?? null, taskId: m.taskId ?? null, agent: m.agent ?? null,
		pid: process.pid, createdAt: Date.now(), ttlSeconds: m.ttlSeconds,
	}, env);
	return () => forgetMachine(name, env);
}

/**
 * Records an agent's worker VM before `provider.ensure` (src/actors/worker.ts); `forgetMachine` once the worker has
 * destroyed it. Never throws: false when the record couldn't be written (that machine is then never listed).
 */
export function recordAgentMachine(m: { idemKey: string; sandbox: string | null | undefined; runId: string; agentId: string; workerKey: readonly string[]; ttlSeconds: number }, env: Env = process.env): boolean {
	return writeRecord({
		name: machineNameFor(m.idemKey), sandbox: m.sandbox ?? "unknown", kind: "agent", runId: m.runId, agentId: m.agentId, workerKey: [...m.workerKey],
		pid: process.pid, createdAt: Date.now(), ttlSeconds: m.ttlSeconds,
	}, env);
}

function validRecord(r: unknown, file: string): r is MachineRecord {
	const x = r as Partial<MachineRecord> | null;
	if (!x || typeof x !== "object" || typeof x.name !== "string" || !SAFE.test(x.name) || `${x.name}.json` !== file || typeof x.sandbox !== "string") return false;
	if (x.kind === "agent") {
		const a = x as Partial<AgentMachine>;
		return typeof a.runId === "string" && typeof a.agentId === "string" && Array.isArray(a.workerKey) && a.workerKey.length > 0 && a.workerKey.every((k) => typeof k === "string");
	}
	return typeof x.kind === "string" && JOB_KINDS.includes(x.kind);
}

/**
 * Every machine this capcomd recorded (both kinds, whatever their process or lifetime). null when the ledger itself
 * can't be read (then nobody can say which machines are capcomd's). A missing ledger is an empty one. A file that
 * can't be read or isn't a valid record still names its machine (by its file name) with no record: that machine is
 * capcomd's, but who uses it is unknown.
 */
export function readMachineLedger(env: Env = process.env): LedgerEntry[] | null {
	const dir = machinesDir(env);
	let files: string[];
	try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch (e) {
		return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
	}
	const out: LedgerEntry[] = [];
	for (const f of files) {
		const name = f.slice(0, -".json".length);
		if (!SAFE.test(name)) continue;
		let r: unknown = null;
		try { r = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { r = null; }
		out.push(validRecord(r, f) ? { name, record: r } : { name, record: null });
	}
	return out;
}

function alive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The machines capcomd's own jobs hold now: records whose process is alive and whose lifetime isn't up. */
export function liveJobMachines(env: Env = process.env, o: { now?: number; isAlive?: (pid: number) => boolean } = {}): JobMachine[] {
	return jobsHeld(readMachineLedger(env) ?? [], o);
}

/** The job records of a ledger read that count as owners now (their process is alive, their lifetime isn't up). */
export function jobsHeld(entries: LedgerEntry[], o: { now?: number; isAlive?: (pid: number) => boolean } = {}): JobMachine[] {
	const now = o.now ?? Date.now();
	const isAlive = o.isAlive ?? alive;
	const out: JobMachine[] = [];
	for (const { record: r } of entries) {
		if (!r || r.kind === "agent") continue;
		if (now > Number(r.createdAt) + Number(r.ttlSeconds) * 1000) continue;
		if (!isAlive(Number(r.pid))) continue;
		out.push(r);
	}
	return out;
}

const AI: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** What the Machines section says about one of these: a role word and a daemon-written line. */
export function jobOwnerText(m: Pick<JobMachine, "kind" | "purpose" | "runId" | "agent">): { role: string; label: string } {
	const ai = (m.agent && AI[m.agent]) ?? "an AI";
	switch (m.kind) {
		case "check": return { role: "checks", label: m.runId && SAFE.test(m.runId) ? `Checks for ${m.runId}` : "Checks" };
		case "login": return { role: "login", label: m.purpose === "auth-status" ? `Checking the ${ai} login` : `Logging in to ${ai}` };
		case "env_build": return { role: "environment", label: "Building the agent environment" };
		case "doctor": return { role: "environment", label: "Checking the agent environment" };
	}
}
