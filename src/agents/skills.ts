// Skills an operator can attach to a message (harness.v1 GET /v1/skills, POST …/messages `skills`, `capcomd send
// --skill`): the bundled capcomd skills and the user's ~/.claude/skills/<dir>/SKILL.md. An attached skill's SKILL.md
// goes to the agent with the message, the way a spawner's orchestration skill goes with its prompt.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SkillInfo = { name: string; description: string; source: "bundled" | "user" };
/** A skill as it is sent with a message: its name and its SKILL.md. */
export type AttachedSkill = { name: string; content: string };

/** At most this many skills on one message. */
export const SKILLS_PER_MESSAGE_MAX = 8;
/** The SKILL.md files attached to one message are at most this many bytes together. */
export const SKILL_MAX_BYTES = 256 * 1024;
const NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function frontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  const out: Record<string, string> = {};
  for (const l of (m?.[1] ?? "").split("\n")) { const k = /^(name|description):\s*(.*)$/.exec(l); if (k) out[k[1]!] = k[2]!.replace(/^["']|["']$/g, ""); }
  return out;
}

/** Every skill by name (lowercase), bundled first; a user skill with a bundled skill's name is left out. */
async function registry(): Promise<Map<string, SkillInfo & { read: () => string }>> {
  const out = new Map<string, SkillInfo & { read: () => string }>();
  const { ORCHESTRATION_SKILL } = await import("../utils/assets");
  for (const md of [ORCHESTRATION_SKILL]) {
    const f = frontmatter(md);
    if (f.name) out.set(f.name.toLowerCase(), { name: f.name.toLowerCase(), description: f.description ?? "", source: "bundled", read: () => md });
  }
  const dir = join(homedir(), ".claude", "skills");
  if (existsSync(dir)) for (const d of readdirSync(dir).sort()) {
    const p = join(dir, d, "SKILL.md");
    if (!existsSync(p)) continue;
    let md: string;
    try { md = readFileSync(p, "utf8"); } catch { continue; }
    const f = frontmatter(md);
    const name = (f.name ?? d).toLowerCase();
    if (NAME.test(name) && !out.has(name)) out.set(name, { name, description: f.description ?? "", source: "user", read: () => readFileSync(p, "utf8") });
  }
  return out;
}

/** GET /v1/skills. */
export async function listSkills(): Promise<SkillInfo[]> {
  return [...(await registry()).values()].map(({ name, description, source }) => ({ name, description, source }));
}

/** One skill's SKILL.md by name; null when there is no such skill. */
export async function readSkill(name: string): Promise<AttachedSkill | null> {
  const s = (await registry()).get(name.toLowerCase());
  if (!s) return null;
  try { return { name: s.name, content: s.read() }; } catch { return null; }
}

/**
 * Check skill names a caller wants attached and read them: a plain sentence for the caller when one is unknown, too
 * big or there are too many. Duplicates are dropped (first one wins).
 */
export async function resolveSkills(names: string[], o: { read?: (name: string) => Promise<AttachedSkill | null>; listedBy?: string } = {}): Promise<{ skills: AttachedSkill[] } | { error: string }> {
  const read = o.read ?? readSkill;
  if (names.length > SKILLS_PER_MESSAGE_MAX) return { error: `At most ${SKILLS_PER_MESSAGE_MAX} skills can go with one message (got ${names.length}).` };
  const want = [...new Set(names)];
  const skills: AttachedSkill[] = [];
  let bytes = 0;
  for (const n of want) {
    const s = await read(n);
    if (!s) return { error: `There is no skill named "${n}": ${o.listedBy ?? "GET /v1/skills"} lists the skills you can attach.` };
    const b = Buffer.byteLength(s.content);
    if (b > SKILL_MAX_BYTES) return { error: `The skill "${n}" is over ${SKILL_MAX_BYTES} bytes, too big to send with a message.` };
    if ((bytes += b) > SKILL_MAX_BYTES) return { error: `These skills add up to over ${SKILL_MAX_BYTES} bytes, too much to send with one message: attach fewer.` };
    skills.push(s);
  }
  return { skills };
}

/** A message as the agent reads it: the text, then each attached skill's SKILL.md. */
export function withSkills(text: string, skills: AttachedSkill[] | null | undefined): string {
  if (!skills?.length) return text;
  const parts = skills.map((s) => `<skill name="${s.name}">\n${s.content.trim()}\n</skill>`);
  return `${text}\n\nThe sender attached ${skills.length === 1 ? "this skill" : "these skills"} to the message: read ${skills.length === 1 ? "it" : "them"} and use ${skills.length === 1 ? "it" : "them"} for this request.\n\n${parts.join("\n\n")}`;
}
