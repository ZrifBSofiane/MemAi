// Hook tests: `memai hook card` must emit exactly the Claude Code SessionStart payload,
// stay silent when there is no card, never fail a session, and be byte-stable/idempotent.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SELF, tempDir, makeCorpus, indexPath, runNode } from '../scripts/test-helpers.mjs'
import { hookCardPayload, buildHookContext, HOOK_EVENTS } from '../mcp/hook.mjs'

const cleanup = []
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may hold the db briefly */ }
  }
})

async function indexedProject() {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  makeCorpus(root)
  await indexPath(root, path.join(root, '.memai', 'mem.db'))
  return root
}

function emptyProject() {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'README.md'), '# empty project\n')
  return root
}

test('with no store: no payload, no output, exit 0, and nothing is created', async () => {
  const root = emptyProject()
  const payload = hookCardPayload({ root, env: {} })
  assert.equal(payload.json, null)
  assert.equal(payload.text, '')
  assert.equal(payload.tokens, 0)

  const res = await runNode([SELF.bin, 'hook', 'card', '--root', root], { cwd: root })
  assert.equal(res.code, 0, `hook must never fail a session: ${res.stderr}`)
  assert.equal(res.stdout.trim(), '', 'no card yet must be silent stdout')
  assert.equal(fs.existsSync(path.join(root, '.memai')), false, 'hook must be read-only')
})

test('with a store: exact SessionStart hookSpecificOutput shape', async () => {
  const root = await indexedProject()
  const payload = hookCardPayload({ root, env: {} })
  assert.ok(payload.json, 'expected a payload')
  assert.deepEqual(Object.keys(payload.json), ['hookSpecificOutput'])
  const hso = payload.json.hookSpecificOutput
  assert.deepEqual(Object.keys(hso).sort(), ['additionalContext', 'hookEventName'])
  assert.equal(hso.hookEventName, 'SessionStart')
  assert.ok(typeof hso.additionalContext === 'string' && hso.additionalContext.length > 100)
  assert.match(hso.additionalContext, /MemAi paged memory/)
  assert.match(hso.additionalContext, /op:"fault"/)
  assert.match(hso.additionalContext, /project|stack|commands/i)

  const res = await runNode([SELF.bin, 'hook', 'card', '--root', root], { cwd: root })
  assert.equal(res.code, 0, res.stderr)
  const lines = res.stdout.split('\n').filter((l) => l.trim())
  assert.equal(lines.length, 1, 'hook stdout must be exactly one JSON line')
  const parsed = JSON.parse(lines[0])
  assert.deepEqual(parsed, payload.json)
})

test('SubagentStart event is supported and emitted in hookEventName', async () => {
  const root = await indexedProject()
  const payload = hookCardPayload({ root, env: {}, event: 'SubagentStart' })
  assert.equal(payload.json.hookSpecificOutput.hookEventName, 'SubagentStart')
  const res = await runNode([SELF.bin, 'hook', 'card', '--event', 'SubagentStart', '--root', root], { cwd: root })
  assert.equal(res.code, 0, res.stderr)
  assert.equal(JSON.parse(res.stdout.trim()).hookSpecificOutput.hookEventName, 'SubagentStart')
  assert.deepEqual(HOOK_EVENTS, ['SessionStart', 'SubagentStart'])
})

test('--text prints the raw additional context (no JSON envelope)', async () => {
  const root = await indexedProject()
  const payload = hookCardPayload({ root, env: {} })
  const res = await runNode([SELF.bin, 'hook', 'card', '--text', '--root', root], { cwd: root })
  assert.equal(res.code, 0, res.stderr)
  assert.equal(res.stdout.trimEnd(), payload.text)
  assert.doesNotMatch(res.stdout, /hookSpecificOutput/)
})

test('output is byte-stable for an unchanged corpus (prefix-cache friendly)', async () => {
  const root = await indexedProject()
  const a = hookCardPayload({ root, env: {} })
  const b = hookCardPayload({ root, env: {} })
  assert.equal(a.text, b.text)
  assert.deepEqual(a.json, b.json)
  assert.equal(a.tokens, b.tokens)

  const cliA = await runNode([SELF.bin, 'hook', 'card', '--root', root], { cwd: root })
  const cliB = await runNode([SELF.bin, 'hook', 'card', '--root', root], { cwd: root })
  assert.equal(cliA.stdout, cliB.stdout)
})

test('buildHookContext returns null rather than creating a store', async () => {
  const root = emptyProject()
  assert.equal(buildHookContext({ root, env: {} }), null)
  assert.equal(fs.existsSync(path.join(root, '.memai')), false)
})

test('an unknown event fails the payload builder but the CLI still exits 0', async () => {
  const root = await indexedProject()
  assert.throws(() => hookCardPayload({ root, env: {}, event: 'NotAnEvent' }), /unknown hook event/)
  const res = await runNode([SELF.bin, 'hook', 'card', '--event', 'NotAnEvent', '--root', root], { cwd: root })
  assert.equal(res.code, 0, 'a bad event must not break a session start')
  assert.equal(res.stdout.trim(), '')
  assert.match(res.stderr, /unknown hook event/)
})

test('`memai hook session-start` alias emits SessionStart', async () => {
  const root = await indexedProject()
  const res = await runNode([SELF.bin, 'hook', 'session-start', '--root', root], { cwd: root })
  assert.equal(res.code, 0, res.stderr)
  assert.equal(JSON.parse(res.stdout.trim()).hookSpecificOutput.hookEventName, 'SessionStart')
})

test('`memai hook` with an unknown subcommand exits 2 with usage', async () => {
  const res = await runNode([SELF.bin, 'hook', 'nope'], { cwd: process.cwd() })
  assert.equal(res.code, 2)
  assert.match(res.stderr, /usage: memai hook card/)
})
