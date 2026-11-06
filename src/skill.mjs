// `memai skill` — install the portable Agent Skills package into agent skill roots.
//
// One canonical skill lives at `<repo>/skills/memai/SKILL.md` and is installed (copied or linked)
// into the roots that agent hosts actually scan. Per the verified matrix there are exactly two
// destinations per scope:
//
//   project  <root>/.agents/skills/memai/    portable Agent Skills root: Codex, OpenCode, ZCode,
//                                             DSH, Cursor/Gemini aliases, generic SKILL.md hosts
//            <root>/.claude/skills/memai/    Claude Code project skills (also read by OpenCode and
//                                             Cursor)
//   global   ~/.agents/skills/memai/ and ~/.claude/skills/memai/
//
// Per-agent flags are aliases that map onto those two roots — they never create extra copies:
//   claude -> .claude   codex|opencode|zcode|dsh|generic -> .agents
//
// Idempotency is content-based: a target is "unchanged" only when every installed file is
// byte-identical to the source (same relative path + same bytes). No marker or version field is
// written into SKILL.md, because frontmatter is parsed by strict clients. A target that exists and
// differs is never clobbered without `--force`.
//
// Zero dependencies, Node builtins only, Windows + POSIX.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const SKILL_NAME = 'memai'
export const SKILLS_DIR = 'skills'
export const SKILL_AGENTS = ['claude', 'codex', 'opencode', 'zcode', 'dsh', 'generic']

/** The two install destinations. `agents` lists the flags each one covers. */
export const SKILL_TARGETS = [
  {
    id: 'agents',
    label: '.agents/skills/memai',
    parts: ['.agents', 'skills', SKILL_NAME],
    agents: ['codex', 'opencode', 'zcode', 'dsh', 'generic'],
    covers: 'Codex, OpenCode, ZCode, DSH, Cursor/Gemini aliases, generic Agent Skills hosts',
  },
  {
    id: 'claude',
    label: '.claude/skills/memai',
    parts: ['.claude', 'skills', SKILL_NAME],
    agents: ['claude'],
    covers: 'Claude Code (also read by OpenCode and Cursor)',
  },
]

/** Optional, non-default roots some agents also scan; documented, not written by default. */
export const OPTIONAL_SKILL_ROOTS = [
  { path: '.dsh/skills/memai', note: 'DSH project root (higher priority than .agents; redundant for MemAi)' },
  { path: '.codex/skills/memai', note: 'older Codex-only root; Codex now scans .agents/skills' },
  { path: '.zcode/skills/memai', note: 'ZCode project root (also reads .agents/skills)' },
  { path: '~/.zcode/skills/memai', note: 'ZCode user root — alias of ~/.agents/skills' },
  { path: '.gemini/skills/memai', note: 'Gemini CLI project root (also reads .agents/skills)' },
  { path: '~/.gemini/skills/memai', note: 'Gemini CLI user root — alias of ~/.agents/skills' },
]

export const SKILL_HELP = `Usage: memai skill <command> [options]

Commands:
  install [options]   Install the MemAi skill (from skills/memai/) into agent skill roots.
  list                Show installed targets for the project and (when present) the user scope.
  status              Same as list with a summary count.

Options for install/list:
  --agent NAME      claude|codex|opencode|zcode|dsh|generic|all (repeatable / comma separated).
                    Default: all. Aliases map onto two roots: claude -> .claude/skills,
                    everything else -> .agents/skills.
  --global          user scope: ~/.agents/skills/memai and ~/.claude/skills/memai
                    (default: project scope, relative to --root / MEMAI_ROOT / the repo root)
  --root DIR        project root (default: $MEMAI_ROOT, nearest .git/.memai ancestor, cwd)
  --link            symlink the skill directory instead of copying it (junction on Windows;
                    falls back to a copy if the OS refuses)
  --force           replace a target that exists with different content
  --json            machine-readable output (list/status)
  --help            this help

The skill is content-hashed: a re-run reports "unchanged" when the installed copy is
byte-identical to skills/memai/SKILL.md; conflicting directories are never overwritten
without --force.
`

// ---------------------------------------------------------------------------
// Canonical source
// ---------------------------------------------------------------------------

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SRC_DIR, '..')

/** The repo-relative directory holding the canonical skill (contains SKILL.md). */
export function canonicalSkillDir() {
  return path.join(REPO_ROOT, SKILLS_DIR, SKILL_NAME)
}

export function resolveHome(env = process.env) {
  const h = String(env.HOME ?? '').trim() || String(env.USERPROFILE ?? '').trim()
  return h || os.homedir()
}

export function normalizeSkillAgents(requested = ['all']) {
  const list = Array.isArray(requested) ? requested : [requested]
  const out = new Set()
  for (const raw of list) {
    for (const name of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (name === 'all') { for (const a of SKILL_AGENTS) out.add(a); continue }
      if (!SKILL_AGENTS.includes(name)) throw new Error(`unknown agent: ${name} (expected ${SKILL_AGENTS.join('|')}|all)`)
      out.add(name)
    }
  }
  return SKILL_AGENTS.filter((a) => out.has(a))
}

/** Resolve the concrete install targets for a set of agents and a scope. */
export function skillTargets({ agents = ['all'], global = false, root = process.cwd(), home = resolveHome() } = {}) {
  const wanted = normalizeSkillAgents(agents)
  const base = global ? home : root
  return SKILL_TARGETS
    .map((t) => ({ ...t, dir: path.join(base, ...t.parts) }))
    .filter((t) => t.agents.some((a) => wanted.includes(a)))
    .map((t) => ({ ...t, agents: t.agents.filter((a) => wanted.includes(a)) }))
}

/** Read every file in the canonical skill, with per-file sha256 and a tree hash. */
export function readSkillSource(sourceDir = canonicalSkillDir()) {
  let stat
  try { stat = fs.statSync(sourceDir) } catch { stat = null }
  if (!stat || !stat.isDirectory()) {
    throw new Error(`canonical skill not found at ${sourceDir} (expected skills/${SKILL_NAME}/SKILL.md)`)
  }
  const files = []
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, relPath)
      else if (entry.isFile()) {
        const content = fs.readFileSync(abs)
        files.push({ path: relPath, content, sha256: crypto.createHash('sha256').update(content).digest('hex') })
      }
    }
  }
  walk(sourceDir)
  if (!files.some((f) => f.path === 'SKILL.md')) throw new Error(`${sourceDir} has no SKILL.md`)
  const manifest = files.map((f) => `${f.path}:${f.sha256}`).join('\n')
  return {
    dir: sourceDir,
    files,
    hash: crypto.createHash('sha256').update(manifest).digest('hex'),
  }
}

// ---------------------------------------------------------------------------
// Frontmatter (for validation + `skill list --json`)
// ---------------------------------------------------------------------------

/**
 * Parse the simple YAML frontmatter used by SKILL.md without a YAML dependency.
 * Supports `key: value` scalars (single/double quoted or plain) and one nested `metadata:` map
 * whose values are strings. Returns `{ ok, data, errors }`; `ok:false` lists every problem.
 */
export function parseSkillFrontmatter(text) {
  const errors = []
  const data = {}
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const lines = source.split(/\r?\n/)
  if (lines[0] !== '---') { errors.push('frontmatter must start with a "---" line'); return { ok: false, data, errors } }
  const end = lines.indexOf('---', 1)
  if (end === -1) { errors.push('frontmatter has no closing "---" line'); return { ok: false, data, errors } }
  const body = lines.slice(end + 1).join('\n')

  const unquote = (v) => {
    const s = v.trim()
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      const inner = s.slice(1, -1)
      return s.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'")
    }
    return s
  }

  let inMetadata = false
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.match(/^\s*/)[0].length
    const trimmed = line.trim()
    const m = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (!m) { errors.push(`line ${i + 1}: not "key: value" — ${JSON.stringify(trimmed)}`); continue }
    const [, key, rawValue] = m
    if (indent > 0) {
      if (!inMetadata) { errors.push(`line ${i + 1}: nested key ${JSON.stringify(key)} outside metadata`); continue }
      data.metadata = { ...(data.metadata ?? {}) }
      data.metadata[key] = unquote(rawValue)
      continue
    }
    if (key === 'metadata') {
      if (rawValue.trim() !== '') { errors.push('metadata must be a nested string map, not an inline value'); }
      inMetadata = true
      data.metadata = data.metadata ?? {}
      continue
    }
    inMetadata = false
    data[key] = unquote(rawValue)
  }

  const check = (label, cond, message) => { if (!cond) errors.push(message) }
  check('name', typeof data.name === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.name), 'name must match ^[a-z0-9]+(-[a-z0-9]+)*$')
  check('name-length', typeof data.name === 'string' && data.name.length <= 64, 'name must be <= 64 characters')
  check('description', typeof data.description === 'string' && data.description.length > 0 && data.description.length <= 1024, 'description must be 1..1024 characters')
  check('compatibility', data.compatibility === undefined || (typeof data.compatibility === 'string' && data.compatibility.length <= 500), 'compatibility must be <= 500 characters')
  if (data.metadata !== undefined) {
    check('metadata', data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata), 'metadata must be a string map')
    for (const [k, v] of Object.entries(data.metadata ?? {})) {
      if (typeof v !== 'string') errors.push(`metadata.${k} must be a string`)
      if (/[:#]{1}/.test(k)) errors.push(`metadata key ${JSON.stringify(k)} is unsafe`)
    }
  }
  const providerOnly = ['allowed-tools', 'allowed_tools', 'context', 'agent', 'disable-model-invocation', 'user-invocable', 'argument-hint']
  for (const key of providerOnly) {
    if (Object.prototype.hasOwnProperty.call(data, key)) errors.push(`frontmatter field ${JSON.stringify(key)} is provider-specific and not portable`)
  }
  return { ok: errors.length === 0, data, body, errors }
}

/** Load and validate the canonical skill file (used by tests and `skill list`). */
export function readCanonicalSkill() {
  const dir = canonicalSkillDir()
  const file = path.join(dir, 'SKILL.md')
  const text = fs.readFileSync(file, 'utf8')
  const parsed = parseSkillFrontmatter(text)
  return { dir, file, text, ...parsed }
}

// ---------------------------------------------------------------------------
// Inspect + install
// ---------------------------------------------------------------------------

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function listTree(dir) {
  const out = []
  const walk = (current, rel = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(abs, relPath)
      else if (entry.isFile()) out.push({ path: relPath, content: fs.readFileSync(abs) })
    }
  }
  walk(dir)
  return out
}

/**
 * Compare a target directory with the source.
 * @returns {{exists:boolean,isDirectory:boolean,isSymlink:boolean,linkTarget:string|null,matches:boolean,reason:string}}
 */
export function inspectTarget(dir, source) {
  let stat
  try { stat = fs.lstatSync(dir) } catch { stat = null }
  if (!stat) return { exists: false, isDirectory: false, isSymlink: false, linkTarget: null, matches: false, reason: 'missing' }

  const isSymlink = stat.isSymbolicLink()
  let linkTarget = null
  if (isSymlink) {
    try { linkTarget = fs.readlinkSync(dir) } catch { linkTarget = null }
    let resolved = linkTarget
    if (resolved) {
      try { resolved = fs.realpathSync(dir) } catch { resolved = linkTarget }
    }
    let sourceReal = source.dir
    try { sourceReal = fs.realpathSync(source.dir) } catch { /* keep */ }
    if (resolved && (resolved === sourceReal || path.resolve(path.dirname(dir), linkTarget) === sourceReal)) {
      return { exists: true, isDirectory: true, isSymlink: true, linkTarget, matches: true, reason: 'symlink to source' }
    }
    return { exists: true, isDirectory: false, isSymlink: true, linkTarget, matches: false, reason: 'symlink to a different location' }
  }
  if (!stat.isDirectory()) {
    return { exists: true, isDirectory: false, isSymlink: false, linkTarget: null, matches: false, reason: 'not a directory' }
  }

  let installed
  try { installed = listTree(dir) } catch (err) {
    return { exists: true, isDirectory: true, isSymlink: false, linkTarget: null, matches: false, reason: `unreadable: ${err.message}` }
  }
  if (installed.length !== source.files.length) {
    return { exists: true, isDirectory: true, isSymlink: false, linkTarget: null, matches: false, reason: `${installed.length} file(s) installed, source has ${source.files.length}` }
  }
  const byPath = new Map(source.files.map((f) => [f.path, f]))
  for (const file of installed) {
    const want = byPath.get(file.path)
    if (!want) return { exists: true, isDirectory: true, isSymlink: false, linkTarget: null, matches: false, reason: `unexpected file ${file.path}` }
    if (sha256(file.content) !== want.sha256) {
      return { exists: true, isDirectory: true, isSymlink: false, linkTarget: null, matches: false, reason: `${file.path} differs` }
    }
  }
  return { exists: true, isDirectory: true, isSymlink: false, linkTarget: null, matches: true, reason: 'byte-identical' }
}

function copySkill(source, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const file of source.files) {
    const target = path.join(dest, ...file.path.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content)
  }
}

function linkSkill(source, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  fs.symlinkSync(source.dir, dest, type)
}

function removeTarget(dir) {
  let stat
  try { stat = fs.lstatSync(dir) } catch { return }
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(dir, { recursive: true, force: true })
  else fs.rmSync(dir, { force: true })
}

/**
 * Install the canonical skill into the targets selected by `agents`.
 *
 * @returns {{ok:boolean, source:string, scope:'project'|'global', base:string, results:object[], changed:number, conflicts:number, errors:number}}
 */
export function installSkills({
  root = process.cwd(),
  home = resolveHome(),
  agents = ['all'],
  global = false,
  link = false,
  force = false,
  sourceDir = canonicalSkillDir(),
} = {}) {
  const source = readSkillSource(sourceDir)
  const targets = skillTargets({ agents, global, root, home })
  const base = global ? home : root
  const results = []

  for (const target of targets) {
    const state = inspectTarget(target.dir, source)
    const record = {
      id: target.id,
      path: target.dir,
      display: path.relative(base, target.dir) || target.dir,
      agents: target.agents,
      action: 'unchanged',
      files: 0,
      linked: false,
      message: '',
    }
    try {
      if (state.matches) {
        record.action = 'unchanged'
        record.message = state.reason
      } else if (state.exists && !force) {
        record.action = 'conflict'
        record.message = `${state.reason}; re-run with --force to replace it`
      } else {
        if (state.exists) removeTarget(target.dir)
        let linked = false
        if (link) {
          try { linkSkill(source, target.dir); linked = true } catch (err) {
            record.message = `symlink failed (${err.code ?? err.message}); copied instead`
          }
        }
        if (!linked) copySkill(source, target.dir)
        record.action = state.exists ? 'updated' : 'created'
        record.files = source.files.length
        record.linked = linked
        if (!record.message) record.message = `${source.files.length} file(s)`
      }
    } catch (err) {
      record.action = 'error'
      record.message = err?.message ?? String(err)
    }
    results.push(record)
  }

  const conflicts = results.filter((r) => r.action === 'conflict').length
  const errors = results.filter((r) => r.action === 'error').length
  const changed = results.filter((r) => r.action === 'created' || r.action === 'updated').length
  return { ok: conflicts === 0 && errors === 0, source: source.dir, scope: global ? 'global' : 'project', base, results, changed, conflicts, errors }
}

/** Status of every target in one scope (or both when `scope:'all'`). */
export function listSkills({ root = process.cwd(), home = resolveHome(), scope = 'all' } = {}) {
  const source = readSkillSource()
  const scopes = scope === 'all' ? ['project', 'global'] : [scope]
  const rows = []
  for (const name of scopes) {
    const base = name === 'global' ? home : root
    for (const target of skillTargets({ agents: ['all'], global: name === 'global', root, home })) {
      const state = inspectTarget(target.dir, source)
      rows.push({
        scope: name,
        id: target.id,
        path: target.dir,
        display: path.relative(base, target.dir) || target.dir,
        agents: target.agents,
        covers: target.covers,
        exists: state.exists,
        linked: state.isSymlink,
        matches: state.matches,
        reason: state.reason,
      })
    }
  }
  return { source: source.dir, hash: source.hash, rows }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseSkillArgv(argv) {
  const positional = []
  const flags = { agent: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { positional.push(a); continue }
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
    let value = eq > 0 ? a.slice(eq + 1) : undefined
    if (value === undefined) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--') && ['agent', 'root'].includes(key)) { value = next; i++ }
    }
    if (key === 'agent') {
      for (const name of String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) flags.agent.push(name)
    } else if (value === undefined) flags[key] = true
    else flags[key] = value
  }
  return { positional, flags }
}

const ACTION_ORDER = { created: 0, updated: 1, unchanged: 2, conflict: 3, error: 4 }

/**
 * Run `memai skill <command>`.
 * The caller resolves the project root (same rules as the rest of the CLI) and passes it in.
 * @returns {{code:number, text:string, json?:object}}
 */
export function runSkillCommand(argv = [], { root = process.cwd(), env = process.env, home = null } = {}) {
  const { positional, flags } = parseSkillArgv(argv)
  const cmd = positional[0] ?? ''
  const resolvedHome = home ?? resolveHome(env)

  if (flags.help || cmd === 'help' || cmd === '') {
    if (cmd === 'help' || flags.help) return { code: 0, text: SKILL_HELP }
    return { code: 2, text: `memai skill: missing command\n\n${SKILL_HELP}` }
  }
  if (!['install', 'list', 'status'].includes(cmd)) {
    return { code: 2, text: `memai skill: unknown command ${JSON.stringify(cmd)}\n\n${SKILL_HELP}` }
  }

  let agents
  try {
    agents = normalizeSkillAgents(flags.agent.length ? flags.agent : ['all'])
  } catch (err) {
    return { code: 2, text: `memai skill: ${err.message}\n` }
  }

  if (cmd === 'install') {
    let result
    try {
      result = installSkills({
        root,
        home: resolvedHome,
        agents,
        global: !!flags.global,
        link: !!flags.link,
        force: !!flags.force,
      })
    } catch (err) {
      return { code: 1, text: `memai skill install: ${err.message}\n` }
    }
    const lines = [
      `MemAi skill install — ${result.scope === 'global' ? 'user scope' : `project ${result.base}`}`,
      `source: ${result.source}`,
    ]
    for (const r of [...result.results].sort((a, b) => (ACTION_ORDER[a.action] - ACTION_ORDER[b.action]) || a.display.localeCompare(b.display))) {
      const detail = r.linked ? 'symlinked' : r.action === 'unchanged' ? r.message : `${r.files} file(s)`
      lines.push(`  ${r.action.padEnd(9)} ${r.display}  (${r.agents.join(', ')})${detail ? ` — ${detail}` : ''}`)
      if (r.action === 'conflict' && r.message) lines.push(`            ${r.message}`)
    }
    const unchanged = result.results.filter((r) => r.action === 'unchanged').length
    lines.push(`skills: ${result.changed} changed, ${unchanged} unchanged, ${result.conflicts} conflict(s), ${result.errors} error(s)`)
    if (result.changed === 0 && result.conflicts === 0 && result.errors === 0) lines.push('already up to date')
    lines.push('next: restart/reload the agent; the skill is listed in its skill catalog')
    return { code: result.ok ? 0 : 1, text: lines.join('\n') + '\n', json: result }
  }

  // list / status
  const scope = flags.global ? 'global' : 'all'
  let listing
  try {
    listing = listSkills({ root, home: resolvedHome, scope })
  } catch (err) {
    return { code: 1, text: `memai skill ${cmd}: ${err.message}\n` }
  }
  const installed = listing.rows.filter((r) => r.exists && r.matches).length
  const summary = { source: listing.source, hash: listing.hash, installed, total: listing.rows.length, rows: listing.rows }
  if (flags.json) return { code: 0, text: JSON.stringify(summary, null, 2) + '\n', json: summary }

  const lines = [`MemAi skill — one skill, installed where each agent scans for SKILL.md`, `source: ${listing.source}`, '']
  for (const scopeName of ['project', 'global']) {
    const rows = listing.rows.filter((r) => r.scope === scopeName)
    if (!rows.length) continue
    lines.push(`${scopeName === 'global' ? 'user scope' : `project scope (${root})`}:`)
    for (const r of rows) {
      const status = r.matches ? (r.linked ? 'linked' : 'installed') : r.exists ? 'differs' : 'missing'
      lines.push(`  ${status.padEnd(9)} ${r.display}  (${r.agents.join(', ')})`)
      if (r.exists && !r.matches && r.reason) lines.push(`            ${r.reason} — run \`memai skill install --force\``)
    }
    lines.push('')
  }
  lines.push(`summary: ${installed}/${listing.rows.length} targets installed and byte-identical`)
  if (cmd === 'status') lines.push(installed === 0 ? 'status: not installed' : 'status: installed')
  return { code: 0, text: lines.join('\n') + '\n', json: summary }
}
