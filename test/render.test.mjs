// Card/resume tests: the card carries a version that `diff --since` accepts.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from '../scripts/test-helpers.mjs'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'

const cleanup = []
test.after(() => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* windows */ } } })

async function fixture() {
  const root = tempDir()
  cleanup.push(root)
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"render-fixture","version":"1.0.0","type":"module"}')
  fs.writeFileSync(path.join(root, 'src', 'watch.js'), [
    'export const DEBOUNCE_MS = 800',
    'export function startWatcher() {',
    '  const pidfile = ".memai/watch.pid"',
    '  return pidfile',
    '}',
    '',
  ].join('\n'))
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  return { root, store, pages }
}

test('card carries the current project version for resume', async () => {
  const { store, pages } = await fixture()
  try {
    const card = pages.card()
    const m = card.text.match(/^version: ([0-9a-f]{8})$/m)
    assert.ok(m, `card has no version line:\n${card.text}`)
    const d = pages.diff({ since: m[1] })
    assert.equal(d.ok, true, d.error)
  } finally { store.close() }
})
