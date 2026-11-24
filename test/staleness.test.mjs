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

test('fault path:line returns the enclosing symbol', async () => {
  const { root, store, pages } = await indexedProject()
  try {
    // auth.js lines: 4-7 verifyToken, so :4 is the symbol's first line.
    const f = pages.fault('src/auth.js:4')
    assert.ok(f.ok, f.error)
    assert.equal(f.mode, 'line')
    assert.equal(f.symbol, 'verifyToken')
    assert.equal(f.line, 4)
    assert.equal(f.lineEnd, 7)
    assert.equal(f.truncated, false)
    assert.equal(f.requestedLine, 4)
    assert.match(f.text, /\(complete\)/)
    assert.ok(!f.text.includes('(window)'))
    assert.equal(f.stale, false)
  } finally { store.close() }
})

test('fault path:line mid-symbol still returns the whole symbol', async () => {
  const { store, pages } = await indexedProject()
  try {
    const f = pages.fault('src/auth.js:6')
    assert.ok(f.ok, f.error)
    assert.equal(f.symbol, 'verifyToken')
    assert.equal(f.line, 4)
    assert.equal(f.lineEnd, 7)
    assert.match(f.text, /\(complete\)/)
    assert.match(f.text, /\(requested line 6\)/)
    assert.match(f.text, /token\.split/)
  } finally { store.close() }
})

test('fault path:line on an oversized symbol labels the rest and the truncation', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"line-big","version":"1.0.0","type":"module"}')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  const big = ['// big fixture', 'export function bigThing(input) {']
  for (let i = 0; i < 38; i++) big.push(`  const step${i} = input + ${i}`)
  big.push('  return step0', '}', '')
  fs.writeFileSync(path.join(root, 'src', 'big.js'), big.join('\n'))
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  try {
    // bigThing spans lines 2-42 (~290 tokens): the whole never fits 150.
    const rest = pages.fault('src/big.js:30', { budget: 150 })
    assert.ok(rest.ok, rest.error)
    assert.equal(rest.symbol, 'bigThing')
    assert.equal(rest.line, 30)
    assert.equal(rest.lineEnd, 42)
    assert.match(rest.text, /\(rest of bigThing; starts at 2\)/)
    assert.ok(!rest.text.includes('(complete)'))

    const cut = pages.fault('src/big.js:2', { budget: 150 })
    assert.ok(cut.ok, cut.error)
    assert.match(cut.text, /\(truncated: \d+ more lines of bigThing, which ends at 42\)/)
    assert.ok(cut.lineEnd < 42)
    assert.ok(!cut.text.includes('(complete)'))
    assert.ok(!cut.text.includes('(rest of'))
  } finally { store.close() }
})

test('fault never claims (complete) on a cap-limited slice', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"cap-fixture","version":"1.0.0","type":"module"}')
  const huge = ['// huge fixture', 'export function hugeThing(input) {']
  for (let i = 0; i < 240; i++) huge.push(`  const v${i} = input + ${i}`)
  huge.push('  return v0', '}', '')
  fs.writeFileSync(path.join(root, 'src', 'huge.js'), huge.join('\n'))
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  try {
    // hugeThing spans lines 2-243; the slice caps at line 221. Big budget: the
    // whole capped slice fits, so only the cap detection can keep the label honest.
    const line = pages.fault('src/huge.js:5', { budget: 3000 })
    assert.ok(line.ok, line.error)
    assert.ok(!line.text.includes('(complete)'), `must not claim complete: ${line.text.split('\n')[0]}`)
    assert.match(line.text, /capped at 220 lines/)
    assert.equal(line.symbol, 'hugeThing')

    const sym = pages.fault('hugeThing', { budget: 3000 })
    assert.ok(sym.ok, sym.error)
    assert.ok(!sym.text.includes('(complete)'), `must not claim complete: ${sym.text.split('\n')[0]}`)
    assert.match(sym.text, /capped at 220 lines/)
  } finally { store.close() }
})

test('fault path:line outside symbols keeps the window and names a continuing symbol', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"line-window","version":"1.0.0","type":"module"}')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  const w = ['// window fixture', 'export function tiny() {', '  return 1', '}', '']
  w.push('export function longThing(a) {')
  for (let i = 0; i < 69; i++) w.push(`  const x${i} = a + ${i}`)
  w.push('  return x0', '}', '')
  fs.writeFileSync(path.join(root, 'src', 'w.js'), w.join('\n'))
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  try {
    // Line 5 sits between tiny (2-4) and longThing (6-77); the window 5-64 cuts longThing.
    const f = pages.fault('src/w.js:5', { budget: 400 })
    assert.ok(f.ok, f.error)
    assert.equal(f.mode, 'line')
    assert.equal(f.line, 5)
    assert.equal(f.lineEnd, 64)
    assert.match(f.text, /\(window\)/)
    assert.match(f.text, /\(longThing continues to 77\)/)
    assert.equal(f.symbol, undefined)
  } finally { store.close() }
})

test('fault path:line on a markdown file stays a window', async () => {
  const { store, pages } = await indexedProject()
  try {
    const f = pages.fault('docs/auth.md:1')
    assert.ok(f.ok, f.error)
    assert.equal(f.mode, 'line')
    assert.match(f.text, /\(window\)/)
  } finally { store.close() }
})

test('fault path:line after an unindexed edit degrades to a stale window', async () => {
  const { root, store, pages } = await indexedProject()
  try {
    const file = path.join(root, 'src', 'auth.js')
    fs.writeFileSync(file, '// shifted\n// shifted\n' + fs.readFileSync(file, 'utf8'))
    const f = pages.fault('src/auth.js:6')
    assert.ok(f.ok, f.error)
    assert.match(f.text, /\(window\)/)
    assert.match(f.text, /STALE: file changed since index/)
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
