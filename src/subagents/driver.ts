// ADR-017 driver glue: give an agent its in-VM capcomd (token + spool pump) for as long as it runs.
//  - Real agents (allowSpawn only): VmSpool over boxd exec; the runner installs the CLI + skill.
//  - Scripted fake agents (CAPCOMD_SPAWN_EXEC=script, tests/scenarios): the contract's `script` runs
//    on this host with a scrubbed env (no host secrets, no engine endpoint) and the same CLI on a
//    LocalSpool, so scenarios exercise exactly the in-VM code path minus boxd.
import { VM_CLI_SOURCE } from "../utils/assets";
import { spawn as spawnProc } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { client } from "../core/relay";
import type { ScopeAgent } from "../actors/scope";
import { handleRpc } from "./rpc";
import { LocalSpool, VmSpool, startPump } from "./spool";
import { mint, opsFor } from "./token";
import { killpoint } from "../utils/killpoint";
import { env } from "../utils/env";
import type { SandboxProvider, VmId } from "../providers/sandbox";
import { VM_RPC_DIR } from "./skill";


const NODE_BIN = Bun.which("node") ?? "node";

function pumpFor(runId: string, a: ScopeAgent, spool: LocalSpool | VmSpool, intervalMs: number) {
  const s = client().scope.getOrCreate([runId]);
  const ttlMs = Number(env("TOKEN_TTL_MS") ?? 30 * 60_000);
  let jti: string | null = null;
  const pump = startPump({
    spool, intervalMs, refreshMs: Math.max(1000, ttlMs / 2),
    mintToken: () => { const t = mint({ run: runId, sub: a.agentId, ops: opsFor(a.limits), ttlMs }); jti = t.claims.jti; return t.token; },
    handle: async (req) => {
      driverKillpoint(`rpc.${req.op}.before`);
      const r = await handleRpc(req, { runId, agentId: a.agentId });
      driverKillpoint(`rpc.${req.op}.before_reply`); // handled (e.g. child spawned) but the VM never got the answer
      return r;
    },
    onLog: (lines) => { s.appendLog({ agentId: a.agentId, stream: "agent", lines }).catch(() => {}); },
  });
  return {
    stop: async () => {
      await pump.stop();
      // The agent is done with its token: revoke it so a copy left in the VM is dead now, not at exp.
      if (jti) await s.revokeToken({ jti, agentId: a.agentId, reason: `agent ${a.agentId} finished` }).catch(() => {});
    },
  };
}

/** Real agent VM: pump while `work` runs (the worker actor's pushBranch). */
export async function withVmRpc<T>(runId: string, a: ScopeAgent, provider: SandboxProvider, vmId: VmId, jsonl: string | undefined, work: () => Promise<T>): Promise<T> {
  const p = pumpFor(runId, a, new VmSpool(provider, vmId, VM_RPC_DIR, jsonl), Number(env("VM_RPC_POLL_MS") ?? 1000));
  try { return await work(); } finally { await p.stop(); }
}

export class ScriptFailed extends Error { constructor(msg: string, readonly exitCode: number) { super(msg); } }

/** Chaos: kill this driver once at `name` (marker file), simulating a host crash mid-RPC. */
export function driverKillpoint(name: string) {
  const want = env("DRIVER_KILLPOINT");
  if (!want || want !== name) return;
  const marker = env("DRIVER_KILLPOINT_MARKER");
  if (!marker || existsSync(marker)) return;
  writeFileSync(marker, String(process.pid));
  console.error(`[DRIVER-KILL] ${name} pid ${process.pid}`);
  process.kill(process.pid, "SIGKILL");
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Scripted fake agent. Its "VM" is a per-agent directory that outlives the driver: a new driver
 * (after a crash) re-attaches to the running script and drains the same spool, like a real
 * driver re-attaching to a VM. Env is built from scratch: PATH (with capcomd), a private HOME,
 * the spool, and task identity. Nothing else from the host leaks in.
 */
export async function runScripted(runId: string, a: ScopeAgent): Promise<{ exitCode: number }> {
  // Agents capcomd spawns itself have no contract script: verify's reviewer takes CAPCOMD_SCRIPT_REVIEWER, and any
  // other a script by profile, CAPCOMD_SCRIPT_<PROFILE> (`capcomd run --planner`'s planner).
  const ownScript = (a.contract as any)?.review ? env("SCRIPT_REVIEWER") : a.profile ? env(`SCRIPT_${a.profile.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`) : undefined;
  const script = typeof a.contract?.script === "string" ? (a.contract.script as string) : ownScript ?? `capcomd result --summary "did: ${a.task.replace(/["`$\\]/g, "")}"`;
  const root = join(env("SCRIPT_VM_DIR") ?? join(tmpdir(), "capcomd-vms"), runId, a.agentId);
  const dir = join(root, "rpc"), bin = join(root, "bin"), home = join(root, "home");
  const pidFile = join(root, "pid"), exitFile = join(root, "exit"), out = join(root, "stdout"), err = join(root, "stderr");
  mkdirSync(bin, { recursive: true }); mkdirSync(home, { recursive: true });
  writeFileSync(join(bin, "vm-cli.mjs"), VM_CLI_SOURCE);
  writeFileSync(join(bin, "capcomd"), `#!/bin/sh\nexec node ${JSON.stringify(join(bin, "vm-cli.mjs"))} "$@"\n`);
  chmodSync(join(bin, "capcomd"), 0o755);
  // The PATH below is minimal; node may live elsewhere on the host (Homebrew, nvm): link it in.
  if (NODE_BIN !== "node" && !existsSync(join(bin, "node"))) symlinkSync(NODE_BIN, join(bin, "node"));
  const s = client().scope.getOrCreate([runId]);
  const p = pumpFor(runId, a, new LocalSpool(dir, [{ file: out, stream: "stdout" }, { file: err, stream: "stderr" }]), Number(env("SCRIPT_RPC_POLL_MS") ?? 100));
  try {
    for (let i = 0; i < 100 && !(existsSync(join(dir, "token")) && statSync(join(dir, "token")).size); i++) await new Promise((r) => setTimeout(r, 20));
    let pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
    if (!existsSync(exitFile) && !(pid && alive(pid))) {
      killpoint("script.before_start");
      const sEnv: Record<string, string> = {
        PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: home, CAPCOMD_RPC_DIR: dir, CAPCOMD_TOKEN_FILE: join(dir, "token"),
        CAPCOMD_AGENT_ID: a.agentId, CAPCOMD_RUN_ID: runId, CAPCOMD_TASK: a.task, CAPCOMD_DEPTH: String(a.depth),
        CAPCOMD_AWAIT_POLL_MS: env("SCRIPT_AWAIT_POLL_MS") ?? "150", CAPCOMD_RPC_TIMEOUT_MS: env("SCRIPT_RPC_TIMEOUT_MS") ?? "60000",
      };
      // Detached: the "VM" keeps running if this driver dies; the exit code lands in a file.
      const wrapper = `( ${script} ) > ${JSON.stringify(out)} 2> ${JSON.stringify(err)} < /dev/null; echo $? > ${JSON.stringify(exitFile)}.tmp; mv ${JSON.stringify(exitFile)}.tmp ${JSON.stringify(exitFile)}`;
      const ch = spawnProc("sh", ["-c", wrapper], { cwd: home, env: sEnv, stdio: "ignore", detached: true });
      ch.unref();
      pid = ch.pid!;
      writeFileSync(pidFile, String(pid));
    }
    // Wait for exit; cancellation propagates into the "VM" (kill its process group).
    for (;;) {
      if (existsSync(exitFile)) break;
      const cur = await s.getAgent({ agentId: a.agentId }).catch(() => null);
      if (cur?.status === "cancelled") { try { process.kill(-pid, "SIGKILL"); } catch {} return { exitCode: 137 }; }
      if (!alive(pid) && !existsSync(exitFile)) { await new Promise((r) => setTimeout(r, 300)); if (!existsSync(exitFile)) return { exitCode: 137 }; }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { exitCode: Number(readFileSync(exitFile, "utf8").trim() || 1) };
  } finally { await p.stop(); }
}
