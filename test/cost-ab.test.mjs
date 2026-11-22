// Pure tests for the live A/B gate. No ZCode sessions are started.
import test from 'node:test'
import assert from 'node:assert/strict'
import { gate, renderTable, TASK_SETS } from '../tools/cost-ab.mjs'

test('gate passes only when every task is non-worse and the total is lower', () => {
  const rows = [
    { id: 'P1', arm: 'baseline', billedInput: 1000, correct: true },
    { id: 'P1', arm: 'treatment', billedInput: 900, correct: true },
    { id: 'P2', arm: 'baseline', billedInput: 1000, correct: true },
    { id: 'P2', arm: 'treatment', billedInput: 950, correct: true },
  ]
  const v = gate(rows)
  assert.equal(v.ok, true)
  assert.equal(v.baseTotal, 2000)
  assert.equal(v.treatTotal, 1850)
})

test('gate fails when one task is worse even if the total is lower', () => {
  const rows = [
    { id: 'P1', arm: 'baseline', billedInput: 1000, correct: true },
    { id: 'P1', arm: 'treatment', billedInput: 1100, correct: true },
    { id: 'P2', arm: 'baseline', billedInput: 1000, correct: true },
    { id: 'P2', arm: 'treatment', billedInput: 500, correct: true },
  ]
  const v = gate(rows)
  assert.equal(v.ok, false)
  assert.match(v.failures.join(' '), /P1/)
})

test('gate fails on an incorrect treatment answer', () => {
  const rows = [
    { id: 'P1', arm: 'baseline', billedInput: 1000, correct: true },
    { id: 'P1', arm: 'treatment', billedInput: 900, correct: false },
  ]
  assert.equal(gate(rows).ok, false)
})

test('gate fails when an arm is missing', () => {
  const v = gate([{ id: 'P1', arm: 'baseline', billedInput: 1000, correct: true }])
  assert.equal(v.ok, false)
  assert.match(v.failures.join(' '), /missing arm/)
})

test('renderTable includes both arms and the correctness column', () => {
  const t = renderTable([
    { id: 'P1', arm: 'baseline', billedInput: 1, turns: 2, cliCalls: 3, correct: true },
    { id: 'P1', arm: 'treatment', billedInput: 2, turns: 2, cliCalls: 3, correct: true },
  ])
  assert.match(t, /baseline/)
  assert.match(t, /treatment/)
  assert.match(t, /local CLI/)
})

test('payload task set has stable ids and expectations', () => {
  assert.deepEqual(TASK_SETS.payload.map((t) => t.id), ['P1', 'P2', 'P3'])
  for (const t of TASK_SETS.payload) assert.ok(t.expect instanceof RegExp)
})

test('turns tasks require the local CLI; the resume task requires fewer calls', () => {
  assert.deepEqual(TASK_SETS.turns.map((t) => t.id), ['T1', 'T2', 'T3'])
  for (const t of TASK_SETS.turns) {
    assert.equal(t.requireCli, true)
    assert.equal(!!t.requireFewerCalls, t.id === 'T2')
    assert.match(t.prompt, /node bin\/memai\.mjs/)
  }
})

test('gate fails when the treatment does not use fewer local CLI calls', () => {
  const rows = [
    { id: 'T1', arm: 'baseline', billedInput: 1000, correct: true, valid: true, cliCalls: 2 },
    { id: 'T1', arm: 'treatment', billedInput: 900, correct: true, valid: true, cliCalls: 2, requireFewerCalls: true },
  ]
  const v = gate(rows)
  assert.equal(v.ok, false)
  assert.match(v.failures.join(' '), /fewer local CLI calls/)
})
