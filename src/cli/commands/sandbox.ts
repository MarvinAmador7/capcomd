// `capcomd sandbox shell` (ADR-021 §3, "Open in Terminal stays safe"): an interactive shell in the machine an agent
// runs on, or in a machine capcomd left behind. The app's Open in Terminal runs exactly this command (the daemon's
// `terminalCommand`), built only from ids capcomd handed out; this side trusts none of them. It looks the machine up
// again (capcomd's own records for an agent, the provider's list for a machine), accepts only ids of
// [A-Za-z0-9._-]{1,128} carrying capcomd's prefix, and connects with this CLI's own credentials (the boxd key from
// `capcomd setup`, the local docker CLI), never the app's API token. boxd: an interactive exec with a terminal;
// Docker: `docker exec -it`.
import { RelayError } from "../../core/errors";
import { isMachineId, SAFE_ID } from "../../api/sandboxes";
import { descriptorOf, isListedProvider, LISTED_PROVIDERS, type ListedProvider } from "../../providers/registry";
import { MACHINE_PREFIX, type VmInfo } from "../../providers/sandbox";
import type { InteractiveSession } from "../../auth/interactive";

type Env = Record<string, string | undefined>;

/** Lands in the agent's work directory when there is one, then the login shell the machine has. */
export const SHELL_SCRIPT = "cd /var/tmp/capcomd 2>/dev/null || cd; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi";
export const SHELL_ARGV = ["sh", "-c", SHELL_SCRIPT];

export interface AgentMachine { sandbox: string; vmId: string; name: string | null }
export interface ShellProvider {
	list(prefix: string): Promise<VmInfo[]>;
	streamExec?(id: string, cmd: string[], opts: { env?: Record<string, string>; tty?: boolean; cols?: number; rows?: number }): InteractiveSession;
}
export interface ShellDeps {
	env: Env;
	/** The machine an agent holds now (capcomd's records: its worker), or null when it holds none. */
	agentMachine(runId: string, agentId: string): Promise<AgentMachine | null>;
	/** A provider made with this CLI's own credentials. */
	provider(name: ListedProvider): Promise<ShellProvider>;
	/** Runs a command attached to this terminal; resolves with its exit code (docker exec). */
	spawn(argv: string[]): Promise<number>;
	/** Connects an interactive session to this terminal; resolves with its exit code (boxd). */
	attach(session: InteractiveSession): Promise<number>;
	stderr(line: string): void;
	isTTY: boolean;
	columns?: number;
	rows?: number;
}

const usage = (m: string) => new RelayError("usage", m, "Usage: capcomd sandbox shell <runId> <agentId>  |  capcomd sandbox shell --sandbox <name> --machine <id>");

/** What `capcomd sandbox shell` will connect to, after every check; exported for tests. */
export async function resolveShellTarget(args: { positionals: string[]; sandbox?: string; machine?: string }, deps: Pick<ShellDeps, "agentMachine" | "provider">): Promise<{ sandbox: ListedProvider; machine: VmInfo; owner: { runId: string; agentId: string } | null }> {
	const rest = args.positionals;
	let sandbox: string, want: { id?: string; name?: string };
	let owner: { runId: string; agentId: string } | null = null;
	if (args.machine !== undefined) {
		if (rest.length) throw usage("give either <runId> <agentId> or --sandbox and --machine, not both");
		if (!args.sandbox) throw usage("--machine needs --sandbox (where the machine runs)");
		if (!isMachineId(args.machine)) throw usage(`not a capcomd machine id: it must start with ${MACHINE_PREFIX} and use only letters, digits, '.', '_' and '-' (at most 128)`);
		sandbox = args.sandbox;
		want = { name: args.machine };
	} else {
		if (rest.length !== 2) throw usage("give the run and the agent: capcomd sandbox shell <runId> <agentId>");
		const [runId, agentId] = rest as [string, string];
		if (!SAFE_ID.test(runId) || !SAFE_ID.test(agentId)) throw usage("run and agent ids use only letters, digits, '.', '_' and '-'");
		const m = await deps.agentMachine(runId, agentId);
		if (!m) throw new RelayError("not_found", `${agentId} has no machine now (it hasn't started, or it has ended and its machine was deleted)`, `Check it with \`capcomd tree ${runId}\`.`);
		if (args.sandbox !== undefined && args.sandbox !== m.sandbox) throw usage(`${agentId} runs on ${m.sandbox}, not ${args.sandbox}`);
		if (!SAFE_ID.test(m.vmId) || (m.name !== null && !isMachineId(m.name))) throw new RelayError("not_found", `${agentId}'s machine id isn't one capcomd opens a shell in`, "Report this: capcomd records only ids it made.");
		sandbox = m.sandbox;
		want = { id: m.vmId, ...(m.name ? { name: m.name } : {}) };
		owner = { runId, agentId };
	}
	if (!isListedProvider(sandbox)) throw usage(`unknown place ${JSON.stringify(sandbox.slice(0, 64))}: use one of ${LISTED_PROVIDERS.join(", ")}`);
	if (!descriptorOf(sandbox)!.caps.shell) throw usage(`${sandbox} has no shell into its machines`);
	// Look it up again at the provider: only a machine that exists now and carries capcomd's prefix.
	const p = await deps.provider(sandbox);
	const rows = await p.list(MACHINE_PREFIX);
	const machine = rows.find((r) => isMachineId(r.name) && SAFE_ID.test(r.id) && (want.id !== undefined ? r.id === want.id || (want.name !== undefined && r.name === want.name) : r.name === want.name));
	if (!machine) throw new RelayError("not_found", `no capcomd machine ${want.name ?? want.id} on ${sandbox} now`, "It may have been deleted (its agent ended, or its idle lifetime was up).");
	return { sandbox, machine, owner };
}

/** `capcomd sandbox shell …`. Resolves with the shell's exit code. */
export async function sandboxShell(args: { positionals: string[]; sandbox?: string; machine?: string }, deps: ShellDeps): Promise<number> {
	const t = await resolveShellTarget(args, deps);
	const d = descriptorOf(t.sandbox)!;
	deps.stderr(`Warning: this is a shell inside an agent's sandbox (${d.title}, machine ${t.machine.name}${t.owner ? `, agent ${t.owner.agentId} of ${t.owner.runId}` : ", no agent"}): what you change there can change its work.`);
	if (t.sandbox === "docker") {
		const { dockerBin } = await import("../../providers/docker");
		return deps.spawn([dockerBin(deps.env), "exec", "-i", ...(deps.isTTY ? ["-t"] : []), t.machine.name, ...SHELL_ARGV]);
	}
	const p = await deps.provider(t.sandbox);
	if (!p.streamExec) throw new RelayError("config", `${d.title} can't open an interactive shell here`, "Update capcomd, or check `capcomd setup check`.");
	return deps.attach(p.streamExec(t.machine.id, SHELL_ARGV, { tty: true, cols: deps.columns ?? 120, rows: deps.rows ?? 40 }));
}

/** This terminal ⇄ an interactive session: raw keystrokes in, output straight out (nothing is filtered or kept). */
async function attachTerminal(s: InteractiveSession): Promise<number> {
	const stdin = process.stdin;
	const onData = (d: Buffer) => s.write(new Uint8Array(d));
	const onEnd = () => s.end();
	const raw = !!stdin.isTTY;
	if (raw) stdin.setRawMode(true);
	stdin.on("data", onData); stdin.on("end", onEnd); stdin.resume();
	const resize = () => s.resize?.(process.stdout.columns || 120, process.stdout.rows || 40);
	if (process.stdout.isTTY) process.stdout.on("resize", resize);
	try {
		for await (const chunk of s.output) process.stdout.write(chunk);
		return await s.wait();
	} finally {
		stdin.off("data", onData); stdin.off("end", onEnd); if (raw) stdin.setRawMode(false); stdin.pause();
		if (process.stdout.isTTY) process.stdout.off("resize", resize);
	}
}

/** The real dependencies: capcomd's engine for an agent's machine, providers with this CLI's own credentials. */
export function localShellDeps(env: Env = process.env): ShellDeps {
	return {
		env,
		agentMachine: async (runId, agentId) => {
			const { assertEngine, client } = await import("../../core/relay");
			const { getAgentOrThrow } = await import("../../primitives/ops");
			const { vmNameFor } = await import("../../providers/boxd");
			const { sandboxName } = await import("../../providers/registry");
			await assertEngine();
			const a = await getAgentOrThrow(runId, agentId);
			const epoch = Number(a.epoch ?? 1);
			const wk: any = await (client().worker as any).get(epoch > 1 ? [runId, agentId, `e${epoch}`] : [runId, agentId]).getWorker({ workerId: agentId }).catch(() => null);
			const ctx = wk?.context ?? {};
			if (!wk || wk.state === "destroyed" || typeof ctx.vmId !== "string" || !ctx.vmId) return null;
			let sandbox: string | null = typeof ctx.sandbox === "string" && ctx.sandbox ? ctx.sandbox : null;
			if (!sandbox) { try { sandbox = sandboxName(env); } catch { return null; } }
			return { sandbox, vmId: ctx.vmId, name: typeof ctx.idemKey === "string" ? vmNameFor(ctx.idemKey, MACHINE_PREFIX) : null };
		},
		provider: async (name) => {
			if (name === "docker") return new (await import("../../providers/docker")).DockerProvider();
			const { BoxdProvider } = await import("../../providers/boxd");
			return new BoxdProvider({ keepaliveMs: 0 });
		},
		spawn: async (argv) => Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env: env as Record<string, string> }).exited,
		attach: attachTerminal,
		stderr: (line) => process.stderr.write(`${line}\n`),
		isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
		columns: process.stdout.columns,
		rows: process.stdout.rows,
	};
}
