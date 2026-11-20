// Crew screen mockups (ADR-024 §5, step 6). DRAFT: awaiting the owner's approval; build nothing from them until then.
// Writes crew-list.html, crew-detail.html and crew-untrusted.html in design/; render each with tools/render.sh.
// Run from apps/menubar/design:  bun tools/gencrew.ts && tools/render.sh crew-list 620 830 && tools/render.sh crew-detail 560 1482 && tools/render.sh crew-untrusted 560 1212
//
// The visual language is the approved Settings window's (settings/*.dc.html, settings-spec.md): 620 pt window, the
// toolbar tabs, grouped rows (13 pt label, 11 pt sub, 10 pt group corners), system controls and colours. The detail is
// a sheet like a place's Details… (settings/CloudExplore.dc.html, 560 pt, Done at the bottom right). The faces are
// the catalog bots from packages/bot-avatar (brand/README.md: avatars wherever an agent is named), seeded by the
// profile's name (or its identity.avatar.seed) and made distinct with botTeam, as the brand sheets are.
// Sample data: the profiles `capcomd setup project` writes for a Claude + Codex project (src/config/project-setup.ts
// planProject), with the worker's model set to claude-sonnet-5-5 and the planner's to claude-opus-5-5 by the team;
// every `fit` sentence is what src/profiles/describe.ts fitText returns for those specs.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { botGrid, botTeam, gridSvg, type BotTraits, type Size } from "../../../../packages/bot-avatar/src/index";

const DESIGN = join(import.meta.dir, "..");
const write = (f: string, html: string) => { writeFileSync(join(DESIGN, f), html); console.log(f); };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---- the crew ------------------------------------------------------------------------------------------------------

type Status = "ready" | "login" | "trust";
interface Crew {
	name: string; role: string; title?: string; tags: string[]; provider: "claude" | "codex"; cost: "low" | "medium" | "high" | null;
	fit: string; status: Status; isDefault?: boolean; trusted?: boolean;
}
const CREW: Crew[] = [
	{ name: "planner", role: "planner", tags: ["plan"], provider: "claude", cost: "high", status: "ready",
		fit: "orchestrates: sees everything, runs nothing; Claude Code, claude-opus-5-5, high effort, high cost; leads any number of worker or codex-worker or lead or context-consolidator helpers, any depth" },
	{ name: "lead", role: "lead", tags: [], provider: "claude", cost: "medium", status: "ready",
		fit: "orchestrates: sees everything, runs nothing; Claude Code, claude-sonnet-5-5, medium cost; leads up to 3 worker or codex-worker helpers, one level" },
	{ name: "worker", role: "worker", tags: [], provider: "claude", cost: "medium", status: "ready", isDefault: true,
		fit: "edits and runs code; Claude Code, claude-sonnet-5-5, medium cost; can't spawn" },
	{ name: "codex-worker", role: "worker", tags: [], provider: "codex", cost: null, status: "login",
		fit: "edits and runs code; Codex, the CLI's default model; can't spawn" },
	{ name: "reviewer", role: "critic", tags: ["review"], provider: "claude", cost: "medium", status: "ready", trusted: true,
		fit: "read-only; answers with a report (spawn it with report); Claude Code, claude-sonnet-5-5, high effort, medium cost; up to 40 turns; can't spawn" },
	{ name: "context-consolidator", role: "other", tags: [], provider: "claude", cost: null, status: "ready",
		fit: "read-only; Claude Code, the CLI's default model; can't spawn" },
	{ name: "security-critic", role: "critic", title: "Security critic", tags: ["review", "security", "read-only"], provider: "claude", cost: "high", status: "trust",
		fit: "read-only; answers with a report (spawn it with report); Claude Code, claude-opus-5-5, high effort, high cost; up to 40 turns; network limited to 2 hosts; can't spawn" },
];
const TEAM = botTeam(CREW.map((c) => ({ seed: c.name, role: c.role })));
const traitsOf = (name: string) => TEAM[CREW.findIndex((c) => c.name === name)]!;
const bot = (t: BotTraits, size: Size, scale = 1) =>
	`<span class="av" title="${esc(t.name)}">${gridSvg(botGrid(t, size), { scale, label: `${t.name}, ${t.role}`, decorative: true })}</span>`;

// ---- shared pieces -------------------------------------------------------------------------------------------------

const CLAUDE = `<svg width="13" height="13" viewBox="0 0 24 24" aria-label="Claude Code" role="img"><path fill="#d97757" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"></path></svg>`;
const CODEX = `<svg width="13" height="13" viewBox="0 0 24 24" aria-label="Codex" role="img"><g fill="#d1d1d6"><circle cx="12" cy="12" r="10.5" opacity=".28"></circle><path d="M12 5.2 17.9 8.6v6.8L12 18.8 6.1 15.4V8.6z"></path></g></svg>`;
const CHEV = `<svg width="9" height="12" viewBox="0 0 9 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m1.5 4.2 3-2.7 3 2.7"></path><path d="m1.5 7.8 3 2.7 3-2.7"></path></svg>`;
const FOLDER = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2h8.8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"></path></svg>`;
const PERSON = `<svg width="15" height="13" viewBox="0 0 24 21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="6" r="4"></circle><path d="M3.5 19.5c1.4-3.8 4.7-5.6 8.5-5.6s7.1 1.8 8.5 5.6"></path></svg>`;
/** Source chips (which file sets a row): arrow = inherited, plain = the profile's own file, ring = an override. */
const UP = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 6.5 1.5 1.5"></path><path d="M1.5 5V1.5H5"></path></svg>`;
const src = {
	inh: (from: string) => `<span class="src" title="Inherited from ${from} (it extends ${from}); change it here to set it in this profile's own file">${UP}${from}</span>`,
	own: `<span class="src own" title="Set in this profile's own file">this profile</span>`,
	ovr: (layer: string) => `<span class="src ovr" title="Set by an override.yaml laid over it; change it there">override · ${layer}</span>`,
	def: `<span class="src def" title="Not set by any file: capcomd's or the agent's default">default</span>`,
};
const costMark = (c: Crew["cost"]) => {
	if (!c) return `<span class="cost none" title="Cost unknown: the model is the CLI's default">–</span>`;
	const n = { low: 1, medium: 2, high: 3 }[c];
	return `<span class="cost" title="${c[0]!.toUpperCase() + c.slice(1)} cost: the model's list price, relative to its provider's others">${[1, 2, 3].map((i) => `<b${i > n ? ` class="off"` : ""}>$</b>`).join("")}</span>`;
};

const CSS = `
body{margin:0;background:#141415}
a{color:#4ea1ff}a:hover{color:#7cb9ff}
.win{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;color:#f5f5f7;-webkit-font-smoothing:antialiased;letter-spacing:-0.08px}
.bar{background:#2b2b2d;border-bottom:0.5px solid #000;padding:10px 12px 8px;position:relative}
.lights{position:absolute;left:14px;top:14px;display:flex;gap:8px}
.light{width:12px;height:12px;border-radius:50%;box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.25)}
.wtitle{text-align:center;font-size:13px;font-weight:600;color:#e5e5e7;height:20px;line-height:20px}
.tabs{display:flex;justify-content:center;gap:2px;margin-top:4px}
.tab{display:flex;flex-direction:column;align-items:center;gap:2px;width:68px;padding:5px 0 4px;border-radius:8px;color:#a1a1a6;font:inherit;font-size:11px;background:none;border:0}
.tab.on{background:rgba(255,255,255,.1);color:#4ea1ff}
.body{padding:20px 24px 24px;display:flex;flex-direction:column;gap:22px}
.sec{display:flex;flex-direction:column;gap:6px}
.sh{font-size:13px;font-weight:600;padding:0 2px;display:flex;align-items:center;gap:6px}
.grp{background:rgba(255,255,255,.05);border:0.5px solid rgba(255,255,255,.09);border-radius:10px}
.grp.ask{box-shadow:0 0 0 1px rgba(255,159,10,.6);border-color:transparent}
.row{display:flex;align-items:center;gap:12px;min-height:40px;padding:7px 12px;box-sizing:border-box}
.row + .row,.row + .crow,.crow + .row,.crow + .crow{border-top:0.5px solid rgba(255,255,255,.08)}
.lbl{flex:1;font-size:13px;display:flex;flex-direction:column;gap:2px;min-width:0}
.sub{font-size:11px;color:#98989d;line-height:1.35}
.foot{font-size:11px;color:#98989d;padding:0 2px;line-height:1.4}
.val{font-size:13px;color:#98989d;display:flex;align-items:center;gap:6px;flex:none}
.btn{height:22px;padding:0 10px;border-radius:6px;background:rgba(255,255,255,.13);border:0;box-shadow:0 0.5px 0 rgba(255,255,255,.08) inset;color:#f5f5f7;font:inherit;font-size:13px;flex:none;white-space:nowrap}
.btn.pri{background:#0a84ff;color:#fff}
.pop{height:22px;padding:0 5px 0 9px;border-radius:6px;background:rgba(255,255,255,.13);border:0;color:#f5f5f7;font:inherit;font-size:13px;display:flex;align-items:center;gap:6px;flex:none}
.badge{font-size:11px;font-weight:500;color:#4ea1ff;background:rgba(10,132,255,.16);border-radius:5px;padding:2px 7px;flex:none}
.badge.gray{color:#c7c7cc;background:rgba(255,255,255,.1)}
.badge.orange{color:#ffb340;background:rgba(255,159,10,.16)}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.empty{width:8px;height:8px;border-radius:50%;flex:none;box-shadow:inset 0 0 0 1.2px #8e8e93}
.mono{font-family:ui-monospace,"SF Mono",Menlo,monospace}
.tog{width:38px;height:22px;border-radius:11px;background:rgba(255,255,255,.18);position:relative;border:0;padding:0;flex:none}
.tog.on{background:#0a84ff}
.knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35)}
.tog.on .knob{left:18px}
.av{display:block;flex:none;line-height:0}.av svg{display:block}
/* crew rows: face, name line with the meta on the right, then the daemon's fit sentence under both */
.crow{display:grid;grid-template-columns:24px 1fr;column-gap:12px;row-gap:3px;padding:9px 12px 10px;align-items:center}
.crow .av{grid-row:1 / span 2;align-self:start;margin-top:1px}
.nl{display:flex;align-items:center;gap:7px;min-width:0;font-size:13px}
.nm{font-weight:500;white-space:nowrap}
.ttl{color:#98989d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.tag{white-space:nowrap;flex:none;font-size:11px;color:#98989d;box-shadow:inset 0 0 0 0.5px rgba(255,255,255,.2);border-radius:4px;padding:0 5px;line-height:15px}
.meta{margin-left:auto;display:flex;align-items:center;gap:10px;flex:none}
.fit{font-size:11px;color:#98989d;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;padding-right:4px}
.cost{font-size:11px;font-weight:600;color:#c7c7cc;width:22px;text-align:left;letter-spacing:-0.5px}
.cost .off{color:#5a5a5e}.cost.none{color:#6e6e73;font-weight:400}
.stat{display:flex;align-items:center;gap:6px;font-size:12px;color:#98989d;width:96px;white-space:nowrap}
.meta .btn{min-width:78px}
/* source chips and edit-in-place fields (detail sheet) */
.src{font-size:11px;color:#98989d;background:rgba(255,255,255,.06);border-radius:5px;padding:1px 6px;display:inline-flex;align-items:center;gap:3px;flex:none;line-height:15px}
.src.own{color:#d1d1d6;background:rgba(255,255,255,.1)}
.src.ovr{color:#d1d1d6;box-shadow:inset 0 0 0 0.5px rgba(255,255,255,.35);background:none}
.src.def{color:#6e6e73;background:none;box-shadow:inset 0 0 0 0.5px rgba(255,255,255,.12)}
.field{height:22px;width:190px;padding:0 7px;border-radius:5px;background:rgba(255,255,255,.07);box-shadow:inset 0 0 0 0.5px rgba(255,255,255,.16);color:#f5f5f7;font-size:13px;display:flex;align-items:center;gap:4px;box-sizing:border-box;flex:none;overflow:hidden;white-space:nowrap}
.field.ph{color:#6e6e73}
.field.nf{width:64px;justify-content:flex-end}
.tok{background:rgba(10,132,255,.24);color:#d6e8ff;border-radius:4px;padding:0 6px;font-size:12px;line-height:16px}
.stepper{display:flex;flex-direction:column;width:13px;height:22px;border-radius:5px;background:rgba(255,255,255,.13);align-items:center;justify-content:center;gap:3px;flex:none}
.ro{font-size:13px;color:#98989d;flex:none;max-width:220px;text-align:right}
.mrow{display:flex;align-items:center;gap:10px;padding:7px 12px;font-size:12px;color:#d1d1d6}
.mrow + .mrow{border-top:0.5px solid rgba(255,255,255,.06)}
.num{width:16px;height:16px;border-radius:50%;background:rgba(255,255,255,.1);font-size:10px;font-weight:600;color:#c7c7cc;display:flex;align-items:center;justify-content:center;flex:none}
.path{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:11px;color:#98989d;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.quote{font-size:12px;color:#d1d1d6;line-height:1.4;border-left:2px solid rgba(255,255,255,.18);padding-left:8px;margin-top:4px}
.hash{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:10.5px;color:#8e8e93}
.actions{display:flex;align-items:center;gap:8px;padding:12px 20px;border-top:0.5px solid rgba(255,255,255,.08)}
.legend{display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:0 2px}
.chk{display:flex;gap:9px;align-items:flex-start;padding:8px 12px;font-size:12px;color:#d1d1d6;line-height:1.4}
.chk + .chk{border-top:0.5px solid rgba(255,255,255,.06)}
.chk svg{flex:none;margin-top:2px}
.draft{position:fixed;right:10px;top:6px;font:500 10px -apple-system,sans-serif;color:#ff9f0a;letter-spacing:.3px;opacity:.85}
`;

const page = (title: string, w: number, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<!-- DRAFT, awaiting owner approval. Generated by tools/gencrew.ts: edit the generator, not this file. -->
<style>${CSS}</style>
</head>
<body style="width:${w}px">
${body}
</body>
</html>
`;

const TAB_ICONS = {
	General: `<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>`,
	Accounts: `<circle cx="12" cy="12" r="9.5"></circle><circle cx="12" cy="10" r="3.2"></circle><path d="M6.2 18.6c1.3-2.3 3.4-3.5 5.8-3.5s4.5 1.2 5.8 3.5"></path>`,
	Runs: `<path d="M12 3 3.5 7.5 12 12l8.5-4.5z"></path><path d="m3.5 12 8.5 4.5 8.5-4.5"></path><path d="m3.5 16.5 8.5 4.5 8.5-4.5"></path>`,
	// person.2, drawn in the same 1.6 stroke as the others
	Crew: `<circle cx="9" cy="8.6" r="3.3"></circle><path d="M2.8 19.2c.9-3.1 3.3-4.8 6.2-4.8s5.3 1.7 6.2 4.8"></path><circle cx="16.6" cy="9.4" r="2.7"></circle><path d="M17 14.5c2.2.2 3.8 1.6 4.4 4"></path>`,
	About: `<circle cx="12" cy="12" r="9.5"></circle><path d="M12 11v6"></path><circle cx="12" cy="7.6" r="0.6" fill="currentColor"></circle>`,
};
const titleBar = (on: keyof typeof TAB_ICONS) => `
  <div class="bar">
    <div class="lights" aria-hidden="true"><span class="light" style="background:#ff5f57"></span><span class="light" style="background:#febc2e"></span><span class="light" style="background:#4a4a4c"></span></div>
    <div class="wtitle">${on}</div>
    <div class="tabs" role="tablist" aria-label="Settings">${(Object.keys(TAB_ICONS) as Array<keyof typeof TAB_ICONS>).map((k) => `
      <button class="tab${k === on ? " on" : ""}" role="tab" aria-selected="${k === on}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TAB_ICONS[k]}</svg>${k}</button>`).join("")}
    </div>
  </div>`;

// ---- 1 · crew-list -------------------------------------------------------------------------------------------------

const statusOf = (c: Crew) => ({
	ready: `<div class="stat" title="Logged in with your Claude plan"><span class="dot" style="background:#30d158"></span>Ready</div>`,
	login: `<div class="stat" title="Not logged in: capcomd auth login codex"><span class="empty"></span>Not logged in</div>`,
	trust: `<div class="stat" title="A spawn of it waits until you trust its persona and skill"><span class="dot" style="background:#ff9f0a"></span>Needs trust</div>`,
})[c.status];
const buttonOf = (c: Crew) => ({ ready: `<button class="btn">Details…</button>`, login: `<button class="btn">Log In…</button>`, trust: `<button class="btn pri">Review…</button>` })[c.status];

const crewRow = (c: Crew) => `
        <div class="crow">
          ${bot(traitsOf(c.name), "small")}
          <div class="nl">
            <span class="nm">${esc(c.name)}</span>${c.title ? `<span class="ttl">${esc(c.title)}</span>` : ""}${c.isDefault ? `<span class="badge">Default</span>` : ""}${c.trusted ? `<span class="badge gray" title="Its persona and skill from this project are trusted as they are now">Trusted</span>` : ""}${c.tags.slice(0, c.title ? 1 : 2).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}${c.tags.length > (c.title ? 1 : 2) ? `<span class="tag" title="${esc(c.tags.join(", "))}">+${c.tags.length - (c.title ? 1 : 2)}</span>` : ""}
            <div class="meta">${c.provider === "claude" ? CLAUDE : CODEX}${costMark(c.cost)}${statusOf(c)}${buttonOf(c)}</div>
          </div>
          <div class="fit" title="${esc(c.fit)}">${esc(c.fit[0]!.toUpperCase() + c.fit.slice(1))}.</div>
        </div>`;

write("crew-list.html", page("Crew: list (DRAFT)", 620, `
<div class="win" style="width:620px;height:830px;background:#1e1e1f;display:flex;flex-direction:column;overflow:hidden">
${titleBar("Crew")}
  <div class="body">
    <div class="sec">
      <div class="grp">
        <div class="row">
          <div class="lbl">Project<span class="sub">Its crew is the profiles in its .capcomd/profiles/, plus yours.</span></div>
          <button class="pop" aria-label="Project: tinycalc">${FOLDER}tinycalc${CHEV}</button>
        </div>
      </div>
    </div>

    <div class="sec">
      <div class="sh">${FOLDER}<span style="flex:1">tinycalc</span></div>
      <div class="grp">${CREW.map(crewRow).join("")}
      </div>
      <div class="foot">Each profile is a file in the project's .capcomd/profiles/: commit it and your team gets the same crew. A profile that needs trust can't be spawned until you trust it.</div>
    </div>

    <div class="sec">
      <div class="sh">${PERSON}<span style="flex:1">Yours</span></div>
      <div class="grp">
        <div class="row"><div class="lbl" style="color:#98989d">None yet.</div></div>
      </div>
      <div class="foot">Profiles in ~/.capcomd/profiles/ join every project's crew. A project's profile of the same name wins.</div>
    </div>
  </div>
</div>
<div class="draft">DRAFT · awaiting owner approval</div>`));

// ---- 2 · crew-detail (reviewer) ------------------------------------------------------------------------------------

const header = (c: Crew, version: number, statusHtml: string) => `
    <div class="sec">
      <div class="grp">
        <div class="row" style="align-items:center;gap:14px;padding:12px 12px">
          ${bot(traitsOf(c.name), "full", 2)}
          <div class="lbl" style="gap:3px">
            <span style="display:flex;align-items:center;gap:7px"><span style="font-size:15px;font-weight:600">${esc(c.name)}</span>${c.title ? `<span class="ttl" style="font-size:13px">${esc(c.title)}</span>` : ""}<span class="badge gray">v${version}</span>${c.provider === "claude" ? CLAUDE : CODEX}${costMark(c.cost)}</span>
            <span class="sub" style="font-size:12px;line-height:1.4">${esc(c.fit[0]!.toUpperCase() + c.fit.slice(1))}.</span>
          </div>
          ${statusHtml}
        </div>
      </div>
    </div>`;

const field = (label: string, sub: string | null, chip: string, control: string) => `
        <div class="row"><div class="lbl">${label}${sub ? `<span class="sub">${sub}</span>` : ""}</div>${chip}${control}</div>`;
const pop = (v: string, icon = "") => `<button class="pop">${icon}${v}${CHEV}</button>`;
const STEPPER = `<span class="stepper"><svg width="7" height="4" viewBox="0 0 7 4" fill="none" stroke="#d1d1d6" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="m1 3.2 2.5-2.4L6 3.2"/></svg><svg width="7" height="4" viewBox="0 0 7 4" fill="none" stroke="#d1d1d6" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="m1 .8 2.5 2.4L6 .8"/></svg></span>`;
const legend = `
      <div class="legend"><span class="foot" style="padding:0">Each row says where its value comes from:</span>${src.inh("worker")}${src.own}${src.ovr("project")}${src.def}</div>`;

const reviewer = CREW.find((c) => c.name === "reviewer")!;
write("crew-detail.html", page("Crew: profile details (DRAFT)", 560, `
<div class="win" style="width:560px;height:1480px;background:#1e1e1f;display:flex;flex-direction:column;overflow:hidden;border-radius:10px;border:0.5px solid rgba(255,255,255,.14)">
  <div class="body" style="flex:1">
${header(reviewer, 3, `<div class="val" title="Logged in with your Claude plan"><span class="dot" style="background:#30d158"></span>Ready</div>`)}

    <div class="sec">
      <div class="sh">Made from</div>
      <div class="grp">
        <div class="mrow"><span class="num">1</span><span style="width:74px">worker</span><span class="path">.capcomd/profiles/worker.yaml</span><span class="src">extends</span><span class="src def" style="color:#98989d">Project</span></div>
        <div class="mrow"><span class="num">2</span><span style="width:74px">reviewer</span><span class="path">.capcomd/profiles/reviewer/profile.yaml</span><span class="src own">this profile</span><span class="src def" style="color:#98989d">Project</span></div>
      </div>
      <div class="foot">A later file wins. Changes here are written to reviewer/profile.yaml at once and raise its version; an inherited value you change stops following worker.</div>
${legend}
    </div>

    <div class="sec">
      <div class="sh">Identity</div>
      <div class="grp">${field("Title", "What the app calls it; its name when unset", src.def, `<div class="field ph">reviewer</div>`)}${field("Description", "A planner reads it when it picks a profile", src.def, `<div class="field ph">None</div>`)}${field("Tags", null, src.own, `<div class="field"><span class="tok">review</span></div>`)}
        <div class="row" style="align-items:flex-start">
          <div class="lbl">Persona<span class="sub">SOUL.md · 1.6 KB · first in its prompt, before its skills</span><span class="quote">You review changes the way this team&#39;s most careful engineer would: tests first, then the diff, then the commit message.</span></div>
          ${src.own}<div class="val" style="font-size:12px"><span class="dot" style="background:#30d158"></span>Trusted</div><button class="btn">Open</button>
        </div>
      </div>
      <div class="foot">The persona is the project&#39;s text, shown as it is written. You trusted it as it is now; if SOUL.md changes, reviewer waits for your trust again.</div>
    </div>

    <div class="sec">
      <div class="sh">Skills</div>
      <div class="grp">
        <div class="row">
          <div class="lbl"><span class="mono" style="font-size:12px">review-checklist</span><span class="sub">Project · skills/review-checklist/SKILL.md · <span class="hash">sha256:8f3c1e…e01a</span></span></div>
          <div class="val" style="font-size:12px"><span class="dot" style="background:#30d158"></span>Trusted</div><button class="btn">Open</button>
        </div>
      </div>
      <div class="foot">An agent gets each skill exactly as its hash says. capcomd&#39;s orchestration skill is added by itself to profiles that may spawn.</div>
    </div>

    <div class="sec">
      <div class="sh">Agent</div>
      <div class="grp">${field("Agent", null, src.inh("worker"), pop("Claude Code", CLAUDE))}${field("Login", null, src.inh("worker"), pop("Plan login"))}${field("Model", null, src.inh("worker"), `<div class="field mono" style="font-size:12px">claude-sonnet-5-5</div>`)}${field("Effort", null, src.own, pop("High"))}${field("Works by", null, src.def, pop("Executing: edits and runs code"))}${field("Allowed tools", "Read, Glob, Grep, LS, git diff, git log, git show, cat, ls, bun test", src.own, `<button class="btn">Edit…</button>`)}${field("Added to the prompt", "Change it in the profile&#39;s file", src.def, `<span class="ro">Nothing</span>`)}
      </div>
    </div>

    <div class="sec">
      <div class="sh">Limits</div>
      <div class="grp">${field("Turns", null, src.own, `<span style="display:flex;gap:4px"><div class="field nf">40</div>${STEPPER}</span>`)}${field("Budget", "In US dollars", src.def, `<span style="display:flex;gap:4px"><div class="field nf ph">No limit</div>${STEPPER}</span>`)}${field("Time limit", null, src.def, `<span style="display:flex;gap:4px"><div class="field nf ph">No limit</div>${STEPPER}</span>`)}
      </div>
    </div>

    <div class="sec">
      <div class="sh">Spawning</div>
      <div class="grp">${field("May answer with a report", "Spawned with report: read-only, its result is its final message", src.own, `<button class="tog on" role="switch" aria-checked="true"><span class="knob"></span></button>`)}${field("May spawn agents", null, src.def, `<button class="tog" role="switch" aria-checked="false"><span class="knob"></span></button>`)}
      </div>
      <div class="foot">Sandbox, jobs and the rest follow the same way: every value the profile&#39;s files set has a row.</div>
    </div>
  </div>
  <div class="actions"><button class="btn">Open File</button><button class="btn">Show in Finder</button><span style="flex:1"></span><button class="btn pri">Done</button></div>
</div>
<div class="draft">DRAFT · awaiting owner approval</div>`));

// ---- 3 · crew-untrusted (security-critic) --------------------------------------------------------------------------

const critic = CREW.find((c) => c.name === "security-critic")!;
const YES = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#30d158" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2.2 6.3 2.4 2.4 5.2-5.4"/></svg>`;
const NO = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#8e8e93" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 6h6"/></svg>`;
write("crew-untrusted.html", page("Crew: needs trust (DRAFT)", 560, `
<div class="win" style="width:560px;height:1210px;background:#1e1e1f;display:flex;flex-direction:column;overflow:hidden;border-radius:10px;border:0.5px solid rgba(255,255,255,.14)">
  <div class="body" style="flex:1">
${header(critic, 1, `<div class="val" title="A spawn of it is refused until you trust it"><span class="dot" style="background:#ff9f0a"></span>Needs trust</div>`)}

    <div class="sec">
      <div class="sh">Trust this project&#39;s text</div>
      <div class="grp ask">
        <div class="row" style="align-items:flex-start">
          <div class="lbl">Persona<span class="sub">SOUL.md · 2.1 KB · <span class="hash">sha256:9c1e07…74a2</span></span><span class="quote">You are a security reviewer. Read every change as an attacker would, and report what you would try first.</span></div>
          <span class="badge orange">New</span><button class="btn">Open</button>
        </div>
        <div class="row" style="align-items:flex-start">
          <div class="lbl"><span class="mono" style="font-size:12px">threat-model</span><span class="sub">Skill · skills/threat-model/SKILL.md · 6.4 KB · <span class="hash">sha256:41d0b9…c3f8</span></span></div>
          <span class="badge orange" title="You trusted it before with other content">Changed</span><button class="btn">Open</button>
        </div>
        <div class="row">
          <div class="lbl">Trust both as they are now<span class="sub">Opens Terminal with <span class="mono" style="font-size:11px">capcomd profiles trust security-critic</span> ready: it shows each file and its hash and asks you there. This row updates by itself.</span></div>
          <button class="btn pri">Trust…</button>
        </div>
      </div>
      <div class="foot">Until then a planner sees security-critic as waiting on your trust, and capcomd refuses to spawn it. Its settings below don&#39;t need trust: capcomd enforces them.</div>
    </div>

    <div class="sec">
      <div class="sh">What trusting covers</div>
      <div class="grp">
        <div class="chk">${YES}<span>Exactly these two files, as their hashes say. If either changes (an update, an agent&#39;s commit), security-critic waits for your trust again.</span></div>
        <div class="chk">${YES}<span>security-critic and any profile that extends it: they share the files, so one trust covers them.</span></div>
        <div class="chk">${NO}<span>Nothing runs on this Mac. A profile is text and settings; its MCP server (semgrep) runs inside the agent&#39;s sandbox.</span></div>
        <div class="chk">${NO}<span>Your own skills need no trust: <span class="mono" style="font-size:11px">owasp-top-10</span> comes from ~/.claude/skills.</span></div>
      </div>
    </div>

    <div class="sec">
      <div class="sh">Made from</div>
      <div class="grp">
        <div class="mrow"><span class="num">1</span><span style="width:96px">worker</span><span class="path">.capcomd/profiles/worker.yaml</span><span class="src">extends</span></div>
        <div class="mrow"><span class="num">2</span><span style="width:96px">reviewer</span><span class="path">.capcomd/profiles/reviewer/profile.yaml</span><span class="src">extends</span></div>
        <div class="mrow"><span class="num">3</span><span style="width:96px">security-critic</span><span class="path">.capcomd/profiles/security-critic/profile.yaml</span><span class="src own">this profile</span></div>
      </div>
      <div class="foot">Installed into this project from acme/capcomd-profiles at 4e1b2c0 (its LOCK). Updating it replaces these files and asks for trust again where one changed.</div>
    </div>

    <div class="sec">
      <div class="sh">Skills</div>
      <div class="grp">
        <div class="row"><div class="lbl"><span class="mono" style="font-size:12px">threat-model</span><span class="sub">Project · <span class="hash">sha256:41d0b9…c3f8</span></span></div><div class="val" style="font-size:12px"><span class="dot" style="background:#ff9f0a"></span>Needs trust</div></div>
        <div class="row"><div class="lbl"><span class="mono" style="font-size:12px">owasp-top-10</span><span class="sub">Yours · ~/.claude/skills · <span class="hash">sha256:e27a55…09bd</span></span></div><div class="val" style="font-size:12px"><span class="dot" style="background:#30d158"></span>Yours</div></div>
      </div>
    </div>

    <div class="sec">
      <div class="sh">Agent</div>
      <div class="grp">${field("Model", null, src.own, `<div class="field mono" style="font-size:12px">claude-opus-5-5</div>`)}${field("Effort", null, src.own, pop("High"))}${field("Network", "github.com, api.anthropic.com", src.own, `<button class="btn">Edit…</button>`)}${field("Turns", null, src.inh("reviewer"), `<span style="display:flex;gap:4px"><div class="field nf">40</div>${STEPPER}</span>`)}
      </div>
    </div>
  </div>
  <div class="actions"><button class="btn">Open File</button><button class="btn">Show in Finder</button><span style="flex:1"></span><button class="btn pri">Done</button></div>
</div>
<div class="draft">DRAFT · awaiting owner approval</div>`));
