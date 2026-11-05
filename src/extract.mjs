// Deterministic repo distillation: turns a working tree into compact pages.
//
//   project.card    ~700-token orientation page: stack, commands, entrypoints,
//                   layout, conventions, paging protocol. Loaded once per session.
//   project.map     <=3500-token symbol map: one line per file with LOC + top
//                   symbols. This is the replacement for "read every file".
//   file:<path>     per-file page: header + imports + symbol signatures with
//                   line numbers. Bodies are NOT included; demand-page them with
//                   `fault <symbol>`.
//
// Everything here is deterministic (sorted paths, no timestamps in page text,
// extractor version pinned), so the same tree always yields the same hashes.
// Extraction is local CPU+disk: zero model tokens.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { sha1 } from './store.mjs'
import { estTokens, clampText } from './tokens.mjs'

/** Bump when extraction output changes; it participates in every page hash. */
export const EXTRACTOR_VERSION = 'x1'

const LANG_BY_EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'java', cs: 'cs',
  rb: 'rb', php: 'php', sql: 'sql', json: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'md', markdown: 'md',
  sh: 'sh', bash: 'sh', ps1: 'sh', html: 'html', htm: 'html', css: 'css', scss: 'css',
}
export const SOURCE_LANGS = new Set(['js', 'ts', 'py', 'go', 'rs', 'java', 'cs', 'rb', 'php', 'sql', 'sh', 'html', 'css'])

const IGNORE_DIRS = new Set([
  '.git', '.hg', '.svn', '.memai', '.memory', '.mempages', 'node_modules', 'bower_components', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', 'target', 'vendor', '.venv', 'venv',
  '__pycache__', '.cache', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.gradle', '.dart_tool', '.terraform', 'Pods', '.DS_Store',
])
const IGNORE_FILE_RES = [
  /^package-lock\.json$/, /^pnpm-lock\.yaml$/, /^yarn\.lock$/, /^npm-shrinkwrap\.json$/,
  /\.min\.(js|css)$/, /\.map$/, /\.lock$/,
  /\.(png|jpe?g|gif|webp|ico|bmp|tiff|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|exe|dll|so|dylib|node|wasm|woff2?|ttf|otf|eot|mp4|mp3|wav|mov|avi|bin|dat|db|sqlite|sqlite3)$/i,
]
const MAX_FILE_BYTES = 512 * 1024

export function langOf(relPath) { return LANG_BY_EXT[path.extname(relPath).slice(1).toLowerCase()] || null }
export function isTestPath(rel) { return /(^|[\\/])(tests?|__tests__|specs?)([\\/]|$)|\.(test|spec)\.[a-z0-9]+$/i.test(rel) }
export function isDocPath(rel) { return /(^|[\\/])(docs?|man)([\\/]|$)|\.md$/i.test(rel) }
export function isConfigPath(rel) { return /(^|[\\/])(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|Makefile|makefile|README[^\\/]*|tsconfig\.json|\.eslintrc[^\\/]*|vite\.config\.[a-z]+|next\.config\.[a-z]+|docker-compose\.ya?ml|Dockerfile)$/i.test(rel) }

// ---------------------------------------------------------------------------
// Corpus discovery
// ---------------------------------------------------------------------------

function applyGitignoreRule(rule) {
  let r = rule.trim()
  if (!r || r.startsWith('#')) return null
  const neg = r.startsWith('!')
  if (neg) r = r.slice(1)
  const dirOnly = r.endsWith('/')
  if (dirOnly) r = r.slice(0, -1)
  const anchored = r.startsWith('/')
  if (anchored) r = r.slice(1)
  const body = r.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*').replace(/\?/g, '[^/]')
  const re = anchored || r.includes('/') ? new RegExp(`^${body}${dirOnly ? '(/|$)' : '(/|$)'}`) : new RegExp(`(^|/)${body}${dirOnly ? '(/|$)' : '(/|$)'}`)
  return { re, neg, dirOnly }
}
function readGitignore(root) {
  const rules = []
  for (const name of ['.gitignore', '.git/info/exclude']) {
    try { for (const line of fs.readFileSync(path.join(root, name), 'utf8').split('\n')) { const r = applyGitignoreRule(line); if (r) rules.push(r) } } catch {}
  }
  return rules
}
function ignoredByGitignore(rel, isDir, rules) {
  let ignored = false
  for (const r of rules) {
    if (r.dirOnly && !isDir && !rel.includes('/')) continue
    if (r.re.test(rel)) ignored = !r.neg
  }
  return ignored
}

export function listFiles(root, { maxFiles = 4000, useGit = true, ignore = [] } = {}) {
  const gitDir = path.join(root, '.git')
  const rules = readGitignore(root)
  const out = []
  let ignored = 0
  const ignorePrefixes = ignore.map((p) => String(p).replace(/\\\\/g, '/').replace(/\/+$/, ''))
  const isIgnored = (rel) => ignorePrefixes.some((p) => rel === p || rel.startsWith(p + '/'))
  const push = (rel, st) => {
    if (isIgnored(rel)) { ignored++; return }
    const ext = path.extname(rel).slice(1).toLowerCase()
    if (!LANG_BY_EXT[ext]) { ignored++; return }
    if (IGNORE_FILE_RES.some((re) => re.test(rel))) { ignored++; return }
    if (st.size > MAX_FILE_BYTES) { ignored++; return }
    out.push({ path: rel, abs: path.join(root, rel), bytes: st.size, mtime: Math.floor(st.mtimeMs) })
  }
  if (useGit && fs.existsSync(gitDir)) {
    // git ls-files: tracked files, already .gitignore-filtered, deterministic order.
    let raw = ''
    try {
      raw = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    } catch { raw = '' }
    if (raw) {
      for (const rel of raw.split('\0').filter(Boolean)) {
        let st
        try { st = fs.statSync(path.join(root, rel)) } catch { continue }
        if (!st.isFile()) continue
        push(rel.split(path.sep).join('/'), st)
      }
      out.sort((a, b) => a.path.localeCompare(b.path))
      return { files: out.slice(0, maxFiles), source: 'git', ignored }
    }
  }
  const walk = (dirAbs, prefix) => {
    if (out.length >= maxFiles) return
    let entries
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) { ignored++; continue }
        if (rules.length && ignoredByGitignore(rel, true, rules)) { ignored++; continue }
        walk(path.join(dirAbs, e.name), rel)
      } else if (e.isFile()) {
        if (rules.length && ignoredByGitignore(rel, false, rules)) { ignored++; continue }
        let st
        try { st = fs.statSync(path.join(dirAbs, e.name)) } catch { continue }
        push(rel, st)
      }
    }
  }
  walk(root, '')
  out.sort((a, b) => a.path.localeCompare(b.path))
  return { files: out.slice(0, maxFiles), source: 'walk', ignored }
}

/** Cheap binary check: a NUL byte in the first 8 KiB means "not text". */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

// ---------------------------------------------------------------------------
// Symbol extraction (regex, deterministic, per language)
// ---------------------------------------------------------------------------

const KEYWORDS = new Set('if for while switch catch function return new do else try finally with await yield throw typeof instanceof delete void class constructor'.split(' '))

function rulesFor(lang) {
  // Top-level declarations only for functions/classes/consts: local variables a
  // few indent levels deep are noise for navigation (they are still reachable
  // through `fault <path>:<line>`). Routes/tests/headings may be indented.
  const jsLike = [
    { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, kind: 'function' },
    { re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, kind: 'function' },
    { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/, kind: 'import' },
    { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'const' },
    { re: /^(?:export\s+)?(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
    { re: /^\s*(?:app|router|server|api|fastify)\.(get|post|put|patch|delete|use|all)\s*\(\s*['"`]([^'"`]+)/, kind: 'route', nameFrom: 2 },
    { re: /^\s*(?:describe|it|test|suite)\s*\(\s*['"`]([^'"`]{1,80})/, kind: 'test', nameFrom: 1 },
    { re: /^\s*exports\.([A-Za-z_$][\w$]*)\s*=/, kind: 'export' },
  ]
  if (lang === 'js' || lang === 'ts') return jsLike
  if (lang === 'py') return [
    { re: /^\s*(?:async\s+)?def\s+(\w+)\s*\(/, kind: 'function' },
    { re: /^\s*class\s+(\w+)/, kind: 'class' },
    { re: /^([A-Z][A-Z0-9_]{2,})\s*=/, kind: 'const' },
  ]
  if (lang === 'go') return [
    { re: /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/, kind: 'function' },
    { re: /^type\s+(\w+)\s+(?:struct|interface)/, kind: 'type' },
    { re: /^func\s+\(/, kind: 'method', nameFrom: 0, literalName: 'method' },
  ]
  if (lang === 'rs') return [
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, kind: 'function' },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|union)\s+(\w+)/, kind: 'type' },
    { re: /^\s*(?:pub\s+)?mod\s+(\w+)/, kind: 'module' },
    { re: /^\s*(?:pub\s+)?const\s+(\w+)/, kind: 'const' },
  ]
  if (lang === 'java' || lang === 'cs') return [
    { re: /^\s*(?:public|private|protected|internal|static|final|abstract|sealed|partial|\s)*\s*(?:class|interface|enum|record|struct)\s+(\w+)/, kind: 'class' },
    { re: /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:final\s+)?(?:async\s+)?[\w<>[\],.? ]+\s+(\w+)\s*\(/, kind: 'method' },
  ]
  if (lang === 'rb') return [
    { re: /^\s*def\s+(?:self\.)?(\w+[?!=]?)/, kind: 'function' },
    { re: /^\s*(?:class|module)\s+([A-Z]\w*)/, kind: 'class' },
  ]
  if (lang === 'php') return [
    { re: /^\s*(?:public|private|protected|static|\s)*function\s+(\w+)/, kind: 'function' },
    { re: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, kind: 'class' },
  ]
  if (lang === 'sql') return [
    { re: /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/i, kind: 'table' },
    { re: /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/i, kind: 'index' },
    { re: /^\s*ALTER\s+TABLE\s+([\w."]+)/i, kind: 'table' },
  ]
  if (lang === 'sh') return [
    { re: /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, kind: 'function' },
  ]
  if (lang === 'md') return [{ re: /^(#{1,3})\s+(.+)/, kind: 'heading', nameFrom: 2 }]
  return []
}

const IMPORT_RES = {
  js: [/from\s+['"]([^'"]+)['"]/g, /require\(\s*['"]([^'"]+)['"]\s*\)/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g],
  ts: [/from\s+['"]([^'"]+)['"]/g, /require\(\s*['"]([^'"]+)['"]\s*\)/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g],
  py: [/^\s*from\s+([\w.]+)\s+import\s+/gm, /^\s*import\s+([\w.]+)/gm],
  go: [/^\s*import\s+"([^"]+)"/gm, /^\s*"([\w./-]+)"\s*$/gm],
  rs: [/^\s*use\s+([\w:]+)/gm],
  java: [/^\s*import\s+([\w.]+);/gm],
  cs: [/^\s*using\s+([\w.]+);/gm],
  rb: [/require\s+['"]([^'"]+)['"]/g],
  php: [/(?:require|include)(?:_once)?\s*[('"]\s*([^'")]+)/g],
}

/** @returns {{symbols:Array<{name:string,kind:string,line:number,signature:string}>, imports:string[]}} */
export function extractSymbols(text, lang) {
  const lines = text.split('\n')
  const rules = rulesFor(lang)
  const symbols = []
  const seen = new Set()
  // nameFrom: capture group containing the name (default 1); literalName: fixed name
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length > 400) continue
    for (const rule of rules) {
      const m = rule.re.exec(line)
      if (!m) continue
      let name = rule.literalName ?? (rule.nameFrom ? m[rule.nameFrom] : m[1])
      if (!name) continue
      name = String(name).trim()
      if (!name || KEYWORDS.has(name)) continue
      if (rule.kind === 'route') name = `${m[1].toUpperCase()} ${name}`
      if (rule.kind === 'md') name = `${'#'.repeat(m[1].length)} ${name}`.slice(0, 90)
      if (name.length > 90) name = name.slice(0, 90)
      const key = `${name}@${i + 1}`
      if (seen.has(key)) break
      seen.add(key)
      symbols.push({ name, kind: rule.kind, line: i + 1, signature: line.trim().slice(0, 160) })
      break
    }
    if (symbols.length >= 400) break
  }
  // Class methods: second pass, only when the file declares a class. Local
  // `const` noise is excluded above; methods are worth a line in the file page.
  if (['js', 'ts', 'java', 'cs', 'php'].includes(lang) && symbols.some((s) => s.kind === 'class')) {
    const methodRe = /^(\s{2,8})(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/
    for (let i = 0; i < lines.length && symbols.length < 400; i++) {
      if (symbols.some((s) => s.line === i + 1)) continue
      const m = methodRe.exec(lines[i])
      if (!m) continue
      const name = m[2]
      if (!name || KEYWORDS.has(name)) continue
      symbols.push({ name, kind: 'method', line: i + 1, signature: lines[i].trim().slice(0, 160) })
    }
    symbols.sort((a, b) => a.line - b.line)
  }
  // JSON/YAML/TOML: top-level keys, not regex rules.
  if (lang === 'json') {
    try {
      const obj = JSON.parse(text)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const k of Object.keys(obj).slice(0, 40)) symbols.push({ name: k, kind: 'key', line: lineOfKey(lines, k), signature: k })
      }
    } catch { /* invalid JSON: no symbols */ }
  }
  if (lang === 'yaml' || lang === 'toml') {
    for (let i = 0; i < lines.length && symbols.length < 60; i++) {
      const m = /^([A-Za-z0-9_.-]{1,60})\s*[:=]/.exec(lines[i])
      if (m) symbols.push({ name: m[1], kind: 'key', line: i + 1, signature: lines[i].trim().slice(0, 160) })
    }
  }
  const imports = []
  const importRules = IMPORT_RES[lang] || []
  const seenImp = new Set()
  for (const re of importRules) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) && imports.length < 60) {
      const spec = (m[1] || '').trim()
      if (spec && spec.length <= 120 && !seenImp.has(spec)) { seenImp.add(spec); imports.push(spec) }
    }
  }
  return { symbols, imports }
}

function lineOfKey(lines, key) {
  const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`)
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1
  return 1
}

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------

export function filePageVersion(rel, contentHash) { return sha1(`${EXTRACTOR_VERSION}|file|${rel}|${contentHash}`) }
export function pageTextVersion(pageId, text) { return sha1(`${EXTRACTOR_VERSION}|${pageId}|${text}`) }

export function renderFilePage({ rel, lang, loc, bytes, contentHash, symbols, imports }, { budget = 1200 } = {}) {
  const head = `# file: ${rel}  ${lang} ${loc}L ${fmtBytes(bytes)} sha1:${contentHash.slice(0, 8)}`
  const parts = [head]
  const imp = imports.slice(0, 6)
  if (imp.length) parts.push(`imports: ${imp.join(', ')}${imports.length > 6 ? ` (+${imports.length - 6})` : ''}`)
  if (!symbols.length) parts.push('(no symbols extracted — fault <path>:<line> to page a line range)')
  else {
    parts.push(`symbols (${symbols.length}):`)
    for (const s of symbols.slice(0, 60)) {
      const sig = s.kind === 'heading' || s.kind === 'key' ? '' : s.signature
      parts.push(`${String(s.line).padStart(5)} ${s.kind.padEnd(8)} ${sig || s.name}`)
    }
    if (symbols.length > 60) parts.push(`… (+${symbols.length - 60} symbols omitted; query or fault directly)`)
  }
  return clampText(parts.join('\n'), budget)
}

const fmtBytes = (n) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`

function symbolListText(symbols, max = 4) {
  const PRIORITY = { function: 5, class: 5, route: 4, type: 4, export: 3, method: 3, const: 1, test: 1 }
  const usable = symbols.filter((s) => !['import', 'heading', 'key'].includes(s.kind))
  usable.sort((a, b) => (PRIORITY[b.kind] ?? 0) - (PRIORITY[a.kind] ?? 0) || a.line - b.line)
  const names = []
  for (const s of usable) if (!names.includes(s.name)) names.push(s.name)
  const shown = names.slice(0, max)
  return `${shown.join(',')}${names.length > max ? `,+${names.length - max}` : ''}`
}

/** Build the <=budget-token project.map from per-file records. */
export function renderProjectMap(records, { budget = 3500, version = '' } = {}) {
  const files = [...records].sort((a, b) => a.rel.localeCompare(b.rel))
  const totalBytes = files.reduce((a, f) => a + f.bytes, 0)
  const totalTokens = files.reduce((a, f) => a + f.tokens, 0)
  // Priority: source > other (config/data) > tests > docs. Deterministic and
  // independent of budget, so the same tree always produces the same ordering.
  const prio = (f) => (isDocPath(f.rel) ? 0 : isTestPath(f.rel) ? 1 : SOURCE_LANGS.has(f.lang) ? 3 : 2)
  const byDir = new Map()
  for (const f of files) {
    const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '.'
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push(f)
  }
  const dirScore = (d) => byDir.get(d).reduce((a, f) => a + prio(f), 0)
  const dirs = [...byDir.keys()].sort((a, b) => dirScore(b) - dirScore(a) || (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)))
  for (const d of dirs) byDir.get(d).sort((a, b) => prio(b) - prio(a) || a.rel.localeCompare(b.rel))
  const header = `# project map${version ? ` (v ${version.slice(0, 8)})` : ''} — ${files.length} files, ${fmtBytes(totalBytes)}, ~${totalTokens} tokens if read fully`
  const lines = [header]
  const footer = (n) => `… (+${n} files omitted by map budget — \`query\`/\`fault\` to page them)`
  let omitted = 0
  for (const dir of dirs) {
    const entries = byDir.get(dir)
    const dirLineIndex = lines.length
    lines.push(`${dir}/`)
    let added = 0
    for (const f of entries) {
      const base = f.rel.slice(f.rel.lastIndexOf('/') + 1)
      const line = `  ${base} ${f.loc}L ${symbolListText(f.symbols)}`.trimEnd()
      const candidate = lines.join('\n') + '\n' + line
      if (estTokens(candidate) > budget) { omitted += entries.length - added; break }
      lines.push(line)
      added++
    }
    if (added === 0) { omitted += entries.length; lines.splice(dirLineIndex, 1) } // drop empty dir header
  }
  if (omitted) lines.push(footer(omitted))
  const text = lines.join('\n')
  // Final hard clamp in case the footer pushed us over.
  return clampText(text, budget)
}

/** Build the <=budget-token project.card. */
export function renderProjectCard({ root, files, records, version, commands, entrypoints, name, description, topLevel, conventions, budget = 700 }) {
  const totalBytes = files.reduce((a, f) => a + f.bytes, 0)
  const totalTokens = records.reduce((a, f) => a + f.tokens, 0)
  const langs = {}
  for (const f of files) langs[f.lang] = (langs[f.lang] || 0) + 1
  const langText = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, n]) => `${l} ${n}f`).join(' · ')
  const lines = []
  lines.push(`# project card${version ? ` (v ${version.slice(0, 8)})` : ''}${name ? ` — ${name}` : ''}`)
  if (description) lines.push(`description: ${description.slice(0, 160)}`)
  lines.push(`corpus: ${files.length} files, ${fmtBytes(totalBytes)}, ~${totalTokens} tokens if read fully`)
  lines.push(`stack: ${langText || 'unknown'}`)
  if (commands.length) {
    lines.push('commands:')
    for (const c of commands.slice(0, 6)) lines.push(`  ${c.name}: ${c.cmd.slice(0, 110)}`)
  }
  if (entrypoints.length) lines.push(`entrypoints: ${entrypoints.slice(0, 6).join(', ')}`)
  if (topLevel.length) {
    lines.push('layout:')
    for (const t of topLevel.slice(0, 8)) lines.push(`  ${t.dir}/ ${t.files}f${t.bytes ? ` ${fmtBytes(t.bytes)}` : ''}`)
  }
  if (conventions.length) {
    lines.push('conventions:')
    for (const c of conventions.slice(0, 6)) lines.push(`  - ${c}`)
  }
  lines.push('paging protocol (token-cheap; bodies are demand-paged):')
  lines.push('  map            symbol map of every file, <=3500 tok')
  lines.push('  query <q>      5 ranked page/page hits (~60 tok each)')
  lines.push('  get file:<p>   per-file signatures, <=1200 tok')
  lines.push('  fault <sym>    one symbol body slice, <=600 tok (path#sym, path:line also work)')
  lines.push('  diff --since <v>  tiny delta for a new session')
  lines.push('do NOT read whole files unless a fault proves the symbol is needed.')
  return clampText(lines.join('\n'), budget)
}

// ---------------------------------------------------------------------------
// Corpus metadata for the card
// ---------------------------------------------------------------------------

export function readConfigInfo(root, files) {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const info = { name: null, description: null, commands: [], entrypoints: [], conventions: [] }
  const relPaths = files.map((f) => f.path)
  // package.json
  const pkgRel = relPaths.find((p) => p === 'package.json') || relPaths.find((p) => p.endsWith('/package.json') && p.split('/').length <= 2)
  if (pkgRel) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, pkgRel), 'utf8'))
      info.name = pkg.name ?? null
      info.description = pkg.description ?? null
      const scripts = pkg.scripts || {}
      for (const key of ['test', 'build', 'lint', 'dev', 'start', 'check']) {
        if (scripts[key]) info.commands.push({ name: key, cmd: String(scripts[key]) })
      }
      if (pkg.main) info.entrypoints.push(`${pkgRel === 'package.json' ? '' : pkgRel.replace(/\/package\.json$/, '') + '/'}${String(pkg.main).replace(/^\.\//, '')}`)
      if (pkg.bin) {
        const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin)
        for (const b of bins) info.entrypoints.push(String(b).replace(/^\.\//, ''))
      }
      const dev = { ...(pkg.devDependencies || {}), ...(pkg.dependencies || {}) }
      for (const [name, label] of [['tap', 'tap'], ['jest', 'jest'], ['vitest', 'vitest'], ['mocha', 'mocha'], ['ava', 'ava']]) {
        if (dev[name]) { info.testRunner = label; break }
      }
      info.esm = pkg.type === 'module'
      info.pkg = pkg
    } catch {}
  }
  // pyproject / Cargo / go.mod
  for (const p of ['pyproject.toml', 'Cargo.toml', 'go.mod']) {
    if (!relPaths.includes(p)) continue
    try {
      const t = fs.readFileSync(path.join(root, p), 'utf8')
      for (const m of t.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]{1,80})"/gm)) {
        if (/^(name|version|description)$/.test(m[1]) && !info.name && m[1] === 'name') info.name = m[2]
      }
      if (p === 'pyproject.toml') {
        for (const m of t.matchAll(/^([A-Za-z0-9_-]+)\s*=\s*"([^"\n]{1,110})"/gm)) if (/^(pytest|ruff|mypy|black)$/.test(m[1])) info.commands.push({ name: m[1], cmd: m[1] })
      }
    } catch {}
  }
  if (!info.commands.length) {
    if (relPaths.some((p) => p === 'Makefile' || p === 'makefile')) info.commands.push({ name: 'make', cmd: 'make test' })
    if (relPaths.some((p) => p.endsWith('.py'))) info.commands.push({ name: 'test', cmd: 'python -m pytest' })
    if (relPaths.some((p) => p.endsWith('.go'))) info.commands.push({ name: 'test', cmd: 'go test ./...' })
    if (relPaths.some((p) => p.endsWith('.rs'))) info.commands.push({ name: 'test', cmd: 'cargo test' })
  }
  // Fallback entrypoints: conventional names, shallow first.
  if (!info.entrypoints.length) {
    const re = /(^|\/)(index|main|server|app|cli|entry)\.(js|mjs|cjs|ts|py|go|rs)$/
    const candidates = relPaths.filter((p) => re.test(p)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    info.entrypoints = candidates.slice(0, 3)
  }
  // Conventions from observed content.
  const hasEsm = relPaths.some((p) => /\.(mjs|ts|js)$/.test(p)) && files.some((f) => f.looksEsm)
  const hasCjs = files.some((f) => f.looksCjs)
  if (hasEsm && !hasCjs) info.conventions.push('ES module imports (import/export)')
  else if (hasCjs && !hasEsm) info.conventions.push('CommonJS (require/module.exports)')
  const testCount = relPaths.filter(isTestPath).length
  if (testCount) info.conventions.push(`${testCount} test files (${info.testRunner || 'runner not detected'})${relPaths.some((p) => /(^|\/)tests?(\/|$)/.test(p)) ? ', under tests/' : ''}`)
  const docCount = relPaths.filter((p) => /\.md$/i.test(p)).length
  if (docCount) info.conventions.push(`${docCount} markdown docs`)
  return info
}

function topLevelLayout(files) {
  const m = new Map()
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '.'
    if (!m.has(dir)) m.set(dir, { dir, files: 0, bytes: 0 })
    const e = m.get(dir)
    e.files++
    e.bytes += f.bytes
  }
  return [...m.values()].sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir))
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/**
 * Distil `root` into the store. Deterministic; idempotent (same tree => same
 * project version). Returns statistics including the new project version hash.
 */
export function indexCorpus(store, { root, maxFiles = 4000, cardBudget = 700, mapBudget = 3500, useGit = true, force = false, ignore = [] } = {}) {
  const t0 = performance.now()
  root = path.resolve(root)
  const listed = listFiles(root, { maxFiles, useGit, ignore })
  const records = []
  let readFiles = 0
  let reused = 0
  let deleted = 0

  // Files that vanished from the tree disappear from the index.
  const seen = new Set(listed.files.map((f) => f.path))
  for (const row of store.allFiles()) {
    if (!seen.has(row.path)) { store.deleteFile(row.path); deleted++ }
  }

  for (const f of listed.files) {
    let buf
    try { buf = fs.readFileSync(f.abs) } catch { continue }
    if (looksBinary(buf)) continue
    const text = buf.toString('utf8')
    const contentHash = sha1(buf)
    const lang = langOf(f.path)
    const prev = store.getFile(f.path)
    const prevPage = prev ? store.getPage(`file:${f.path}`) : null
    const expectedVersion = filePageVersion(f.path, contentHash)
    if (!force && prev && prev.content_hash === contentHash && prevPage && prevPage.version_hash === expectedVersion) {
      // Unchanged content: reuse symbol rows, only refresh mtime/tokens if needed.
      reused++
      const symbols = store.symbolsForPage(`file:${f.path}`)
      records.push({
        rel: f.path, lang, bytes: f.bytes, loc: prev.loc, contentHash, tokens: prev.tokens || estTokens(text),
        symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line, signature: s.signature })),
        imports: store.importsForFile(f.path),
        looksEsm: /\bimport\s|\bexport\s/.test(text.slice(0, 20000)), looksCjs: /\brequire\s*\(|module\.exports/.test(text.slice(0, 20000)),
      })
      continue
    }
    readFiles++
    const { symbols, imports } = extractSymbols(text, lang)
    const loc = text.split('\n').length
    const tokens = estTokens(text)
    const page = renderFilePage({ rel: f.path, lang, loc, bytes: f.bytes, contentHash, symbols, imports })
    store.upsertFile({ path: f.path, contentHash, bytes: f.bytes, loc, lang, mtime: f.mtime, tokens })
    store.setSymbols(`file:${f.path}`, f.path, symbols)
    store.setImports(`file:${f.path}`, f.path, imports)
    store.upsertPage({
      id: `file:${f.path}`, kind: `file:${lang}`, versionHash: filePageVersion(f.path, contentHash),
      text: page.text, producer: 'extract', meta: { contentHash, loc, bytes: f.bytes }, symbols: symbols.slice(0, 60),
      files: [{ path: f.path, contentHash, mtime: f.mtime, bytes: f.bytes }],
    })
    records.push({
      rel: f.path, lang, bytes: f.bytes, loc, contentHash, tokens,
      symbols, imports,
      looksEsm: /\bimport\s|\bexport\s/.test(text), looksCjs: /\brequire\s*\(|module\.exports/.test(text),
    })
  }

  const files = store.allFiles()
  const info = readConfigInfo(root, files)
  const card = renderProjectCard({
    root, files, records, version: null, commands: info.commands, entrypoints: info.entrypoints,
    name: info.name, description: info.description, topLevel: topLevelLayout(files),
    conventions: info.conventions, budget: cardBudget,
  })
  const map = renderProjectMap(records, { budget: mapBudget, version: null })

  // Merkle: parent page version = hash(child file page versions + extractor version).
  const childHash = sha1(records.map((r) => `${r.rel}:${filePageVersion(r.rel, r.contentHash)}`).sort().join('\n') + `|${EXTRACTOR_VERSION}`)
  const cardVersion = sha1(`${EXTRACTOR_VERSION}|project.card|${childHash}|${card.text}`)
  const mapVersion = sha1(`${EXTRACTOR_VERSION}|project.map|${childHash}|${map.text}`)
  store.upsertPage({ id: 'project.card', kind: 'project.card', versionHash: cardVersion, text: card.text, producer: 'extract', meta: { files: files.length } })
  store.upsertPage({ id: 'project.map', kind: 'project.map', versionHash: mapVersion, text: map.text, producer: 'extract', meta: { files: files.length } })

  // Project version manifest = every page in the store (corpus pages + boards).
  // Board pages participate so agent-visible shared state changes are diffable.
  const manifest = {}
  for (const p of store.all('SELECT id, version_hash FROM pages ORDER BY id')) manifest[p.id] = p.version_hash
  const rootHash = sha1(Object.entries(manifest).map(([k, v]) => `${k}:${v}`).join('\n') + `|${EXTRACTOR_VERSION}`)
  const prevLatest = store.latestVersion()
  const versionHash = sha1(`project|${EXTRACTOR_VERSION}|${rootHash}`)
  const parent = prevLatest && prevLatest.root_hash !== rootHash ? prevLatest.version_hash : (prevLatest?.version_hash ?? null)
  const rec = store.recordVersion({ versionHash, rootHash, parentHash: parent, manifest, producer: 'extract' })
  store.setMeta('extractor_version', EXTRACTOR_VERSION)
  store.setMeta('root', root)
  store.setMeta('last_index_ms', Math.round(performance.now() - t0))
  store.setMeta('last_index_files', files.length)
  store.setMeta('corpus_bytes', files.reduce((a, f) => a + f.bytes, 0))
  store.setMeta('corpus_tokens', files.reduce((a, f) => a + (f.tokens || 0), 0))
  store.setMeta('last_version', versionHash)
  store.setMeta('map_tokens', map.tokens)
  store.setMeta('card_tokens', card.tokens)

  return {
    root, source: listed.source, files: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0),
    loc: files.reduce((a, f) => a + f.loc, 0), fullTokens: files.reduce((a, f) => a + (f.tokens || 0), 0),
    readFiles, reused, deleted, ignored: listed.ignored,
    card: { tokens: card.tokens, budget: cardBudget, truncated: card.truncated },
    map: { tokens: map.tokens, budget: mapBudget, truncated: map.truncated },
    version: versionHash, versionRecorded: rec.recorded, parent,
    elapsedMs: Math.round(performance.now() - t0),
  }
}
