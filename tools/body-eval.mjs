#!/usr/bin/env node
// Body-pick gate probe: run `query --body` over an eval fixture file and report,
// per fixture, whether the picked body comes from the expected file.
//   node tools/body-eval.mjs bench/eval-fixtures-ext.json [--out FILE] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)
const fixturesFile = process.argv[2]
if (!fixturesFile) {
  process.stderr.write('usage: node tools/body-eval.mjs <fixtures.json> [--out FILE] [--json]\n')
  process.exit(1)
}
const root = process.cwd()
const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root, create: false })
const pages = new MemoryPages({ store, root })
const fixtures = JSON.parse(fs.readFileSync(fixturesFile, 'utf8'))
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
const rows = fixtures.map((f) => {
  const r = pages.query(String(f.q), { k: 5, body: true })
  const expect = norm(f.expect)
  const got = r.body?.ok ? norm(r.body.path) : 'none'
  const hit = got !== 'none' && (got === expect || got.endsWith('/' + expect))
  return { q: String(f.q), expect, hit, got }
})
const hits = rows.filter((r) => r.hit).length
const text = [
  `# body-eval — ${fixtures.length} fixtures`,
  `body: file=${Math.round((100 * hits) / fixtures.length)}%  (${hits}/${fixtures.length})`,
  ...rows.filter((r) => !r.hit).map((r) => `body-miss: "${r.q}" → expected ${r.expect}, got ${r.got}`),
].join('\n')
const out = arg('out')
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(rows, null, 2))
}
process.stdout.write((has('json') ? JSON.stringify({ hits, total: fixtures.length, rows }) : text) + '\n')
store.close()
