// Staleness + read-only tests: every serving surface (query/get/card/map/fault)
// must tell the truth about disk state, `--read-only` must never create a store,
// and fault replies must carry a structured line range.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SELF, tempDir, makeCorpus, indexPath, runNode } from '../scripts/test-helpers.mjs'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'

const cleanup = []
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may hold the db briefly */ }
  }
})

/** An indexed corpus fixture; returns { root, pages } with the store left open. */
async function indexedProject() {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  makeCorpus(root)
  const dbPath = path.join(root, '.memai', 'mem.db')
  const store = new MemoryStore({ dbPath, root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  return { root, store, pages }
}

function emptyProject() {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'README.md'), '# nothing indexed\n')
  return root
}

/** Append a line to a corpus file so its content hash, mtime and size all change. */
function touch(root, rel, extra = '// touched\n') {
  fs.appendFileSync(path.join(root, rel), extra)
}

test('query marks hits stale after an edit and clean before', async () => {
  const { root, store, pages } = await indexedProject()
  try {
    const before = pages.query('verifyToken', { k: 5 })
    assert.ok(before.ok)
    assert.equal(before.hits[0].stale, false)
    assert.ok(!before.text.includes('[STALE]'))

    touch(root, path.join('src', 'auth.js'))

    const after = pages.query('verifyToken', { k: 5 })
    assert.equal(after.hits[0].stale, true)
    assert.match(after.text, /\[STALE\]/)
  } finally { store.close() }
})

test('get file:<path> reports stale in reply and header; card/map scan the corpus', async () => {
  const { root, store, pages } = await indexedProject()
  try {
    const clean = pages.get('file:src/auth.js')
    assert.equal(clean.stale, false)

    touch(root, path.join('src', 'auth.js'))

    const dirty = pages.get('file:src/auth.js')
    assert.equal(dirty.stale, true)
    assert.match(dirty.text, /STALE: file changed on disk/)

    const card = pages.card()
    assert.equal(card.stale, true)
    assert.match(card.text, /STALE: 1 changed/)
    assert.match(card.text, /of \d+ files/)

    // Removing a file from disk is staleness too.
    fs.rmSync(path.join(root, 'src', 'billing.js'))
    const card2 = pages.card()
    assert.match(card2.text, /1 missing/)
  } finally { store.close() }
})

test('--no-stale / staleCheck=false disables all checks', async () => {
  const { root, store, pages } = await indexedProject()
  try {
    touch(root, path.join('src', 'auth.js'))
    pages.staleCheck = false
    const q = pages.query('verifyToken', { k: 5 })
    assert.equal(q.hits[0].stale, undefined)
    assert.ok(!q.text.includes('[STALE]'))
    const g = pages.get('file:src/auth.js')
    assert.equal(g.stale, null)
    assert.ok(!g.text.includes('STALE'))
    const card = pages.card()
    assert.equal(card.stale, null)
    assert.ok(!card.text.includes('STALE'))
  } finally { store.close() }
})

test('fault symbol reply carries lineEnd + stale; header range is structured', async () => {
  const { root, store, pages } = await indexedProject()
  try {
    const f = pages.fault('verifyToken')
    assert.ok(f.ok, f.error)
    assert.equal(f.mode, 'symbol')
    assert.equal(typeof f.line, 'number')
    assert.equal(typeof f.lineEnd, 'number')
    assert.ok(f.lineEnd > f.line)
    assert.match(f.text, new RegExp(`src/auth\\.js:${f.line}-${f.lineEnd}`))
    assert.equal(f.stale, false)

    // The reported range must reproduce the slice a bounded file read would return.
    const disk = fs.readFileSync(path.join(root, 'src', 'auth.js'), 'utf8').split('\n')
    const slice = disk.slice(f.line - 1, f.lineEnd).join('\n')
    assert.ok(slice.includes('export function verifyToken'))
    assert.ok(slice.includes('return token.split'))

    touch(root, path.join('src', 'auth.js'))
    const f2 = pages.fault('verifyToken')
    assert.equal(f2.stale, true)
    assert.match(f2.text, /STALE: file changed since index/)
  } finally { store.close() }
})

test('fault path:line reply carries lineEnd and staleness', async () => {
  const { root, store, pages } = await indexedProject()
  try {
    const f = pages.fault('src/auth.js:4')
    assert.ok(f.ok, f.error)
    assert.equal(f.mode, 'line')
    const total = fs.readFileSync(path.join(root, 'src', 'auth.js'), 'utf8').split('\n').length
    assert.equal(f.lineEnd, Math.min(total, f.line - 1 + 60))
    assert.ok(f.lineEnd >= f.line)
    assert.equal(f.stale, false)
  } finally { store.close() }
})

test('--read-only never creates a store on a store-less project', async () => {
  const root = emptyProject()
  const res = await runNode([SELF.bin, 'query', 'anything', '--read-only', '--root', root], { cwd: root })
  assert.equal(res.code, 1, `expected exit 1, stderr: ${res.stderr}`)
  const parsed = JSON.parse(res.stdout.trim())
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /no MemAi store/)
  assert.match(parsed.error, /memai init/)
  assert.equal(fs.existsSync(path.join(root, '.memai')), false, '--read-only must not create .memai')
})

test('--read-only still serves an existing store', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  makeCorpus(root)
  await indexPath(root)
  const res = await runNode([SELF.bin, 'query', 'verifyToken', '--read-only', '--root', root], { cwd: root })
  assert.equal(res.code, 0, res.stderr)
  const parsed = JSON.parse(res.stdout.trim())
  assert.equal(parsed.ok, true)
  assert.equal(parsed.hits[0].stale, false)
})

test('MEMAI_READONLY=1 env behaves like --read-only', async () => {
  const root = emptyProject()
  const res = await runNode([SELF.bin, 'status', '--root', root], { cwd: root, env: { MEMAI_READONLY: '1' } })
  assert.equal(res.code, 1)
  assert.equal(fs.existsSync(path.join(root, '.memai')), false, 'env read-only must not create .memai')
})

test('default (non-read-only) open still creates the store lazily as before', async () => {
  const root = emptyProject()
  const res = await runNode([SELF.bin, 'query', 'x', '--root', root], { cwd: root })
  assert.equal(res.code, 0, res.stderr)
  assert.equal(fs.existsSync(path.join(root, '.memai', 'mem.db')), true, 'legacy write-on-read behavior preserved by default')
})
