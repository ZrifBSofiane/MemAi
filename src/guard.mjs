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
