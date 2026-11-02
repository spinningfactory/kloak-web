export interface DocsVersion {
  id: string
  // Absolute URL path the version is served at, e.g. /docs/ or /docs/v0.2.0/.
  path: string
  latest: boolean
  // Markdown pages relative to the version's source directory.
  pages: string[]
}

export interface Versioning {
  current: string
  latest: string
  releasesUrl: string
  versions: DocsVersion[]
}

// The URL of the page at relativePath in version, or of the version's home
// page when it has no such page. Each version is a separate build, so these
// links must be followed with a full page load, not the VitePress router.
export function versionHref(version: DocsVersion, relativePath: string, cleanUrls: boolean): string {
  if (!version.pages.includes(relativePath)) return version.path
  const route = relativePath
    .replace(/(^|\/)index\.md$/, '$1')
    .replace(/\.md$/, cleanUrls ? '' : '.html')
  return version.path + route
}

export function versionLabel(version: DocsVersion): string {
  return version.latest ? `${version.id} (latest)` : version.id
}
