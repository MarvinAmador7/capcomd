// ADR-017 driver glue: give an agent its in-VM capcomd (token + spool pump) for as long as it runs.
//  - Real agents (allowSpawn only): VmSpool over boxd exec; the runner installs the CLI + skill.
//  - Scripted fake agents (CAPCOMD_SPAWN_EXEC=script, tests/scenarios): the contract's `script` runs
//    on this host with a scrubbed env (no host secrets, no engine endpoint) and the same CLI on a
//    LocalSpool, so scenarios exercise exactly the in-VM code path minus boxd.
import { spawn as spawnProc } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
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

export const VM_CLI_PATH = new URL("./vm-cli.mjs", import.meta.url).pathname;

function pumpFor(runId: string, a: ScopeAgent, spool: LocalSpool | VmSpool, intervalMs: number) {
  const s = client().scope.getOrCreate([runId]);
  const ttlMs = Number(env("TOKEN_TTL_MS") ?? 30 * 60_000);
  let jti: string | null = null;
  const pump = startPump({
    spool, intervalMs, refreshMs: Math.max(1000, ttlMs / 2),
    mintToken: () => { const t = mint({ run: runId, sub: a.agentId, ops: opsFor(a.limits), ttlMs }); jti = t.claims.jti; return t.token; },
    handle: async (req) => { killpoint("rpc.handle.before"); const r = await handleRpc(req, { runId, agentId: a.agentId }); killpoint("rpc.handle.after"); return r; },
    onLog: (lines) => { s.appendLog({ agentId: a.agentId, stream: "agent", lines }).catch(() => {}); },
  });
  return {
    stop: async () => {
      await pump.stop();
      // The agent is done with its token: revoke it so a copy left in the VM is dead now, not at exp.
      if (jti) await s.revokeToken({ jti, reason: `agent ${a.agentId} finished` }).catch(() => {});
    },
  };
}

/** Real agent VM: pump while `work` runs (the worker actor's pushBranch). */
export async function withVmRpc<T>(runId: string, a: ScopeAgent, provider: SandboxProvider, vmId: VmId, jsonl: string | undefined, work: () => Promise<T>): Promise<T> {
  const p = pumpFor(runId, a, new VmSpool(provider, vmId, VM_RPC_DIR, jsonl), Number(env("VM_RPC_POLL_MS") ?? 1000));
  try { return await work(); } finally { await p.stop(); }
}

export class ScriptFailed extends Error { constructor(msg: string, readonly exitCode: number) { super(msg); } }

/**
 * Scripted fake agent. Env is built from scratch: PATH (with capcomd), a private HOME, the spool,
 * and task identity. Nothing else from the host leaks in.
 */
export async function runScripted(runId: string, a: ScopeAgent): Promise<{ exitCode: number }> {
  const script = typeof a.contract?.script === "string" ? (a.contract.script as string) : `capcomd result --summary "did: ${a.task.replace(/["`$\\]/g, "")}"`;
  const root = mkdtempSync(join(tmpdir(), `capcomd-agent-${a.agentId}-`));
  const dir = join(root, "rpc"), bin = join(root, "bin"), home = join(root, "home");
  mkdirSync(bin, { recursive: true }); mkdirSync(home, { recursive: true });
  writeFileSync(join(bin, "capcomd"), `#!/bin/sh\nexec node ${JSON.stringify(VM_CLI_PATH)} "$@"\n`);
  chmodSync(join(bin, "capcomd"), 0o755);
  const spool = new LocalSpool(dir);
  const p = pumpFor(runId, a, spool, Number(env("SCRIPT_RPC_POLL_MS") ?? 100));
  // Token first, so the script's first call already carries it.
  await new Promise((r) => setTimeout(r, 0));
  const sEnv: Record<string, string> = {
    PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: home, CAPCOMD_RPC_DIR: dir, CAPCOMD_TOKEN_FILE: join(dir, "token"),
    CAPCOMD_AGENT_ID: a.agentId, CAPCOMD_RUN_ID: runId, CAPCOMD_TASK: a.task, CAPCOMD_DEPTH: String(a.depth),
    CAPCOMD_AWAIT_POLL_MS: env("SCRIPT_AWAIT_POLL_MS") ?? "150", CAPCOMD_RPC_TIMEOUT_MS: env("SCRIPT_RPC_TIMEOUT_MS") ?? "60000",
  };
  const s = client().scope.getOrCreate([runId]);
  try {
    for (let i = 0; i < 100 && !Bun.file(join(dir, "token")).size; i++) await new Promise((r) => setTimeout(r, 20));
    killpoint("script.before_start");
    const exitCode = await new Promise<number>((resolve) => {
      const ch = spawnProc("sh", ["-c", script], { cwd: home, env: sEnv, stdio: ["ignore", "pipe", "pipe"] });
      const log = (stream: string) => (b: Buffer) => { const lines = b.toString("utf8").split("\n").filter(Boolean); if (lines.length) s.appendLog({ agentId: a.agentId, stream, lines }).catch(() => {}); };
      ch.stdout.on("data", log("stdout")); ch.stderr.on("data", log("stderr"));
      // Cancellation propagates into the "VM": kill the script when the agent is cancelled.
      const watch = setInterval(async () => { const cur = await s.getAgent({ agentId: a.agentId }).catch(() => null); if (cur?.status === "cancelled") ch.kill("SIGKILL"); }, 200);
      ch.on("close", (code, sig) => { clearInterval(watch); resolve(code ?? (sig ? 137 : 1)); });
    });
    return { exitCode };
  } finally { await p.stop(); }
}
