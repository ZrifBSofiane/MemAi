#!/usr/bin/env node
// MemAi MCP server: JSON-RPC 2.0 over newline-delimited stdio, zero dependencies.
//
// Contract:
//   * stdout carries protocol JSON only — exactly one JSON-RPC object per line.
//     Nothing else may be written there, ever.
//   * every log goes to stderr (`MEMAI_DEBUG=1` for verbose traces).
//   * newline framing only (MCP stdio transport); `Content-Length` framing is
//     not used.
//   * protocol versions: 2024-11-05, 2025-03-26, 2025-06-18. The requested
//     version is echoed when supported, otherwise the latest is returned (per
//     MCP lifecycle rules).
//
// Surface: one `mem` tool by default (tools are billed on every request);
// the 11 granular `mem_*` tools only when MEMAI_GRANULAR_TOOLS=1. Resources
// and prompts are exposed so clients can browse pages without burning a call.
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import {
  PRODUCT, VERSION, DEBUG_ENV, ROOT_ENV, DB_ENV,
  isDebug, isGranularTools, resolveRoot, resolveDb,
} from './paths.mjs'
import { TOOL_NAME, toolDefs, callTool, INSTRUCTIONS } from './tools.mjs'
import { listResources, readResource, listPrompts, getPrompt } from './resources.mjs'

export const SERVER_NAME = 'memai-mcp'
export const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18']
export const LATEST_PROTOCOL = '2025-06-18'

function rpcError(code, message, data) {
  const err = new Error(message)
  err.rpc = { code, ...(data === undefined ? {} : { data }) }
  return err
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result })
const fail = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })

export function usage() {
  return `memai-mcp ${VERSION} — MemAi MCP server (stdio, JSON-RPC 2.0, newline framed)

Usage:
  memai-mcp [--root DIR] [--db FILE]

  --root DIR   project root (default: $${ROOT_ENV}, then nearest ancestor with
               .git/.memai, then the current directory)
  --db FILE    store file (default: $${DB_ENV}, then <root>/.memai/mem.db)

Environment:
  ${ROOT_ENV}              project root
  ${DB_ENV}               store file
  MEMAI_AGENT            default board agent id (default: anon)
  MEMAI_GRANULAR_TOOLS   "1" exposes 11 mem_* tools instead of the single mem tool
  MEMAI_DEBUG            "1" for stderr traces

The server speaks MCP protocol versions ${SUPPORTED_PROTOCOLS.join(', ')}.
stdout is protocol-only; logs go to stderr.
`
}

export function parseServerArgs(argv = process.argv.slice(2)) {
  const out = { root: null, db: null, help: false, version: false, rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--version' || a === '-v') out.version = true
    else if (a === '--root') out.root = argv[++i] ?? null
    else if (a.startsWith('--root=')) out.root = a.slice('--root='.length)
    else if (a === '--db') out.db = argv[++i] ?? null
    else if (a.startsWith('--db=')) out.db = a.slice('--db='.length)
    else out.rest.push(a)
  }
  return out
}

/**
 * Start the stdio server. Returns a promise that resolves with the process exit
 * code when the transport closes (or immediately for --help/--version).
 */
export function startServer(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2)
  const env = opts.env ?? process.env
  const cwd = path.resolve(opts.cwd ?? process.cwd())
  const input = opts.input ?? process.stdin
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr

  const parsed = parseServerArgs(argv)
  if (parsed.help) { stdout.write(usage()); return Promise.resolve(0) }
  if (parsed.version) { stdout.write(`${SERVER_NAME} ${VERSION}\n`); return Promise.resolve(0) }

  const state = {
    initialized: false,
    ready: false,
    protocolVersion: LATEST_PROTOCOL,
    clientInfo: null,
    granular: isGranularTools(env),
    shutdownRequested: false,
    ignoring: false,
    root: resolveRoot({ root: parsed.root, env, cwd }),
    db: null,
  }
  state.db = resolveDb(state.root, { db: parsed.db, env, cwd })

  const log = (msg) => { stderr.write(`[${SERVER_NAME}] ${msg}\n`) }
  const debug = (msg) => { if (isDebug(env)) log(msg) }
  let writeChain = Promise.resolve()
  function send(message, onFlush) {
    const line = JSON.stringify(message) + '\n'
    writeChain = writeChain.then(() => new Promise((resolve) => {
      const flushed = () => { resolve(); if (onFlush) onFlush() }
      if (stdout.write(line, flushed)) { /* callback still fires */ }
    }))
    return writeChain
  }

  // ---- request handling ----------------------------------------------------

  function initialize(params) {
    const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : null
    const negotiated = requested && SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL
    state.initialized = true
    state.protocolVersion = negotiated
    state.clientInfo = params?.clientInfo && typeof params.clientInfo === 'object' ? params.clientInfo : null
    debug(`initialize requested=${requested ?? '(none)'} negotiated=${negotiated} client=${state.clientInfo?.name ?? '?'}${state.clientInfo?.version ? '@' + state.clientInfo.version : ''}`)
    return {
      protocolVersion: negotiated,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      serverInfo: { name: SERVER_NAME, title: PRODUCT, version: VERSION },
      instructions: INSTRUCTIONS,
    }
  }

  async function toolsCall(params) {
    const name = typeof params?.name === 'string' ? params.name : ''
    if (!name) throw rpcError(-32602, 'tools/call requires a tool name')
    const args = params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}
    const scope = { root: state.root, db: state.db, env, cwd, granular: state.granular }
    return callTool(name, args, scope)
  }

  function requireObject(params, method) {
    if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) {
      throw rpcError(-32602, `${method} params must be an object`)
    }
    return params ?? {}
  }

  async function callMethod(method, params) {
    switch (method) {
      case 'initialize':
        return initialize(params)
      case 'ping':
        return {}
      case 'notifications/initialized':
        state.ready = true
        return {}
      case 'tools/list':
        return { tools: toolDefs({ granular: state.granular }) }
      case 'tools/call':
        return toolsCall(params)
      case 'resources/list':
        return listResources({ root: state.root, db: state.db, env, cwd, cursor: requireObject(params, method).cursor ?? null })
      case 'resources/read': {
        const p = requireObject(params, method)
        return readResource({ root: state.root, db: state.db, env, cwd, uri: p.uri })
      }
      case 'prompts/list':
        return listPrompts()
      case 'prompts/get': {
        const p = requireObject(params, method)
        return getPrompt({ root: state.root, db: state.db, env, cwd, name: p.name })
      }
      case 'logging/setLevel':
        return {}
      case 'shutdown':
        state.shutdownRequested = true
        return {}
      default:
        throw rpcError(-32601, `method not found: ${method}`)
    }
  }

  function handleNotification(message) {
    switch (message.method) {
      case 'notifications/initialized':
        state.ready = true
        debug('client ready (notifications/initialized)')
        break
      case 'notifications/cancelled':
        debug(`client cancelled request ${message.params?.requestId}`)
        break
      case 'notifications/roots/list_changed':
        debug('client roots changed')
        break
      default:
        debug(`ignoring notification ${message.method}`)
    }
  }

  async function handleItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail(null, -32600, 'Invalid Request', 'expected a JSON-RPC object')
    }
    const hasId = Object.prototype.hasOwnProperty.call(item, 'id') && item.id !== undefined
    const id = hasId ? item.id : null
    if (item.jsonrpc !== '2.0') return fail(id, -32600, 'Invalid Request', 'jsonrpc must be "2.0"')

    if (!hasId) {
      try {
        if (typeof item.method !== 'string') return null
        handleNotification(item)
      } catch (err) {
        debug(`notification error: ${err?.message ?? err}`)
      }
      return null
    }

    if (typeof item.method !== 'string' || !item.method) {
      return fail(id, -32600, 'Invalid Request', 'method must be a non-empty string')
    }
    try {
      if (!state.initialized && item.method !== 'initialize' && item.method !== 'ping') {
        throw rpcError(-32002, 'server not initialized: send initialize first')
      }
      const result = await callMethod(item.method, item.params)
      return ok(id, result)
    } catch (err) {
      if (err?.rpc) return fail(id, err.rpc.code, err.message, err.rpc.data)
      debug(`internal error in ${item.method}: ${err?.stack ?? err}`)
      return fail(id, -32603, 'Internal error', String(err?.message ?? err))
    }
  }

  async function processPayload(payload) {
    const isBatch = Array.isArray(payload)
    const items = isBatch ? payload : [payload]
    if (isBatch && items.length === 0) {
      await send(fail(null, -32600, 'Invalid Request', 'empty batch'))
      return
    }
    const responses = []
    for (const item of items) {
      const response = await handleItem(item)
      if (response) responses.push(response)
    }
    if (responses.length) {
      if (state.shutdownRequested) await send(isBatch ? responses : responses[0], () => finish(0))
      else await send(isBatch ? responses : responses[0])
    } else if (state.shutdownRequested) {
      finish(0)
    }
  }

  function processLine(line) {
    const trimmed = String(line).trim()
    if (!trimmed) return undefined
    let payload
    try {
      payload = JSON.parse(trimmed)
    } catch (err) {
      return send(fail(null, -32700, 'Parse error', String(err?.message ?? err)))
    }
    return processPayload(payload)
  }

  // ---- lifecycle -----------------------------------------------------------

  let finished = false
  let resolveExit
  const exitPromise = new Promise((resolve) => { resolveExit = resolve })
  function finish(code) {
    if (finished) return
    finished = true
    debug(`shutting down (${code})`)
    writeChain = writeChain.finally(() => { try { resolveExit(code) } catch { /* noop */ } })
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  let chain = Promise.resolve()
  rl.on('line', (line) => {
    if (state.ignoring) return
    chain = chain.then(() => processLine(line)).catch((err) => debug(`line handler error: ${err?.stack ?? err}`))
  })
  rl.on('close', () => {
    chain = chain.then(() => {
      debug('stdin closed')
      finish(0)
    })
    state.ignoring = true
  })
  rl.on('error', (err) => { log(`stdin error: ${err?.message ?? err}`); finish(1) })

  const onSignal = (sig) => { debug(`received ${sig}`); finish(0) }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  // Keep stderr quiet on a normal run: many MCP clients surface any server stderr as an error
  // even when the connection succeeds. Set MEMAI_DEBUG=1 for the banner/traces.
  debug(`v${VERSION} root=${state.root} db=${state.db} surface=${state.granular ? 'granular (11 mem_* tools)' : `single "${TOOL_NAME}" tool`}`)

  return exitPromise.finally(() => {
    try { rl.close() } catch { /* noop */ }
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  })
}

// Auto-start only when this file is the process entry point (bins call startServer()).
const invokedDirectly = process.argv[1] && (() => {
  try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href } catch { return false }
})()
if (invokedDirectly) {
  startServer().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`[${SERVER_NAME}] fatal: ${err?.stack ?? err}\n`)
    process.exit(1)
  })
}
