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

import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'
import { decideGuard, readState, statePath, hasOverride, recordDeny } from '../src/guard.mjs'

/** Indexed project with one large (~10 KB) and one small file. */
async function guardProject() {
  const root = projectDir()
  const big = []
  for (let i = 0; i < 220; i++) big.push(`export function bigFn${i}(x) { return x + ${i} }`)
  fs.writeFileSync(path.join(root, 'big.js'), big.join('\n') + '\n')
  fs.writeFileSync(path.join(root, 'small.js'), 'export const s = 1\n')
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  return { root, store, pages }
}

const readPayload = (file, extra = {}) => ({ tool_name: 'Read', tool_input: { file_path: file }, session_id: 'sess-1', ...extra })

test('decideGuard denies a large fresh indexed whole-file read', async () => {
  const { root, store, pages } = await guardProject()
  try {
    const r = decideGuard({ payload: readPayload('big.js'), root, env: {}, cwd: root, now: 1_000, store, pages })
    assert.equal(r.decision, 'deny')
    assert.equal(r.rel, 'big.js')
    assert.ok(r.text.includes('MemAi guard'))
    assert.ok(r.text.includes('again'), 'override hint present')
    assert.ok(r.text.includes('fault '), 'concrete next moves present')
    const st = readState(root)
    assert.equal(st.denyCount, 1)
    assert.equal(st.lastDeny.rel, 'big.js')
  } finally { store.close() }
})

test('decideGuard allows: small, partial, not-indexed, outside, disabled, allowlisted, stale', async () => {
  const { root, store, pages } = await guardProject()
  const call = (payload, env = {}) => decideGuard({ payload, root, env, cwd: root, now: 1_000, store, pages })
  try {
    assert.equal(call(readPayload('small.js')).decision, 'allow')
    assert.equal(call({ tool_name: 'Read', tool_input: { file_path: 'big.js', offset: 10, limit: 50 }, session_id: 's' }).reason, 'partial read')
    assert.equal(call(readPayload('nope.js')).decision, 'allow')
    assert.equal(call(readPayload('../outside.js')).reason, 'outside project root')
    assert.equal(call(readPayload('big.js'), { MEMAI_GUARD: 'off' }).reason, 'guard disabled')
    assert.equal(call({ tool_name: 'Bash', tool_input: { command: 'cat big.js' } }).reason, 'not a guarded read tool')

    fs.writeFileSync(path.join(root, '.memai', 'guard.json'), JSON.stringify({ allow: ['big.*'] }))
    assert.equal(call(readPayload('big.js')).reason, 'allowlisted')
    fs.rmSync(path.join(root, '.memai', 'guard.json'))

    // Indexed, then changed on disk -> stale signatures, allow.
    fs.appendFileSync(path.join(root, 'big.js'), '\n// edit\n')
    assert.equal(call(readPayload('big.js')).reason, 'stale index')
  } finally { store.close() }
})

test('override: second read in the same session passes, another session does not', async () => {
  const { root, store, pages } = await guardProject()
  const call = (session, now = 5_000) => decideGuard({ payload: readPayload('big.js', { session_id: session }), root, env: {}, cwd: root, now, store, pages })
  try {
    assert.equal(call('s1').decision, 'deny')
    assert.equal(call('s1').decision, 'allow')
    assert.equal(call('s1').reason, 'override')
    assert.equal(call('s2').decision, 'deny')
    // TTL expiry re-denies (now + 1h + 1ms).
    assert.equal(call('s1', 5_000 + 3_600_001).decision, 'deny')
  } finally { store.close() }
})

test('state file is tolerant of corruption and prunes expired entries', async () => {
  const { root, store } = await guardProject()
  try {
    fs.writeFileSync(statePath(root), '{broken')
    assert.deepEqual(readState(root), { version: 1, overrides: {}, denyCount: 0, lastDeny: null })
    recordDeny(root, { sessionId: 'a', rel: 'x.js', now: 1, bytes: 1, fileTokens: 1, sigTokens: 1 })
    assert.equal(hasOverride(root, { sessionId: 'a', rel: 'x.js', now: 2 }), true)
    recordDeny(root, { sessionId: 'b', rel: 'y.js', now: 3_700_000, bytes: 1, fileTokens: 1, sigTokens: 1 })
    assert.equal(hasOverride(root, { sessionId: 'a', rel: 'x.js', now: 3_700_000 }), false, 'expired override pruned')
  } finally { store.close() }
})

import { spawnSync } from 'node:child_process'
import { SELF } from '../scripts/test-helpers.mjs'

const runHook = (root, payload, env = {}) => spawnSync(process.execPath, [SELF.bin, 'hook', 'guard', '--root', root], {
  cwd: root, encoding: 'utf8', timeout: 60_000,
  input: typeof payload === 'string' ? payload : JSON.stringify(payload),
  env: { ...process.env, ...env },
})

test('CLI: large read -> one deny JSON object, exit 0', async () => {
  const { root, store } = await guardProject()
  try {
    const r = runHook(root, readPayload('big.js'))
    assert.equal(r.status, 0, r.stderr)
    const out = r.stdout.trim()
    assert.equal(out.split('\n').length, 1, 'exactly one line of stdout')
    const j = JSON.parse(out)
    assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.equal(j.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /MemAi guard/)
  } finally { store.close() }
})

test('CLI: allow paths print nothing, malformed input still exits 0', async () => {
  const { root, store } = await guardProject()
  try {
    assert.equal(runHook(root, readPayload('small.js')).stdout, '')
    const bad = runHook(root, 'not json')
    assert.equal(bad.stdout, '')
    assert.equal(bad.status, 0)
    assert.equal(runHook(root, readPayload('big.js'), { MEMAI_GUARD: 'off' }).stdout, '')
  } finally { store.close() }
})

test('CLI: no store -> silent allow', () => {
  const root = tempDir()
  cleanup.push(root)
  fs.writeFileSync(path.join(root, 'huge.js'), 'export const x = 1\n'.repeat(500))
  const r = runHook(root, readPayload('huge.js'))
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})
