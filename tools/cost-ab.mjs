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
  turns: [
    {
      id: 'T1',
      requireCli: true,
      tolerancePct: 1,
      expect: /flushDelayMs|startWatcher/,
      prompt: 'Use exactly one local CLI call: `node bin/memai.mjs query "how does the watcher debounce work" --body --text`. Answer with the function that computes the delay. Do not use the MCP tool, a globally installed `memai`, or any other lookup.',
    },
    {
      id: 'T2',
      requireCli: true,
      requireFewerCalls: true,
      expect: /empty|nothing changed|no changes|up to date|src\//i,
      prompt: 'Call `node bin/memai.mjs card --text` once. If the card carries a `version:` line, call `node bin/memai.mjs diff --since <that version> --text` once and list the changed files. If it does not, call `node bin/memai.mjs status --text` once to get the version, then the same diff. Answer with the changed files.',
    },
    {
      id: 'T3',
      requireCli: true,
      expect: /watch\.mjs/,
      prompt: 'Use exactly one local CLI call: `node bin/memai.mjs query "breakerLogged" --text`. Answer with the file path that contains that token. Do not use the MCP tool, a globally installed `memai`, or grep.',
    },
  ],
  faultcomplete: [
    {
      id: 'FC1',
      requireCli: true,
      tolerancePct: 1,
      expect: /flushDelayMs|DEBOUNCE_MS/,
      prompt: 'Use exactly one local CLI call: `node bin/memai.mjs fault startWatcher --text`. Explain how the watcher debounce delay is computed. Answer with the function name.',
    },
    {
      id: 'FC2',
      requireCli: true,
      tolerancePct: 1,
      expect: /reuse|content_hash|version/i,
      prompt: 'Use exactly one local CLI call: `node bin/memai.mjs fault "src/extract.mjs#indexFiles" --text`. Explain how it decides to reuse a file.',
    },
    {
      id: 'FC3',
      requireCli: true,
      tolerancePct: 1,
      expect: /body|source|score/i,
      prompt: 'Use exactly one local CLI call: `node bin/memai.mjs fault "src/page.mjs#query" --text`. Explain how `--body` chooses a symbol.',
    },
  ],
  composite: [
    {
      id: 'C1',
      requireCli: true,
      requireFewerCalls: true,
      tolerancePct: 1,
      expect: /indexCorpus|indexFiles/,
      prompt: 'Find the functions that call the function that decides to reuse unchanged files during indexing. Use the local CLI (`node bin/memai.mjs`); do not use grep or the MCP tool. Answer with the caller names.',
    },
    {
      id: 'C2',
      requireCli: true,
      requireFewerCalls: true,
      tolerancePct: 1,
      expect: /distilFile|no changes|empty/i,
      prompt: 'Use the card version and show what changed since it, including the body of the function that decides to reuse unchanged files. Use the local CLI (`node bin/memai.mjs`); do not use grep or the MCP tool.',
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
    const tolerance = Number(t.treatment.tolerancePct ?? 0)
    const limit = t.baseline.billedInput * (1 + tolerance / 100)
    if (t.treatment.billedInput > limit) {
      failures.push(`${id}: treatment ${t.treatment.billedInput} > baseline ${t.baseline.billedInput}${tolerance ? ` (+${tolerance}% tolerance)` : ''}`)
    }
    if (t.treatment.correct === false) failures.push(`${id}: incorrect answer`)
    if (t.baseline.valid === false) failures.push(`${id}: baseline did not run the local CLI`)
    if (t.treatment.valid === false) failures.push(`${id}: treatment did not run the local CLI`)
    if (t.treatment.requireFewerCalls && !(Number.isFinite(t.baseline.cliCalls) && t.treatment.cliCalls < t.baseline.cliCalls)) {
      failures.push(`${id}: treatment did not use fewer local CLI calls (${t.treatment.cliCalls} vs ${t.baseline.cliCalls})`)
    }
  }
  if (treatTotal >= baseTotal) failures.push(`total ${treatTotal} >= baseline ${baseTotal}`)
  return { ok: failures.length === 0, failures, baseTotal, treatTotal }
}

export function renderTable(rows) {
  const lines = [
    '| task | arm | billed-in | turns | local CLI | correct |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ]
  for (const r of rows) {
    lines.push(`| ${r.id} | ${r.arm} | ${r.billedInput ?? '-'} | ${r.turns ?? '-'} | ${r.cliCalls ?? '-'} | ${r.correct === null ? '-' : r.correct ? 'yes' : 'no'} |`)
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
  const localCli = (cmd) => /bin[\\/]memai\.mjs/.test(cmd)
  const cliCalls = events.filter((e) => e.tool === 'Bash' && localCli(commandOf(e))).length
  const memCalls = events.filter((e) => /mem/i.test(e.tool)).length
    + events.filter((e) => e.tool === 'Bash' && /memai\s/.test(commandOf(e))).length
  return {
    id: task.id, arm, dir, session: session.id, exit: res.status, ok: true,
    billedInput: rep.billedInput, turns: rep.turns,
    toolCalls: events.length,
    toolErrors: events.filter((e) => e.status === 'error').length,
    cliCalls, memCalls,
    valid: task.requireCli ? cliCalls > 0 : true,
    requireFewerCalls: !!task.requireFewerCalls,
    tolerancePct: Number(task.tolerancePct ?? 0),
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
  const baselineDir = baseline ? path.resolve(baseline) : null
  const treatmentDir = treatment ? path.resolve(treatment) : null
  if (argv.includes('--dry-run')) {
    process.stdout.write(`# dry run [${setName}] — ${tasks.length} tasks × 2 arms = ${tasks.length * 2} sessions\n`)
    process.stdout.write(`baseline:  ${baselineDir ?? '(missing --baseline)'}\n`)
    process.stdout.write(`treatment: ${treatmentDir ?? '(missing --treatment)'}\n`)
    for (const t of tasks) process.stdout.write(`${t.id}: ${t.prompt.slice(0, 80)}…\n`)
    return
  }
  if (!baselineDir || !treatmentDir) {
    process.stderr.write('usage: node tools/cost-ab.mjs --baseline <dir> --treatment <dir> [--tasks payload] [--label name]\n')
    process.exitCode = 2
    return
  }
  const rows = []
  for (const [arm, dir] of [['baseline', baselineDir], ['treatment', treatmentDir]]) {
    for (const task of tasks) {
      let r = runOne({ dir, task, arm })
      if (r.billedInput === 0) r = runOne({ dir, task, arm })
      rows.push(r)
      process.stderr.write(`${arm} ${task.id}: billedIn=${r.billedInput ?? '-'} cli=${r.cliCalls ?? '-'}\n`)
    }
  }
  const verdict = gate(rows)
  const label = flag(argv, 'label') ?? setName
  const stamp = new Date().toISOString().slice(0, 10)
  const md = `# live cost A/B [${label}] — ${stamp}\n\n${renderTable(rows)}\n\n${verdict.ok ? 'PASS' : 'FAIL'}: ${verdict.failures.length ? verdict.failures.join('; ') : `total ${verdict.treatTotal} < ${verdict.baseTotal}`}\n`
  fs.writeFileSync(path.join(OUT, `cost-ab-${stamp}-${label}.json`), JSON.stringify({ date: stamp, set: setName, dirs: { baseline: baselineDir, treatment: treatmentDir }, verdict, rows }, null, 2) + '\n')
  fs.writeFileSync(path.join(OUT, `cost-ab-${stamp}-${label}.md`), md)
  process.stdout.write(md)
  process.exitCode = verdict.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main()
