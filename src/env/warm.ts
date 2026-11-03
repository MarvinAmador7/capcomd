// Does a project on Docker have a warm checkout in its env image? `capcomd env build --sandbox docker` bakes the
// project's target, with its dependencies, into the image (the warm template), and each agent's container uses it in
// place instead of cloning and installing. Setup and capcomd_setup ask this so a person (or their agent) knows to run
// the build: the image has no template, or one of another repository, or one that drifted from the target
// (src/env/drift.ts). The build itself is never started here: it takes minutes.
import { REBUILD, templateDrift, type Drift } from "./drift";
import { readLedger, ledgerPath, type EnvRecord } from "./resolve";
import { loadMergeConfig } from "../merge/config";
import { withSandbox } from "../providers/run-sandbox";

type Env = Record<string, string | undefined>;

export type WarmState = "no-image" | "no-template" | "other-repo" | "no-repo" | Drift["state"];
export interface WarmStatus {
  state: WarmState;
  /** Agents get the warm checkout as it is (current or a few commits behind: they fetch the difference). */
  ok: boolean;
  detail: string;
  /** The command that makes (or refreshes) it; null when nothing needs doing. */
  command: string | null;
  image: string | null;
}

/** https://github.com/o/r(.git) and git@github.com:o/r.git compare equal. */
export function sameRepo(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@/, "https://").replace(/^https:\/\/[^@/]*@/, "https://").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The warm template's state for a project whose runs use Docker. `env`: the project's settings (its CAPCOMD_REPO and
 * target, e.g. from src/api/create-run.ts launchContext). `drift` (tests) replaces the fetch that compares the
 * template with the target; `timeoutMs` bounds it.
 */
export async function warmTemplateStatus(env: Env, o: { drift?: typeof templateDrift; current?: EnvRecord | null } = {}): Promise<WarmStatus> {
  const docker = withSandbox(env, "docker");
  const cur = o.current !== undefined ? o.current ?? undefined : readLedger(ledgerPath(docker)).current;
  const cfg = loadMergeConfig(docker);
  const command = REBUILD;
  if (!cfg) return { state: "no-repo", ok: false, detail: "the project names no repository (CAPCOMD_REPO), so there's nothing to warm", command: null, image: cur?.name ?? null };
  if (!cur) return { state: "no-image", ok: false, detail: `no Docker env image yet: agents start from the base image, clone ${cfg.remote} and install its dependencies themselves`, command, image: null };
  const t = cur.manifest.template;
  if (!t) return { state: "no-template", ok: false, detail: `the Docker env image ${cur.name} (built ${cur.builtAt}) has no warm checkout of this repository: each agent clones and installs it`, command, image: cur.name };
  if (!sameRepo(cur.manifest.repo, cfg.remote)) return { state: "other-repo", ok: false, detail: `the Docker env image ${cur.name} has a warm checkout of ${cur.manifest.repo || "another repository"}, not ${cfg.remote}: this project's agents clone instead`, command, image: cur.name };
  const d = await (o.drift ?? templateDrift)(cur, cfg, { timeoutMs: 15_000 }).catch(() => null);
  if (!d) return { state: "unknown", ok: true, detail: `warm checkout of ${t.target} at ${t.commit.slice(0, 12)} in ${cur.name} (couldn't compare it with ${cfg.target} now)`, command: null, image: cur.name };
  const ok = d.state === "current" || d.state === "behind" || d.state === "unknown";
  return { state: d.state, ok, detail: d.message, command: d.state === "current" ? null : command, image: cur.name };
}
