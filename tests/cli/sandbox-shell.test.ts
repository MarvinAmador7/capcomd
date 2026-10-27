// `capcomd sandbox shell` (ADR-021 §3): what the app's Open in Terminal runs. It trusts none of its arguments: it
// looks the machine up again, accepts only capcomd's own machine ids, and opens a shell with this CLI's credentials
// (boxd: an interactive exec with a terminal; Docker: `docker exec -it`). No real VM or container: the providers,
// capcomd's records and the terminal are injected.
import { describe, expect, test } from "bun:test";
import { RelayError } from "../../src/core/errors";
import { resolveShellTarget, sandboxShell, SHELL_ARGV, type ShellDeps } from "../../src/cli/commands/sandbox";
import type { VmInfo } from "../../src/providers/sandbox";
import type { InteractiveSession } from "../../src/auth/interactive";

const ROWS: Record<string, VmInfo[]> = {
	boxd: [
		{ id: "m_1", name: "relay-3f9c2a1b7e5d4c60", state: "running" },
		{ id: "m_2", name: "relay-0a0b0c0d0e0f1011", state: "running" },
		{ id: "m_9", name: "someone-elses-machine", state: "running" },
	],
	docker: [{ id: "relay-aaaaaaaaaaaaaaaa", name: "relay-aaaaaaaaaaaaaaaa", state: "running" }],
};

function deps(o: Partial<ShellDeps> & { owners?: Record<string, { sandbox: string; vmId: string; name: string | null }> } = {}) {
	const spawned: string[][] = [];
	const streamed: Array<{ id: string; cmd: string[]; opts: unknown }> = [];
	const listed: string[] = [];
	const lines: string[] = [];
	const session = { write() {}, end() {}, close() {}, output: (async function* () {})(), wait: async () => 7 } as InteractiveSession;
	const d: ShellDeps = {
		env: { CAPCOMD_DOCKER_BIN: "/stub/docker" },
		agentMachine: async (runId, agentId) => o.owners?.[`${runId}/${agentId}`] ?? null,
		provider: async (name) => ({
			list: async (prefix) => { listed.push(`${name}:${prefix}`); return ROWS[name] ?? []; },
			streamExec: (id, cmd, opts) => { streamed.push({ id, cmd, opts }); return session; },
		}),
		spawn: async (argv) => { spawned.push(argv); return 0; },
		attach: async (s) => s.wait(),
		stderr: (l) => lines.push(l),
		isTTY: true,
		columns: 100, rows: 30,
		...o,
	};
	return { d, spawned, streamed, listed, lines };
}
const fails = async (p: Promise<unknown>, code: string, msg: RegExp) => {
	const e = await p.then(() => null, (x) => x);
	expect(e).toBeInstanceOf(RelayError);
	expect((e as RelayError).code).toBe(code as never);
	expect((e as RelayError).message).toMatch(msg);
};

describe("capcomd sandbox shell: arguments", () => {
	test("needs a run and an agent, or --sandbox with --machine, never both", async () => {
		const { d } = deps();
		await fails(resolveShellTarget({ positionals: [] }, d), "usage", /give the run and the agent/);
		await fails(resolveShellTarget({ positionals: ["run-1"] }, d), "usage", /give the run and the agent/);
		await fails(resolveShellTarget({ positionals: ["run-1", "agt-1", "x"] }, d), "usage", /give the run and the agent/);
		await fails(resolveShellTarget({ positionals: ["run-1", "agt-1"], machine: "relay-0a0b0c0d0e0f1011", sandbox: "boxd" }, d), "usage", /not both/);
		await fails(resolveShellTarget({ positionals: [], machine: "relay-0a0b0c0d0e0f1011" }, d), "usage", /--machine needs --sandbox/);
	});
	test("accepts only [A-Za-z0-9._-]{1,128} ids, and machine ids with capcomd's prefix", async () => {
		const { d, listed } = deps();
		for (const m of ["someone-elses-machine", "relay-x;rm -rf ~", "relay-$(id)", "relay-a b", "relay-'q'", `relay-${"a".repeat(123)}`, "../relay-x", ""])
			await fails(resolveShellTarget({ positionals: [], sandbox: "boxd", machine: m }, d), "usage", /not a capcomd machine id/);
		for (const [r, a] of [["run-1;id", "agt-1"], ["run-1", "agt 1"], ["run-1", "$(id)"], ["", "agt-1"]])
			await fails(resolveShellTarget({ positionals: [r!, a!] }, d), "usage", /only letters, digits/);
		expect(listed).toEqual([]); // nothing was asked of any provider
	});
	test("only listed places with a shell", async () => {
		const { d } = deps();
		await fails(resolveShellTarget({ positionals: [], sandbox: "fake", machine: "relay-0a0b0c0d0e0f1011" }, d), "usage", /unknown place "fake"/);
		await fails(resolveShellTarget({ positionals: [], sandbox: "nope", machine: "relay-0a0b0c0d0e0f1011" }, d), "usage", /use one of docker, boxd/);
	});
	test("looks the machine up again: one the provider doesn't list now is not found", async () => {
		const { d, listed } = deps();
		await fails(resolveShellTarget({ positionals: [], sandbox: "boxd", machine: "relay-ffffffffffffffff" }, d), "not_found", /no capcomd machine relay-ffffffffffffffff on boxd/);
		await fails(resolveShellTarget({ positionals: [], sandbox: "docker", machine: "relay-0a0b0c0d0e0f1011" }, d), "not_found", /on docker/);
		expect(listed).toEqual(["boxd:relay-", "docker:relay-"]);
	});
	test("an agent: its machine from capcomd's records, then the provider's list", async () => {
		const { d } = deps({ owners: { "run-8kq2/agt-41": { sandbox: "boxd", vmId: "m_1", name: "relay-3f9c2a1b7e5d4c60" }, "run-8kq2/agt-42": { sandbox: "boxd", vmId: "m_gone", name: "relay-1111111111111111" }, "run-8kq2/agt-43": { sandbox: "boxd", vmId: "m;x", name: null } } });
		expect(await resolveShellTarget({ positionals: ["run-8kq2", "agt-41"] }, d)).toEqual({ sandbox: "boxd", machine: ROWS.boxd![0]!, owner: { runId: "run-8kq2", agentId: "agt-41" } });
		await fails(resolveShellTarget({ positionals: ["run-8kq2", "agt-40"] }, d), "not_found", /agt-40 has no machine now/);
		await fails(resolveShellTarget({ positionals: ["run-8kq2", "agt-42"] }, d), "not_found", /no capcomd machine relay-1111111111111111 on boxd/);
		await fails(resolveShellTarget({ positionals: ["run-8kq2", "agt-43"] }, d), "not_found", /isn't one capcomd opens a shell in/);
		await fails(resolveShellTarget({ positionals: ["run-8kq2", "agt-41"], sandbox: "docker" }, d), "usage", /runs on boxd, not docker/);
	});
});

describe("capcomd sandbox shell: the shell", () => {
	test("boxd: an interactive exec with a terminal on the machine's id, after a one-line warning", async () => {
		const { d, streamed, spawned, lines } = deps({ owners: { "run-8kq2/agt-41": { sandbox: "boxd", vmId: "m_1", name: "relay-3f9c2a1b7e5d4c60" } } });
		expect(await sandboxShell({ positionals: ["run-8kq2", "agt-41"] }, d)).toBe(7);
		expect(streamed).toEqual([{ id: "m_1", cmd: SHELL_ARGV, opts: { tty: true, cols: 100, rows: 30 } }]);
		expect(spawned).toEqual([]);
		expect(lines).toEqual(["Warning: this is a shell inside an agent's sandbox (Cloud · boxd, machine relay-3f9c2a1b7e5d4c60, agent agt-41 of run-8kq2): what you change there can change its work."]);
		expect(SHELL_ARGV[0]).toBe("sh");
	});
	test("docker: `docker exec -it <container>` with this CLI's docker; -t only on a terminal", async () => {
		const tty = deps();
		expect(await sandboxShell({ positionals: [], sandbox: "docker", machine: "relay-aaaaaaaaaaaaaaaa" }, tty.d)).toBe(0);
		expect(tty.spawned).toEqual([["/stub/docker", "exec", "-i", "-t", "relay-aaaaaaaaaaaaaaaa", ...SHELL_ARGV]]);
		expect(tty.streamed).toEqual([]);
		expect(tty.lines).toEqual(["Warning: this is a shell inside an agent's sandbox (Local · Docker, machine relay-aaaaaaaaaaaaaaaa, no agent): what you change there can change its work."]);
		const piped = deps({ isTTY: false });
		await sandboxShell({ positionals: [], sandbox: "docker", machine: "relay-aaaaaaaaaaaaaaaa" }, piped.d);
		expect(piped.spawned[0]).toEqual(["/stub/docker", "exec", "-i", "relay-aaaaaaaaaaaaaaaa", ...SHELL_ARGV]);
	});
	test("nothing runs when a check fails", async () => {
		const { d, spawned, streamed, lines } = deps();
		await sandboxShell({ positionals: [], sandbox: "boxd", machine: "relay-x;id" }, d).catch(() => {});
		await sandboxShell({ positionals: [], sandbox: "boxd", machine: "relay-ffffffffffffffff" }, d).catch(() => {});
		expect([spawned, streamed, lines]).toEqual([[], [], []]);
	});
});

describe("capcomd sandbox shell from the CLI", () => {
	test("usage errors exit 2 before anything is looked up", async () => {
		const run = (args: string[]) => Bun.spawn(["bun", "src/cli/index.ts", ...args], { cwd: `${import.meta.dir}/../..`, stdout: "pipe", stderr: "pipe", env: { ...process.env, CAPCOMD_NO_CONFIG: "1", CAPCOMD_ENDPOINT: "http://127.0.0.1:1" } });
		const bad = run(["sandbox", "shell", "--sandbox", "boxd", "--machine", "relay-x;id"]);
		expect(await bad.exited).toBe(2);
		expect(await new Response(bad.stderr).text()).toContain("not a capcomd machine id");
		const other = run(["sandbox", "nope"]);
		expect(await other.exited).toBe(2);
	}, 30_000);
});
