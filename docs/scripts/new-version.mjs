// Starts the docs for a new Kloak release:
//
//   npm run new-version -- v0.4.0
//
// Copies the current latest docs (the pages and sidebar.json in docs/) into
// versions/<current latest>/, lists that version as archived and makes the
// new release the latest in .vitepress/versions.json. Then update the pages
// in docs/ for the new release.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const versionsFile = path.join(root, '.vitepress/versions.json')
const versions = JSON.parse(fs.readFileSync(versionsFile, 'utf8'))

const next = process.argv[2]
if (!next || !/^v\d+\.\d+\.\d+$/.test(next)) {
  console.error('usage: npm run new-version -- vX.Y.Z')
  process.exit(1)
}
if (next === versions.latest || versions.archived.includes(next)) {
  console.error(`${next} is already listed in .vitepress/versions.json`)
  process.exit(1)
}

const previous = versions.latest
const target = path.join(root, 'versions', previous)
if (fs.existsSync(target)) {
  console.error(`versions/${previous} already exists`)
  process.exit(1)
}

// Everything in docs/ that is not a page of the docs.
const notContent = new Set([
  '.vitepress',
  'node_modules',
  'package.json',
  'package-lock.json',
  'public',
  'scripts',
  'versions',
])
for (const entry of fs.readdirSync(root)) {
  if (notContent.has(entry) || entry.startsWith('.')) continue
  fs.cpSync(path.join(root, entry), path.join(target, entry), { recursive: true })
}

versions.archived.unshift(previous)
versions.latest = next
fs.writeFileSync(versionsFile, JSON.stringify(versions, null, 2) + '\n')

console.log(`Archived the ${previous} docs in versions/${previous}/.`)
console.log(`${next} is now the latest version: update the pages in docs/ for it.`)
