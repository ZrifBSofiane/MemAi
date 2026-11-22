// Live cost A/B: same prompt, two worktrees, billed input from the ZCode DB.
//
// Both directories must have a fresh .memai index:
//   (cd <dir> && node bin/memai.mjs index)
//
// Usage:
//   node tools/cost-ab.mjs --dry-run
//   node tools/cost-ab.mjs --baseline ../MemAi-base --treatment ../MemAi-payload --label payload
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionsSince, sessionReport } from './zcode-session-report.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const OUT = path.join(ROOT, 'bench')
const ZCODE = process.env.ZCODE_BIN || 'C:/Program Files/ZCode/resources/glm/zcode.cjs'

export const TASK_SETS = {
  payload: [
    {
      id: 'P1',
      expect: /flushDelayMs|startWatcher/,
      prompt: 'Use the memai CLI via Bash (not MCP) to find where the watcher debounce is implemented in this project. Answer with the function name only.',
    },
    {
      id: 'P2',
      expect: /bm25|rank/i,
      prompt: 'Use the memai CLI via Bash (not MCP) to find how symbolSearch ranks results. Answer with the scoring column or function name.',
    },
    {
      id: 'P3',
      expect: /pack/,
      prompt: 'Use the memai CLI via Bash (not MCP) to list the MemAi MCP operations. Answer with the operation names.',
    },
  ],
}

export function gate(rows) {
  const byTask = new Map()
  for (const r of rows) {
    const t = byTask.get(r.id) ?? {}
    t[r.arm] = r
    byTask.set(r.id, t)
  }
  const failures = []
  let baseTotal = 0
  let treatTotal = 0
  for (const [id, t] of byTask) {
    if (!t.baseline || !t.treatment) { failures.push(`${id}: missing arm`); continue }
    if (!Number.isFinite(t.baseline.billedInput) || !Number.isFinite(t.treatment.billedInput)) {
      failures.push(`${id}: missing billedInput`)
      continue
    }
    baseTotal += t.baseline.billedInput
    treatTotal += t.treatment.billedInput
    if (t.treatment.billedInput > t.baseline.billedInput) {
      failures.push(`${id}: treatment ${t.treatment.billedInput} > baseline ${t.baseline.billedInput}`)
    }
    if (t.treatment.correct === false) failures.push(`${id}: incorrect answer`)
  }
  if (treatTotal >= baseTotal) failures.push(`total ${treatTotal} >= baseline ${baseTotal}`)
  return { ok: failures.length === 0, failures, baseTotal, treatTotal }
}

export function renderTable(rows) {
  const lines = [
    '| task | arm | billed-in | turns | tool calls | --text calls | correct |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
  ]
  for (const r of rows) {
    lines.push(`| ${r.id} | ${r.arm} | ${r.billedInput ?? '-'} | ${r.turns ?? '-'} | ${r.toolCalls ?? '-'} | ${r.bashTextCalls ?? '-'} | ${r.correct === null ? '-' : r.correct ? 'yes' : 'no'} |`)
  }
  return lines.join('\n')
}

function runOne({ dir, task, arm }) {
  const sinceMs = Date.now() - 2000
  const res = spawnSync(process.execPath, [ZCODE, '-p', task.prompt, '--cwd', dir], {
    cwd: dir, encoding: 'utf8', timeout: 600_000,
  })
  const session = sessionsSince({ sinceMs, cwd: dir }).filter((s) => !s.parentId)[0]
  if (!session) return { id: task.id, arm, dir, ok: false, error: 'no session recorded', exit: res.status }
  const rep = sessionReport({ sessionId: session.id })
  if (!rep.ok) return { id: task.id, arm, dir, ok: false, error: rep.error, session: session.id }
  const events = rep.toolEvents ?? []
  const commandOf = (e) => typeof e.input?.command === 'string' ? e.input.command : ''
  const bashTextCalls = events.filter((e) => e.tool === 'Bash' && commandOf(e).includes('--text')).length
  const memCalls = events.filter((e) => /mem/i.test(e.tool)).length
    + events.filter((e) => e.tool === 'Bash' && /memai\s/.test(commandOf(e))).length
  return {
    id: task.id, arm, dir, session: session.id, exit: res.status, ok: true,
    billedInput: rep.billedInput, turns: rep.turns,
    toolCalls: events.length,
    toolErrors: events.filter((e) => e.status === 'error').length,
    bashTextCalls, memCalls,
    correct: task.expect ? task.expect.test(res.stdout ?? '') : null,
    stdoutTail: (res.stdout ?? '').slice(-400),
  }
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null
}

function main() {
  const argv = process.argv.slice(2)
  const setName = flag(argv, 'tasks') ?? 'payload'
  const tasks = TASK_SETS[setName]
  if (!tasks) {
    process.stderr.write(`unknown --tasks ${setName}; use ${Object.keys(TASK_SETS).join('|')}\n`)
    process.exitCode = 2
    return
  }
  const baseline = flag(argv, 'baseline')
  const treatment = flag(argv, 'treatment')
  if (argv.includes('--dry-run')) {
    process.stdout.write(`# dry run [${setName}] — ${tasks.length} tasks × 2 arms = ${tasks.length * 2} sessions\n`)
    process.stdout.write(`baseline:  ${baseline ?? '(missing --baseline)'}\n`)
    process.stdout.write(`treatment: ${treatment ?? '(missing --treatment)'}\n`)
    for (const t of tasks) process.stdout.write(`${t.id}: ${t.prompt.slice(0, 80)}…\n`)
    return
  }
  if (!baseline || !treatment) {
    process.stderr.write('usage: node tools/cost-ab.mjs --baseline <dir> --treatment <dir> [--tasks payload] [--label name]\n')
    process.exitCode = 2
    return
  }
  const rows = []
  for (const [arm, dir] of [['baseline', baseline], ['treatment', treatment]]) {
    for (const task of tasks) {
      let r = runOne({ dir, task, arm })
      if (r.billedInput === 0) r = runOne({ dir, task, arm })
      rows.push(r)
      process.stderr.write(`${arm} ${task.id}: billedIn=${r.billedInput ?? '-'} textCalls=${r.bashTextCalls ?? '-'}\n`)
    }
  }
  const verdict = gate(rows)
  const label = flag(argv, 'label') ?? setName
  const stamp = new Date().toISOString().slice(0, 10)
  const md = `# live cost A/B [${label}] — ${stamp}\n\n${renderTable(rows)}\n\n${verdict.ok ? 'PASS' : 'FAIL'}: ${verdict.failures.length ? verdict.failures.join('; ') : `total ${verdict.treatTotal} < ${verdict.baseTotal}`}\n`
  fs.writeFileSync(path.join(OUT, `cost-ab-${stamp}-${label}.json`), JSON.stringify({ date: stamp, set: setName, dirs: { baseline, treatment }, verdict, rows }, null, 2) + '\n')
  fs.writeFileSync(path.join(OUT, `cost-ab-${stamp}-${label}.md`), md)
  process.stdout.write(md)
  process.exitCode = verdict.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main()
