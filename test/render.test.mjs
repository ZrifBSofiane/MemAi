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
    const tiny = pages.card({ budget: 40 })
    assert.ok(tiny.tokens <= 40, `tiny card ${tiny.tokens} > 40`)
  } finally { store.close() }
})

test('query auto-runs ripgrep when the index has no hits', async () => {
  const { store, pages } = await fixture()
  try {
    const r = pages.query('pidfile', { k: 5 })
    assert.ok(r.hits.some((h) => h.path === 'src/watch.js'), `expected a text hit:\n${r.text}`)
    assert.match(r.rgNote ?? '', /auto-rg/)
  } finally { store.close() }
})

test('fault returns a complete large body by default and marks it', async () => {
  const { root, store, pages } = await fixture()
  try {
    const big = Array.from({ length: 80 }, (_, i) => `  const v${i} = ${i}`).join('\n')
    fs.writeFileSync(path.join(root, 'src', 'big.js'), `export function bigFunction() {\n${big}\n  return v79\n}\n`)
    await pages.index({ maxFiles: 100 })
    const full = pages.fault('bigFunction')
    assert.equal(full.truncated, false, 'default should complete an 80-line body')
    assert.match(full.text, /\(complete\)/)
    const small = pages.fault('bigFunction', { budget: 200 })
    assert.equal(small.truncated, true)
    assert.match(small.text, /\(truncated: \d+ more lines?\)/)
  } finally { store.close() }
})

test('docs filename matches cannot outrank a source page', async () => {
  const { root, store, pages } = await fixture()
  try {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(root, 'docs', 'token-savings.md'), '# Token savings\n\ntoken savings measured here\n')
    fs.writeFileSync(path.join(root, 'src', 'tokenizer.js'), 'export function tokenize(input) {\n  return input.split(/\\s+/)\n}\n')
    await pages.index({ maxFiles: 100 })
    const r = pages.query('token savings', { k: 5 })
    const src = r.hits.find((h) => h.path === 'src/tokenizer.js')
    const doc = r.hits.find((h) => h.path === 'docs/token-savings.md')
    assert.ok(src, `source page missing: ${r.text}`)
    assert.ok(doc, `docs page missing: ${r.text}`)
    assert.ok(src.score > doc.score, `source ${src.score} must outrank docs ${doc.score}`)
    assert.ok(doc.score <= 0.8, `docs pathBoost must be capped, got ${doc.score}`)
  } finally { store.close() }
})
