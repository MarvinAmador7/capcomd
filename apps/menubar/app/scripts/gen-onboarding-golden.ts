// Runs the onboarding prototype's own script (design/onboarding/onboarding.dc.html) and writes what the Swift port must
// reproduce to Tests/CapcomdOnboardingTests/Fixtures/prototype.json: the pour (seeded heads and sparks), the laptop and
// head sprites, the background circuit pixels and the comets. CapcomdOnboardingTests compares the port with it (the
// sprite rows themselves are read from the HTML by the tests). Run it after the prototype changes:
//
//   bun apps/menubar/app/scripts/gen-onboarding-golden.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const html = readFileSync(join(here, "../../design/onboarding/onboarding.dc.html"), "utf8");
const open = html.indexOf("data-dc-script");
const start = html.indexOf(">", open) + 1;
const end = html.indexOf("class Component", start);
if (open < 0 || end < 0) throw new Error("the prototype's script wasn't found");
const code = html.slice(start, end);

// The prototype's top-level constants and functions, evaluated as they are; nothing else of the page runs.
const out = new Function(`${code}
  return { ROWS, PAL, SCREEN, POUR, BG, COMETS, laptop, head, sprite };`)() as any;

const cells = (shadow: string, p: number) =>
  shadow === "none" ? [] : shadow.split(", ").map((s: string) => {
    const [x, y, , , c] = s.split(" ");
    return [parseInt(x) / p - 1, parseInt(y) / p, c];
  });

const golden = {
  generatedFrom: "apps/menubar/design/onboarding/onboarding.dc.html",
  minis: out.POUR.minis.map((m: any, i: number) => ({
    i, p: m.s.p, color: i % 3 === 1 ? "orange" : "purple",
    dx: m.dx, up: m.up, fall: m.fall, rot: m.rot, delay: Number(m.delay), dur: Number(m.dur), offX: m.offX, offY: m.offY,
  })),
  sparks: out.POUR.sparks.map((s: any) => ({ x: s.x, d: Number(s.d) })),
  laptop: { w: out.POUR.lap.w / 6, h: out.POUR.lap.h / 6, cells: cells(out.POUR.lap.body, 6) },
  head: { orange: cells(out.head("orange", 1).body, 1), purple: cells(out.head("purple", 1).body, 1) },
  sprite: Object.fromEntries(["orange", "purple"].flatMap((c) => ["smile", "happy"].map((m) => {
    const s = out.sprite(c, 1, m);
    return [`${c}-${m}`, { body: cells(s.body, 1), lids: cells(s.lids, 1), face: cells(s.face, 1) }];
  }))),
  bg: { pix: out.BG.pix.map((p: any) => ({ ...p, d: Number(p.d) })), rings: out.BG.rings.map((r: any) => ({ ...r, d: Number(r.d) })) },
  comets: out.COMETS,
};
const file = join(here, "../Tests/CapcomdOnboardingTests/Fixtures/prototype.json");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(golden, null, 1) + "\n");
console.log(`wrote ${file}: ${golden.minis.length} heads, ${golden.sparks.length} sparks, ${golden.bg.pix.length} pixels`);
