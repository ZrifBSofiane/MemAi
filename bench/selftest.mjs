// Self-test: end-to-end round-trip for the memory-pages store, extractor,
// paging, versioning, delta, bulletin board and COW merge.
//
//   node bench/selftest.mjs
//
// Prints PASS/FAIL per check and exits non-zero on any failure. Runs on a
// throwaway 10-file corpus under .tmp/ (no network, no npm, deterministic).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages, sliceSymbol } from '../src/page.mjs'
import { estTokens, clampText, DEFAULT_CHARS_PER_TOKEN } from '../src/tokens.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ROOT = path.resolve(HERE, '..')
const TMP = path.join(ROOT, '.tmp', 'selftest')
const CORPUS = path.join(TMP, 'corpus')
const DB = path.join(TMP, 'mem.db')

let passed = 0
let failed = 0
const failures = []

async function check(name, fn) {
  try {
    const note = await fn()
    passed++
    console.log(`PASS ${name}${note ? `  (${note})` : ''}`)
  } catch (err) {
    failed++
    failures.push({ name, error: err.message })
    console.log(`FAIL ${name}  -> ${err.message}`)
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }

function writeCorpus() {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(CORPUS, { recursive: true })
  const files = {
    'package.json': JSON.stringify({ name: 'selftest-api', version: '0.0.1', type: 'module', main: 'src/app.js', scripts: { test: 'node --test', lint: 'eslint .' } }, null, 2) + '\n',
    'README.md': '# selftest-api\n\nA tiny corpus used by memory-pages self-tests.\n',
    '.gitignore': 'ignored/\nnode_modules/\n',
    'src/app.js': `import { ThingService } from './services/thing.service.js'\nimport { serializeThing } from './services/thing.service.js'\n\nexport function startServer(port = 8080) {\n  const service = new ThingService()\n  return { port, service, start: () => 'listening' }\n}\n\nexport const app = { startServer }\n`,
    'src/services/thing.service.js': `import { Thing } from '../models/thing.model.js'\n\nconst TABLE = 'things'\n\nexport class ThingService {\n  async list({ limit = 10 } = {}) {\n    return { ok: true, items: [], limit }\n  }\n\n  async get(id) {\n    if (!id) throw new Error('missing_id')\n    return { ok: true, thing: new Thing({ id }) }\n  }\n}\n\nexport function serializeThing(thing) {\n  return { id: thing.id, name: thing.name ?? 'unnamed' }\n}\n\nfunction validateThing(input) {\n  return typeof input === 'object' && input !== null\n}\n`,
    'src/models/thing.model.js': `export class Thing {\n  constructor(props = {}) {\n    this.id = props.id ?? null\n    this.name = props.name ?? 'thing'\n  }\n\n  toJSON() { return { id: this.id, name: this.name } }\n}\n`,
    'src/utils/helpers.js': `export function clamp(value, min, max) {\n  return Math.min(max, Math.max(min, value))\n}\n\nexport function pad(value, width = 4) {\n  return String(value).padStart(width, '0')\n}\n`,
    'tests/thing.test.js': `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { ThingService, serializeThing } from '../src/services/thing.service.js'\n\ntest('thing service lists', async () => {\n  const result = await new ThingService().list({ limit: 3 })\n  assert.equal(result.ok, true)\n})\n`,
    'docs/thing.md': '# Thing\n\nThe thing resource. Uses `ThingService`.\n',
    'ignored/secret.js': 'export const shouldNeverBeIndexed = true\n',
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(CORPUS, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  try {
    execFileSync('git', ['-C', CORPUS, 'init', '-q'], { stdio: 'ignore' })
    execFileSync('git', ['-C', CORPUS, 'add', '-A'], { stdio: 'ignore' })
  } catch { /* walk fallback is fine */ }
  fs.mkdirSync(TMP, { recursive: true })
}

console.log('memory-pages selftest\n')
writeCorpus()

let store = new MemoryStore({ dbPath: DB, root: CORPUS })
let pages = new MemoryPages({ store, root: CORPUS })
const versionOf = () => pages.store.latestVersion()?.version_hash

// ---------------------------------------------------------------------------
await check('token estimator is deterministic and budget-clamps', () => {
  assertEq(estTokens(''), 0, 'empty')
  assertEq(estTokens('abcd'), Math.ceil(4 / DEFAULT_CHARS_PER_TOKEN), 'abcd')
  assert(estTokens('x'.repeat(4000)) > estTokens('x'.repeat(400)), 'monotonic')
  for (const budget of [1, 5, 50, 200]) {
    const r = clampText('line\n'.repeat(500), budget)
    assert(r.tokens <= budget, `clamp tokens ${r.tokens} > budget ${budget}`)
    assert(r.truncated === true, 'must be truncated')
  }
  const full = clampText('a\nb', 1000)
  assertEq(full.truncated, false, 'small text not truncated')
  return 'cpt=' + DEFAULT_CHARS_PER_TOKEN
})

let idx1
await check('index distils a corpus into pages (git-aware, ignored files skipped)', async () => {
  idx1 = await pages.index({ maxFiles: 100 })
  assert(idx1.files >= 7, `expected >=7 indexed files, got ${idx1.files}`)
  assert(idx1.card.tokens > 0 && idx1.card.tokens <= 700, `card tokens ${idx1.card.tokens}`)
  assert(idx1.map.tokens > 0 && idx1.map.tokens <= 3500, `map tokens ${idx1.map.tokens}`)
  assert(!store.getFile('ignored/secret.js'), 'gitignored file must not be indexed')
  assert(store.getFile('src/app.js'), 'app.js indexed')
  return `${idx1.files} files, ${idx1.fullTokens} tokens if read fully, ${idx1.elapsedMs}ms`
})

await check('project card contains stack, commands and the paging protocol', () => {
  const card = pages.card()
  assert(card.ok, card.error)
  assert(card.tokens <= 700, `card over budget: ${card.tokens}`)
  for (const needle of ['selftest-api', 'node --test', 'entrypoints', 'fault', 'do NOT read whole files']) {
    assert(card.text.includes(needle), `card missing "${needle}"`)
  }
  return card.tokens + ' tokens'
})

await check('project map lists files and symbols within budget', () => {
  const map = pages.map()
  assert(map.ok, map.error)
  assert(map.tokens <= 3500, `map over budget: ${map.tokens}`)
  for (const needle of ['thing.service.js', 'ThingService', 'serializeThing']) {
    assert(map.text.includes(needle), `map missing "${needle}"`)
  }
  return map.tokens + ' tokens'
})

await check('file page gives signatures, not bodies', () => {
  const page = pages.get('file:src/services/thing.service.js', { budget: 1200 })
  assert(page.ok, page.error)
  assert(page.text.includes('serializeThing'), 'signature missing')
  assert(page.text.includes('class'), 'class line missing')
  assert(!page.text.includes("throw new Error('missing_id')"), 'file page must not contain bodies')
  const full = estTokens(fs.readFileSync(path.join(CORPUS, 'src/services/thing.service.js'), 'utf8'))
  assert(page.tokens < full, `page (${page.tokens}) should be smaller than full file (${full})`)
  return `${page.tokens} vs ${full} full-file tokens`
})

await check('query returns ranked symbol hits with snippets', () => {
  const q = pages.query('serializeThing', { k: 3 })
  assert(q.ok, q.error)
  assert(q.count >= 1, 'expected at least one hit')
  assert(q.hits.some((h) => h.symbol === 'serializeThing'), 'missing symbol hit')
  assert(q.tokens <= 400, `query over budget: ${q.tokens}`)
  assert(!q.text.includes('return { id: thing.id'), 'query must only return snippets')
  return q.count + ' hits, ' + q.tokens + ' tokens'
})

await check('fault pages one symbol body under budget', () => {
  const f = pages.fault('serializeThing', { budget: 300 })
  assert(f.ok, f.error)
  assertEq(f.path, 'src/services/thing.service.js', 'wrong file')
  assert(f.text.includes('return { id: thing.id'), 'body missing')
  assert(f.tokens <= 300, `fault over budget: ${f.tokens}`)
  const f2 = pages.fault('src/services/thing.service.js#serializeThing', { budget: 300 })
  assert(f2.ok && f2.line === f.line, 'path#symbol mode failed')
  const f3 = pages.fault('src/services/thing.service.js:12', { budget: 300 })
  assert(f3.ok && f3.mode === 'line', 'path:line mode failed')
  const f4 = pages.fault('src/services/thing.service.js', { budget: 300 })
  assert(f4.ok && f4.mode === 'file-page', 'path mode failed')
  const bad = pages.fault('doesNotExistAnywhere')
  assert(!bad.ok, 'missing symbol should fail')
  return `${f.lines} lines, ${f.tokens} tokens`
})

await check('every resolve path respects its token budget', () => {
  for (const budget of [40, 80, 150, 400]) {
    for (const r of [pages.card({ budget }), pages.map({ budget }), pages.get('file:src/app.js', { budget }), pages.fault('startServer', { budget }), pages.query('thing', { budget })]) {
      assert(r.tokens <= budget, `${r.pageId ?? r.target ?? r.query} tokens ${r.tokens} > budget ${budget}`)
    }
  }
  return 'budgets 40/80/150/400 respected'
})

await check('re-index of an unchanged tree is idempotent (same Merkle version)', async () => {
  const before = versionOf()
  const idx2 = await pages.index({ maxFiles: 100 })
  assertEq(idx2.version, before, 'version changed without a content change')
  assert(idx2.readFiles <= 1, `expected ~0 re-reads, got ${idx2.readFiles}`)
  // same page upsert again is a no-op
  const p = store.getPage('project.card')
  const r = store.upsertPage({ id: p.id, kind: p.kind, versionHash: p.version_hash, text: p.text })
  assertEq(r.changed, false, 'identical page upsert must not change history')
  return 'source=' + idx2.source
})

await check('WAL mode + reopen keeps the store intact', () => {
  const mode = store.one('PRAGMA journal_mode')?.journal_mode
  assertEq(mode, 'wal', 'journal mode')
  store.close()
  store = new MemoryStore({ dbPath: DB, root: CORPUS })
  pages = new MemoryPages({ store, root: CORPUS })
  assert(store.getFile('src/app.js'), 'file row lost after reopen')
  assert(store.getPage('project.card'), 'page lost after reopen')
  return 'journal_mode=wal'
})

let oldVersion
await check('content change produces a new version and a tiny diff', async () => {
  oldVersion = versionOf()
  const file = path.join(CORPUS, 'src/services/thing.service.js')
  fs.appendFileSync(file, `\nexport function archiveThing(thing) {\n  return { ...thing, archivedAt: new Date().toISOString() }\n}\n`)
  const idx = await pages.index({ maxFiles: 100 })
  assert(idx.version !== oldVersion, 'version did not change')
  assert(idx.readFiles >= 1, 'changed file was not re-read')
  const d = pages.diff({ since: oldVersion })
  assert(d.ok, d.error)
  assert(d.changed.some((c) => c.path === 'src/services/thing.service.js'), 'diff missed the changed file')
  assert(d.text.includes('archiveThing'), 'diff should name the added symbol')
  const fullRead = estTokens(fs.readFileSync(file, 'utf8'))
  assert(d.tokens < fullRead / 2, `diff ${d.tokens} should be much smaller than full read ${fullRead}`)
  const archived = pages.fault('archiveThing', { budget: 300 })
  assert(archived.ok, 'fault on the added symbol failed after re-index')
  return `diff ${d.tokens} tokens vs ${fullRead} full-read tokens`
})

await check('old page versions remain readable (copy-on-write history)', () => {
  // Find the pre-change page version hash from the old manifest.
  const oldManifest = store.getVersion(oldVersion).manifest
  const oldHash = oldManifest['file:src/services/thing.service.js']
  const text = store.getPageHistoryText('file:src/services/thing.service.js', oldHash)
  assert(text && !text.includes('archiveThing'), 'old version text must be preserved and immutable')
  return 'old text preserved'
})

await check('deleting a file is reflected in the delta', async () => {
  const before = versionOf()
  fs.rmSync(path.join(CORPUS, 'docs/thing.md'))
  const idx = await pages.index({ maxFiles: 100 })
  const d = pages.diff({ since: before })
  assert(d.removed.includes('docs/thing.md'), 'diff missed the removed file')
  assert(!store.getFile('docs/thing.md'), 'removed file still indexed')
  assert(idx.deleted >= 1, 'deleted count not reported')
  return 'removed docs/thing.md'
})

await check('board messages are append-only, deduped and cursor-aware', () => {
  const a = pages.post('handoff', 'auth lives in src/services/thing.service.js', { agent: 'agent-a' })
  const dup = pages.post('handoff', 'auth lives in src/services/thing.service.js', { agent: 'agent-a' })
  assertEq(dup.deduped, true, 'identical message must dedupe')
  assertEq(dup.seq, a.seq, 'deduped seq')
  pages.post('board', 'tests are in tests/', { agent: 'agent-b' })
  const inbox1 = pages.inbox('agent-a', { since: 0 })
  assert(inbox1.messages.length === 2, `expected 2 messages, got ${inbox1.messages.length}`)
  assert(inbox1.tokens <= 900, 'inbox over budget')
  const inbox2 = pages.inbox('agent-a')
  assertEq(inbox2.messages.length, 0, 'cursor should suppress already-read messages')
  return 'seq=' + a.seq
})

await check('board merge rebuilds a shared page and bumps its version', () => {
  const m1 = pages.merge('board:handoff', { agent: 'agent-a' })
  assert(m1.ok, m1.error)
  assert(m1.text.includes('src/services/thing.service.js'), 'board page missing message')
  const v1 = store.getPage('board:handoff').version_hash
  pages.post('handoff', 'second note', { agent: 'agent-b' })
  const m2 = pages.merge('board:handoff', { agent: 'agent-b' })
  assert(m2.ok, m2.error)
  assert(store.getPage('board:handoff').version_hash !== v1, 'merge must bump the board page version')
  assert(m2.text.includes('second note'), 'merged page missing second note')
  const bad = pages.merge('project.card')
  assert(!bad.ok, 'corpus pages must be immutable (merge must reject them)')
  return 'board version bumped'
})

await check('COW edit is staged, then published by merge', () => {
  const e = pages.addEdit('board:handoff', 'agent-c claims jwt.js owns signing', { agent: 'agent-c' })
  assert(e.ok, e.error)
  const before = store.getPage('board:handoff').version_hash
  const pending = store.pendingEdits('board:handoff')
  assert(pending.length >= 1, 'edit not pending')
  const m = pages.merge('board:handoff', { agent: 'agent-c' })
  assert(m.ok, m.error)
  assert(store.getPage('board:handoff').version_hash !== before, 'merge did not bump version')
  assert(m.text.includes('jwt.js owns signing'), 'edit not in merged page')
  assertEq(store.pendingEdits('board:handoff').length, 0, 'edits not marked merged')
  return 'staged -> merged'
})

await check('status reports corpus, pages, versions and board state', () => {
  const s = pages.status()
  assert(s.corpus.files >= 6, 'corpus count')
  assert(s.pages >= 5, 'page count')
  assert(s.versions >= 3, 'version count')
  assertEq(s.messages, 3, 'message count')
  assert(s.tokens > 0, 'status tokens')
  return `${s.corpus.files} files, ${s.pages} pages, ${s.versions} versions`
})

await check('sqlite file contains FTS5 index and WAL', () => {
  const fts = store.one("SELECT name FROM sqlite_master WHERE name = 'fts'")
  assert(fts, 'fts table missing')
  assert(store.searchPages('serializeThing').length >= 1, 'FTS search returned nothing')
  return 'fts5 ok'
})

store.close()

// ---------------------------------------------------------------------------
console.log('')
if (failed === 0) {
  console.log(`ALL ${passed} CHECKS PASSED`)
  process.exit(0)
} else {
  for (const f of failures) console.log(`FAILED: ${f.name}: ${f.error}`)
  console.log(`${passed} passed, ${failed} FAILED`)
  process.exit(1)
}
