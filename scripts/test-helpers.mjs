// Shared helpers for `test/*.test.mjs` — NOT a test file itself.
//
// Kept outside `test/` on purpose: Node's test runner treats every file under a directory named
// `test` as a test file, so a helper module there would be executed as an empty test. Zero
// dependencies; Windows + POSIX.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SELF = {
  server: path.join(REPO, 'mcp', 'server.mjs'),
  binMcp: path.join(REPO, 'bin', 'memai-mcp.mjs'),
  bin: path.join(REPO, 'bin', 'memai.mjs'),
  probe: path.join(REPO, 'scripts', 'mcp-probe.mjs'),
}

/** Create a unique temp directory; callers may remove it at the end of a test. */
export function tempDir(prefix = 'memai-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** A tiny multi-language corpus with stable symbol names for paging tests. */
export function makeCorpus(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'memai-test-corpus',
    version: '1.0.0',
    type: 'module',
    scripts: { test: 'node --test', build: 'node build.mjs', lint: 'eslint .' },
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(root, 'README.md'), '# memai-test-corpus\n\nA fixture used by the MemAi test suite.\n')
  fs.writeFileSync(path.join(root, 'src', 'auth.js'), [
    '// Authentication helpers.',
    'const TOKEN_TTL_MS = 3600_000',
    '',
    'export function verifyToken(token) {',
    '  if (!token || typeof token !== "string") return false',
    '  return token.split(".").length === 3',
    '}',
    '',
    'export function issueToken(userId) {',
    '  return `${userId}.${TOKEN_TTL_MS}.signature`',
    '}',
    '',
    'export class AuthService {',
    '  constructor(store) { this.store = store }',
    '  login(user, password) { return verifyToken(issueToken(user.id)) && !!password }',
    '  logout() { this.store = null }',
    '}',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(root, 'src', 'billing.js'), [
    'import { AuthService } from "./auth.js"',
    '',
    'export function createInvoice(userId, amountCents) {',
    '  if (amountCents <= 0) throw new Error("amount must be positive")',
    '  return { userId, amountCents, status: "draft" }',
    '}',
    '',
    'export class BillingService {',
    '  constructor(db) { this.db = db; this.auth = new AuthService(db) }',
    '  charge(invoice) { return this.db.insert("charges", invoice) }',
    '}',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(root, 'docs', 'auth.md'), '# Auth\n\nTokens are verified by `verifyToken`.\n')
  return { root }
}

/** Build a MemAi store for `root` in-process (same code path as `memai init`). */
export async function indexPath(root, dbPath = path.join(root, '.memai', 'mem.db')) {
  const { MemoryStore } = await import('../src/store.mjs')
  const { MemoryPages } = await import('../src/page.mjs')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const store = new MemoryStore({ dbPath, root })
  try {
    store.setMeta('root', root)
    const pages = new MemoryPages({ store, root })
    const result = await pages.index({ maxFiles: 500 })
    return { dbPath, result }
  } finally {
    store.close()
  }
}

/** Spawn a Node script and capture buffered output (for short-lived CLI commands). */
export function runNode(args, { cwd = REPO, env = {}, timeoutMs = 90000 } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, NO_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(err) })
    })
  })
}

/**
 * Minimal MCP JSON-RPC client over a child process's stdio.
 * Records every stdout line so tests can assert the transport stayed protocol-clean.
 */
export class RpcClient {
  constructor(child, { timeoutMs = 8000 } = {}) {
    this.child = child
    this.timeoutMs = timeoutMs
    this.pending = new Map()
    this.nextId = 1
    this.stdoutLines = []
    this.badStdoutLines = []
    this.stderr = ''
    this.exitCode = null
    this.exited = new Promise((resolve) => {
      child.once('exit', (code) => { this.exitCode = code; resolve(code) })
    })
    child.stderr.on('data', (d) => { this.stderr += d })
    this.rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      this.stdoutLines.push(trimmed)
      let msg
      try { msg = JSON.parse(trimmed) } catch {
        this.badStdoutLines.push(trimmed)
        return
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, timer } = this.pending.get(msg.id)
        clearTimeout(timer)
        this.pending.delete(msg.id)
        resolve(msg)
      }
    })
  }

  static spawn(args, { cwd = REPO, env = {}, timeoutMs = 8000 } = {}) {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    return new RpcClient(child, { timeoutMs })
  }

  rpc(method, params, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  /** Wait for an already-received (or future) stdout message matching `predicate`. */
  async waitForMessage(predicate, { timeoutMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs
    let cursor = 0
    while (Date.now() < deadline) {
      while (cursor < this.stdoutLines.length) {
        const line = this.stdoutLines[cursor++]
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (predicate(msg)) return msg
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    return null
  }

  async initialize({ protocolVersion = '2025-06-18', clientInfo = { name: 'memai-test', version: '0.1.0' } } = {}) {
    const res = await this.rpc('initialize', { protocolVersion, capabilities: {}, clientInfo })
    this.notify('notifications/initialized')
    return res
  }

  async waitExit(ms = 5000) {
    return Promise.race([
      this.exited,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), ms)),
    ])
  }

  async shutdown({ killAfterMs = 5000 } = {}) {
    try { this.rl.close() } catch { /* noop */ }
    if (this.exitCode === null) {
      try { this.child.stdin.end() } catch { /* noop */ }
      const code = await this.waitExit(killAfterMs)
      if (code === 'timeout') { try { this.child.kill() } catch { /* noop */ } }
      return code
    }
    return this.exitCode
  }
}

/** First text block of a tools/call result. */
export function textOf(response) {
  return response?.result?.content?.[0]?.text ?? ''
}

/** Assert every stdout line the server wrote was a JSON-RPC object, and return it. */
export async function assertProtocolClean(client, assert) {
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(client.badStdoutLines, [], `stdout carried non-JSON lines: ${JSON.stringify(client.badStdoutLines)}`)
  for (const line of client.stdoutLines) {
    const msg = JSON.parse(line)
    assert.equal(msg.jsonrpc, '2.0', `stdout line is not JSON-RPC 2.0: ${line}`)
    assert.ok('id' in msg || 'method' in msg, `stdout line has neither id nor method: ${line}`)
  }
}
