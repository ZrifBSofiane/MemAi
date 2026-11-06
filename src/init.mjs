// `memai init` — one-command onboarding for any coding agent.
//
// What it does, in order:
//   1. installs the portable Agent Skills package (`skills/memai/` -> `.agents/skills` and
//      `.claude/skills`) so supported agents pick MemAi up from their skill catalog;
//   2. creates <root>/.memai/mem.db (WAL SQLite) and indexes the repo locally
//      (0 model tokens);
//   3. writes an idempotent instruction block with `<!-- memai:start/end -->`
//      markers into CLAUDE.md (Claude Code) and/or AGENTS.md (Codex, OpenCode,
//      ZCode, DSH, generic);
//   4. drops ready-to-paste MCP config snippets into .memai/configs/;
//   5. with --write-configs: safely merges .mcp.json (Claude Code, project
//      scope) and opencode.json — only the `memai` server entry is touched,
//      every other key is preserved; unparseable files are never overwritten;
//   6. prints exactly what changed and the manual step(s) that remain.
//
// Second run changes nothing: store/index are content-addressed, instruction
// blocks are replaced in place, JSON merges serialise identically, and the skill
// install is compared by content hash.
//
// `--md` is a preview mode: prints the instruction block(s) and writes nothing.
// `--no-skill` skips step 1.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryStore } from './store.mjs'
import { MemoryPages } from './page.mjs'
import { installSkills, canonicalSkillDir } from './skill.mjs'
import { PRODUCT, VERSION, STORE_DIR, DB_FILE, ROOT_ENV } from '../mcp/paths.mjs'

export const INIT_MARKER_START = '<!-- memai:start -->'
export const INIT_MARKER_END = '<!-- memai:end -->'

/** Agents we know how to onboard. `all` expands to every entry. */
export const AGENTS = ['claude', 'codex', 'opencode', 'zcode', 'dsh', 'generic']
export const AGENT_TARGETS = {
  claude: ['CLAUDE.md'],
  codex: ['AGENTS.md'],
  opencode: ['AGENTS.md'],
  zcode: ['AGENTS.md'],
  dsh: ['AGENTS.md'],
  generic: ['AGENTS.md'],
}

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SRC_DIR, '..')
const SELF_CLI = path.join(REPO_ROOT, 'bin', 'memai.mjs')
const SELF_MCP = path.join(REPO_ROOT, 'bin', 'memai-mcp.mjs')

export const INIT_HELP = `Usage: memai init [options]

  --agent NAME        one of ${AGENTS.join('|')}|all (repeatable / comma separated).
                      Default: auto-detect from CLAUDE.md, .claude/, opencode.json,
                      .codex/, .zcode/, installed CLIs; falls back to generic.
  --write-configs     also merge .mcp.json (Claude Code) and opencode.json safely
  --no-skill          do not install the Agent Skills package (skills/memai/)
  --md                print the instruction block(s) as Markdown and exit (writes nothing)
  --no-index          create the store but skip indexing the repository
  --max-files N       cap the indexed file count (default 4000)
  --force             re-extract unchanged files
  --root DIR          project root (default: $${ROOT_ENV}, nearest .git/.memai ancestor, cwd)
  --db FILE           store file (default: <root>/.memai/${DB_FILE})
  --help              this help

Installs the portable skill into <root>/.agents/skills/memai and <root>/.claude/skills/memai
(the two roots agents actually scan), unless --no-skill.
Idempotent: a second run changes nothing. Store is <root>/.memai/mem.db.
`

// ---------------------------------------------------------------------------
// Small filesystem / JSON helpers
// ---------------------------------------------------------------------------

function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** Write only when content changed; returns created|updated|unchanged. */
function writeIfChanged(file, text) {
  const existing = readText(file)
  if (existing === text) return { action: 'unchanged', file }
  const existed = existing !== null
  writeText(file, text)
  return { action: existed ? 'updated' : 'created', file }
}

function readJson(file) {
  const raw = readText(file)
  if (raw === null) return { ok: true, exists: false, data: {} }
  try { return { ok: true, exists: true, data: JSON.parse(raw) } } catch (err) {
    return { ok: false, exists: true, error: err.message }
  }
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** Merge `entry` into data[pathKeys...][key], preserving every other key. */
function mergeJsonPath(data, pathKeys, key, entry) {
  const next = isPlainObject(data) ? { ...data } : {}
  let cursor = next
  for (const step of pathKeys) {
    cursor[step] = isPlainObject(cursor[step]) ? { ...cursor[step] } : {}
    cursor = cursor[step]
  }
  cursor[key] = entry
  return next
}

/** Merge `entry` into data[block][key], preserving every other key. */
function mergeJsonEntry(data, { block, key, entry }) {
  return mergeJsonPath(data, [block], key, entry)
}

// ---------------------------------------------------------------------------
// Instruction block
// ---------------------------------------------------------------------------

/**
 * The block written into CLAUDE.md / AGENTS.md. Deliberately short, stable
 * (no timestamps, no absolute paths: it is committed) and tool-agnostic.
 */
export function instructionBlock({ agents = [] } = {}) {
  const claude = agents.includes('claude')
  const mcpLine = claude
    ? 'MCP: server `memai`, tool `mem` (in Claude Code the full name is `mcp__memai__mem`).'
    : 'MCP: server `memai`, tool `mem`. If MCP is not configured, run the same operations with the `memai` CLI.'
  return [
    INIT_MARKER_START,
    '## MemAi — paged project memory (read this first)',
    '',
    'This repository has a MemAi store in `.memai/` (local SQLite, no network, gitignored). It distils the repo',
    'locally — 0 model tokens — into small budgeted pages: a project card, a symbol map, per-file signature',
    'pages, and a shared multi-agent board.',
    '',
    mcpLine,
    '',
    '**At session start**, load the card once: `{"op":"card"}` (~200 tokens) or `memai card`. Then page in only',
    'what you need:',
    '',
    '- locate a symbol/feature: `{"op":"query","q":"<terms>"}` then `{"op":"fault","target":"<symbol>"}` for one',
    '  body slice. `fault <path>:<line>` works for line ranges and non-source files.',
    '- understand a module: `{"op":"get","pageId":"file:<path>"}` gives signatures (~10–30% of the file), then',
    '  fault only the symbols the task touches.',
    '- resume after edits: `{"op":"diff","since":"<version>"}` (record the current version at session end) —',
    '  do not re-read changed files. Re-index after edits: `{"op":"index"}` (local, 0 model tokens).',
    '- share state with other agents: `{"op":"note","topic":"<topic>","body":"..."}` and',
    '  `{"op":"inbox","agent":"<id>"}`. Send page ids and symbol names, never file bodies.',
    '',
    '**Rules:** never inline content that can be referenced; prefer one `fault` over reading a whole file.',
    'Do NOT use MemAi for a single file under ~1.3 KB (~346 tokens) — a plain read is cheaper.',
    INIT_MARKER_END,
  ].join('\n')
}

/**
 * Replace the marked block in `existing` (or append it). Throws if the file has
 * only one of the two markers, so a corrupted block is never silently cloned.
 * @returns {{text:string, action:'created'|'updated'|'unchanged'}}
 */
export function mergeInstructionBlock(existing, block) {
  const text = existing ?? ''
  const start = text.indexOf(INIT_MARKER_START)
  const end = text.indexOf(INIT_MARKER_END)
  if (start === -1 && end === -1) {
    if (!text) return { text: block + '\n', action: 'created' }
    const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
    return { text: text + sep + block + '\n', action: 'updated' }
  }
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`found a partial MemAi marker block (${INIT_MARKER_START} / ${INIT_MARKER_END}); fix or remove it and re-run`)
  }
  const next = text.slice(0, start) + block + text.slice(end + INIT_MARKER_END.length)
  return { text: next, action: next === text ? 'unchanged' : 'updated' }
}

// ---------------------------------------------------------------------------
// Config snippets
// ---------------------------------------------------------------------------

/** Command/args an MCP client should run for this repository. */
export function mcpServerEntry({ root }) {
  const npxCached = /[\\/]_npx[\\/]/i.test(REPO_ROOT)
  if (npxCached) {
    return { command: 'npx', args: ['-y', '-p', 'memai-cli', 'memai-mcp', '--root', root] }
  }
  return { command: process.execPath, args: [SELF_MCP, '--root', root] }
}

function shellQuote(s) {
  const v = String(s)
  return /[\s"']/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v
}

/**
 * Hook commands are executed through a shell (bash when Git Bash is present, otherwise
 * PowerShell). Windows backslashes are consumed as escapes by bash, so emit forward slashes:
 * they work in bash, PowerShell and cmd alike.
 */
const slashPath = (p) => String(p).replace(/\\/g, '/')

function hookCommand({ root, event = 'SessionStart' }) {
  const parts = [slashPath(process.execPath), slashPath(SELF_CLI), 'hook', 'card', '--root', slashPath(root)]
  if (event !== 'SessionStart') parts.push('--event', event)
  return parts.map(shellQuote).join(' ')
}

function tomlString(s) {
  return JSON.stringify(String(s))
}

function tomlArray(items) {
  return `[${items.map(tomlString).join(', ')}]`
}

/**
 * The MCP config snippets written into .memai/configs/.
 *
 * They are absolute for THIS checkout (verified working); the published package can be used via
 * `npx -y -p memai-cli memai-mcp` instead (the `memai-cli` bin alias also makes `npx -y memai-cli
 * mcp` resolve).
 *
 * Shapes are per-client and were checked against the real CLIs where installed:
 *   * Claude Code  project .mcp.json   -> { mcpServers: { memai: { type, command, args } } }
 *   * generic MCP                      -> { mcpServers: { memai: { command, args } } }
 *   * OpenCode v2                      -> { mcp: { servers: { memai: { type:'local', command:[...] } } } }
 *                                         (v2 ignores a bare `mcp.memai`, and reads `disabled`, not `enabled`)
 *   * ZCode                            -> { mcp: { servers: { memai: { type:'stdio', command, args } } } }
 *                                         plus process hooks; hooks are off unless `hooks.enabled`
 */
export function configSnippets({ root }) {
  const entry = mcpServerEntry({ root })
  const claudeMcp = { mcpServers: { memai: { type: 'stdio', ...entry } } }
  const genericMcp = { mcpServers: { memai: { ...entry } } }
  const opencode = {
    $schema: 'https://opencode.ai/config.json',
    mcp: { servers: { memai: { type: 'local', command: [entry.command, ...entry.args], cwd: '.' } } },
  }
  const zcode = {
    mcp: {
      servers: {
        memai: { type: 'stdio', command: entry.command, args: entry.args, timeoutMs: 30000 },
      },
    },
    hooks: {
      enabled: true,
      events: {
        SessionStart: [{
          matcher: 'startup|resume',
          hooks: [{
            type: 'process',
            command: process.execPath,
            args: [SELF_CLI, 'hook', 'card'],
            timeoutMs: 20000,
          }],
        }],
      },
    },
  }
  const codexToml = [
    '# Codex CLI MCP server for MemAi. Append to ~/.codex/config.toml (global).',
    '[mcp_servers.memai]',
    `command = ${tomlString(entry.command)}`,
    `args = ${tomlArray(entry.args)}`,
    '',
  ].join('\n')
  const claudeHooks = {
    hooks: {
      SessionStart: [
        { matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: hookCommand({ root }), timeout: 30 }] },
      ],
      SubagentStart: [
        { hooks: [{ type: 'command', command: hookCommand({ root, event: 'SubagentStart' }), timeout: 30 }] },
      ],
    },
  }
  return {
    'claude-mcp.json': JSON.stringify(claudeMcp, null, 2) + '\n',
    'generic-mcp.json': JSON.stringify(genericMcp, null, 2) + '\n',
    'opencode.json': JSON.stringify(opencode, null, 2) + '\n',
    'zcode-config.json': JSON.stringify(zcode, null, 2) + '\n',
    'codex-config.toml': codexToml,
    'claude-settings-hooks.json': JSON.stringify(claudeHooks, null, 2) + '\n',
  }
}

// ---------------------------------------------------------------------------
// Agent detection
// ---------------------------------------------------------------------------

function onPath(name, env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      try { if (fs.statSync(path.join(dir, name + ext)).isFile()) return true } catch { /* next */ }
    }
  }
  return false
}

export function detectAgents({ root, env = process.env } = {}) {
  const found = new Set()
  const has = (rel) => fs.existsSync(path.join(root, rel))
  if (has('CLAUDE.md') || has('.claude') || onPath('claude', env)) found.add('claude')
  if (has('.codex') || onPath('codex', env)) found.add('codex')
  if (has('opencode.json') || has('.opencode') || onPath('opencode', env)) found.add('opencode')
  if (has('.zcode') || onPath('zcode', env)) found.add('zcode')
  if (has('.dsh') || env.DSH_HOME) found.add('dsh')
  if (!found.size) found.add('generic')
  return AGENTS.filter((a) => found.has(a))
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function parseInitArgv(argv) {
  const flags = { agent: [] }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { positional.push(a); continue }
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
    let value = eq > 0 ? a.slice(eq + 1) : undefined
    if (value === undefined) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--') && ['root', 'db', 'agent', 'max-files'].includes(key)) { value = next; i++ }
    }
    if (key === 'agent') {
      for (const name of String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) flags.agent.push(name)
    } else if (value === undefined) flags[key] = true
    else flags[key] = value
  }
  return { positional, flags }
}

function normalizeAgents(requested) {
  const out = new Set()
  for (const name of requested) {
    if (name === 'all') { for (const a of AGENTS) out.add(a); continue }
    if (!AGENTS.includes(name)) throw new Error(`unknown agent: ${name} (expected ${AGENTS.join('|')}|all)`)
    out.add(name)
  }
  return AGENTS.filter((a) => out.has(a))
}

const defaultRoot = () => process.env[ROOT_ENV] || process.cwd()

function defaultDbFor(root, explicitDb) {
  if (explicitDb !== undefined && explicitDb !== true) return path.resolve(String(explicitDb))
  if (process.env.MEMAI_DB) return path.resolve(process.env.MEMAI_DB)
  return path.join(path.resolve(root), STORE_DIR, DB_FILE)
}

/**
 * Run `memai init`.
 * @returns {Promise<{ok:boolean, text:string, root?:string, db?:string, changed?:object[], manualSteps?:string[]}>}
 */
export async function runInit(argv = [], { env = process.env, cwd = process.cwd(), out = null } = {}) {
  const { flags } = parseInitArgv(argv)
  if (flags.help) return { ok: true, text: INIT_HELP }

  const root = path.resolve(cwd, String(flags.root !== undefined && flags.root !== true ? flags.root : (env[ROOT_ENV] || defaultRoot())))
  const db = defaultDbFor(root, flags.db)
  let agents
  try {
    agents = normalizeAgents(flags.agent.length ? flags.agent : detectAgents({ root, env }))
  } catch (err) {
    return { ok: false, text: `memai init: ${err.message}\n` }
  }

  // --md: preview the instruction block(s) for the selected files, write nothing.
  if (flags.md) {
    const files = [...new Set(agents.flatMap((a) => AGENT_TARGETS[a]))]
    const block = instructionBlock({ agents })
    const parts = files.map((f) => `--- ${f} ---\n${block}`)
    return {
      ok: true,
      text: `# ${PRODUCT} init preview (--md, nothing written)\n# root: ${root}\n# agents: ${agents.join(', ')}\n\n${parts.join('\n\n')}\n\n# re-run without --md to create the store and write these blocks\n`,
      root, agents, changed: [], manualSteps: [],
    }
  }

  const changed = []
  const manualSteps = []
  const storeDir = path.dirname(db)
  fs.mkdirSync(storeDir, { recursive: true })

  // 1. Agent Skills package: one canonical skill copied into the two roots agents scan.
  //    Installed before indexing so the store sees a stable corpus. Conflicts never abort init.
  let skillResult = null
  if (!flags['no-skill']) {
    try {
      skillResult = installSkills({ root, env, agents, sourceDir: canonicalSkillDir() })
    } catch (err) {
      skillResult = {
        ok: false, source: canonicalSkillDir(), scope: 'project', base: root,
        results: [], changed: 0, conflicts: 0, errors: 1, error: err?.message ?? String(err),
      }
    }
  }

  // 2. Store + index (local, deterministic, idempotent by content hash).
  let indexResult = null
  let storeAction = 'existing'
  const hadStore = fs.existsSync(db)
  const store = new MemoryStore({ dbPath: db, root })
  try {
    store.setMeta('root', root)
    if (!flags['no-index']) {
      const pages = new MemoryPages({ store, root })
      indexResult = await pages.index({ maxFiles: flags['max-files'] ? Number(flags['max-files']) : 4000, force: !!flags.force })
    }
  } finally {
    store.close()
  }
  if (!hadStore) storeAction = 'created'

  // 3. Instruction blocks (idempotent markers, merged not clobbered).
  const instructionFiles = [...new Set(agents.flatMap((a) => AGENT_TARGETS[a]))]
  const block = instructionBlock({ agents })
  for (const name of instructionFiles) {
    const file = path.join(root, name)
    try {
      const merged = mergeInstructionBlock(readText(file), block)
      if (merged.action === 'unchanged') continue
      writeText(file, merged.text)
      changed.push({ file: name, action: merged.action === 'created' ? 'created' : 'updated' })
    } catch (err) {
      return { ok: false, text: `memai init: ${name}: ${err.message}\n`, root, db, changed, manualSteps }
    }
  }

  // 4. Ready-to-paste MCP config snippets.
  const configDir = path.join(storeDir, 'configs')
  for (const [name, content] of Object.entries(configSnippets({ root }))) {
    const w = writeIfChanged(path.join(configDir, name), content)
    if (w.action !== 'unchanged') changed.push({ file: `configs/${name}`, action: w.action })
  }

  // 5. --write-configs: merge the two project-scope config files that tolerate it.
  if (flags['write-configs']) {
    if (agents.includes('claude')) {
      const file = path.join(root, '.mcp.json')
      const parsed = readJson(file)
      if (!parsed.ok) {
        manualSteps.push(`.mcp.json exists but is not valid JSON (${parsed.error}); merge .memai/configs/claude-mcp.json manually.`)
      } else {
        const next = mergeJsonEntry(parsed.data, { block: 'mcpServers', key: 'memai', entry: { type: 'stdio', ...mcpServerEntry({ root }) } })
        const w = writeIfChanged(file, JSON.stringify(next, null, 2) + '\n')
        if (w.action !== 'unchanged') changed.push({ file: '.mcp.json', action: w.action })
      }
    }
    if (agents.includes('opencode')) {
      const file = path.join(root, 'opencode.json')
      const parsed = readJson(file)
      if (!parsed.ok) {
        manualSteps.push(`opencode.json exists but is not valid JSON (${parsed.error}); merge .memai/configs/opencode.json manually.`)
      } else {
        const entry = mcpServerEntry({ root })
        // OpenCode v2: servers live under `mcp.servers`, and `disabled` (not `enabled`) toggles one.
        const next = mergeJsonPath(parsed.data, ['mcp', 'servers'], 'memai', {
          type: 'local',
          command: [entry.command, ...entry.args],
          cwd: '.',
        })
        const w = writeIfChanged(file, JSON.stringify(next, null, 2) + '\n')
        if (w.action !== 'unchanged') changed.push({ file: 'opencode.json', action: w.action })
      }
    }
  }

  // 6. What is left for a human (or an agent) to do.
  if (agents.includes('claude')) {
    if (flags['write-configs']) {
      manualSteps.push('Claude Code: .mcp.json holds the `memai` server — approve it on next start (`claude mcp list`), or add it manually with `claude mcp add -s project memai -- npx -y -p memai-cli memai-mcp`.')
    } else {
      manualSteps.push('Claude Code: copy .memai/configs/claude-mcp.json into .mcp.json, or run `claude mcp add memai -- ...` (re-run init with --write-configs to merge it).')
    }
    manualSteps.push('Claude Code (optional): merge .memai/configs/claude-settings-hooks.json into .claude/settings.json to inject the card at SessionStart (hook schema: documented, see adapters/claude-code/).')
  }
  if (agents.includes('codex')) {
    manualSteps.push('Codex: append .memai/configs/codex-config.toml to ~/.codex/config.toml (global; project-local config.toml support is unverified).')
  }
  if (agents.includes('opencode')) {
    manualSteps.push(flags['write-configs']
      ? 'OpenCode: opencode.json was updated (mcp.servers.memai, OpenCode v2 shape) — restart OpenCode.'
      : 'OpenCode: merge .memai/configs/opencode.json into opencode.json (re-run init with --write-configs to merge it).')
  }
  if (agents.includes('zcode')) {
    manualSteps.push('ZCode: merge .memai/configs/zcode-config.json into ~/.zcode/cli/config.json (mcp.servers.memai + optional SessionStart hook; exact keys documented in adapters/zcode/).')
  }
  if (agents.includes('dsh')) {
    manualSteps.push('DSH: no MCP needed — install the cordis bundle in adapters/dsh/ via plugin_manager (it injects the card into every in-process agent).')
  }
  if (agents.includes('generic')) {
    manualSteps.push('Generic MCP clients (Cursor/Zed/Cline/Gemini/…): point the client at .memai/configs/generic-mcp.json.')
  }
  if (skillResult) {
    if (skillResult.error) {
      manualSteps.push(`Skill: could not install the Agent Skills package (${skillResult.error}); run \`memai skill install\` manually.`)
    } else if (skillResult.conflicts) {
      for (const conflict of skillResult.results.filter((r) => r.action === 'conflict')) {
        manualSteps.push(`Skill: ${path.relative(root, conflict.path)} exists with different content — run \`memai skill install --force\` to replace it.`)
      }
    } else if (skillResult.changed) {
      const dirs = skillResult.results.filter((r) => r.action === 'created' || r.action === 'updated').map((r) => path.relative(root, r.path))
      manualSteps.push(`Skill: installed in ${dirs.join(', ')} — the agent lists it in its skill catalog (Claude Code: /skills, /memai).`)
    }
  } else if (flags['no-skill']) {
    manualSteps.push('Skill: skipped (--no-skill). Run `memai skill install --agent all` later to add it.')
  }
  manualSteps.push('Restart/reload your agent so it picks up the new MCP server, instruction files and skill.')

  // 7. Human summary.
  const lines = [
    `${PRODUCT} init — root ${root}`,
    `store: ${path.relative(root, db) || db} (${storeAction})`,
  ]
  if (indexResult) {
    const unchanged = indexResult.readFiles === 0 && indexResult.deleted === 0
    lines.push(unchanged
      ? `index: unchanged (version ${String(indexResult.version).slice(0, 8)}, ${indexResult.files} files, ${indexResult.elapsedMs}ms)`
      : `index: ${indexResult.files} files, ${indexResult.fullTokens} tokens if read fully, version ${String(indexResult.version).slice(0, 8)}, ${indexResult.elapsedMs}ms (local, 0 model tokens)`)
  } else {
    lines.push('index: skipped (--no-index)')
  }
  lines.push(changed.length
    ? `changed: ${changed.length} file(s) — ${changed.map((c) => `${c.file} ${c.action}`).join(', ')}`
    : 'changed: 0 file(s) (already up to date)')
  lines.push(`instructions: ${instructionFiles.join(', ')}`)
  if (!skillResult) {
    lines.push('skills: skipped (--no-skill)')
  } else if (skillResult.error) {
    lines.push(`skills: failed (${skillResult.error})`)
  } else {
    const skillChanged = skillResult.results.filter((r) => r.action === 'created' || r.action === 'updated')
    const dirs = skillResult.results.map((r) => path.relative(root, r.path))
    lines.push(skillChanged.length
      ? `skills: ${skillChanged.length} installed — ${skillChanged.map((r) => path.relative(root, r.path)).join(', ')}`
      : `skills: already installed (${dirs.join(', ')})`)
    if (skillResult.conflicts) lines.push(`skills: ${skillResult.conflicts} conflicting target(s) — re-run \`memai skill install --force\``)
  }
  lines.push('manual steps:')
  for (const step of manualSteps) lines.push(`  - ${step}`)
  lines.push('')
  lines.push('next: `memai card` (or the `mem` MCP tool with {"op":"card"})')

  const result = { ok: true, root, db, agents, index: indexResult, skills: skillResult, changed, manualSteps, text: lines.join('\n') + '\n' }
  if (out) out.write(result.text)
  return result
}
