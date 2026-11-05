// Deterministic 200-file fixture: "atlas-api", a synthetic but structurally
// realistic multi-resource service (routes -> services -> models -> tests).
//
// Why a fixture at all: the benchmark must also cover a corpus large enough to
// page (>200 files) with a *known* task->file ground truth, and it must be
// mutable (for delta-resume scenarios) without touching the machine's real code.
// The benchmark additionally runs on real corpora (npm CLI, this repo's own
// source, the bundled usage-meter DSH plugin).
//
// Generated deterministically from a seeded PRNG: same output on every machine.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
export const FIXTURE_DIR = path.resolve(HERE, 'fixtures', 'atlas')

export const RESOURCES = [
  ['auth', 'Auth', ['loginWithPassword', 'rotateSession', 'hashPassword', 'verifySession', 'requireScope']],
  ['billing', 'Billing', ['applyCredits', 'serializeInvoice', 'computeProration', 'chargeCard', 'refundCharge']],
  ['widgets', 'Widget', ['listWidgets', 'createWidget', 'updateWidget', 'deleteWidget', 'reorderWidgets']],
  ['invoices', 'Invoice', ['listInvoices', 'createInvoice', 'voidInvoice', 'serializeInvoice', 'reconcileInvoice']],
  ['users', 'User', ['listUsers', 'createUser', 'updateUser', 'deactivateUser', 'findByEmail']],
  ['teams', 'Team', ['listTeams', 'createTeam', 'addMember', 'removeMember', 'listMembers']],
  ['projects', 'Project', ['listProjects', 'createProject', 'archiveProject', 'cloneProject', 'listProjectFiles']],
  ['sessions', 'Session', ['listSessions', 'createSession', 'refreshSession', 'revokeSession', 'verifySession']],
  ['tokens', 'Token', ['listTokens', 'issueToken', 'revokeToken', 'verifyToken', 'rotateToken']],
  ['notifications', 'Notification', ['listNotifications', 'enqueueNotification', 'markRead', 'drainQueue', 'previewDigest']],
  ['search', 'Search', ['searchAll', 'searchDocuments', 'reindexDocument', 'suggestTerms', 'rankResults']],
  ['reports', 'Report', ['listReports', 'createReport', 'renderReport', 'scheduleReport', 'exportCsv']],
  ['uploads', 'Upload', ['listUploads', 'beginUpload', 'completeUpload', 'deleteUpload', 'signUploadUrl']],
  ['webhooks', 'Webhook', ['listWebhooks', 'registerWebhook', 'deliverWebhook', 'retryDelivery', 'verifySignature']],
  ['comments', 'Comment', ['listComments', 'createComment', 'editComment', 'deleteComment', 'threadComments']],
  ['tags', 'Tag', ['listTags', 'createTag', 'renameTag', 'mergeTags', 'tagCounts']],
  ['folders', 'Folder', ['listFolders', 'createFolder', 'moveFolder', 'deleteFolder', 'folderTree']],
  ['events', 'Event', ['listEvents', 'appendEvent', 'replayEvents', 'snapshotEvents', 'pruneEvents']],
  ['metrics', 'Metric', ['listMetrics', 'recordMetric', 'aggregateMetrics', 'resetMetrics', 'exportMetrics']],
  ['audit', 'Audit', ['listAuditTrail', 'appendAuditEntry', 'verifyChain', 'exportAuditTrail', 'retentionPolicy']],
  ['jobs', 'Job', ['listJobs', 'enqueueJob', 'cancelJob', 'retryJob', 'jobStatus']],
  ['flags', 'Flag', ['listFlags', 'setFlag', 'evaluateFlag', 'rolloutFlag', 'flagOverrides']],
  ['tenants', 'Tenant', ['listTenants', 'createTenant', 'suspendTenant', 'tenantConfig', 'tenantUsage']],
  ['api-keys', 'ApiKey', ['listApiKeys', 'createApiKey', 'revokeApiKey', 'rotateApiKey', 'verifyApiKey']],
]

const MIDDLEWARE = ['authMiddleware', 'loggingMiddleware', 'errorMiddleware', 'rateLimitMiddleware', 'corsMiddleware',
  'requestIdMiddleware', 'cacheMiddleware', 'metricsMiddleware', 'validationMiddleware', 'tenantMiddleware']
const UTILS = ['jwt', 'cache', 'serialize', 'validate', 'dates', 'ids', 'logger', 'retry', 'paginate', 'crypto',
  'slugify', 'parse', 'env', 'clamp', 'debounce', 'format', 'hash', 'queue']

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const w = (rel, content, { nl = '\n' } = {}) => ({ rel, content: content.replace(/\n/g, nl) })

function serviceFile(slug, pascal, methods, rnd) {
  const table = slug.replace(/-/g, '_')
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
  const methodsText = methods.map((m) => `
  /**
   * ${m} — ${slug} service operation. Validates input, talks to the store, and
   * returns a plain JSON-safe record (never leaks internal fields).
   */
  async ${m}(input = {}) {
    const payload = validate${pascal}Input(input, '${m}')
    const rows = await db.select(TABLE, { filter: pickFilter(payload), limit: payload.limit ?? 50 })
    const records = rows.map((row) => serialize${pascal}(row))
    logger.debug('${slug}.${m}', { count: records.length, keys: Object.keys(payload) })
    if (!records.length) return { ok: true, items: [], count: 0 }
    return { ok: true, items: records, count: records.length, page: nextPage(payload) }
  }`).join('\n')
  const extra = slug === 'billing' ? `
export function serializeInvoice(invoice) {
  if (!invoice) throw new AppError('invoice_missing', 404)
  return {
    id: invoice.id,
    customerId: invoice.customerId,
    currency: invoice.currency ?? 'usd',
    totalCents: invoice.lineItems.reduce((sum, item) => sum + item.amountCents * item.quantity, 0),
    lines: invoice.lineItems.map((item) => ({ sku: item.sku, qty: item.quantity, amount: item.amountCents })),
    issuedAt: invoice.issuedAt,
    status: invoice.status ?? 'draft',
  }
}

export async function applyCredits(customerId, credits) {
  if (!Number.isInteger(credits) || credits <= 0) throw new AppError('bad_credit_amount', 400)
  const account = await db.selectOne(TABLE, { customerId })
  if (!account) throw new AppError('account_not_found', 404)
  const next = { ...account, balanceCents: Math.max(0, account.balanceCents - credits) }
  await db.update(TABLE, account.id, next)
  return { customerId, appliedCredits: credits, balanceCents: next.balanceCents }
}
` : ''
  const authExtra = slug === 'auth' ? `
export async function verifyToken(token) {
  const claims = jwt.verify(token, config.TOKEN_SECRET, { algorithms: ['HS256'] })
  if (!claims.sub) throw new AppError('token_missing_subject', 401)
  if (claims.exp && claims.exp * 1000 < Date.now()) throw new AppError('token_expired', 401)
  return { userId: claims.sub, scopes: claims.scopes ?? [], tenantId: claims.tenantId ?? null }
}

export async function loginWithPassword(email, password) {
  const user = await db.selectOne('users', { email })
  if (!user || !passwordMatches(password, user.passwordHash)) throw new AppError('invalid_credentials', 401)
  return { token: signUserToken(user), refreshToken: signRefreshToken(user) }
}
` : ''
  return `import { db } from '../db.js'
import { AppError } from '../errors.js'
import { logger } from '../utils/logger.js'
import { nextPage, pickFilter } from '../utils/paginate.js'
import { serialize${pascal}, validate${pascal}Input } from '../models/${slug}.model.js'
${slug === 'auth' ? `import { jwt, signUserToken, signRefreshToken, passwordMatches } from '../utils/jwt.js'\nimport { config } from '../config/index.js'\n` : ''}${slug === 'billing' ? `import { money } from '../utils/format.js'\n` : ''}
const TABLE = '${table}'

export class ${pascal}Service {
${methodsText}
}

export function serialize${pascal}Row(row) {
  return row === null || row === undefined ? null : { ...row, _type: '${slug}' }
}

export function validate${pascal}Input(input, operation) {
  if (input === null || typeof input !== 'object') throw new AppError(\`\${operation}_input_not_object\`, 400)
  if (input.id !== undefined && typeof input.id !== 'string') throw new AppError(\`\${operation}_bad_id\`, 400)
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)) {
    throw new AppError(\`\${operation}_bad_limit\`, 400)
  }
  return {
    id: input.id ?? null,
    limit: input.limit ?? 50,
    offset: input.offset ?? 0,
    filter: input.filter ?? {},
    include: Array.isArray(input.include) ? input.include.filter((f) => typeof f === 'string') : [],
    operation,
  }
}
${extra}${authExtra}
export const ${slug.replace(/-/g, '_')}Service = new ${pascal}Service()
`
}

function modelFile(slug, pascal, rnd) {
  const fields = ['id', 'tenantId', 'createdAt', 'updatedAt', 'status', 'ownerId', 'metadata']
  const fieldLines = fields.map((f) => `  ${f}: ${f === 'status' ? "'active'" : f === 'metadata' ? '{}' : 'null'},`).join('\n')
  return `import { AppError } from '../errors.js'

/** Canonical ${slug} model. The service layer serializes through this class. */
export class ${pascal} {
  constructor(props = {}) {
    this.id = props.id ?? null
    this.tenantId = props.tenantId ?? null
    this.createdAt = props.createdAt ?? new Date().toISOString()
    this.updatedAt = props.updatedAt ?? this.createdAt
    this.status = props.status ?? 'active'
    this.ownerId = props.ownerId ?? null
    this.metadata = props.metadata ?? {}
  }

  static get fields() { return ${JSON.stringify(fields)} }

  static fromRow(row) {
    if (!row) return null
    return new ${pascal}({
      id: row.id,
      tenantId: row.tenant_id ?? row.tenantId,
      createdAt: row.created_at ?? row.createdAt,
      updatedAt: row.updated_at ?? row.updatedAt,
      status: row.status,
      ownerId: row.owner_id ?? row.ownerId,
      metadata: row.metadata ?? {},
    })
  }

  toJSON() {
    return {
      id: this.id, tenantId: this.tenantId, createdAt: this.createdAt, updatedAt: this.updatedAt,
      status: this.status, ownerId: this.ownerId, metadata: this.metadata,
    }
  }

  validate() {
    if (!this.id) throw new AppError('${slug}_missing_id', 400)
    if (!['active', 'suspended', 'archived'].includes(this.status)) throw new AppError('${slug}_bad_status', 400)
    return true
  }
}

export const ${pascal.toUpperCase()}_FIELDS = ${JSON.stringify(fields)}
export const ${pascal.toUpperCase()}_DEFAULTS = {
${fieldLines}
}
`
}

function routeFile(slug, pascal, rnd, { prefix = '/api/v1' } = {}) {
  const base = `${prefix}/${slug}`
  const verbs = [
    ['get', `'${base}'`, 'list'],
    ['post', `'${base}'`, 'create'],
    ['get', `'${base}/:id'`, 'get'],
    ['patch', `'${base}/:id'`, 'update'],
    ['delete', `'${base}/:id'`, 'remove'],
  ]
  const handlers = verbs.map(([verb, p, op]) => `router.${verb}(${p}, authMiddleware, validate${pascal}Handlers.${op}, async (req, res, next) => {
  try {
    const result = await ${slug.replace(/-/g, '_')}Service.${op}({ ...req.query, ...req.body, id: req.params?.id })
    res.json({ ok: true, data: result })
  } catch (err) {
    next(err)
  }
})`).join('\n\n')
  return `import { Router } from '../app.js'
import { authMiddleware, tenantMiddleware } from '../middleware/authMiddleware.js'
import { rateLimitMiddleware } from '../middleware/rateLimitMiddleware.js'
import { ${slug.replace(/-/g, '_')}Service } from '../services/${slug}.service.js'
import { validate${pascal}Handlers } from '../middleware/validationMiddleware.js'

const router = new Router()
router.use(rateLimitMiddleware)

${handlers}

export default router
`
}

function testFile(slug, pascal) {
  return `import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ${pascal}Service } from '../src/services/${slug}.service.js'
import { ${pascal} } from '../src/models/${slug}.model.js'

describe('${slug} service', () => {
  let service
  beforeEach(() => {
    service = new ${pascal}Service()
  })

  it('lists ${slug} with a bounded page', async () => {
    const result = await service.list({ limit: 10, offset: 0 })
    assert.equal(result.ok, true)
    assert.ok(Array.isArray(result.items))
    assert.ok(result.items.length <= 10)
  })

  it('rejects a non-object payload', async () => {
    await assert.rejects(() => service.create(null), /input_not_object/)
  })

  it('serializes a ${pascal} record without leaking internals', () => {
    const model = ${pascal}.fromRow({ id: '${slug}_1', status: 'active' })
    const json = model.toJSON()
    assert.equal(json.id, '${slug}_1')
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'internal'), false)
  })

  it('round-trips a ${pascal} through fromRow/toJSON', () => {
    const model = new ${pascal}({ id: '${slug}_2', metadata: { region: 'eu' } })
    assert.equal(model.validate(), true)
    assert.equal(model.toJSON().metadata.region, 'eu')
  })
})
`
}

function docFile(slug, pascal) {
  return `# ${pascal} API

The \`${slug}\` resource is exposed at \`/api/v1/${slug}\` and backed by
\`src/services/${slug}.service.js\`, \`src/models/${slug}.model.js\`, and the
route table in \`src/routes/${slug}.routes.js\`.

## Endpoints

| method | path | handler |
| --- | --- | --- |
| GET | /api/v1/${slug} | list |
| POST | /api/v1/${slug} | create |
| GET | /api/v1/${slug}/:id | get |
| PATCH | /api/v1/${slug}/:id | update |
| DELETE | /api/v1/${slug}/:id | remove |

## Conventions

- every handler is wrapped by \`authMiddleware\` and \`tenantMiddleware\`
- list responses are paginated with \`limit\` (max 500) and \`offset\`
- errors are \`AppError\` instances with a stable machine code
- records are serialized by the model; service methods never return raw rows

## Notes

${pascal} rows are tenant-scoped. Cross-tenant access is a 404, not a 403, to
avoid leaking existence. Bulk operations must be idempotent on \`requestId\`.
`
}

function dataFile(slug, pascal) {
  const rows = [1, 2, 3].map((n) => ({
    id: `${slug}_${n}`,
    tenantId: 'tenant_default',
    status: n === 3 ? 'archived' : 'active',
    createdAt: `2025-0${n}-1${n}T00:00:00.000Z`,
    metadata: { region: n === 2 ? 'eu' : 'us', seed: n },
  }))
  return JSON.stringify({ resource: slug, count: rows.length, rows }, null, 2) + '\n'
}

function utilFile(name) {
  const bodies = {
    jwt: `import crypto from 'node:crypto'
import { config } from '../config/index.js'

export function signToken(payload, ttlSeconds = config.TOKEN_TTL) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url')
  const signature = crypto.createHmac('sha256', config.TOKEN_SECRET).update(\`\${header}.\${body}\`).digest('base64url')
  return \`\${header}.\${body}.\${signature}\`
}

export function verifyToken(token, secret = config.TOKEN_SECRET) {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 3) throw new Error('malformed_token')
  const [header, body, signature] = parts
  const expected = crypto.createHmac('sha256', secret).update(\`\${header}.\${body}\`).digest('base64url')
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('bad_signature')
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
}

export function signUserToken(user) { return signToken({ sub: user.id, scopes: user.scopes ?? [] }) }
export function signRefreshToken(user) { return signToken({ sub: user.id, kind: 'refresh' }, 60 * 60 * 24 * 30) }
export function passwordMatches(plain, hash) {
  return crypto.createHash('sha256').update(String(plain)).digest('hex') === hash
}

export const jwt = { signToken, verifyToken, signUserToken, signRefreshToken }
`,
    cache: `const store = new Map()

export function cacheGet(key) {
  const hit = store.get(key)
  if (!hit) return null
  if (hit.expiresAt < Date.now()) { store.delete(key); return null }
  return hit.value
}

export function cacheSet(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs })
  return value
}

export async function memoize(key, ttlMs, producer) {
  const hit = cacheGet(key)
  if (hit !== null) return hit
  const value = await producer()
  return cacheSet(key, value, ttlMs)
}

export function cacheClear() { store.clear() }
export function cacheStats() { return { size: store.size } }
`,
    serialize: `export function serializeRecord(record) {
  if (record === null || record === undefined) return null
  const { passwordHash, internalNotes, ...safe } = record
  return safe
}

export function serializeList(rows) { return rows.map(serializeRecord) }

export function pickFields(record, fields) {
  const out = {}
  for (const f of fields) if (record && Object.prototype.hasOwnProperty.call(record, f)) out[f] = record[f]
  return out
}
`,
  }
  if (bodies[name]) return bodies[name]
  return `/** ${name} helpers. */
export function ${name}Of(value) {
  return value === null || value === undefined ? null : String(value)
}

export function ${name}List(values = []) {
  return Array.isArray(values) ? values.map(${name}Of) : []
}

export function ${name}Eq(a, b) {
  return ${name}Of(a) === ${name}Of(b)
}
`
}

function middlewareFile(name) {
  const base = name.replace(/Middleware$/, '')
  if (name === 'authMiddleware') {
    return `import { verifyToken } from '../utils/jwt.js'
import { AppError } from '../errors.js'

export async function authMiddleware(req, res, next) {
  const header = req.headers?.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.cookies?.session
  if (!token) return next(new AppError('unauthorized', 401))
  try {
    req.auth = verifyToken(token)
    return next()
  } catch (err) {
    return next(new AppError('invalid_token', 401))
  }
}

export async function tenantMiddleware(req, res, next) {
  req.tenantId = req.auth?.tenantId ?? req.headers['x-tenant-id'] ?? 'tenant_default'
  return next()
}
`
  }
  return `/** ${base} middleware. */
export async function ${name}(req, res, next) {
  const startedAt = performance.now()
  try {
    req.${base} = { at: new Date().toISOString() }
    await next()
  } finally {
    res.setHeader?.('x-${base.toLowerCase()}-ms', String(Math.round(performance.now() - startedAt)))
  }
}

export default ${name}
`
}

const ROOT_FILES = {
  'package.json': JSON.stringify({
    name: 'atlas-api', version: '1.4.0', private: true, type: 'module', main: 'src/server.js',
    bin: { atlas: 'src/server.js' },
    scripts: { test: 'node --test tests/', build: 'node scripts/build.mjs', lint: 'node scripts/lint-report.mjs', dev: 'node src/server.js' },
    dependencies: { 'atlas-core': '^1.0.0', 'atlas-http': '^2.1.0', 'atlas-log': '^0.9.0' },
    engines: { node: '>=22' },
  }, null, 2) + '\n',
  'README.md': `# atlas-api

Multi-tenant resource API used by the Atlas product. Each resource is a vertical slice:
route table -> service -> model -> tests. Shared behaviour lives in \`src/middleware\`
and \`src/utils\`; configuration is environment-driven through \`src/config/index.js\`.

## Develop

\`\`\`bash
node src/server.js       # start on :8080
node --test tests/       # run the suite
node scripts/lint-report.mjs
\`\`\`

## Layout

\`\`\`
src/routes/<resource>.routes.js      HTTP surface + validation hooks
src/services/<resource>.service.js   business logic, pagination, errors
src/models/<resource>.model.js       canonical record shape
src/middleware/                      auth, tenant, rate limit, logging, cache
src/utils/                           jwt, cache, serialize, retry, ids, ...
tests/<resource>.test.js             unit tests (node:test)
docs/<resource>.md                   endpoint documentation
migrations/<nnn>_<name>.sql          schema changes
\`\`\`
`,
  '.gitignore': `node_modules/\ndist/\ntmp/\n*.log\n.cache/\n`,
  'src/server.js': `import { createServer } from 'node:http'
import { app } from './app.js'
import { config } from './config/index.js'
import { logger } from './utils/logger.js'

const server = createServer(app.handleRequest)

server.listen(config.PORT, () => {
  logger.info('atlas-api listening', { port: config.PORT, env: config.NODE_ENV })
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info('shutting down', { signal })
    server.close(() => process.exit(0))
  })
}

export { server }
`,
  'src/app.js': `import { logger } from './utils/logger.js'
import { errorMiddleware } from './middleware/errorMiddleware.js'
import { requestIdMiddleware } from './middleware/requestIdMiddleware.js'
import { metricsMiddleware } from './middleware/metricsMiddleware.js'
import { router as routeTable } from './routes/index.js'

export class Router {
  constructor() { this.routes = [] }
  use(fn) { this.routes.push({ method: 'USE', path: '*', fns: [fn] }); return this }
  get(p, ...fns) { return this._add('GET', p, fns) }
  post(p, ...fns) { return this._add('POST', p, fns) }
  patch(p, ...fns) { return this._add('PATCH', p, fns) }
  delete(p, ...fns) { return this._add('DELETE', p, fns) }
  _add(method, path, fns) { this.routes.push({ method, path, fns }); return this }
}

export const app = {
  handleRequest(req, res) {
    const match = routeTable.find((route) => route.method === (req.method ?? 'GET') && route.path === req.url)
    const chain = [requestIdMiddleware, metricsMiddleware, ...(match?.fns ?? []), errorMiddleware]
    let i = 0
    const next = (err) => {
      const fn = chain[i++]
      if (!fn) return
      if (err) return errorMiddleware({ ...req, error: err }, res, next)
      return fn(req, res, next)
    }
    next()
  },
}

export { logger }
`,
  'src/config/index.js': `const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) ? n : fallback
}

export const config = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: int(process.env.PORT, 8080),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  DB_URL: process.env.DB_URL ?? 'file:atlas.db',
  TOKEN_SECRET: process.env.TOKEN_SECRET ?? 'dev-only-secret',
  TOKEN_TTL: int(process.env.TOKEN_TTL, 60 * 60),
  CACHE_TTL: int(process.env.CACHE_TTL, 5000),
  RATE_LIMIT_WINDOW: int(process.env.RATE_LIMIT_WINDOW, 60),
  RATE_LIMIT_MAX: int(process.env.RATE_LIMIT_MAX, 600),
  TENANT_HEADER: 'x-tenant-id',
}

export function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(\`missing required env: \${name}\`)
  return value
}
`,
  'src/db.js': `import { config } from './config/index.js'
import { logger } from './utils/logger.js'

const tables = new Map()

function table(name) {
  if (!tables.has(name)) tables.set(name, [])
  return tables.get(name)
}

let counter = 0

export const db = {
  nextId(prefix) { counter += 1; return \`\${prefix}_\${counter}\` },
  async insert(name, record) { table(name).push(record); return record },
  async update(name, id, patch) {
    const rows = table(name)
    const idx = rows.findIndex((r) => r.id === id)
    if (idx < 0) return null
    rows[idx] = { ...rows[idx], ...patch }
    return rows[idx]
  },
  async select(name, { filter = {}, limit = 50, offset = 0 } = {}) {
    const rows = table(name).filter((row) => Object.entries(filter).every(([k, v]) => v === undefined || row[k] === v))
    logger.debug('db.select', { table: name, filter, limit, offset })
    return rows.slice(offset, offset + limit)
  },
  async selectOne(name, filter = {}) { const rows = await this.select(name, { filter, limit: 1 }); return rows[0] ?? null },
  async remove(name, id) { const rows = table(name); const idx = rows.findIndex((r) => r.id === id); if (idx >= 0) rows.splice(idx, 1); return idx >= 0 },
  async reset() { tables.clear(); logger.info('db.reset', { db: config.DB_URL }) },
}
`,
  'src/errors.js': `export class AppError extends Error {
  constructor(code, status = 500, details = null) {
    super(code)
    this.name = 'AppError'
    this.code = code
    this.status = status
    this.details = details
    this.expose = status < 500
  }

  toJSON() { return { code: this.code, status: this.status, details: this.details } }
}

export class ValidationError extends AppError {
  constructor(field, message) { super('validation_failed', 400, { field, message }); this.name = 'ValidationError' }
}

export class NotFoundError extends AppError {
  constructor(what) { super(\`\${what}_not_found\`, 404) }
}

export function isAppError(err) { return err instanceof AppError }
`,
  'src/routes/index.js': RESOURCES.map(([slug]) => `import ${pascalOf(slug)}Routes from './${slug}.routes.js'`).join('\n') + '\n\n// Flattened route table consumed by app.handleRequest.\nexport const router = [\n' +
    RESOURCES.map(([slug]) => `  ...${pascalOf(slug)}Routes.routes,`).join('\n') + '\n]\n',
}

function pascalOf(slug) { return slug.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join('') }

const EXTRA_FILES = {
  'scripts/build.mjs': `#!/usr/bin/env node
// Bundle-free "build": validates that every route module imports cleanly.
import { readdirSync } from 'node:fs'
import path from 'node:path'

const routes = readdirSync('src/routes').filter((f) => f.endsWith('.routes.js'))
let failed = 0
for (const file of routes) {
  try {
    const mod = await import(\`../src/routes/\${file}\`)
    if (!mod.default) throw new Error('no default export')
  } catch (err) {
    failed++
    console.error(\`route \${file} failed:\`, err.message)
  }
}
if (failed) process.exit(1)
console.log(\`built \${routes.length} route modules\`)
`,
  'scripts/seed.mjs': `import { db } from '../src/db.js'

const seeds = { users: 3, teams: 2, projects: 2 }
for (const [table, count] of Object.entries(seeds)) {
  for (let i = 0; i < count; i++) {
    await db.insert(table, { id: \`\${table}_\${i + 1}\`, status: 'active' })
    console.log(\`seeding \${table} \${i + 1}/\${count}\`)
  }
}
console.log('seed complete', (await db.select('users')).length, 'users')
`,
  'scripts/migrate.mjs': `import { readdirSync, readFileSync } from 'node:fs'

const dir = new URL('../migrations/', import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
for (const file of files) {
  const sql = readFileSync(new URL(file, dir), 'utf8')
  if (!sql.includes('CREATE')) throw new Error(\`migration \${file} has no CREATE\`)
  console.log('applied', file, sql.length, 'bytes')
}
`,
  'scripts/lint-report.mjs': `import { readdirSync } from 'node:fs'

const files = readdirSync('src', { recursive: true }).filter((f) => String(f).endsWith('.js'))
const offenders = files.filter((f) => String(f).includes('TODO'))
console.log(JSON.stringify({ files: files.length, offenders: offenders.length, clean: offenders.length === 0 }, null, 2))
`,
  'scripts/release.mjs': `import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = \`v\${pkg.version}\`
console.log('releasing', tag)
execFileSync('git', ['tag', '-a', tag, '-m', tag])
`,
  'scripts/benchmark.mjs': `import { performance } from 'node:perf_hooks'

const startedAt = performance.now()
const samples = []
for (let i = 0; i < 1000; i++) samples.push({ i, ms: performance.now() - startedAt })
console.log(JSON.stringify({ count: samples.length, elapsedMs: Math.round(performance.now() - startedAt) }))
`,
}

const MIGRATIONS = {
  '001_init.sql': `CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);\nCREATE INDEX IF NOT EXISTS tenants_name ON tenants(name);\n`,
  '002_users.sql': `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);\nCREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email);\n`,
  '003_projects.sql': `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), owner_id TEXT REFERENCES users(id), archived_at TEXT);\n`,
  '004_invoices.sql': `CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, customer_id TEXT NOT NULL, total_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft');\n`,
  '005_events.sql': `CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);\nCREATE INDEX IF NOT EXISTS events_type ON events(type);\n`,
  '006_audit.sql': `CREATE TABLE IF NOT EXISTS audit_trail (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, prev_hash TEXT, hash TEXT NOT NULL);\nCREATE INDEX IF NOT EXISTS audit_actor ON audit_trail(actor);\n`,
}

function buildFiles() {
  const rnd = mulberry32(20260101)
  const files = []
  for (const [rel, content] of Object.entries(ROOT_FILES)) {
    // routes/index.js is generated from RESOURCES below, not the placeholder above.
    files.push(w(rel, content))
  }
  for (const [slug, pascal, methods] of RESOURCES) {
    files.push(w(`src/services/${slug}.service.js`, serviceFile(slug, pascal, methods, rnd)))
    files.push(w(`src/models/${slug}.model.js`, modelFile(slug, pascal, rnd)))
    files.push(w(`src/routes/${slug}.routes.js`, routeFile(slug, pascal, rnd)))
    files.push(w(`tests/${slug}.test.js`, testFile(slug, pascal)))
    files.push(w(`docs/${slug}.md`, docFile(slug, pascal)))
  }
  for (const name of MIDDLEWARE) files.push(w(`src/middleware/${name}.js`, middlewareFile(name)))
  for (const name of UTILS) files.push(w(`src/utils/${name}.js`, utilFile(name)))
  for (const name of UTILS.slice(0, 10)) {
    files.push(w(`tests/utils/${name}.test.js`, `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport * as mod from '../../src/utils/${name}.js'\n\ntest('${name} exports functions', () => {\n  const fns = Object.values(mod).filter((v) => typeof v === 'function')\n  assert.ok(fns.length > 0, 'expected at least one exported function')\n})\n\ntest('${name} handles null input', () => {\n  for (const [key, fn] of Object.entries(mod)) {\n    if (typeof fn !== 'function' || fn.length === 0) continue\n    assert.doesNotThrow(() => fn(null), \`\${key}(null) should not throw\`)\n  }\n})\n`))
  }
  for (const [slug, pascal] of RESOURCES.slice(0, 7)) {
    files.push(w(`tests/integration/${slug}.integration.test.js`, `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { app } from '../../src/app.js'\nimport { ${pascal}Service } from '../../src/services/${slug}.service.js'\n\ntest('${slug}: create then read through the HTTP surface', async () => {\n  const created = await ${pascal}Service.create({ name: 'integration-${slug}' })\n  assert.equal(created.ok, true)\n  assert.ok(app.handleRequest)\n})\n\ntest('${slug}: listing is tenant scoped', async () => {\n  const listed = await ${pascal}Service.list({ limit: 5 })\n  assert.ok(Array.isArray(listed.items))\n})\n`))
  }
  for (const [slug] of RESOURCES.slice(0, 14)) files.push(w(`data/${slug}.json`, dataFile(slug, pascalOf(slug))))
  for (const [rel, content] of Object.entries(EXTRA_FILES)) files.push(w(rel, content))
  for (const [rel, content] of Object.entries(MIGRATIONS)) files.push(w(`migrations/${rel}`, content))
  // Ignored junk: must never appear in the index.
  files.push(w('tmp/ignored.log', 'this file is gitignored and must not be indexed\n'))
  files.push(w('.cache/stale.json', '{"ignored": true}\n'))
  return files
}

/** Generate the fixture on disk (idempotent). */
export function ensureFixture({ force = false } = {}) {
  const files = buildFiles()
  const tracked = files.filter((f) => !f.rel.startsWith('tmp/') && !f.rel.startsWith('.cache/'))
  const marker = path.join(FIXTURE_DIR, '.git', 'index')
  if (force || !fs.existsSync(path.join(FIXTURE_DIR, 'package.json'))) {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true })
    for (const f of files) {
      const abs = path.join(FIXTURE_DIR, f.rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, f.content)
    }
    try {
      execFileSync('git', ['-C', FIXTURE_DIR, 'init', '-q'], { stdio: 'ignore' })
      execFileSync('git', ['-C', FIXTURE_DIR, 'add', '-A'], { stdio: 'ignore' })
    } catch (err) { throw new Error(`fixture git init failed: ${err.message}`) }
  }
  const bytes = tracked.reduce((a, f) => a + Buffer.byteLength(f.content), 0)
  return { dir: FIXTURE_DIR, files: tracked.length, bytes, generated: fs.existsSync(marker) }
}

export function fixtureStats() {
  const files = buildFiles().filter((f) => !f.rel.startsWith('tmp/') && !f.rel.startsWith('.cache/'))
  return { files: files.length, bytes: files.reduce((a, f) => a + Buffer.byteLength(f.content), 0) }
}

/** Ground-truth tasks for the fixture: known file sets, symbols and paged plans. */
export function fixtureTasks() {
  return [
    {
      id: 'locate-auth', type: 'locate', corpus: 'atlas-fixture',
      goal: 'Where is token verification handled and what does it check?',
      query: 'verify token jwt', terms: ['verifyToken', 'jwt'],
      files: ['src/routes/auth.routes.js', 'src/services/auth.service.js', 'src/utils/jwt.js', 'src/middleware/authMiddleware.js'],
      plan: [{ op: 'query', q: 'verifyToken' }, { op: 'fault', target: 'verifyToken' }, { op: 'get', id: 'file:src/services/auth.service.js' }],
    },
    {
      id: 'understand-billing', type: 'understand', corpus: 'atlas-fixture',
      goal: 'Explain how invoices are serialized and where credits are applied.',
      query: 'serializeInvoice applyCredits', terms: ['serializeInvoice', 'applyCredits'],
      files: ['src/services/billing.service.js', 'src/models/invoices.model.js', 'src/utils/serialize.js', 'tests/billing.test.js'],
      plan: [{ op: 'fault', target: 'serializeInvoice' }, { op: 'fault', target: 'applyCredits' }, { op: 'get', id: 'file:src/utils/serialize.js' }],
    },
    {
      id: 'add-endpoint', type: 'change', corpus: 'atlas-fixture',
      goal: 'Add GET /api/v1/widgets/:id/audit following existing route conventions.',
      query: 'widgets routes audit', terms: ['widgets', 'audit'],
      files: ['src/routes/widgets.routes.js', 'src/routes/audit.routes.js', 'src/services/widgets.service.js', 'src/middleware/validationMiddleware.js', 'tests/widgets.test.js'],
      plan: [{ op: 'get', id: 'file:src/routes/widgets.routes.js' }, { op: 'query', q: 'audit route' }, { op: 'fault', target: 'audit' }, { op: 'get', id: 'file:src/middleware/validationMiddleware.js' }],
    },
    {
      id: 'refactor-invoice', type: 'refactor', corpus: 'atlas-fixture',
      goal: 'Refactor serializeInvoice to support partial refunds without changing callers.',
      query: 'serializeInvoice refund', terms: ['serializeInvoice', 'refund'],
      files: ['src/services/billing.service.js', 'src/models/invoices.model.js', 'src/utils/serialize.js', 'tests/billing.test.js'],
      plan: [{ op: 'fault', target: 'serializeInvoice' }, { op: 'query', q: 'refundCharge' }, { op: 'get', id: 'file:src/models/invoices.model.js' }],
    },
    {
      id: 'locate-cache', type: 'locate', corpus: 'atlas-fixture',
      goal: 'Where is response caching configured and how do we clear it?',
      query: 'cache ttl clear', terms: ['cache'],
      files: ['src/utils/cache.js', 'src/middleware/cacheMiddleware.js', 'src/config/index.js', 'src/app.js'],
      plan: [{ op: 'query', q: 'cacheSet cacheClear' }, { op: 'fault', target: 'cacheClear' }, { op: 'fault', target: 'cacheSet' }],
    },
    {
      id: 'review-auth-service', type: 'review', corpus: 'atlas-fixture',
      goal: 'Review src/services/auth.service.js for token handling problems.',
      query: 'auth service token session', terms: ['verifyToken', 'refreshSession'],
      files: ['src/services/auth.service.js', 'src/utils/jwt.js', 'src/middleware/authMiddleware.js', 'src/config/index.js'],
      plan: [{ op: 'get', id: 'file:src/services/auth.service.js' }, { op: 'fault', target: 'verifyToken' }, { op: 'fault', target: 'rotateSession' }],
    },
  ]
}
