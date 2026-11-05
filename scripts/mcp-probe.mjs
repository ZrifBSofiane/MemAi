#!/usr/bin/env node
// MemAi MCP probe — a human/CI health check for the stdio MCP server.
//
// It performs a real MCP handshake over stdio and reports the negotiated protocol version, server
// identity, instructions, tool surface (single `mem`, or 11 granular tools when
// MEMAI_GRANULAR_TOOLS=1), resources and prompts. When a MemAi store exists at the probed root it
// also exercises `tools/call mem status/card` and `resources/read memai://card`; otherwise those
// data checks are reported as skipped (an unindexed checkout is a valid state — run `memai init`).
//
// It exits non-zero on any protocol error, so CI can gate on it.
//
// Usage:
//   node scripts/mcp-probe.mjs [--root DIR] [--db FILE] [--timeout MS] [--verbose]
//   node scripts/mcp-probe.mjs --help
//
// Zero dependencies; Windows + POSIX; the spawned server is always killed on exit.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const DEFAULT_SERVER = path.join(REPO, 'mcp', 'server.mjs')

const HELP = `MemAi MCP probe

Usage: node scripts/mcp-probe.mjs [options]

  --root DIR      project root passed to the server (default: cwd)
  --db FILE       store file passed to the server (default: <root>/.memai/mem.db)
  --server FILE   server entry to spawn (default: mcp/server.mjs)
  --timeout MS    per-request timeout, default 8000
  --verbose       print the full JSON of every response
  --help          this help

Exit code 0 = every run check passed; 1 = a protocol/transport error was detected.
`

function parseArgs(argv = process.argv.slice(2)) {
  const out = { root: null, db: null, server: DEFAULT_SERVER, timeout: 8000, verbose: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--verbose' || a === '-v') out.verbose = true
    else if (a === '--root') out.root = argv[++i] ?? null
    else if (a.startsWith('--root=')) out.root = a.slice(7)
    else if (a === '--db') out.db = argv[++i] ?? null
    else if (a.startsWith('--db=')) out.db = a.slice(5)
    else if (a === '--server') out.server = argv[++i] ?? DEFAULT_SERVER
    else if (a === '--timeout') out.timeout = Number(argv[++i]) || 8000
    else if (!a.startsWith('-')) out.root = a // positional root
  }
  return out
}

function resolveStorePath({ root, db, cwd = process.cwd() }) {
  if (db) return path.resolve(cwd, db)
  const base = root ? path.resolve(cwd, root) : cwd
  return path.join(base, '.memai', 'mem.db')
}

function fail(message) {
  console.error(`mcp-probe: FAIL — ${message}`)
  process.exitCode = 1
}

async function main() {
  const opts = parseArgs()
  if (opts.help) { process.stdout.write(HELP); return }

  const root = opts.root ? path.resolve(process.cwd(), opts.root) : process.cwd()
  const storePath = resolveStorePath({ root, db: opts.db })
  const hasStore = (() => { try { return fs.statSync(storePath).isFile() } catch { return false } })()

  const args = [opts.server, '--root', root]
  if (opts.db) args.push('--db', storePath)

  console.log('MemAi MCP probe')
  console.log(`  server : ${opts.server}`)
  console.log(`  root   : ${root}`)
  console.log(`  store  : ${hasStore ? storePath : `${storePath} (absent — data checks will be skipped)`}`)

  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MEMAI_DEBUG: '' },
  })

  const stderrChunks = []
  child.stderr.on('data', (d) => stderrChunks.push(d))

  const pending = new Map()
  let nextId = 1
  let stdoutBadLines = 0

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try { msg = JSON.parse(trimmed) } catch {
      stdoutBadLines++
      console.error(`  ! non-JSON stdout line: ${trimmed.slice(0, 160)}`)
      return
    }
    if (opts.verbose) console.log('  <-', JSON.stringify(msg))
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id)
      clearTimeout(timer)
      pending.delete(msg.id)
      resolve(msg)
    }
  })

  const exitPromise = new Promise((resolve) => child.once('exit', resolve))
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout after ${opts.timeout}ms waiting for ${method}`))
    }, opts.timeout)
    pending.set(id, { resolve, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

  const steps = []
  const step = async (name, fn) => {
    try {
      const detail = await fn()
      steps.push({ name, ok: true, skipped: false, detail })
      console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`)
    } catch (err) {
      steps.push({ name, ok: false, skipped: false, detail: err?.message ?? String(err) })
      console.log(`  FAIL ${name} — ${err?.message ?? err}`)
    }
  }
  const skip = (name, why) => {
    steps.push({ name, ok: true, skipped: true, detail: why })
    console.log(`  SKIP ${name} — ${why}`)
  }

  let negotiated = null
  let toolCount = 0
  let granular = false

  await step('initialize (protocol 2025-06-18)', async () => {
    const res = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'memai-probe', version: '0.1.0' },
    })
    if (res.error) throw new Error(`JSON-RPC error ${res.error.code}: ${res.error.message}`)
    const r = res.result ?? {}
    if (r.protocolVersion !== '2025-06-18') throw new Error(`negotiated ${JSON.stringify(r.protocolVersion)}, expected 2025-06-18`)
    if (!r.serverInfo?.name) throw new Error('serverInfo.name missing')
    if (!r.capabilities?.tools) throw new Error('capabilities.tools missing')
    if (typeof r.instructions !== 'string' || r.instructions.trim().length < 40) throw new Error('initialize.instructions missing/too short')
    negotiated = r.protocolVersion
    return `${r.serverInfo.name} v${r.serverInfo.version}, capabilities tools+resources+prompts, instructions ${r.instructions.length} chars`
  })

  if (!negotiated) {
    child.kill()
    await exitPromise
    fail('handshake failed; server did not initialize')
    return
  }

  notify('notifications/initialized')

  await step('protocol negotiation (older supported version is echoed)', async () => {
    const res = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memai-probe', version: '0.1.0' } })
    if (res.error) throw new Error(res.error.message)
    if (res.result?.protocolVersion !== '2024-11-05') throw new Error(`expected 2024-11-05, got ${res.result?.protocolVersion}`)
    return '2024-11-05 accepted'
  })

  await step('ping', async () => {
    const res = await rpc('ping', {})
    if (res.error) throw new Error(res.error.message)
    return 'pong'
  })

  await step('tools/list', async () => {
    const res = await rpc('tools/list', {})
    if (res.error) throw new Error(res.error.message)
    const tools = res.result?.tools ?? []
    toolCount = tools.length
    granular = tools.length > 1
    for (const t of tools) {
      if (!t.name || !t.inputSchema || t.inputSchema.type !== 'object') throw new Error(`tool ${JSON.stringify(t.name)} has no object inputSchema`)
    }
    if (!granular && tools[0]?.name !== 'mem') throw new Error(`default surface should be the single "mem" tool, got ${tools.map((t) => t.name).join(', ')}`)
    if (granular && tools.length !== 11) throw new Error(`MEMAI_GRANULAR_TOOLS=1 should expose 11 tools, got ${tools.length}`)
    console.log(`       tools: ${tools.map((t) => t.name).join(', ')}`)
    return `${tools.length} tool(s)`
  })

  await step('resources/list', async () => {
    const res = await rpc('resources/list', {})
    if (res.error) throw new Error(res.error.message)
    const resources = res.result?.resources ?? []
    if (!resources.some((r) => r.uri === 'memai://card')) throw new Error('memai://card missing from resources')
    return `${resources.length} resource(s), incl. memai://card`
  })

  await step('prompts/list', async () => {
    const res = await rpc('prompts/list', {})
    if (res.error) throw new Error(res.error.message)
    const prompts = res.result?.prompts ?? []
    if (!prompts.some((p) => p.name === 'memai-card')) throw new Error('memai-card prompt missing')
    return `${prompts.length} prompt(s)`
  })

  await step('unknown method returns JSON-RPC -32601', async () => {
    const res = await rpc('definitely/not/a/method', {})
    if (!res.error) throw new Error('expected a JSON-RPC error')
    if (res.error.code !== -32601) throw new Error(`expected -32601, got ${res.error.code}`)
    return 'method not found'
  })

  if (hasStore) {
    const call = granular ? 'mem_status' : 'mem'
    const callArgs = granular ? {} : { op: 'status' }
    await step(`tools/call ${call} status`, async () => {
      const res = await rpc('tools/call', { name: call, arguments: callArgs })
      if (res.error) throw new Error(`JSON-RPC error ${res.error.code}: ${res.error.message}`)
      const r = res.result ?? {}
      const text = r.content?.[0]?.text ?? ''
      if (!text) throw new Error('empty result content')
      if (r.isError) throw new Error(`tool returned isError: ${text.slice(0, 200)}`)
      return text.split('\n')[0].slice(0, 90)
    })
    if (!granular) {
      await step('tools/call mem card', async () => {
        const res = await rpc('tools/call', { name: 'mem', arguments: { op: 'card' } })
        if (res.error) throw new Error(res.error.message)
        const text = res.result?.content?.[0]?.text ?? ''
        if (res.result?.isError) throw new Error(text.slice(0, 200))
        if (!/token/i.test(text)) throw new Error('card response has no token header')
        return text.split('\n').find((l) => l.trim())?.slice(0, 90) ?? 'ok'
      })
    }
    await step('resources/read memai://card', async () => {
      const res = await rpc('resources/read', { uri: 'memai://card' })
      if (res.error) throw new Error(res.error.message)
      const text = res.result?.contents?.[0]?.text ?? ''
      if (!text.trim()) throw new Error('card text empty')
      return (text.split('\n').find((l) => l.trim()) ?? 'ok').slice(0, 90)
    })
  } else {
    skip('tools/call mem status', 'no store at ' + storePath)
    skip('tools/call mem card', 'no store at ' + storePath)
    skip('resources/read memai://card', 'no store at ' + storePath)
  }

  child.stdin.end()
  const code = await Promise.race([exitPromise, new Promise((r) => setTimeout(() => r('timeout'), 3000))])
  await step('clean shutdown on stdin EOF', async () => {
    if (code === 'timeout') { child.kill(); throw new Error('server did not exit within 3s of stdin EOF') }
    if (code !== 0) throw new Error(`server exited with code ${code}`)
    return 'exit 0'
  })

  await step('stdout is protocol-clean', async () => {
    if (stdoutBadLines > 0) throw new Error(`${stdoutBadLines} non-JSON stdout line(s)`)
    return 'every stdout line was one JSON-RPC object'
  })

  const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim()
  console.log(`\n  negotiated protocol: ${negotiated}${toolCount ? `, tools: ${toolCount}` : ''}`)
  console.log(`  stderr: ${stderrText ? stderrText.split('\n').slice(-2).join(' | ').slice(0, 200) : '(empty)'}`)

  const failed = steps.filter((s) => !s.ok)
  const skipped = steps.filter((s) => s.skipped)
  if (failed.length) {
    fail(`${failed.length}/${steps.length} check(s) failed: ${failed.map((s) => s.name).join(', ')}`)
    return
  }
  console.log(`\nOK — ${steps.length - skipped.length}/${steps.length - skipped.length} run checks passed${skipped.length ? `, ${skipped.length} skipped` : ''}`)
}

main().catch((err) => {
  fail(err?.stack ?? String(err))
  process.exitCode = 1
})
