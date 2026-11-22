// ZCode session report: billed tokens, tool calls, whole-file reads and guard
// denials for one session (or all sessions under a directory since a time).
//
// Read-only over the ZCode app database; schema observed on ZCode 0.17.x:
//   session(id, directory, title, time_created)
//   turn_usage(session_id, input_tokens, output_tokens, reasoning_tokens,
//              cache_read_input_tokens, cache_creation_input_tokens)
//   part(session_id, time_created, data)  -- data JSON: {type:'tool', tool, state:{input,output,status}}
//
// Usage:
//   node tools/zcode-session-report.mjs --session sess_xxx [--json]
//   node tools/zcode-session-report.mjs --cwd D:/Projects/MemAI --since 2h [--json]
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const DEFAULT_DB = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.zcode', 'cli', 'db', 'db.sqlite')
const GUARD_MARK = 'MemAi guard'

const parseSince = (v) => {
  if (v === undefined || v === null) return 0
  if (typeof v === 'number') return v
  const m = String(v).match(/^(\d+(?:\.\d+)?)([smhd])$/)
  if (!m) return 0
  const n = Number(m[1])
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]
  return Date.now() - n * unit
}

function open(dbPath) {
  if (!fs.existsSync(dbPath)) return null
  try { return new DatabaseSync(dbPath, { readOnly: true }) } catch { return null }
}

export function sessionsSince({ dbPath = DEFAULT_DB, sinceMs = 0, cwd = null } = {}) {
  const db = open(dbPath)
  if (!db) return []
  try {
    let rows = db.prepare('SELECT id, directory, title, time_created, parent_id FROM session WHERE time_created >= ? ORDER BY time_created DESC').all(sinceMs)
    if (cwd) {
      const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const want = norm(cwd)
      rows = rows.filter((r) => norm(r.directory) === want)
    }
    return rows.map((r) => ({ id: r.id, directory: r.directory, title: r.title, created: r.time_created, parentId: r.parent_id ?? null }))
  } finally { db.close() }
}

export function sessionReport({ dbPath = DEFAULT_DB, sessionId } = {}) {
  const db = open(dbPath)
  if (!db) return { ok: false, error: `no database at ${dbPath}`, sessionId }
  try {
    const session = db.prepare('SELECT id, directory, title, time_created FROM session WHERE id = ?').get(sessionId)
    if (!session) return { ok: false, error: `no session ${sessionId}`, sessionId }

    const t = db.prepare(`SELECT COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
      COALESCE(SUM(reasoning_tokens),0) AS reasoning, COALESCE(SUM(cache_read_input_tokens),0) AS cacheRead,
      COALESCE(SUM(cache_creation_input_tokens),0) AS cacheWrite, COUNT(*) AS turns
      FROM turn_usage WHERE session_id = ?`).get(sessionId)

    const parts = db.prepare('SELECT data FROM part WHERE session_id = ? ORDER BY time_created').all(sessionId)
    const reads = []
    const denied = []
    const calls = new Map()
    for (const row of parts) {
      let d
      try { d = JSON.parse(row.data) } catch { continue }
      if (d?.type !== 'tool' || !d.tool) continue
      const st = d.state ?? {}
      const entry = calls.get(d.tool) ?? { tool: d.tool, count: 0, errors: 0, outputBytes: 0 }
      entry.count += 1
      if (st.status === 'error') entry.errors += 1
      entry.outputBytes += typeof st.output === 'string' ? st.output.length : 0
      calls.set(d.tool, entry)
      if (d.tool !== 'Read') continue
      const input = st.input ?? {}
      const out = typeof st.output === 'string' ? st.output : ''
      // A denied call has status "error" with an empty output; the reason the
      // model sees lives in metadata.modelContent (observed on ZCode 0.17.x).
      const modelText = typeof st.metadata?.modelContent === 'string' ? st.metadata.modelContent : ''
      const isDeny = out.includes(GUARD_MARK) || modelText.includes(GUARD_MARK)
      const rec = {
        path: input.file_path ?? input.filePath ?? input.path ?? null,
        partial: input.offset !== undefined || input.limit !== undefined || input.start_line !== undefined,
        wholeFile: input.offset === undefined && input.limit === undefined && input.start_line === undefined,
        outputBytes: Math.max(out.length, modelText.length),
        status: st.status ?? null,
        denied: isDeny,
      }
      reads.push(rec)
      if (isDeny) denied.push(rec)
    }

    return {
      ok: true,
      session: { id: session.id, directory: session.directory, title: session.title, created: session.time_created },
      turns: t.turns,
      tokens: { input: t.input, output: t.output, reasoning: t.reasoning, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite },
      billedInput: t.input + t.cacheRead + t.cacheWrite,
      toolCalls: [...calls.values()].sort((a, b) => b.count - a.count),
      reads,
      wholeFileReads: reads.filter((r) => r.wholeFile && !r.denied).length,
      denyCount: denied.length,
      denied,
    }
  } finally { db.close() }
}

export function summaryText(r) {
  if (!r.ok) return `# session report — ${r.error}`
  const tok = r.tokens
  const lines = [
    `# session ${r.session.id} — ${r.session.title ?? '(untitled)'}`,
    `dir: ${r.session.directory}  turns: ${r.turns}`,
    `tokens: input ${tok.input} · cache-read ${tok.cacheRead} · cache-write ${tok.cacheWrite} · output ${tok.output} · billed-in ${r.billedInput}`,
    `reads: ${r.reads.length} (${r.wholeFileReads} whole-file, ${r.denyCount} denied by guard)`,
    `tools: ${r.toolCalls.map((t) => `${t.tool}×${t.count}`).join(' · ')}`,
  ]
  return lines.join('\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const argv = process.argv.slice(2)
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }
  const dbPath = flag('db', DEFAULT_DB)
  const sessionId = flag('session')
  if (sessionId) {
    const r = sessionReport({ dbPath, sessionId })
    process.stdout.write((argv.includes('--json') ? JSON.stringify(r) : summaryText(r)) + '\n')
    process.exit(r.ok ? 0 : 1)
  }
  const list = sessionsSince({ dbPath, sinceMs: parseSince(flag('since', '24h')), cwd: flag('cwd') })
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(list) + '\n')
  else process.stdout.write(list.map((s) => `${s.id}  ${new Date(s.created).toISOString()}  ${s.title ?? ''}`).join('\n') + '\n')
}
