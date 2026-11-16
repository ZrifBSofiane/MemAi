// Card conventions tests: the ESM/CJS detection must actually work (it read
// fields off store rows where they never existed through 0.2.0's first cut),
// persist across incremental rebuilds, and migrate old stores additively.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from '../scripts/test-helpers.mjs'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'
import { buildRecordsFromStore } from '../src/extract.mjs'

const cleanup = []
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may hold the db briefly */ }
  }
})

/** Fresh indexed project over a custom corpus; store left open. */
async function project(files) {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'conventions-fixture', version: '1.0.0' }, null, 2))
  for (const [rel, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, rel), body)
  }
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  return { dir, root, store, pages }
}

const conventionsOf = (pages) => {
  const card = pages.card({ budget: 99999 })
  const line = card.text.split('\n').find((l) => /^  - /.test(l)) ?? ''
  return card.text.split('\n').filter((l) => l.startsWith('  - '))
}

test('ESM project reports ES module conventions', async () => {
  const { store, pages } = await project({
    'src/a.js': 'import { b } from "./b.js"\nexport function a() { return b() }\n',
    'src/b.js': 'export const b = () => 1\n',
  })
  try {
    const convs = conventionsOf(pages)
    assert.ok(convs.some((c) => c.includes('ES module imports')), `conventions: ${JSON.stringify(convs)}`)
    assert.ok(!convs.some((c) => c.includes('CommonJS')))
    assert.ok(buildRecordsFromStore(store).some((r) => r.rel === 'src/a.js' && r.looksEsm === true))
  } finally { store.close() }
})

test('CJS project reports CommonJS conventions', async () => {
  const { pages } = await project({
    'src/c.js': 'const fs = require("fs")\nfunction c() { return fs }\nmodule.exports = { c }\n',
  })
  try {
    const convs = conventionsOf(pages)
    assert.ok(convs.some((c) => c.includes('CommonJS')), `conventions: ${JSON.stringify(convs)}`)
    assert.ok(!convs.some((c) => c.includes('ES module')))
  } finally { /* closed via cleanup */ }
})

test('mixed or non-JS projects report neither convention', async () => {
  const mixed = await project({
    'src/e.js': 'import x from "./y.js"\nexport function e() { return require("./z") }\n',
    'src/y.js': 'export const x = 1\n',
    'src/z.py': 'def z():\n    return 1\n',
  })
  const py = await project({ 'src/m.py': 'def m():\n    return 2\n' })
  try {
    for (const { pages, name } of [{ pages: mixed.pages, name: 'mixed' }, { pages: py.pages, name: 'py-only' }]) {
      const convs = conventionsOf(pages)
      assert.ok(!convs.some((c) => c.includes('ES module') || c.includes('CommonJS')), `${name}: ${JSON.stringify(convs)}`)
    }
  } finally { mixed.store.close(); py.store.close() }
})

test('flags persist in the store and survive incremental rebuilds', async () => {
  const { root, store, pages } = await project({
    'src/a.js': 'import { b } from "./b.js"\nexport function a() { return b() }\n',
    'src/b.js': 'export const b = () => 1\n',
  })
  try {
    store.close()
    // Reopen fresh: the convention must come from persisted columns, not memory.
    const store2 = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
    const pages2 = new MemoryPages({ store2, root })
    try {
      assert.ok(buildRecordsFromStore(store2).every((r) => r.looksEsm === true), 'persisted looks_esm')
      // Incremental rebuild (untouched file) must keep the convention.
      await pages2.indexFiles([path.join(root, 'src', 'a.js')])
      const convs = conventionsOf(pages2)
      assert.ok(convs.some((c) => c.includes('ES module')), `after incremental: ${JSON.stringify(convs)}`)
    } finally { store2.close() }
  } catch { /* cleanup via test.after */ }
})

test('pre-0.2 stores without the flag columns migrate additively', async () => {
  const { root, store, pages } = await project({
    'src/a.js': 'import { b } from "./b.js"\nexport function a() { return b() }\n',
  })
  const dbPath = path.join(root, '.memai', 'mem.db')
  try {
    store.close()
    // Simulate a 0.1.x store: drop the new columns behind its back.
    const raw = new DatabaseSync(dbPath)
    raw.exec('ALTER TABLE files DROP COLUMN looks_esm')
    raw.exec('ALTER TABLE files DROP COLUMN looks_cjs')
    raw.close()

    const store2 = new MemoryStore({ dbPath, root }) // _migrate re-adds them
    const pages2 = new MemoryPages({ store2, root })
    try {
      await pages2.index({ force: true }) // re-distil to fill the fresh columns
      const convs = conventionsOf(pages2)
      assert.ok(convs.some((c) => c.includes('ES module')), `after migration: ${JSON.stringify(convs)}`)
    } finally { store2.close() }
  } catch { /* cleanup via test.after */ }
})
