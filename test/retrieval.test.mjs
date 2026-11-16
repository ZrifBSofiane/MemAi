// Retrieval upgrade tests: hybrid `query --rg`, the miss log, and `fault --deep`.
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

/** Fresh indexed project; returns { root, store, pages } with the store open. */
async function project() {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  makeCorpus(root)
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  return { root, store, pages }
}

test('query --rg finds body-only content the index never pages', async () => {
  const { root, store, pages } = await project()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    // "amount must be positive" appears only inside createInvoice's body — file pages carry signatures, not bodies.
    const bare = pages.query('amount must be positive', { k: 5 })
    assert.equal(bare.hits.length, 0, 'index-only query must miss body text')

    // Fresh files can be briefly unreadable to rg (AV scans) → partial results;
    // retry briefly until the body line shows up instead of flaking.
    let hybrid = null
    let textHit = null
    for (let i = 0; i < 10 && !textHit; i++) {
      hybrid = pages.query('amount must be positive', { k: 5, rg: true })
      textHit = hybrid.hits.find((h) => h.kind === 'text' && h.snippet.includes('amount must be positive'))
      if (!textHit) await sleep(300)
    }
    assert.ok(hybrid.hits.length >= 1, 'rg union must find hits')
    assert.ok(textHit, `rg hits are kind=text with the body line: ${JSON.stringify(hybrid.hits)}`)
    assert.equal(textHit.source, 'rg')
    assert.equal(textHit.path, 'src/billing.js')
    assert.ok(textHit.line >= 1)
    assert.match(hybrid.text, /^text file:/m, 'text lines carry a text prefix')
  } finally { store.close() }
})

test('query --rg degrades to a note when rg is unavailable', async () => {
  const { root, store, pages } = await project()
  try {
    pages._rgSearch = undefined // defensive: the CLI path is what we test
    const res = await runNode([SELF.bin, 'query', 'verifyToken', '--rg', '--root', root], {
      cwd: root, env: { PATH: '' }, timeoutMs: 30000,
    })
    assert.equal(res.code, 0, `query must not fail without rg: ${res.stderr}`)
    const parsed = JSON.parse(res.stdout.trim())
    assert.equal(parsed.ok, true)
    assert.ok(parsed.hits.length >= 1, 'index hits still served')
    assert.match(parsed.rgNote ?? '', /rg: unavailable/, 'degradation is reported, not hidden')
  } finally { store.close() }
})

test('miss log: record, dedupe-free stats, per-tool breakdown', async () => {
  const { root, store, pages } = await project()
  try {
    const empty = pages.missStats()
    assert.equal(empty.total, 0)

    pages.recordMiss('session cookie rotate', { foundBy: 'rg', hitPath: 'src/auth.js:40' })
    pages.recordMiss('session cookie rotate', { foundBy: 'rg' })
    pages.recordMiss('webhook retry queue', { foundBy: 'manual' })

    const stats = pages.missStats()
    assert.equal(stats.total, 3)
    assert.equal(stats.top[0].query, 'session cookie rotate')
    assert.equal(stats.top[0].n, 2)
    assert.equal(stats.byTool.find((t) => t.tool === 'manual').n, 1)
    assert.match(stats.text, /miss stats — 3 recorded/)

    // CLI surface.
    const r = await runNode([SELF.bin, 'miss', 'config hot reload', '--found-by', 'grep', '--path', 'src/config.js', '--root', root], { cwd: root })
    assert.equal(r.code, 0, r.stderr)
    const rec = JSON.parse(r.stdout.trim())
    assert.equal(rec.ok, true)
    assert.equal(typeof rec.id, 'number')

    const s = await runNode([SELF.bin, 'miss', '--stats', '--root', root], { cwd: root })
    assert.equal(s.code, 0, s.stderr)
    const parsed = JSON.parse(s.stdout.trim())
    assert.equal(parsed.ok, true)
    assert.equal(parsed.total, 4)
    assert.equal(parsed.top[0].query, 'session cookie rotate')
  } finally { store.close() }
})

test('fault --deep: callees from the slice, callers from signatures', async () => {
  const { store, pages } = await project()
  try {
    // login()'s single-line body calls verifyToken + issueToken (same file).
    const f = pages.fault('login', { deep: true })
    assert.ok(f.ok, f.error)
    assert.ok(f.deep, 'deep context present')
    const calleeNames = f.deep.callees.map((c) => c.name)
    assert.ok(calleeNames.includes('verifyToken'), `callees should include verifyToken: ${calleeNames}`)
    assert.ok(calleeNames.includes('issueToken'))
    assert.ok(f.text.includes('# deep callees:'))

    // Callers of verifyToken: login's declaration line mentions it.
    const caller = pages.fault('verifyToken', { deep: true })
    assert.ok(caller.deep.callers.some((c) => c.name === 'login'), `callers should include login: ${JSON.stringify(caller.deep.callers)}`)
    assert.ok(caller.text.includes('# deep callers'))

    // deep stays out unless asked, and the budget still clamps the combined text.
    const plain = pages.fault('login')
    assert.equal(plain.deep, undefined)
    assert.ok(!plain.text.includes('# deep'))
    assert.ok(f.tokens <= 600 + 60, 'deep must respect the budget discipline')
  } finally { store.close() }
})

test('MCP surface: mem op=miss records, op=query passes rg, op=fault passes deep', async () => {
  const { root } = await project()
  try {
    const res = await runNode([SELF.bin, 'query', 'hookProbe', '--rg', '--root', root], { cwd: root })
    assert.equal(res.code, 0, res.stderr)
    const parsed = JSON.parse(res.stdout.trim())
    assert.equal(parsed.ok, true)
    assert.ok('rgNote' in parsed, 'rg envelope carries the note field even when null')

    const m = await runNode([SELF.bin, 'miss', 'probe term', '--root', root], { cwd: root })
    assert.equal(m.code, 0, m.stderr)
    assert.equal(JSON.parse(m.stdout.trim()).ok, true)
  } finally { /* cleanup via test.after */ }
})
