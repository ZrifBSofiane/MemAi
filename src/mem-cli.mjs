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

export const VERSION = '0.4.0'

const HELP = `MemAi CLI  (tokens are the currency; every response has a token count)

  init                       create .memai/mem.db (no index)
  index [--max-files N] [--force]
                             distil the working tree into pages (local, 0 model tokens)
  status                     corpus + store + version summary
  card [--budget 700]        project card: stack, commands, entrypoints, conventions
  map [--budget 3500]        symbol map for every file (the "don't read files" page)
  diff [--since HASH]        tiny delta from an old version (new-session resume)
  diff --last [--agent A]    delta since your last checkpoint
  checkpoint [--agent A]     record the current version for a later diff --last
  graph <path|sym> [--depth N]   module dependency navigation: importers,
                             imports, reverse chains, cycles (from the imports table)
  graph --shortest <a> <b>   BFS shortest import path between two files/symbols
  affected <path|sym> [--budget 500]   blast radius: files that transitively
                             import it, with hop counts (cycle-safe)
  pack [topic] [--fault "a,b"] [--no-card] [--budget 1500]  budgeted handoff
                             bundle: card + board notes + fault slices + resume version
  eval [--fixtures FILE] [--k 5] [--modes index,hybrid]  retrieval quality harness;
                             fixtures: [{"q":"...","expect":"src/x.js"}], default .memai/eval.json
  get <pageId> [--budget 1200]    page text (file:<path> | project.card | project.map | board:<t>)
  query <terms> [--k 5] [--budget 400] [--rg]   ranked hits, snippets only;
                                 --rg unions a ripgrep body sweep (catches what the index does not page)
  fault <sym | path#sym | path:line | path> [--budget 600] [--deep]   one slice;
                                 --deep appends callees + best-effort callers
  miss "<query>" [--found-by T] [--path P] [--agent A]   log a retrieval miss (recall data)
  miss --stats                    miss counts, top missed queries, per-tool breakdown
  note <topic> <body> [--agent A]        append to shared board (deduped)
  post <topic> <body> [--agent A]        broadcast message
  inbox <agent> [--since N] [--topic T]  messages since cursor (advances cursor)
  agents                     known agents, status, read cursors
  edit <pageId> <body> [--agent A]       stage a COW delta (does not mutate page)
  merge <pageId> [--agent A]             assemble pending edits -> new page version

global flags: --root DIR  --db FILE  --text  --cpt N (chars/token)  --json (default)
              --read-only (never create a store; error if missing)  --no-stale (skip disk staleness checks)

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
  const readOnly = !!(flags['read-only'] || process.env.MEMAI_READONLY === '1')
  const store = new MemoryStore({ dbPath, root: cwd, create: !readOnly })
  const root = store.getMeta('root') ? path.resolve(store.getMeta('root')) : cwd
  const pages = new MemoryPages({ store, root })
  pages.staleCheck = !(flags['no-stale'] || process.env.MEMAI_NO_STALE === '1')
  return { store, pages, root, dbPath, readOnly }
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
  let ctx
  try {
    ctx = env ?? open(flags)
  } catch (err) {
    return { ok: false, cmd, error: err?.message ?? String(err), tokens: 0 }
  }
  const { store, pages, root, dbPath } = ctx
  try {
    switch (cmd) {
      case 'index': return { ok: true, cmd, ...(await pages.index({ maxFiles: num(flags['max-files'], 4000), force: !!flags.force })) }
      case 'status': return { ok: true, cmd, ...pages.status() }
      case 'card': return { ok: true, cmd, ...pages.card({ budget: num(flags.budget, DEFAULTS.card) }) }
      case 'map': return { ok: true, cmd, ...pages.map({ budget: num(flags.budget, DEFAULTS.map) }) }
      case 'diff': return {
        ok: true, cmd,
        ...pages.diff({
          since: flags.since ?? null, budget: num(flags.budget, DEFAULTS.diff),
          last: !!flags.last, agent: String(flags.agent ?? (process.env.MEMAI_AGENT ?? process.env.MEM_AGENT) ?? 'anon'),
        }),
      }
      case 'checkpoint': {
        const agent = String(flags.agent ?? (process.env.MEMAI_AGENT ?? process.env.MEM_AGENT) ?? 'anon')
        return { ok: true, cmd, ...pages.checkpoint(agent) }
      }
      case 'graph': {
        const targets = positional.slice(1)
        if (flags.shortest) {
          if (targets.length < 2) return { ok: false, cmd, error: 'usage: graph --shortest <a> <b>  (paths or symbols)', tokens: 0 }
          return { ok: true, cmd, ...pages.graphShortest(targets[0], targets[1], { budget: num(flags.budget, DEFAULTS.graph) }) }
        }
        const target = targets.join(' ')
        if (!target) return { ok: false, cmd, error: 'usage: graph <path|symbol> [--depth N] | graph --shortest <a> <b>', tokens: 0 }
        return { ok: true, cmd, ...pages.graph(target, { depth: num(flags.depth, 1), budget: num(flags.budget, DEFAULTS.graph) }) }
      }
      case 'affected': {
        const target = positional.slice(1).join(' ')
        if (!target) return { ok: false, cmd, error: 'usage: affected <path|symbol>', tokens: 0 }
        return { ok: true, cmd, ...pages.affected(target, { budget: num(flags.budget, DEFAULTS.graph) }) }
      }
      case 'pack': {
        const topic = positional[1] ?? 'handoff'
        const agent = String(flags.agent ?? (process.env.MEMAI_AGENT ?? process.env.MEM_AGENT) ?? 'anon')
        const faults = flags.fault && flags.fault !== true ? [String(flags.fault)] : []
        return { ok: true, cmd, ...pages.pack(topic, { budget: num(flags.budget, DEFAULTS.pack), faults, card: !flags['no-card'], agent }) }
      }
      case 'eval': {
        const file = flags.fixtures && flags.fixtures !== true ? path.resolve(String(flags.fixtures)) : path.join(root, '.memai', 'eval.json')
        let fixtures
        try { fixtures = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {
          return {
            ok: false, cmd,
            error: `no fixtures at ${file} — create it as JSON: [{"q":"verify token","expect":"src/auth.js"}, …] (or pass --fixtures FILE)`,
            tokens: 0,
          }
        }
        const modes = flags.modes && flags.modes !== true ? String(flags.modes).split(',').map((m) => m.trim()).filter(Boolean) : ['index', 'hybrid']
        return { ok: true, cmd, ...pages.evaluate(fixtures, { k: num(flags.k, 5), modes }) }
      }
      case 'get': {
        const id = positional[1]
        if (!id) return { ok: false, cmd, error: 'usage: get <pageId>', tokens: 0 }
        return { ok: true, cmd, ...pages.get(id, { budget: num(flags.budget, DEFAULTS.get) }) }
      }
      case 'query': {
        const q = positional.slice(1).join(' ')
        if (!q) return { ok: false, cmd, error: 'usage: query <terms> [--rg] [--k N]', tokens: 0 }
        return { ok: true, cmd, ...pages.query(q, { k: num(flags.k, 5), budget: num(flags.budget, DEFAULTS.query), rg: !!flags.rg }) }
      }
      case 'fault': {
        const target = positional.slice(1).join(' ')
        if (!target) return { ok: false, cmd, error: 'usage: fault <symbol|path#symbol|path:line|path> [--deep]', tokens: 0 }
        return { ok: true, cmd, ...pages.fault(target, { budget: num(flags.budget, DEFAULTS.fault), deep: !!flags.deep }) }
      }
      case 'miss': {
        if (flags.stats) return { ok: true, cmd, ...pages.missStats({ budget: num(flags.budget, 400) }) }
        const q = positional.slice(1).join(' ')
        if (!q) return { ok: false, cmd, error: 'usage: miss "<query>" [--found-by rg|grep|manual] [--path p] [--agent A] | miss --stats', tokens: 0 }
        const agent = String(flags.agent ?? (process.env.MEMAI_AGENT ?? process.env.MEM_AGENT) ?? 'anon')
        const foundBy = flags['found-by'] && flags['found-by'] !== true ? String(flags['found-by']) : null
        const hitPath = flags.path && flags.path !== true ? String(flags.path) : null
        return { ok: true, cmd, ...pages.recordMiss(q, { foundBy, hitPath, agent }) }
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
