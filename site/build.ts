// Builds the static site: site/src → site/dist. No dependencies beyond Bun.
//
//   bun site/build.ts            # writes site/dist
//   bun site/build.ts --tools    # also writes site/.tools/ (the pages tools/render.ts photographs for og.png and icons)
//
// The page is complete without JavaScript: the build pre-draws the default crew (packages/bot-avatar), the
// wordmark and the app marks into the HTML; the page script only adds the live crew and the stage disclosures.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { botSvg, botTeam, h32, markSvg, MENU_BAR_MARK } from "../packages/bot-avatar/src/index.ts";
import { CREW_ROLES, DEFAULT_SEED, crewSvg, crewSuffix } from "./src/js/crew.js";
import { wordmarkSvg } from "./src/js/wordmark.js";

const root = import.meta.dir;
const src = join(root, "src"), out = join(root, "dist");
const config = JSON.parse(readFileSync(join(root, "site.config.json"), "utf8")) as { url: string; description: string };
const siteUrl = config.url.replace(/\/+$/, "");
const pkg = JSON.parse(readFileSync(join(root, "..", "package.json"), "utf8")) as { version: string };
const version = pkg.version.split(".").slice(0, 2).join("."); // "0.6"

const CHECK = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M2 6.4 4.8 9 10 3" fill="none" stroke="#30D158" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const wordmark = wordmarkSvg().replace(' role="img" aria-label="capcomd"', ' aria-hidden="true" focusable="false"');

/** Fill the page's art: wordmark, app marks, and the default crew drawn from DEFAULT_SEED. */
async function render(html: string, seed = DEFAULT_SEED): Promise<string> {
  const team = botTeam(CREW_ROLES.map((role, i) => ({ seed: `${seed}/${i}`, role })));
  const svg = (i: number, size: "xs" | "small" | "full", o: Record<string, string> = {}) => crewSvg(botSvg, seed, team, i, size, o);
  const set = (fn: (el: HTMLRewriterTypes.Element) => string) => ({ element(el: HTMLRewriterTypes.Element) { el.setInnerContent(fn(el), { html: true }); } });
  const rw = new HTMLRewriter()
    .on("[data-wordmark]", set(() => wordmark))
    .on("[data-menumark]", set(() => markSvg(MENU_BAR_MARK, { color: "#FFFFFF" }).replace(/ width="\d+" height="\d+"/, "") + "1"))
    .on("[data-mark-face]", set(() => markSvg(MENU_BAR_MARK, { color: "currentColor" }).replace(/ width="\d+" height="\d+"/, "")))
    .on("[data-check]", set(() => CHECK))
    .on("#crew", set(() => [0, 1, 2, 3].map((i) => `<span style="--k:${i}">${svg(i, "full", i === 0 ? { pose: "wave" } : {})}</span>`).join("")))
    .on("[data-crew]", set((el) => svg(+el.getAttribute("data-crew")!, "full", el.getAttribute("data-pose") ? { pose: el.getAttribute("data-pose")! } : {})))
    .on("[data-xs]", set((el) => svg(+el.getAttribute("data-xs")!, "xs")))
    .on("[data-face]", set((el) => svg(+el.getAttribute("data-face")!, "small")))
    .on("[data-tile]", set(() => svg(0, "small")))
    .on("[data-name]", set((el) => crewSuffix(h32, seed, +el.getAttribute("data-name")!)))
    .on("[data-sleepy]", set(() => `<span class="floor"></span>` + botSvg({ seed: `${seed}/0`, role: "planner", size: "full", mood: "sleepy", decorative: true }).replace(/ width="\d+" height="\d+"/, "")));
  const filled = await rw.transform(new Response(html)).text();
  return filled
    .replaceAll("{{SITE_URL}}", siteUrl)
    .replaceAll("{{DESCRIPTION}}", config.description)
    .replaceAll("{{VERSION}}", version)
    .replaceAll("{{SEED}}", seed);
}

const minifyCss = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{};,>])\s*/g, "$1").replace(/;}/g, "}").trim();
const write = (path: string, data: string | Uint8Array) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });

// Styles and script, fingerprinted so hosts can cache them for good.
const hashed = (name: string, body: string) => { const [base, ext] = name.split("."); return `${base}.${Bun.hash(body).toString(16).slice(0, 10)}.${ext}`; };
const css = minifyCss(readFileSync(join(src, "styles.css"), "utf8"));
const js = await Bun.build({ entrypoints: [join(src, "js", "main.js")], minify: true, target: "browser", format: "esm" });
if (!js.success) { console.error(js.logs); process.exit(1); }
const jsText = await js.outputs[0]!.text();
const cssName = hashed("styles.css", css), jsName = hashed("main.js", jsText);
if (process.argv.includes("--tools")) write(join(out, "assets", cssName), css); // only the tool pages link it
write(join(out, "assets", jsName), jsText);

// Pages
for (const page of ["index.html", "404.html"]) {
  // The stylesheet is inlined: one request fewer before the first paint (a one-page site gains more than it loses in caching).
  const html = (await render(readFileSync(join(src, page), "utf8")))
    .replace('<link rel="stylesheet" href="/assets/styles.css">', `<style>${css}</style>`)
    .replaceAll("/assets/main.js", `/assets/${jsName}`);
  write(join(out, page), html);
}

// Fonts (with their licences), static images, favicon
cpSync(join(src, "fonts"), join(out, "fonts"), { recursive: true });
if (existsSync(join(src, "static"))) cpSync(join(src, "static"), out, { recursive: true });
const mark = markSvg(MENU_BAR_MARK, { color: "#FF7410" }).match(/<path[^>]*\/>/)![0];
write(join(out, "favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" rx="3" fill="#2B0E57"/>${mark}</svg>\n`);
write(join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap.xml\n`);
write(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteUrl}/</loc></url></urlset>\n`);

// Source pages for tools/render.ts (og.png, the PNG icons): same art, same fonts.
if (process.argv.includes("--tools")) {
  const tools = join(root, ".tools");
  rmSync(tools, { recursive: true, force: true });
  for (const page of ["og.html", "icon.html"]) write(join(tools, page), (await render(readFileSync(join(root, "tools", page), "utf8"))).replaceAll("/assets/styles.css", `/assets/${cssName}`));
  write(join(tools, "favicon.svg"), readFileSync(join(out, "favicon.svg")));
}

if (siteUrl.includes("example")) console.warn(`site.config.json: url is still the placeholder (${siteUrl}); set it before publishing.`);
console.log(`built ${out} (capcomd ${version}, crew ${DEFAULT_SEED})`);
