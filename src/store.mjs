// SQLite page store for MemAi. Node 24 `node:sqlite` (FTS5 built in).
// WAL mode, synchronous=NORMAL, idempotent writes keyed by content hash.
//
// Tables
//   pages         current text per page id (kind: project.card | project.map | file:<path> | board:<topic>)
//   page_history  every page version text ever recorded (COW: old versions immutable)
//   page_files    page -> contributing files (Merkle children)
//   files         distilled corpus index: path, sha1, bytes, LOC, lang, mtime, page id
//   symbols       symbol -> page/path/line/signature (fault index)
//   imports       file -> imported specifier (dependency trace)
//   versions      project version manifests: {pageId: versionHash} (Merkle root + delta base)
//   messages      append-only agent board (topic, agent, kind, body, refs)
//   agents        per-agent presence + read cursor + pages it has seen
//   edits         copy-on-write deltas published against a page (merged later)
//   index_meta    key/value (extractor version, last index, root, etc.)
//
// Idempotency: pages upsert is a no-op when version_hash is unchanged; messages
// dedupe on (topic, agent, sha1(body)); index runs are no-ops when the corpus
// hash is unchanged.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { estTokens } from './tokens.mjs'

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex')
export { sha1 }

// Node prints an ExperimentalWarning for node:sqlite on every CLI invocation.
// That stderr noise costs nothing in tokens but wrecks clean JSON piping, so we
// filter only that exact warning before loading the module.
const origEmitWarning = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === 'string' ? warning : warning?.message ?? ''
  if (/SQLite is an experimental feature/i.test(msg)) return
  return origEmitWarning.call(process, warning, ...rest)
}
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  producer TEXT NOT NULL DEFAULT 'extract',
  meta TEXT
);
CREATE TABLE IF NOT EXISTS page_history (
  page_id TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  symbols TEXT,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, version_hash)
);
CREATE TABLE IF NOT EXISTS page_files (
  page_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mtime INTEGER,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (page_id, path)
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  loc INTEGER NOT NULL,
  lang TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  page_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  page_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  lname TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  signature TEXT NOT NULL,
  PRIMARY KEY (page_id, name, line)
);
CREATE INDEX IF NOT EXISTS symbols_lname ON symbols(lname);
CREATE TABLE IF NOT EXISTS imports (
  page_id TEXT NOT NULL,
  path TEXT NOT NULL,
  module TEXT NOT NULL,
  PRIMARY KEY (page_id, module)
);
CREATE TABLE IF NOT EXISTS versions (
  version_hash TEXT PRIMARY KEY,
  root_hash TEXT NOT NULL,
  parent_hash TEXT,
  created_at INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  producer TEXT NOT NULL DEFAULT 'extract'
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  refs TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_topic ON messages(topic, seq);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  role TEXT,
  status TEXT,
  last_seen INTEGER,
  read_seq INTEGER NOT NULL DEFAULT 0,
  page_versions TEXT
);
CREATE TABLE IF NOT EXISTS edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  body TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  merged_version TEXT
);
CREATE INDEX IF NOT EXISTS edits_page ON edits(page_id, merged_version);
CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(page_id UNINDEXED, kind UNINDEXED, body);
`

export class MemoryStore {
  constructor({ dbPath, root }) {
    this.root = root ? path.resolve(root) : null
    this.dbPath = dbPath ? path.resolve(dbPath) : null
    if (this.dbPath) fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
    this.db = new DatabaseSync(this.dbPath || ':memory:')
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
    this._stmts = new Map()
  }

  /** Prepared statement cache. */
  stmt(sql) {
    let s = this._stmts.get(sql)
    if (!s) { s = this.db.prepare(sql); this._stmts.set(sql, s) }
    return s
  }
  one(sql, ...p) { return this.stmt(sql).get(...p) }
  all(sql, ...p) { return this.stmt(sql).all(...p) }
  run(sql, ...p) { return this.stmt(sql).run(...p) }
  exec(sql) { this.db.exec(sql) }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const r = fn(); this.db.exec('COMMIT'); return r } catch (e) { try { this.db.exec('ROLLBACK') } catch {} throw e }
  }

  close() { try { this._stmts.clear(); this.db.close() } catch {} }

  dbBytes() {
    if (!this.dbPath) return 0
    let n = 0
    for (const suffix of ['', '-wal', '-shm']) { try { n += fs.statSync(this.dbPath + suffix).size } catch {} }
    return n
  }

  // ---------------------------------------------------------------- pages ---

  getPage(id) {
    const row = this.one('SELECT * FROM pages WHERE id = ?', id)
    return row ? { ...row, meta: row.meta ? JSON.parse(row.meta) : null } : null
  }
  hasPage(id) { return !!this.one('SELECT 1 AS x FROM pages WHERE id = ?', id) }
  listPages(kindLike = null) {
    const rows = kindLike
      ? this.all('SELECT id, kind, version_hash, tokens, bytes, updated_at, producer FROM pages WHERE kind LIKE ? ORDER BY id', kindLike)
      : this.all('SELECT id, kind, version_hash, tokens, bytes, updated_at, producer FROM pages ORDER BY id')
    return rows
  }
  pageCount() { return this.one('SELECT COUNT(*) AS n FROM pages').n }

  /** Upsert page text/version. No-op (changed=false) when identical content hash. */
  upsertPage({ id, kind, versionHash, text, producer = 'extract', meta = null, symbols = null, files = null }) {
    const tokens = estTokens(text)
    const existing = this.one('SELECT version_hash FROM pages WHERE id = ?', id)
    const changed = !existing || existing.version_hash !== versionHash
    if (changed) {
      this.run(
        `INSERT INTO pages(id, kind, version_hash, text, tokens, bytes, updated_at, producer, meta)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, version_hash=excluded.version_hash,
           text=excluded.text, tokens=excluded.tokens, bytes=excluded.bytes,
           updated_at=excluded.updated_at, producer=excluded.producer, meta=excluded.meta`,
        id, kind, versionHash, text, tokens, Buffer.byteLength(text), Date.now(), producer, meta ? JSON.stringify(meta) : null
      )
      this.run('DELETE FROM page_history WHERE page_id = ? AND version_hash = ?', id, versionHash)
      this.run('INSERT INTO page_history(page_id, version_hash, text, tokens, symbols, recorded_at) VALUES (?,?,?,?,?,?)',
        id, versionHash, text, tokens, symbols ? JSON.stringify(symbols) : null, Date.now())
      this.run('DELETE FROM fts WHERE page_id = ?', id)
      this.run('INSERT INTO fts(page_id, kind, body) VALUES (?,?,?)', id, kind, text)
    }
    if (files) {
      this.run('DELETE FROM page_files WHERE page_id = ?', id)
      const ins = this.stmt('INSERT INTO page_files(page_id, path, content_hash, mtime, bytes) VALUES (?,?,?,?,?)')
      for (const f of files) ins.run(id, f.path, f.contentHash, f.mtime ?? 0, f.bytes ?? 0)
    }
    return { changed, tokens, previousHash: existing?.version_hash ?? null }
  }

  getPageHistoryText(pageId, versionHash) {
    const row = this.one('SELECT text FROM page_history WHERE page_id = ? AND version_hash = ?', pageId, versionHash)
    return row?.text ?? null
  }
  getPageHistorySymbols(pageId, versionHash) {
    const row = this.one('SELECT symbols FROM page_history WHERE page_id = ? AND version_hash = ?', pageId, versionHash)
    return row?.symbols ? JSON.parse(row.symbols) : null
  }
  deletePage(id) {
    this.run('DELETE FROM pages WHERE id = ?', id)
    this.run('DELETE FROM page_files WHERE page_id = ?', id)
    this.run('DELETE FROM symbols WHERE page_id = ?', id)
    this.run('DELETE FROM imports WHERE page_id = ?', id)
    this.run('DELETE FROM fts WHERE page_id = ?', id)
  }

  // ---------------------------------------------------------------- files ---

  upsertFile({ path: p, contentHash, bytes, loc, lang, mtime, tokens = 0 }) {
    const pageId = `file:${p}`
    this.run(
      `INSERT INTO files(path, content_hash, bytes, loc, lang, mtime, tokens, page_id) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash, bytes=excluded.bytes,
         loc=excluded.loc, lang=excluded.lang, mtime=excluded.mtime, tokens=excluded.tokens, page_id=excluded.page_id`,
      p, contentHash, bytes, loc, lang, mtime, tokens, pageId
    )
    return pageId
  }
  getFile(p) { return this.one('SELECT * FROM files WHERE path = ?', p) }
  allFiles() { return this.all('SELECT * FROM files ORDER BY path') }
  fileCount() { return this.one('SELECT COUNT(*) AS n FROM files').n }
  corpusStats() {
    return this.one('SELECT COUNT(*) AS files, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(loc),0) AS loc, COALESCE(SUM(tokens),0) AS tokens FROM files')
  }
  deleteFile(p) {
    this.run('DELETE FROM files WHERE path = ?', p)
    this.run('DELETE FROM symbols WHERE page_id = ?', `file:${p}`)
    this.run('DELETE FROM imports WHERE page_id = ?', `file:${p}`)
    this.deletePage(`file:${p}`)
  }

  // -------------------------------------------------------------- symbols ---

  setSymbols(pageId, p, symbols) {
    this.run('DELETE FROM symbols WHERE page_id = ?', pageId)
    const ins = this.stmt('INSERT OR REPLACE INTO symbols(page_id, path, name, lname, kind, line, signature) VALUES (?,?,?,?,?,?,?)')
    for (const s of symbols) ins.run(pageId, p, s.name, s.name.toLowerCase(), s.kind, s.line, s.signature.slice(0, 200))
  }
  setImports(pageId, p, modules) {
    this.run('DELETE FROM imports WHERE page_id = ?', pageId)
    const ins = this.stmt('INSERT OR IGNORE INTO imports(page_id, path, module) VALUES (?,?,?)')
    for (const m of modules) ins.run(pageId, p, m)
  }
  /** Ranked symbol lookup: exact name, prefix, then substring. Non-test first. */
  symbolSearch(q, { limit = 8 } = {}) {
    const lq = q.toLowerCase()
    const rows = this.all(
      `SELECT name, kind, path, line, signature,
              CASE WHEN lname = ? THEN 0 WHEN lname LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END AS rank
       FROM symbols WHERE lname LIKE ? ESCAPE '\\' ORDER BY rank, length(path), path, line LIMIT 200`,
      lq, `${escapeLike(lq)}%`, `%${escapeLike(lq)}%`
    )
    const scored = rows.map((r) => ({
      ...r,
      score: (r.rank === 0 ? 4 : r.rank === 1 ? 3 : 1) + (/(^|\/)test|\.test\.|spec\./i.test(r.path) ? -1 : 0),
    })).sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path) || a.line - b.line)
    return scored.slice(0, limit)
  }
  symbolsForPage(pageId) { return this.all('SELECT * FROM symbols WHERE page_id = ? ORDER BY line', pageId) }
  importsForFile(p) { return this.all('SELECT module FROM imports WHERE page_id = ? ORDER BY module', `file:${p}`).map((r) => r.module) }

  // ----------------------------------------------------------- fts search ---

  /** Sanitised FTS5 query. Returns page hits with bm25 score and a snippet. */
  searchPages(q, { limit = 8 } = {}) {
    const terms = String(q).toLowerCase().split(/[^a-z0-9_$]+/i).filter((t) => t.length >= 2).slice(0, 8)
    if (!terms.length) return []
    const expr = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')
    let rows = []
    try {
      rows = this.all('SELECT page_id, kind, bm25(fts) AS score FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?', expr, limit * 3)
    } catch { rows = [] }
    const out = []
    for (const r of rows) {
      const page = this.one('SELECT text FROM pages WHERE id = ?', r.page_id)
      if (!page) continue
      const lines = page.text.split('\n')
      const hitLine = lines.find((l) => terms.some((t) => l.toLowerCase().includes(t))) ?? lines[0] ?? ''
      out.push({
        pageId: r.page_id,
        kind: r.kind,
        path: r.page_id.startsWith('file:') ? r.page_id.slice(5) : null,
        score: Number(r.score),
        snippet: hitLine.trim().slice(0, 140),
      })
      if (out.length >= limit) break
    }
    return out
  }

  // ------------------------------------------------------------- versions ---

  recordVersion({ versionHash, rootHash, parentHash = null, manifest, producer = 'extract' }) {
    const existing = this.one('SELECT version_hash FROM versions WHERE version_hash = ?', versionHash)
    if (existing) return { recorded: false, versionHash }
    this.run('INSERT INTO versions(version_hash, root_hash, parent_hash, created_at, manifest, page_count, producer) VALUES (?,?,?,?,?,?,?)',
      versionHash, rootHash, parentHash, Date.now(), JSON.stringify(manifest), Object.keys(manifest).length, producer)
    return { recorded: true, versionHash }
  }
  getVersion(versionHash) {
    const row = this.one('SELECT * FROM versions WHERE version_hash = ?', versionHash)
    if (!row) return null
    return { ...row, manifest: JSON.parse(row.manifest) }
  }
  latestVersion() { return this.one('SELECT * FROM versions ORDER BY created_at DESC, rowid DESC LIMIT 1') }
  versionList(n = 20) { return this.all('SELECT version_hash, root_hash, parent_hash, created_at, page_count, producer FROM versions ORDER BY created_at DESC, rowid DESC LIMIT ?', n) }

  // ------------------------------------------------------------- messages ---

  postMessage({ topic, agent, kind = 'note', body, refs = null }) {
    if (!body || !body.trim()) throw new Error('empty message')
    const hash = sha1(`${topic}\0${agent}\0${kind}\0${body}`)
    const existing = this.one('SELECT seq FROM messages WHERE hash = ?', hash)
    if (existing) return { seq: existing.seq, deduped: true }
    const r = this.run('INSERT INTO messages(hash, topic, agent, kind, body, refs, ts) VALUES (?,?,?,?,?,?,?)',
      hash, topic, agent, kind, body, refs ? JSON.stringify(refs) : null, Date.now())
    return { seq: Number(r.lastInsertRowid), deduped: false }
  }
  messagesSince(seq, { topic = null, limit = 40 } = {}) {
    const rows = topic
      ? this.all('SELECT seq, topic, agent, kind, body, refs, ts FROM messages WHERE seq > ? AND topic = ? ORDER BY seq LIMIT ?', seq, topic, limit)
      : this.all('SELECT seq, topic, agent, kind, body, refs, ts FROM messages WHERE seq > ? ORDER BY seq LIMIT ?', seq, limit)
    return rows
  }
  latestSeq() { return this.one('SELECT COALESCE(MAX(seq),0) AS n FROM messages').n }
  messageCount() { return this.one('SELECT COUNT(*) AS n FROM messages').n }

  // --------------------------------------------------------------- agents ---

  upsertAgent(id, { role = null, status = null, lastSeen = null, pageVersions = null } = {}) {
    this.run(
      `INSERT INTO agents(id, role, status, last_seen, read_seq, page_versions) VALUES (?,?,?,?,0,?)
       ON CONFLICT(id) DO UPDATE SET role=COALESCE(excluded.role, agents.role), status=COALESCE(excluded.status, agents.status),
         last_seen=COALESCE(excluded.last_seen, agents.last_seen), page_versions=COALESCE(excluded.page_versions, agents.page_versions)`,
      id, role, status, lastSeen, pageVersions ? JSON.stringify(pageVersions) : null
    )
  }
  setAgentStatus(id, status) {
    this.upsertAgent(id, { status, lastSeen: Date.now() })
    this.run('UPDATE agents SET status = ?, last_seen = ? WHERE id = ?', status, Date.now(), id)
  }
  getAgent(id) { return this.one('SELECT * FROM agents WHERE id = ?', id) }
  allAgents() { return this.all('SELECT * FROM agents ORDER BY last_seen DESC, id') }
  setReadCursor(id, seq) { this.run('UPDATE agents SET read_seq = MAX(read_seq, ?), last_seen = ? WHERE id = ?', seq, Date.now(), id) }

  // ---------------------------------------------------------------- edits ---

  addEdit({ pageId, agent, body }) {
    const hash = sha1(`${pageId}\0${agent}\0${body}`)
    const ex = this.one('SELECT id FROM edits WHERE page_id = ? AND hash = ?', pageId, hash)
    if (ex) return { id: ex.id, deduped: true }
    const r = this.run('INSERT INTO edits(page_id, agent, body, hash, created_at) VALUES (?,?,?,?,?)', pageId, agent, body, hash, Date.now())
    return { id: Number(r.lastInsertRowid), deduped: false }
  }
  pendingEdits(pageId) { return this.all('SELECT * FROM edits WHERE page_id = ? AND merged_version IS NULL ORDER BY id', pageId) }
  markEditsMerged(pageId, versionHash, ids) {
    const up = this.stmt('UPDATE edits SET merged_version = ? WHERE id = ?')
    for (const id of ids) up.run(versionHash, id)
  }
  editCount() { return this.one('SELECT COUNT(*) AS n FROM edits').n }

  // ---------------------------------------------------------------- meta ---

  setMeta(key, value) {
    this.run('INSERT INTO index_meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value))
  }
  getMeta(key) { return this.one('SELECT value FROM index_meta WHERE key = ?', key)?.value ?? null }
  allMeta() { const o = {}; for (const r of this.all('SELECT key, value FROM index_meta')) o[r.key] = r.value; return o }
  metaCount() { return this.one('SELECT COUNT(*) AS n FROM index_meta').n }
}

function escapeLike(s) { return s.replace(/[%_\\]/g, (m) => `\\${m}`) }
