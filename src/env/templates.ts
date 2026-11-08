// Project templates: on a VM provider with snapshots (boxd), the counterpart of Docker's warm checkout. `capcomd env
// build --project` (or the first agent of a project that has none) boots a build VM from nothing secret, brings the
// project's whole history into it from the host's mirror as a bundle (src/merge/transfer.ts: no git credential enters
// the VM or the snapshot), runs the project's setup step (CAPCOMD_SETUP_COMMAND, else its lockfile's install), installs
// the agent CLIs and snapshots it as `capcomd-env-<base>-<project>-<build>`. Each agent's VM then boots from that
// snapshot and the host sends it only what changed since (a delta bundle), instead of the whole repository.
//
// A template is never waited for: an agent without a usable one boots from the base environment and clones (the full
// bundle), and the build runs in the background (scheduleTemplateBuild), as does a rebuild once the delta an agent
// received passes CAPCOMD_TEMPLATE_REBUILD_MB (default 50) or the template no longer fits (its lockfile changed, the
// target was rewritten, the agent CLIs' pins moved). Besides, sandbox-boxd's timer (the jobs service, plugin API
// §16.2) refreshes every template whose repository moved, daily (refreshTemplates), and `capcomd env build --project`
// refreshes one by hand.
import { rmSync } from "node:fs";
import type { SandboxProvider } from "../providers/sandbox";
import type { SnapshotPlatform, SnapshotInfo } from "./platform";
import type { AgentConfig, ContextBundleSpec } from "../agents/config";
import { isSecretPlatform } from "./platform";
import { env as envVar } from "../utils/env";
import { sandboxCaps } from "../providers/registry";
import { buildInProgress, buildMarkerPath, projectKey, readBuildMarker, readTemplates, templateLedgerPath, writeTemplates, type ProjectTemplate } from "./resolve";
import { OPEN_EGRESS } from "../providers/sandbox";

type Source = Record<string, string | undefined>;

/** auto (the default): templates are built and refreshed by themselves; manual: only by `capcomd env build --project`;
 *  off: never used. CAPCOMD_PROJECT_TEMPLATES. */
export type TemplateMode = "auto" | "manual" | "off";
export function templateMode(source: Source = process.env): TemplateMode {
  const v = (envVar("PROJECT_TEMPLATES", source) ?? "auto").toLowerCase();
  return v === "off" || v === "manual" ? v : "auto";
}
/** The place keeps project templates: a VM per agent, with snapshots (boxd), and templates aren't off. Docker keeps its
 *  warm checkout in the env image instead (src/env/build.ts `warm`). */
export function keepsProjectTemplates(source: Source = process.env): boolean {
  const c = sandboxCaps(source);
  return c.isolation === "vm" && c.snapshots && templateMode(source) !== "off";
}
/** The delta past which an agent's template is rebuilt (CAPCOMD_TEMPLATE_REBUILD_MB, default 50). */
export const rebuildBytes = (source: Source = process.env) => Number(envVar("TEMPLATE_REBUILD_MB", source) ?? 50) * 1024 ** 2;
/** The biggest template capcomd snapshots (CAPCOMD_TEMPLATE_MAX_GB, default 10). */
export const maxTemplateBytes = (source: Source = process.env) => Number(envVar("TEMPLATE_MAX_GB", source) ?? 10) * 1024 ** 3;
/** How long after a failed build the next one waits, unless asked for by hand (1 hour). */
export const RETRY_AFTER_MS = 60 * 60_000;

/** Where a project's build says it is running (one marker per project, next to the templates ledger). */
export const templateMarkerPath = (repo: string, source: Source = process.env) => buildMarkerPath(templateLedgerPath(source)).replace(/\.build\.json$/, `.${projectKey(repo)}.build.json`);

/**
 * What a template build may not reach and must not see: the domains of the place's host-bound secrets (boxd swaps a
 * placeholder for the real value only on its way to them), and those placeholders' names. The setup step runs the
 * repository's own code, so the build VM's egress leaves those domains out and the step runs without those variables.
 */
export async function secretExposure(p: unknown): Promise<{ domains: string[]; names: string[] }> {
  if (!isSecretPlatform(p)) return { domains: [], names: [] };
  const list = await p.secretList().catch(() => []);
  return { domains: [...new Set(list.flatMap((s) => s.domains.map((d) => d.toLowerCase())))], names: [...new Set(list.map((s) => s.name))] };
}

/** Does egress entry `allowed` (a host, `*.host`, or `*`) let a VM reach `domain` (a host or `*.host`)? Generous on
 *  purpose: it decides what a build VM must not reach. */
export function reaches(allowed: string, domain: string): boolean {
  const a = allowed.trim().toLowerCase(), d = domain.trim().toLowerCase();
  if (!a || !d) return false;
  if (a === OPEN_EGRESS) return true;
  const host = (x: string) => x.replace(/^\*\./, "");
  const under = (x: string, parent: string) => x === parent || x.endsWith(`.${parent}`);
  if (a.startsWith("*.")) return under(host(d), host(a)) || under(host(a), host(d)) && d.startsWith("*.");
  return a === d || (d.startsWith("*.") && under(a, host(d)));
}

/**
 * The build VM's egress: `base` plus the project's `extra`, less every entry that reaches a domain a host-bound secret
 * is bound to (`*`, open egress, reaches them all), and those left out. Throws when nothing is left: boxd takes an
 * empty list as unrestricted.
 */
export function buildEgress(base: string[], extra: string[], secretDomains: string[]): { allow: string[]; left: string[] } {
  const all = [...new Set([...base, ...extra].map((d) => d.trim()).filter(Boolean))];
  const left = all.filter((a) => secretDomains.some((d) => reaches(a, d)));
  const allow = all.filter((a) => !left.includes(a));
  if (!allow.length) throw new Error(`env build: every host the build VM may reach (${all.join(", ")}) is bound to a host-bound secret; nothing is left for its egress`);
  return { allow, left };
}

export interface TemplateBuildRequest {
  provider: SandboxProvider & SnapshotPlatform;
  repo: string;
  cfg: AgentConfig;
  /** The host's git repos for `repo` (MergeConfig.workdir). */
  hostGit?: { workdir: string };
  /** The project's setup step (CAPCOMD_SETUP_COMMAND), else its lockfile's install. */
  setup?: string;
  /** Hosts the setup step needs beyond capcomd's base list (CAPCOMD_SETUP_EGRESS). */
  egress?: string[];
  /** The project's mapped brains the template carries (BuildOptions.bundles; `capcomd env build --project`). */
  bundles?: ContextBundleSpec[];
  source?: Source;
  force?: boolean;
  log?: (line: string) => void;
}

/**
 * Build (or find up to date) the project's template: envBuild with a full warm checkout and the project's setup. One
 * build per project at a time: another process's build of it that is still running (its marker) refuses this one, so
 * two builds never race on one snapshot name. The local API keys (each agent's) are checked absent from the VM, as in
 * `capcomd env build`.
 */
export async function buildProjectTemplate(r: TemplateBuildRequest) {
  const { envBuild } = await import("./build");
  const source = r.source ?? process.env;
  const m = readBuildMarker(templateMarkerPath(r.repo, source));
  if (m && m.pid !== process.pid && buildInProgress(m)) throw new Error(`env build: a build of ${r.repo}'s template is already running (pid ${m.pid}, since ${m.startedAt}); wait for it`);
  const { activeAdapters } = await import("../agents/adapters");
  const forbidden = activeAdapters().map((a) => source[a.secretName]).filter((v): v is string => !!v);
  return envBuild(r.provider, {
    repoUrl: r.repo, cfg: r.cfg, force: !!r.force, ...(r.log ? { log: r.log } : {}), ...(r.hostGit ? { hostGit: r.hostGit } : {}), warm: true, forbidden, ...(r.bundles?.length ? { bundles: r.bundles } : {}),
    project: { setup: r.setup ?? null, egress: r.egress ?? [], maxBytes: maxTemplateBytes(source), marker: templateMarkerPath(r.repo, source), ledger: templateLedgerPath(source) },
  });
}

const running = new Map<string, Promise<unknown>>();

export type ScheduleResult = "started" | "running" | "retry_later" | "manual" | "off";

/** The branch a project's template was built from and its commit then (templates.json), or null without one. */
export function templateTarget(repo: string, source: Source = process.env): { target: string; commit: string } | null {
  const t = readTemplates(templateLedgerPath(source)).templates[projectKey(repo)];
  return t ? { target: t.target, commit: t.commit } : null;
}

/** `branch`'s tip on the remote (ls-remote, on the host), or null. */
async function remoteTip(repo: string, branch: string): Promise<string | null> {
  const { lsRemote } = await import("../merge/host-git");
  const l = await lsRemote(repo, ["--heads", `refs/heads/${branch}`], { timeoutMs: 60_000 });
  return l.code === 0 ? /^([0-9a-f]{40,64})\s/m.exec(l.stdout)?.[1] ?? null : null;
}

/**
 * Start the project's template build in the background unless one runs (here or in another capcomd process: its
 * marker), the last one failed less than RETRY_AFTER_MS ago, or templates are manual or off. Never waits for it.
 * `unlessTargetAt`: the template's branch and commit; when that branch is still there, a rebuild would make the same
 * template (an agent on another target, or on its own branch with another lockfile, can't use it either way), so the
 * build is skipped and said so, instead of booting a VM and sending it the whole repository for nothing.
 */
export function scheduleTemplateBuild(r: TemplateBuildRequest & { reason: string; now?: () => number; unlessTargetAt?: { target: string; commit: string } | null }): ScheduleResult {
  const source = r.source ?? process.env;
  const mode = templateMode(source);
  const say = r.log ?? ((l: string) => console.error(`[templates] ${l}`));
  if (mode === "off") return "off";
  if (mode === "manual") { say(`${r.repo}: ${r.reason}; run \`capcomd env build --project\` to refresh its template (CAPCOMD_PROJECT_TEMPLATES=manual)`); return "manual"; }
  const key = projectKey(r.repo);
  if (running.has(key)) return "running";
  const m = readBuildMarker(templateMarkerPath(r.repo, source));
  const now = (r.now ?? Date.now)();
  if (buildInProgress(m, now)) return "running";
  if (m?.state === "failed" && now - Date.parse(m.endedAt ?? m.startedAt) < RETRY_AFTER_MS) return "retry_later";
  say(`${r.repo}: building its template in the background (${r.reason})`);
  const at = r.unlessTargetAt;
  const job = (async () => {
    if (at && (await remoteTip(r.repo, at.target).catch(() => null)) === at.commit) {
      say(`${r.repo}: ${at.target} is still at ${at.commit.slice(0, 12)}, as its template was built: a rebuild would make the same one; not rebuilding`);
      return;
    }
    const res = await buildProjectTemplate({ ...r, log: (l) => say(`${r.repo}: ${l}`) });
    say(`${r.repo}: template ${res.name} ${res.cached ? "already up to date" : "ready"}`);
  })()
    .catch((e) => say(`${r.repo}: template build failed: ${String((e as Error)?.message ?? e).slice(0, 400)}`))
    .finally(() => running.delete(key));
  running.set(key, job);
  return "started";
}
/** Tests: wait for the background builds started in this process. */
export const templateBuildsSettled = () => Promise.allSettled([...running.values()]);

/**
 * After a template was used, should it be rebuilt? When the agent couldn't use it in place (cloned instead), or the
 * delta it received passed the threshold. Null: it is fine.
 */
export function rebuildReason(w: { path: "in_place" | "clone"; reason?: string; bytes: number }, source: Source = process.env): string | null {
  // A retry in the same VM finds the template used by its first attempt: nothing wrong with the template.
  if (w.path === "clone" && !/used by an earlier run/.test(w.reason ?? "")) return `an agent couldn't use it (${w.reason ?? "clone"})`;
  const limit = rebuildBytes(source);
  if (w.bytes > limit) return `an agent's delta was ${(w.bytes / 1024 ** 2).toFixed(1)} MB, over ${(limit / 1024 ** 2).toFixed(0)} MB`;
  return null;
}

export interface TemplateView {
  project: string; repo: string; name: string; target: string; commit: string; builtAt: string; ageMs: number;
  sizeBytes: number | null; status: SnapshotInfo["status"] | "missing";
  /** Commits on the target since the template's commit, and the bytes an agent would receive now (null: unknown). */
  behind: number | null; deltaBytes: number | null;
  building: boolean; lastFailure: string | null;
}

/** Every project template this place has: age, size, how far behind and how big an agent's delta is now. */
export async function templateViews(p: SnapshotPlatform, o: { source?: Source; now?: () => number; delta?: boolean; workdir?: (repo: string) => string } = {}): Promise<TemplateView[]> {
  const source = o.source ?? process.env;
  const now = (o.now ?? Date.now)();
  const out: TemplateView[] = [];
  for (const t of Object.values(readTemplates(templateLedgerPath(source)).templates)) {
    const snap = await p.snapshotGet(t.name).catch(() => null);
    const m = readBuildMarker(templateMarkerPath(t.repo, source));
    let behind: number | null = null, deltaBytes: number | null = null;
    if (o.delta !== false && o.workdir) {
      const T_ = await import("../merge/transfer");
      const d = await T_.deltaSince({ remote: t.repo, workdir: o.workdir(t.repo) }, Object.values(t.heads), t.target).catch(() => null);
      if (d) { behind = d.behind; deltaBytes = d.bytes; }
    }
    out.push({
      project: t.project, repo: t.repo, name: t.name, target: t.target, commit: t.commit, builtAt: t.builtAt, ageMs: now - Date.parse(t.builtAt),
      sizeBytes: snap?.sizeBytes ?? t.sizeBytes ?? null, status: snap?.status ?? "missing", behind, deltaBytes,
      building: buildInProgress(m, now), lastFailure: m?.state === "failed" ? m.endedAt ?? m.startedAt : null,
    });
  }
  return out;
}

/**
 * The scheduled refresh (sandbox-boxd's timer, plugin API §16.2): every project template whose repository moved since
 * it was built is rebuilt in the background, with the setup step and egress it was built with, so the next morning's
 * agents get a small delta. One that is current is left alone; a failure is its build's own (retried no sooner than
 * RETRY_AFTER_MS).
 */
export async function refreshTemplates(o: { provider: () => SandboxProvider & SnapshotPlatform; cfg: () => AgentConfig; source?: Source; log?: (l: string) => void; workdir?: string }): Promise<Array<{ repo: string; result: ScheduleResult | "current" | "unknown" }>> {
  const source = o.source ?? process.env;
  const out: Array<{ repo: string; result: ScheduleResult | "current" | "unknown" }> = [];
  const templates = Object.values(readTemplates(templateLedgerPath(source)).templates);
  if (!templates.length || templateMode(source) !== "auto") return out;
  const T_ = await import("../merge/transfer");
  for (const t of templates) {
    const workdir = t.hostGit ?? o.workdir ?? (await import("../merge/config")).loadMergeConfig({ ...source, CAPCOMD_REPO: t.repo })!.workdir;
    const d = await T_.deltaSince({ remote: t.repo, workdir }, Object.values(t.heads), t.target).catch(() => null);
    if (!d) { out.push({ repo: t.repo, result: "unknown" }); continue; }
    if (d.bytes === 0) { out.push({ repo: t.repo, result: "current" }); continue; }
    out.push({ repo: t.repo, result: scheduleTemplateBuild({ provider: o.provider(), repo: t.repo, cfg: o.cfg(), hostGit: { workdir }, ...(t.setup ? { setup: t.setup } : {}), egress: t.egress ?? [], source, ...(o.log ? { log: o.log } : {}), reason: `the scheduled refresh: ${d.behind ?? "?"} new commit(s) on ${t.target}, a ${(d.bytes / 1024 ** 2).toFixed(1)} MB delta` }) });
  }
  return out;
}

/** Forget a project's template and delete the snapshots capcomd made for it (never another name). */
export async function removeProjectTemplate(p: SnapshotPlatform, repo: string, source: Source = process.env): Promise<string[]> {
  const path = templateLedgerPath(source);
  const l = readTemplates(path);
  const key = projectKey(repo);
  const t = l.templates[key];
  if (!t) return [];
  const names = [t.name, ...(t.previous ? [t.previous] : [])].filter((n) => l.created.includes(n));
  for (const n of names) await p.snapshotDelete(n);
  delete l.templates[key];
  writeTemplates({ ...l, created: l.created.filter((n) => !names.includes(n)) }, path);
  rmSync(templateMarkerPath(repo, source), { force: true });
  return names;
}

export type { ProjectTemplate };
