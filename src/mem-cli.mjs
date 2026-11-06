// Thin agent-callable CLI. Designed for bash/tool use from a coding agent:
// JSON on stdout, a `tokens` field on EVERY response, hard token budgets, and
// no file bodies unless explicitly demand-paged.
//
//   node src/cli.mjs <command> [args] [--flags]
//
// Run `node src/cli.mjs help` for the surface.
import fs from 'node:fs'
import path from 'node:path'
import { MemoryStore } from './store.mjs'
import { MemoryPages, DEFAULTS } from './page.mjs'
import { estTokens } from './tokens.mjs'

export const VERSION = '0.1.1'

const HELP = `MemAi CLI  (tokens are the currency; every response has a token count)

  init                       create .memai/mem.db (no index)
  index [--max-files N] [--force]
                             distil the working tree into pages (local, 0 model tokens)
  status                     corpus + store + version summary
  card [--budget 700]        project card: stack, commands, entrypoints, conventions
  map [--budget 3500]        symbol map for every file (the "don't read files" page)
  diff [--since HASH]        tiny delta from an old version (new-session resume)
  get <pageId> [--budget 1200]    page text (file:<path> | project.card | project.map | board:<t>)
  query <terms> [--k 5] [--budget 400]   ranked page/symbol hits, snippets only
  fault <sym | path#sym | path:line | path> [--budget 600]   demand-page one slice
  note <topic> <body> [--agent A]        append to shared board (deduped)
  post <topic> <body> [--agent A]        broadcast message
  inbox <agent> [--since N] [--topic T]  messages since cursor (advances cursor)
  agents                     known agents, status, read cursors
  edit <pageId> <body> [--agent A]       stage a COW delta (does not mutate page)
  merge <pageId> [--agent A]             assemble pending edits -> new page version

global flags: --root DIR  --db FILE  --text  --cpt N (chars/token)  --json (default)

Examples:
  node src/cli.mjs index
  node src/cli.mjs card
  node src/cli.mjs query "verify token"
  node src/cli.mjs fault verifyToken --budget 400
  node src/cli.mjs diff --since 3d1a9f2c
`

function parseArgv(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++ } else flags[key] = true
    } else positional.push(a)
  }
  return { positional, flags }
}
const num = (v, d) => (v === undefined || v === true ? d : Number(v))

function open(flags) {
  const cwd = path.resolve(flags.root ? String(flags.root) : process.cwd())
  const dbPath = flags.db ? path.resolve(String(flags.db)) : path.join(cwd, '.memai', 'mem.db')
  const store = new MemoryStore({ dbPath, root: cwd })
  const root = store.getMeta('root') ? path.resolve(store.getMeta('root')) : cwd
  const pages = new MemoryPages({ store, root })
  return { store, pages, root, dbPath }
}

export function createEnv(flags = {}) { return open(flags) }

export async function run(argv, { env = null } = {}) {
  const { positional, flags } = parseArgv(argv)
  const cmd = positional[0] ?? 'help'
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return { ok: true, cmd: 'help', tokens: estTokens(HELP), text: HELP }
  if (flags.cpt) { const { setCharsPerToken } = await import('./tokens.mjs'); setCharsPerToken(Number(flags.cpt)) }
  if (cmd === 'init') {
    const cwd = path.resolve(flags.root ? String(flags.root) : process.cwd())
    const dbPath = flags.db ? path.resolve(String(flags.db)) : path.join(cwd, '.memai', 'mem.db')
    const store = new MemoryStore({ dbPath, root: cwd })
    store.setMeta('root', cwd)
    store.setMeta('created_at', new Date().toISOString())
    store.close()
    return { ok: true, cmd, root: cwd, db: dbPath, text: `initialized ${dbPath}` }
  }
  const ctx = env ?? open(flags)
  const { store, pages, root, dbPath } = ctx
  try {
    switch (cmd) {
      case 'index': return { ok: true, cmd, ...(await pages.index({ maxFiles: num(flags['max-files'], 4000), force: !!flags.force })) }
      case 'status': return { ok: true, cmd, ...pages.status() }
      case 'card': return { ok: true, cmd, ...pages.card({ budget: num(flags.budget, DEFAULTS.card) }) }
      case 'map': return { ok: true, cmd, ...pages.map({ budget: num(flags.budget, DEFAULTS.map) }) }
      case 'diff': return { ok: true, cmd, ...pages.diff({ since: flags.since ?? null, budget: num(flags.budget, DEFAULTS.diff) }) }
      case 'get': {
        const id = positional[1]
        if (!id) return { ok: false, cmd, error: 'usage: get <pageId>', tokens: 0 }
        return { ok: true, cmd, ...pages.get(id, { budget: num(flags.budget, DEFAULTS.get) }) }
      }
      case 'query': {
        const q = positional.slice(1).join(' ')
        if (!q) return { ok: false, cmd, error: 'usage: query <terms>', tokens: 0 }
        return { ok: true, cmd, ...pages.query(q, { k: num(flags.k, 5), budget: num(flags.budget, DEFAULTS.query) }) }
      }
      case 'fault': {
        const target = positional.slice(1).join(' ')
        if (!target) return { ok: false, cmd, error: 'usage: fault <symbol|path#symbol|path:line|path>', tokens: 0 }
        return { ok: true, cmd, ...pages.fault(target, { budget: num(flags.budget, DEFAULTS.fault) }) }
      }
      case 'note': case 'post': {
        const [topic, ...rest] = positional.slice(1)
        const body = rest.join(' ')
        if (!topic || !body) return { ok: false, cmd, error: `usage: ${cmd} <topic> <body>`, tokens: 0 }
        const agent = String(flags.agent ?? (process.env.MEMAI_AGENT ?? process.env.MEM_AGENT) ?? 'anon')
        return { ok: true, cmd, ...pages.post(topic, body, { agent, kind: cmd === 'note' ? 'note' : 'broadcast' }) }
      }
      case 'inbox': {
        const agent = positional[1] ?? String(flags.agent ?? (process.env.MEMAI_AGENT ?? process.env.MEM_AGENT) ?? 'anon')
        return { ok: true, cmd, ...pages.inbox(agent, { since: flags.since != null ? Number(flags.since) : null, topic: flags.topic ? String(flags.topic) : null, budget: num(flags.budget, 900), advance: !flags['no-advance'] }) }
      }
      case 'agents': return { ok: true, cmd, ...pages.agents() }
      case 'edit': {
        const [id, ...rest] = positional.slice(1)
        const body = rest.join(' ')
        if (!id || !body) return { ok: false, cmd, error: 'usage: edit <pageId> <body>', tokens: 0 }
        return { ok: true, cmd, ...pages.addEdit(id, body, { agent: String(flags.agent ?? (process.env.MEMAI_AGENT ?? process.env.MEM_AGENT) ?? 'anon') }) }
      }
      case 'merge': {
        const id = positional[1]
        if (!id) return { ok: false, cmd, error: 'usage: merge <pageId>', tokens: 0 }
        return { ok: true, cmd, ...pages.merge(id, { agent: String(flags.agent ?? (process.env.MEMAI_AGENT ?? process.env.MEM_AGENT) ?? 'anon'), budget: num(flags.budget, 800) }) }
      }
      default:
        return { ok: false, cmd, error: `unknown command: ${cmd}`, tokens: estTokens(HELP), text: HELP.slice(0, 1200) }
    }
  } finally {
    if (!env) { try { store.close() } catch {} }
  }
}

/** Render a CLI result envelope: JSON by default, text with --text. */
export function render(result, flags = {}) {
  // `tokens` always measures the thing the model will ingest: the text payload
  // when the command returns one, otherwise the JSON payload. The JSON envelope
  // itself is transport and may be larger; a tool wrapper should forward `text`.
  const payloadTokens = result.tokens ?? estTokens(JSON.stringify({ ...result, tokens: undefined }))
  const out = { ...result, tokens: payloadTokens }
  if (flags.text || flags.t) {
    if (result.text) return `# tokens: ${payloadTokens}\n${result.text}`
  }
  return JSON.stringify(out)
}
