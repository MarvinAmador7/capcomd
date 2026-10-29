// @capcomd/bot-avatar: a pixel bot for every agent. seed (the agent id) + role + size → a small, crisp SVG, from a
// modular parts catalog (src/catalog.ts, exported as fixtures/catalog.json). Pure functions, no I/O, no dependencies.
export * from "./types";
export { CATALOG } from "./catalog";
export { MENU_BAR_MARK, markSvg } from "./marks";
export { h32, hkey, fnv1a32, fmix32, mulberry32, rng, SEP } from "./hash";
export {
	botTraits, botName, botGrid, botSvg, botTeam, gridSvg, gridRows, withOverrides, withPart, distinct, normalizeRole, weightOf, compatible, candidates, rendezvous, tone, artFor,
	countCombinations, constrainedSlots, MOODS, TEAM_TRIES, type Mood, type Overrides, type Rendered, type SvgOptions, type AvatarInput,
} from "./engine";
