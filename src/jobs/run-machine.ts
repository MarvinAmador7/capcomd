// A run's own job machine (docs/spec/plugin-api.md §16.2): where a run-owned `exec` job (`owner: {run: true}`) runs, so
// it outlives the agent that started it (a server kept for review). It is made the way a run's checks machine is
// (src/merge/verify.ts runInVm): on the run's sandbox, through `sandbox.ensuring` (purpose `job`: labels
// `{purpose: "job", run}`), from the run's environment image (never an auth snapshot: no credential reaches it), with
// only the package registries as egress. It is recorded in the machines ledger as the run's (kind `job`), so the
// place's Machines list shows it as the run's background jobs, and it holds a machine slot of its place while it lives
// (src/providers/capacity.ts), as a check's machine does: it counts with the run's machines. The jobs service
// (service.ts) destroys it when its run ends, or once no job of the run runs in it any more; its jobs' records keep
// where it is (`RunMachineRef`), so a restarted daemon finds it again.
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayError } from "../core/errors";
import type { JobMachine } from "./machine";

/** The owner key of a run's job machine (`JobMachine.agentId`): no agent's id is this. */
export const RUN_OWNER = "run";

/** Where a run's job machine is, as its jobs' records keep it (kernel-only), for a restarted daemon to find it. */
export interface RunMachineRef {
  /** Its run's sandbox when it was made (null: the daemon's). */
  sandbox: string | null;
  vmId: string;
  idemKey: string;
  /** Where its jobs' directories are, and where a job runs when its spec names no `cwd`. */
  dir: string;
  cwd: string;
  ttlSeconds: number;
}

/** A run's job machine while this daemon holds it: `release` destroys it and gives back its record and its slot. */
export interface HeldRunMachine { m: JobMachine; ref: RunMachineRef; release(): Promise<void> }

/** How long a job start waits for a machine slot on a place with a cap before it is refused (it is an in-VM call). */
const SLOT_WAIT_MS = () => Number(process.env.CAPCOMD_JOBS_SLOT_WAIT_MS ?? 30_000);
const READY_MS = 120_000;
type Env = Record<string, string | undefined>;

/** The place's name: the run's sandbox, else the daemon's. */
async function placeOf(sandbox: string | null, source: Env): Promise<string | null> {
  if (sandbox) return sandbox;
  try { return (await import("../providers/registry")).sandboxName(source); } catch { return null; }
}

/** The machine's paths and the env its commands get: a VM's agent home and PATH; the host test sandbox's own folder. */
async function layout(place: string | null, runId: string, idemKey: string, source: Env): Promise<{ dir: string; cwd: string; env: Record<string, string> | undefined }> {
  // The test sandbox that runs "VMs" on this host shares one /tmp: each run's job machine gets its own folder there.
  if (place === "fake-host") {
    const root = join(tmpdir(), "capcomd-jobvm", runId, idemKey.slice(-12));
    return { dir: join(root, "jobs"), cwd: join(root, "work"), env: undefined };
  }
  const { agentWorkdir } = await import("../agents/config");
  const { agentPath } = await import("../agents/runner");
  const workdir = agentWorkdir(source), home = `${workdir}/home`;
  return { dir: "/tmp/capcomd-jobs", cwd: `${workdir}/jobs`, env: { PATH: agentPath(home), HOME: home } };
}

/**
 * Make the run's job machine for a job that may run `lifetimeMs`: a slot of its place (refused, retryable, when none
 * comes free within CAPCOMD_JOBS_SLOT_WAIT_MS), its ledger record, then the machine, ready, with its folders.
 */
export async function ensureRunMachine(runId: string, o: { lifetimeMs: number }): Promise<HeldRunMachine> {
  const { providerForRun } = await import("../dependencies");
  const { runSandboxEnv, runIdleLifetime } = await import("../providers/run-sandbox");
  const { BASE_EGRESS } = await import("../agents/config");
  const { resolveEnvSnapshot } = await import("../env/resolve");
  const { recordJobMachine } = await import("../providers/machines");
  const { holdSlot } = await import("../providers/capacity");
  const { provider, sandbox } = await providerForRun(runId);
  const source = await runSandboxEnv(runId);
  const place = await placeOf(sandbox, source);
  const idemKey = `capcomd-job-${runId}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  // Its idle lifetime is the run's, and never shorter than the job it is made for may run.
  const ttlSeconds = Math.max(await runIdleLifetime(runId, sandbox, source), Math.ceil(o.lifetimeMs / 1000) + 600);
  const slot = await holdSlot(place, `capcomd-jobs-${runId}`, { waitMs: SLOT_WAIT_MS() }).catch((e) => {
    throw new RelayError("engine_unreachable", `${(e as Error).message}, so the run's job machine wasn't made`, "Start it again once an agent of this place has finished.", { code: "unavailable", retryable: true });
  });
  const forget = recordJobMachine({ idemKey, sandbox: place, kind: "job", purpose: "job", runId, ttlSeconds });
  const snap = resolveEnvSnapshot(source);
  const where = await layout(place, runId, idemKey, source);
  let id: string | null = null;
  try {
    ({ id } = await provider.ensure({ idemKey, isolated: true, ttlSeconds, egressAllow: [...BASE_EGRESS], labels: { purpose: "job", run: runId }, ...(snap ? { fromSnapshot: snap } : {}) }));
    await provider.waitReady(id, READY_MS);
    const ref: RunMachineRef = { sandbox, vmId: id, idemKey, dir: where.dir, cwd: where.cwd, ttlSeconds };
    const held = holding(runId, ref, where.env, () => { forget(); slot.release(); });
    const mk = await held.m.exec(["mkdir", "-p", ref.dir, ref.cwd], { timeoutMs: 30_000 });
    if (mk.code !== 0) throw new Error(`making its folders failed: ${(mk.stderr || mk.stdout).trim().slice(-300)}`);
    return held;
  } catch (e) {
    if (id) await provider.destroy(id).catch(() => {});
    forget(); slot.release();
    if (e instanceof RelayError) throw e;
    throw new RelayError("engine_unreachable", `the run's job machine couldn't be made: ${String((e as Error)?.message ?? e).slice(0, 500)}`, "Try again; if it keeps failing, check the sandbox (capcomd doctor).", { code: "unavailable", retryable: true });
  }
}

/** The run's job machine a restarted daemon finds from its jobs' records: recorded again as this process's, with a
 *  slot if one is free now (the machine is there either way). */
export async function reattachRunMachine(runId: string, ref: RunMachineRef): Promise<HeldRunMachine> {
  const { recordJobMachine } = await import("../providers/machines");
  const { holdSlot } = await import("../providers/capacity");
  const { runSandboxEnv } = await import("../providers/run-sandbox");
  const { withSandbox } = await import("../providers/run-sandbox");
  const source = ref.sandbox ? withSandbox(process.env, ref.sandbox) : await runSandboxEnv(runId);
  const place = await placeOf(ref.sandbox, source);
  const slot = await holdSlot(place, `capcomd-jobs-${runId}`, { waitMs: 0 }).catch(() => null);
  const forget = recordJobMachine({ idemKey: ref.idemKey, sandbox: place, kind: "job", purpose: "job", runId, ttlSeconds: ref.ttlSeconds });
  return holding(runId, ref, (await layout(place, runId, ref.idemKey, source)).env, () => { forget(); slot?.release(); });
}

function holding(runId: string, ref: RunMachineRef, env: Record<string, string> | undefined, done: () => void): HeldRunMachine {
  let provider: Promise<import("../providers/sandbox").SandboxProvider> | null = null;
  const p = () => (provider ??= import("../dependencies").then((d) => d.providerNamed(ref.sandbox)));
  // Its commands go to the provider as it is (as an agent's spool pump does): a call during an outage fails and is
  // looked at again next tick, instead of holding up the jobs' loop for the outage window.
  const m: JobMachine = {
    runId, agentId: RUN_OWNER, dir: ref.dir, cwd: ref.cwd,
    exec: async (cmd, o) => (await import("../providers/resilient")).rawProvider(await p()).exec(ref.vmId, cmd, { ...(env ? { env } : {}), ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }),
  };
  let released: Promise<void> | null = null;
  return {
    m, ref,
    release: () => (released ??= (async () => {
      try { await (await p()).destroy(ref.vmId); } catch (e) { console.error(`[jobs] ${runId}: destroying its job machine ${ref.vmId}: ${(e as Error)?.message ?? e}`); }
      done();
    })()),
  };
}
