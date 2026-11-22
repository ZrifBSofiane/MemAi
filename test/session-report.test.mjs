// Session-report analyzer tests: a hermetic ZCode-shaped SQLite fixture, no
// dependency on the live app database.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tempDir } from '../scripts/test-helpers.mjs'
import { sessionReport, sessionsSince } from '../tools/zcode-session-report.mjs'

const cleanup = []
test.after(() => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* windows */ } } })

function fixtureDb() {
  const dir = tempDir()
  cleanup.push(dir)
  const dbPath = path.join(dir, 'zcode.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, parent_id TEXT);
    CREATE TABLE turn_usage (session_id TEXT, turn_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
      reasoning_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER);
    CREATE TABLE part (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `)
  const addSession = db.prepare('INSERT INTO session VALUES (?,?,?,?,?)')
  addSession.run('sess_a', 'D:/Projects/MemAI', 'task A', 1000, null)
  addSession.run('sess_b', 'D:/Projects/Other', 'task B', 2000, null)
  const addTurn = db.prepare('INSERT INTO turn_usage VALUES (?,?,?,?,?,?,?)')
  addTurn.run('sess_a', 't1', 1000, 50, 0, 900, 0)
  addTurn.run('sess_a', 't2', 2000, 60, 10, 1800, 100)
  addTurn.run('sess_b', 't3', 500, 20, 0, 0, 0)
  const addPart = db.prepare('INSERT INTO part VALUES (?,?,?,?)')
  const tool = (id, sid, at, name, input, output) => addPart.run(id, sid, at, JSON.stringify({
    type: 'tool', tool: name, state: { status: 'completed', input, output },
  }))
  // Whole-file read (no offset/limit), partial read, a fault, and a guard deny.
  tool('p1', 'sess_a', 10, 'Read', { file_path: 'D:/Projects/MemAI/src/page.mjs' }, 'x'.repeat(1200))
  tool('p2', 'sess_a', 11, 'Read', { file_path: 'D:/Projects/MemAI/src/store.mjs', offset: 10, limit: 40 }, 'y'.repeat(300))
  tool('p3', 'sess_a', 12, 'fault', { target: 'query' }, 'z'.repeat(500))
  tool('p4', 'sess_b', 13, 'Read', { file_path: 'D:/Projects/Other/a.js' }, 'q'.repeat(100))
  addPart.run('p5', 'sess_a', 14, JSON.stringify({
    type: 'tool', tool: 'Read', state: { status: 'error', input: { file_path: 'D:/Projects/MemAI/src/page.mjs' }, output: '# MemAi guard — src/page.mjs withheld (50.1 KB ≈ 12926 tok)\n…' },
  }))
  db.close()
  return dbPath
}

test('sessionReport sums billed tokens and classifies reads', () => {
  const dbPath = fixtureDb()
  const r = sessionReport({ dbPath, sessionId: 'sess_a' })
  assert.equal(r.ok, true)
  assert.equal(r.session.id, 'sess_a')
  assert.deepEqual(r.tokens, { input: 3000, output: 110, reasoning: 10, cacheRead: 2700, cacheWrite: 100 })
  assert.equal(r.reads.length, 3, 'two reads + the denied attempt')
  const whole = r.reads.filter((x) => x.wholeFile)
  assert.equal(whole.length, 2, 'the two whole-file attempts (one denied)')
  assert.equal(r.reads.find((x) => x.partial).path, 'D:/Projects/MemAI/src/store.mjs')
  assert.equal(r.denyCount, 1)
  assert.equal(r.denied[0].path, 'D:/Projects/MemAI/src/page.mjs')
  assert.equal(r.toolCalls.find((t) => t.tool === 'fault').count, 1)
  assert.equal(r.toolCalls.find((t) => t.tool === 'Read').count, 3)
})

test('sessionsSince filters by directory prefix and time', () => {
  const dbPath = fixtureDb()
  const all = sessionsSince({ dbPath, sinceMs: 0 })
  assert.equal(all.length, 2)
  const memai = sessionsSince({ dbPath, sinceMs: 0, cwd: 'D:/Projects/MemAI' })
  assert.equal(memai.length, 1)
  assert.equal(memai[0].id, 'sess_a')
  const recent = sessionsSince({ dbPath, sinceMs: 1500 })
  assert.deepEqual(recent.map((s) => s.id), ['sess_b'])
})

test('malformed parts are tolerated, not fatal', () => {
  const dbPath = fixtureDb()
  const db = new DatabaseSync(dbPath)
  db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('bad', 'sess_a', 99, '{not json')
  db.close()
  const r = sessionReport({ dbPath, sessionId: 'sess_a' })
  assert.equal(r.ok, true)
  assert.equal(r.denyCount, 1)
})

test('missing database reports ok:false instead of throwing', () => {
  const r = sessionReport({ dbPath: path.join(tempDir(), 'nope.db'), sessionId: 'sess_x' })
  assert.equal(r.ok, false)
  assert.match(r.error, /no database|not found/i)
})

test('deny detection reads metadata.modelContent when output is empty', () => {
  const dbPath = fixtureDb()
  const db = new DatabaseSync(dbPath)
  db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('p6', 'sess_a', 15, JSON.stringify({
    type: 'tool', tool: 'Read',
    state: { status: 'error', input: { file_path: 'D:/Projects/MemAI/src/page.mjs' }, output: '', metadata: { modelContent: '# MemAi guard — src/page.mjs withheld (50.1 KB ≈ 12926 tok)' } },
  }))
  db.close()
  const r = sessionReport({ dbPath, sessionId: 'sess_a' })
  assert.equal(r.ok, true)
  assert.equal(r.denyCount, 2, 'p5 output form + p6 modelContent form')
})

test('toolEvents exposes per-call inputs for A/B attribution', () => {
  const dbPath = fixtureDb()
  const r = sessionReport({ dbPath, sessionId: 'sess_a' })
  assert.ok(Array.isArray(r.toolEvents), 'toolEvents is an array')
  assert.equal(r.toolEvents.filter((e) => e.tool === 'Read').length, 3)
  const fault = r.toolEvents.find((e) => e.tool === 'fault')
  assert.equal(fault.input.target, 'query')
  assert.equal(fault.status, 'completed')
  assert.ok(fault.outputBytes > 0)
})
