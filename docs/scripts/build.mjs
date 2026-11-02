// Builds every docs version listed in .vitepress/versions.json into
// .vitepress/dist/: the latest at the root, each archived version in
// .vitepress/dist/<version>/. Each version is its own VitePress build (see
// .vitepress/config.ts), selected with DOCS_VERSION.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const versions = JSON.parse(fs.readFileSync(path.join(root, '.vitepress/versions.json'), 'utf8'))
const vitepress = path.join(root, 'node_modules', '.bin', 'vitepress')

// The latest build empties .vitepress/dist, so it must run first.
for (const version of [versions.latest, ...versions.archived]) {
  console.log(`\n=== Building docs ${version}\n`)
  const result = spawnSync(vitepress, ['build'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DOCS_VERSION: version },
  })
  if (result.status !== 0) {
    console.error(`Building docs ${version} failed`)
    process.exit(result.status ?? 1)
  }
}
