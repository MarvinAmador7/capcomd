// capcomd's own short jobs on machines (ADR-021 §3): the checks VM (verify), `auth login` / `auth status`, `env build`
// and `env doctor` create machines with capcomd's prefix too. Without a record of their own, the resources route would
// call a running check "left behind" (orphaned), and a later Delete could kill it. So the process that makes one records
// it here first, in a local ledger capcomd itself writes (never the provider's labels, which a sandbox can forge), and
// removes the record once the machine is destroyed.
//
// One file per machine (`<state>/machines/<name>.json`): processes add and remove their own without racing each other.
// A record counts only while the process that wrote it is alive and the machine's idle lifetime since it was made isn't
// up, so a job that crashed leaves a machine that reads as orphaned again (and is deleted when its lifetime is up).
import { createHash } from "node:crypto";
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

/** CAPCOMD_MACHINES_LEDGER (a directory) wins; else `<state>/machines`. */
export const machinesDir = (env: Env = process.env) => env.CAPCOMD_MACHINES_LEDGER || join(stateDir(env), "machines");

/** The name a provider gives the machine for an idempotency key (boxd's vmNameFor and Docker's container name). */
export function machineNameFor(idemKey: string, prefix = MACHINE_PREFIX): string {
	return `${prefix}${createHash("sha256").update(idemKey).digest("hex").slice(0, 16)}`;
}

const SAFE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Records a machine one of capcomd's jobs is about to make; call before `provider.ensure` (a record of a machine that
 * never came up is harmless), and call the returned release once it is destroyed. Never throws: a ledger that can't
 * be written only makes the machine read as orphaned.
 */
export function recordJobMachine(m: { idemKey: string; sandbox: string | null | undefined; kind: JobKind; purpose: string; runId?: string | null; taskId?: string | null; agent?: string | null; ttlSeconds: number }, env: Env = process.env): () => void {
	const name = machineNameFor(m.idemKey);
	const dir = machinesDir(env);
	const file = join(dir, `${name}.json`);
	const rec: JobMachine = {
		name, sandbox: m.sandbox ?? "unknown", kind: m.kind, purpose: m.purpose, runId: m.runId ?? null, taskId: m.taskId ?? null, agent: m.agent ?? null,
		pid: process.pid, createdAt: Date.now(), ttlSeconds: m.ttlSeconds,
	};
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
		renameSync(tmp, file);
	} catch { /* best effort */ }
	return () => { try { rmSync(file, { force: true }); } catch { /* best effort */ } };
}

function alive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The machines capcomd's own jobs hold now: records whose process is alive and whose lifetime isn't up. */
export function liveJobMachines(env: Env = process.env, o: { now?: number; isAlive?: (pid: number) => boolean } = {}): JobMachine[] {
	const dir = machinesDir(env);
	const now = o.now ?? Date.now();
	const isAlive = o.isAlive ?? alive;
	let files: string[];
	try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
	const out: JobMachine[] = [];
	for (const f of files) {
		let r: JobMachine;
		try { r = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
		if (!r || typeof r.name !== "string" || !SAFE.test(r.name) || `${r.name}.json` !== f) continue;
		if (!["check", "login", "env_build", "doctor"].includes(r.kind)) continue;
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
