// Live guard A/B: three read-heavy tasks, run headless twice — guard disabled
// (baseline) and guard enabled (treatment) — then measured from the ZCode app DB.
//
// Requires: the PreToolUse hook installed AND TRUSTED in ZCode (see
// adapters/zcode/README.md "Trust gate"); trustable only in the app's hooks
// review. Usage:
//   node tools/guard-ab.mjs --dry-run
//   node tools/guard-ab.mjs            # runs the 6 sessions, prints the table
//
// Per-arm control is project-scoped: .memai/guard.json {"enabled": false} for
// the baseline, {"enabled": true} for the treatment. The hook stays installed
// in both arms, so its spawn overhead is identical.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { sessionsSince, sessionReport } from './zcode-session-report.mjs'

const ROOT = 'D:/Projects/MemAI'
const ZCODE = 'C:/Program Files/ZCode/resources/glm/zcode.cjs'
const GUARD_JSON = path.join(ROOT, '.memai', 'guard.json')
const OUT_DIR = path.join(ROOT, 'bench')

// Two prompt sets:
// - command: explicitly orders a whole-file read — the regime where the guard
//   fires. An explicit order tests whether the deny page steers the model to a
//   fault when there is no advertised bypass.
// - question: a task that lets the model choose how to gather information.
export const TASK_SETS = {
  command: [
    { id: 'C1', file: 'src/page.mjs', prompt: 'Read D:/Projects/MemAI/src/page.mjs in full, then list its five largest functions with line numbers. Do not modify files.' },
    { id: 'C2', file: 'src/store.mjs', prompt: 'Read D:/Projects/MemAI/src/store.mjs in full, then summarize how symbolSearch ranks results. Do not modify files.' },
    { id: 'C3', file: 'src/extract.mjs', prompt: 'Read D:/Projects/MemAI/src/extract.mjs in full, then summarize how symbols are extracted. Do not modify files.' },
  ],
  question: [
    { id: 'Q1', file: 'src/page.mjs', prompt: 'In D:/Projects/MemAI/src/page.mjs, which function has the largest body by line span? Answer with its name and start/end line numbers.' },
    { id: 'Q2', file: 'src/store.mjs', prompt: 'How does symbolSearch in D:/Projects/MemAI/src/store.mjs rank results? Give the scoring terms and how idf is computed.' },
    { id: 'Q3', file: 'src/extract.mjs', prompt: 'Which symbol kinds does D:/Projects/MemAI/src/extract.mjs emit for markdown files, and what regex does it use?' },
  ],
}

const setGuard = (enabled) => fs.writeFileSync(GUARD_JSON, JSON.stringify({ enabled, note: 'guard-ab arm control' }) + '\n')

function runOne(task) {
  const t0 = Date.now() - 2000
  const r = spawnSync(process.execPath, [ZCODE, '-p', task.prompt, '--cwd', ROOT], {
    cwd: ROOT, encoding: 'utf8', timeout: 600_000,
  })
  const sessions = sessionsSince({ sinceMs: t0, cwd: ROOT }).filter((s) => !s.parentId)
  const s = sessions[0]
  if (!s) return { task: task.id, ok: false, error: 'no session recorded', exit: r.status }
  const rep = sessionReport({ sessionId: s.id })
  return {
    task: task.id, file: task.file, session: s.id, exit: r.status,
    ok: rep.ok,
    billedInput: rep.billedInput, input: rep.tokens.input, cacheRead: rep.tokens.cacheRead,
    output: rep.tokens.output, turns: rep.turns,
    reads: rep.reads.length, wholeFileReads: rep.wholeFileReads, denies: rep.denyCount,
    faults: rep.toolCalls.filter((t) => t.tool === 'fault').reduce((a, t) => a + t.count, 0),
    tools: rep.toolCalls.map((t) => `${t.tool}×${t.count}`).join(' '),
  }
}

export function renderTable(rows) {
  const lines = [
    '| task | file | arm | billed-in | whole-file reads | denies | faults | out |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const r of rows) {
    lines.push(`| ${r.task} | ${r.file} | ${r.arm} | ${r.billedInput} | ${r.wholeFileReads} | ${r.denies} | ${r.faults ?? 0} | ${r.output} |`)
  }
  return lines.join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  const setFlag = argv.indexOf('--task-set')
  const setName = setFlag >= 0 && argv[setFlag + 1] ? argv[setFlag + 1] : 'command'
  const TASKS = TASK_SETS[setName]
  if (!TASKS) { process.stderr.write(`unknown --task-set ${setName} (use ${Object.keys(TASK_SETS).join('|')})\n`); process.exitCode = 2; return }
  const dry = argv.includes('--dry-run')
  if (dry) {
    process.stdout.write(`# dry run [${setName}] — ${TASKS.length} tasks × 2 arms = ${TASKS.length * 2} headless sessions\n`)
    for (const t of TASKS) process.stdout.write(`${t.id} ${t.file}: ${t.prompt.slice(0, 80)}…\n`)
    return
  }
  const rows = []
  const arms = [
    { arm: 'baseline', enabled: false },
    { arm: 'treatment', enabled: true },
  ]
  for (const a of arms) {
    setGuard(a.enabled)
    for (const task of TASKS) {
      let r = runOne(task)
      if (r.billedInput === 0) r = runOne(task) // one transient empty run was observed
      rows.push({ ...r, arm: a.arm })
      process.stderr.write(`${a.arm} ${task.id}: billedIn=${r.billedInput} whole=${r.wholeFileReads} denies=${r.denies}\n`)
    }
  }
  fs.rmSync(GUARD_JSON, { force: true }) // leave the project at defaults
  const table = renderTable(rows)
  const stamp = new Date().toISOString().slice(0, 10)
  fs.writeFileSync(path.join(OUT_DIR, `guard-live-${stamp}-${setName}.json`), JSON.stringify({ date: stamp, taskSet: setName, root: ROOT, rows }, null, 2) + '\n')
  fs.writeFileSync(path.join(OUT_DIR, `guard-live-${stamp}-${setName}.md`), `# live guard A/B [${setName}] — ${stamp}\n\n${table}\n`)
  process.stdout.write(table + '\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) main()
