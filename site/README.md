# capcomd launch site

A Next.js app (App Router, TypeScript) styled with Tailwind CSS. It's exported as static files (`output: "export"`),
so `out/` can be served by any static host. It has no server features, API routes, middleware, analytics or
host-specific code. It lives in the capcomd repo but has its own `package.json` and lockfile, and it isn't part of a
root workspace.

```sh
cd site
bun install            # the site's own dependencies (exact versions, site/bun.lock)
bun run dev            # http://localhost:4173, with hot reload
bun run build          # static export to out/ (fetches the two Google fonts once, to self-host them)
bun run preview        # serve out/ like a static host on http://127.0.0.1:4173 (gzip; 404.html for missing paths)
bun run typecheck      # tsc --noEmit for the site
bun run vendor         # re-vendor packages/bot-avatar after the avatar engine changes
```

Stack: Next.js 16.4.3, React 19.3.1, Tailwind CSS 4.3.3 (`@tailwindcss/postcss`), TypeScript 7.0.2.

## What's where

| Path | What |
|---|---|
| `app/layout.tsx` | Fonts (`next/font/google`: Bebas Neue and EB Garamond, self-hosted at build time, SIL OFL), metadata (title, description, canonical, Open Graph, Twitter, icons), and the one inline script that marks the page as scripted. |
| `app/page.tsx` | The page: Hero, Run, Sandboxes, RoleTree, AtScale, Patterns, Drive, Footer. |
| `app/globals.css` | Tailwind, the design tokens in `@theme` (colours, type, spacing, easing), and the art direction's components in `@layer components` (the hero slot, the stages, the app panels, the tree), which read only those tokens. Simple layouts such as the footer use utilities. |
| `app/bots/page.tsx`, `components/playground/`, `lib/playground.ts` | The bot playground at `/bots/`: pull a bot from an id and a role, set any of its 14 parts, a mood and a size, keep a crew (localStorage), download SVG or PNG, share a link (`#s=…&r=…&t=…&z=…`) that redraws the bot exactly. Its OG image is `app/bots/og.png/route.tsx`. |
| `components/Nav.tsx` | The navigation, shared by both pages. |
| `app/not-found.tsx` | The 404 page (exported as `404.html`). |
| `app/og.png/route.tsx`, `app/apple-touch-icon.png/route.tsx` | Rendered once at build time with `next/og` into `out/og.png` (1200×630, the hero's art) and `out/apple-touch-icon.png`. They're static GETs, with nothing at runtime. |
| `app/icon.svg` | The favicon: the menu bar bot mark (`MENU_BAR_MARK` in packages/bot-avatar) on a plum tile. |
| `app/robots.ts`, `app/sitemap.ts` | `robots.txt` and `sitemap.xml`, written at build time. |
| `components/` | One component per section. Server components by default, so the copy is in the static HTML and works without JS. The client parts are only `crew.tsx` (the crew, redrawn per visit and on "Draw another", and the typed goal), `RunAccordion.tsx` (the stages, an APG accordion of disclosure buttons) and `Reveals.tsx` (scroll entrances). |
| `lib/site.ts` | **The site's origin, one value. It's a placeholder (`https://capcomd.example`) until the domain is decided (TODO).** Also the title and description. |
| `lib/crew.ts`, `lib/marks.ts` | The crew's roles and default seed (`run_7e9410`, what the static HTML is drawn with), the wordmark, the menu bar mark. |
| `lib/vendor/bot-avatar.js` | packages/bot-avatar, bundled as one ESM file by `bun run vendor` (with hand-written types beside it). |
| `lib/version.ts` | capcomd's version for "Early release, 0.6", read from the repo's root `package.json` at build time. |
| `public/fonts/OFL-*.txt` | The fonts' licences, linked from the footer. |
| `scripts/` | The vendoring script and the preview server (Bun). |
| `CONTENT.md` | Where every claim comes from, and the sample content to confirm. |
| `directions/`, `DIRECTIONS.md` | The art-direction comps (A, B, B2, B3) that led here. They aren't part of the build. |
| `shots/` | Screenshots of the exported site. |

## Notes

Run every command from `site/`: `lib/version.ts` reads `../package.json` and `next.config.ts` roots Turbopack
at the current folder, both relative to it.

## Hosting

Serve `out/` as is. Set `SITE_URL` in `lib/site.ts` first, and use `404.html` as the not-found page. Turn on gzip
or brotli. `_next/static/` is content-hashed, so it can be cached for good. None of this is configured here, because
no host is chosen yet.

## Note for the repo

The root `tsconfig.json` excludes `site/`: the site has its own `tsconfig.json` and `bun run typecheck`, and the root
one would fail on it (it lacks the site's path aliases and React types).
