# capcomd launch site

A static site: `src/` is built into `dist/`, a plain folder any static host can serve. The only tool it needs is Bun
(already used by this repository), and it has no dependencies of its own.

```sh
cd site
bun run build      # src → dist
bun run preview    # build, then serve dist on http://127.0.0.1:4173 (PORT=… to change); missing paths get 404.html
bun run images     # re-render src/static/og.png and the PNG icons in headless Chrome (only when the art changes)
```

## What's where

| Path | What |
|---|---|
| `src/index.html`, `src/404.html` | The pages. `{{SITE_URL}}`, `{{DESCRIPTION}}`, `{{VERSION}}` and `{{SEED}}` are filled in by the build. |
| `src/styles.css` | All styles, minified and inlined into each page (one request fewer before the first paint). |
| `src/js/main.js` | The page script, bundled with `packages/bot-avatar` into `dist/assets/main.<hash>.js`: the live crew, the run's five stages, the entrances. The page is complete without it. |
| `src/js/crew.js`, `src/js/wordmark.js` | Shared by the page and the build: which roles the crew has, and the pixel wordmark. |
| `src/fonts/` | Bebas Neue and EB Garamond, latin subsets (woff2), self-hosted, with their SIL Open Font License texts. |
| `src/static/` | Copied to the site root as is: `og.png` (1200×630), `favicon-32.png`, `apple-touch-icon.png`. |
| `build.ts` | The build. It pre-draws the default crew (`run_7e9410`) with the avatar engine, so the bots are in the HTML. It also writes `favicon.svg` (the menu bar bot mark), `robots.txt` and `sitemap.xml`. |
| `preview.ts` | A tiny local static server for `dist/`. |
| `tools/` | `og.html` and `icon.html` (the art for the images) and `render.ts`, which photographs them in headless Chrome. |
| `site.config.json` | The site's origin (for canonical, Open Graph and sitemap URLs) and its description. **The URL is a placeholder until the domain is decided.** |
| `CONTENT.md` | Where each claim on the page comes from, and the sample content to confirm. |
| `directions/` | The art-direction comps (A, B, B2, B3) that led here. They aren't part of the build. |
| `shots/` | Screenshots of the built site. |

The site version ("Early release, 0.6") comes from the root `package.json`, so it follows releases.

## Hosting

Serve `dist/` as is. Set `url` in `site.config.json` first. Use `404.html` as the not-found page. Turn on gzip or
brotli. `assets/` files are fingerprinted, so they can be cached for good. Cache `fonts/` and the images for a long
time too, and the HTML briefly. None of this is configured here, because no host is chosen yet.
