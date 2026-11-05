// MCP resources + prompts for MemAi.
//
// Resources give clients (Claude Code, Zed, generic MCP hosts) a way to browse
// and read pages *without* spending a tool call, and they cost nothing until
// read. Pages are exposed as `memai://page/<pageId>` plus three convenience
// URIs for the aggregate pages and status. Listing is paginated (100/page).
import { openProject, closeProject } from './paths.mjs'
import { INSTRUCTIONS } from './tools.mjs'

const PAGE_SIZE = 100

export const STATIC_RESOURCES = [
  {
    uri: 'memai://card',
    name: 'project.card',
    title: 'MemAi project card',
    description: 'Stack, build/test commands, entrypoints and the paging protocol. Read once at session start (~200 tokens).',
    mimeType: 'text/markdown',
  },
  {
    uri: 'memai://map',
    name: 'project.map',
    title: 'MemAi project map',
    description: 'Every indexed file with its top symbols (the "do not read files" page, up to ~3500 tokens).',
    mimeType: 'text/markdown',
  },
  {
    uri: 'memai://status',
    name: 'store status',
    title: 'MemAi store status',
    description: 'Corpus size, page/version/board counts, latest version and store path.',
    mimeType: 'text/markdown',
  },
]

const encodePage = (pageId) => `memai://page/${encodeURIComponent(pageId)}`

function pageToResource(page) {
  const isFile = page.id.startsWith('file:')
  return {
    uri: encodePage(page.id),
    name: page.id,
    title: isFile ? `file page: ${page.id.slice(5)}` : page.id,
    description: `${page.kind} page (~${page.tokens} tokens)`,
    mimeType: 'text/markdown',
  }
}

function rpcError(code, message) {
  const err = new Error(message)
  err.rpc = { code }
  return err
}

/**
 * resources/list — static URIs first, then every store page except the two
 * aggregates already listed. Paginated via an opaque (numeric) cursor.
 */
export function listResources({ root = null, db = null, env = process.env, cwd = process.cwd(), cursor = null } = {}) {
  const offset = parseCursor(cursor)
  const all = [...STATIC_RESOURCES]
  const project = openProject({ root, db, env, cwd, create: false })
  try {
    if (project.exists) {
      for (const page of project.store.listPages()) {
        if (page.id === 'project.card' || page.id === 'project.map') continue
        all.push(pageToResource(page))
      }
    }
  } finally {
    closeProject(project)
  }
  const slice = all.slice(offset, offset + PAGE_SIZE)
  const next = offset + PAGE_SIZE < all.length ? String(offset + PAGE_SIZE) : undefined
  return next ? { resources: slice, nextCursor: next } : { resources: slice }
}

function parseCursor(cursor) {
  if (cursor === null || cursor === undefined || cursor === '') return 0
  const n = Number(cursor)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/**
 * resources/read — returns `{contents:[{uri, mimeType, text}]}`.
 * Reads are raw page text (no tool envelope); unknown URIs throw an rpc error.
 */
export function readResource({ root = null, db = null, env = process.env, cwd = process.cwd(), uri } = {}) {
  const u = typeof uri === 'string' ? uri.trim() : ''
  if (!u) throw rpcError(-32602, 'resources/read requires a uri')

  if (u === 'memai://status') {
    const status = withStore({ root, db, env, cwd }, (project) => project.pages.status())
    return contents(u, status.text)
  }

  let pageId = null
  if (u === 'memai://card') pageId = 'project.card'
  else if (u === 'memai://map') pageId = 'project.map'
  else if (u.startsWith('memai://page/')) pageId = safeDecode(u.slice('memai://page/'.length))
  else if (u.startsWith('memai://file/')) pageId = `file:${safeDecode(u.slice('memai://file/'.length))}`
  else throw rpcError(-32002, `unknown resource: ${u}`)

  const page = withStore({ root, db, env, cwd }, (project) => project.store.getPage(pageId))
  if (!page) throw rpcError(-32002, `no such page: ${pageId} (run memai init / index)`)
  return contents(u, page.text)
}

function withStore(scope, fn) {
  const project = openProject({ ...scope, create: false })
  try {
    if (!project.exists) throw rpcError(-32002, `no MemAi store at ${project.dbPath}; run \`memai init\``)
    return fn(project)
  } finally {
    closeProject(project)
  }
}

function safeDecode(s) {
  try { return decodeURIComponent(s) } catch { return s }
}

function contents(uri, text) {
  return { contents: [{ uri, mimeType: 'text/markdown', text }] }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const PROMPT_NAME = 'memai-card'

export function listPrompts() {
  return {
    prompts: [{
      name: PROMPT_NAME,
      title: 'MemAi: load the project card',
      description: 'Injects the MemAi project card plus the paging contract into the conversation (one-shot, ~250 tokens).',
      arguments: [],
    }],
  }
}

/**
 * prompts/get — a client-triggered "onboard me" prompt. Works without a store:
 * the model still gets the contract plus a hint to initialize.
 */
export function getPrompt({ root = null, db = null, env = process.env, cwd = process.cwd(), name } = {}) {
  if (name !== PROMPT_NAME) throw rpcError(-32602, `unknown prompt: ${name}`)
  let cardText = ''
  const project = openProject({ root, db, env, cwd, create: false })
  try {
    if (project.exists) {
      const card = project.pages.card()
      if (card.ok) cardText = card.text
    }
  } finally {
    closeProject(project)
  }
  const body = cardText
    ? `${INSTRUCTIONS}\n\n# MemAi project card\n\n${cardText}`
    : `${INSTRUCTIONS}\n\n# MemAi\n\nNo store was found at ${project.dbPath} yet. Run \`memai init\` in this repository, then call the "mem" tool with {"op":"card"}.`
  return {
    description: 'MemAi project card + paging contract',
    messages: [{ role: 'user', content: { type: 'text', text: body } }],
  }
}
