// `capcomd env build|status|rm`: a boxd snapshot with the agent CLIs, git config and the repo's
// dependencies baked in, and no secrets. Workers boot from it (fromSnapshot). ADR-015.
import type { SandboxProvider } from "../providers/sandbox";
import type { EnvPlatform, SnapshotInfo } from "./platform";
import type { AgentConfig } from "../agents/config";
import { BASE_EGRESS } from "../agents/config";
import { ALL_ADAPTERS } from "../agents/adapters";
import { agentHome, agentPath, detectScript, installScript, parseDetect, sq, templateDir } from "../agents/runner";
import { Redactor } from "../agents/redact";
import { ENV_PREFIX, ENV_SCHEMA, envName, readLedger, writeLedger, type EnvManifest, type EnvRecord } from "./resolve";

export const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
/** Shapes that must never be in a snapshot. */
export const SECRET_SHAPES = "sk-ant-[A-Za-z0-9_-]{8,}|sk-proj-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|bxd_[A-Za-z0-9]{16,}";

export interface BuildOptions {
  /** Repo whose dependencies to bake in; omit for CLIs + git config only. */
  repoUrl?: string;
  cfg: AgentConfig;
  ledgerPath?: string;
  /** Rebuild even if a ready snapshot with this content hash exists. */
  force?: boolean;
  log?: (line: string) => void;
  snapshotTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Values that must not appear anywhere in the VM (local API keys); checked, never printed. */
  forbidden?: string[];
}

export interface BuildResult { name: string; cached: boolean; record: EnvRecord; snapshot: SnapshotInfo }

export async function envBuild(p: SandboxProvider & EnvPlatform, o: BuildOptions): Promise<BuildResult> {
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  const t0 = now();
  const r = new Redactor(o.forbidden ?? []);
  const home = agentHome(o.cfg);
  const T = templateDir(o.cfg);
  const baseEnv = { PATH: agentPath(home), HOME: home };
  // No repo → the name is known up front (pins + no lockfile): skip the VM when it is already built.
  if (!o.repoUrl && !o.force) {
    const manifest: EnvManifest = { schema: ENV_SCHEMA, pins: { claude: o.cfg.version, codex: o.cfg.codexVersion, node: o.cfg.nodeVersion }, lockHash: "none", lockFile: "none", repo: "" };
    const name = envName(manifest);
    const existing = await p.snapshotGet(name);
    if (existing?.status === "ready") {
      const l = readLedger(o.ledgerPath);
      const record = l.history.find((h) => h.name === name) ?? { name, manifest, versions: {}, builtAt: new Date().toISOString(), buildMs: 0, depsInstalled: false };
      writeLedger({ current: record, history: l.history.some((h) => h.name === name) ? l.history : [...l.history, record] }, o.ledgerPath);
      log(`snapshot ${name} already ready; no VM booted`);
      return { name, cached: true, record, snapshot: existing };
    }
  }
  const { id } = await p.ensure({ idemKey: `capcomd-env-build-${t0}`, isolated: true, ttlSeconds: 3600, egressAllow: [...BASE_EGRESS], labels: { purpose: "env-build" } });
  const sh = (s: string, timeoutMs = 120_000) => p.exec(id, ["sh", "-c", s], { env: baseEnv, timeoutMs });
  const must = async (what: string, s: string, timeoutMs?: number) => {
    const res = await sh(s, timeoutMs);
    if (res.code !== 0) throw new Error(`env build: ${what} failed (exit ${res.code}): ${r.text(res.stderr || res.stdout).slice(-600)}`);
    return res;
  };
  let keep = false;
  try {
    await p.waitReady(id, 120_000);
    log(`vm ${id} ready (${now() - t0}ms)`);
    await must("mkdir", `mkdir -p ${sq(home)}`);

    // 1. Repo + lockfile hash (the snapshot name depends on it).
    await must("clean template", `rm -rf ${sq(T)}`);
    let lockFile = "none", lockHash = "none";
    if (o.repoUrl) {
      const clone = await p.exec(id, ["git", "clone", "--depth", "1", "--no-tags", o.repoUrl, T], { env: baseEnv, timeoutMs: 300_000 });
      if (clone.code !== 0) throw new Error(`env build: git clone failed: ${r.text(clone.stderr).slice(-400)}`);
      const lock = (await sh(`cd ${sq(T)} && for f in ${LOCKFILES.join(" ")}; do [ -f "$f" ] && { echo "$f $(sha256sum "$f" | cut -c1-64)"; break; }; done; true`)).stdout.trim();
      if (lock) [lockFile, lockHash] = lock.split(/\s+/) as [string, string];
    } else log("no repo given: baking CLIs + git config only (set CAPCOMD_REPO to bake deps)");
    const manifest: EnvManifest = { schema: ENV_SCHEMA, pins: { claude: o.cfg.version, codex: o.cfg.codexVersion, node: o.cfg.nodeVersion }, lockHash, lockFile, repo: o.repoUrl ?? "" };
    const name = envName(manifest);
    log(`content hash → ${name} (lockfile ${lockFile})`);

    const existing = await p.snapshotGet(name);
    if (existing?.status === "ready" && !o.force) {
      const l = readLedger(o.ledgerPath);
      const record = l.history.find((h) => h.name === name) ?? { name, manifest, versions: {}, builtAt: new Date().toISOString(), buildMs: 0, depsInstalled: false };
      writeLedger({ current: record, history: l.history.some((h) => h.name === name) ? l.history : [...l.history, record] }, o.ledgerPath);
      log(`snapshot ${name} already ready; skipping build`);
      return { name, cached: true, record, snapshot: existing };
    }

    // 2. Detect what the image already has; install only what is missing (pinned).
    const versions: EnvRecord["versions"] = {};
    for (const a of ALL_ADAPTERS) {
      const det = parseDetect((await sh(detectScript(a))).stdout);
      if (det.node) versions.node = { version: det.node.replace(/^v/, ""), source: "image" };
      if (det.bin) { versions[a.bin] = { version: det.version ?? "unknown", source: "image" }; log(`${a.bin}: found ${det.version} at ${det.bin} (kept)`); continue; }
      log(`${a.bin}: missing → installing ${a.npmPackage}@${a.pinnedVersion(o.cfg)}`);
      const out = await must(`${a.bin} install`, installScript(o.cfg, home, a), 600_000);
      versions[a.bin] = { version: /\d+\.\d+\.\d+/.exec(out.stdout)?.[0] ?? a.pinnedVersion(o.cfg), source: "installed" };
    }
    if (!versions.node) {
      const n = (await sh(`command -v node >/dev/null && node -v; true`)).stdout.trim();
      versions.node = n ? { version: n.replace(/^v/, ""), source: "installed" } : { version: "", source: "missing" };
    }

    // 3. Git identity (commits use -c too; this covers agent-run git).
    await must("git config", `git config --global user.name capcomd && git config --global user.email capcomd@users.noreply.github.com && git config --global init.defaultBranch main && git config --global advice.detachedHead false && git config --global --add safe.directory '*'`);

    // 4. Repo dependencies into the template (workers copy node_modules when the lockfile matches).
    let depsInstalled = false;
    if (lockFile !== "none") {
      const cmd = lockFile.startsWith("bun") ? "bun install --frozen-lockfile" : lockFile === "package-lock.json" ? "npm ci --no-fund --no-audit" : lockFile === "pnpm-lock.yaml" ? "npx --yes pnpm install --frozen-lockfile" : "npx --yes yarn install --frozen-lockfile";
      const tool = cmd.split(" ")[0]!;
      const has = (await sh(`command -v ${tool} >/dev/null && echo yes; true`)).stdout.includes("yes");
      if (has) {
        const res = await sh(`cd ${sq(T)} && ${cmd}`, 900_000);
        depsInstalled = res.code === 0;
        log(depsInstalled ? `deps: ${cmd} ok` : `deps: ${cmd} failed (exit ${res.code}); workers will install themselves`);
      } else log(`deps: ${tool} not in image; skipped (workers install themselves)`);
      if (depsInstalled) await must("lockhash", `printf %s ${sq(lockHash)} > ${sq(`${T}/.capcomd-lockhash`)}`);
    } else log("deps: no lockfile; skipped");

    // 5. Scrub check: no credential-shaped strings or known local key values anywhere we wrote, or in env.
    await sh(`rm -f ${sq(home)}/.bash_history /root/.bash_history ${sq(T)}/.git/FETCH_HEAD 2>/dev/null; true`);
    const scan = await sh(`{ env; cat ${sq(home)}/.gitconfig 2>/dev/null; cat ${sq(T)}/.git/config 2>/dev/null; } | grep -cE '${SECRET_SHAPES}'; grep -rIlE --exclude-dir=node_modules --exclude-dir=node --exclude-dir=npm --exclude-dir=.git '${SECRET_SHAPES}' ${sq(home)} 2>/dev/null | head -5; true`);
    const hits = Number(scan.stdout.split("\n")[0]?.trim() || 0);
    const files = scan.stdout.split("\n").slice(1).filter(Boolean);
    if (hits > 0 || files.length) throw new Error(`env build: refusing to snapshot, credential-shaped data found (${hits} in env/git config${files.length ? `; files: ${files.join(", ")}` : ""})`);
    for (const v of o.forbidden ?? []) {
      if (!v || v.length < 8) continue;
      const f = await p.exec(id, ["sh", "-c", `env | grep -cF "$CAPCOMD_PROBE"; grep -rlF --exclude-dir=node_modules "$CAPCOMD_PROBE" ${sq(home)} ${sq(T)} 2>/dev/null | head -1; true`], { env: { ...baseEnv, CAPCOMD_PROBE: v } });
      // The probe itself is in this exec's env (count 1); anything more is a leak.
      if (Number(f.stdout.split("\n")[0]) > 1 || f.stdout.split("\n").slice(1).some(Boolean)) throw new Error("env build: refusing to snapshot, a local API key value is present in the VM");
    }
    log("scrub: clean");

    // 6. Snapshot (VM must be running), wait until ready.
    const created = await p.snapshotCreate(id, name);
    log(`snapshot ${name} ${created.status}`);
    const deadline = now() + (o.snapshotTimeoutMs ?? 15 * 60_000);
    let snap: SnapshotInfo | null = created;
    while (snap?.status !== "ready") {
      if (snap?.status === "failed") throw new Error(`env build: snapshot ${name} failed`);
      if (now() > deadline) { keep = false; throw new Error(`env build: snapshot ${name} not ready in time (status ${snap?.status})`); }
      await new Promise((res) => setTimeout(res, o.pollMs ?? 3000));
      snap = await p.snapshotGet(name);
    }
    const record: EnvRecord = { name, manifest, versions, builtAt: new Date().toISOString(), buildMs: now() - t0, depsInstalled };
    const l = readLedger(o.ledgerPath);
    writeLedger({ current: record, history: [...l.history.filter((h) => h.name !== name), record] }, o.ledgerPath);
    log(`ready: ${name} in ${record.buildMs}ms`);
    return { name, cached: false, record, snapshot: snap };
  } finally {
    if (!keep) await p.destroy(id).catch(() => {});
  }
}

export async function envStatus(p: EnvPlatform, ledgerPath?: string) {
  const l = readLedger(ledgerPath);
  const snaps = (await p.snapshotList()).filter((s) => s.name.startsWith(ENV_PREFIX));
  return { current: l.current, snapshots: snaps.map((s) => ({ ...s, current: s.name === l.current?.name, record: l.history.find((h) => h.name === s.name) })) };
}

/** Delete one env snapshot (or all capcomd-env-* when name is "all"). */
export async function envRm(p: EnvPlatform, name: string | undefined, ledgerPath?: string): Promise<string[]> {
  const l = readLedger(ledgerPath);
  const target = name ?? l.current?.name;
  if (!target) throw new Error("no env snapshot to remove (none built; pass a name or `all`)");
  const names = target === "all" ? (await p.snapshotList()).map((s) => s.name).filter((n) => n.startsWith(ENV_PREFIX)) : [target];
  for (const n of names) {
    if (!n.startsWith(ENV_PREFIX)) throw new Error(`refusing to delete ${n}: not a capcomd env snapshot`);
    await p.snapshotDelete(n);
  }
  writeLedger({ current: l.current && names.includes(l.current.name) ? undefined : l.current, history: l.history.filter((h) => !names.includes(h.name)) }, ledgerPath);
  return names;
}
