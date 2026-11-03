// `capcomd env build|status|rm`: a snapshot (a boxd snapshot, a Docker image) with the agent CLIs, git config and the
// repo's dependencies baked in, and no secrets. Workers boot from it (fromSnapshot). ADR-015. On Docker it also keeps a
// warm template: a full checkout of the project's target that each agent's container uses in place.
import type { SandboxProvider } from "../providers/sandbox";
import type { SnapshotPlatform, SnapshotInfo } from "./platform";
import type { AgentConfig } from "../agents/config";
import { BASE_EGRESS } from "../agents/config";
import { ALL_ADAPTERS } from "../agents/adapters";
import { agentHome, agentPath, detectScript, installScript, parseDetect, sq, templateDir } from "../agents/runner";
import { Redactor } from "../agents/redact";
import { rmSync } from "node:fs";
import { buildMarkerPath, ENV_PREFIX, ENV_SCHEMA, envName, ledgerPath, readBuildMarker, readLedger, writeBuildMarker, writeLedger, type EnvManifest, type EnvRecord } from "./resolve";

import { LOCKFILES, TEMPLATE_LOCKHASH, TEMPLATE_MARKER, type TemplateMarker } from "../agents/workspace";
export { LOCKFILES };
/** The bun that installs a bun.lock project's dependencies into a warm template when the image has none (npm package). */
export const BUN_VERSION = "1.4.3";
/** Shapes that must never be in a snapshot. */
export const SECRET_SHAPES = "sk-ant-[A-Za-z0-9_-]{8,}|sk-proj-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|bxd_[A-Za-z0-9]{16,}";

/**
 * The CLI's version from an install transcript: the LAST x.y.z, because the script ends with
 * `<bin> --version` and earlier output (node download, npm) can carry other versions.
 */
export function lastVersion(text: string): string | undefined {
  return text.match(/\d+\.\d+\.\d+/g)?.at(-1);
}

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
  /**
   * Keep a warm template (Docker): a full clone of the repo's `target` with its dependencies installed, which each
   * agent's container uses in place (src/agents/workspace.ts). Off: a shallow clone, only node_modules is reused.
   */
  warm?: boolean;
  /** The branch the warm template is built from (the project's target; default: the repository's default branch). */
  target?: string;
}

export interface BuildResult { name: string; cached: boolean; record: EnvRecord; snapshot: SnapshotInfo }

/**
 * Build (or reuse) the agent environment. While it runs, a `building` marker next to the ledger says so (with this
 * process's pid, so a killed build reads as stale); it is removed when the build succeeds and becomes `failed` when it
 * throws (GET /v1/environments `status`). A marker another build has since taken over is left alone.
 */
export async function envBuild(p: SandboxProvider & SnapshotPlatform, o: BuildOptions): Promise<BuildResult> {
  const marker = buildMarkerPath(o.ledgerPath ?? ledgerPath());
  const mine = { state: "building" as const, pid: process.pid, startedAt: new Date().toISOString() };
  const ours = () => { const m = readBuildMarker(marker); return !m || (m.pid === mine.pid && m.startedAt === mine.startedAt); };
  const clear = () => { try { if (ours()) rmSync(marker, { force: true }); } catch { /* best effort */ } };
  try { writeBuildMarker(marker, mine); } catch { /* a status marker never stops a build */ }
  // Exiting mid-build (Ctrl-C handled with process.exit): no marker claims a build that isn't running.
  process.once("exit", clear);
  try {
    const res = await buildEnv(p, o);
    clear();
    return res;
  } catch (e) {
    try { if (ours()) writeBuildMarker(marker, { ...mine, state: "failed", endedAt: new Date().toISOString() }); } catch { /* best effort */ }
    throw e;
  } finally {
    process.removeListener("exit", clear);
  }
}

async function buildEnv(p: SandboxProvider & SnapshotPlatform, o: BuildOptions): Promise<BuildResult> {
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
  const idemKey = `capcomd-env-build-${t0}`;
  // capcomd's own job: recorded so the place's Machines list shows it as the environment build, not as left behind.
  const { recordJobMachine } = await import("../providers/machines");
  const { sandboxName } = await import("../providers/registry");
  let place: string | null = null;
  try { place = sandboxName(); } catch { /* unknown: recorded as such */ }
  const release = recordJobMachine({ idemKey, sandbox: place, kind: "env_build", purpose: "env-build", ttlSeconds: 3600 });
  let id: string;
  try { ({ id } = await p.ensure({ idemKey, isolated: true, ttlSeconds: 3600, egressAllow: [...BASE_EGRESS], labels: { purpose: "env-build" } })); } catch (e) { release(); throw e; }
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
    let template: EnvManifest["template"];
    if (o.repoUrl) {
      // Warm (Docker): the whole history of the target, so agents branch and rebase in it without cloning. Otherwise
      // shallow: only its node_modules is reused.
      const branch = o.warm && o.target ? ["--branch", o.target] : [];
      const cloneArgs = o.warm ? ["clone", "--no-tags", ...branch, o.repoUrl, T] : ["clone", "--depth", "1", "--no-tags", o.repoUrl, T];
      let clone = await p.exec(id, ["git", ...cloneArgs], { env: baseEnv, timeoutMs: o.warm ? 900_000 : 300_000 });
      if (clone.code !== 0 && branch.length) {
        log(`warm template: no branch ${o.target} to clone; using the repository's default branch`);
        await sh(`rm -rf ${sq(T)}`);
        clone = await p.exec(id, ["git", "clone", "--no-tags", o.repoUrl, T], { env: baseEnv, timeoutMs: 900_000 });
      }
      if (clone.code !== 0) throw new Error(`env build: git clone failed: ${r.text(clone.stderr).slice(-400)}`);
      const lock = (await sh(`cd ${sq(T)} && for f in ${LOCKFILES.join(" ")}; do [ -f "$f" ] && { echo "$f $(sha256sum "$f" | cut -c1-64)"; break; }; done; true`)).stdout.trim();
      if (lock) [lockFile, lockHash] = lock.split(/\s+/) as [string, string];
      if (o.warm) {
        const head = (await sh(`cd ${sq(T)} && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD`)).stdout.trim().split("\n");
        if (/^[0-9a-f]{40}$/.test(head[0] ?? "") && head[1]) template = { commit: head[0]!, target: head[1]! };
        else log("warm template: couldn't read the clone's commit; workers will clone");
      }
    } else log("no repo given: baking CLIs + git config only (set CAPCOMD_REPO to bake deps)");
    const manifest: EnvManifest = { schema: ENV_SCHEMA, pins: { claude: o.cfg.version, codex: o.cfg.codexVersion, node: o.cfg.nodeVersion }, lockHash, lockFile, repo: o.repoUrl ?? "", ...(template ? { template } : {}) };
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
      versions[a.bin] = { version: lastVersion(out.stdout) ?? a.pinnedVersion(o.cfg), source: "installed" };
    }
    if (!versions.node) {
      const n = lastVersion((await sh(`command -v node >/dev/null && node -v; true`)).stdout);
      versions.node = n ? { version: n, source: "installed" } : { version: "", source: "missing" };
    }

    // 3. Git identity (commits use -c too; this covers agent-run git).
    await must("git config", `git config --global user.name capcomd && git config --global user.email capcomd@users.noreply.github.com && git config --global init.defaultBranch main && git config --global advice.detachedHead false && git config --global --add safe.directory '*'`);

    // 4. Repo dependencies into the template (workers use them in place, or copy node_modules, when the lockfile
    //    matches). A warm template gets the package manager its lockfile needs when the image lacks it (pinned).
    let depsInstalled = false;
    if (lockFile !== "none") {
      const pm = o.warm ? await packageManager(sh, T, lockFile, home, log) : null;
      const cmd = pm ?? defaultInstall(lockFile);
      const tool = cmd.split(" ")[0]!;
      const has = (await sh(`command -v ${tool} >/dev/null && echo yes; true`)).stdout.includes("yes");
      if (has) {
        const t = now();
        const res = await sh(`cd ${sq(T)} && ${cmd}`, 900_000);
        depsInstalled = res.code === 0;
        log(depsInstalled ? `deps: ${cmd} ok (${now() - t}ms)` : `deps: ${cmd} failed (exit ${res.code}): ${r.text(res.stderr || res.stdout).slice(-400)}; workers will install themselves`);
      } else log(`deps: ${tool} not in image; skipped (workers install themselves)`);
      // A warm template keeps the hash in its .git, out of the working tree agents commit from.
      if (depsInstalled) await must("lockhash", `printf %s ${sq(lockHash)} > ${sq(o.warm ? `${T}/${TEMPLATE_LOCKHASH}` : `${T}/.capcomd-lockhash`)}`);
    } else log("deps: no lockfile; skipped");

    // 4b. The warm template's record: only for a clean checkout (the install changed nothing git sees), so an agent's
    //     tree in place is exactly a fresh clone's. Package manager caches go: node_modules doesn't need them.
    if (template) {
      await sh(`rm -rf ${sq(`${home}/.bun/install/cache`)} ${sq(`${home}/.cache/pnpm`)} ${sq(`${home}/.cache/yarn`)} 2>/dev/null; true`);
      if (depsInstalled) await must("exclude", `cd ${sq(T)} && grep -qx node_modules .git/info/exclude 2>/dev/null || echo node_modules >> .git/info/exclude`);
      const dirty = (await sh(`cd ${sq(T)} && git status --porcelain | head -5`)).stdout.trim();
      if (dirty) {
        log(`warm template: the dependency install changed the checkout (${dirty.split("\n").join(", ")}); workers will clone`);
        template = undefined;
        delete manifest.template;
      } else {
        const marker: TemplateMarker = { schema: 1, repo: o.repoUrl!, target: template.target, commit: template.commit, lockFile, lockHash, depsInstalled };
        await p.upload(id, `${T}/${TEMPLATE_MARKER}`, new TextEncoder().encode(JSON.stringify(marker) + "\n"));
        log(`warm template: ${template.target} at ${template.commit.slice(0, 12)}${depsInstalled ? ", dependencies installed" : ""}`);
      }
    }

    // 5. Scrub check: no credential-shaped strings or known local key values anywhere we wrote, or in env.
    await sh(`rm -f ${sq(home)}/.bash_history /root/.bash_history ${sq(T)}/.git/FETCH_HEAD 2>/dev/null; true`);
    const scan = await sh(`{ env; cat ${sq(home)}/.gitconfig 2>/dev/null; cat ${sq(T)}/.git/config ${sq(`${T}/${TEMPLATE_MARKER}`)} 2>/dev/null; } | grep -cE '${SECRET_SHAPES}'; grep -rIlE --exclude-dir=node_modules --exclude-dir=node --exclude-dir=npm --exclude-dir=.git '${SECRET_SHAPES}' ${sq(home)} 2>/dev/null | head -5; true`);
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
    release();
  }
}

type Sh = (s: string, timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A lockfile's frozen install with the package manager it names (no pin). */
export const defaultInstall = (lockFile: string) => lockFile.startsWith("bun") ? "bun install --frozen-lockfile" : lockFile === "package-lock.json" ? "npm ci --no-fund --no-audit" : lockFile === "pnpm-lock.yaml" ? "npx --yes pnpm install --frozen-lockfile" : "npx --yes yarn install --frozen-lockfile";

/** `packageManager` in package.json ("pnpm@9.12.0+sha512…"): the name and exact version, or null. */
export function pinnedManager(field: string): { name: string; version: string } | null {
  const m = /^(bun|pnpm|yarn|npm)@(\d+\.\d+\.\d+[\w.-]*)/.exec(field.trim());
  return m ? { name: m[1]!, version: m[2]! } : null;
}

/**
 * The command that installs a warm template's dependencies for its lockfile, after putting the package manager it
 * needs in the agent home when the image has none: the version the project pins (`packageManager`, `.bun-version`),
 * else CAPCOMD_BUN_VERSION or BUN_VERSION for bun. null: the default command (npm ci, or the image's own tool).
 */
export async function packageManager(sh: Sh, T: string, lockFile: string, home: string, log: (l: string) => void): Promise<string | null> {
  const out = (await sh(`cd ${sq(T)} && printf 'pm=%s\\nbv=%s\\n' "$(node -p 'try { require("./package.json").packageManager || "" } catch { "" }' 2>/dev/null)" "$(cat .bun-version 2>/dev/null)"; true`)).stdout;
  const val = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(out)?.[1]?.trim() ?? "";
  const pin = pinnedManager(val("pm"));
  if (lockFile.startsWith("bun")) {
    if ((await sh(`command -v bun >/dev/null && echo yes; true`)).stdout.includes("yes")) return null;
    const version = (pin?.name === "bun" ? pin.version : null) ?? (/^\d+\.\d+\.\d+$/.test(val("bv")) ? val("bv") : null) ?? process.env.CAPCOMD_BUN_VERSION ?? BUN_VERSION;
    log(`deps: bun not in image → installing bun@${version}`);
    const res = await sh(`NPM=$(command -v npm || echo ${sq(`${home}/node/bin/npm`)}) && "$NPM" install -g --prefix ${sq(`${home}/npm`)} --no-fund --no-audit ${sq(`bun@${version}`)} && bun --version`, 600_000);
    if (res.code !== 0) log(`deps: installing bun@${version} failed (exit ${res.code}): ${(res.stderr || res.stdout).slice(-300)}`);
    return "bun install --frozen-lockfile";
  }
  if (lockFile === "pnpm-lock.yaml" && pin?.name === "pnpm") return `npx --yes pnpm@${pin.version} install --frozen-lockfile`;
  if (lockFile === "yarn.lock" && pin?.name === "yarn") return /^1\./.test(pin.version) ? `npx --yes yarn@${pin.version} install --frozen-lockfile` : `npx --yes yarn@${pin.version} install --immutable`;
  return null;
}

export async function envStatus(p: SnapshotPlatform, ledgerPath?: string) {
  const l = readLedger(ledgerPath);
  const snaps = (await p.snapshotList()).filter((s) => s.name.startsWith(ENV_PREFIX));
  return { current: l.current, snapshots: snaps.map((s) => ({ ...s, current: s.name === l.current?.name, record: l.history.find((h) => h.name === s.name) })) };
}

/** Delete one env snapshot (or all capcomd-env-* when name is "all"). */
export async function envRm(p: SnapshotPlatform, name: string | undefined, ledgerPath?: string): Promise<string[]> {
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
