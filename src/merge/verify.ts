import type { Git } from "./git";

/**
 * Where verify's check command runs. The tree under test is agent-written code, so with real agents
 * (CAPCOMD_SANDBOX=boxd) it runs in a throwaway VM, never on the orchestrator host. Fake sandboxes
 * (tests, local dev) run it on the host. CAPCOMD_CHECKS=vm|host overrides.
 */
export type ChecksMode = "vm" | "host";
export function checksMode(source: Record<string, string | undefined> = process.env): ChecksMode {
  const m = (source.CAPCOMD_CHECKS ?? "").toLowerCase();
  if (m === "vm" || m === "host") return m;
  return (source.CAPCOMD_SANDBOX ?? source.RELAY_SANDBOX ?? "fake") === "boxd" ? "vm" : "host";
}

/** Run the repo's test command in the merged worktree. No command configured = pass (reported). */
export async function runTests(git: Git, command: string, env: Record<string, string>): Promise<{ passed: boolean; output: string; where?: ChecksMode }> {
  if (!command.trim()) return { passed: true, output: "(no test command configured)" };
  if (checksMode() === "vm") return { ...(await runInVm(git, command, env)), where: "vm" };
  const proc = Bun.spawn(["sh", "-c", command], { cwd: git.cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { passed: code === 0, output: (out + err).slice(-4000), where: "host" };
}

const CHECKS_TIMEOUT_MS = () => Number(process.env.CAPCOMD_CHECKS_TIMEOUT_MS ?? 20 * 60_000);

/**
 * The VM path: a fresh VM from the env snapshot (CLIs and baked deps, no credentials: never an auth
 * snapshot), only the package registries as egress, the exact tree under test (`git archive` of HEAD,
 * no .git), deps reused from the snapshot when the lockfile matches (else installed), the command with
 * only the run/task/target ids in its env, and the VM always destroyed.
 */
async function runInVm(git: Git, command: string, env: Record<string, string>): Promise<{ passed: boolean; output: string }> {
  const { getDependencies } = await import("../dependencies");
  const { loadAgentConfig, BASE_EGRESS } = await import("../agents/config");
  const { agentHome, agentPath, templateDir, sq } = await import("../agents/runner");
  const { resolveEnvSnapshot } = await import("../env/resolve");
  const provider = getDependencies().provider;
  const cfg = loadAgentConfig({ ...process.env, CAPCOMD_CREDENTIALS: "auto", CAPCOMD_AGENT: "fake" });
  const home = agentHome(cfg);
  const tree = (await git.ok(["rev-parse", "HEAD^{tree}"])).trim();
  const W = `${cfg.workdir}/checks-${tree.slice(0, 12)}`;
  const snap = resolveEnvSnapshot();
  const { id } = await provider.ensure({
    idemKey: `capcomd-checks-${env.CAPCOMD_RUN_ID ?? "run"}-${env.CAPCOMD_TASK_ID ?? "task"}-${tree.slice(0, 12)}-${Date.now().toString(36)}`,
    isolated: true, ttlSeconds: 3600, egressAllow: [...BASE_EGRESS], labels: { purpose: "checks", ...(env.CAPCOMD_RUN_ID ? { run: env.CAPCOMD_RUN_ID } : {}) },
    ...(snap ? { fromSnapshot: snap } : {}),
  });
  const sh = (script: string, timeoutMs = 300_000) => provider.exec(id, ["sh", "-c", script], { env: { PATH: agentPath(home), HOME: home }, timeoutMs });
  try {
    await provider.waitReady(id, 120_000);
    const archive = Bun.spawn(["git", "archive", "--format=tar", "HEAD"], { cwd: git.cwd, stdout: "pipe", stderr: "pipe" });
    const [tar, archiveErr, code] = await Promise.all([new Response(archive.stdout).arrayBuffer(), new Response(archive.stderr).text(), archive.exited]);
    if (code !== 0) return { passed: false, output: `checks VM: git archive failed: ${archiveErr.slice(-500)}` };
    await provider.upload(id, `${W}.tar`, new Uint8Array(tar));
    const unpack = await sh(`rm -rf ${sq(W)} && mkdir -p ${sq(W)} && tar -xf ${sq(`${W}.tar`)} -C ${sq(W)} && rm -f ${sq(`${W}.tar`)}`);
    if (unpack.code !== 0) return { passed: false, output: `checks VM: unpacking the tree failed: ${(unpack.stderr || unpack.stdout).slice(-500)}` };
    // Deps: the snapshot's node_modules when the lockfile matches; else a frozen install.
    const T = templateDir(cfg);
    const deps = await sh(`cd ${sq(W)} || exit 1
L=; F=; for f in bun.lock bun.lockb package-lock.json pnpm-lock.yaml yarn.lock; do [ -f "$f" ] && { F=$f; L=$(sha256sum "$f" | cut -c1-64); break; }; done
if [ -z "$F" ]; then echo "deps: none"; exit 0; fi
if [ -d ${sq(T)}/node_modules ] && [ "$(cat ${sq(T)}/.capcomd-lockhash 2>/dev/null)" = "$L" ]; then cp -a ${sq(T)}/node_modules node_modules && echo "deps: reused"; exit 0; fi
case "$F" in bun.lock*) bun install --frozen-lockfile;; package-lock.json) npm ci --no-fund --no-audit;; pnpm-lock.yaml) npx --yes pnpm install --frozen-lockfile;; *) npx --yes yarn install --frozen-lockfile;; esac`, 900_000);
    if (deps.code !== 0) return { passed: false, output: `checks VM: installing dependencies failed (exit ${deps.code}): ${(deps.stdout + deps.stderr).slice(-1500)}` };
    const ids = Object.entries(env).map(([k, v]) => `${k}=${sq(v)}`).join(" ");
    const run = await sh(`cd ${sq(W)} && env ${ids} sh -c ${sq(command)}`, CHECKS_TIMEOUT_MS());
    return { passed: run.code === 0, output: (run.stdout + run.stderr).slice(-4000) };
  } finally {
    await provider.destroy(id).catch(() => {});
  }
}
