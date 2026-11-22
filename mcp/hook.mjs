// Claude Code (and generic) SessionStart hook: inject the MemAi project card
// as `additionalContext`.
//
// Two invocation forms:
//   memai hook card                 -> JSON on stdout for Claude Code hooks:
//                                     {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
//   memai hook card --text          -> raw card text (for AGENTS.md-style hosts,
//                                     DSH instructions or shell debugging)
//   memai hook card --event SubagentStart
//
// Design rules:
//   * never fail a session: any problem is logged to stderr and we exit 0;
//   * byte-stable output when the corpus has not changed (content-addressed
//     card + no timestamps), so provider prefix caching can hit;
//   * read-only: the hook never creates a store or indexes. `memai init` does
//     that explicitly.
import fs from 'node:fs'
import path from 'node:path'
import { openProject, closeProject, nearestProjectRoot, resolveDb } from './paths.mjs'
import { estTokens } from '../src/tokens.mjs'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'
import { watcherAlive } from '../src/watch.mjs'
import { decideGuard, guardFilePath } from '../src/guard.mjs'

export const HOOK_EVENTS = ['SessionStart', 'SubagentStart']

const CARD_RULES = [
  '# MemAi paged memory for this repository',
  '# Prefer mem {op:"fault", target:"<symbol>"} over reading whole files; use {"op":"query"} to find symbols first.',
  '# On resume use {"op":"diff","since":"<version>"} instead of re-reading; call {"op":"index"} after edits.',
].join('\n')

/**
 * Build the text injected into the session. Returns null when there is no
 * indexed card yet.
 */
export function buildHookContext({ root = null, db = null, env = process.env, cwd = process.cwd(), maxTokens = 700 } = {}) {
  const project = openProject({ root, db, env, cwd, create: false })
  try {
    if (!project.exists) return null
    const card = project.pages.card({ budget: maxTokens })
    if (!card.ok || !card.text) return null
    return `${CARD_RULES}\n\n${card.text}`
  } finally {
    closeProject(project)
  }
}

/**
 * Produce the exact stdout payload for `memai hook card`.
 * Returns `{ text, tokens, json }`:
 *   json — the object to print as JSON, or null when there is no card yet (callers must stay
 *          silent in that case: a SessionStart hook that prints nothing is a valid no-op)
 *   text — raw additional context (for --text)
 */
export function hookCardPayload({ root = null, db = null, env = process.env, cwd = process.cwd(), event = 'SessionStart' } = {}) {
  if (!HOOK_EVENTS.includes(event)) throw new Error(`unknown hook event: ${event} (expected ${HOOK_EVENTS.join(' or ')})`)
  const additionalContext = buildHookContext({ root, db, env, cwd })
  if (!additionalContext) {
    return { text: '', tokens: 0, json: null }
  }
  return {
    text: additionalContext,
    tokens: estTokens(additionalContext),
    json: { hookSpecificOutput: { hookEventName: event, additionalContext } },
  }
}

/**
 * PostToolUse (`memai hook index`): distil the file an editing tool just wrote
 * into the project store. Reads the Claude-style hook payload
 * `{tool_name, tool_input:{file_path}}` (top-level `file_path` also accepted),
 * finds the owning project by walking up from the file, and runs a targeted
 * single-file index. Sub-second; the caller stays silent and exits 0 no matter
 * what — a broken re-index must never fail a session.
 */
export async function hookIndexFile({ payload = null, root = null, db = null, env = process.env, cwd = process.cwd() } = {}) {
  const filePath = payload?.tool_input?.file_path ?? payload?.inputs?.file_path ?? payload?.file_path ?? null
  if (!filePath || typeof filePath !== 'string') return { ok: true, indexed: false, reason: 'no file_path in payload' }
  const abs = path.resolve(cwd, filePath)
  const projectRoot = root ? path.resolve(root) : nearestProjectRoot(path.dirname(abs))
  const dbPath = resolveDb(projectRoot, { db, env })
  if (!fs.existsSync(dbPath)) return { ok: true, indexed: false, reason: `no store at ${dbPath}` }
  // Dedup: when the resident watcher is alive it distils this file within its
  // debounce window anyway — skip the duplicate work (and the ~300ms node spawn
  // cost lands only on sessions without the daemon).
  const watcherPid = watcherAlive(projectRoot)
  if (watcherPid) return { ok: true, indexed: false, skipped: true, reason: `watcher alive (pid ${watcherPid}) — daemon will index this file` }
  const store = new MemoryStore({ dbPath, root: projectRoot })
  try {
    const pages = new MemoryPages({ store, root: projectRoot })
    const r = await pages.indexFiles([abs])
    return { ok: true, indexed: r.readFiles > 0 || r.deleted > 0, readFiles: r.readFiles, reused: r.reused, deleted: r.deleted, version: r.version }
  } finally {
    store.close()
  }
}

/**
 * PreToolUse (`memai hook guard`): deny an above-threshold whole-file read and
 * return the signature page instead. `json` is null whenever the read may
 * proceed — the caller must stay silent in that case. Never throws.
 */
export function hookGuardPayload({ payload = null, root = null, db = null, env = process.env, cwd = process.cwd(), now = Date.now() } = {}) {
  const filePath = guardFilePath(payload)
  if (!filePath) return { json: null, decision: 'allow', reason: 'no file path in payload' }
  const abs = path.resolve(cwd, filePath)
  const projectRoot = root ? path.resolve(root) : nearestProjectRoot(path.dirname(abs))
  const dbPath = resolveDb(projectRoot, { db, env })
  if (!fs.existsSync(dbPath)) return { json: null, decision: 'allow', reason: `no store at ${dbPath}` }
  const store = new MemoryStore({ dbPath, root: projectRoot })
  try {
    const pages = new MemoryPages({ store, root: projectRoot })
    const r = decideGuard({ payload, root: projectRoot, env, cwd, now, store, pages })
    if (r.decision !== 'deny') return { json: null, decision: 'allow', reason: r.reason }
    return {
      json: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.text } },
      decision: 'deny', text: r.text, tokens: estTokens(r.text),
    }
  } finally {
    store.close()
  }
}
