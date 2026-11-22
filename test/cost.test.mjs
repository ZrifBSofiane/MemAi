// Static cost-bench tests: a hermetic fixture project, no model calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from '../scripts/test-helpers.mjs'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'
import { measure, renderReport, baselineFrom, compareBaseline } from '../bench/cost.mjs'

const cleanup = []
test.after(() => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* windows */ } } })

async function fixture() {
  const root = tempDir()
  cleanup.push(root)
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"cost-fixture","version":"1.0.0","type":"module"}')
  fs.writeFileSync(path.join(root, 'src', 'auth.js'), [
    'export const TOKEN_TTL = 60',
    'export function verifyToken(token) {',
    "  const [head] = token.split('.')",
    "  return head === 'ok'",
    '}',
    '',
  ].join('\n'))
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  store.close()
  return root
}

const CALLS = [
  { id: 'q1', op: 'query', q: 'verifyToken' },
  { id: 'f1', op: 'fault', target: 'verifyToken' },
  { id: 'g1', op: 'graph', target: 'src/auth.js' },
]

test('measure reports every fixed surface and a total', async () => {
  const root = await fixture()
  const r = measure({ root, calls: CALLS, turns: 10 })
  assert.equal(r.ok, true)
  for (const k of ['schema', 'instructions', 'initBlock', 'skillFrontmatter', 'card']) {
    assert.ok(r.surfaces[k] > 0, `${k} must be positive`)
  }
  const sum = r.surfaces.schema + r.surfaces.instructions + r.surfaces.initBlock + r.surfaces.skillFrontmatter + r.surfaces.card
  assert.equal(r.surfaces.total, sum)
  assert.equal(r.model.turns, 10)
  assert.equal(r.model.perRequest, r.surfaces.schema + r.surfaces.initBlock + r.surfaces.skillFrontmatter)
  assert.equal(r.model.once, r.surfaces.instructions + r.surfaces.card)
})

test('text payload is never larger than the JSON envelope', async () => {
  const root = await fixture()
  const r = measure({ root, calls: CALLS })
  assert.equal(r.delivered.length, 3)
  for (const d of r.delivered) {
    assert.ok(d.textTokens > 0, `${d.id} text tokens`)
    assert.ok(d.textTokens <= d.jsonTokens, `${d.id}: text ${d.textTokens} > json ${d.jsonTokens}`)
  }
})

test('renderReport names the surfaces and every call', async () => {
  const root = await fixture()
  const out = renderReport(measure({ root, calls: CALLS }))
  assert.match(out, /schema \d+/)
  assert.match(out, /q1/)
  assert.match(out, /turn model/)
})

test('compareBaseline reports growth per surface and per call', async () => {
  const root = await fixture()
  const r = measure({ root, calls: CALLS })
  const base = baselineFrom(r)
  assert.deepEqual(compareBaseline(r, base), [])
  const shrunk = JSON.parse(JSON.stringify(base))
  shrunk.surfaces.schema = Math.max(1, shrunk.surfaces.schema - 1)
  shrunk.delivered[0].textTokens = Math.max(1, shrunk.delivered[0].textTokens - 1)
  const worse = compareBaseline(r, shrunk)
  assert.equal(worse.length, 2)
  assert.match(worse.map((w) => w.name).join(' '), /schema|q1/)
})
