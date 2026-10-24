import { createHash } from "crypto";
import { readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
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
export async function runTests(git: Git, command: string, env: Record<string, string>): Promise<{ passed: boolean; output: string; where?: ChecksMode | "reused" }> {
  if (!command.trim()) return { passed: true, output: "(no test command configured)" };
  // The same tree already passed the same command (verify, then a merge onto a target that hasn't moved): its result
  // is known, so no second run, and no second checks VM. Only passes are kept; CAPCOMD_CHECKS_REUSE=0 turns it off.
  const key = process.env.CAPCOMD_CHECKS_REUSE === "0" ? null : await passKey(git, command);
  const cache = key ? await passFile(git) : null;
  const prior = key && cache ? passes(cache).get(key) : undefined;
  if (prior) return { passed: true, output: `(this tree passed \`${command}\` at ${new Date(prior.at).toISOString()}; not run again)\n${prior.output}`.slice(-4000), where: "reused" };
  let r: { passed: boolean; output: string; where: ChecksMode };
  if (checksMode() === "vm") r = { ...(await runInVm(git, command, env)), where: "vm" };
  else {
    const proc = Bun.spawn(["sh", "-c", command], { cwd: git.cwd, env: { ...hostCheckEnv(), ...env }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    r = { passed: code === 0, output: (out + err).slice(-4000), where: "host" };
  }
  if (r.passed && key && cache) recordPass(cache, key, r.output);
  return r;
}

/** Passing checks by (tree, command), in the clone's git dir: verify and merge share the run's clone (a cache: losing
 *  it only costs a re-run). */
async function passFile(git: Git): Promise<string | null> {
  const dir = (await git.run(["rev-parse", "--absolute-git-dir"])).stdout.trim();
  return dir ? join(dir, "capcomd-checks-passed.json") : null;
}
async function passKey(git: Git, command: string): Promise<string | null> {
  const tree = (await git.run(["rev-parse", "HEAD^{tree}"])).stdout.trim();
  return tree ? createHash("sha256").update(`${tree}\0${command}`).digest("hex") : null;
}
function passes(file: string): Map<string, { at: number; output: string }> {
  try { return new Map(Object.entries(JSON.parse(readFileSync(file, "utf8")))); } catch { return new Map(); }
}
function recordPass(file: string, key: string, output: string) {
  const m = passes(file);
  m.set(key, { at: Date.now(), output: output.slice(-1000) });
  const kept = [...m.entries()].slice(-500);
  try { const tmp = `${file}.${process.pid}`; writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept))); renameSync(tmp, file); } catch {}
}

/**
 * The environment a check gets on the host (fake sandboxes, or CAPCOMD_CHECKS=host): the operator's, minus what could
 * act as them: capcomd's own settings, provider and GitHub keys, anything named like a key, token, secret, password or
 * credential, git credential config and the SSH agent. Toolchain variables (PATH, HOME, BUN_INSTALL, …) stay, so
 * checks run as they would in the operator's shell. (The VM path passes only the run, task and target ids.)
 */
export function hostCheckEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const drop = /^(CAPCOMD_|RELAY_|BOXD_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|GH_|GITHUB_|GIT_CONFIG_|GIT_ASKPASS$|SSH_AUTH_SOCK$|AWS_|GOOGLE_|AZURE_|NPM_TOKEN$)|(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && !drop.test(k)) out[k] = v;
  return out;
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
