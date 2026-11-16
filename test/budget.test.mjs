// Budget-fit regression: large symbols whose clamped body cannot shrink below
// the header must serve a near-budget page, never a header-only stub
// (0.1.x served 28 of 600 tokens for dense 80-line functions).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from '../scripts/test-helpers.mjs'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'

const cleanup = []
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may hold the db briefly */ }
  }
})

/** An indexed project with one dense ~90-line function. */
async function denseProject() {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  const body = []
  body.push('export function denseFunction(opts) {')
  for (let i = 0; i < 85; i++) body.push(`  const step${i} = opts.value + ${i} // ${'padding text to make the line dense '} ${i * 7}`)
  body.push('  return step84')
  body.push('}')
  fs.writeFileSync(path.join(root, 'src', 'dense.js'), body.join('\n') + '\n')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'dense-fixture', version: '1.0.0' }, null, 2))
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  return { root, store, pages }
}

test('default-budget fault on a large symbol serves near-budget body, not a stub', async () => {
  const { store, pages } = await denseProject()
  try {
    const f = pages.fault('denseFunction')
    assert.ok(f.ok, f.error)
    assert.equal(f.truncated, true, 'a 90-line function must be truncated at 600')
    assert.ok(f.tokens >= 550, `served ${f.tokens} of ${f.budget} — header-only stub regression`)
    assert.ok(f.text.length > 2000, `text too short: ${f.text.length}`)
    assert.match(f.text, /export function denseFunction/)
    assert.match(f.text, /truncated/)
  } finally { store.close() }
})

test('explicit budget is respected end-to-end', async () => {
  const { store, pages } = await denseProject()
  try {
    const f = pages.fault('denseFunction', { budget: 1200 })
    assert.ok(f.ok)
    assert.ok(f.tokens <= 1200 + 60, `over budget: ${f.tokens}`)
    assert.ok(f.tokens >= 1000, `served only ${f.tokens} of 1200`)
  } finally { store.close() }
})
