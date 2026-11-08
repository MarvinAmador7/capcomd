// Trusting a project's profile skills (ADR-024 decision 4, §7 step 7): a profile in the project's `.capcomd/profiles/`
// is text the repository supplies, and a skill of it is instructions its agents follow, so an agent of it isn't spawned
// with one the operator hasn't looked at. Trust is the plugins' mechanism (src/install/trust.ts, kind `profile`): one
// SKILL.md's content hash at one place (the file, made real), kept in <capcomd home>/trust.json, which no project can
// write. A changed SKILL.md, or the same one in another checkout, needs trusting again. The hash is the sha256 the
// agent is pinned with (./skills.ts), so what was trusted is exactly what the agent gets. The user's own profiles
// (written or installed into ~/.capcomd/profiles) and their ~/.claude/skills need no trust: the user put them there.
// A project's persona (`identity.persona`, ./persona.ts) is prompt text too, the first the agent reads, and is trusted
// the same way (decision 4): its file made real, the sha256 it is pinned with.
// A project's profile file that sets its agents' sandbox (`sandbox.provider`, and the `environment` and `size` of that
// machine) is trusted the same way too (ADR-024 §9, the owner's decision of 2026-11-08): it can send a run's agents to
// another sandbox and spend the user's credit there, so a spawn honours it only once the operator has trusted that file
// as it is (its path made real, the sha256 of its text as it was read). A run started with its own sandbox (`capcomd run
// --sandbox`, POST /v1/runs `sandbox`, `capcomd_run_new`'s) keeps every agent there, and then needs no trust for it.
import { basename, dirname } from "node:path";
import { recordTrust, trustState } from "../install/trust";
import type { MachineFile } from "./load";
import type { ProfilePersona } from "./persona";
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

/** A profile's persona from the project's profiles, and whether the operator trusts it as it is. */
export interface PersonaTrust {
  /** As the manifest names it (`SOUL.md`). */
  file: string;
  path: string;
  /** `sha256:<hex>`. */
  hash: string;
  trust: "trusted" | "changed" | "untrusted";
  trustedHash: string | null;
}

/** A resolved profile's persona with its trust when it is the project's; null for none, or the user's (no trust needed). */
export function projectPersonaTrust(persona: ProfilePersona | null | undefined, env: Env = process.env): PersonaTrust | null {
  if (!persona || persona.source !== "project") return null;
  const hash = `sha256:${persona.hash}`;
  const t = trustState(PROFILE_TRUST_KIND, persona.path, hash, env);
  return { file: persona.file, path: persona.path, hash, trust: t.state, trustedHash: t.entry?.hash ?? null };
}

/** Why an agent of profile `name` isn't spawned with these skills and persona, or null when every one of the project's
 *  is trusted as it is. */
export function untrustedProfileProblem(name: string, skills: readonly ProfileSkill[], persona: ProfilePersona | null | undefined, env: Env = process.env): string | null {
  const bad = projectSkillTrust(skills, env).filter((s) => s.trust !== "trusted");
  const p = projectPersonaTrust(persona, env), badPersona = p && p.trust !== "trusted" ? p : null;
  if (!bad.length && !badPersona) return null;
  const changed = (t: SkillTrust["trust"]) => (t === "changed" ? " (changed since you trusted it)" : "");
  const said = [
    ...(bad.length ? [`its project skill${bad.length > 1 ? "s" : ""} ${bad.map((s) => `${s.name}${changed(s.trust)}`).join(", ")}`] : []),
    ...(badPersona ? [`its project persona ${badPersona.file}${changed(badPersona.trust)}`] : []),
  ];
  return `profile ${name} can't be spawned: ${said.join(" and ")} ${bad.length + (badPersona ? 1 : 0) > 1 ? "aren't" : "isn't"} trusted`;
}

/** A profile row's `untrustedPersona` (GET /v1/profiles, capcomd_profiles, `capcomd profiles list --json`): the file of
 *  its project persona when the operator hasn't trusted it as it is, which a spawn of it waits on; null otherwise. */
export function untrustedPersona(persona: ProfilePersona | null | undefined, env: Env = process.env): string | null {
  const p = projectPersonaTrust(persona, env);
  return p && p.trust !== "trusted" ? p.file : null;
}

/** A project's profile file that sets a profile's machine (./load.ts MachineFile), and whether the operator trusts it as it is. */
export interface MachineTrust {
  /** As a message names it: `<name>.yaml`, or `<name>/profile.yaml` (`override.yaml`) in a package. */
  file: string;
  path: string;
  /** The keys it set (`sandbox.provider`, `sandbox.environment`, `sandbox.size`). */
  keys: string[];
  /** `sha256:<hex>` of its text. */
  hash: string;
  trust: "trusted" | "changed" | "untrusted";
  trustedHash: string | null;
}

/** A profile file as a message names it, never its directory on the host (the message can reach an agent). */
export const profileFileName = (path: string) => (/^(?:profile|override)\.(?:ya?ml|json)$/.test(basename(path)) ? `${basename(dirname(path))}/${basename(path)}` : basename(path));

/** The project's files among `files` (a resolved profile's machineFiles), each with its trust; the user's aren't listed. */
export function projectMachineTrust(files: readonly MachineFile[] | undefined, env: Env = process.env): MachineTrust[] {
  return (files ?? []).filter((f) => f.layer === "project").map((f) => {
    const hash = `sha256:${f.hash}`;
    const t = trustState(PROFILE_TRUST_KIND, f.path, hash, env);
    return { file: profileFileName(f.path), path: f.path, keys: [...f.keys], hash, trust: t.state, trustedHash: t.entry?.hash ?? null };
  });
}

/** A profile row's `untrustedSandbox` (GET /v1/profiles, capcomd_profiles, `capcomd profiles list --json`): the project's
 *  files that set its sandbox and that the operator hasn't trusted as they are, which a spawn of it on a run without its
 *  own sandbox waits on (only while it names a `sandbox.provider`); empty otherwise. */
export function untrustedSandbox(files: readonly MachineFile[] | undefined, sandboxProvider: string | undefined, env: Env = process.env): string[] {
  return sandboxProvider ? projectMachineTrust(files, env).filter((t) => t.trust !== "trusted").map((t) => t.file) : [];
}

/** Why an agent of profile `name` isn't sent to the sandbox its profile names (`provider`), or null when no project file
 *  sets it or every one is trusted as it is. Asked only when the run has no sandbox of its own (that one wins). */
export function untrustedSandboxProblem(name: string, provider: string | undefined, files: readonly MachineFile[] | undefined, env: Env = process.env): string | null {
  if (!provider) return null;
  const bad = projectMachineTrust(files, env).filter((t) => t.trust !== "trusted");
  if (!bad.length) return null;
  const said = bad.map((t) => `${t.file} (${t.keys.join(", ")})${t.trust === "changed" ? " changed since you trusted it" : ""}`).join(", ");
  return `profile ${name} can't be spawned: it sends its agents to the ${provider} sandbox, and the project's profile file${bad.length > 1 ? "s" : ""} that set${bad.length > 1 ? "" : "s"} that, ${said}, ${bad.length > 1 ? "aren't" : "isn't"} trusted`;
}
export const untrustedSandboxHint = (name: string) => `A project's profile moves its agents to another sandbox (and may spend your credit there) only once you have looked at it: capcomd profiles trust ${name} shows the file and asks. Or start the run with its own sandbox (capcomd run --sandbox NAME), which every agent of the run then uses.`;

export const untrustedProfileHint = (name: string) => `A project's profile skills and persona go into its agents' instructions only once you have looked at them: capcomd profiles trust ${name} shows each and asks.`;

/** Trust each of the project's skills of a profile, its persona, and the project's files that set its sandbox
 *  (`machine`), as they are now (`capcomd profiles trust <name>`). */
export function trustProfile(skills: readonly ProfileSkill[], persona: ProfilePersona | null | undefined, o: { by?: string; env?: Env; machine?: readonly MachineFile[] } = {}): { skills: SkillTrust[]; persona: PersonaTrust | null; machine: MachineTrust[] } {
  const env = o.env ?? process.env, by = o.by ?? "operator";
  const out = projectSkillTrust(skills, env).map((s): SkillTrust => {
    if (s.trust !== "trusted") recordTrust({ kind: PROFILE_TRUST_KIND, name: s.name, dir: s.path, hash: s.hash, by }, env);
    return { ...s, trust: "trusted", trustedHash: s.hash };
  });
  const p = projectPersonaTrust(persona, env);
  if (p && p.trust !== "trusted") recordTrust({ kind: PROFILE_TRUST_KIND, name: p.file, dir: p.path, hash: p.hash, by }, env);
  const machine = projectMachineTrust(o.machine, env).map((m): MachineTrust => {
    if (m.trust !== "trusted") recordTrust({ kind: PROFILE_TRUST_KIND, name: m.file, dir: m.path, hash: m.hash, by }, env);
    return { ...m, trust: "trusted", trustedHash: m.hash };
  });
  return { skills: out, persona: p ? { ...p, trust: "trusted", trustedHash: p.hash } : null, machine };
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
