// Guard: PreToolUse interception of whole-file reads.
//
// The decision logic lives here so the hook (mcp/hook.mjs), the CLI status
// command, and the bench all share one implementation. Design:
// docs/superpowers/specs/2026-11-22-guard-design.md
//
// Rules: deny only when a whole read costs at least twice the paged
// alternative; never throw into the caller (a hook must not break a session).
import fs from 'node:fs'
import path from 'node:path'
import { sha1 } from './store.mjs'

export const GUARD_DEFAULTS = Object.freeze({
  enabled: true,
  minBytes: 8192,
  allow: [],
  toolNames: ['Read', 'read_file'],
})
export const SIG_BUDGET = 400        // token budget of the signature excerpt
export const FAULT_EST_TOKENS = 400  // one typical fault slice
export const STATE_TTL_MS = 3600_000 // override lifetime

/** Effective config: guard.json, then env overrides. Never throws. */
export function loadGuardConfig({ root, env = process.env } = {}) {
  const cfg = { enabled: GUARD_DEFAULTS.enabled, minBytes: GUARD_DEFAULTS.minBytes, allow: [], toolNames: [...GUARD_DEFAULTS.toolNames], source: 'defaults' }
  if (root) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(root, '.memai', 'guard.json'), 'utf8'))
      cfg.source = 'guard.json'
      if (typeof raw?.enabled === 'boolean') cfg.enabled = raw.enabled
      if (Number.isFinite(raw?.minBytes) && raw.minBytes > 0) cfg.minBytes = Math.trunc(raw.minBytes)
      if (Array.isArray(raw?.allow)) cfg.allow = raw.allow.filter((g) => typeof g === 'string')
      if (Array.isArray(raw?.toolNames) && raw.toolNames.length) cfg.toolNames = raw.toolNames.filter((t) => typeof t === 'string')
    } catch { /* missing or invalid guard.json -> defaults */ }
  }
  if (String(env.MEMAI_GUARD ?? '').toLowerCase() === 'off') { cfg.enabled = false; cfg.source = 'env' }
  const envMin = Number(env.MEMAI_GUARD_MIN_BYTES)
  if (Number.isFinite(envMin) && envMin > 0) { cfg.minBytes = Math.trunc(envMin); cfg.source = 'env' }
  return cfg
}

/** Glob with `**` (any depth), `*` (one segment), `?` (one char). */
export function globMatch(pattern, rel) {
  const p = String(pattern).replace(/\\/g, '/')
  let re = '^'
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') { re += '.*'; i++ } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(re + '$').test(String(rel).replace(/\\/g, '/'))
}

export function guardToolName(payload) {
  const v = payload?.tool_name ?? payload?.toolName ?? payload?.name ?? ''
  return String(v ?? '')
}

/** File path from Claude Code (`tool_input.file_path`) or ZCode-ish shapes. */
export function guardFilePath(payload) {
  const ti = payload?.tool_input ?? payload?.toolInput ?? payload?.inputs ?? {}
  const v = ti?.file_path ?? ti?.filePath ?? ti?.path ?? ti?.file ?? payload?.file_path
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** A read with any range parameter is partial — never guarded. */
export function isWholeFileRead(toolInput = {}) {
  const keys = ['offset', 'limit', 'start_line', 'end_line', 'startLine', 'endLine', 'start', 'end']
  for (const k of keys) {
    const v = toolInput?.[k]
    if (v !== undefined && v !== null && v !== '') return false
  }
  return true
}

// ---------------------------------------------------------------- state ---

export function statePath(root) { return path.join(root, '.memai', 'guard-state.json') }

/** Deny/override state. Corrupt or missing file reads as empty. */
export function readState(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(root), 'utf8'))
    const overrides = raw?.overrides && typeof raw.overrides === 'object' ? raw.overrides : {}
    return { version: 1, overrides, denyCount: Number(raw?.denyCount) || 0, lastDeny: raw?.lastDeny ?? null }
  } catch {
    return { version: 1, overrides: {}, denyCount: 0, lastDeny: null }
  }
}

/** Atomic write (tmp + rename); callers already swallow failures. */
export function writeState(root, state) {
  const p = statePath(root)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, p)
}

export function hasOverride(root, { sessionId, rel, now = Date.now(), ttlMs = STATE_TTL_MS }) {
  const ts = readState(root).overrides[`${sessionId}|${rel}`]
  return typeof ts === 'number' && now - ts < ttlMs
}

/** Record a deny and the one-shot override it grants for this session. */
export function recordDeny(root, { sessionId, rel, now = Date.now(), bytes = 0, fileTokens = 0, sigTokens = 0, ttlMs = STATE_TTL_MS }) {
  const st = readState(root)
  st.overrides[`${sessionId}|${rel}`] = now
  for (const [k, ts] of Object.entries(st.overrides)) {
    if (!(typeof ts === 'number' && now - ts < ttlMs)) delete st.overrides[k]
  }
  st.denyCount += 1
  st.lastDeny = { rel, at: new Date(now).toISOString(), bytes, fileTokens, sigTokens }
  try { writeState(root, st) } catch { /* a guard must never fail the session */ }
}

// ------------------------------------------------------------- decision ---

const kb = (n) => (n / 1024).toFixed(1)

/** The deny reason: size + cost, the signature page, and exactly what to do next. */
export function buildDenyReason({ rel, bytes, fileTokens, sigText, sigTokens, minBytes, store }) {
  const all = (store?.symbolsForPage?.(`file:${rel}`) ?? []).filter((s) => !['heading', 'test', 'import', 'key'].includes(s.kind))
  // Prefer bodies over constants; among bodies, suggest the largest — the line
  // gap to the next symbol is a cheap size proxy (`fault noop` is a wasted move).
  const callable = all.filter((s) => ['function', 'method', 'class'].includes(s.kind))
  const pool = callable.length ? callable : all
  const syms = pool
    .map((s, i) => ({ ...s, gap: i + 1 < pool.length ? pool[i + 1].line - s.line : 0 }))
    .sort((a, b) => b.gap - a.gap || a.line - b.line)
    .slice(0, 3)
  const lines = [
    `# MemAi guard — ${rel} withheld (${kb(bytes)} KB ≈ ${fileTokens} tok)`,
    `Whole-file reads above ${kb(minBytes)} KB return signatures first; Read this path again to override for this session.`,
    `Signatures (index page, ${sigTokens} tok):`,
    String(sigText ?? '').trim(),
    'Next moves:',
    ...syms.map((s, i) => `  fault ${s.name}${i === 0 ? '' : ' --deep'}   # ~300–600 tok`),
    `  Read ${rel} again   # override`,
  ]
  return lines.join('\n')
}

/**
 * The whole decision. Order is contractual (tests assert reasons):
 * enabled -> tool -> path -> root -> whole-file -> allowlist -> exists ->
 * minBytes -> indexed -> fresh -> page -> cost rule -> override.
 */
export function decideGuard({ payload = null, root, env = process.env, cwd = process.cwd(), now = Date.now(), store, pages } = {}) {
  const cfg = loadGuardConfig({ root, env })
  if (!cfg.enabled) return { decision: 'allow', reason: 'guard disabled' }
  if (!cfg.toolNames.includes(guardToolName(payload))) return { decision: 'allow', reason: 'not a guarded read tool' }
  const raw = guardFilePath(payload)
  if (!raw) return { decision: 'allow', reason: 'no file path in payload' }
  const abs = path.resolve(cwd, raw)
  const rel = path.relative(root, abs).split(path.sep).join('/')
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { decision: 'allow', reason: 'outside project root' }
  const ti = payload?.tool_input ?? payload?.toolInput ?? payload?.inputs ?? {}
  if (!isWholeFileRead(ti)) return { decision: 'allow', reason: 'partial read' }
  if (cfg.allow.some((g) => globMatch(g, rel))) return { decision: 'allow', reason: 'allowlisted' }

  let st
  try { st = fs.statSync(abs) } catch { return { decision: 'allow', reason: 'file missing' } }
  if (st.size < cfg.minBytes) return { decision: 'allow', reason: 'below minBytes' }

  const row = store.getFile(rel)
  if (!row) return { decision: 'allow', reason: 'not indexed' }
  try {
    if (sha1(fs.readFileSync(abs)) !== row.content_hash) return { decision: 'allow', reason: 'stale index' }
  } catch { return { decision: 'allow', reason: 'file unreadable' } }

  const sig = pages.get(`file:${rel}`, { budget: SIG_BUDGET })
  if (!sig?.ok) return { decision: 'allow', reason: 'no page' }
  const fileTokens = Math.ceil(st.size / 3.966)
  if (fileTokens < 2 * (sig.tokens + FAULT_EST_TOKENS)) return { decision: 'allow', reason: 'paging would not halve the read' }

  const sessionId = String(payload?.session_id ?? payload?.sessionId ?? 'anon')
  if (hasOverride(root, { sessionId, rel, now })) return { decision: 'allow', reason: 'override' }

  recordDeny(root, { sessionId, rel, now, bytes: st.size, fileTokens, sigTokens: sig.tokens })
  const text = buildDenyReason({ rel, bytes: st.size, fileTokens, sigText: sig.text, sigTokens: sig.tokens, minBytes: cfg.minBytes, store })
  return { decision: 'deny', rel, bytes: st.size, fileTokens, sigTokens: sig.tokens, text }
}
