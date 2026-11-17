// `memai watch` — a tiny resident daemon that keeps the store fresh.
//
// The staleness problem is structural: an index is only as good as the last
// `memai index`, and agents (and humans) forget. The watcher closes that gap
// mechanically: it listens to OS filesystem events and distils exactly the
// files that changed, never listing or re-reading the whole tree.
//
// Modes:
//   memai watch                  foreground; Ctrl-C to stop
//   memai watch --detach         spawn-self mode used by --ensure (writes the pidfile, loops)
//   memai watch --ensure         start a detached watcher unless one is already alive; exit 0 always
//                                (safe to call from a SessionStart hook)
//   memai watch --stop           terminate the running watcher and clean the pidfile
//   memai watch --status         one JSON line: {running, pid, startedAt, ...}
//
// Design rules (mirroring mcp/hook.mjs):
//   * never crash on a single bad file: errors go to .memai/watch.log and the loop continues;
//   * the watcher never creates a store: without one it exits with a `memai init` hint;
//   * .memai/** is always ignored (the daemon must not react to its own writes);
//   * big change bursts (branch switches, builds) fall back to one full index
//     pass, which reuses unchanged files anyway.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isIndexableRel, readGitignore } from './extract.mjs'
import { MemoryStore } from './store.mjs'
import { MemoryPages } from './page.mjs'
import { resolveRoot, resolveDb, isDebug } from '../mcp/paths.mjs'

export const DEBOUNCE_MS = 800
export const FULL_INDEX_THRESHOLD = 50
export const FULL_KEY = '\0full' // sentinel: unknown-what-changed → one full pass
const LOG_MAX_BYTES = 64 * 1024
const PID_POLL_MS = 150

const SELF_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'memai.mjs')

// --------------------------------------------------------------- plumbing ---

const pidPath = (root) => path.join(root, '.memai', 'watch.pid')
const logPath = (root) => path.join(root, '.memai', 'watch.log')

/** Process liveness: ESRCH = dead, EPERM = alive but owned by someone else. */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (err) { return err?.code === 'EPERM' }
}

function readPidFile(root) {
  try { return JSON.parse(fs.readFileSync(pidPath(root), 'utf8')) } catch { return null }
}

/** Pid of the live watcher for a project root, or null. Used by `hook index`
 * to skip its own indexing when the daemon will handle the file anyway. */
export function watcherAlive(root) {
  const pid = readPidFile(root)
  return pid && alive(pid.pid) ? pid.pid : null
}

/**
 * Pure backpressure decision: normally flush after `debounceMs`, but once more
 * than `maxPerMinute` flushes happened inside `windowMs`, hold until the oldest
 * flush leaves the window. Events keep coalescing meanwhile, so nothing is
 * lost — the watcher just stops thrashing under pathological writers.
 */
export function flushDelayMs(now, recentFlushTimes, { maxPerMinute = 30, windowMs = 60000, debounceMs = DEBOUNCE_MS } = {}) {
  const within = recentFlushTimes.filter((t) => now - t < windowMs)
  if (within.length < maxPerMinute) return debounceMs
  return Math.max(debounceMs, within[0] + windowMs - now)
}

function logLine(root, msg) {
  try {
    const p = logPath(root)
    try { if (fs.statSync(p).size > LOG_MAX_BYTES) fs.renameSync(p, `${p}.old`) } catch { /* first line */ }
    fs.appendFileSync(p, `${new Date().toISOString()} pid=${process.pid} ${msg}\n`)
  } catch { /* logging must never crash the watcher */ }
  if (isDebug(process.env)) process.stderr.write(`[memai watch] ${msg}\n`)
}

/**
 * Pure event filter: filename from fs.watch → indexable repo-relative path,
 * FULL_KEY when the platform gave no filename, null to skip.
 * Exported for tests; the watcher uses it through `makeEventFilter`.
 */
export function eventToRel(root, rules, filename) {
  if (!filename) return FULL_KEY
  let rel = String(filename).replace(/\\/g, '/')
  const r = String(root).replace(/\\/g, '/').replace(/\/+$/, '') + '/'
  if (rel.toLowerCase().startsWith(r.toLowerCase())) rel = rel.slice(r.length)
  rel = rel.replace(/^(\.\/)+/, '')
  if (!rel || rel.startsWith('.memai/') || rel === '.memai') return null
  if (rel.split('/').some((s) => s === 'node_modules')) return null // fs.watch recursive can cross into untracked dirs
  return isIndexableRel(rel, { rules }) ? rel : null
}

/**
 * Pure batch decision: sentinel or large bursts → one full index pass
 * (its reuse path is O(corpus) reads but always converges); small batches →
 * targeted incremental indexing.
 */
export function planBatch(paths, { threshold = FULL_INDEX_THRESHOLD } = {}) {
  if (!Array.isArray(paths) || !paths.length || paths.includes(FULL_KEY)) return { mode: 'full', paths: [] }
  if (paths.length > threshold) return { mode: 'full', paths: [] }
  return { mode: 'files', paths }
}

// ------------------------------------------------------------------ run ---

export async function runWatch(argv, { env = process.env } = {}) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++ } else flags[a.slice(2)] = true
  }
  const root = resolveRoot({ root: flags.root === true ? null : flags.root, env })
  const dbPath = resolveDb(root, { db: flags.db === true ? null : flags.db, env })

  if (flags.stop) return stopWatcher(root)
  if (flags.status) return watchStatus(root, { dbPath })
  if (flags.ensure) return ensureWatcher({ root, dbPath })
  return startWatcher({ root, dbPath, detach: !!flags.detach, debounceMs: Number(flags['debounce-ms']) || DEBOUNCE_MS })
}

/** --ensure: spawn a detached watcher unless one is alive. Never throws; safe in hooks. */
async function ensureWatcher({ root, dbPath }) {
  try {
    const pid = readPidFile(root)
    if (pid && alive(pid.pid)) return { ok: true, cmd: 'watch', running: true, pid: pid.pid, text: `watch already running (pid ${pid.pid})` }
    if (!fs.existsSync(dbPath)) return { ok: true, cmd: 'watch', running: false, text: `watch: no store at ${dbPath}; run memai init (ensure is a no-op)` }
    const child = spawn(process.execPath, [SELF_BIN, 'watch', '--detach', `--root=${root}`, `--db=${dbPath}`], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: root,
    })
    child.unref()
    // Wait briefly for the pidfile so callers can trust `ensure` synchronously.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await sleep(PID_POLL_MS)
      const p = readPidFile(root)
      if (p && alive(p.pid)) return { ok: true, cmd: 'watch', running: true, pid: p.pid, text: `watch started (pid ${p.pid})` }
    }
    return { ok: true, cmd: 'watch', running: false, text: `watch spawn did not write a pidfile in time (it may still come up)` }
  } catch (err) {
    return { ok: true, cmd: 'watch', running: false, text: `watch ensure: ${err?.message ?? err}` } // never fail a session start
  }
}

/** --stop: kill the running watcher and remove its pidfile. */
function stopWatcher(root) {
  const pid = readPidFile(root)
  if (!pid || !alive(pid.pid)) {
    try { fs.rmSync(pidPath(root), { force: true }) } catch { /* nothing to clean */ }
    return { ok: true, cmd: 'watch', running: false, text: `watch not running` }
  }
  try { process.kill(pid.pid) } catch (err) {
    if (err?.code !== 'ESRCH') return { ok: false, cmd: 'watch', error: `kill ${pid.pid}: ${err?.message ?? err}`, tokens: 0 }
  }
  try { fs.rmSync(pidPath(root), { force: true }) } catch { /* nothing to clean */ }
  logLine(root, `stopped by external request (was pid ${pid.pid})`)
  return { ok: true, cmd: 'watch', running: false, stopped: pid.pid, text: `watch stopped (pid ${pid.pid})` }
}

/** --status: one JSON line describing the watcher (read-only store probe). */
function watchStatus(root, { dbPath }) {
  const pid = readPidFile(root)
  const running = !!(pid && alive(pid.pid))
  const out = {
    ok: true, cmd: 'watch', root, running,
    pid: running ? pid.pid : null,
    startedAt: running ? new Date(pid.started_at).toISOString() : null,
    message: running ? `watch running (pid ${pid.pid}, since ${new Date(pid.started_at).toISOString()})` : 'watch not running',
  }
  try {
    const store = new MemoryStore({ dbPath, root, create: false })
    try { out.version = store.getMeta('last_version') ?? null } finally { store.close() }
  } catch { /* no store: fine */ }
  return { ...out, text: JSON.stringify(out) } // bin prints text: status output IS the JSON line
}

/** Foreground/detached loop: full index once, then react to events. The
 * returned promise resolves only when the watcher shuts down — bin must not
 * exit the process while the loop is alive. */
function startWatcher({ root, dbPath, detach = false, debounceMs = DEBOUNCE_MS }) {
  if (!fs.existsSync(dbPath)) {
    return Promise.resolve({ ok: false, cmd: 'watch', error: `no MemAi store at ${dbPath}; run memai init`, tokens: 0 })
  }
  return new Promise((resolveDone) => {
    const store = new MemoryStore({ dbPath, root })
    const pages = new MemoryPages({ store, root })
    const rules = readGitignore(root)
    const pidFile = pidPath(root)

    let watcher = null
    let stopped = false
    const pending = new Map()
    let chain = Promise.resolve() // serialises flushes: SQLite writes must not overlap
    let timer = null
    const flushTimes = [] // recent flush starts, for the circuit breaker
    let breakerLogged = false

    const writePidFile = () => fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, started_at: Date.now(), root }))

    const cleanup = () => {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
      try { watcher?.close() } catch { /* already closed */ }
      try { const p = readPidFile(root); if (p?.pid === process.pid) fs.rmSync(pidFile, { force: true }) } catch { /* best effort */ }
      try { store.close() } catch { /* already closed */ }
    }

    const flush = () => {
      timer = null
      if (!pending.size || stopped) return
      const paths = [...pending.keys()]
      pending.clear()
      flushTimes.push(Date.now())
      while (flushTimes.length > 64) flushTimes.shift()
      chain = chain.then(async () => {
        if (stopped) return
        const plan = planBatch(paths)
        try {
          if (plan.mode === 'full') {
            const r = await pages.index({ maxFiles: 20000 })
            logLine(root, `burst (${paths.length} paths) → full index: read=${r.readFiles} reused=${r.reused} deleted=${r.deleted} → ${r.version?.slice(0, 8)}`)
          } else {
            const r = await pages.indexFiles(plan.paths)
            logLine(root, `${plan.paths.length} path(s) → incremental: read=${r.readFiles} reused=${r.reused} deleted=${r.deleted} → ${r.version?.slice(0, 8)}`)
          }
        } catch (err) {
          logLine(root, `flush failed: ${err?.message ?? err}`)
        }
      })
    }
    const schedule = () => {
      const now = Date.now()
      const delay = flushDelayMs(now, flushTimes, { debounceMs })
      if (delay > debounceMs && !breakerLogged) {
        breakerLogged = true
        logLine(root, `circuit breaker: >flush budget in the last minute — holding events (they keep coalescing), next flush in ~${Math.round(delay / 1000)}s`)
      } else if (delay <= debounceMs) breakerLogged = false
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, delay)
    }

    let done = (payload) => { cleanup(); resolveDone(payload) }

    // Sync once at start so drift that accumulated while the watcher was down
    // is folded in (the reuse path makes this cheap on an up-to-date store).
    chain = chain.then(() => pages.index({ maxFiles: 20000 }))
      .then((r) => logLine(root, `started${detach ? ' (detached)' : ''}: full sync read=${r.readFiles} reused=${r.reused} deleted=${r.deleted} → ${r.version?.slice(0, 8)}`))
      .catch((err) => logLine(root, `startup sync failed: ${err?.message ?? err}`))
      .then(() => { if (!stopped) writePidFile() })

    try {
      watcher = fs.watch(root, { recursive: true, persistent: true }, (_event, filename) => {
        const rel = eventToRel(root, rules, filename)
        if (!rel) return
        pending.set(rel, true)
        schedule()
      })
    } catch (err) {
      return done({ ok: false, cmd: 'watch', error: `fs.watch: ${err?.message ?? err}`, tokens: 0 })
    }
    watcher.on('error', (err) => {
      logLine(root, `watch error: ${err?.message ?? err}`)
      if (err?.code === 'ENOENT') done({ ok: true, cmd: 'watch', running: false, text: 'project directory vanished; watch stopped' }) // a watcher over nothing is noise
    })

    const shutdown = () => done({ ok: true, cmd: 'watch', running: false, text: 'watch stopped' })
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    process.on('SIGHUP', shutdown)

    logLine(root, `watching ${root} (debounce ${debounceMs}ms)`)
    if (!detach) process.stderr.write(`[memai watch] watching ${root} — Ctrl-C to stop\n`)
  })
}
