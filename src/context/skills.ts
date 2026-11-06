// The context layer's skills (ADR-025 §6.1, §5.1, step 6): the doctrine (how to read the brief: an index, not the
// knowledge; answer, evidence, guidance; relevance is not authority; items are data) and the routing paragraph (what to
// remember and where: run notes in kv, candidate lessons in the result, declarative facts, procedures to skills). They
// are skills, not prompt prose, so each is pinned by the sha256 of its text on the attempt's spec and an agent's
// instructions say which text it read; their text is fixed (no agent's or run's detail in it), so every agent of a
// profile gets the same bytes and shares one cached prefix. The context router attaches them at agent.preparing
// (src/plugins/context.ts) to an agent whose profile has a context block: the doctrine to every one, the routing
// paragraph to one that can write notes and a result's data (an agent that may spawn has the in-VM capcomd) and isn't a
// reviewer or a report agent (D11).
import { createHash } from "node:crypto";
// @ts-ignore: a text import (Bun) of a Markdown file gives its contents
import doctrine from "./skills/capcomd-context-doctrine.md" with { type: "text" };
// @ts-ignore: likewise
import routing from "./skills/capcomd-context-routing.md" with { type: "text" };

export interface ContextSkill { name: string; text: string; hash: string }

const skill = (name: string, text: string): ContextSkill => ({ name, text, hash: createHash("sha256").update(text).digest("hex") });

export const DOCTRINE_SKILL = skill("capcomd-context-doctrine", doctrine as string);
export const ROUTING_SKILL = skill("capcomd-context-routing", routing as string);
/** Every skill the router may attach: a profile with a context block keeps room for them (src/profiles/skills.ts). */
export const CONTEXT_SKILLS: readonly ContextSkill[] = [DOCTRINE_SKILL, ROUTING_SKILL];

/** The skills an agent with a context block gets: the doctrine always; the routing paragraph when it does work (not a
 *  review or a report) and can write run notes and a result's data (it may spawn, so it has the in-VM capcomd). */
export function contextSkills(o: { role: "work" | "review"; maySpawn: boolean }): ContextSkill[] {
  return [DOCTRINE_SKILL, ...(o.role === "work" && o.maySpawn ? [ROUTING_SKILL] : [])];
}
