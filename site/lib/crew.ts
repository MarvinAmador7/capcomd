import { botSvg, botTeam, h32, type BotTraits, type Size } from "./vendor/bot-avatar.js";

/** The page's crew, by index: the hero shows 0–3; the stages and the roles tree use the rest. */
export const CREW_ROLES = ["planner", "worker", "worker", "worker", "critic", "critic", "lead", "worker", "worker", "other"] as const;
/** The crew the static HTML is drawn with (the page draws a fresh one on each visit). */
export const DEFAULT_SEED = "run_7e9410";

export const crewTeam = (seed: string): BotTraits[] => botTeam(CREW_ROLES.map((role, i) => ({ seed: `${seed}/${i}`, role })));

export interface BotOpts { pose?: string; mood?: "happy" | "sleepy" | "oops" | "love" }
/** One crew member as an SVG string, sized by CSS (width/height attributes removed), hidden from assistive tech. */
export function crewSvg(seed: string, team: BotTraits[], i: number, size: Size, o: BotOpts = {}): string {
  return botSvg({ seed: `${seed}/${i}`, role: CREW_ROLES[i], size, traits: team[i], decorative: true, ...o }).replace(/ width="\d+" height="\d+"/, "");
}

/** The app names an agent by its profile plus a short suffix (card-spec.md); here, 4 hex digits of the seed's hash. */
export const crewSuffix = (seed: string, i: number): string => (h32(`${seed}/${i}`) >>> 0).toString(16).padStart(8, "0").slice(-4); // taste-skill-ignore: hex id

export const randomRunId = (): string =>
  "run_" + Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join(""); // taste-skill-ignore: hex run id
