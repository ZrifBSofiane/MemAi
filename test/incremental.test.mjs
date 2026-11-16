// Incremental indexing tests: indexFiles(paths) must converge to the same
// project version as a full re-index over identical mutations, prune vanished
// files, and refuse non-indexable paths.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir, makeCorpus } from '../scripts/test-helpers.mjs'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'
import { isIndexableRel } from '../src/extract.mjs'

const cleanup = []
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may hold the db briefly */ }
  }
})

/** Fresh indexed project; returns { root, store, pages } with the store open. */
async function project() {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, path.basename(dir)) // unique per call
  fs.mkdirSync(root, { recursive: true })
  makeCorpus(root)
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  return { root, store, pages }
}

/** Mutations shared by both indexing strategies: edit, add, delete. */
function mutate(root) {
  fs.appendFileSync(path.join(root, 'src', 'auth.js'), '\nexport function revokedTokenCheck(t) { return !!t }\n')
  fs.writeFileSync(path.join(root, 'src', 'notify.js'), 'export function notifyUser(id) { return `ping ${id}` }\n')
  fs.rmSync(path.join(root, 'docs', 'auth.md'))
}

test('indexFiles converges to the same version as a full re-index', async () => {
  const a = await project()
  const b = await project()
  try {
    assert.equal(a.pages.status().version, b.pages.status().version, 'fixtures start identical')

    mutate(a.root)
    mutate(b.root)

    // A: full re-index after the mutations.
    const full = await a.pages.index({ maxFiles: 500 })
    // B: incremental index of exactly the touched paths.
    const inc = await b.pages.indexFiles([
      path.join(b.root, 'src', 'auth.js'),
      path.join(b.root, 'src', 'notify.js'),
      path.join(b.root, 'docs', 'auth.md'),
    ])

    assert.equal(full.version, inc.version, 'incremental version must equal full-index version')
    assert.equal(inc.readFiles, 2, 'two files distilled (edit + add)')
    assert.equal(inc.deleted, 1, 'vanished doc pruned')
    assert.equal(a.pages.status().version, b.pages.status().version)
    assert.equal(b.store.getFile('docs/auth.md'), undefined, 'deleted file row gone')

    // Idempotent: re-running indexFiles on unchanged paths records no new version.
    const again = await b.pages.indexFiles([path.join(b.root, 'src', 'auth.js')])
    assert.equal(again.readFiles, 0)
    assert.equal(again.reused, 1)
    assert.equal(again.version, inc.version)
  } finally { a.store.close(); b.store.close() }
})

test('indexFiles ignores non-indexable and foreign paths', async () => {
  const { root, store, pages } = await project()
  try {
    const before = pages.status().version
    const r = await pages.indexFiles([
      path.join(root, 'screenshot.png'),
      path.join(root, 'node_modules', 'pkg', 'index.js'),
      path.join(root, '.memai', 'mem.db'),
      'D:/definitely/outside/other.js',
      'package-lock.json',
    ])
    assert.equal(r.readFiles, 0, 'nothing distiled')
    assert.equal(r.deleted, 0)
    assert.equal(pages.status().version, before, 'version unchanged')
  } finally { store.close() }
})

test('isIndexableRel mirrors the walk gates', () => {
  assert.equal(isIndexableRel('src/auth.js'), true)
  assert.equal(isIndexableRel('src\\auth.js'), true, 'windows separators normalised')
  assert.equal(isIndexableRel('docs/auth.md'), true)
  assert.equal(isIndexableRel('image.png'), false)
  assert.equal(isIndexableRel('bundle.min.js'), false)
  assert.equal(isIndexableRel('node_modules/pkg/index.js'), false)
  assert.equal(isIndexableRel('.git/config'), false)
  assert.equal(isIndexableRel('.memai/mem.db'), false)
  assert.equal(isIndexableRel('.eslintrc.json'), true, 'hidden files are fine, hidden dirs are not')
  assert.equal(isIndexableRel('deep/../auth.js'), false)
  assert.equal(isIndexableRel(''), false)
})
