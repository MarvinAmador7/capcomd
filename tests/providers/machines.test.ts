// ADR-021 §3, the phase-3 prerequisite: capcomd's own short jobs (the checks VM, `auth login`/`status`, `env build`,
// `env doctor`) make machines with capcomd's prefix too. Each records its machine in capcomd's own ledger while it runs,
// so the resources route lists it as running with an owner of its kind and no actions, never as orphaned; once the job
// ends (or its process is gone, or its lifetime is up) the record no longer counts. Provider labels are never read.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinResources, terminalCommandFor } from "../../src/api/sandboxes";
import { jobOwners } from "../../src/api/rivet-source";
import { jobOwnerText, liveJobMachines, machineNameFor, machinesDir, recordJobMachine } from "../../src/providers/machines";
import { vmNameFor } from "../../src/providers/boxd";
import { FakeProvider } from "../../src/providers/fake";
import type { VmInfo, VmSpec } from "../../src/providers/sandbox";
import { initDependencies, resetDependencies } from "../../src/dependencies";
import { loadAgentConfig } from "../../src/agents/config";
import { authLogin } from "../../src/auth/login";
import { envBuild } from "../../src/env/build";
import { Git } from "../../src/merge/git";
import { runTests } from "../../src/merge/verify";
import { bareRepo } from "../merge/gitfixture";

const saved = { ...process.env };
const ledger = mkdtempSync(join(tmpdir(), "capcomd-machines-"));
// No engine here (and never a developer's own on the default port): nothing below names a run to verify, so verify
// doesn't ask an engine for the run's sandbox; a dead endpoint makes sure.
beforeAll(() => { process.env.CAPCOMD_MACHINES_LEDGER = ledger; process.env.CAPCOMD_ENDPOINT = "http://127.0.0.1:9"; delete process.env.CAPCOMD_SANDBOX; });
afterAll(() => { resetDependencies(); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

/**
 * A host-exec fake whose machines a provider list would show under capcomd's names (the fake itself names them by
 * idempotency key), and that looks at the place's Machines list the way the daemon builds it, while the job runs.
 */
class Watched extends FakeProvider {
	specs: VmSpec[] = [];
	seen: ReturnType<typeof joinResources>[] = [];
	override async ensure(spec: VmSpec) { this.specs.push(spec); return super.ensure(spec); }
	rows(): VmInfo[] { return this.specs.map((s, i) => ({ id: `m_${i}`, name: machineNameFor(s.idemKey), state: "running" })); }
	look() { this.seen.push(joinResources("fake", this.rows(), jobOwners())); }
	override async exec(id: string, cmd: string[], opts?: Parameters<FakeProvider["exec"]>[2]) { if (!this.seen.length) this.look(); return super.exec(id, cmd, opts); }
}

describe("the machines ledger", () => {
	test("names match the providers'; a record counts while its process lives and its lifetime isn't up; release removes it", () => {
		expect(machineNameFor("capcomd-checks-run-1-agt-1-abc")).toBe(vmNameFor("capcomd-checks-run-1-agt-1-abc"));
		expect(machinesDir({ CAPCOMD_MACHINES_LEDGER: "/x/y" })).toBe("/x/y");
		expect(machinesDir({ CAPCOMD_HOME: "/h" })).toBe("/h/state/machines");
		const env = { CAPCOMD_MACHINES_LEDGER: mkdtempSync(join(tmpdir(), "capcomd-ledger-")) };
		const release = recordJobMachine({ idemKey: "k1", sandbox: "boxd", kind: "check", purpose: "checks", runId: "run-8kq2", taskId: "agt-1", ttlSeconds: 3600 }, env);
		const [m] = liveJobMachines(env);
		expect(m).toMatchObject({ name: machineNameFor("k1"), sandbox: "boxd", kind: "check", runId: "run-8kq2", pid: process.pid });
		expect(liveJobMachines(env, { isAlive: () => false })).toEqual([]); // its process died: no longer capcomd's
		expect(liveJobMachines(env, { now: Date.now() + 3601_000 })).toEqual([]); // past its lifetime
		release();
		expect(liveJobMachines(env)).toEqual([]);
		expect(readdirSync(env.CAPCOMD_MACHINES_LEDGER)).toEqual([]);
	});

	test("listed as running with an owner of their kind and no actions; an unrecorded machine is still orphaned", () => {
		const env = { CAPCOMD_MACHINES_LEDGER: mkdtempSync(join(tmpdir(), "capcomd-ledger-")) };
		const jobs = [
			recordJobMachine({ idemKey: "check-1", sandbox: "boxd", kind: "check", purpose: "checks", runId: "run-8kq2", ttlSeconds: 3600 }, env),
			recordJobMachine({ idemKey: "login-1", sandbox: "boxd", kind: "login", purpose: "auth-login", agent: "claude-code", ttlSeconds: 1800 }, env),
			recordJobMachine({ idemKey: "status-1", sandbox: "boxd", kind: "login", purpose: "auth-status", agent: "codex", ttlSeconds: 1800 }, env),
			recordJobMachine({ idemKey: "build-1", sandbox: "boxd", kind: "env_build", purpose: "env-build", ttlSeconds: 3600 }, env),
			recordJobMachine({ idemKey: "doctor-1", sandbox: "boxd", kind: "doctor", purpose: "doctor", ttlSeconds: 900 }, env),
			recordJobMachine({ idemKey: "docker-check", sandbox: "docker", kind: "check", purpose: "checks", runId: "run-x", ttlSeconds: 3600 }, env),
		];
		const keys = ["check-1", "login-1", "status-1", "build-1", "doctor-1", "docker-check", "left-behind"];
		const rows: VmInfo[] = keys.map((k, i) => ({ id: `m_${i}`, name: machineNameFor(k), state: "running" }));
		const res = joinResources("boxd", rows, jobOwners(env));
		const by = (k: string) => res.find((r) => r.id === machineNameFor(k))!;
		expect(by("check-1")).toMatchObject({ state: "running", actions: [], owner: { kind: "check", runId: "run-8kq2", agentId: null, role: "checks", task: null, label: "Checks for run-8kq2" } });
		expect(by("login-1")).toMatchObject({ state: "running", actions: [], owner: { kind: "login", runId: null, role: "login", label: "Logging in to Claude Code" } });
		expect(by("status-1").owner).toMatchObject({ kind: "login", label: "Checking the Codex login" });
		expect(by("build-1")).toMatchObject({ state: "running", actions: [], owner: { kind: "env_build", role: "environment", label: "Building the agent environment" } });
		expect(by("doctor-1").owner).toMatchObject({ kind: "doctor", label: "Checking the agent environment" });
		// Another place's job doesn't claim this place's machine; nothing records this one: left behind.
		expect(by("docker-check")).toMatchObject({ state: "orphaned", owner: null });
		expect(by("left-behind")).toMatchObject({ state: "orphaned", owner: null, actions: ["open_terminal", "delete"], destructive: true, confirm: "Delete this machine? No agent is using it." });
		for (const r of res.filter((x) => x.owner)) expect(r).toMatchObject({ actions: [], destructive: false, confirm: null });
		for (const r of res.filter((x) => x.owner)) expect(terminalCommandFor("boxd", r)).toBeNull();
		for (const release of jobs) release();
		expect(joinResources("boxd", rows, jobOwners(env)).every((r) => r.state === "orphaned")).toBe(true);
		expect(jobOwnerText({ kind: "check", purpose: "checks", runId: "run-$(x)", agent: null }).label).toBe("Checks");
	});
});

describe("capcomd's own jobs record their machines while they run", () => {
	test("checks (verify): the run's checks while they run, gone from the ledger after", async () => {
		const repo = mkdtempSync(join(tmpdir(), "capcomd-mach-checks-"));
		const git = new Git(repo);
		await git.ok(["init", "-q", "-b", "main"]);
		writeFileSync(join(repo, "ok.sh"), "echo ok\n");
		await git.ok(["add", "."]);
		await git.ok(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"]);
		const p = new Watched({ hostExec: true });
		initDependencies({ provider: p });
		const env0 = { ...process.env };
		Object.assign(process.env, { CAPCOMD_CHECKS: "vm", CAPCOMD_AGENT_WORKDIR: mkdtempSync(join(tmpdir(), "capcomd-mach-vm-")), CAPCOMD_ENV: "image" });
		try {
			expect(await runTests(git, "sh ok.sh", { CAPCOMD_TASK_ID: "agt-1", CAPCOMD_TARGET: "main" })).toMatchObject({ passed: true, where: "vm" });
		} finally { resetDependencies(); for (const k of ["CAPCOMD_CHECKS", "CAPCOMD_AGENT_WORKDIR", "CAPCOMD_ENV"]) if (env0[k] === undefined) delete process.env[k]; else process.env[k] = env0[k]; }
		expect(p.seen[0]!.map((r) => [r.state, r.owner?.kind, r.owner?.label, r.actions])).toEqual([["running", "check", "Checks", []]]);
		expect(joinResources("fake", p.rows(), jobOwners()).map((r) => r.state)).toEqual(["orphaned"]); // ended: no longer recorded
		expect(liveJobMachines()).toEqual([]);
	}, 60_000);

	test("env build: the environment build while it runs", async () => {
		const r = await bareRepo();
		const workdir = mkdtempSync(join(tmpdir(), "capcomd-mach-env-"));
		const home = join(workdir, "home");
		mkdirSync(join(home, "node/bin"), { recursive: true });
		mkdirSync(join(home, "npm/bin"), { recursive: true });
		const sh = (f: string, body: string) => { writeFileSync(f, `#!/bin/bash\n${body}\n`); chmodSync(f, 0o755); };
		sh(join(home, "node/bin/node"), `case "$1" in -v) echo v22.9.0;; -p) echo 22;; esac`);
		sh(join(home, "npm/bin/claude"), `echo "2.1.290 (Claude Code)"`);
		sh(join(home, "npm/bin/codex"), `echo "codex-cli 0.1"`);
		const p = new Watched({ hostExec: true });
		await envBuild(p, { repoUrl: r.bare, cfg: loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir }), ledgerPath: join(workdir, "envs.json"), pollMs: 1 });
		expect(p.seen[0]!.map((x) => [x.state, x.owner?.kind, x.owner?.label, x.actions])).toEqual([["running", "env_build", "Building the agent environment", []]]);
		expect(liveJobMachines()).toEqual([]);
	}, 60_000);

	test("auth login: logging in while it runs", async () => {
		const workdir = mkdtempSync(join(tmpdir(), "capcomd-mach-auth-"));
		mkdirSync(join(workdir, "home"), { recursive: true });
		const p = new Watched({ hostExec: true });
		p.secretsDenied = true;
		const stdin = new PassThrough() as any;
		setTimeout(() => stdin.write("BROWSERCODE\n"), 150);
		const cfg = loadAgentConfig({ CAPCOMD_AGENT: "claude-code", CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_BIN: new URL("../auth/fake-claude-login.sh", import.meta.url).pathname, CAPCOMD_CREDENTIALS: "auto" });
		await authLogin(p as any, "claude-code", { cfg, envSnapshot: "capcomd-env-2f1eed2b11c528fc", ledgerPath: join(workdir, "auths.json"), stdout: () => {}, stdin, pollMs: 1 });
		expect(p.seen[0]!.map((x) => [x.state, x.owner?.kind, x.owner?.role, x.owner?.label, x.actions])).toEqual([["running", "login", "login", "Logging in to Claude Code", []]]);
		expect(liveJobMachines()).toEqual([]);
		expect(existsSync(ledger)).toBe(true);
	}, 60_000);
});
