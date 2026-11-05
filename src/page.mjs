// Page model + Merkle versioning + demand paging.
//
// A "page" is immutable content addressed by a hash:
//   file:<path>       version = sha1(extractorVersion | path | sha1(file bytes))
//   project.card/map  version = sha1(children + extractorVersion)
//   board:<topic>     version = sha1(prevVersion | merged edit hashes)
// The project version is the Merkle root over the per-page versions, stored as
// a manifest {pageId: versionHash} so a new session can ask "what changed since
// <hash>" and receive a tiny delta instead of re-reading anything.
//
// COW: `addEdit` publishes an agent delta against a page without touching it;
// `merge(pageId)` assembles pending edits into a new version (history keeps the
// old text). Readers always resolve the current version.
//
// Every response carries a token count and is clamped to a caller budget, so an
// agent can decide exactly how much context to buy.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { sha1 } from './store.mjs'
import { estTokens, clampText } from './tokens.mjs'
import { EXTRACTOR_VERSION, langOf, isTestPath } from './extract.mjs'

export const DEFAULTS = {
  card: 700, map: 3500, get: 1200, fault: 600, query: 400, diff: 600,
}
export const PAGE_KINDS = ['project.card', 'project.map', 'file:<path>', 'board:<topic>']

const fitWithHeader = (bodyText, budget, makeHeader) => {
  // Reserve header tokens by iterating: clamp body, build header, check total.
  let b = Math.max(0, budget)
  for (let i = 0; i < 4; i++) {
    const body = clampText(bodyText, b)
    const header = makeHeader(body)
    const text = header + '\n' + body.text
    const total = estTokens(text)
    if (total <= budget) return { text, tokens: total, truncated: body.truncated, omittedLines: body.omittedLines, header }
    b -= Math.max(1, total - budget)
    if (b < 0) b = 0
  }
  const body = clampText(bodyText, 0)
  const header = makeHeader(body)
  return { text: header, tokens: estTokens(header), truncated: true, omittedLines: body.omittedLines, header }
}

async function noop() {}

/** Normalise a user-supplied path: forward slashes, no leading ./ or drive root. */
export function normPath(p) {
  let s = String(p).replace(/\\/g, '/').trim()
  s = s.replace(/^\.\//, '')
  return s
}

export class MemoryPages {
  constructor({ store, root }) {
    this.store = store
    this.root = path.resolve(root)
  }

  // ------------------------------------------------------------- indexing ---

  index(opts = {}) {
    return import('./extract.mjs').then(({ indexCorpus }) => indexCorpus(this.store, { root: this.root, ...opts }))
  }

  // --------------------------------------------------------------- paging ---

  resolve(pageId, { budget = DEFAULTS.get } = {}) {
    const page = this.store.getPage(pageId)
    if (!page) return { ok: false, error: `no such page: ${pageId}`, pageId, tokens: 0 }
    const version = page.version_hash.slice(0, 8)
    const r = fitWithHeader(page.text, budget, (body) =>
      `# page ${page.id}@${version}  body=${body.tokens}/${budget}${body.truncated ? ' (truncated)' : ''}`)
    return {
      ok: true, pageId: page.id, kind: page.kind, version: page.version_hash,
      tokens: r.tokens, budget, truncated: r.truncated, text: r.text,
    }
  }

  card(opts = {}) { return this.resolve('project.card', { budget: opts.budget ?? DEFAULTS.card, ...opts }) }
  map(opts = {}) { return this.resolve('project.map', { budget: opts.budget ?? DEFAULTS.map, ...opts }) }
  get(pageId, opts = {}) { return this.resolve(pageId, { budget: opts.budget ?? DEFAULTS.get }) }

  // ---------------------------------------------------------------- delta ---

  /**
   * Tiny textual delta between the current project version and `since`.
   * Returns changed/added/removed pages with per-file symbol churn, never bodies.
   */
  diff({ since = null, budget = DEFAULTS.diff } = {}) {
    const latest = this.store.latestVersion()
    if (!latest) return { ok: false, error: 'no versions recorded; run index first', tokens: 0 }
    const cur = this.store.getVersion(latest.version_hash)
    if (!since) {
      const text = `# no --since given; current version ${cur.version_hash.slice(0, 12)} (${cur.page_count} pages)\n# usage: diff --since <version>` 
      const t = estTokens(text)
      return { ok: true, from: null, to: cur.version_hash, tokens: t, text, added: [], changed: [], removed: [], aggregate: [] }
    }
    const old = this.store.getVersion(since)
    if (!old) {
      const candidates = this.store.versionList(5).map((v) => v.version_hash.slice(0, 12)).join(', ')
      return { ok: false, error: `unknown version ${since}; recent: ${candidates}`, tokens: 0 }
    }
    const curM = cur.manifest
    const oldM = old.manifest
    const isAggregate = (id) => id === 'project.card' || id === 'project.map'
    const added = []
    const removed = []
    const changed = []
    const aggregate = []
    for (const [id, hash] of Object.entries(curM)) {
      if (isAggregate(id)) { if (oldM[id] !== hash) aggregate.push(id); continue }
      if (!(id in oldM)) { added.push({ pageId: id, version: hash }); continue }
      if (oldM[id] !== hash) {
        const entry = { pageId: id, version: hash, tokens: this.store.getPage(id)?.tokens ?? 0 }
        if (id.startsWith('file:')) {
          const oldSym = this.store.getPageHistorySymbols(id, oldM[id]) || []
          const newSym = this.store.symbolsForPage(id).map((s) => ({ name: s.name, kind: s.kind }))
          const oldNames = new Set(oldSym.map((s) => s.name))
          const newNames = new Set(newSym.map((s) => s.name))
          entry.symbolsAdded = [...newNames].filter((n) => !oldNames.has(n)).slice(0, 6)
          entry.symbolsRemoved = [...oldNames].filter((n) => !newNames.has(n)).slice(0, 6)
        }
        changed.push(entry)
      }
    }
    for (const id of Object.keys(oldM)) {
      if (isAggregate(id)) continue
      if (!(id in curM)) removed.push({ pageId: id })
    }
    const byPath = (e) => e.pageId.replace(/^file:/, '')
    changed.sort((a, b) => byPath(a).localeCompare(byPath(b)))
    added.sort((a, b) => byPath(a).localeCompare(byPath(b)))
    removed.sort((a, b) => byPath(a).localeCompare(byPath(b)))
    const lines = []
    lines.push(`# delta ${cur.version_hash.slice(0, 8)} since ${old.version_hash.slice(0, 8)}  (+${added.length} added, ~${changed.length} changed, -${removed.length} removed)`)
    if (aggregate.length) lines.push(`aggregate: ${aggregate.join(', ')} rebuilt (do not re-read; the map is the delta)`) 
    for (const e of added) lines.push(`+ ${byPath(e)}`)
    for (const e of removed) lines.push(`- ${byPath(e)}`)
    for (const e of changed) {
      const bits = [`~ ${byPath(e)}`, `${e.tokens}tok`]
      if (e.symbolsAdded?.length) bits.push(`+sym:${e.symbolsAdded.join(',')}`)
      if (e.symbolsRemoved?.length) bits.push(`-sym:${e.symbolsRemoved.join(',')}`)
      lines.push(bits.join('  '))
    }
    if (!added.length && !changed.length && !removed.length) lines.push('(no changes)')
    lines.push('# next: get file:<path> for signatures | fault <symbol> for a body slice')
    const r = clampText(lines.join('\n'), budget)
    return {
      ok: true, from: old.version_hash, to: cur.version_hash,
      added: added.map(byPath), changed: changed.map((e) => ({ path: byPath(e), tokens: e.tokens, symbolsAdded: e.symbolsAdded || [], symbolsRemoved: e.symbolsRemoved || [] })),
      removed: removed.map(byPath), aggregate, tokens: r.tokens, truncated: r.truncated, text: r.text, budget,
    }
  }

  // ---------------------------------------------------------------- fault ---

  /** Demand-page one slice: symbol name, path#symbol, path:line, or path page. */
  fault(target, { budget = DEFAULTS.fault } = {}) {
    target = normPath(target)
    if (!target) return { ok: false, error: 'empty fault target', tokens: 0 }
    if (target.startsWith('file:')) target = target.slice(5)
    let m
    if ((m = /^(.*)#([\w$.-]+)$/.exec(target))) return this._faultSymbol(m[2], m[1], { budget })
    if ((m = /^(.*):(\d+)$/.exec(target))) return this._faultLine(m[1], Number(m[2]), { budget })
    const asFile = this._findFile(target)
    if (asFile) {
      const r = this.resolve(`file:${asFile.path}`, { budget })
      return { ...r, target, mode: 'file-page' }
    }
    return this._faultSymbol(target, null, { budget })
  }

  _findFile(p) {
    const exact = this.store.getFile(p)
    if (exact) return exact
    const rows = this.store.all('SELECT * FROM files WHERE path LIKE ? ESCAPE \'\\\' ORDER BY length(path) LIMIT 5', `%${p.replace(/[%_\\]/g, (c) => `\\${c}`)}`)
    return rows.length === 1 ? rows[0] : null
  }

  _faultSymbol(name, wantedPath, { budget }) {
    let candidates
    if (wantedPath) {
      const f = this._findFile(wantedPath)
      if (!f) return { ok: false, error: `no such file: ${wantedPath}`, tokens: 0 }
      candidates = this.store.symbolsForPage(f.page_id).filter((s) => s.lname === name.toLowerCase() || s.name === name)
      if (!candidates.length) {
        return { ok: false, error: `symbol ${name} not found in ${f.path}; try query ${name}`, tokens: 0, candidates: this.store.symbolSearch(name, { limit: 3 }) }
      }
    } else {
      candidates = this.store.symbolSearch(name, { limit: 8 })
      if (!candidates.length) return { ok: false, error: `symbol not found: ${name}`, tokens: 0 }
    }
    const best = candidates[0]
    const pageId = `file:${best.path}`
    let text
    try { text = fs.readFileSync(path.join(this.root, best.path), 'utf8') } catch { return { ok: false, error: `file vanished from disk: ${best.path} — re-index`, tokens: 0 } }
    const lines = text.split('\n')
    const startLine = best.line
    const sl = sliceSymbol(lines, startLine, langOf(best.path) || 'js')
    const code = lines.slice(sl.start, sl.end).join('\n')
    const header = (body) =>
      `# fault ${best.name} (${best.kind}) ${best.path}:${startLine}  ${sl.end - sl.start}L  tokens=${body.tokens}/${budget}` +
      (candidates.length > 1 ? `  (+${candidates.length - 1} other match${candidates.length > 2 ? 'es' : ''}: ${candidates.slice(1, 3).map((c) => `${c.path}:${c.line}`).join(', ')})` : '') +
      `\n# file page: get file:${best.path}`
    const r = fitWithHeader(code, budget, header)
    return {
      ok: true, target: name, mode: 'symbol', symbol: best.name, kind: best.kind, path: best.path, line: startLine,
      lines: sl.end - sl.start, tokens: r.tokens, budget, truncated: r.truncated, text: r.text,
      also: candidates.slice(1, 4).map((c) => `${c.path}:${c.line}`),
    }
  }

  _faultLine(p, line, { budget }) {
    const f = this._findFile(p)
    if (!f) return { ok: false, error: `no such file: ${p}`, tokens: 0 }
    let text
    try { text = fs.readFileSync(path.join(this.root, f.path), 'utf8') } catch { return { ok: false, error: `file vanished: ${f.path}`, tokens: 0 } }
    const lines = text.split('\n')
    const from = Math.max(0, line - 1)
    const to = Math.min(lines.length, from + 60)
    const code = lines.slice(from, to).map((l, i) => `${from + i + 1}| ${l}`).join('\n')
    const r = fitWithHeader(code, budget, (body) => `# fault ${f.path}:${line}  showing ${from + 1}-${to} of ${lines.length}  tokens=${body.tokens}/${budget}`)
    return { ok: true, target: `${p}:${line}`, mode: 'line', path: f.path, line, tokens: r.tokens, budget, truncated: r.truncated, text: r.text }
  }

  // ---------------------------------------------------------------- query ---

  /** Ranked, compact hits: symbol rows first, then page-text FTS hits. */
  query(q, { k = 5, budget = DEFAULTS.query, kind = null } = {}) {
    const ident = /^[A-Za-z_$][\w$.:-]*$/.test(q.trim())
    const hits = []
    const seen = new Set()
    const push = (h) => {
      const key = h.pageId + '|' + (h.symbol || '')
      if (seen.has(key)) return
      seen.add(key)
      hits.push(h)
    }
    for (const s of this.store.symbolSearch(q, { limit: k })) {
      push({ pageId: `file:${s.path}`, kind: 'symbol', path: s.path, symbol: s.name, symbolKind: s.kind, line: s.line, snippet: s.signature, score: s.score })
    }
    for (const p of this.store.searchPages(q, { limit: k * 2 })) {
      if (kind && !p.pageId.startsWith(kind)) continue
      if (p.pageId.startsWith('file:')) {
        push({ pageId: p.pageId, kind: 'page', path: p.path, symbol: null, line: null, snippet: p.snippet, score: 1 })
      }
    }
    const top = hits.slice(0, k)
    const lines = [`# query "${q}" — ${top.length} hit${top.length === 1 ? '' : 's'} (use fault <symbol> or get <pageId>)`]
    for (const h of top) {
      lines.push(`${h.symbol ? 'sym' : 'page'} ${h.pageId}${h.line ? `:${h.line}` : ''}  ${h.symbol ? `${h.symbolKind} ${h.symbol}: ` : ''}${(h.snippet || '').slice(0, 120)}`)
    }
    if (!top.length) lines.push('(no hits — try a broader term or `map`)')
    const r = clampText(lines.join('\n'), budget)
    return { ok: true, query: q, hits: top, count: top.length, tokens: r.tokens, budget, truncated: r.truncated, text: r.text }
  }

  // ---------------------------------------------------------------- merge ---

  /**
   * Copy-on-write merge for shared board pages.
   * Corpus pages (project.card/map, file:*) are immutable: re-index owns them.
   * Agents publish to `board:<topic>` pages; merge rebuilds the board page from
   * the append-only message log + any pending edits, producing a new version.
   */
  merge(pageId, { agent = 'anon', budget = 900 } = {}) {
    if (!pageId.startsWith('board:')) {
      return {
        ok: false, pageId, tokens: 0,
        error: 'only board:<topic> pages are mergeable; corpus pages are immutable (note/post -> merge board:<topic>)',
      }
    }
    const topic = pageId.slice('board:'.length)
    const messages = this.store.all('SELECT seq, hash, agent, kind, body FROM messages WHERE topic = ? ORDER BY seq DESC LIMIT 200', topic).reverse()
    const edits = this.store.pendingEdits(pageId)
    if (!messages.length && !edits.length) {
      return { ok: false, pageId, tokens: 0, error: `nothing on topic ${topic}; post <topic> <body> first` }
    }
    const lines = [`# board:${topic}  ${messages.length} messages${edits.length ? ` + ${edits.length} pending edits` : ''}`]
    for (const m of messages) lines.push(`[${m.seq}] <${m.agent}> ${m.kind}: ${m.body.replace(/\s+/g, ' ').slice(0, 300)}`)
    for (const e of edits) lines.push(`+ <${e.agent}> edit: ${e.body.replace(/\s+/g, ' ').slice(0, 300)}`)
    lines.push(`# publish: note ${topic} <body> [--agent A] then merge ${pageId}`)
    const bodyText = lines.join('\n')
    const versionHash = sha1(`${EXTRACTOR_VERSION}|board|${topic}|${messages.map((m) => m.hash).join(',')}|${edits.map((e) => e.hash).join(',')}`)
    const prev = this.store.getPage(pageId)
    this.store.upsertPage({ id: pageId, kind: `board:${topic}`, versionHash, text: bodyText, producer: `merge:${agent}` })
    this.store.markEditsMerged(pageId, versionHash, edits.map((e) => e.id))
    this._recordVersion('merge')
    const r = this.resolve(pageId, { budget })
    return {
      ok: true, pageId, topic, messages: messages.length, editsMerged: edits.length,
      version: versionHash, changed: prev?.version_hash !== versionHash,
      tokens: r.tokens, text: r.text,
    }
  }

  addEdit(pageId, body, { agent = 'anon' } = {}) {
    if (!this.store.hasPage(pageId)) return { ok: false, error: `no such page: ${pageId}`, tokens: 0 }
    if (!body?.trim()) return { ok: false, error: 'empty edit', tokens: 0 }
    const r = this.store.addEdit({ pageId, agent, body })
    return { ok: true, id: r.id, deduped: r.deduped, tokens: estTokens(body), text: `edit queued for ${pageId}; merge <pageId> to publish` }
  }

  /** Record a project version for the current page set (used by merge). */
  _recordVersion(producer) {
    const manifest = {}
    for (const p of this.store.all('SELECT id, version_hash FROM pages ORDER BY id')) manifest[p.id] = p.version_hash
    const rootHash = sha1(Object.entries(manifest).map(([k, v]) => `${k}:${v}`).join('\n') + `|${EXTRACTOR_VERSION}`)
    const prev = this.store.latestVersion()
    const versionHash = sha1(`project|${producer}|${rootHash}|${prev?.version_hash ?? ''}`)
    this.store.recordVersion({ versionHash, rootHash, parentHash: prev?.version_hash ?? null, manifest, producer })
    this.store.setMeta('last_version', versionHash)
    return versionHash
  }

  // ----------------------------------------------------------------- board ---

  post(topic, body, { agent = 'anon', kind = 'note', refs = null } = {}) {
    const r = this.store.postMessage({ topic: topic || 'board', agent, kind, body, refs })
    this.store.upsertAgent(agent, { role: null, status: null, lastSeen: Date.now() })
    return { ok: true, seq: r.seq, deduped: r.deduped, tokens: estTokens(body) }
  }

  note(topic, body, opts = {}) { return this.post(topic, body, { ...opts, kind: 'note' }) }

  inbox(agent, { since = null, topic = null, budget = 900, advance = true } = {}) {
    const a = this.store.getAgent(agent)
    const from = since ?? a?.read_seq ?? 0
    const rows = this.store.messagesSince(from, { topic, limit: 40 })
    const lines = [`# inbox ${agent}  since seq ${from}  ${rows.length} msg`]
    for (const m of rows) lines.push(`[${m.seq}] ${m.topic} <${m.agent}> ${m.kind}: ${m.body.replace(/\s+/g, ' ').slice(0, 220)}`)
    if (!rows.length) lines.push('(empty — post <topic> <body> to broadcast)')
    const r = clampText(lines.join('\n'), budget)
    const last = rows.length ? rows[rows.length - 1].seq : from
    if (advance && rows.length) this.store.setReadCursor(agent, last)
    return {
      ok: true, agent, from, to: last, messages: rows.map((m) => ({ seq: m.seq, topic: m.topic, agent: m.agent, kind: m.kind, body: m.body })),
      tokens: r.tokens, text: r.text, budget, truncated: r.truncated,
    }
  }

  agents() {
    const rows = this.store.allAgents()
    const lines = [`# agents (${rows.length})`]
    for (const a of rows) {
      const seen = a.page_versions ? (() => { try { return Object.keys(JSON.parse(a.page_versions)).length } catch { return 0 } })() : 0
      lines.push(`${a.id}  ${a.status ?? '-'}  role=${a.role ?? '-'}  read_seq=${a.read_seq}  seen_pages=${seen}  last=${a.last_seen ? new Date(a.last_seen).toISOString().slice(0, 19) : '-'}`)
    }
    if (!rows.length) lines.push('(none — register with `mem note <topic> <body> --agent <id>`)')
    const text = lines.join('\n')
    return { ok: true, agents: rows, tokens: estTokens(text), text }
  }

  // ---------------------------------------------------------------- status ---

  status() {
    const s = this.store.corpusStats()
    const meta = this.store.allMeta()
    const pages = this.store.pageCount()
    const kinds = {}
    for (const p of this.store.listPages()) kinds[p.kind.split(':')[0]] = (kinds[p.kind.split(':')[0]] || 0) + 1
    const latest = this.store.latestVersion()
    const text = [
      '# MemAi status',
      `root: ${this.root}`,
      `db: ${this.store.dbPath ?? ':memory:'} (${(this.store.dbBytes() / 1024).toFixed(1)}KB)`,
      `corpus: ${s.files} files, ${(s.bytes / 1024).toFixed(1)}KB, ${s.loc} LOC, ~${s.tokens} tokens if read fully`,
      `pages: ${pages} (${Object.entries(kinds).map(([k, n]) => `${k}:${n}`).join(' ')})`,
      `versions: ${this.store.one('SELECT COUNT(*) AS n FROM versions').n}  latest=${latest?.version_hash?.slice(0, 12) ?? '-'}`,
      `card=${meta.card_tokens ?? '?'}tok  map=${meta.map_tokens ?? '?'}tok  index=${meta.last_index_ms ?? '?'}ms`,
      `board: ${this.store.messageCount()} messages, ${this.store.editCount()} unmerged edits, ${this.store.allAgents().length} agents`,
      `extractor: ${meta.extractor_version ?? '-'}  indexed_files: ${meta.last_index_files ?? '-'}  last_index: ${meta.last_index_ms ?? '-'}ms`,
    ].join('\n')
    return {
      ok: true, root: this.root, db: this.store.dbPath, dbBytes: this.store.dbBytes(),
      corpus: { files: s.files, bytes: s.bytes, loc: s.loc, tokens: s.tokens },
      pages, kinds, version: latest?.version_hash ?? null, versions: this.store.one('SELECT COUNT(*) AS n FROM versions').n,
      messages: this.store.messageCount(), edits: this.store.editCount(), agents: this.store.allAgents().length,
      tokens: estTokens(text), text,
    }
  }
}

// ---------------------------------------------------------------------------
// Code slicing
// ---------------------------------------------------------------------------

/** Find the end line (exclusive) of the block starting at `startLine` (1-based). */
export function sliceSymbol(lines, startLine, lang, { maxLines = 220 } = {}) {
  const start = Math.max(0, Math.min(lines.length - 1, startLine - 1))
  const first = lines[start] ?? ''
  const indent = first.match(/^\s*/)[0].length
  const closedLangs = new Set(['py', 'yaml', 'toml', 'md', 'sh'])
  if (closedLangs.has(lang)) {
    let end = start + 1
    for (let i = start + 1; i < lines.length && i - start < maxLines; i++) {
      const l = lines[i]
      if (!l.trim()) { end = i + 1; continue }
      const ind = l.match(/^\s*/)[0].length
      if (ind <= indent) break
      end = i + 1
    }
    return { start, end }
  }
  // Brace language: track { } outside strings/comments.
  let depth = 0
  let started = false
  const st = { blockComment: false }
  for (let i = start; i < lines.length && i - start < maxLines; i++) {
    const r = scanBraces(lines[i], st)
    if (!started) {
      if (!r.hasBrace) {
        // No brace: declaration/assignment, optionally continued across lines.
        if (i === start && /[=(,]\s*$/.test(lines[i])) { started = true; depth = 0; continue }
        return { start, end: i + 1 }
      }
      depth += r.opens - r.closes
      started = true
      if (depth <= 0) return { start, end: i + 1 }
    } else {
      depth += r.opens - r.closes
      if (depth <= 0) return { start, end: i + 1 }
    }
  }
  return { start, end: Math.min(lines.length, start + maxLines) }
}

function scanBraces(line, st) {
  let opens = 0, closes = 0, hasBrace = false
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    const n = line[i + 1]
    if (st.blockComment) { if (c === '*' && n === '/') { st.blockComment = false; i++ } continue }
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '/' && n === '/') break
    if (c === '/' && n === '*') { st.blockComment = true; i++; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') { opens++; hasBrace = true }
    else if (c === '}') { closes++; hasBrace = true }
  }
  return { opens, closes, hasBrace }
}
