import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfigWithTheme, type DefaultTheme } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import versions from './versions.json'
import type { DocsVersion, Versioning } from './theme/versioning'

export interface ThemeConfig extends DefaultTheme.Config {
  versioning: Versioning
}

// Each docs version is a separate VitePress build. DOCS_VERSION picks the
// version (the latest one when unset): the latest docs live in docs/ and are
// served at /docs/, an archived version lives in docs/versions/<version>/ and
// is served at /docs/<version>/. scripts/build.mjs builds all of them.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const current = process.env.DOCS_VERSION || versions.latest
const allVersions = [versions.latest, ...versions.archived]
if (!allVersions.includes(current)) {
  throw new Error(`DOCS_VERSION=${current} is not listed in .vitepress/versions.json`)
}

function srcDirOf(version: string): string {
  return version === versions.latest ? root : path.join(root, 'versions', version)
}

function basePathOf(version: string): string {
  return version === versions.latest ? '/docs/' : `/docs/${version}/`
}

// Markdown pages of a version, relative to its source directory, so the
// version switcher can keep the reader on the same page when it exists in the
// version they switch to.
function pagesOf(version: string): string[] {
  const srcDir = srcDirOf(version)
  const skip = new Set(['node_modules', 'public', 'scripts', 'versions'])
  const pages: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || (dir === srcDir && skip.has(entry.name))) continue
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith('.md')) pages.push(path.relative(srcDir, file).split(path.sep).join('/'))
    }
  }
  walk(srcDir)
  return pages.sort()
}

const sidebar: DefaultTheme.SidebarItem[] = JSON.parse(
  fs.readFileSync(path.join(srcDirOf(current), 'sidebar.json'), 'utf8'),
)

const versioning: Versioning = {
  current,
  latest: versions.latest,
  releasesUrl: 'https://github.com/spinningfactory/kloak/releases',
  versions: allVersions.map((id): DocsVersion => ({
    id,
    path: basePathOf(id),
    latest: id === versions.latest,
    pages: pagesOf(id),
  })),
}

export default withMermaid(defineConfigWithTheme<ThemeConfig>({
  title: 'Kloak',
  description: 'Kubernetes eBPF Secret Interceptor — Documentation',
  base: basePathOf(current),
  srcDir: srcDirOf(current),
  srcExclude: ['versions/**', 'scripts/**'],
  outDir: current === versions.latest ? '.vitepress/dist' : `.vitepress/dist/${current}`,
  appearance: 'force-dark',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/transparent-logo.svg' }],
  ],

  vite: {
    // Shared by every version: Vite looks in <srcDir>/public by default.
    publicDir: path.join(root, 'public'),
  },

  themeConfig: {
    logo: '/transparent-logo.svg',
    siteTitle: 'LOAK Docs',

    nav: [
      ...sidebar.map((group) => ({ text: group.text ?? '', link: group.items?.[0]?.link ?? '/' })),
      { component: 'VersionSwitcher' },
    ],

    sidebar,

    versioning,

    socialLinks: [
      { icon: 'github', link: 'https://github.com/spinningfactory/kloak' },
    ],

    footer: {
      message: 'Released under the GNU AGPL-3.0 License.',
      copyright: 'Copyright 2025-present Kloak Contributors',
    },

    search: {
      provider: 'local',
    },
  },

  mermaid: {
    theme: 'dark',
  },
}))
