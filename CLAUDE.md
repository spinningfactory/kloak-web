# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kloak Web is the website and documentation for [Kloak](https://github.com/spinningfactory/kloak), a Kubernetes eBPF secret interceptor. The repo contains three independently structured sites deployed together to Cloudflare Pages at `getkloak.io`:

- **Landing page** (`/website/`) — static HTML/CSS/JS, no build system
- **Documentation site** (`/docs/`) — VitePress (Vue-based static site generator)
- **Blog** (`/blog/`) — Astro with Content Collections

## Commands

All doc commands run from the `/docs/` directory:

```bash
cd docs && npm ci           # Install dependencies
cd docs && npm run dev      # Start dev server (hot reload)
cd docs && npm run build    # Production build (output: docs/.vitepress/dist/)
cd docs && npm run preview  # Preview production build locally
```

Blog commands run from the `/blog/` directory:

```bash
cd blog && npm ci           # Install dependencies
cd blog && npm run dev      # Start dev server (http://localhost:4321/blog/)
cd blog && npm run build    # Production build (output: blog/dist/)
cd blog && npm run preview  # Preview production build locally
```

The landing page has no build step — edit HTML/CSS/JS directly in `/website/`.

To produce the full deployable site locally, run the same script Cloudflare Pages runs:

```bash
bash build.sh   # outputs the full assembled site at _site/
```

## Architecture

### Deployment

Cloudflare Pages is connected to this repo. On every push to `main`, Cloudflare runs `bash build.sh` and serves the resulting `_site/` directory at `getkloak.io`. PRs auto-deploy to preview URLs at `<branch-or-pr>.kloak-web.pages.dev`.

- **Build entry point:** `build.sh` at repo root — builds VitePress docs, Astro blog, then assembles `_site/`
- **Node version:** pinned via `.nvmrc` (Node 20)
- **Security headers:** `_headers` at repo root, copied into `_site/` by `build.sh`, applied by Cloudflare Pages
- **Custom domain:** `getkloak.io` (configured in the Cloudflare Pages dashboard, not via a CNAME file)

### Documentation Site (`/docs/`)

- **Config:** `docs/.vitepress/config.ts` — nav, sidebar, base path (`/docs/`), dark-mode-only
- **Theme:** `docs/.vitepress/theme/` — extends VitePress DefaultTheme with custom CSS (teal/dark branding)
- **Content structure:** `getting-started/`, `guides/`, `tutorials/`, `architecture/`, `reference/`
- **Diagrams:** Mermaid syntax in markdown

### Landing Page (`/website/`)

- `index.html` — single-page layout with hero, features, architecture overview, CTAs
- `styles.css` — CSS variables, dark theme, responsive grid
- `app.js` — navbar scroll effect, mobile menu toggle, scroll animations
- Links to `/docs/` for documentation, `/blog/` for the blog, and GitHub for the main Kloak repo

### Blog (`/blog/`)

- **Config:** `blog/astro.config.mjs` — `base: '/blog'`, sitemap integration, Shiki dark theme
- **Schema:** `blog/src/content.config.ts` — Content Collection with frontmatter validation (title, description, pubDate, author, tags, draft)
- **Posts:** `blog/src/content/blog/<slug>/index.md` (folder-per-post so images can be co-located and Astro auto-optimizes them)
- **Layouts:** `BaseLayout` (shared chrome) and `PostLayout` (centered article with reading-optimized typography)
- **Pages:** index (hero + featured + grid + tags), `[...slug]` (post detail), `tag/[tag]`, `rss.xml`
- **Styling:** mirrors landing-page design tokens (Inter, dark theme, teal/blue accents) — see `blog/src/styles/global.css`

## Key Details

- Node 20 is used in CI (pinned via `.nvmrc`)
- VitePress base path is `/docs/` — all internal doc links must account for this
- The site uses dark mode only (configured in VitePress and custom CSS)
- Brand color is teal/blue (`#1782CE`)
- Kloak uses ULIDs (not UUIDs) throughout documentation
