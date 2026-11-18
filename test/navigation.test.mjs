// 0.3.0 features: module graph navigation, eval harness, hook↔watcher dedup,
// status freshness, checkpoint/diff --last, handoff packs, circuit breaker.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir, makeCorpus, SELF, runNode } from '../scripts/test-helpers.mjs'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'
import { flushDelayMs, watcherAlive, DEBOUNCE_MS } from '../src/watch.mjs'
import { hookIndexFile } from '../mcp/hook.mjs'

const cleanup = []
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may hold the db briefly */ }
  }
})

/** Fresh indexed project with a custom corpus; store left open. */
async function project(files) {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'nav-fixture', version: '1.0.0' }, null, 2))
  for (const [rel, body] of Object.entries(files ?? {})) fs.writeFileSync(path.join(root, rel), body)
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  return { root, store, pages }
}

test('graph: importers, imports, external markers, extensionless specifiers', async () => {
  const { store, pages } = await project({
    'src/a.js': 'import { b } from "./b"\nimport fs from "node:fs"\nexport function a() { return b() + fs.constants }\n',
    'src/b.js': 'import { c } from "./c.js"\nexport const b = () => c()\n',
    'src/c.js': 'export function c() { return 1 }\n',
  })
  try {
    const g = pages.graph('src/c.js')
    assert.ok(g.ok, g.error)
    assert.deepEqual(g.importers.map((r) => r.path), ['src/b.js'], 'c is imported by b')
    assert.equal(g.imported.length, 0, 'c imports nothing')

    const ga = pages.graph('src/a.js')
    const importedPaths = ga.imported.map((r) => r.path ?? `(external) ${r.spec}`)
    assert.ok(importedPaths.includes('src/b.js'), 'extensionless "./b" resolves to src/b.js')
    assert.ok(importedPaths.some((p) => p.startsWith('(external)')), 'node:fs marked external')

    const gs = pages.graph('c')
    assert.equal(gs.resolved, 'src/c.js', 'symbol target resolves to its file')
    assert.equal(gs.symbol, 'c')
  } finally { store.close() }
})

test('graph: transitive reverse chains and cycle detection', async () => {
  const { store, pages } = await project({
    'src/a.js': 'import { b } from "./b.js"\nexport function a() { return b() }\n',
    'src/b.js': 'import { c } from "./c.js"\nexport const b = () => c()\n',
    'src/c.js': 'import { a } from "./a.js"\nexport function c() { return a() }\n',
  })
  try {
    const g = pages.graph('src/c.js', { depth: 3 })
    assert.ok(g.ok)
    const chains = g.chain.map((c) => c.join('->'))
    assert.ok(chains.some((c) => c.startsWith('src/c.js->src/b.js')), `chain: ${JSON.stringify(g.chain)}`)
    assert.ok(chains.some((c) => c.includes('src/a.js')), 'chain reaches a at depth 3')
    assert.ok(g.cycles.length >= 1, 'a→b→c→a cycle detected')
    assert.match(g.text, /cycle:/)
  } finally { store.close() }
})

test('checkpoint + diff --last round-trip; error without checkpoint', async () => {
  const { root, store, pages } = await project({ 'src/one.js': 'export const one = 1\n' })
  try {
    const noCp = pages.diff({ last: true, agent: 'zoe' })
    assert.equal(noCp.ok, false)
    assert.match(noCp.error, /checkpoint/)

    const cp = pages.checkpoint('zoe')
    assert.equal(cp.ok, true)
    const before = cp.version

    fs.writeFileSync(path.join(root, 'src', 'two.js'), 'export const two = 2\n')
    await pages.index({ maxFiles: 500 })

    const d = pages.diff({ last: true, agent: 'zoe', budget: 9999 })
    assert.equal(d.ok, true)
    assert.equal(d.from, before, 'delta measured from the checkpoint')
    assert.ok(d.added.includes('src/two.js'), `added: ${JSON.stringify(d.added)}`)

    // Other agents are unaffected.
    const other = pages.diff({ last: true, agent: 'mia' })
    assert.equal(other.ok, false)
  } finally { store.close() }
})

test('pack: card + notes + fault slices + resume footer, budget respected', async () => {
  const { store, pages } = await project({
    'src/auth.js': 'export function verifyToken(token) {\n  return token.split(".").length === 3\n}\n',
  })
  try {
    pages.post('handoff', 'finish the token TTL work', { agent: 'zoe' })
    const p = pages.pack('handoff', { faults: ['verifyToken'], budget: 1500 })
    assert.ok(p.ok)
    assert.match(p.text, /# project card/)
    assert.match(p.text, /finish the token TTL work/)
    assert.match(p.text, /# fault verifyToken →/)
    assert.match(p.text, /resume with: diff --since/)
    assert.ok(p.tokens <= 1500, `tokens ${p.tokens}`)

    const slim = pages.pack('handoff', { card: false, faults: [], budget: 200 })
    assert.ok(!slim.text.includes('# project card'), 'card skipped with card:false')
    const unknownTopic = pages.pack('nothing-here')
    assert.ok(!unknownTopic.text.includes('# notes ('), 'empty topic has no notes section')
  } finally { store.close() }
})

test('eval: fixtures produce recall/MRR per mode and list misses', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  makeCorpus(root)
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  try {
    const fixtures = [
      { q: 'verify token', expect: 'src/auth.js' },
      { q: 'create invoice', expect: 'src/billing.js' },
      { q: 'totally unrelated xyzzy', expect: 'src/does-not-exist.js' },
    ]
    const r = pages.evaluate(fixtures, { k: 5 })
    assert.ok(r.ok)
    const idx = r.results.index
    assert.equal(idx.total, 3)
    assert.equal(idx.hits, 2, 'two real fixtures hit, the bogus one misses')
    assert.ok(idx.recallAtK > 0.6 && idx.recallAtK < 0.7, `recall ${idx.recallAtK}`)
    assert.ok(r.results.hybrid.recallAtK >= idx.recallAtK, 'hybrid never below index-only')
    assert.match(r.text, /miss: "totally unrelated xyzzy"/)

    const noFixtures = pages.evaluate([])
    assert.equal(noFixtures.ok, false)
  } finally { store.close() }
})

test('status reports freshness; it follows disk edits and --no-stale', async () => {
  const { root, store, pages } = await project({ 'src/one.js': 'export const one = 1\n' })
  try {
    const fresh = pages.status()
    assert.match(fresh.text, /freshness: fresh \(\d+ files\)/)
    assert.deepEqual(fresh.stale, { changed: 0, missing: 0, checked: fresh.stale.checked })

    fs.appendFileSync(path.join(root, 'src', 'one.js'), '\n// edit\n')
    fs.rmSync(path.join(root, 'package.json'))
    const dirty = pages.status()
    assert.match(dirty.text, /freshness: 1 changed, 1 missing/)
    assert.equal(dirty.stale.changed, 1)
    assert.equal(dirty.stale.missing, 1)

    pages.staleCheck = false
    assert.equal(pages.status().stale, null)
  } finally { store.close() }
})

test('hook skips indexing when the watcher is alive, indexes when not', async () => {
  const { root, store, pages } = await project({ 'src/auth.js': 'export function dedupProbe() { return 1 }\n' })
  try {
    const before = pages.status().version
    // Fake a live watcher by writing OUR pid (this test process is alive).
    fs.writeFileSync(path.join(root, '.memai', 'watch.pid'), JSON.stringify({ pid: process.pid, started_at: Date.now(), root }))
    assert.equal(watcherAlive(root), process.pid)
    const r = await hookIndexFile({ payload: { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src', 'auth.js') } }, root })
    assert.equal(r.ok, true)
    assert.equal(r.skipped, true, 'hook must defer to the live watcher')
    assert.match(r.reason, /watcher alive/)

    fs.rmSync(path.join(root, '.memai', 'watch.pid'))
    assert.equal(watcherAlive(root), null)
    fs.appendFileSync(path.join(root, 'src', 'auth.js'), '\nexport function dedupProbe2() { return 2 }\n')
    const before2 = pages.status().version
    const r2 = await hookIndexFile({ payload: { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src', 'auth.js') } }, root })
    assert.equal(r2.ok, true)
    assert.equal(r2.indexed, true, 'without a watcher the hook indexes the edit')
    assert.notEqual(pages.status().version, before2)
  } finally { store.close() }
})

test('circuit breaker: normal debounce until flush budget, then hold past the window', () => {
  const now = 1_000_000
  const quiet = flushDelayMs(now, [now - 5000], {})
  assert.equal(quiet, DEBOUNCE_MS)

  // 30 flushes in the last minute: hold until the oldest leaves the window.
  const busy = Array.from({ length: 30 }, (_, i) => now - 55000 + i)
  const d = flushDelayMs(now, busy, {})
  assert.ok(d >= 55000 - (now - 55_000) - busy.length, `delay ${d} pushes past the window`)
  assert.ok(d > DEBOUNCE_MS)

  // Old flushes age out and the breaker releases.
  const aging = Array.from({ length: 30 }, (_, i) => now - 59_000 + i)
  assert.equal(flushDelayMs(now + 1500, aging, {}), DEBOUNCE_MS, 'once the window clears, back to debounce')
})

// ------------------------------------------------------- 0.4.0: shortest/affected ---

const chainCorpus = {
  'src/a.js': 'import { b } from "./b"\nexport function a() { return b() }\n',
  'src/b.js': 'import { c } from "./c.js"\nexport const b = () => c()\n',
  'src/c.js': 'export function c() { return 1 }\n',
  'src/d.js': 'export const d = 1\n',
}

test('graph --shortest: import chain between two files, BFS over imports', async () => {
  const { store, pages } = await project(chainCorpus)
  try {
    const r = pages.graphShortest('src/a.js', 'src/c.js')
    assert.ok(r.ok, r.error)
    assert.equal(r.direction, 'imports')
    assert.equal(r.hops, 2)
    assert.deepEqual(r.path, ['src/a.js', 'src/b.js', 'src/c.js'])
    assert.match(r.text, /2 hops/)
    assert.match(r.text, /-> src\/b\.js/)
    assert.ok(r.tokens <= 500 + 60, 'budget discipline')
  } finally { store.close() }
})

test('graph --shortest: symbol endpoints and imported-by fallback', async () => {
  const { store, pages } = await project(chainCorpus)
  try {
    // Querying leaf -> root: nothing imports FROM c, so the path runs the
    // other direction (c is imported by b, which is imported by a).
    const r = pages.graphShortest('c', 'a')
    assert.ok(r.ok, r.error)
    assert.equal(r.resolvedA, 'src/c.js')
    assert.equal(r.resolvedB, 'src/a.js')
    assert.equal(r.direction, 'imported-by')
    assert.equal(r.hops, 2)
    assert.deepEqual(r.path, ['src/c.js', 'src/b.js', 'src/a.js'])

    // Same file: zero hops, no BFS needed.
    const same = pages.graphShortest('src/b.js', 'b')
    assert.ok(same.ok)
    assert.equal(same.hops, 0)
    assert.deepEqual(same.path, ['src/b.js'])

    // d is an island: reachable from neither direction.
    const none = pages.graphShortest('src/a.js', 'src/d.js')
    assert.equal(none.ok, false)
    assert.match(none.error, /no import path/)
  } finally { store.close() }
})

test('affected: transitive importers with hop counts, cycle-safe', async () => {
  const { store, pages } = await project(chainCorpus)
  try {
    const r = pages.affected('c')
    assert.ok(r.ok, r.error)
    assert.equal(r.resolved, 'src/c.js')
    assert.equal(r.symbol, 'c')
    assert.equal(r.count, 2)
    assert.deepEqual(r.files, [
      { path: 'src/b.js', hops: 1 },
      { path: 'src/a.js', hops: 2 },
    ])
    assert.match(r.text, /src\/b\.js/)
    assert.ok(r.tokens <= 500 + 60)
  } finally { store.close() }
})

test('affected: cycles terminate without duplicates', async () => {
  const { store, pages } = await project({
    'src/a.js': 'import { b } from "./b.js"\nexport function a() { return b() }\n',
    'src/b.js': 'import { c } from "./c.js"\nexport const b = () => c()\n',
    'src/c.js': 'import { a } from "./a.js"\nexport function c() { return a() }\n',
  })
  try {
    const r = pages.affected('src/c.js')
    assert.ok(r.ok, r.error)
    assert.equal(r.count, 2, 'a imports b imports c; the c->a edge must not duplicate')
    assert.deepEqual(r.files.map((f) => f.path), ['src/b.js', 'src/a.js'])
    assert.deepEqual(r.files.map((f) => f.hops), [1, 2])
  } finally { store.close() }
})

test('affected + graph --shortest CLI surface', async () => {
  const { root, store } = await project(chainCorpus)
  try {
    const s = await runNode([SELF.bin, 'graph', 'src/a.js', 'src/c.js', '--shortest', '--root', root], { cwd: root })
    assert.equal(s.code, 0, s.stderr)
    const parsed = JSON.parse(s.stdout.trim())
    assert.equal(parsed.ok, true)
    assert.equal(parsed.hops, 2)
    assert.equal(parsed.direction, 'imports')

    const af = await runNode([SELF.bin, 'affected', 'c', '--root', root], { cwd: root })
    assert.equal(af.code, 0, af.stderr)
    const pa = JSON.parse(af.stdout.trim())
    assert.equal(pa.ok, true)
    assert.equal(pa.resolved, 'src/c.js')
    assert.equal(pa.count, 2, 'b imports c, a imports b — both transitively')
    assert.deepEqual(pa.files.map((f) => f.path), ['src/b.js', 'src/a.js'])
  } finally { store.close() }
})
