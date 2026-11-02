# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kloak Web is the website and documentation for [Kloak](https://github.com/spinningfactory/kloak), a Kubernetes eBPF secret interceptor. The repo contains three independently structured sites deployed together to Cloudflare Workers (Static Assets) at `getkloak.io`:

- **Landing page** (`/website/`) — static HTML/CSS/JS, no build system
- **Documentation site** (`/docs/`) — VitePress (Vue-based static site generator)
- **Blog** (`/blog/`) — Astro with Content Collections

## Commands

All doc commands run from the `/docs/` directory:

```bash
cd docs && npm ci           # Install dependencies
cd docs && npm run dev      # Start dev server for the latest docs (hot reload)
cd docs && DOCS_VERSION=v0.2.0 npm run dev   # Dev server for an archived version
cd docs && npm run build    # Build every version (output: docs/.vitepress/dist/)
cd docs && npm run preview  # Preview the production build locally, all versions
cd docs && npm run new-version -- v0.4.0     # Archive the latest docs, start docs for a new release
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

A Cloudflare Workers project (Static Assets path, in the unified Workers & Pages dashboard) is connected to this repo. On every push to a watched branch, Cloudflare runs `bash build.sh` and uploads the resulting `_site/` directory. Production is `main` → `getkloak.io`. Other branches deploy to preview URLs.

- **Build entry point:** `build.sh` at repo root — builds VitePress docs, Astro blog, then assembles `_site/`
- **Assets directory:** declared in `wrangler.jsonc` as `assets.directory: ./_site` (Workers Static Assets reads this; the dashboard UI does not have a separate "Build output directory" field)
- **Node version:** pinned via `.nvmrc` (Node 20)
- **Security headers:** `_headers` at repo root, copied into `_site/` by `build.sh`, applied automatically
- **Custom domain:** `getkloak.io` (configured in the Cloudflare Workers project's Settings → Domains & Routes)

### Documentation Site (`/docs/`)

- **Config:** `docs/.vitepress/config.ts` — base path, sidebar (read from the version's `sidebar.json`), nav (the first page of each sidebar group), dark-mode-only
- **Theme:** `docs/.vitepress/theme/` — extends VitePress DefaultTheme with custom CSS (teal/dark branding), the version switcher (`VersionSwitcher.vue`, a nav item) and the "older version" banner (`VersionBanner.vue`)
- **Content structure:** `getting-started/`, `guides/`, `tutorials/`, `architecture/`, `reference/`
- **Diagrams:** Mermaid syntax in markdown

#### Versioned docs

The docs are versioned by Kloak release. Each version is a separate VitePress build, selected with the `DOCS_VERSION` env var (`scripts/build.mjs` runs them all):

- `docs/.vitepress/versions.json` lists the `latest` release and the `archived` ones (newest first). Only stable releases get docs, no alphas or betas.
- The latest docs live in `docs/` (pages plus `sidebar.json`) and are served at `/docs/`.
- Each archived version is a frozen copy in `docs/versions/<version>/` (pages plus its own `sidebar.json`), served at `/docs/<version>/`. Fix mistakes there directly; don't backport new features.
- Every version's content describes that release's code (check the kloak repo at the release tag, not `main`), and its install commands pin `--version` to that chart.
- When kloak cuts a release: `npm run new-version -- vX.Y.Z` copies the current latest docs into `versions/<previous latest>/` and makes `vX.Y.Z` the latest; then update the pages in `docs/` for the new release, and rewrite `reference/release-notes.md` with its most important changes (highlights, upgrade notes, fixes, supported versions), linking each to its kloak PR and to the GitHub release.
- The switcher links across builds with plain `<a target="_self">` links (full page loads): VitePress prefixes nav links with the current build's base, which can't point at another version.

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
- VitePress base path is `/docs/` for the latest docs and `/docs/<version>/` for archived ones. Write internal links as `/guides/...`: VitePress adds the base. Link outside the docs (the blog, the landing page) with absolute `https://getkloak.io/...` URLs
- The site uses dark mode only (configured in VitePress and custom CSS)
- Brand color is teal/blue (`#1782CE`)
- Kloak placeholders (v0.2.0+) are `kl::` followed by random characters, with the same byte length (and HPACK Huffman bit length) as the real value. Not ULIDs, UUIDs, or hashes. In v0.1.x they were `kloak:` plus uppercase Crockford Base32 characters from a ULID. Generate realistic examples with kloak's own generator (of that release) rather than inventing them.
- `getkloak.io/enabled` is a label; `getkloak.io/hosts` and `getkloak.io/port` are annotations (v0.2.0+ rejects them as labels; v0.1.2 ignores them as labels; in v0.1.0 and v0.1.1 they were labels).
