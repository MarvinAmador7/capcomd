"use client";

// The bot playground: everything the avatar engine can draw, as a game. Pull a bot from an id and a role, change any
// of its 14 parts, keep a crew (localStorage, optional), download SVG or PNG, share a link that redraws it exactly.
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CATALOG, MOODS, botGrid, botTraits, gridSvg, rng, withOverrides, type Mood } from "@/lib/vendor/bot-avatar.js";
import { SITE } from "@/lib/site";
import {
  PART_SLOTS, ROLES, SLOT_LABEL, botPng, crewPng, decode, describe, download, encode, fileName, fits, odds, partOf,
  randomSeed, setPart, type Backdrop, type BotTraits, type PartSlot, type Role, type Size,
} from "@/lib/playground";

const STORE = "capcomd.bots.crew.v1";
const CREW_MAX = 12;
const SIZES: Array<[Size, string]> = [["full", "Full body"], ["small", "Head and shoulders"], ["xs", "Head"]];
const MOOD_LABEL: Record<Mood, string> = { happy: "Happy", sleepy: "Sleepy", oops: "Oops", love: "Love" };
// The app's run-finished confetti (Theme.Moments in apps/menubar): 26 squares of 2 or 3 points in these colours.
const CONFETTI = ["#FF7A10", "#9457DC", "#5EE6FF", "#F7A3DA"];
const KEYS = "capcomd.bots.keys.v1";

const svgOf = (t: BotTraits, size: Size, label?: string) =>
  gridSvg(botGrid(t, size), label ? { label } : { label: "", decorative: true }).replace(/ width="\d+" height="\d+"/, "");
const fmt = (n: number) => n.toLocaleString("en-US");

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
  const [pulls, setPulls] = useState(0);
  const [cheer, setCheer] = useState(false);
  const [crew, setCrew] = useState<string[]>([]);
  const [scale, setScale] = useState(8);
  const [bg, setBg] = useState<Backdrop>("none");
  const [status, setStatus] = useState("");
  const [canShare, setCanShare] = useState(false);
  const [origin, setOrigin] = useState("");
  const [keys, setKeys] = useState(true);
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
    return () => { window.clearTimeout(flashTimer.current); window.clearTimeout(cheerTimer.current); };
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
    setCrew((cur) => {
      if (cur.includes(c)) { flash(`${t.name} is already in your crew.`); return cur; }
      if (cur.length >= CREW_MAX) { flash(`Your crew is full (${CREW_MAX}). Remove one first.`); return cur; }
      const next = [...cur, c]; writeCrew(next); flash(`${t.name} joined your crew.`); return next;
    });
  }, [t, size]);
  const copy = useCallback(async () => {
    try { await navigator.clipboard.writeText(link); flash("Link copied."); } catch { flash("Select the link and copy it."); }
  }, [link]);
  const savePng = useCallback(async () => {
    download(await botPng(t, size, scale, bg), `${fileName(t)}-${size}@${scale}x.png`);
    flash(`Saved ${fileName(t)}-${size}@${scale}x.png`);
  }, [t, size, scale, bg]);
  const saveSvg = () => {
    download(new Blob([gridSvg(botGrid(t, size), { scale, label: describe(t) })], { type: "image/svg+xml" }), `${fileName(t)}-${size}.svg`);
    flash(`Saved ${fileName(t)}-${size}.svg`);
  };
  // The app's run-finished moment, as the app plays it: for about 2 s the bot cheers with a happy face, anyone
  // without a crown or flag in a party hat, over static confetti. It's a moment, not a trait: nothing is changed.
  const doCheer = () => {
    setCheer(true); setPulls((n) => n + 1);
    window.clearTimeout(cheerTimer.current);
    cheerTimer.current = window.setTimeout(() => setCheer(false), 2200);
  };

  // Single-key shortcuts (R pull, S save, C copy link, D download PNG), outside text fields only, and off with the
  // switch below (WCAG 2.1.4).
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      const k = e.key.toLowerCase();
      if (k === "r") { e.preventDefault(); pull(); } else if (k === "s") { e.preventDefault(); save(); }
      else if (k === "c") { e.preventDefault(); void copy(); } else if (k === "d") { e.preventDefault(); void savePng(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, pull, save, copy, savePng]);
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
  const crewTraits = useMemo(() => crew.map((code) => ({ code, bot: decode(code)! })), [crew]);
  const deferred = useDeferredValue(t);

  return (
    <>
      <section className="pg" aria-labelledby="pg-stage-title">
        <h2 className="sr" id="pg-stage-title">Your bot</h2>
        <div className="pg__stage">
          <div className="pg__slot">
            <span className="floor" aria-hidden="true" />
            {confetti.length > 0 && (
              <svg className="pg__confetti" viewBox="0 0 100 70" preserveAspectRatio="none" aria-hidden="true" shapeRendering="crispEdges">
                {confetti.map((c, i) => <rect key={i} x={c.x} y={c.y} width={c.s} height={c.s * 1.4} fill={c.c} />)}
              </svg>
            )}
            <div key={pulls} className={`pg__bot pg__bot--${size}`} role="img" aria-label={`${t.name}, ${t.role}${cheer ? ", cheering" : ""}`} aria-describedby="pg-desc" dangerouslySetInnerHTML={{ __html: big }} />
          </div>
          <div className="pg__id">
            <p className="pg__name">{t.name}</p>
            <p className="pg__meta"><span>{t.role}</span> <code>{t.seed}</code></p>
          </div>
          <div className="pg__actions">
            <button type="button" className="button" onClick={pull} aria-keyshortcuts="R">Pull a bot <kbd>R</kbd></button>
            <button type="button" className="button button--ghost" onClick={save} aria-keyshortcuts="S">Add to crew <kbd>S</kbd></button>
            <button type="button" className="button button--ghost" onClick={doCheer}>Cheer</button>
          </div>
          <p className="pg__odds">
            {p > 0
              ? <>Odds of an id drawing exactly this {t.role}: <b>1 in {fmt(Math.round(1 / p))}</b>. One of {fmt(counts[t.role])} possible {t.role}s.</>
              : <>Made by hand: no id draws this as a {t.role}. One of {fmt(counts[t.role])} possible {t.role}s, plus yours.</>}
          </p>
          <p className="pg__desc" id="pg-desc">{desc}</p>
        </div>

        <form className="pg__panel" onSubmit={(e) => e.preventDefault()} aria-label="Bot controls">
          <div className="pg__row">
            <label className="pg__field" data-ui>
              <span>Agent id or any text</span>
              <input type="text" value={seedText} maxLength={64} spellCheck={false} autoComplete="off"
                onChange={(e) => { setSeedText(e.target.value); if (e.target.value.trim()) change(botTraits(e.target.value.trim(), t.role)); }}
                aria-describedby="pg-seed-note" />
            </label>
              <span className="pg__note" id="pg-seed-note">Same id, same bot. Typing an agent's id draws its bot; in a crew, a sibling that would look like another gets a variant.</span>
          </div>
          <Group legend="Role" note="Changes the odds: planners wear the crown, leads the flag.">
            {ROLES.map((r) => (
              <Seg key={r} name="role" checked={t.role === r} onChange={() => change(botTraits(t.seed, r))}>{r}</Seg>
            ))}
          </Group>
          <Group legend="Size">
            {SIZES.map(([s, l]) => <Seg key={s} name="size" checked={size === s} onChange={() => setSize(s)}>{l}</Seg>)}
          </Group>
          <Group legend="Mood" note="Sets the eyes and the mouth.">
            {(Object.keys(MOODS) as Mood[]).map((m) => (
              <button key={m} type="button" className="pg__chip" aria-pressed={t.eyes === MOODS[m].eyes && t.mouth === MOODS[m].mouth}
                onClick={() => change(setPart(setPart(t, "eyes", MOODS[m].eyes), "mouth", MOODS[m].mouth))}>{MOOD_LABEL[m]}</button>
            ))}
          </Group>
          <p className="pg__note pg__legend-note">Each tile previews the part on this bot. A lighter tile means picking it changes another part too, to keep the bot valid.</p>
          {PART_SLOTS.map((slot) => <Parts key={slot} slot={slot} t={deferred} current={t[slot]} onPick={(id) => change(setPart(t, slot, id))} />)}
        </form>
      </section>

      <section className="pg-take" aria-labelledby="pg-take-title">
        <h2 className="big" id="pg-take-title" data-reveal><span>Take it</span> <span>with you.</span></h2>
        <div className="pg-take__grid">
          <div className="pg-take__box" data-reveal>
            <h3>Download</h3>
            <Group legend="Backdrop for PNG">
              {([["none", "Transparent"], ["floor", "Dither floor"], ["paper", "Paper"]] as const).map(([v, l]) => <Seg key={v} name="bg" checked={bg === v} onChange={() => setBg(v)}>{l}</Seg>)}
            </Group>
            <label className="pg__field pg__field--inline" data-ui>
              <span>Scale</span>
              <select value={scale} onChange={(e) => setScale(Number(e.target.value))}>
                {Array.from({ length: 16 }, (_, i) => i + 1).map((s) => { const w = CATALOG.frames[size].w * s; return <option key={s} value={s}>{s}× ({w}×{w} px)</option>; })}
              </select>
            </label>
            <div className="pg__actions">
              <button type="button" className="button" onClick={() => void savePng()} aria-keyshortcuts="D">PNG <kbd>D</kbd></button>
              <button type="button" className="button button--ghost" onClick={saveSvg}>SVG</button>
            </div>
            <p className="pg__hint">Pixel-perfect: each cell becomes a {scale}×{scale} square, never smoothed. SVGs are transparent and scale crisply.</p>
          </div>
          <div className="pg-take__box" data-reveal>
            <h3>Share</h3>
            <label className="pg__field" data-ui>
              <span>Link to this bot</span>
              <input type="text" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <div className="pg__actions">
              <button type="button" className="button" onClick={() => void copy()} aria-keyshortcuts="C">Copy link <kbd>C</kbd></button>
              {canShare && <button type="button" className="button button--ghost" onClick={() => void navigator.share({ title: `${t.name}, a capcomd bot`, url: link }).catch(() => {})}>Share…</button>}
            </div>
            <p className="pg__hint">The link holds the id, the role, every part and the size, so it redraws exactly this bot.</p>
          </div>
        </div>
      </section>

      <p className="pg__brand">{SITE.brand}</p>
      <section className="pg-crew" aria-labelledby="pg-crew-title">
        <div className="pg-crew__head">
          <h2 className="big" id="pg-crew-title" data-reveal><span>Your crew.</span></h2>
          <p>{crewTraits.length ? `${crewTraits.length} of ${CREW_MAX}. Kept in this browser only.` : `Add up to ${CREW_MAX} bots. They stay in this browser.`}</p>
        </div>
        {crewTraits.length > 0 ? (
          <>
            <ul className="pg-crew__list">
              {crewTraits.map(({ code: key, bot: { traits: c, size: cs } }) => (
                <li key={key}>
                  <button type="button" className="pg-crew__bot" onClick={() => { setT(c); setSize(cs); setSeedText(c.seed); setCheer(false); setPulls((n) => n + 1); window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }}
                    aria-label={`Open ${c.name}, ${c.role}`}>
                    <span className="floor" aria-hidden="true" />
                    <span className="pg-crew__svg" dangerouslySetInnerHTML={{ __html: svgOf(c, "full") }} />
                  </button>
                  <span className="pg-crew__name">{c.name}<small>{c.role}</small></span>
                  <button type="button" className="pg-crew__x" aria-label={`Remove ${c.name} from your crew`}
                    onClick={() => setCrew((cur) => { const next = cur.filter((x) => x !== key); writeCrew(next); return next; })}>×</button>
                </li>
              ))}
            </ul>
            <div className="pg__actions">
              <button type="button" className="button" onClick={async () => { download(await crewPng(crewTraits.map((x) => x.bot.traits)), "capcomd-crew.png"); flash("Saved capcomd-crew.png"); }}>Crew as one PNG</button>
              <button type="button" className="button button--ghost" onClick={() => { setCrew([]); writeCrew([]); }}>Clear crew</button>
            </div>
          </>
        ) : <p className="pg-crew__empty">Your crew is empty. Pull a bot you like and press <kbd>S</kbd>.</p>}
      </section>

      <p className="pg__status" role="status" aria-live="polite">{status}</p>
      <div className="pg__keys">
        <label className="pg__switch"><input type="checkbox" checked={keys} onChange={(e) => setShortcuts(e.target.checked)} /> <span>Single-key shortcuts</span></label>
        <p><kbd>R</kbd> pull · <kbd>S</kbd> add to crew · <kbd>C</kbd> copy link · <kbd>D</kbd> download PNG</p>
      </div>
    </>
  );
}

function Group({ legend, note, children }: { legend: string; note?: string; children: ReactNode }) {
  return (
    <fieldset className="pg__group">
      <legend>{legend}</legend>
      {note && <p className="pg__note">{note}</p>}
      <div className="pg__seg" data-ui>{children}</div>
    </fieldset>
  );
}

function Seg({ name, checked, onChange, children }: { name: string; checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className="pg__opt">
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span>{children}</span>
    </label>
  );
}

/** One slot: every part in the catalog, each previewed on this bot. A part that clashes still works: another part gives way. */
function Parts({ slot, t, current, onPick }: { slot: PartSlot; t: BotTraits; current: string; onPick: (id: string) => void }) {
  const parts = CATALOG.slots[slot];
  const thumbs = useMemo(() => parts.map((p) => {
    const preview = p.id === t[slot] ? t : setPartSafe(t, slot, p.id);
    return svgOf(preview, slot === "legs" || slot === "pose" || slot === "torso" || slot === "plate" || slot === "dither" ? "full" : "small");
  }), [parts, slot, t]);
  return (
    <fieldset className="pg__group pg__parts">
      <legend>{SLOT_LABEL[slot]} <span className="pg__current"><span className="sr">, now: </span>{partOf(slot, current).label}</span></legend>
      <div className="pg__grid" data-ui>
        {parts.map((p, i) => {
          const ok = fits(t, slot, p.id);
          return (
            <label key={p.id} className={`pg__part${ok ? "" : " pg__part--moves"}`} title={ok ? p.label : `${p.label} (another part gives way)`}>
              <input type="radio" name={`part-${slot}`} checked={current === p.id} onChange={() => onPick(p.id)} />
              <span className="pg__thumb" dangerouslySetInnerHTML={{ __html: thumbs[i]! }} />
              <span className="pg__plabel">{p.label}{ok ? "" : <span className="sr"> (another part gives way)</span>}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const setPartSafe = (t: BotTraits, slot: PartSlot, id: string) => { try { return setPart(t, slot, id); } catch { return t; } };
