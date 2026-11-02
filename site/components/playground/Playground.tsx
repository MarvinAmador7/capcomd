"use client";

// The bot playground: everything the avatar engine can draw, as a game. Pull a bot from an id and a role, change any
// of its 14 parts (one part at a time), keep a crew (localStorage, optional), download SVG or PNG, share a link that
// redraws it exactly.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CATALOG, MOODS, botGrid, botTraits, gridSvg, rng, withOverrides, type Mood } from "@/lib/vendor/bot-avatar.js";
import { SITE } from "@/lib/site";
import { Exploded } from "./Exploded";
import { Dropdown } from "./Dropdown";
import {
  PART_SLOTS, ROLES, SLOT_LABEL, botPng, partIcon, crewPng, decode, describe, download, encode, fileName, fits, odds, partOf,
  randomSeed, setPart, type Backdrop, type BotTraits, type PartSlot, type Role, type Size,
} from "@/lib/playground";

const STORE = "capcomd.bots.crew.v1";
const KEYS = "capcomd.bots.keys.v1";
const CREW_MAX = 12;
const SIZES: Array<[Size, string]> = [["full", "Full body"], ["small", "Head and shoulders"], ["xs", "Head"]];
const SIZE_NAME: Record<Size, string> = { full: "full body", small: "head and shoulders", xs: "head" };
const MOOD_LABEL: Record<Mood, string> = { happy: "Happy", sleepy: "Sleepy", oops: "Oops", love: "Love" };
/** The 14 parts, grouped as you'd look at a bot. Order of the engine's slots is kept within each group. */
const GROUPS: Array<[string, PartSlot[]]> = [
  ["Head", ["head", "antenna", "accessory", "ears"]],
  ["Face", ["screen", "eyes", "mouth", "blush"]],
  ["Body", ["torso", "plate", "pose", "legs"]],
  ["Style", ["palette", "dither"]],
];
const ORDER: PartSlot[] = GROUPS.flatMap(([, s]) => s);
/** Body parts are previewed on the whole bot, head and face parts on head and shoulders, where they're bigger. */
const PREVIEW: Record<PartSlot, Size> = Object.fromEntries(PART_SLOTS.map((s) => [s, ["torso", "plate", "pose", "legs", "dither"].includes(s) ? "full" : "small"])) as Record<PartSlot, Size>;
// The app's run-finished confetti (Theme.Moments in apps/menubar): 26 squares of 2 or 3 points in these colours.
const CONFETTI = ["#FF7A10", "#9457DC", "#5EE6FF", "#F7A3DA"];

const svgOf = (t: BotTraits, size: Size) => gridSvg(botGrid(t, size), { label: "", decorative: true }).replace(/ width="\d+" height="\d+"/, "");
const fmt = (n: number) => n.toLocaleString("en-US");
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function readCrew(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    // Keep only codes that still decode, so the list and its Remove buttons stay aligned.
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && decode(x) !== null).slice(0, CREW_MAX) : [];
  } catch { return []; }
}
function writeCrew(c: string[]) { try { localStorage.setItem(STORE, JSON.stringify(c)); } catch { /* private mode: the crew lasts for this visit */ } }

export function Playground({ initialSeed, counts }: { initialSeed: string; counts: Record<Role, number> }) {
  const [t, setT] = useState<BotTraits>(() => botTraits(initialSeed, "worker"));
  const [size, setSize] = useState<Size>("full");
  const [seedText, setSeedText] = useState(initialSeed);
  const [slot, setSlot] = useState<PartSlot>("head");
  const [pulls, setPulls] = useState(0);
  const [cheer, setCheer] = useState(false);
  const [crew, setCrew] = useState<string[]>([]);
  const [scale, setScale] = useState(8);
  const [bg, setBg] = useState<Backdrop>("none");
  const [status, setStatus] = useState("");
  const [canShare, setCanShare] = useState(false);
  const [origin, setOrigin] = useState("");
  const [keys, setKeys] = useState(true);
  const [pop, setPop] = useState<string | null>(null);
  const loaded = useRef(false);
  const flashTimer = useRef<number | undefined>(undefined);
  const cheerTimer = useRef<number | undefined>(undefined);

  // A shared link (#s=…&r=…&t=…) opens on its bot; the crew comes back from localStorage when it's available.
  useEffect(() => {
    const shared = location.hash.length > 1 ? decode(location.hash) : null;
    if (shared) { setT(shared.traits); setSize(shared.size); setSeedText(shared.traits.seed); }
    setCrew(readCrew());
    setCanShare(typeof navigator.share === "function");
    setOrigin(`${location.origin}${location.pathname}`);
    try { setKeys(localStorage.getItem(KEYS) !== "off"); } catch { /* default on */ }
    loaded.current = true;
    // A link pasted into this tab's address bar (only the hash changes) redraws too.
    const onHash = () => { const sh = decode(location.hash); if (sh) { setT(sh.traits); setSize(sh.size); setSeedText(sh.traits.seed); setCheer(false); } };
    window.addEventListener("hashchange", onHash);
    return () => { window.removeEventListener("hashchange", onHash); window.clearTimeout(flashTimer.current); window.clearTimeout(cheerTimer.current); };
  }, []);
  const code = useMemo(() => encode(t, size), [t, size]);
  useEffect(() => { if (loaded.current) history.replaceState(null, "", `#${code}`); }, [code]);
  const link = `${origin}#${code}`;

  const flash = (m: string) => { setStatus(m); window.clearTimeout(flashTimer.current); flashTimer.current = window.setTimeout(() => setStatus(""), 2400); };
  const change = (next: BotTraits) => { setT(next); setCheer(false); };
  const pull = useCallback(() => {
    const s = randomSeed();
    setT((cur) => botTraits(s, cur.role)); setSeedText(s); setCheer(false); setPulls((n) => n + 1);
  }, []);
  const save = useCallback(() => {
    const c = encode(t, size);
    if (crew.includes(c)) { flash(`${t.name} is already in your crew.`); return; }
    if (crew.length >= CREW_MAX) { flash(`Your crew is full (${CREW_MAX}). Remove one first.`); return; }
    const next = [...crew, c]; setCrew(next); writeCrew(next); flash(`${t.name} joined your crew.`);
  }, [t, size, crew]);
  const copy = useCallback(async () => {
    try { await navigator.clipboard.writeText(link); flash("Link copied."); } catch { flash("Open Share and copy the link from there."); }
  }, [link]);
  const savePng = useCallback(async () => {
    const name = `${fileName(t)}-${size}@${scale}x.png`;
    download(await botPng(t, size, scale, bg), name); flash(`Saved ${name}`);
  }, [t, size, scale, bg]);
  const saveSvg = () => {
    const name = `${fileName(t)}-${size}.svg`;
    download(new Blob([gridSvg(botGrid(t, size), { scale, label: describe(t) })], { type: "image/svg+xml" }), name); flash(`Saved ${name}`);
  };
  // The app's run-finished moment, as the app plays it: for about 2 s the bot cheers with a happy face, anyone
  // without a crown or flag in a party hat, over static confetti. It's a moment, not a trait: nothing is changed.
  const doCheer = () => {
    setCheer(true); setPulls((n) => n + 1);
    window.clearTimeout(cheerTimer.current);
    cheerTimer.current = window.setTimeout(() => setCheer(false), 2200);
  };
  const viaKey = useRef(false);
  const stepPart = useCallback((d: number) => { viaKey.current = !!document.activeElement?.closest(".pg__panel"); setSlot((s) => ORDER[(ORDER.indexOf(s) + d + ORDER.length) % ORDER.length]!); }, []);
  // After [ or ], focus the newly selected part tab (if focus was in the editor), so arrows keep working and
  // screen readers announce the part.
  useEffect(() => {
    if (!viaKey.current) return;
    viaKey.current = false;
    document.querySelector<HTMLInputElement>(`input[name="part"][value="${slot}"]`)?.focus();
  }, [slot]);

  // Single-key shortcuts (R pull, S save, C copy link, D download PNG, [ and ] previous / next part), outside text
  // fields only, and off with the switch at the bottom (WCAG 2.1.4).
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input[type=text], input:not([type]), textarea, select, [contenteditable]")) return;
      const k = e.key.toLowerCase();
      const act: Record<string, () => void> = { r: pull, s: save, c: () => void copy(), d: () => void savePng(), "[": () => stepPart(-1), "]": () => stepPart(1), ",": () => stepPart(-1), ".": () => stepPart(1) };
      if (act[k] && !e.shiftKey) { e.preventDefault(); act[k](); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, pull, save, copy, savePng, stepPart]);
  // One popover at a time; Escape or a click elsewhere closes it, and focus goes back to its button.
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: PointerEvent) => { if (!(e.target as Element).closest(".pg__popwrap")) setPop(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { document.getElementById(`btn-${pop}`)?.focus(); setPop(null); } };
    document.addEventListener("pointerdown", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [pop]);
  const toggle = (name: string) => setPop((cur) => (cur === name ? null : name));
  const setShortcuts = (on: boolean) => { setKeys(on); try { localStorage.setItem(KEYS, on ? "on" : "off"); } catch { /* this visit only */ } };

  const p = odds(t);
  const desc = describe(t);
  const shown = useMemo(() => {
    if (!cheer) return t;
    const orchestrator = t.antenna === "crown" || t.antenna === "flag";
    return withOverrides(t, { mood: "happy", pose: "cheer", accessory: orchestrator ? undefined : "party" });
  }, [t, cheer]);
  const big = useMemo(() => svgOf(shown, size), [shown, size]);
  const confetti = useMemo(() => {
    if (!cheer) return [];
    const r = rng(t.seed, "confetti");
    return Array.from({ length: 26 }, () => ({ x: (r() % 10000) / 100, y: (r() % 10000) / 143, s: r() % 2 === 0 ? 0.7 : 1, c: CONFETTI[r() % CONFETTI.length]! }));
  }, [cheer, t.seed]);
  const crewBots = useMemo(() => crew.map((c) => ({ code: c, bot: decode(c)! })), [crew]);
  // One engine-drawn icon per part, redrawn as the bot changes (about 15 ms for all 14).
  const icons = useMemo(() => Object.fromEntries(PART_SLOTS.map((sl) => [sl, partIcon(t, sl)])) as Record<PartSlot, string>, [t]);
  // Icons for role, size and mood, all drawn by the engine from this bot's id: the head this id gets in each role,
  // this bot at each size, and its face in each mood.
  const headSvg = (x: BotTraits) => gridSvg(botGrid(x, "xs"), { label: "", decorative: true, scale: 2 });
  const roleIcons = useMemo(() => Object.fromEntries(ROLES.map((r) => [r, headSvg(botTraits(t.seed, r))])) as Record<Role, string>, [t.seed]);
  // Size: the bot as that size draws it (xs at 2×, small and full at 1×), shown in the 28-px icon box.
  const sizeIcons = useMemo(() => Object.fromEntries(SIZES.map(([z]) => [z, gridSvg(botGrid(t, z), { label: "", decorative: true, scale: z === "xs" ? 2 : 1 })])) as Record<Size, string>, [t]);
  const moodIcons = useMemo(() => ({ ...Object.fromEntries((Object.keys(MOODS) as Mood[]).map((m) => [m, headSvg(withOverrides(t, { mood: m }))])), own: headSvg(t) }) as Record<Mood | "own", string>, [t]);
  const mood = (Object.keys(MOODS) as Mood[]).find((m) => t.eyes === MOODS[m].eyes && t.mouth === MOODS[m].mouth);
  const sizePx = CATALOG.frames[size].w;

  return (
    <>
      <section className="pg" aria-label="Bot playground">
        <div className="pg__stage">
          <div className="pg__slot" data-load style={{ ["--d" as string]: "120ms" }}>
            <span className="floor" aria-hidden="true" />
            {confetti.length > 0 && (
              <svg className="pg__confetti" viewBox="0 0 100 70" preserveAspectRatio="none" aria-hidden="true" shapeRendering="crispEdges">
                {confetti.map((c, i) => <rect key={i} x={c.x} y={c.y} width={c.s} height={c.s * 1.4} fill={c.c} />)}
              </svg>
            )}
            <div key={pulls} className={`pg__bot pg__bot--${size}`} role="img" aria-label={`${t.name}, ${t.role}${cheer ? ", cheering" : ""}`} aria-describedby="pg-desc" dangerouslySetInnerHTML={{ __html: big }} />
            <p className="pg__tag" aria-hidden="true"><b>{t.name}</b> <span>{t.role}</span></p>
          </div>
          <div className="pg__id">
            <h2 className="pg__name">{t.name}</h2>
            <p className="pg__meta"><span>{t.role}</span> <code>{t.seed}</code></p>
          </div>
          <p className="pg__odds" data-load style={{ ["--d" as string]: "220ms" }}>
            {p > 0
              ? <>1 in {fmt(Math.round(1 / p))} ids draw exactly this {t.role}, of {fmt(counts[t.role])} possible.</>
              : <>Made by hand: no id draws this {t.role}. {fmt(counts[t.role])} {t.role}s are possible, plus yours.</>}
          </p>
          <p className="sr" id="pg-desc">{desc}</p>
          <div className="pg__bar" data-load style={{ ["--d" as string]: "260ms" }} role="group" aria-label="Bot actions" data-ui>
            <button type="button" className="pg__act" onClick={doCheer}>Cheer</button>
            <button type="button" className="pg__act" onClick={save} aria-keyshortcuts="S">Add to crew <kbd aria-hidden="true">S</kbd></button>
            <Pop label="Download" kbd="D" open={pop === "download"} onToggle={() => toggle("download")}>
              <Group legend="Backdrop">
                {([["none", "None"], ["floor", "Floor"], ["paper", "Paper"]] as const).map(([v, l]) => <Seg key={v} name="bg" checked={bg === v} onChange={() => setBg(v)}>{l}</Seg>)}
              </Group>
              <label className="pg__field pg__field--inline">
                <span>Scale</span>
                <select value={scale} onChange={(e) => setScale(Number(e.target.value))}>
                  {Array.from({ length: 16 }, (_, i) => i + 1).map((s) => <option key={s} value={s}>{s}× · {sizePx * s} px</option>)}
                </select>
              </label>
              <div className="pg__row2">
                <button type="button" className="pg__btn pg__btn--primary" onClick={() => void savePng()} aria-keyshortcuts="D">PNG</button>
                <button type="button" className="pg__btn" onClick={saveSvg}>SVG</button>
              </div>
              <p className="pg__hint">The {SIZE_NAME[size]}, {sizePx * scale}×{sizePx * scale} px, each cell a crisp {scale}×{scale} square. SVGs are transparent.</p>
            </Pop>
            <Pop label="Share" kbd="C" open={pop === "share"} onToggle={() => toggle("share")}>
              <label className="pg__field">
                <span>Link to this bot</span>
                <input type="text" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
              </label>
              <div className="pg__row2">
                <button type="button" className="pg__btn pg__btn--primary" onClick={() => void copy()} aria-keyshortcuts="C">Copy link</button>
                {canShare && <button type="button" className="pg__btn" onClick={() => void navigator.share({ title: `${t.name}, a capcomd bot`, url: link }).catch(() => {})}>Share…</button>}
              </div>
              <p className="pg__hint">The link holds the id, the role, every part and the size, so it redraws exactly this bot.</p>
            </Pop>
          </div>
          <p className="pg__license">{SITE.license}</p>
        </div>

        <form className="pg__panel" data-ui data-load style={{ ["--d" as string]: "180ms" }} onSubmit={(e) => e.preventDefault()} aria-label="Bot editor">
          <div className="pg__pull">
            <label className="pg__field pg__field--grow" data-ui>
              <span>Agent id or any text</span>
              <input type="text" value={seedText} maxLength={64} spellCheck={false} autoComplete="off"
                onChange={(e) => { setSeedText(e.target.value); if (e.target.value.trim()) change(botTraits(e.target.value.trim(), t.role)); }} />
            </label>
            <button type="button" className="button pg__pullbtn" onClick={pull} aria-keyshortcuts="R">Pull</button>
          </div>
          <div className="pg__trio">
            <Dropdown label="Role" value={t.role} onChange={(r) => change(botTraits(t.seed, r))}
              options={ROLES.map((r) => ({ value: r, label: r, icon: roleIcons[r] }))} />
            <Dropdown label="Size" value={size} onChange={setSize}
              options={SIZES.map(([z, l]) => ({ value: z, label: l, icon: sizeIcons[z] }))} />
            <Dropdown label="Mood" value={mood ?? null} align="right" placeholder={{ label: "Own face", icon: moodIcons.own }}
              onChange={(m) => change(setPart(setPart(t, "eyes", MOODS[m].eyes), "mouth", MOODS[m].mouth))}
              options={(Object.keys(MOODS) as Mood[]).map((m) => ({ value: m, label: MOOD_LABEL[m], icon: moodIcons[m] }))} />
          </div>

          <fieldset className="pg__picker">
            <legend>Part <span className="pg__keyhint" aria-hidden="true"><kbd>[</kbd> <kbd>]</kbd></span></legend>
            {GROUPS.map(([g, slots]) => (
              <div key={g} className="pg__pgroup" role="group" aria-label={g}>
                <span className="pg__gname" aria-hidden="true">{g}</span>
                {slots.map((s) => (
                  <label key={s} className="pg__ptab">
                    <input type="radio" name="part" value={s} checked={slot === s} onChange={() => setSlot(s)} />
                    <span><span className="pg__picon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icons[s] }} /><b>{SLOT_LABEL[s]}</b><span className="sr">: </span><i>{partOf(s, t[s]).label.replace(/ \(.*\)$/, "")}</i></span>
                  </label>
                ))}
              </div>
            ))}
          </fieldset>

          <Options slot={slot} t={t} onPick={(id) => change(setPart(t, slot, id))} />
        </form>
      </section>

      <section className="pg-crew" aria-labelledby="pg-crew-title">
        <div className="pg-crew__head">
          <h2 className="pg-crew__title" id="pg-crew-title">Your crew</h2>
          <p>{crewBots.length ? `${crewBots.length} of ${CREW_MAX}, kept in this browser.` : <>Empty. Pull a bot you like and press <kbd>S</kbd>.</>}</p>
          {crewBots.length > 0 && (
            <div className="pg__row2">
              <button type="button" className="pg__btn" onClick={async () => { download(await crewPng(crewBots.map((x) => x.bot.traits)), "capcomd-crew.png"); flash("Saved capcomd-crew.png"); }}>Crew as one PNG</button>
              <button type="button" className="pg__btn" onClick={() => { setCrew([]); writeCrew([]); }}>Clear</button>
            </div>
          )}
        </div>
        {crewBots.length > 0 && (
          <ul className="pg-crew__list">
            {crewBots.map(({ code: key, bot: { traits: c, size: cs } }) => (
              <li key={key}>
                <button type="button" className="pg-crew__bot" aria-label={`Open ${c.name}, ${c.role}`}
                  onClick={() => { setT(c); setSize(cs); setSeedText(c.seed); setCheer(false); setPulls((n) => n + 1); window.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" }); }}>
                  <span className="floor" aria-hidden="true" />
                  <span className="pg-crew__svg" dangerouslySetInnerHTML={{ __html: svgOf(c, "full") }} />
                </button>
                <span className="pg-crew__name">{c.name}</span>
                <button type="button" className="pg-crew__x" aria-label={`Remove ${c.name} from your crew`}
                  onClick={() => setCrew((cur) => { const next = cur.filter((x) => x !== key); writeCrew(next); return next; })}>×</button>
              </li>
            ))}
          </ul>
        )}
        <div className="pg__keys">
          <label className="pg__switch"><input type="checkbox" checked={keys} onChange={(e) => setShortcuts(e.target.checked)} /> <span>Single-key shortcuts</span></label>
          <p><kbd>R</kbd> pull · <kbd>[</kbd> <kbd>]</kbd> or <kbd>,</kbd> <kbd>.</kbd> part · <kbd>S</kbd> add to crew · <kbd>C</kbd> copy link · <kbd>D</kbd> PNG</p>
        </div>
      </section>

      <Exploded t={t} onPull={pull} />
      <p className="pg__status" role="status" aria-live="polite">{status}</p>
    </>
  );
}

/** The options for one part: every part the catalog has for the slot, previewed on this bot. */
function Options({ slot, t, onPick }: { slot: PartSlot; t: BotTraits; onPick: (id: string) => void }) {
  const parts = CATALOG.slots[slot];
  const thumbs = useMemo(() => parts.map((p) => svgOf(p.id === t[slot] ? t : safe(t, slot, p.id), PREVIEW[slot])), [parts, slot, t]);
  return (
    <fieldset className="pg__options">
      <legend>{SLOT_LABEL[slot]}<span className="sr">, now:</span><span aria-hidden="true"> · </span><span className="pg__current">{partOf(slot, t[slot]).label}</span></legend>
      <div className="pg__grid" data-ui>
        {parts.map((p, i) => {
          const ok = fits(t, slot, p.id);
          return (
            <label key={p.id} className={`pg__part${ok ? "" : " pg__part--moves"}`}>
              <input type="radio" name={`opt-${slot}`} checked={t[slot] === p.id} onChange={() => onPick(p.id)} />
              <span className="pg__thumb" dangerouslySetInnerHTML={{ __html: thumbs[i]! }} />
              <span className="pg__plabel">{p.label.replace(/ \(.*\)$/, "")}{ok ? "" : <span className="sr"> (another part changes too)</span>}</span>
            </label>
          );
        })}
      </div>
      <p className="pg__swap"><span className="pg__swapmark" aria-hidden="true" /> Dimmed: picking it changes another part too, to keep the bot valid.</p>
    </fieldset>
  );
}
const safe = (t: BotTraits, slot: PartSlot, id: string) => { try { return setPart(t, slot, id); } catch { return t; } };

/** A small popover: a disclosure button and its panel (open state, Escape and outside clicks live in Playground). */
function Pop({ label, kbd, open, onToggle, children }: { label: string; kbd: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = label.toLowerCase();
  return (
    <div className="pg__popwrap" onBlur={(e) => { if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) onToggle(); }}>
      <button type="button" id={`btn-${id}`} className="pg__act" aria-expanded={open} aria-controls={`pop-${id}`} onClick={onToggle}>
        {label} <kbd aria-hidden="true" title={`${kbd}: ${label === "Download" ? "download a PNG" : "copy the link"}`}>{kbd}</kbd> <svg className="pg__caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <div className="pg__pop" id={`pop-${id}`} role="group" aria-label={`${label} options`} hidden={!open}>{children}</div>
    </div>
  );
}

function Group({ legend, wide, children }: { legend: string; wide?: boolean; children: ReactNode }) {
  return (
    <fieldset className={`pg__group${wide ? " pg__group--wide" : ""}`}>
      <legend>{legend}</legend>
      <div className="pg__seg" data-ui>{children}</div>
    </fieldset>
  );
}

function Seg({ name, checked, onChange, icon, big, children }: { name: string; checked: boolean; onChange: () => void; icon?: string; big?: boolean; children: ReactNode }) {
  return (
    <label className={`pg__opt${icon ? " pg__opt--icon" : ""}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span>{icon && <span className={`pg__oicon${big ? " pg__oicon--big" : ""}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} />}<span className="pg__oname">{children}</span></span>
    </label>
  );
}
