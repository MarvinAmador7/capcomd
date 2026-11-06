// `capcomd env build|status|rm`: a snapshot (a boxd snapshot, a Docker image) with the agent CLIs, git config and the
// repo's dependencies baked in, and no secrets. Workers boot from it (fromSnapshot). ADR-015. On Docker it also keeps a
// warm template: a full checkout of the project's target that each agent's container uses in place.
import type { SandboxProvider } from "../providers/sandbox";
import type { SnapshotPlatform, SnapshotInfo } from "./platform";
import type { AgentConfig } from "../agents/config";
import { BASE_EGRESS } from "../agents/config";
import { activeAdapters } from "../agents/adapters";
import { agentHome, agentPath, detectScript, installScript, parseDetect, sq, templateDir } from "../agents/runner";
import { Redactor } from "../agents/redact";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "../utils/home";
import { baseEnvHash, buildMarkerPath, ENV_PREFIX, ENV_SCHEMA, envName, ledgerPath, projectKey, readBuildMarker, readLedger, readTemplates, templateName, writeBuildMarker, writeLedger, writeTemplates, type EnvManifest, type EnvRecord, type ProjectTemplate } from "./resolve";
import { createHash } from "node:crypto";

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
  /** Where the host keeps its git repos for `repoUrl` (MergeConfig.workdir): the VM never fetches with credentials,
   *  the host does and hands it the commits (src/merge/transfer.ts). Default: <state>/host-git. */
  hostGit?: { workdir: string };
  /**
   * A project template (src/env/templates.ts; with `warm`): every branch's history, the project's `setup` step (else
   * the lockfile's install) run with the place's secret placeholders unset and their domains out of the VM's egress
   * (plus `egress`), at most `maxBytes`, named `capcomd-env-<base>-<project>-<build>` and recorded in the templates
   * ledger (`ledger`; the env ledger's current build is left alone), its build marker at `marker`.
   */
  project?: { setup: string | null; egress: string[]; maxBytes: number; marker: string; ledger: string };
}

export interface BuildResult { name: string; cached: boolean; record: EnvRecord; snapshot: SnapshotInfo }

/**
 * Build (or reuse) the agent environment. While it runs, a `building` marker next to the ledger says so (with this
 * process's pid, so a killed build reads as stale); it is removed when the build succeeds and becomes `failed` when it
 * throws (GET /v1/environments `status`). A marker another build has since taken over is left alone.
 */
export async function envBuild(p: SandboxProvider & SnapshotPlatform, o: BuildOptions): Promise<BuildResult> {
  const marker = o.project?.marker ?? buildMarkerPath(o.ledgerPath ?? ledgerPath());
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
  // A project template's setup runs the repository's own code: the VM reaches none of the domains a host-bound secret
  // is swapped in for, so a placeholder it can read is no use to it, and the setup runs without them in its env.
  const exposure = o.project ? await (await import("./templates")).secretExposure(p) : { domains: [], names: [] };
  const egress = [...new Set([...BASE_EGRESS, ...(o.project?.egress ?? [])])].filter((d) => !exposure.domains.includes(d.toLowerCase()));
  if (o.project) for (const d of [...BASE_EGRESS, ...o.project.egress]) if (exposure.domains.includes(d.toLowerCase())) log(`egress: ${d} left out of the build VM (a host-bound secret is bound to it)`);
  const release = recordJobMachine({ idemKey, sandbox: place, kind: "env_build", purpose: "env-build", ttlSeconds: 3600 });
  let id: string;
  try { ({ id } = await p.ensure({ idemKey, isolated: true, ttlSeconds: o.project ? 3 * 3600 : 3600, egressAllow: egress.length ? egress : [...BASE_EGRESS], labels: { purpose: "env-build" } })); } catch (e) { release(); throw e; }
  const sh = (s: string, timeoutMs = 120_000) => p.exec(id, ["sh", "-c", s], { env: baseEnv, timeoutMs });
  /** The repository's own code (its install or setup step), without the place's secret placeholders. */
  const untrusted = (cmd: string) => `${exposure.names.length ? `env ${exposure.names.map((n) => `-u ${sq(n)}`).join(" ")} ` : ""}sh -c ${sq(cmd)}`;
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
      // only the default branch's tree: only its node_modules is reused. Either way the host fetches it and hands it to
      // the VM (src/merge/transfer.ts): no git credential enters the VM, whose image runs the project's install next.
      const T_ = await import("../merge/transfer");
      const hostGit = { remote: o.repoUrl, workdir: o.hostGit?.workdir ?? join(stateDir(), "host-git") };
      const box = { exec: (cmd: string[], x?: { cwd?: string; timeoutMs?: number }) => p.exec(id, cmd, { env: baseEnv, ...(x?.timeoutMs ? { timeoutMs: x.timeoutMs } : {}), ...(x?.cwd ? { cwd: x.cwd } : {}) }), upload: (path: string, d: Uint8Array) => p.upload(id, path, d) };
      const fail = (e: unknown) => new Error(`env build: git clone failed: ${r.text(String((e as Error)?.message ?? e)).slice(-400)}`);
      const fallback = async () => {
        const d = await (await import("../merge/host-git")).remoteDefaultBranch(o.repoUrl!, { timeoutMs: 60_000 });
        if (!d) throw fail(`the repository ${o.repoUrl} has no default branch`);
        return d;
      };
      // A big repository's first fetch and upload take minutes: bounded by a stall, not a clock, and said as they go.
      const onProgress = (q: import("../merge/transfer").TransferProgress) => log(T_.progressLine("warm template", q));
      if (o.warm) {
        try { await T_.sendToSandbox(hostGit, box, T, { branches: "all", checkout: o.target ?? await fallback(), onProgress }, { fresh: true }); }
        catch (e) {
          if (!o.target || !(e instanceof T_.TransferError) || !/no branch /.test(e.message)) throw fail(e);
          log(`warm template: no branch ${o.target} to clone; using the repository's default branch`);
          try { await T_.sendToSandbox(hostGit, box, T, { branches: "all", checkout: await fallback(), onProgress }, { fresh: true }); } catch (e2) { throw fail(e2); }
        }
      } else {
        try { await T_.sendTree(hostGit, box, T, await fallback()); } catch (e) { throw fail(e); }
      }
      const lock = (await sh(`cd ${sq(T)} && for f in ${LOCKFILES.join(" ")}; do [ -f "$f" ] && { echo "$f $(sha256sum "$f" | cut -c1-64)"; break; }; done; true`)).stdout.trim();
      if (lock) [lockFile, lockHash] = lock.split(/\s+/) as [string, string];
      if (o.warm) {
        const head = (await sh(`cd ${sq(T)} && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD`)).stdout.trim().split("\n");
        if (/^[0-9a-f]{40}$/.test(head[0] ?? "") && head[1]) template = { commit: head[0]!, target: head[1]! };
        else log("warm template: couldn't read the clone's commit; workers will clone");
      }
    } else log("no repo given: baking CLIs + git config only (set CAPCOMD_REPO to bake deps)");
    const manifest: EnvManifest = { schema: ENV_SCHEMA, pins: { claude: o.cfg.version, codex: o.cfg.codexVersion, node: o.cfg.nodeVersion }, lockHash, lockFile, repo: o.repoUrl ?? "", ...(template ? { template } : {}) };
    // A project template: every branch's tip as built (an agent's delta is counted from them), and a name per project,
    // base env and build.
    let heads: Record<string, string> = {};
    if (o.project) {
      if (!template) throw new Error("env build: the project template has no checkout to keep");
      const refs = (await must("branches", `cd ${sq(T)} && git for-each-ref --format='%(objectname) %(refname)' refs/remotes/origin/`)).stdout;
      for (const line of refs.split("\n")) { const [sha, ref] = line.trim().split(" "); if (sha && ref && ref !== "refs/remotes/origin/HEAD") heads[ref.slice("refs/remotes/origin/".length)] = sha; }
    }
    const build = createHash("sha256").update(JSON.stringify({ commit: template?.commit, heads, lockHash, setup: o.project?.setup ?? null, ...(o.force ? { at: t0 } : {}) })).digest("hex").slice(0, 8);
    const name = o.project ? templateName(manifest.pins, o.repoUrl!, build) : envName(manifest);
    log(`content hash → ${name} (lockfile ${lockFile})`);

    const existing = await p.snapshotGet(name);
    if (o.project && existing) {
      const tl = readTemplates(o.project.ledger);
      // Never overwrite a snapshot capcomd didn't make as a template; one it made that is still there is this build.
      if (existing.status !== "ready" && !tl.created.includes(name)) throw new Error(`env build: a snapshot named ${name} exists (${existing.status}) and capcomd didn't make it; not overwriting it`);
      if (existing.status === "ready") {
        const record: EnvRecord = { name, manifest, versions: {}, builtAt: new Date().toISOString(), buildMs: 0, depsInstalled: false };
        await recordTemplate(p, o, { record, heads, template: template!, sizeBytes: existing.sizeBytes ?? null, made: false }, log);
        log(`snapshot ${name} already ready; skipping build`);
        return { name, cached: true, record, snapshot: existing };
      }
      await p.snapshotDelete(name);
    }
    if (!o.project && existing?.status === "ready" && !o.force) {
      const l = readLedger(o.ledgerPath);
      const record = l.history.find((h) => h.name === name) ?? { name, manifest, versions: {}, builtAt: new Date().toISOString(), buildMs: 0, depsInstalled: false };
      writeLedger({ current: record, history: l.history.some((h) => h.name === name) ? l.history : [...l.history, record] }, o.ledgerPath);
      log(`snapshot ${name} already ready; skipping build`);
      return { name, cached: true, record, snapshot: existing };
    }

    // 2. Detect what the image already has; install only what is missing (pinned).
    const versions: EnvRecord["versions"] = {};
    for (const a of activeAdapters()) {
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
    if (o.project?.setup) {
      // The project's own setup step (CAPCOMD_SETUP_COMMAND), as Conductor's: from the checkout, once per build. It
      // failing fails the build: the template stays what it was.
      const t = now();
      log(`setup: ${o.project.setup}`);
      const res = await sh(`cd ${sq(T)} && ${untrusted(o.project.setup)}`, 60 * 60_000);
      if (res.code !== 0) throw new Error(`env build: the setup step failed (exit ${res.code}): ${r.text(res.stderr || res.stdout).slice(-600)}`);
      depsInstalled = true;
      log(`setup: ok (${now() - t}ms)`);
      if (lockFile !== "none") await must("lockhash", `printf %s ${sq(lockHash)} > ${sq(`${T}/${TEMPLATE_LOCKHASH}`)}`);
    } else if (lockFile !== "none") {
      const pm = o.warm ? await packageManager(sh, T, lockFile, home, log) : null;
      const cmd = pm ?? defaultInstall(lockFile);
      const tool = cmd.split(" ")[0]!;
      const has = (await sh(`command -v ${tool} >/dev/null && echo yes; true`)).stdout.includes("yes");
      if (has) {
        const t = now();
        const res = await sh(`cd ${sq(T)} && ${o.project ? untrusted(cmd) : cmd}`, 900_000);
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
        if (o.project) throw new Error(`env build: the setup step changed the checkout (${dirty.split("\n").join(", ")}): agents couldn't work in it as a fresh clone (ignore what it writes in .gitignore, or write it outside the checkout)`);
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

    // 5b. A project template has a size cap (CAPCOMD_TEMPLATE_MAX_GB): what the build added, the checkout and the home.
    let sizeBytes: number | null = null;
    if (o.project) {
      const du = (await sh(`du -sk ${sq(T)} ${sq(home)} 2>/dev/null | awk '{s+=$1} END {print s}'`)).stdout.trim();
      sizeBytes = Number(du) > 0 ? Number(du) * 1024 : null;
      if (sizeBytes !== null && sizeBytes > o.project.maxBytes) throw new Error(`env build: the template is ${(sizeBytes / 1024 ** 3).toFixed(1)} GB, over the ${(o.project.maxBytes / 1024 ** 3).toFixed(0)} GB cap (CAPCOMD_TEMPLATE_MAX_GB); not snapshotting it`);
      log(`size: ${sizeBytes === null ? "unknown" : `${(sizeBytes / 1024 ** 2).toFixed(0)} MB`}`);
    }

    // 6. Snapshot (VM must be running), wait until ready.
    if (o.project) { const tl = readTemplates(o.project.ledger); writeTemplates({ ...tl, created: [...new Set([...tl.created, name])] }, o.project.ledger); }
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
    if (o.project) {
      // The cap is on what the template adds (checked above): boxd's snapshot size counts the base image too (8 GB).
      await recordTemplate(p, o, { record, heads, template: template!, sizeBytes: snap.sizeBytes ?? sizeBytes, made: true }, log);
      log(`ready: ${name} in ${record.buildMs}ms`);
      return { name, cached: false, record, snapshot: snap };
    }
    const l = readLedger(o.ledgerPath);
    writeLedger({ current: record, history: [...l.history.filter((h) => h.name !== name), record] }, o.ledgerPath);
    log(`ready: ${name} in ${record.buildMs}ms`);
    return { name, cached: false, record, snapshot: snap };
  } finally {
    if (!keep) await p.destroy(id).catch(() => {});
    release();
  }
}

/**
 * A project template built (or found ready) becomes its project's: the one it replaces is kept as `previous` (agents
 * may be booting from it right now), and the one before that is deleted, only if capcomd made it as a template.
 */
async function recordTemplate(p: SnapshotPlatform, o: BuildOptions, b: { record: EnvRecord; heads: Record<string, string>; template: NonNullable<EnvManifest["template"]>; sizeBytes: number | null; made: boolean }, log: (l: string) => void) {
  const path = o.project!.ledger;
  const l = readTemplates(path);
  const key = projectKey(o.repoUrl!);
  const old = l.templates[key];
  const m = b.record.manifest;
  const replaced = !!old && old.name !== b.record.name;
  const previous = replaced ? old!.name : old?.previous;
  const drop = replaced && old!.previous && old!.previous !== b.record.name && l.created.includes(old!.previous) ? [old!.previous] : [];
  const t: ProjectTemplate = {
    project: key, repo: o.repoUrl!, name: b.record.name, ...(previous && previous !== b.record.name ? { previous } : {}), base: baseEnvHash(m.pins), pins: m.pins,
    target: b.template.target, commit: b.template.commit, heads: b.heads, lockFile: m.lockFile, lockHash: m.lockHash, depsInstalled: b.record.depsInstalled,
    setup: o.project!.setup, ...(o.project!.egress.length ? { egress: o.project!.egress } : {}), ...(o.hostGit ? { hostGit: o.hostGit.workdir } : {}), versions: b.record.versions, builtAt: b.record.builtAt, buildMs: b.record.buildMs, sizeBytes: b.sizeBytes,
  };
  writeTemplates({ templates: { ...l.templates, [key]: t }, created: l.created.filter((n) => !drop.includes(n)) }, path);
  for (const n of drop) await p.snapshotDelete(n).then(() => log(`deleted the template before last: ${n}`), (e) => log(`couldn't delete ${n}: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
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
  // A project template removed this way is forgotten too, so no agent boots from a snapshot that is gone.
  const tl = readTemplates();
  const gone = Object.entries(tl.templates).filter(([, t]) => names.includes(t.name));
  if (gone.length) writeTemplates({ templates: Object.fromEntries(Object.entries(tl.templates).filter(([, t]) => !names.includes(t.name))), created: tl.created.filter((n) => !names.includes(n)) });
  return names;
}
