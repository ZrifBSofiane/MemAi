// Host-only MemAi plugin for DeepSeek Harness. Node builtins only: a linked workspace bundle cannot
// import @deepseek-ai/* (see .research/memory/internals.md §2.2).
//
// What it does (see README.md):
//   1. `systemPrompt.context({required:true})` — a tiny project card reaches EVERY in-process
//      agent (lead, spawned/forked subagents, team members), appended only when it changes,
//      restored after compaction.
//   2. `systemPrompt.section` — static guidance in the cached system-prompt prefix.
//   3. `tools.register` — one `mem` tool: page content in on demand instead of re-reading files.
//
// The store is a plain SQLite file (node:sqlite) under $DSH_HOME/memai/memai.db. Pages are written
// by the MemAi indexer (npx -y memai-cli index), or any producer that keeps the same shape.
// (Host-API audit behind this design: .research/memory/internals.md in the development workspace.)
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'memai'
export const inject = ['systemPrompt', 'tools']

const DEFAULTS = { dbPath: '', cardMaxTokens: 120, toolName: 'mem' }
const CHARS_PER_TOKEN = 3.966 // calibrated against provider usage in local DSH session logs

export function resolveDbPath (config) {
  if (typeof config?.dbPath === 'string' && config.dbPath.length > 0) return config.dbPath
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'memai', 'memai.db')
}

export function openStore (dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 4000;
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, version_hash TEXT,
      text TEXT NOT NULL, tokens INTEGER NOT NULL, bytes INTEGER, updated_at INTEGER NOT NULL,
      producer TEXT, meta TEXT);
    CREATE TABLE IF NOT EXISTS board (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL,
      agent TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL);
  `)
  // Compatibility with a store written by the core MemAi CLI/adapters: those
  // tables use `pages.version_hash`, the original plugin schema used `version`.
  try {
    const cols = db.prepare('PRAGMA table_info(pages)').all().map((c) => c.name)
    if (!cols.includes('version_hash')) db.exec('ALTER TABLE pages ADD COLUMN version_hash TEXT')
    if (cols.includes('version')) db.exec('UPDATE pages SET version_hash = version WHERE version_hash IS NULL')
  } catch { /* read-only or exotic store: ops still work, diff falls back below */ }
  return db
}

const estTokens = (text) => Math.ceil(String(text).length / CHARS_PER_TOKEN)

function bounded (text, maxChars = 4000) {
  const s = String(text ?? '')
  if (s.length <= maxChars) return s
  return `${s.slice(0, maxChars)}\n(Omitted ${s.length - maxChars} chars; ask for a narrower page/range.)`
}

function header (tokens) {
  return `tokens≈${tokens} | `
}

export function apply (ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const db = openStore(resolveDbPath(config))
  ctx.effect(() => () => { try { db.close() } catch {} }, 'memai.store()')

  const pageText = (kind) => {
    try {
      const row = db.prepare('SELECT text FROM pages WHERE kind = ? ORDER BY updated_at DESC LIMIT 1').get(kind)
      return row?.text ?? ''
    } catch { return '' }
  }
  const cardText = () => pageText('project.card')

  // (a) The `mem` tool: one always-visible schema; compact text results only.
  ctx.effect(() => ctx.tools.register({
    name: config.toolName,
    description:
      'Read project memory pages instead of re-reading files. Start with op:"card"; use op:"query" to find a page, ' +
      'op:"get" for a page id, op:"fault" for exact lines, op:"diff" since a version, op:"note"/"post" to write to the shared board.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: { type: 'string', enum: ['card', 'map', 'get', 'query', 'diff', 'fault', 'note', 'post', 'inbox'] },
        id: { type: 'string' },
        query: { type: 'string' },
        path: { type: 'string' },
        topic: { type: 'string' },
        body: { type: 'string' },
        since: { type: 'integer' },
        maxChars: { type: 'integer' }
      },
      required: ['op']
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute (args, exec) {
      const sessionId = exec?.agent?.id ?? 'unknown'
      const cap = Number.isFinite(args.maxChars) ? Math.min(Math.max(args.maxChars, 500), 12000) : 4000
      switch (args.op) {
        case 'card': {
          const t = cardText()
          if (!t) return '(no project card indexed yet — run the indexer or mem({op:"query"}))'
          return header(estTokens(t)) + (t.length / CHARS_PER_TOKEN > config.cardMaxTokens ? bounded(t, cap) : t)
        }
        case 'map': {
          const t = pageText('project.map')
          return t ? header(estTokens(t)) + bounded(t, cap) : '(no map indexed yet)'
        }
        case 'get': {
          const row = args.id ? db.prepare('SELECT text FROM pages WHERE id = ?').get(args.id) : undefined
          if (!row) return `(no page ${String(args.id ?? '')})`
          const t = String(row.text)
          const out = bounded(t, cap)
          return header(estTokens(out)) + out
        }
        case 'query': {
          const like = `%${String(args.query ?? '').replaceAll('%', '')}%`
          const rows = db.prepare('SELECT id, kind, tokens FROM pages WHERE text LIKE ? LIMIT 20').all(like)
          return JSON.stringify(rows)
        }
        case 'diff': {
          const rows = db.prepare('SELECT id, kind, version_hash AS version, updated_at FROM pages WHERE updated_at > ? ORDER BY updated_at')
            .all(Number(args.since ?? 0))
          return JSON.stringify(rows)
        }
        case 'fault': {
          const q = String(args.path ?? '').replaceAll('%', '')
          const rows = db.prepare("SELECT id, kind, text FROM pages WHERE kind = 'file.page' AND id LIKE ? LIMIT 3").all(`%${q}%`)
          return JSON.stringify(rows.map((r) => ({ id: r.id, kind: r.kind, text: bounded(r.text, cap) })))
        }
        case 'note':
        case 'post': {
          db.prepare('INSERT INTO board (topic, agent, body, ts) VALUES (?, ?, ?, ?)')
            .run(String(args.topic ?? 'general'), sessionId, String(args.body ?? ''), Date.now())
          return 'ok'
        }
        case 'inbox': {
          const rows = db.prepare('SELECT seq, topic, agent, body, ts FROM board WHERE seq > ? ORDER BY seq LIMIT 50')
            .all(Number(args.since ?? 0))
          return JSON.stringify(rows)
        }
        default: throw new Error(`unknown op: ${String(args.op)}`)
      }
    }
  }), 'memai.tool()')

  // (b) Invariant guidance in the cached system-prompt prefix. Static text only: any change here
  //     rewrites the prefix and forfeits provider prefix-cache hits for that span.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'memai:guidance',
    order: 1500,
    text: 'A compact project card is present in your runtime context. Prefer it and mem({op:"card"|"map"|"query"|"get"|"fault"|"diff"}) ' +
      'over re-reading project files; page ids are stable and cheap. Never inline a whole file when a page id suffices.'
  }), 'memai.section()')

  // (c) The card itself: a REQUIRED runtime context -> every in-process agent (lead, spawn/fork
  //     subagents, team members). Append-only + deduped: an unchanged value adds nothing, so it is
  //     cache-stable; it is also restored after compaction and in complete-mode personas.
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'memai:project-card',
    order: 130,
    required: true,
    text: () => cardText()
  }), 'memai.context()')
}
