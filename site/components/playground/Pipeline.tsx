"use client";

// "How bots are drawn": the avatar engine (packages/bot-avatar) as a pipeline, worked on the bot on the stage, so every
// value below is the engine's own output for it. Each step names the function that does it; nothing here is a stage
// the code doesn't have. The draw-order strip under the grid step is botGrid()'s layer order.
import { useMemo } from "react";
import { CATALOG, MOODS, botGrid, botSvg, candidates, h32, weightOf, type BotTraits, type Part, type PartSlot, type Size, type Slot } from "@/lib/vendor/bot-avatar.js";
import { PART_SLOTS, partIcon, partOf } from "@/lib/playground";

const hex = (n: number) => "0x" + (n >>> 0).toString(16).padStart(8, "0"); // taste-skill-ignore: a hash, written as hex
const label = (s: PartSlot, id: string) => partOf(s, id).label.replace(/ \(.*\)$/, "");
const svgAt = (t: BotTraits, size: Size) => botSvg({ seed: t.seed, role: t.role, size, traits: t, decorative: true }).replace(/ width="\d+" height="\d+"/, "");

/** botGrid()'s draw order, top of the list drawn first. Parts that draw nothing at a size are skipped there. */
const ORDER: Array<[string, PartSlot | null, string]> = [
  ["Ground shadow", null, "full only"],
  ["Torso", "torso", ""], ["Legs", "legs", "at the hip"], ["Chest plate", "plate", "letter glyph at full"], ["Arms", "pose", "mirrored left"],
  ["Head", "head", ""], ["Ears", "ears", "mirrored left"], ["Blush", "blush", "on the visor"], ["Eyes", "eyes", "on the visor"], ["Mouth", "mouth", "on the visor"],
  ["Antenna", "antenna", "at the top"], ["Accessory", "accessory", "top, side or eye"], ["Ink outline", null, "small and full"],
];

export function Pipeline({ t }: { t: BotTraits }) {
  const data = useMemo(() => {
    // Weighted draws, as botTraits() does them: candidates filtered by the parts already picked, each won with
    // probability weight / Σ weights.
    const picked: Array<[Slot, Part]> = [];
    const draws = PART_SLOTS.map((s) => {
      const c = candidates(s, t.role, picked);
      const me = c.find((x) => x.id === t[s]);
      if (me) picked.push([s, me]);
      return { slot: s, id: t[s], w: me ? weightOf(me, t.role) : 0, total: c.reduce((n, x) => n + weightOf(x, t.role), 0), fit: c.length, all: CATALOG.slots[s].length };
    });
    const full = botGrid(t, "full");
    const svg = botSvg({ seed: t.seed, role: t.role, size: "full", traits: t });
    return {
      draws, colours: full.palette.length, filled: full.px.filter((v) => v >= 0).length,
      paths: (svg.match(/<path /g) ?? []).length, bytes: new Blob([svg]).size,
      sizes: (["xs", "small", "full"] as Size[]).map((s) => ({ s, w: CATALOG.frames[s].w, svg: svgAt(t, s) })),
      icons: Object.fromEntries(PART_SLOTS.map((s) => [s, partIcon(t, s)])) as Record<PartSlot, string>,
    };
  }, [t]);
  const show = (s: PartSlot) => data.draws.find((d) => d.slot === s)!;
  const filtered = data.draws.filter((d) => d.fit < d.all).slice(0, 2);
  const mood = (Object.keys(MOODS) as Array<keyof typeof MOODS>).find((m) => MOODS[m].eyes === t.eyes && MOODS[m].mouth === t.mouth);

  return (
    <section className="pg-about" aria-labelledby="pg-about-title">
      <div className="pg-about__head">
        <h2 className="big" id="pg-about-title" data-reveal><span>How bots</span> <span>are drawn.</span></h2>
        <p data-reveal>The engine in <code>packages/bot-avatar</code>, step by step, on <b>{t.name}</b>, the {t.role} on the stage above. Same id, same bot, forever: every step is integer math on a hash, so the menu bar app&apos;s Swift port draws the same pixels.</p>
      </div>

      <figure className="pipe" aria-labelledby="pipe-cap">
        <ol className="pipe__steps">
          <li className="pipe__step">
            <p className="pipe__fn"><code>h32(id)</code></p>
            <h3>Hash the id</h3>
            <p>FNV-1a over the id&apos;s UTF-8 bytes, finished with MurmurHash3&apos;s <code>fmix32</code>. Every later choice hashes the seed again with its own key.</p>
            <dl className="pipe__out"><div><dt>id</dt><dd><code>{t.seed}</code></dd></div><div><dt>h32</dt><dd><code>{hex(h32(t.seed))}</code></dd></div></dl>
          </li>
          <li className="pipe__step pipe__step--focal">
            <p className="pipe__fn"><code>botTraits(seed, role)</code></p>
            <h3>Draw 14 parts</h3>
            <p>Slots in a fixed order, each a weighted rendezvous pick: a part&apos;s score is its best <code>hkey(seed, slot, part, k)</code> for <i>k</i> below its weight; the top score wins. The role sets the weights: only planners get the crown, only leads the flag.</p>
            <dl className="pipe__out">
              {(["palette", "antenna", "head"] as PartSlot[]).map((s) => <div key={s}><dt>{s}</dt><dd>{label(s, show(s).id)} <span>{show(s).w}/{show(s).total}</span></dd></div>)}
            </dl>
          </li>
          <li className="pipe__step">
            <p className="pipe__fn"><code>compatible()</code></p>
            <h3>Keep it valid</h3>
            <p>Before each pick, parts drop out that the role never gets (weight 0) or that clash with earlier picks: zones they occupy, parts they require or exclude. Editing here uses <code>withPart()</code>: a part that no longer fits gives way to the first one that does.</p>
            <dl className="pipe__out">
              {filtered.length ? filtered.map((d) => <div key={d.slot}><dt>{d.slot}</dt><dd>{d.fit} of {d.all} drawable</dd></div>) : <div><dt>this bot</dt><dd>nothing filtered</dd></div>}
            </dl>
          </li>
          <li className="pipe__step">
            <p className="pipe__fn"><code>botTeam(members)</code></p>
            <h3>Tell siblings apart</h3>
            <p>In a crew, in spawn order: an agent that looks too much like an earlier one (same name, or too few different parts) is redrawn from <code>seed#1</code> … <code>seed#15</code>. Earlier agents never change.</p>
          </li>
          <li className="pipe__step">
            <p className="pipe__fn"><code>withOverrides()</code></p>
            <h3>Moments</h3>
            <p>A mood swaps eyes and mouth (happy, sleepy, oops, love); a moment can set a pose or a hat, never removing a crown or flag. The run-finished cheer is one.</p>
            <dl className="pipe__out"><div><dt>mood</dt><dd>{mood ?? "none"}</dd></div></dl>
          </li>
          <li className="pipe__step pipe__step--wide">
            <p className="pipe__fn"><code>botGrid(traits, size)</code></p>
            <h3>Paint the grid</h3>
            <p>Each part is pixel rows with anchor points. Shading comes from the dither style and a 4×4 Bayer matrix (xs is flat).</p>
            <div className="pipe__sizes" aria-hidden="true">
              {data.sizes.map((z) => <span key={z.s}><span style={{ width: z.w * 2, height: z.w * 2 }} dangerouslySetInnerHTML={{ __html: z.svg }} /><small>{z.s} {z.w}</small></span>)}
            </div>
            <dl className="pipe__out"><div><dt>full</dt><dd>{data.filled} cells, {data.colours} colours</dd></div></dl>
          </li>
          <li className="pipe__step">
            <p className="pipe__fn"><code>gridSvg()</code></p>
            <h3>Write the SVG</h3>
            <p>Same-colour runs merge into rectangles, one <code>&lt;path&gt;</code> per colour, crisp edges, whole-number scale 1–16, labelled &ldquo;Name, role&rdquo;. This page draws it in your browser; the menu bar app&apos;s Swift port reads the exported catalog and draws a bitmap.</p>
            <dl className="pipe__out"><div><dt>full</dt><dd>{data.paths} paths, {(data.bytes / 1024).toFixed(1)} KB</dd></div></dl>
          </li>
        </ol>

        <div className="pipe__layers">
          <h3 className="pipe__sub">Draw order inside <code>botGrid()</code></h3>
          <ol className="pipe__order">
            {ORDER.map(([name, slot, note]) => (
              <li key={name}>
                <span className="pipe__icon" aria-hidden="true" {...(slot ? { dangerouslySetInnerHTML: { __html: data.icons[slot] } } : {})} />
                <b>{name}</b>{note && <small>{note}</small>}
              </li>
            ))}
          </ol>
        </div>
        <figcaption id="pipe-cap">From an agent id to an SVG, in the engine&apos;s order. Values are the engine&apos;s output for the bot on the stage; weights are this part&apos;s weight over all weights that could be drawn at that step.</figcaption>
      </figure>
    </section>
  );
}
