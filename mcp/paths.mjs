// Shared project/store path resolution for the MemAi CLI, MCP server and hooks.
//
// The store is per workspace and written only by MemAi (PROTOCOL.md §9).
//
// Root resolution order (first match wins):
//   1. --root <dir> argument
//   2. MEMAI_ROOT environment variable
//   3. nearest ancestor of cwd containing `.git` or a MemAi store directory
//   4. cwd
//
// Store resolution order:
//   1. --db <file> argument
//   2. MEMAI_DB environment variable
//   3. <root>/.memai/mem.db
//   4. legacy <root>/.memory/mem.db (only while no .memai store exists, so the
//      original prototype index keeps working without a migration step)
//
// Everything here is Node-builtin-only and synchronous; it is shared by the
// CLI bins, `memai init`, the MCP server and the Claude Code hook so all
// surfaces agree on one store.
import fs from 'node:fs'
import path from 'node:path'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'

export const PRODUCT = 'MemAi'
export const VERSION = '0.1.1'
export const STORE_DIR = '.memai'
export const DB_FILE = 'mem.db'
export const LEGACY_STORE_DIRS = ['.memory', '.mempages']
export const ROOT_ENV = 'MEMAI_ROOT'
export const DB_ENV = 'MEMAI_DB'
export const AGENT_ENV = 'MEMAI_AGENT'
export const GRANULAR_TOOLS_ENV = 'MEMAI_GRANULAR_TOOLS'
export const DEBUG_ENV = 'MEMAI_DEBUG'

const statSafe = (p) => { try { return fs.statSync(p) } catch { return null } }
const isDir = (p) => !!statSafe(p)?.isDirectory()
const isFile = (p) => !!statSafe(p)?.isFile()

/** True when path is a git worktree root (`.git` dir, or file for worktrees). */
export function isProjectRoot(dir) {
  return isDir(path.join(dir, '.git')) || isFile(path.join(dir, '.git')) || isDir(path.join(dir, STORE_DIR))
}

/** Walk up from `cwd` looking for a git root or an existing store. */
export function nearestProjectRoot(cwd = process.cwd()) {
  let dir = path.resolve(cwd)
  for (;;) {
    if (isProjectRoot(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return path.resolve(cwd)
    dir = parent
  }
}

/** Resolve the project root for a CLI/MCP invocation. */
export function resolveRoot({ root = null, env = process.env, cwd = process.cwd() } = {}) {
  const explicit = root ?? env?.[ROOT_ENV]
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    return path.resolve(cwd, String(explicit))
  }
  return nearestProjectRoot(cwd)
}

/** The canonical store path for a root (whether or not it exists yet). */
export function defaultDbPath(root) {
  return path.join(path.resolve(root), STORE_DIR, DB_FILE)
}

/** Resolve the SQLite file for a root, honoring --db / MEMAI_DB / legacy dirs. */
export function resolveDb(root, { db = null, env = process.env, cwd = process.cwd() } = {}) {
  const explicit = db ?? env?.[DB_ENV]
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    return path.resolve(cwd, String(explicit))
  }
  const rootAbs = path.resolve(root)
  const preferred = defaultDbPath(rootAbs)
  if (isFile(preferred)) return preferred
  for (const legacy of LEGACY_STORE_DIRS) {
    const candidate = path.join(rootAbs, legacy, DB_FILE)
    if (isFile(candidate)) return candidate
  }
  return preferred
}

/**
 * Open the MemAi store + pager for a project.
 *
 * `create:false` (default) is a read path: when no store exists it returns
 * `{ exists:false }` and never creates files, so read-only tools and hooks stay
 * side-effect free. `create:true` is for init/index/note writes.
 *
 * The root recorded in the store wins over the resolved root (the DB may have
 * been built from a different cwd), but only if that directory still exists.
 */
export function openProject({ root = null, db = null, env = process.env, cwd = process.cwd(), create = false } = {}) {
  const resolvedRoot = resolveRoot({ root, env, cwd })
  const dbPath = resolveDb(resolvedRoot, { db, env, cwd })
  const exists = isFile(dbPath)
  if (!exists && !create) {
    return { exists: false, root: resolvedRoot, dbPath, store: null, pages: null }
  }
  const store = new MemoryStore({ dbPath, root: resolvedRoot })
  const recorded = store.getMeta('root')
  const projectRoot = recorded && isDir(recorded) ? path.resolve(recorded) : resolvedRoot
  const pages = new MemoryPages({ store, root: projectRoot })
  return { exists: true, root: projectRoot, dbPath, store, pages }
}

export function closeProject(project) {
  if (project?.store) { try { project.store.close() } catch { /* already closed */ } }
}

/** True when the opt-in granular `mem_*` tool surface is requested. */
export function isGranularTools(env = process.env) {
  const v = String(env?.[GRANULAR_TOOLS_ENV] ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** True when verbose stderr logging is requested. */
export function isDebug(env = process.env) {
  const v = String(env?.[DEBUG_ENV] ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** Default agent id for board operations. */
export function defaultAgent(env = process.env) {
  const a = env?.[AGENT_ENV]
  return a && String(a).trim() ? String(a).trim() : 'anon'
}
