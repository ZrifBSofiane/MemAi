// MCP tool surface for MemAi — schema definitions + dispatch onto the core.
//
// Token economics is the point, and tool schemas are billed on every request.
// So there are two surfaces:
//
//   * default: ONE tool, `mem`, with an {op} enum. A single tight schema costs
//     roughly 100-150 tokens per model step instead of ~1.2-1.8k for 11 tools.
//   * opt-in: the 11 granular `mem_*` tools, exposed only when
//     MEMAI_GRANULAR_TOOLS=1 (compat tests, benchmarks, hosts that cannot
//     dispatch an op enum).
//
// Every op maps onto one core command in src/mem-cli.mjs and returns the
// core's budget-clamped `text` — never the JSON envelope. `isError` is set on
// failure so the model can recover instead of silently trusting an empty page.
import { DEFAULTS } from '../src/page.mjs'
import { estTokens } from '../src/tokens.mjs'
import { defaultAgent, isGranularTools, openProject, closeProject } from './paths.mjs'

export const TOOL_NAME = 'mem'
export const SERVER_NAME = 'memai-mcp'

export const OPS = ['card', 'map', 'query', 'fault', 'get', 'diff', 'status', 'index', 'note', 'post', 'inbox']

/** Ops that may create the store/db when it does not exist yet. */
const WRITE_OPS = new Set(['index', 'note', 'post'])

/** Per-op budget ceilings: one call must not be able to buy a huge context. */
const MAX_BUDGET = { card: 1500, map: 3500, get: 4000, fault: 2500, query: 1200, diff: 1500, inbox: 2000 }
const DEFAULT_BUDGET = {
  card: DEFAULTS.card, map: DEFAULTS.map, get: DEFAULTS.get, fault: DEFAULTS.fault,
  query: DEFAULTS.query, diff: DEFAULTS.diff, inbox: 900,
}

// The stated break-even from the measured benchmark (bench/RESULTS.md): below
// ~346 tokens / ~1.3 KB of needed content, a plain file read wins.
const WHEN_NOT_USE = 'Do NOT use it for a single file under ~1.3 KB (~346 tokens), or for text you are about to read anyway: a plain file read is cheaper.'

/**
 * The per-session contract handed to the client in `initialize.instructions`.
 * MCP gives us exactly one cheap per-session channel; several clients surface
 * this to the model. Keep it ~150 tokens and never put the dynamic card here.
 */
export const INSTRUCTIONS = [
  'MemAi is this repository\'s local, token-budgeted memory (SQLite in .memai/, no network).',
  'At session start call the `mem` tool once with {"op":"card"} (~200 tokens); it lists the stack, commands, entrypoints and the paging protocol.',
  'Then page in only what you need: {"op":"query","q":"terms"} to locate symbols, {"op":"fault","target":"symbol"} for one body slice, {"op":"get","pageId":"file:<path>"} for a file\'s signatures.',
  'On resume use {"op":"diff","since":"<version>"} instead of re-reading changed files, and {"op":"index"} after edits (local, 0 model tokens).',
  'Other agents share the store: {"op":"note"}, {"op":"post"}, {"op":"inbox"}.',
  'Prefer a fault over reading a whole file, and skip MemAi for a single file under ~1.3 KB (~346 tokens): a plain read is cheaper.',
].join(' ')

const clampInt = (value, fallback, lo, hi) => {
  if (value === undefined || value === null || value === true) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}
const budgetFor = (op, args) => clampInt(args.budget, DEFAULT_BUDGET[op] ?? 900, 1, MAX_BUDGET[op] ?? 4000)
const str = (v) => (typeof v === 'string' ? v.trim() : '')

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

function memInputSchema() {
  return {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: OPS,
        description: 'Operation. card|map|status read pages; query+fault locate and fetch code; get reads one page; diff resumes since a version; index refreshes after edits; note/post/inbox share state with other agents.',
      },
      budget: { type: 'integer', minimum: 1, maximum: 4000, description: 'Token budget for this response; defaults are tuned, pass a smaller budget for a cheap peek.' },
      maxFiles: { type: 'integer', minimum: 1, maximum: 100000, description: 'index: cap on indexed files.' },
      force: { type: 'boolean', description: 'index: re-extract files even when unchanged.' },
      q: { type: 'string', description: 'query: search terms or a symbol name.' },
      k: { type: 'integer', minimum: 1, maximum: 20, description: 'query: number of ranked hits (default 5).' },
      target: { type: 'string', description: 'fault: symbol, path#symbol, path:line, or path.' },
      pageId: { type: 'string', description: 'get: file:<path> | project.card | project.map | board:<topic>.' },
      since: { type: 'string', description: 'diff: previous project version hash; omit to just see the current version.' },
      topic: { type: 'string', description: 'note/post/inbox: board topic (e.g. handoff, review:auth).' },
      body: { type: 'string', description: 'note/post: message body. Send page ids and symbol names, never file bodies.' },
      agent: { type: 'string', description: 'note/post/inbox: your agent id (default: $MEMAI_AGENT or "anon").' },
      advance: { type: 'boolean', description: 'inbox: advance the read cursor (default true).' },
    },
    required: ['op'],
    additionalProperties: false,
  }
}

/** The default, single-tool surface. */
export function memTool() {
  return {
    name: TOOL_NAME,
    title: 'MemAi paged project memory',
    description: `MemAi paged project memory: a locally indexed, token-budgeted store of content-addressed pages (project card/map, per-file signatures, shared agent board). Read {"op":"card"} once per session, then page in only what you need with "query" + "fault" (one body slice) or "get" (file signatures); use "diff" on resume and "note"/"post"/"inbox" to share state with other agents. ${WHEN_NOT_USE}`,
    inputSchema: memInputSchema(),
    annotations: { title: 'MemAi paged project memory', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }
}

const granularSpec = [
  {
    name: 'mem_index', op: 'index', title: 'MemAi: index the repository',
    description: `Distil the repository into MemAi pages (local CPU/disk only, 0 model tokens). Call after checkouts, pulls or bulk edits. ${WHEN_NOT_USE} For a single symbol use mem_fault.`,
    inputSchema: { type: 'object', properties: { maxFiles: { type: 'integer', minimum: 1, maximum: 100000 }, force: { type: 'boolean' } }, additionalProperties: false },
  },
  {
    name: 'mem_status', op: 'status', title: 'MemAi: store status',
    description: 'Cheap orientation: corpus size, page/version/board counts, latest version, store path. Use when diagnosing a missing or stale index; do not poll it in a loop.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mem_card', op: 'card', title: 'MemAi: project card',
    description: `Load the project card once at session start (~200 tokens): stack, commands, entrypoints, conventions, paging protocol. ${WHEN_NOT_USE} Do not call it again in the same session unless the card looks stale.`,
    inputSchema: { type: 'object', properties: { budget: { type: 'integer', minimum: 1, maximum: 1500 } }, additionalProperties: false },
  },
  {
    name: 'mem_map', op: 'map', title: 'MemAi: project map',
    description: `The file inventory with top symbols per file. Use when you must enumerate the repository or find a file you cannot name. ${WHEN_NOT_USE} Prefer mem_query/mem_fault for a known target; the map is the most expensive page.`,
    inputSchema: { type: 'object', properties: { budget: { type: 'integer', minimum: 1, maximum: 3500 } }, additionalProperties: false },
  },
  {
    name: 'mem_query', op: 'query', title: 'MemAi: ranked search',
    description: 'Ranked symbol/page hits with snippets, no bodies (default ~65 tokens). Use to locate a symbol or feature, then fetch the winner with mem_fault. Do not use it to read content; do not run many tiny queries instead of one full read.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, k: { type: 'integer', minimum: 1, maximum: 20 }, budget: { type: 'integer', minimum: 1, maximum: 1200 } }, required: ['q'], additionalProperties: false },
  },
  {
    name: 'mem_fault', op: 'fault', title: 'MemAi: page one slice',
    description: `Demand-page exactly one symbol body / line range / file page under a token budget. This is the default way to read code: prefer it over reading whole files. ${WHEN_NOT_USE} If you need the whole file anyway, read it directly.`,
    inputSchema: { type: 'object', properties: { target: { type: 'string' }, budget: { type: 'integer', minimum: 1, maximum: 2500 } }, required: ['target'], additionalProperties: false },
  },
  {
    name: 'mem_get', op: 'get', title: 'MemAi: read a page',
    description: 'Read a page by id: file:<path> gives signatures (~10-30% of the file), board:<topic> gives shared state, project.card/map give aggregates. Use before a fault to see what symbols exist. Do not use it for a single small file.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, budget: { type: 'integer', minimum: 1, maximum: 4000 } }, required: ['pageId'], additionalProperties: false },
  },
  {
    name: 'mem_diff', op: 'diff', title: 'MemAi: resume delta',
    description: 'Tiny delta between the current project version and a previous one: added/changed/removed pages with symbol churn, never bodies (~100 tokens). Use on a new session instead of re-reading changed files. Requires a version hash recorded at session end.',
    inputSchema: { type: 'object', properties: { since: { type: 'string' }, budget: { type: 'integer', minimum: 1, maximum: 1500 } }, additionalProperties: false },
  },
  {
    name: 'mem_note', op: 'note', title: 'MemAi: note to the board',
    description: 'Append a note to a shared board topic for other agents (append-only, content-deduped). Use for handoff/decisions/status; send page ids or symbol names, never file bodies. Do not use it as a scratchpad for yourself.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' }, body: { type: 'string' }, agent: { type: 'string' } }, required: ['topic', 'body'], additionalProperties: false },
  },
  {
    name: 'mem_post', op: 'post', title: 'MemAi: broadcast to the board',
    description: 'Broadcast a message to all agents on a board topic. Use rarely and for coordination only (task claimed/finished, blocking question); reference pages instead of pasting content.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' }, body: { type: 'string' }, agent: { type: 'string' } }, required: ['topic', 'body'], additionalProperties: false },
  },
  {
    name: 'mem_inbox', op: 'inbox', title: 'MemAi: read the board',
    description: 'Messages since your read cursor (advances it), oldest first, budget-clamped. Use at session start or after a handoff; do not poll it repeatedly within one step.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, since: { type: 'integer', minimum: 0 }, topic: { type: 'string' }, budget: { type: 'integer', minimum: 1, maximum: 2000 }, advance: { type: 'boolean' } }, additionalProperties: false },
  },
]

export function granularTools() {
  // Keep `name`: it is the tool identifier MCP clients call. Only drop the internal `op` mapping.
  return granularSpec.map(({ op: _op, ...tool }) => tool)
}

/** Map a granular tool name to its op (used by tools/call). */
export const GRANULAR_OPS = Object.fromEntries(granularSpec.map((t) => [t.name, t.op]))

export function toolDefs({ granular = false } = {}) {
  return granular ? granularTools() : [memTool()]
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

const hasTokenHeader = (text) => {
  const head = text.slice(0, 240)
  return /tokens?\s*[=:]\s*\d|~\s*\d+\s*tok\b|body=\d+\/\d+/i.test(head)
}

function synthesizeText(op, res) {
  if (op === 'index') {
    const short = String(res.version ?? '').slice(0, 8) || '-'
    return [
      `# index ${res.files ?? 0} files, ${res.fullTokens ?? 0} tokens if read fully, version ${short}`,
      `# read ${res.readFiles ?? 0} / reused ${res.reused ?? 0} / deleted ${res.deleted ?? 0} in ${res.elapsedMs ?? 0}ms (local, 0 model tokens)`,
      '# next: mem {op:"card"} to load orientation, or {op:"diff", since:"<old version>"} on resume',
    ].join('\n')
  }
  if (op === 'note' || op === 'post') {
    return `# ${op} ${res.topic ?? ''} seq=${res.seq ?? '?'}${res.deduped ? ' (deduped: already posted)' : ''}`.trim()
  }
  return `# mem:${op}\n${JSON.stringify(res)}`
}

function errorResult(op, message) {
  return {
    content: [{ type: 'text', text: `# mem:${op} error: ${message}\n# fix: check the arguments; if the store is missing run {op:"index"} or \`memai init\`.` }],
    isError: true,
    structuredContent: { op, ok: false },
  }
}

function toToolResult(op, res) {
  if (!res || res.ok === false) return errorResult(op, res?.error ?? 'unknown error')
  let text = typeof res.text === 'string' && res.text.trim() ? res.text : synthesizeText(op, res)
  if (!hasTokenHeader(text)) text = `# mem:${op} tokens≈${res.tokens ?? estTokens(text)}\n${text}`
  return {
    content: [{ type: 'text', text }],
    structuredContent: { op, ok: true, tokens: estTokens(text), version: res.version ?? res.to ?? null },
    isError: false,
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Execute one op against the project store.
 * @returns {Promise<{content:{type:string,text:string}[], isError?:boolean, structuredContent?:object}>}
 */
export async function dispatch({ root = null, db = null, env = process.env, cwd = process.cwd() } = {}, op, rawArgs = {}) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}
  if (!OPS.includes(op)) {
    return errorResult(op, `unknown op ${JSON.stringify(op)}; use one of: ${OPS.join(', ')}`)
  }
  const create = WRITE_OPS.has(op)
  let project
  try {
    project = openProject({ root, db, env, cwd, create })
  } catch (err) {
    return errorResult(op, `cannot open store: ${err.message}`)
  }
  if (!project.exists && !create) {
    return errorResult(op, `no MemAi store at ${project.dbPath}; run \`memai init\` (or call {op:"index"}) first`)
  }
  const { pages } = project
  try {
    switch (op) {
      case 'card':
        return toToolResult(op, pages.card({ budget: budgetFor('card', args) }))
      case 'map':
        return toToolResult(op, pages.map({ budget: budgetFor('map', args) }))
      case 'status':
        return toToolResult(op, pages.status())
      case 'diff':
        return toToolResult(op, pages.diff({ since: str(args.since) || null, budget: budgetFor('diff', args) }))
      case 'get': {
        const pageId = str(args.pageId)
        if (!pageId) return errorResult(op, 'get requires pageId (file:<path> | project.card | project.map | board:<topic>)')
        return toToolResult(op, pages.get(pageId, { budget: budgetFor('get', args) }))
      }
      case 'query': {
        const q = str(args.q)
        if (!q) return errorResult(op, 'query requires q (search terms or a symbol name)')
        return toToolResult(op, pages.query(q, { k: clampInt(args.k, 5, 1, 20), budget: budgetFor('query', args) }))
      }
      case 'fault': {
        const target = str(args.target)
        if (!target) return errorResult(op, 'fault requires target (symbol | path#symbol | path:line | path)')
        return toToolResult(op, pages.fault(target, { budget: budgetFor('fault', args) }))
      }
      case 'index': {
        const res = await pages.index({ maxFiles: clampInt(args.maxFiles, 4000, 1, 100000), force: !!args.force })
        return toToolResult(op, res)
      }
      case 'note':
      case 'post': {
        const topic = str(args.topic)
        const body = typeof args.body === 'string' ? args.body : ''
        if (!topic) return errorResult(op, `${op} requires topic`)
        if (!body.trim()) return errorResult(op, `${op} requires body`)
        const agent = str(args.agent) || defaultAgent(env)
        const res = pages.post(topic, body, { agent, kind: op === 'note' ? 'note' : 'broadcast' })
        return toToolResult(op, { ...res, topic })
      }
      case 'inbox': {
        const agent = str(args.agent) || defaultAgent(env)
        return toToolResult(op, pages.inbox(agent, {
          since: args.since == null || args.since === true ? null : clampInt(args.since, 0, 0, Number.MAX_SAFE_INTEGER),
          topic: str(args.topic) || null,
          budget: budgetFor('inbox', args),
          advance: args.advance !== false,
        }))
      }
      default:
        return errorResult(op, `unhandled op ${op}`)
    }
  } catch (err) {
    return errorResult(op, err?.message ?? String(err))
  } finally {
    closeProject(project)
  }
}

/**
 * MCP tools/call handler: accepts the tool name (single `mem` or a granular
 * `mem_*`), validates the surface is enabled, and dispatches.
 * Throws an Error with `.rpc` info for protocol-level failures (unknown tool).
 */
export async function callTool(name, args, { root, db, env, cwd, granular = isGranularTools(env) } = {}) {
  if (name === TOOL_NAME) {
    if (granular) {
      const err = new Error(`unknown tool: ${TOOL_NAME} (the granular surface is enabled: use the 11 mem_* tools, or unset MEMAI_GRANULAR_TOOLS to go back to the single "mem" tool)`)
      err.rpc = { code: -32602 }
      throw err
    }
    return dispatch({ root, db, env, cwd }, str(args?.op), args ?? {})
  }
  if (Object.prototype.hasOwnProperty.call(GRANULAR_OPS, name)) {
    if (!granular) {
      const err = new Error(`unknown tool: ${name} (granular mem_* tools are disabled; use the single "mem" tool, or set MEMAI_GRANULAR_TOOLS=1)`)
      err.rpc = { code: -32602 }
      throw err
    }
    return dispatch({ root, db, env, cwd }, GRANULAR_OPS[name], args ?? {})
  }
  const err = new Error(`unknown tool: ${name}`)
  err.rpc = { code: -32602 }
  throw err
}
