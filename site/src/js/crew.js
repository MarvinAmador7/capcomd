// Shared by the page script and the build (which pre-draws the default crew, so the page is complete without JS).
export const CREW_ROLES = ["planner", "worker", "worker", "worker", "critic", "critic", "lead", "worker", "worker", "other"];
export const DEFAULT_SEED = "run_7e9410";
export function crewSvg(botSvg, id, team, i, size, o = {}) {
  return botSvg({ seed: `${id}/${i}`, role: CREW_ROLES[i], size, traits: team[i], decorative: true, ...o }).replace(/ width="\d+" height="\d+"/, "");
}
/** The app names an agent by its profile plus a short suffix (card-spec.md); here, 4 hex digits of the seed's hash. */
export const crewSuffix = (h32, id, i) => (h32(`${id}/${i}`) >>> 0).toString(16).padStart(8, "0").slice(-4); // taste-skill-ignore: hex id
