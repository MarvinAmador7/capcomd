
import { mountBrand, botSvg, botTeam } from "../shared/brand.js";
import { markSvg, MENU_BAR_MARK } from "../shared/bot-avatar.js";
mountBrand();
document.querySelectorAll('[data-menumark]').forEach((el) => { el.innerHTML = markSvg(MENU_BAR_MARK, { color: '#FFFFFF' }) + '1'; });
const CHECK = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2 6.4 4.8 9 10 3" fill="none" stroke="#30D158" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
document.querySelectorAll('[data-check]').forEach((el) => { el.innerHTML = CHECK; });

// One crew for the whole page, drawn from one run id: the planner and three workers stand in the hero's slot,
// then work through the run; the reviewer joins at Review. "Draw another" redraws all of them.
const roles = ['planner', 'worker', 'worker', 'worker', 'critic', 'critic', 'lead', 'worker', 'worker', 'other'];
const crewEl = document.getElementById('crew'), runEl = document.getElementById('runid');
const clean = (s) => s.replace(/ width="\d+" height="\d+"/, '');
function drawCrew(id, again = false) {
  const team = botTeam(roles.map((role, i) => ({ seed: `${id}/${i}`, role })));
  const svg = (i, size, o = {}) => clean(botSvg({ seed: `${id}/${i}`, role: roles[i], size, traits: team[i], decorative: true, ...o }));
  crewEl.innerHTML = [0, 1, 2, 3].map((i) => `<span style="--k:${i}">${svg(i, 'full', i === 0 ? { pose: 'wave' } : {})}</span>`).join('');
  if (again) { crewEl.classList.remove('is-redrawn'); void crewEl.offsetWidth; crewEl.classList.add('is-redrawn'); }
  document.querySelectorAll('[data-crew]').forEach((el) => { el.innerHTML = svg(+el.dataset.crew, 'full', el.dataset.pose ? { pose: el.dataset.pose } : {}); });
  document.querySelectorAll('[data-xs]').forEach((el) => { el.innerHTML = svg(+el.dataset.xs, 'xs'); });
  document.querySelectorAll('[data-face]').forEach((el) => { el.innerHTML = svg(+el.dataset.face, 'small'); });
  document.querySelectorAll('[data-tile]').forEach((el) => { el.innerHTML = svg(0, 'small'); });
  document.querySelectorAll('[data-name]').forEach((el) => { el.textContent = team[+el.dataset.name].name; });
  runEl.textContent = id;
}
const rid = () => 'run_' + Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join(''); // taste-skill-ignore: hex run id
const params = new URLSearchParams(location.hash.slice(1));
drawCrew(params.get('run') || rid());
document.getElementById('redraw').addEventListener('click', () => drawCrew(rid(), true));
document.querySelectorAll('[data-mark-face]').forEach((el) => { el.innerHTML = markSvg(MENU_BAR_MARK, { color: 'currentColor' }); });

// The goal typed into the Ask panel's composer is the run's title in every later panel.
const input = document.getElementById('goal');
const setGoal = () => { const g = input.value.trim() || 'Fix the failing tests in src/'; document.querySelectorAll('[data-goal]').forEach((el) => { el.textContent = g.charAt(0).toUpperCase() + g.slice(1); }); };
input.addEventListener('input', () => { setGoal(); document.querySelectorAll('.try button').forEach((o) => o.setAttribute('aria-pressed', o.textContent === input.value)); });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
document.querySelectorAll('.try button').forEach((b) => b.addEventListener('click', () => {
  input.value = b.textContent; setGoal();
  document.querySelectorAll('.try button').forEach((o) => o.setAttribute('aria-pressed', o === b));
}));
if (params.get('goal')) { input.value = params.get('goal'); document.querySelectorAll('.try button').forEach((o) => o.setAttribute('aria-pressed', o.textContent === input.value)); }
setGoal();

// The stages: one open at a time, like a disclosure list. Arrow keys move between them, Home and End jump.
const stages = [...document.querySelectorAll('.stage')], tabs = stages.map((s) => s.querySelector('.stage__tab'));
const open = (s) => stages.forEach((o, k) => { const on = o === s; o.classList.toggle('is-open', on); tabs[k].setAttribute('aria-expanded', on); });
tabs.forEach((t, k) => {
  t.addEventListener('click', () => open(stages[k]));
  t.addEventListener('keydown', (e) => {
    const go = { ArrowRight: k + 1, ArrowDown: k + 1, ArrowLeft: k - 1, ArrowUp: k - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (go === undefined) return;
    e.preventDefault(); const n = (go + tabs.length) % tabs.length;
    const target = stages[n].classList.contains('is-open') && innerWidth > 760 ? stages[n].querySelector('textarea, .try button') || tabs[n] : tabs[n];
    target.focus();
  });
});
const want = params.get('open');
if (want) { const s = stages.find((x) => x.querySelector('h3').textContent.toLowerCase() === want); if (s) open(s); }

const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }, { rootMargin: '0px 0px -12% 0px', threshold: 0.1 });
document.querySelectorAll('[data-reveal]').forEach((el) => io.observe(el));
