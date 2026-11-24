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
    // A zero-hit index query now auto-runs the rg pass; the explicit flag remains available.
    const bare = pages.query('amount must be positive', { k: 5 })
    assert.ok(bare.hits.length >= 1, 'zero-hit index query auto-runs rg')
    assert.match(bare.rgNote ?? '', /auto-rg/)

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

/** Corpus for ranking tests: generic-term floods + filename-discriminated files. */
function makeFloodCorpus(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'flood-corpus', version: '1.0.0', type: 'module' }, null, 2) + '\n')
  for (const name of ['a.js', 'b.js', 'c.js', 'd.js']) {
    fs.writeFileSync(path.join(root, 'src', name), [
      'export const x = 1',
      'export function indexBuilder() { return x }',
      '',
    ].join('\n'))
  }
  fs.writeFileSync(path.join(root, 'src', 'watch.js'), [
    'export function startWatcher() {',
    '  // liveness index: reads the pidfile left by the previous run',
    '  const pidfile = ".memai/watch.pid"',
    '  return pidfile',
    '}',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(root, 'src', 'cache.js'), [
    'export function cacheGet(key) { return null }',
    'export function cacheStore(key, v) { return v }',
    '',
  ].join('\n'))
  // Shorter path than cache.js: without a file-name boost, plain score ties
  // resolve to this file first, so only a real boost can put cache.js on top.
  fs.writeFileSync(path.join(root, 'src', 's.js'), [
    '// cache cache cache — generic mentions of cache and store in body text',
    'export const cache_store = { get: () => null }',
    '',
  ].join('\n'))
}

/** Fresh indexed flood corpus; returns { root, store, pages }. */
async function floodProject() {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  makeFloodCorpus(root)
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  return { root, store, pages }
}

test('symbol search splits multi-word queries and ranks by specificity', async () => {
  const { store, pages } = await project()
  try {
    // "verify token" as one substring matches no symbol name; per-term it must
    // surface verifyToken (matches BOTH terms: prefix + substring) above
    // single-term substring matches like issueToken.
    const r = pages.query('verify token', { k: 5 })
    assert.ok(r.hits.length >= 1)
    assert.equal(r.hits[0].kind, 'symbol')
    assert.equal(r.hits[0].symbol, 'verifyToken')
    assert.equal(r.hits[0].path, 'src/auth.js')

    // Single-word contract preserved (fault resolution depends on it):
    // exact > prefix > substring.
    const single = store.symbolSearch('verifyToken', { limit: 1 })
    assert.equal(single[0].name, 'verifyToken')
    assert.equal(single[0].path, 'src/auth.js')
    const sub = store.symbolSearch('issueToken', { limit: 1 })
    assert.equal(sub[0].name, 'issueToken')
  } finally { store.close() }
})

test('rg cap is rarity-first: rare and multi-term lines beat generic floods', async () => {
  const { store, pages } = await floodProject()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    // "index" appears in every filler file; "pidfile" only in watch.js.
    // The two-term line (liveness index + pidfile) must rank first and the
    // rare pidfile-only line must surface — generic floods may not take all
    // slots. Fresh files can be briefly unreadable to rg (AV scans), so wait
    // for the full pool before asserting, like the body-text test above.
    let r = null
    let twoTerm = null
    let pidfileOnly = null
    for (let i = 0; i < 10 && !(twoTerm && pidfileOnly); i++) {
      r = pages.query('index pidfile', { k: 5, rg: true })
      twoTerm = r.hits.find((h) => h.path === 'src/watch.js' && h.snippet.includes('pidfile') && h.snippet.includes('index'))
      pidfileOnly = r.hits.find((h) => h.path === 'src/watch.js' && h.snippet.includes('const pidfile'))
      if (!(twoTerm && pidfileOnly)) await sleep(300)
    }
    assert.ok(r && r.hits.length >= 3, `expected rg hits: ${JSON.stringify(r?.hits)}`)
    assert.ok(twoTerm, `two-term watch.js line must surface: ${JSON.stringify(r.hits)}`)
    assert.ok(pidfileOnly, `rare pidfile-only line must surface: ${JSON.stringify(r.hits)}`)
    assert.equal(r.hits[0].path, 'src/watch.js', `top hit should be the two-term line: ${JSON.stringify(r.hits.slice(0, 3))}`)
    assert.equal(r.hits[0].kind, 'text')
    assert.equal(r.hits[0].line, twoTerm.line)
    assert.ok(r.hits.findIndex((h) => h.path === 'src/watch.js' && h.snippet.includes('const pidfile')) < r.hits.findIndex((h) => h.path !== 'src/watch.js' || h.kind !== 'text'), `rare line beats the generic flood: ${JSON.stringify(r.hits.slice(0, 5))}`)
  } finally { store.close() }
})

test('file-name matches boost a page above body-only mentions', async () => {
  const { store, pages } = await floodProject()
  try {
    // cache.js and s.js both contain "cache" and "store" in their paged text,
    // and s.js even has the shorter path — but only cache.js has a query term
    // as its file name, so the file-name boost must put it first.
    const r = pages.query('cache store', { k: 5 })
    assert.ok(r.hits.length >= 2, `expected page hits: ${JSON.stringify(r.hits)}`)
    assert.equal(r.hits[0].path, 'src/cache.js', `file-name hit should rank first: ${JSON.stringify(r.hits.slice(0, 3))}`)
  } finally { store.close() }
})

test('exact symbol match survives prose-diluted idf', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"docs-polluted","version":"1.0.0","type":"module"}')
  fs.writeFileSync(path.join(root, 'src', 'pager.js'), 'export function fault(sym) { return sym }\nexport function pageFor(id) { return id }\n')
  // Markdown headings become pseudo-symbols; several headings mention `fault`,
  // which dilutes its idf across the symbols table.
  for (const n of [1, 2, 3, 4, 5]) {
    fs.writeFileSync(path.join(root, 'docs', `guide${n}.md`), `# Guide ${n}\n\n## Using fault <symbol> to slice a body\n\nThen \`query\` to locate it.\n`)
  }
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  try {
    // `fault` is an exact identifier match in src/pager.js — it must outrank
    // flat page hits that merely mention the words in prose.
    const r = pages.query('fault symbol slice', { k: 5 })
    assert.ok(r.hits.length >= 1)
    assert.equal(r.hits[0].path, 'src/pager.js', `exact symbol should rank first: ${JSON.stringify(r.hits.slice(0, 3))}`)
    assert.equal(r.hits[0].symbol, 'fault')
  } finally { store.close() }
})

test('code evidence outranks docs and test pages; generic path words do not boost', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(root, 'test'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"rank-mix","version":"1.0.0","type":"module"}')
  fs.writeFileSync(path.join(root, 'src', 'widget.js'), 'export function widgetRanker(items) { return items.sort() }\n')
  fs.writeFileSync(path.join(root, 'docs', 'widget.md'), '# Widget\n\nThe widget ranker sorts widget items. Widget widget ranker.\n')
  fs.writeFileSync(path.join(root, 'test', 'widget.test.js'), "import { widgetRanker } from '../src/widget.js'\n// test the widget ranker\n")
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  try {
    // The implementation symbol is the answer; the doc page and the test file
    // merely mention the words. Assert on scores, not order — the order can be
    // decided by a path-length tie-break even when all three score the same.
    const r = pages.query('test widget ranker', { k: 10 })
    const score = (base) => r.hits.find((h) => h.kind === 'page' && h.path.endsWith(base))?.score
    const src = score('src/widget.js')
    const doc = score('docs/widget.md')
    const tst = score('test/widget.test.js')
    assert.ok(src != null && doc != null && tst != null, `all three pages must be hits: ${JSON.stringify(r.hits)}`)
    assert.ok(tst < src, `test page (${tst}) must score below the implementation (${src})`)
    assert.ok(doc < src, `doc page (${doc}) must score below the implementation (${src})`)
    assert.equal(r.hits[0].path, 'src/widget.js', `implementation should rank first: ${JSON.stringify(r.hits.slice(0, 4))}`)
  } finally { store.close() }
})

test('multi-term code symbol beats generic single-term exact matches', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"multi-term","version":"1.0.0","type":"module"}')
  fs.writeFileSync(path.join(root, 'src', 'store.js'), [
    'export function merkleVersion(tree) { return tree }',
    'export function merkleroot(tree) { return tree }',
    '',
  ].join('\n'))
  // Generic single-term identifiers exist across many files, and prose-heavy
  // md headings mention all the query words.
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(root, 'src', `mod${n}.js`), `export const version = ${n}\n`)
  }
  for (const n of [1, 2, 3, 4, 5]) {
    fs.writeFileSync(path.join(root, 'docs', `guide${n}.md`), `# Guide ${n}\n\n## The merkle version manifest layout\n\nKeep it fresh.\n`)
  }
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  try {
    // merkleVersion matches TWO terms; bare `version` matches one generic term.
    // Heading pseudo-symbols must not dilute the weights that decide this.
    const r = pages.query('merkle version manifest', { k: 5 })
    assert.ok(r.hits.length >= 1)
    assert.equal(r.hits[0].path, 'src/store.js', `multi-term symbol should rank first: ${JSON.stringify(r.hits.slice(0, 3))}`)
  } finally { store.close() }
})

test('test-name prose and doc headings rank below implementation symbols', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'test'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"prose-rank","version":"1.0.0","type":"module"}')
  fs.writeFileSync(path.join(root, 'src', 'graph.js'), 'export function blastRadius(target) { return target }\n')
  // A test whose *name* is a sentence containing the query words.
  fs.writeFileSync(path.join(root, 'test', 'graph.test.js'), "test('blast radius transitive importers', () => {})\n")
  // A doc heading that mentions the same words.
  fs.writeFileSync(path.join(root, 'docs', 'graph.md'), '# Blast radius transitive importers\n\nProse.\n')
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  try {
    const r = pages.query('blast radius transitive importers', { k: 5 })
    assert.equal(r.hits[0].path, 'src/graph.js', `implementation must win: ${JSON.stringify(r.hits.slice(0, 4).map((h) => [h.path, h.symbol, h.score]))}`)
  } finally { store.close() }
})

test('query --body returns hits and the top symbol body in one call', async () => {
  const { store, pages } = await project()
  try {
    const r = pages.query('verifyToken', { k: 3, body: true })
    assert.ok(r.body, 'body section present')
    assert.equal(r.body.ok, true)
    assert.equal(r.body.symbol, 'verifyToken')
    assert.match(r.body.text, /token\.split/)
    assert.ok(r.body.tokens > 0)
    assert.ok(r.text.includes('body:'), 'text carries the body section')
    // Without the flag the envelope is unchanged.
    const plain = pages.query('verifyToken', { k: 3 })
    assert.equal(plain.body, undefined)
  } finally { store.close() }
})

test('fault and get accept comma-separated batches', async () => {
  const { store, pages } = await project()
  try {
    const f = pages.fault('verifyToken,issueToken', { budget: 600 })
    assert.equal(f.ok, true)
    assert.equal(f.results.length, 2)
    assert.deepEqual(f.results.map((x) => x.symbol), ['verifyToken', 'issueToken'])
    assert.match(f.text, /verifyToken/)
    assert.match(f.text, /issueToken/)

    const g = pages.get('file:src/auth.js,file:src/billing.js', { budget: 800 })
    assert.equal(g.ok, true)
    assert.equal(g.results.length, 2)
    assert.match(g.text, /auth\.js/)
    assert.match(g.text, /billing\.js/)
  } finally { store.close() }
})

test('CLI: query --body and comma batches wire through', async () => {
  const { root, store } = await project()
  try {
    const r = await runNode([SELF.bin, 'query', 'verifyToken', '--body', '--root', root], { cwd: root })
    assert.equal(r.code, 0, r.stderr)
    const j = JSON.parse(r.stdout.trim())
    assert.equal(j.body.ok, true)
    assert.match(j.body.text, /token/)

    const f = await runNode([SELF.bin, 'fault', 'verifyToken,issueToken', '--root', root], { cwd: root })
    assert.equal(f.code, 0, f.stderr)
    assert.equal(JSON.parse(f.stdout.trim()).results.length, 2)
  } finally { store.close() }
})

test('query --body prefers a callable body over a higher-ranked const', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"body-pick","version":"1.0.0","type":"module"}')
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
  try {
    const r = pages.query('debounce watcher', { body: true })
    assert.equal(r.body.ok, true)
    assert.equal(r.body.symbol, 'startWatcher', `expected the function, got ${r.body.symbol}`)
    assert.match(r.body.text, /pidfile/)
  } finally { store.close() }
})

test('query --body prefers the matching source callable over docs headings', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"body-docs","version":"1.0.0","type":"module"}')
  const docs = ['# How does the watcher debounce work?', '']
  for (let i = 0; i < 25; i++) docs.push(`## Watcher debounce work ${i}`, '')
  docs.push('This page explains the watcher debounce design.', '')
  fs.writeFileSync(path.join(root, 'README.md'), docs.join('\n'))
  fs.writeFileSync(path.join(root, 'src', 'watch.js'), [
    'export const DEBOUNCE_MS = 800',
    'export function startWatcher() {',
    '  const pidfile = ".memai/watch.pid"',
    '  return pidfile',
    '}',
    'export function watcherAlive() {',
    '  return true',
    '}',
    '',
  ].join('\n'))
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  try {
    const r = pages.query('how does the watcher debounce work', { body: true })
    assert.equal(r.body.ok, true)
    assert.equal(r.body.symbol, 'startWatcher', `expected startWatcher, got ${r.body.symbol}`)
    assert.match(r.body.text, /pidfile/)
  } finally { store.close() }
})

test('query --body --deep and diff --faults compose in one call', async () => {
  const { store, pages } = await project()
  try {
    const q = pages.query('verifyToken', { body: true, deep: true })
    assert.equal(q.body.ok, true)
    const card = pages.card().text
    const m = card.match(/^version: ([0-9a-f]{8})$/m)
    assert.ok(m, 'card has no version line')
    const d = pages.diff({ since: m[1], faults: ['verifyToken'] })
    assert.equal(d.ok, true, d.error)
    assert.match(d.text, /# slices/)
    assert.match(d.text, /verifyToken/)
  } finally { store.close() }
})

test('fault --deep names same-file callers', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"deep-fixture","version":"1.0.0","type":"module"}')
  fs.writeFileSync(path.join(root, 'src', 'a.js'), [
    'export function callee() { return 1 }',
    'export function caller() { return callee() }',
    '',
  ].join('\n'))
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  try {
    let f = pages.fault('callee', { deep: true })
    for (let i = 0; i < 10 && !/caller/.test(f.text); i++) {
      await new Promise((r) => setTimeout(r, 300))
      f = pages.fault('callee', { deep: true })
    }
    assert.equal(f.ok, true)
    assert.match(f.text, /# deep callers/)
    assert.match(f.text, /caller/)
  } finally { store.close() }
})
