// ADR-024 `harness.cliVersion` (§2.2): a semver range the agent CLI of a profile's agents must satisfy. The CLI is the
// one the environment its machine boots from recorded when it was built (`capcomd env build`, ./build.ts: the version
// each CLI reported, per build, in the sandbox's ledger), so a spawn is refused before anything runs (reason
// `environment`, as a missing environment is: src/primitives/ops.ts `checkResolved`), `capcomd run` refuses a planner the
// same way before it starts the run, GET /v1/run-options says such a planner isn't ready, and `capcomd profiles
// validate` warns. An environment that recorded no version of the CLI (the sandbox's plain image, no build yet, a CLI
// whose version couldn't be read) can't be shown to satisfy the range, so the spawn is refused too, never run on a CLI
// no one checked.
import { profileFor } from "../auth/profiles";
import { agentSeam, kindOf } from "../plugins/agents";
import { bootSnapshot, EnvironmentProblem, recordedVersions } from "./resolve";

/** A version as a build records one (`2.1.3`, `0.130.0-alpha.1`). */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

export const CLI_VERSION_HINT = "Build an environment whose CLI is in that range (`capcomd env build`; CAPCOMD_CLAUDE_CODE_VERSION or CAPCOMD_CODEX_VERSION pick the version it installs), or change the profile's harness.cliVersion (`capcomd profiles show` says where it is set).";

/**
 * Why an agent of profile `name` can't run with `range` (its `harness.cliVersion`) on `source`'s sandbox, or null (no
 * range, or the environment's CLI satisfies it). `environment`: the profile's `sandbox.environment`; `auth`: its plan
 * login, kept in an image made from an environment, boots that environment (src/env/resolve.ts `bootSnapshot`). An
 * environment the sandbox doesn't have is the environment check's to say (null here).
 */
export function cliVersionProblem(o: { name: string; provider: string; auth: string; range?: string; environment?: string }, source: Record<string, string | undefined> = process.env): string | null {
  if (!o.range) return null;
  const bin = agentSeam(o.provider)?.describe().bin ?? o.provider;
  const kind = kindOf(o.provider);
  const kept = o.auth === "subscription" ? profileFor(kind, source) : undefined;
  const login = kept ? { agent: kind, ...(kept.snapshot ? { snapshot: kept.snapshot } : {}), env: kept.env } : null;
  let boots: string | undefined;
  try { boots = bootSnapshot({ environment: o.environment, real: true, login }, source); } catch (e) {
    if (e instanceof EnvironmentProblem) return null;
    throw e;
  }
  // A plan login's image has the CLI of the environment it was made from.
  const from = boots !== undefined && boots === login?.snapshot ? login.env : boots;
  const version = from ? recordedVersions(from, source)?.[bin]?.version : undefined;
  const at = from ? `the environment ${from}` : "the agent's environment (the sandbox's plain image: no capcomd env build is used)";
  if (!version || !VERSION.test(version)) return `profile ${o.name}: harness.cliVersion ${o.range} can't be checked: ${at} has no recorded ${bin} version`;
  if (!Bun.semver.satisfies(version, o.range)) return `profile ${o.name}: harness.cliVersion is ${o.range}, and the ${bin} CLI in ${at} is ${version}`;
  return null;
}
