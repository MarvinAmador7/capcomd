// Env snapshot naming, local ledger, and worker-side resolution.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env as envVar } from "../utils/env";
import { stateDir } from "../utils/home";
import { providerStateFile, sandboxCaps, sandboxName } from "../providers/registry";

export const ENV_PREFIX = "capcomd-env-";
export const ENV_SCHEMA = 1;

export interface EnvManifest {
  schema: number;
  /** Pinned versions requested (what installs when the image lacks a tool). */
  pins: { claude: string; codex: string; node: string };
  /** sha256 of the repo lockfile, or "none" (no repo given, or no lockfile). */
  lockHash: string;
  lockFile: string;
  /** Repo whose deps were baked in ("" when none). */
  repo: string;
  /**
   * The warm template (Docker): the commit of `target` checked out in the image with its dependencies, which agents
   * use in place (src/agents/workspace.ts). Absent for a shallow template (boxd) or when it couldn't be kept.
   */
  template?: { commit: string; target: string };
}
export interface EnvRecord {
  name: string;
  manifest: EnvManifest;
  /** Versions actually present in the snapshot, and where each came from. */
  versions: Record<string, { version: string; source: "image" | "installed" | "missing" }>;
  builtAt: string;
  buildMs: number;
  depsInstalled: boolean;
}
export interface EnvLedger { current?: EnvRecord; history: EnvRecord[] }

/** Content hash of pins + lockfile; same inputs → same snapshot name → build is skipped. */
export function envName(m: EnvManifest): string {
  // Repo is informational only: any repo with the same lockfile (or none) shares the snapshot. A warm template holds
  // the repo itself, so its repo and commit are content too (a rebuild at a newer commit is a new image).
  const canon = JSON.stringify({ schema: m.schema, pins: m.pins, lockHash: m.lockHash, ...(m.template ? { repo: m.repo, template: m.template.commit } : {}) });
  return ENV_PREFIX + createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

export function ledgerPath(source: Record<string, string | undefined> = process.env): string {
  return envVar("ENV_LEDGER", source) ?? join(stateDir(source), providerStateFile("envs.json", source));
}
export function readLedger(path = ledgerPath()): EnvLedger {
  if (!existsSync(path)) return { history: [] };
  try { const l = JSON.parse(readFileSync(path, "utf8")); return { history: [], ...l }; } catch { return { history: [] }; }
}
export function writeLedger(l: EnvLedger, path = ledgerPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(l, null, 2) + "\n");
}

// ---- project templates (src/env/templates.ts) --------------------------------------------------------------------

type Pins = EnvManifest["pins"];
/** A repository's key: the same for the URL spellings git treats as one (src/agents/workspace.ts `sameRepo`). */
export function projectKey(repo: string): string {
  const norm = repo.trim().replace(/\/+$/, "").replace(/\.git$/, "").replace(/^([a-z+]+:\/\/[^/]+)/i, (h) => h.toLowerCase());
  return createHash("sha256").update(norm).digest("hex").slice(0, 8);
}
/** The base environment a template is built on: the hash of the env build with these pins and no repository, so a
 *  template's name starts with the base env's own (`capcomd-env-<base>`). */
export const baseEnvHash = (pins: Pins) => envName({ schema: ENV_SCHEMA, pins, lockHash: "none", lockFile: "none", repo: "" }).slice(ENV_PREFIX.length);
/** `capcomd-env-<base>-<project>-<build>`: per project and base env, a new name for each build (snapshots aren't
 *  overwritten), never one of the plain env builds' names (`capcomd-env-<16 hex>`). */
export const templateName = (pins: Pins, repo: string, build: string) => `${ENV_PREFIX}${baseEnvHash(pins)}-${projectKey(repo)}-${build}`;
export const isTemplateName = (name: string) => new RegExp(`^${ENV_PREFIX}[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{8}$`).test(name);

/** A project's template: what workers on a VM provider boot from (src/env/templates.ts). */
export interface ProjectTemplate {
  project: string;
  repo: string;
  /** The snapshot. */
  name: string;
  /** The one before it (kept while agents may still boot from it; deleted by the next build). */
  previous?: string;
  /** The base env it was built on (baseEnvHash), and its pins. */
  base: string;
  pins: Pins;
  /** The default branch it was built from, its commit, and every branch's tip then (the delta is counted from these). */
  target: string;
  commit: string;
  heads: Record<string, string>;
  lockFile: string;
  lockHash: string;
  depsInstalled: boolean;
  /** The setup step it ran (null: the lockfile's install), the hosts it was allowed beyond the base list, and where the
   *  host keeps its git repos for it: what a refresh builds it with again. */
  setup: string | null;
  egress?: string[];
  hostGit?: string;
  versions: EnvRecord["versions"];
  builtAt: string;
  buildMs: number;
  /** What the build VM held when it was snapshotted (du of the template and the agent home), or the snapshot's size. */
  sizeBytes: number | null;
}
/** templates.json: one template per project, and every snapshot capcomd made as one (the only ones it ever deletes). */
export interface TemplateLedger { templates: Record<string, ProjectTemplate>; created: string[] }

export function templateLedgerPath(source: Record<string, string | undefined> = process.env): string {
  return envVar("TEMPLATE_LEDGER", source) ?? join(stateDir(source), providerStateFile("templates.json", source));
}
export function readTemplates(path = templateLedgerPath()): TemplateLedger {
  if (!existsSync(path)) return { templates: {}, created: [] };
  try { const l = JSON.parse(readFileSync(path, "utf8")); return { templates: l?.templates ?? {}, created: Array.isArray(l?.created) ? l.created : [] }; } catch { return { templates: {}, created: [] }; }
}
export function writeTemplates(l: TemplateLedger, path = templateLedgerPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(l, null, 2) + "\n");
}

/**
 * The template an agent of `repo` boots from, or why none: the place keeps templates (a VM per agent with snapshots,
 * CAPCOMD_PROJECT_TEMPLATES not off), the project has one, and it was built on the agent's CLI pins (another base env
 * means other CLIs: it is stale until rebuilt).
 */
export function projectTemplateFor(repo: string | undefined, pins: Pins | undefined, source: Record<string, string | undefined> = process.env): { name: string | null; why: "used" | "none" | "stale_base" | "not_kept" } {
  const caps = sandboxCaps(source);
  if (!repo || !pins || caps.isolation !== "vm" || !caps.snapshots || (envVar("PROJECT_TEMPLATES", source) ?? "").toLowerCase() === "off") return { name: null, why: "not_kept" };
  const t = readTemplates(templateLedgerPath(source)).templates[projectKey(repo)];
  if (!t) return { name: null, why: "none" };
  if (t.base !== baseEnvHash(pins)) return { name: null, why: "stale_base" };
  return { name: t.name, why: "used" };
}

/**
 * Which snapshot real-agent workers boot from. CAPCOMD_ENV=image forces the default image;
 * CAPCOMD_ENV_SNAPSHOT names one explicitly; then, on a place that keeps them, the project's template (`o.repo`,
 * built on `o.pins`); otherwise the ledger's current build.
 */
export function resolveEnvSnapshot(source: Record<string, string | undefined> = process.env, o: { repo?: string; pins?: Pins } = {}): string | undefined {
  if ((envVar("ENV", source) ?? "").toLowerCase() === "image") return undefined;
  const explicit = envVar("ENV_SNAPSHOT", source);
  if (explicit) return explicit;
  const t = projectTemplateFor(o.repo, o.pins, source);
  if (t.name) return t.name;
  // Lockfile mismatch only means the worker installs deps itself; CLIs + git config still apply.
  return readLedger(ledgerPath(source)).current?.name;
}

/** A profile's `sandbox.environment` the agent's sandbox can't boot from as asked: a configuration problem. */
export class EnvironmentProblem extends Error { readonly code = "environment"; }

/**
 * What an agent's machine boots from (ADR-024 `sandbox.environment`): the image its plan login is kept in, when it has
 * one (`capcomd auth login` made it from an environment, so the agent gets both), else its profile's environment on
 * `source`'s sandbox: `default` or none is the current build, as for every agent (resolveEnvSnapshot); `image` is the
 * provider's plain image; any other name is that build (`capcomd env status` lists them). A name the sandbox's ledger
 * doesn't have, and a login kept in an image of another environment, throw EnvironmentProblem. `real`: a real agent's
 * CLI needs an environment; a fake (scripted) one boots one only when its profile names it. `repo` and `pins`: the
 * run's repository and the agent's CLI pins, for its project's template (resolveEnvSnapshot).
 */
export function bootSnapshot(o: { environment?: string; real: boolean; login?: { agent: string; snapshot?: string; env: string } | null; repo?: string; pins?: Pins }, source: Record<string, string | undefined> = process.env): string | undefined {
  const named = o.environment && o.environment !== "default" ? o.environment : null;
  let snapshot: string | undefined;
  if (named && named !== "image") {
    const l = readLedger(ledgerPath(source));
    if (l.current?.name !== named && !l.history.some((h) => h.name === named)) {
      let place: string | null = null;
      try { place = sandboxName(source); } catch { /* an unknown sandbox: said where it is used */ }
      throw new EnvironmentProblem(`sandbox.environment ${named} isn't an environment of the ${place ?? "agent's"} sandbox (\`capcomd env status${place ? ` --sandbox ${place}` : ""}\` lists its builds; default is the current one, image the provider's plain image)`);
    }
    snapshot = named;
  }
  if (o.login?.snapshot) {
    if (named && snapshot !== o.login.env)
      throw new EnvironmentProblem(`the ${o.login.agent} plan login is kept in an image made from the environment ${o.login.env}, and this profile's sandbox.environment is ${named}: use environment default (or ${o.login.env}), or an API key (auth: apikey)`);
    return o.login.snapshot;
  }
  if (named) return snapshot;
  return o.real ? resolveEnvSnapshot(source, { ...(o.repo ? { repo: o.repo } : {}), ...(o.pins ? { pins: o.pins } : {}) }) : undefined;
}

/**
 * What `capcomd env build` is doing, next to its sandbox's ledger (`envs.build.json`, `envs-docker.build.json`):
 * written when a build starts (`building`, with the builder's pid), removed when it succeeds, rewritten as `failed`
 * when it throws. GET /v1/environments reads it: a `building` marker whose pid is gone (the build was killed) is stale.
 */
export interface EnvBuildMarker { state: "building" | "failed"; pid: number; startedAt: string; endedAt?: string }
/** A build marker this old is stale even when its pid is alive (the pid was reused): no build runs this long. */
export const BUILD_MARKER_MAX_MS = 3 * 60 * 60_000;
export const buildMarkerPath = (ledger: string) => `${ledger.replace(/\.json$/, "")}.build.json`;
export function readBuildMarker(path: string): EnvBuildMarker | null {
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    if ((m?.state !== "building" && m?.state !== "failed") || !Number.isInteger(m.pid) || typeof m.startedAt !== "string") return null;
    return m;
  } catch { return null; }
}
export function writeBuildMarker(path: string, m: EnvBuildMarker) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(m) + "\n");
}
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
/** Is the build this marker describes still running (its process alive, and not implausibly old)? */
export function buildInProgress(m: EnvBuildMarker | null, now = Date.now()): boolean {
  if (m?.state !== "building" || m.pid <= 0) return false;
  const t = Date.parse(m.startedAt);
  if (Number.isFinite(t) && now - t > BUILD_MARKER_MAX_MS) return false;
  return pidAlive(m.pid);
}
