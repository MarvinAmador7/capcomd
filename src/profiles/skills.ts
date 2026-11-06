// A profile's skills (ADR-024 §2.2 `skills`, §7 step 5): each one's SKILL.md, read when the profile resolves and pinned
// on the agent at spawn by its sha256 (src/primitives/ops.ts `spawnAgent`). The agent gets them at its start the way
// `send --skill` sends a message's (src/agents/skills.ts `skillBlock`), through agent.preparing, the one place skills
// and plugins' prompt text reach an agent (plugin API §6.6.7): the kernel puts them in the payload first, a plugin's
// skills follow. capcomd's own orchestration skill isn't pinned here: its text is written for each agent (limits, budget,
// goal branch) and the built-in skill-orchestration plugin attaches it to every agent that may spawn, so a profile that
// names it gets it once.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { readSkillSync, SKILL_MAX_BYTES, SKILLS_PER_MESSAGE_MAX } from "../agents/skills";
import { CONTEXT_SKILLS, contextSkills } from "../context/skills";

/** capcomd's orchestration skill (plugins/capcomd/skills/capcomd-orchestration), the only bundled one. */
export const ORCHESTRATION_SKILL_NAME = "capcomd-orchestration";

/** A skill as pinned on an agent (its spec's `skills`, plugin API §6.6.7's sources): name, origin, sha256 (hex) of its SKILL.md. */
export interface SkillPin { name: string; source: "builtin" | "project" | "user"; hash: string }
/** A profile's skill, resolved: its pin, its SKILL.md and the file it came from (null for a user skill read by name). */
export interface ProfileSkill extends SkillPin { text: string; path: string | null }

/** What an agent that may spawn keeps free for the orchestration skill it gets at preparation: one of the 8 skills, and
 *  this many of the 256 KB (its text is about 10 KB). */
const ORCHESTRATION_RESERVE_BYTES = 32 * 1024;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A resolved profile's `skills`, read: `dirs` are the package directories that may hold them, nearest first (the
 * profile's overrides, itself, then its ancestors), each with its layer. `maySpawn`: the profile's
 * `children.allowSpawn`; `hasContext`: it has a context block, whose skills the router attaches (ADR-025 step 6).
 * Errors are `<prefix>: skills[i] …`, as a profile's others are.
 */
export function profileSkills(prefix: string, list: unknown, dirs: Array<{ dir: string; layer: "project" | "user" }>, maySpawn: boolean, hasContext = false): { skills: ProfileSkill[]; errors: string[] } {
  const skills: ProfileSkill[] = [], errors: string[] = [];
  if (!Array.isArray(list)) return { skills, errors };
  const at = (i: number, m: string) => errors.push(`${prefix}: skills[${i}] ${m}`);
  list.forEach((entry, i) => {
    if (!isMap(entry) || typeof entry.name !== "string") return; // ./v2.ts checkManifest said why
    const name = entry.name, source = entry.source as string | undefined, pin = entry.hash as string | undefined;
    if (CONTEXT_SKILLS.some((s) => s.name === name)) { at(i, `(${name}): that name is capcomd's own skill, which an agent whose profile has a context block gets by itself; give yours another name`); return; }
    if (name === ORCHESTRATION_SKILL_NAME) {
      if (source !== undefined && source !== "bundled") at(i, `(${name}): that name is capcomd's own skill (source: bundled); give yours another name`);
      else if (pin !== undefined) at(i, `(${name}): capcomd writes this skill for each agent (its limits, budget and goal branch), so a hash can't pin it: remove the hash`);
      else if (!maySpawn) at(i, `(${name}): capcomd's orchestration skill goes only to an agent that may spawn (children.allowSpawn: true), which gets it by itself`);
      return; // the skill-orchestration plugin attaches it at agent.preparing
    }
    let found: { text: string; path: string | null; source: SkillPin["source"] } | null = null;
    if (source === undefined || source === "package") {
      for (const d of dirs) {
        const p = join(d.dir, "skills", name, "SKILL.md");
        if (!existsSync(p)) continue;
        let real: string;
        try { real = realpathSync(p); } catch { continue; }
        if (!real.startsWith(realpathSync(d.dir) + sep) || !statSync(real).isFile()) { at(i, `(${name}): ${p} leads outside the profile's directory`); return; }
        found = { text: readFileSync(real, "utf8"), path: p, source: d.layer };
        break;
      }
    } else if (source === "user") {
      const s = readSkillSync(name);
      if (s?.source === "user") found = { text: s.content, path: null, source: "user" };
    }
    if (!found) {
      at(i, source === "user" ? `(${name}): you have no skill named ${name} (~/.claude/skills/${name}/SKILL.md; \`capcomd skills\` lists yours)`
        : source === "bundled" ? `(${name}): capcomd bundles no skill named ${name} (only ${ORCHESTRATION_SKILL_NAME})`
        : `(${name}): ${dirs.length ? `no skills/${name}/SKILL.md in the profile's directory` : "a single-file profile has no skills/ directory (make it <name>/profile.yaml)"}${source === undefined ? `; a skill of your own (~/.claude/skills) needs source: user` : ""}`);
      return;
    }
    const bytes = Buffer.byteLength(found.text);
    if (!found.text.trim()) { at(i, `(${name}): its SKILL.md is empty`); return; }
    if (bytes > SKILL_MAX_BYTES) { at(i, `(${name}): its SKILL.md is ${bytes} bytes, over the ${SKILL_MAX_BYTES} an agent's skills may have`); return; }
    const hash = sha256(found.text);
    // Pinned in the manifest: a changed SKILL.md is never taken silently.
    if (pin !== undefined && pin !== `sha256:${hash}`) { at(i, `(${name}): its SKILL.md changed: it is sha256:${hash} now, and the profile pins ${pin}. Read it, then pin the new hash`); return; }
    skills.push({ name, source: found.source, hash, text: found.text, path: found.path });
  });
  // The context router's skills (src/context/skills.ts) for a profile with a context block: the doctrine, and the
  // routing paragraph for an agent that may spawn.
  const kept = hasContext ? contextSkills({ role: "work", maySpawn }) : [];
  const most = SKILLS_PER_MESSAGE_MAX - (maySpawn ? 1 : 0) - kept.length;
  const room = SKILL_MAX_BYTES - (maySpawn ? ORCHESTRATION_RESERVE_BYTES : 0) - kept.reduce((n, s) => n + Buffer.byteLength(s.text), 0);
  const ours = list.filter((s) => !(isMap(s) && s.name === ORCHESTRATION_SKILL_NAME)).length;
  const reasons = [...(maySpawn ? ["an agent that may spawn keeps room for capcomd's orchestration skill"] : []), ...(kept.length ? ["a profile with a context block keeps room for its context skills"] : [])];
  const why = reasons.length ? ` (${reasons.join("; ")})` : "";
  if (ours > most) errors.push(`${prefix}: skills: at most ${most} skills${why}, and it names ${ours}`);
  const total = skills.reduce((n, s) => n + Buffer.byteLength(s.text), 0);
  if (!errors.length && total > room) errors.push(`${prefix}: skills: their SKILL.md files add up to ${total} bytes, over the ${room} an agent's skills may have${why}`);
  return { skills, errors };
}

/** The skills pinned on an agent's spec at spawn (`spec.skills`); [] when there are none or the record isn't one. */
export function pinnedSkills(spec: unknown): SkillPin[] {
  const list = isMap(spec) ? spec.skills : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter((s): s is SkillPin => isMap(s) && typeof s.name === "string" && typeof s.hash === "string" && /^[0-9a-f]{64}$/.test(s.hash) && ["builtin", "project", "user"].includes(s.source as string))
    .map(({ name, source, hash }) => ({ name, source, hash }));
}
