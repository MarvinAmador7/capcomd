// capcomd launch site: the live crew, the run's five stages, and the entrances. The page is complete without this
// script (the build pre-draws the default crew and the stages show stacked); this adds the interaction.
import { botSvg, botTeam, h32 } from "../../../packages/bot-avatar/src/index.ts";
import { CREW_ROLES, crewSvg, crewSuffix } from "./crew.js";

const $ = (q, el = document) => el.querySelector(q);
const $$ = (q, el = document) => [...el.querySelectorAll(q)];
const params = new URLSearchParams(location.hash.slice(1));

// One crew for the whole page, drawn from one run id: the hero's slot, the stages and the roles tree.
// A fresh id on every visit (or #run=… to share one); "Draw another" redraws all of them.
const crewEl = $("#crew"), runEl = $("#runid");
function drawCrew(id, again = false) {
  const team = botTeam(CREW_ROLES.map((role, i) => ({ seed: `${id}/${i}`, role })));
  const svg = (i, size, o) => crewSvg(botSvg, id, team, i, size, o);
  crewEl.innerHTML = [0, 1, 2, 3].map((i) => `<span style="--k:${i}">${svg(i, "full", i === 0 ? { pose: "wave" } : {})}</span>`).join("");
  if (again) { crewEl.classList.remove("is-redrawn"); void crewEl.offsetWidth; crewEl.classList.add("is-redrawn"); }
  $$("[data-crew]").forEach((el) => { el.innerHTML = svg(+el.dataset.crew, "full", el.dataset.pose ? { pose: el.dataset.pose } : {}); });
  $$("[data-xs]").forEach((el) => { el.innerHTML = svg(+el.dataset.xs, "xs"); });
  $$("[data-face]").forEach((el) => { el.innerHTML = svg(+el.dataset.face, "small"); });
  $$("[data-tile]").forEach((el) => { el.innerHTML = svg(0, "small"); });
  $$("[data-name]").forEach((el) => { el.textContent = crewSuffix(h32, id, +el.dataset.name); });
  runEl.textContent = id;
}
const rid = () => "run_" + Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join(""); // taste-skill-ignore: hex run id
drawCrew(params.get("run") || rid());
const redraw = $("#redraw");
redraw.closest(".redraw-wrap").hidden = false;
redraw.addEventListener("click", () => drawCrew(rid(), true));

// The goal typed into the Ask panel's composer titles the run in every later panel.
const input = $("#goal"), tries = $$(".try button");
const press = () => tries.forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === input.value)));
const setGoal = () => { const g = input.value.trim() || "Fix the failing tests in src/"; $$("[data-goal]").forEach((el) => { el.textContent = g.charAt(0).toUpperCase() + g.slice(1); }); };
input.addEventListener("input", () => { setGoal(); press(); });
input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
tries.forEach((b) => b.addEventListener("click", () => { input.value = b.textContent; setGoal(); press(); }));
if (params.get("goal")) input.value = params.get("goal");
setGoal(); press();

// The stages: an accordion of disclosure buttons, one stage open at a time. Up/Down/Home/End move between the
// buttons (the APG accordion keys); the visual stage title repeats the button's name, so it's hidden from readers.
const stages = $$(".stage"), tabs = stages.map((s) => $(".stage__tab", s));
$$(".stage__title").forEach((t) => t.setAttribute("aria-hidden", "true"));
const open = (s) => stages.forEach((o, k) => { const on = o === s; o.classList.toggle("is-open", on); tabs[k].setAttribute("aria-expanded", String(on)); });
tabs.forEach((t, k) => {
  t.addEventListener("click", () => open(stages[k]));
  t.addEventListener("keydown", (e) => {
    const go = { ArrowDown: k + 1, ArrowRight: k + 1, ArrowUp: k - 1, ArrowLeft: k - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (go === undefined) return;
    e.preventDefault();
    tabs[(go + tabs.length) % tabs.length].focus();
  });
});
const want = params.get("open");
if (want) { const s = stages.find((x) => $(".stage__title", x).textContent.toLowerCase() === want); if (s) open(s); }

// Entrances, once per element.
const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } }, { rootMargin: "0px 0px -12% 0px", threshold: 0.05 });
$$("[data-reveal]").forEach((el) => io.observe(el));

