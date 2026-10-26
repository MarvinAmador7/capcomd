# Bot avatars: brand proposal

**Status: proposal for review, not approved.** Nothing here changes `../SPEC.md` or the Swift app yet. When the
direction is approved, the approved parts move into SPEC.md and the menu bar app's Swift renderer gets ported from
`packages/bot-avatar`.

Every agent gets a generated pixel bot: same agent id, same bot, forever. The bots come from the capcomd brand material
(the dome-headed bot family with visor screens, cyan eyes, blush and antennas; orange and purple; dithered shading),
and they are drawn by a small deterministic engine from a catalog of body parts.

| Sheet | What it shows |
|---|---|
| `directions.png` | The three directions, side by side, and the recommendation |
| `panel-tree.png` | The approved panel (`tree-card-v3`) with an avatar in every tree row |
| `thread.png` | The approved thread (`thread-panel-v2`): a 24 pt bust in the header, the child's bust on its handoff card, the spawned heads on the spawn row |
| `mention.png` | The approved input states (`thread-input`) with avatars in the `@` popover |
| `moments.png` | Empty state, "meet your team" at a run's start, the run-finished celebration |
| `menubar.png` | The menu bar mark, on dark and light bars, idle / approvals / open |
| `catalog.png`, `catalog-body.png` | Every part in the catalog, the grids and anchors, palettes, dither styles, glyphs, names |
| `contact-sheet.png` | 48 seeds at every size at 1x and 2x, and what the role changes for the same seed |

## Direction

Three ways to make it fun (see `directions.png`):

- **A · Badges.** Avatars replace the profile icons wherever an agent is named. Nothing else changes.
- **B · Identity moments (recommended).** A, plus a few moments where the bots and the pixel language take the stage:
  the empty state, "meet your team" when a run starts, the run's finish, the menu bar mark. Everywhere people
  read and act, the app stays the approved macOS panel.
- **C · Arcade.** Pixel type, dithered fills, scanlines, stepped borders everywhere. The most distinctive, and it
  fights vibrancy, Dynamic Type, Increase Contrast and the HIG.

B keeps the polish where people work and spends the fun where there is room for it. It is also the step toward a
character the agents can grow into (moods, a team that cheers), without committing the whole UI to a game skin.

### Where pixel art is allowed

- Avatars: tree rows, the `@` popover, chips, the thread header, handoff cards, the spawn row.
- Identity moments: empty states, "meet your team", a run's finish, the menu bar mark, the wordmark.
- Nowhere else. No pixel type for UI text, no dithered backgrounds behind text, no pixel borders on controls, no
  pixel icons in place of the approved SF Symbols for steps and status.

### Rules that don't change

- SF Pro and SF Mono for all text. Materials, spacing, radii, hierarchy: as approved.
- Status is shown by the existing status marks (blue ring, red ✕, clock, amber hand). An avatar never carries state
  alone. Moods (sleepy when queued, "oops" when failed, happy when done) may reinforce a mark, never replace it.
- Lowercase profile names stay the row's name; the bot's name ("Ziggy") is secondary (thread header, tooltip).
- Motion: transform and opacity only, ease-out, under 300 ms, Reduce Motion → a 150 ms crossfade, nothing animates on
  keyboard actions. Moments play once and never loop; the menu bar mark never animates.

## Sizes

| Use | Size | Drawing | Cell |
|---|---|---|---|
| Tree rows, `@` popover, chips, spawn row | 14 pt (in the 16 pt icon column) | `xs`, 14×14, head only | 1 pt |
| Thread header, handoff card | 24 pt (centred in a 28 pt slot where one is wanted) | `small`, 24×24, head and shoulders | 1 pt |
| Empty state, meet your team, run finished | 64 pt or 96 pt | `full`, 32×32, whole body | 2 pt or 3 pt |
| Menu bar | 16 pt | fixed 16×16 template mark | 1 pt |

Render crisp: cells only ever scale by whole numbers (1 cell = 1 or 2 device pixels at 14–24 pt), nearest-neighbour /
`shape-rendering: crispEdges`, never a smoothed downscale. A size that isn't a whole multiple (18, 28 pt) centres the
drawing in the slot instead of scaling it. xs is its own drawing, not a shrunk small.

## Measured from the brand material

Sampled from the source images (cell pitch by edge autocorrelation; colours from 5×5 medians at cell centres):

| Source | Pitch | Grid |
|---|---|---|
| xs bots | ≈ 11.9 px | ≈ 17×19 cells (head + letter block) |
| small bots | ≈ 5.2 px | ≈ 42×42 |
| full-body bots | ≈ 3.25 px | ≈ 75 rows |
| wordmark | ≈ 14.4 px | 10 cells tall |
| pattern sheets | 4.5–5.2 px | |

Our grids are smaller (14, 24, 32) so they land on whole points at the real sizes; the proportions follow the
sources (big dome head, visor ≈ 2/3 of the head's width, short body, feet, a dithered floor shadow).

Shading in the sources is a 2×2 checkerboard (orange into purple in the "mix" bots, highlight dots on domes) and an
ordered dither on gradients; the floor shadow is a checker ellipse.

## Palette tokens

Sampled, then lifted a step where a colour vanished on the dark HUD (the sources sit on pure black).

| Token | Value | Sampled from |
|---|---|---|
| orange base / highlight / shade | `#FF7410` / `#FFB566` / `#C8530E` | wordmark `#FF6E00`–`#FF7000`; bots `#FA6A0C`, `#F79228`; highlight `#FFC07F`; shade `#C14B09`–`#CE531F` |
| purple base / highlight / shade | `#9457DC` / `#CDAAF5` / `#5E2BA8` | small bots `#9153CD`–`#9C5ED6`; highlight `#CCA9E8`; xs `#732EBD` |
| deep purple (plates, plum screen) | `#2B0E57`, `#2A0D52` | xs visor `#330E5E` |
| visor (night) | `#07101A` | full-body visor `#040E14`–`#050C14` |
| eye cyan / glint / mouth | `#36D6DE` / `#ECFFFE` / `#5DE2DF` | `#34D3DC`, `#ECFFFE`, `#5DE2DF` |
| blush | `#C065D0` | `#B862CA`–`#BB63CD` |
| metal (ears, stems) | `#BDB7BC` / `#857D81` / `#4F494C` | brand board ears `#6C6366`–`#7B7271` |
| ink outline | `#0E0818` | |
| floor shadow | black at 35 % | the board's checker shadow |

Seven palettes: orange (primary), purple, orange / purple, purple / orange (the brand mixes: one colour dithers into
the other in shadows), and three extras that keep orange or purple as the accent: lavender, steel, ivory. Amber, blue
and red bodies are left out on purpose: those colours mean approval, current and failure in this app.

Contrast (tested in `packages/bot-avatar/test/engine.test.ts`): eyes on their screen ≥ 4.4:1; the screen (or its
bezel) on every body it can sit on ≥ 3:1; every body's highlight ≥ 4.5:1 and base ≥ 2.5:1 on the lightest HUD row
background. Small and full add a one-cell ink outline.

## The catalog

`packages/bot-avatar/src/catalog.ts`, exported expanded to `packages/bot-avatar/fixtures/catalog.json` (format
`bot-catalog/1`). Parts are pixel rows (one character per cell, `.` empty, letters are colour slots), with anchor
points; every head puts its visor at the same rect, so every face fits every head.

| Slot | Parts |
|---|---|
| head | 6: dome, round, square, octagon, capsule, helm |
| screen | 3: night (cyan eyes), plum (white eyes), lilac (ink eyes, bezel) |
| eyes | 9: ovals, dots, wide, happy, wink, sleepy, squint ><, scanner bar, hearts |
| mouth | 7: smile, small, grin, cat ω, flat, o, none |
| blush | 2 |
| ears | 4: metal disc, pod, bolt, none |
| antenna | 8: ball, dual, bolt, tab, dish, none, crown (planner), flag (lead) |
| accessory | 8: none, cap, hard hat, headlamp, party hat, bow, monocle, headphones |
| torso | 3: round, box, slim |
| chest plate | 6: heart, capcomd mark, letter block (name initial), pulse screen, vent, none |
| pose | 4: idle, wave, thumbs up, cheer (moments only) |
| legs | 3: boots, hover jet, treads |
| palette | 7 |
| dither | 4: checker, Bayer 4×4, scanline, flat |
| names | 64 |

74 parts in 14 slots: 3.5 billion raw combinations; after the exclusion rules and role weights, 23.5 million for
planners, 70.5 million for leads and about 530 million for each specialist role.

Rules: a part can `occupy` zones (top, side, ears, eyeR; two parts never share one), `require` or `exclude` parts of
another slot (the cap needs a rounded head; the monocle needs open eyes; the lilac screen is never on a purple body;
the helm's crest takes no tall antenna). Role weights: planners always get the crown and leads the flag, and nobody
else does; planners lean orange (the brand's parent bot), critics lean purple, square heads, dishes and monocles,
workers lean hats, headlamps and treads.

## The engine

`packages/bot-avatar` (private, pure TypeScript, no dependencies; covered by `bun run typecheck` and
`bun run test:fast`).

```ts
import { botSvg, botTraits, botTeam, botGrid, gridSvg } from "@capcomd/bot-avatar";

botSvg({ seed: agentId, role: profile, size: "xs" });              // 14×14 pt, role="img" aria-label="Ziggy, lead"
botSvg({ seed, role, size: "full", scale: 2, mood: "happy", pose: "cheer", accessory: "party" });
botSvg({ seed, role, size: "xs", decorative: true });               // next to text that already names the agent
const team = botTeam(agentsInSpawnOrder);                           // siblings made distinct
botSvg({ seed: a.id, size: "small", traits: team[i] });
```

- `botTraits(seed, role)` → which part fills each slot, plus a name. `botGrid(traits, size)` → a w×h grid of palette
  indices. `gridSvg` / `botSvg` → an SVG string: one `<path>` per colour, crisp edges, `role="img"` + `aria-label`
  (or `aria-hidden`), no scripts, styles or external references; ≤ 2 KB at xs, 4 KB small, 6 KB full.
- **Determinism.** `h32(s)` = MurmurHash3's `fmix32` over FNV-1a 32 of the UTF-8 bytes. Each slot is a weighted
  rendezvous pick: candidate `c` with integer weight `w` scores `max(h32(seed␟slot␟c.id␟k) for k < w)` (␟ = U+001F);
  the highest wins, ties to the earlier one. So a part wins with probability w/Σw, and adding a part repaints only
  the bots it wins (tested). Slots are picked in a fixed order and filtered by the rules against earlier picks.
  Shading is integer math (a light value from the cell's position in its sprite, a 4×4 Bayer matrix). `mulberry32`,
  seeded by `h32`, only lays out decoration (confetti), never picks parts.
- **Forever.** Same seed + role + catalog version → same bot, in any language. Append parts, never edit or reorder
  them; anything that changes an existing bot fails the golden test and is a catalog version bump.
- **Teams.** `botTeam` keeps each agent's own bot unless it looks like one earlier in the list (the same name; the
  same palette and fewer than three other differences in head, eyes, headgear, screen, ears; or a different palette
  and nothing else different); then it takes the first variant seed `id#k` that doesn't.
  Earlier agents never change, so pass agents in spawn order.
- **Moments.** `mood` (happy, sleepy, oops, love) swaps eyes and mouth; `pose` and `accessory` overrides keep the bot
  valid: a party hat replaces an ordinary antenna, never the crown or the flag.

### For the Swift renderer

Read `fixtures/catalog.json`; port `hash.ts` and `engine.ts` (about 300 lines); draw the grid into a bitmap with
nearest-neighbour scaling (no SVG parsing needed). `fixtures/golden/bots.json` has hash and PRNG vectors, traits and
pixel rows for 10 seeds × roles at every size, a team, a moment, three SVG strings and the menu bar mark: match them
byte for byte. Refresh after an intended change with `bun packages/bot-avatar/scripts/golden.ts`.

## Re-rendering

```bash
cd apps/menubar/design
bun tools/genbrand.ts                      # writes brand/*.html (reads the approved HTML, never writes it)
tools/render.sh brand/panel-tree 760 820
tools/render.sh brand/thread 760 680
tools/render.sh brand/mention 1240 270
tools/render.sh brand/moments 1240 600
tools/render.sh brand/menubar 1240 540
tools/render.sh brand/directions 1240 700
tools/render.sh brand/catalog 1240 1960
tools/render.sh brand/catalog-body 1240 1720
tools/render.sh brand/contact-sheet 1240 2080
python3 tools/quantize.py brand/*.png       # 256-colour PNGs before committing
```

The mockups set SF Pro / SF Mono (the app's fonts) so they render true on a Mac; the approved HTML names Inter and
JetBrains Mono.

## Open questions

1. Direction B, A or C? And which moments ship first (empty state and the finish are the cheapest).
2. Bot names: show them (thread header, tooltip, VoiceOver "lead Ziggy") or keep only profiles?
3. Moods following status (sleepy when queued, oops when failed): yes, or always the bot's own face?
4. The menu bar mark: adopt the bot head, or keep the ring?
5. Is the brand material (bot family, palette, wordmark) fine to derive from in this public repo? Only redrawn data
   is committed here, never the source files.
6. Extra palettes (lavender, steel, ivory): keep, or orange and purple only?
