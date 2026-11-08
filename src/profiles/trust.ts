// Trusting a project's profile skills (ADR-024 decision 4, §7 step 7): a profile in the project's `.capcomd/profiles/`
// is text the repository supplies, and a skill of it is instructions its agents follow, so an agent of it isn't spawned
// with one the operator hasn't looked at. Trust is the plugins' mechanism (src/install/trust.ts, kind `profile`): one
// SKILL.md's content hash at one place (the file, made real), kept in <capcomd home>/trust.json, which no project can
// write. A changed SKILL.md, or the same one in another checkout, needs trusting again. The hash is the sha256 the
// agent is pinned with (./skills.ts), so what was trusted is exactly what the agent gets. The user's own profiles
// (written or installed into ~/.capcomd/profiles) and their ~/.claude/skills need no trust: the user put them there.
import { recordTrust, trustState } from "../install/trust";
import type { ProfileSkill } from "./skills";

type Env = Record<string, string | undefined>;
export const PROFILE_TRUST_KIND = "profile";

/** One of a profile's skills from the project's profiles, and whether the operator trusts it as it is. */
export interface SkillTrust {
  name: string;
  /** Its SKILL.md. */
  path: string;
  /** `sha256:<hex>`, as `skills[].hash` pins one. */
  hash: string;
  trust: "trusted" | "changed" | "untrusted";
  trustedHash: string | null;
}

/** The project's skills among `skills` (a resolved profile's), each with its trust; the user's and capcomd's aren't listed. */
export function projectSkillTrust(skills: readonly ProfileSkill[], env: Env = process.env): SkillTrust[] {
  return skills.filter((s) => s.source === "project" && s.path).map((s) => {
    const hash = `sha256:${s.hash}`;
    const t = trustState(PROFILE_TRUST_KIND, s.path!, hash, env);
    return { name: s.name, path: s.path!, hash, trust: t.state, trustedHash: t.entry?.hash ?? null };
  });
}

/** Why an agent of profile `name` isn't spawned with these skills, or null when every project skill is trusted. */
export function untrustedSkillsProblem(name: string, skills: readonly ProfileSkill[], env: Env = process.env): string | null {
  const bad = projectSkillTrust(skills, env).filter((s) => s.trust !== "trusted");
  if (!bad.length) return null;
  const said = bad.map((s) => `${s.name}${s.trust === "changed" ? " (changed since you trusted it)" : ""}`).join(", ");
  return `profile ${name} can't be spawned: its project skill${bad.length > 1 ? "s" : ""} ${said} ${bad.length > 1 ? "aren't" : "isn't"} trusted`;
}

export const untrustedSkillsHint = (name: string) => `A project's profile skills go into its agents' instructions only once you have looked at them: capcomd profiles trust ${name} shows each and asks.`;

/** Trust each of the project's skills of a profile as it is now (`capcomd profiles trust <name>`). */
export function trustProfileSkills(skills: readonly ProfileSkill[], o: { by?: string; env?: Env } = {}): SkillTrust[] {
  const env = o.env ?? process.env;
  return projectSkillTrust(skills, env).map((s) => {
    if (s.trust !== "trusted") recordTrust({ kind: PROFILE_TRUST_KIND, name: s.name, dir: s.path, hash: s.hash, by: o.by ?? "operator" }, env);
    return { ...s, trust: "trusted", trustedHash: s.hash };
  });
}

/** One skill a profile's agents are pinned with, as a profile's row lists it (GET /v1/profiles, capcomd_profiles,
 *  `capcomd profiles list --json`): its name, where it came from and its hash, never its text. */
export interface SkillRow {
  name: string;
  source: ProfileSkill["source"];
  /** `sha256:<hex>`, as `skills[].hash` pins one. */
  hash: string;
  /** false: a project skill the operator hasn't trusted as it is now, so an agent of the profile is refused until they
   *  do (`capcomd profiles trust <name>`). The user's skills and capcomd's need no trust. */
  trusted: boolean;
  /** It was trusted with other content: its SKILL.md changed since. */
  changed: boolean;
}

/** A resolved profile's skills as rows, in its order, each with its trust. */
export function skillRows(skills: readonly ProfileSkill[], env: Env = process.env): SkillRow[] {
  const trust = new Map(projectSkillTrust(skills, env).map((t) => [t.name, t.trust]));
  return skills.map((s) => {
    const t = trust.get(s.name);
    return { name: s.name, source: s.source, hash: `sha256:${s.hash}`, trusted: t === undefined || t === "trusted", changed: t === "changed" };
  });
}
