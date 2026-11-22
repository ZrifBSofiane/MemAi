// Guard (PreToolUse) tests: config, globs, payload shapes, decision matrix, state.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir, REPO } from '../scripts/test-helpers.mjs'
import {
  GUARD_DEFAULTS, SIG_BUDGET, FAULT_EST_TOKENS,
  loadGuardConfig, globMatch, guardToolName, guardFilePath, isWholeFileRead,
} from '../src/guard.mjs'

const cleanup = []
test.after(() => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* windows */ } } })
const projectDir = () => { const d = tempDir(); cleanup.push(d); fs.mkdirSync(path.join(d, '.memai'), { recursive: true }); return d }

test('guard defaults and guard.json overrides', () => {
  const root = projectDir()
  assert.deepEqual(loadGuardConfig({ root, env: {} }), { ...GUARD_DEFAULTS, source: 'defaults' })

  fs.writeFileSync(path.join(root, '.memai', 'guard.json'), JSON.stringify({ minBytes: 4096, allow: ['docs/**'], toolNames: ['Read'] }))
  const c = loadGuardConfig({ root, env: {} })
  assert.equal(c.minBytes, 4096)
  assert.deepEqual(c.allow, ['docs/**'])
  assert.deepEqual(c.toolNames, ['Read'])
  assert.equal(c.source, 'guard.json')

  // Env beats file; MEMAI_GUARD=off is the kill switch.
  assert.equal(loadGuardConfig({ root, env: { MEMAI_GUARD_MIN_BYTES: '2048' } }).minBytes, 2048)
  assert.equal(loadGuardConfig({ root, env: { MEMAI_GUARD: 'off' } }).enabled, false)

  // Invalid JSON never throws.
  fs.writeFileSync(path.join(root, '.memai', 'guard.json'), '{not json')
  assert.equal(loadGuardConfig({ root, env: {} }).minBytes, 8192)
})

test('globMatch: ** spans directories, * does not', () => {
  assert.equal(globMatch('docs/**', 'docs/a/b.md'), true)
  assert.equal(globMatch('docs/**', 'docs'), false)
  assert.equal(globMatch('**/*.lock', 'src/deep/yarn.lock'), true)
  assert.equal(globMatch('src/*.js', 'src/a.js'), true)
  assert.equal(globMatch('src/*.js', 'src/deep/a.js'), false)
  assert.equal(globMatch('a?c.js', 'abc.js'), true)
})

test('payload extraction accepts Claude Code and ZCode shapes', () => {
  assert.equal(guardToolName({ tool_name: 'Read' }), 'Read')
  assert.equal(guardToolName({ toolName: 'read_file' }), 'read_file')
  assert.equal(guardToolName({}), '')
  assert.equal(guardFilePath({ tool_name: 'Read', tool_input: { file_path: 'src/a.js' } }), 'src/a.js')
  assert.equal(guardFilePath({ inputs: { file_path: '/abs/b.js' } }), '/abs/b.js')
  assert.equal(guardFilePath({ tool_input: { path: 'c.js' } }), 'c.js')
  assert.equal(guardFilePath({ tool_input: { file: 'd.js' } }), 'd.js')
  assert.equal(guardFilePath({}), null)
})

test('isWholeFileRead: any range parameter means partial', () => {
  assert.equal(isWholeFileRead({}), true)
  assert.equal(isWholeFileRead({ file_path: 'x' }), true)
  assert.equal(isWholeFileRead({ offset: 1 }), false)
  assert.equal(isWholeFileRead({ limit: 200 }), false)
  assert.equal(isWholeFileRead({ start_line: 5 }), false)
  assert.equal(isWholeFileRead({ endLine: 9 }), false)
})

test('constants are the documented values', () => {
  assert.equal(SIG_BUDGET, 400)
  assert.equal(FAULT_EST_TOKENS, 400)
})
