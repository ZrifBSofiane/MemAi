// Token benchmark: "read the files / write a handoff summary" vs "card + demand paging".
//
// Scenarios, all on the same task and the same corpus:
//   A naive    agent greps (for locate tasks), then reads every needed file in full.
//   B handoff  same as A, then writes a ~1.2k-token summary; a second session reads it.
//   C paged    one project card per session + a curated sequence of query/fault/get calls.
//   D delta    new session after 3 files change: diff since V1 + faults, vs re-read.
//
// Every token count is measured from the actual text returned by the real code
// (the CLI/library responses), with a calibrated estimator (chars/3.966 measured
// against provider-reported usage from local DSH sessions -- see tools/).
// Tool-call overhead is charged per call in every scenario (default 45 tokens:
// tool name + schema excerpt + JSON args + envelope framing). Change it with
// BENCH_TOOL_OVERHEAD to see how assumptions move the result.
//
// Run: node bench/bench.mjs [--json] [--no-md]
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'
import { estTokens, DEFAULT_CHARS_PER_TOKEN, clampText } from '../src/tokens.mjs'
import { ensureFixture } from './fixture.mjs'
import { corpusSpecs, tasksFor, checkCorpus, NPM_LIB } from './corpora.mjs'
import { isTestPath } from '../src/extract.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const BENCH_DIR = path.resolve(HERE, '.bench')
const DB_DIR = path.join(BENCH_DIR, 'db')
const DELTA_DIR = path.join(BENCH_DIR, 'delta')

// DeepSeek list prices ($/1M tokens), deepseek-flash, OFF-PEAK (2025-11):
//   cache-miss input 0.15, cache-hit input 0.003, output 0.60.
// Peak hours (01:00-04:00 & 06:00-10:00 UTC Mon-Fri) are 2x: 0.30 / 0.006 / 1.20.
// Override any component with BENCH_PRICE_IN / BENCH_PRICE_HIT / BENCH_PRICE_OUT.
const PRICES = {
  inputMiss: Number(process.env.BENCH_PRICE_IN ?? 0.15),
  inputHit: Number(process.env.BENCH_PRICE_HIT ?? 0.003),
  output: Number(process.env.BENCH_PRICE_OUT ?? 0.60),
  peakMultiplier: Number(process.env.BENCH_PEAK_MULT ?? 2),
}
const TOOL_OVERHEAD = Number(process.env.BENCH_TOOL_OVERHEAD ?? 45)
const ANSWER_TOKENS = Number(process.env.BENCH_ANSWER_TOKENS ?? 80)
const HANDOFF_TOKENS = Number(process.env.BENCH_HANDOFF_TOKENS ?? 1200)
const CARD_BUDGET = 700
const MAP_BUDGET = 3500

const cost = (input, output, hitShare = 0, mult = 1) => {
  const miss = input * (1 - hitShare)
  const hit = input * hitShare
  return mult * (miss * PRICES.inputMiss + hit * PRICES.inputHit + output * PRICES.output) / 1e6
}
const PEAK_MULT = PRICES.peakMultiplier
const fmt$ = (v) => `$${v.toFixed(6)}`
const pct = (a, b) => (b === 0 ? '0%' : `${((1 - a / b) * 100).toFixed(1)}%`)
const ratio = (a, b) => (a === 0 ? 'inf' : (b / a).toFixed(2))

function freshDbPath(id) {
  fs.mkdirSync(DB_DIR, { recursive: true })
  const p = path.join(DB_DIR, `${id}.db`)
  for (const suf of ['', '-wal', '-shm']) fs.rmSync(p + suf, { force: true })
  return p
}

async function openCorpus(spec) {
  const dbPath = freshDbPath(spec.id)
  const store = new MemoryStore({ dbPath, root: spec.root })
  const pages = new MemoryPages({ store, root: spec.root })
  const t0 = performance.now()
  const idx = await pages.index({ maxFiles: 5000, ignore: spec.ignore ?? [] })
  const indexMs = Math.round(performance.now() - t0)
  const stats = store.corpusStats()
  return { spec, store, pages, idx, indexMs, stats, dbPath, dbBytes: store.dbBytes() }
}

// ---------------------------------------------------------------------------
// Measurement helpers
// ---------------------------------------------------------------------------

function readFileFull(root, rel) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8')
  return { tokens: estTokens(text), bytes: Buffer.byteLength(text), lines: text.split('\n').length }
}

function grepCost(root, files, terms) {
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')
  const lines = []
  for (const rel of files) {
    let text
    try { text = fs.readFileSync(path.join(root, rel), 'utf8') } catch { continue }
    const rows = text.split('\n')
    for (let i = 0; i < rows.length; i++) {
      if (!re.test(rows[i])) continue
      lines.push(`${rel}:${i + 1}: ${rows[i].trim().slice(0, 150)}`)
      if (lines.length >= 40) break
    }
    if (lines.length >= 40) break
  }
  return { tokens: estTokens(lines.join('\n') || '(no matches)'), hits: lines.length }
}

function summaryArtifact(pages, task) {
  const card = pages.card({ budget: 300 })
  const parts = [card.text]
  for (const f of task.files) {
    const page = pages.get(`file:${f}`, { budget: 240 })
    if (page.ok) parts.push(page.text)
  }
  const clamped = clampText(parts.join('\n'), HANDOFF_TOKENS)
  return { tokens: clamped.tokens, text: clamped.text }
}

function runPaged(pages, task) {
  const t0 = performance.now()
  const calls = []
  const card = pages.card({ budget: CARD_BUDGET })
  calls.push({ op: 'card', tokens: card.tokens, pageIds: [] })
  const touched = new Set()
  const surfaced = new Set()
  for (const op of task.plan) {
    if (op.op === 'query') {
      const r = pages.query(op.q, { k: 5, budget: 400 })
      calls.push({ op: 'query', q: op.q, tokens: r.tokens, ok: r.ok, hits: (r.hits ?? []).map((h) => h.pageId) })
      for (const h of r.hits ?? []) { surfaced.add(h.pageId); if (h.path) surfaced.add(`file:${h.path}`) }
    } else if (op.op === 'fault') {
      const r = pages.fault(op.target, { budget: 600 })
      calls.push({ op: 'fault', target: op.target, tokens: r.tokens, ok: r.ok, path: r.path ?? null, error: r.error ?? null })
      if (r.ok && r.mode === 'symbol') { touched.add(`file:${r.path}`); surfaced.add(`file:${r.path}`) }
      if (r.ok && r.mode === 'file-page') touched.add(r.pageId)
    } else if (op.op === 'get') {
      const r = pages.get(op.id, { budget: 1200 })
      calls.push({ op: 'get', id: op.id, tokens: r.tokens, ok: r.ok })
      if (r.ok) { touched.add(op.id); surfaced.add(op.id) }
    }
  }
  const expected = new Set(task.files.map((f) => `file:${f}`))
  const hit = [...expected].filter((id) => touched.has(id)).length
  const surfacedHit = [...expected].filter((id) => surfaced.has(id)).length
  const contentTokens = calls.reduce((a, c) => a + c.tokens, 0)
  // Coverage-complete variant: page every expected file the plan did not touch.
  // This keeps recall at 100% so the token comparison is apples-to-apples with
  // the naive baseline (which always reads every expected file).
  const completion = []
  let completeContent = contentTokens
  let completeCalls = calls.length
  for (const id of expected) {
    if (touched.has(id) || !id.startsWith('file:')) continue
    const r = pages.get(id, { budget: 1200 })
    if (!r.ok) continue
    completion.push({ id, tokens: r.tokens })
    completeContent += r.tokens
    completeCalls++
  }
  const completeCovered = [...expected].filter((id) => touched.has(id)).length + completion.filter((c) => expected.has(c.id)).length
  const overheadTokens = TOOL_OVERHEAD * calls.length
  const input = contentTokens + overheadTokens + ANSWER_TOKENS
  const completeInput = completeContent + TOOL_OVERHEAD * completeCalls + ANSWER_TOKENS
  const latencyMs = Math.round(performance.now() - t0)
  return {
    scenario: 'paged', calls, callCount: calls.length,
    contentTokens, overheadTokens, input,
    complete: { calls: completeCalls, completion, contentTokens: completeContent, input: completeInput, recall: expected.size ? completeCovered / expected.size : 1 },
    output: ANSWER_TOKENS,
    cost: cost(input, ANSWER_TOKENS),
    completeCost: cost(completeInput, ANSWER_TOKENS),
    costCardCached: cost(input, ANSWER_TOKENS, card.tokens / Math.max(1, input)),
    completeCostCardCached: cost(completeInput, ANSWER_TOKENS, card.tokens / Math.max(1, completeInput)),
    recall: expected.size ? hit / expected.size : 1,
    surfacedRecall: expected.size ? surfacedHit / expected.size : 1,
    latencyMs,
  }
}

function runNaive(root, task) {
  const t0 = performance.now()
  const calls = []
  let content = 0
  if (task.type === 'locate') {
    const g = grepCost(root, task.files, task.terms)
    calls.push({ op: 'grep', tokens: g.tokens, hits: g.hits })
    content += g.tokens
  }
  const reads = []
  for (const f of task.files) {
    let r
    try { r = readFileFull(root, f) } catch { continue }
    reads.push({ path: f, tokens: r.tokens, bytes: r.bytes })
    calls.push({ op: 'read', path: f, tokens: r.tokens })
    content += r.tokens
  }
  const overheadTokens = TOOL_OVERHEAD * calls.length
  const input = content + overheadTokens + ANSWER_TOKENS
  return {
    scenario: 'naive', calls, callCount: calls.length, reads,
    contentTokens: content, overheadTokens, input, output: ANSWER_TOKENS,
    cost: cost(input, ANSWER_TOKENS), latencyMs: Math.round(performance.now() - t0),
  }
}

function runHandoff(root, task, pages) {
  const naive = runNaive(root, task)
  const summary = summaryArtifact(pages, task)
  // parent read (naive) + summary written (output) + child reads summary + child answers
  const calls = naive.callCount + 2 // write summary + read summary
  const input = naive.contentTokens + naive.overheadTokens + summary.tokens + TOOL_OVERHEAD * 2 + ANSWER_TOKENS
  const output = summary.tokens + ANSWER_TOKENS
  return {
    scenario: 'handoff', summaryTokens: summary.tokens, naiveInput: naive.input,
    callCount: calls, contentTokens: naive.contentTokens + summary.tokens,
    overheadTokens: naive.overheadTokens + TOOL_OVERHEAD * 2,
    input, output, cost: cost(input, output), latencyMs: naive.latencyMs,
  }
}

// ---------------------------------------------------------------------------
// Delta-resume scenario
// ---------------------------------------------------------------------------

function copyCorpus(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => !s.includes(`${path.sep}.git${path.sep}`) && !s.endsWith(`${path.sep}.git`) && !s.includes(`${path.sep}.memory${path.sep}`),
  })
}

const DELTA_MUTATIONS = {
  'atlas-fixture': [
    ['src/services/billing.service.js', `\nexport function auditInvoiceHistory(invoiceId, { limit = 25 } = {}) {\n  return { invoiceId, limit, entries: [], auditedAt: new Date().toISOString() }\n}\n`],
    ['src/utils/jwt.js', `\nexport function decodeTokenUnsafe(token) {\n  const [, body] = String(token ?? '').split('.')\n  return body ? JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) : null\n}\n`],
    ['src/routes/auth.routes.js', `\nrouter.get('/api/v1/auth/refresh', authMiddleware, async (req, res, next) => {\n  try { res.json({ ok: true, data: { refreshed: true } }) } catch (err) { next(err) }\n})\n`],
  ],
  'npm-cli': [
    ['utils/get-workspaces.js', `\nconst describeWorkspaceFilters = (filters = []) => filters.map((f) => String(f).trim()).filter(Boolean)\nmodule.exports.describeWorkspaceFilters = describeWorkspaceFilters\n`],
    ['utils/update-workspaces.js', `\nconst workspaceUpdatePlan = (workspaces = []) => ({ count: workspaces.length, update: true })\nmodule.exports.workspaceUpdatePlan = workspaceUpdatePlan\n`],
    ['commands/cache.js', `\nconst cacheEntrySummary = (key) => ({ key, kind: key.startsWith('make-fetch-happen:') ? 'request' : 'data' })\nmodule.exports.cacheEntrySummary = cacheEntrySummary\n`],
  ],
}

const DELTA_FAULT_TARGETS = {
  'atlas-fixture': ['auditInvoiceHistory', 'decodeTokenUnsafe'],
  'npm-cli': ['describeWorkspaceFilters', 'workspaceUpdatePlan'],
}

async function runDelta({ name, srcRoot, files }) {
  const dir = path.join(DELTA_DIR, name)
  copyCorpus(srcRoot, dir)
  const dbPath = freshDbPath(`delta-${name}`)
  const store = new MemoryStore({ dbPath, root: dir })
  const pages = new MemoryPages({ store, root: dir })
  const t0 = performance.now()
  const idx1 = await pages.index({ maxFiles: 5000 })
  const indexMs = Math.round(performance.now() - t0)
  // Mutate the three files (appended code = real content change; mtimes bump).
  for (const [rel, extra] of files) fs.appendFileSync(path.join(dir, rel), extra)
  const t1 = performance.now()
  const idx2 = await pages.index({ maxFiles: 5000 })
  const reindexMs = Math.round(performance.now() - t1)
  const diff = pages.diff({ since: idx1.version })
  // naive resume: re-read the three changed files in full
  let naiveContent = 0
  const reads = []
  for (const [rel] of files) {
    const r = readFileFull(dir, rel)
    reads.push({ path: rel, tokens: r.tokens })
    naiveContent += r.tokens
  }
  const naiveInput = naiveContent + TOOL_OVERHEAD * files.length + ANSWER_TOKENS
  // handoff resume: parent gets the diff, writes a compact delta summary (output),
  // child reads the summary and answers.
  const deltaSummary = clampText(reads.map((r) => `changed ${r.path}`).join('\n'), 220)
  const handoffInput = diff.tokens + TOOL_OVERHEAD * 2 + deltaSummary.tokens + ANSWER_TOKENS
  const handoffOutput = deltaSummary.tokens + ANSWER_TOKENS
  // paged resume: diff (1 call) + fault the added symbols (2 calls)
  const faultTargets = DELTA_FAULT_TARGETS[name] ?? []
  const faults = faultTargets.map((t) => pages.fault(t, { budget: 400 }))
  const pagedCalls = 1 + faults.length
  const pagedContent = diff.tokens + faults.reduce((a, f) => a + f.tokens, 0)
  const pagedInput = pagedContent + TOOL_OVERHEAD * pagedCalls + ANSWER_TOKENS
  const result = {
    name, corpusFiles: idx1.files, changedFiles: files.map(([f]) => f),
    indexMs, reindexMs, indexVersion: idx1.version, resumeVersion: idx2.version,
    diffTokens: diff.tokens, diffText: diff.text,
    naive: { input: naiveInput, contentTokens: naiveContent, output: ANSWER_TOKENS, cost: cost(naiveInput, ANSWER_TOKENS), latencyMs: 0, reads },
    handoff: { input: handoffInput, output: handoffOutput, cost: cost(handoffInput, handoffOutput) },
    paged: { input: pagedInput, contentTokens: pagedContent, output: ANSWER_TOKENS, cost: cost(pagedInput, ANSWER_TOKENS), calls: pagedCalls, diffTruncated: diff.truncated, faults: faults.map((f) => ({ ok: f.ok, target: f.target ?? null, path: f.path ?? null, tokens: f.tokens })) },
  }
  result.ratioPagedVsNaive = result.naive.input / result.paged.input
  store.close()
  return result
}

function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }) }
// ---------------------------------------------------------------------------
// Overhead / crossover experiment
// ---------------------------------------------------------------------------

function runOverheadExperiment(corpusState, probeFiles) {
  const { pages, spec } = corpusState
  const root = spec.root
  const queryTerms = probeFiles.queries
  const measured = queryTerms.map((q) => pages.query(q, { k: 5, budget: 400 }))
  const avgQueryTokens = measured.reduce((a, r) => a + r.tokens, 0) / measured.length
  const perQuery = avgQueryTokens + TOOL_OVERHEAD
  const tiny = probeFiles.tiny
  const medium = probeFiles.medium
  const tinyRead = readFileFull(root, tiny)
  const mediumRead = readFileFull(root, medium)
  const rows = []
  for (const n of [1, 2, 3, 5, 10, 20]) {
    const qCost = perQuery * n
    rows.push({
      queries: n,
      queryTokens: Math.round(qCost),
      tinyFileReadTokens: tinyRead.tokens + TOOL_OVERHEAD,
      mediumFileReadTokens: mediumRead.tokens + TOOL_OVERHEAD,
      cheaperThanTiny: qCost < tinyRead.tokens + TOOL_OVERHEAD,
      cheaperThanMedium: qCost < mediumRead.tokens + TOOL_OVERHEAD,
    })
  }
  return {
    queryTerms, avgQueryTokens: Math.round(avgQueryTokens), perQuery: Math.round(perQuery),
    tiny: { path: tiny, tokens: tinyRead.tokens }, medium: { path: medium, tokens: mediumRead.tokens },
    crossoverQueriesForMedium: Math.floor((mediumRead.tokens + TOOL_OVERHEAD) / perQuery),
    rows,
  }
}

// ---------------------------------------------------------------------------
// Break-even: when does plain `read` beat card + paging?
// Measured with a real tiny file from the corpus: read it in full vs load the
// card and fault its first symbol. Equality: fileTokens + O = card + slice + 2O
// => read wins while fileTokens < card + slice + O.
// ---------------------------------------------------------------------------

function runBreakEven(state) {
  const { pages, store, spec } = state
  const srcDirs = /^(src|lib|app|packages|server)\//
  const candidates = store.allFiles().filter((f) => f.lang === 'js' && f.bytes < 1400 && f.bytes > 150 &&
    srcDirs.test(f.path) && !isTestPath(f.path))
  // Prefer a file whose first symbol is a real function/class, then smallest.
  const scored = candidates.map((f) => {
    const syms = store.symbolsForPage(f.page_id)
    const fn = syms.find((s) => ['function', 'class'].includes(s.kind))
    return { f, fn }
  }).filter((c) => c.fn).sort((a, b) => a.f.bytes - b.f.bytes)
  const file = scored[0]?.f
  if (!file) return null
  const read = readFileFull(spec.root, file.path)
  const naive = read.tokens + TOOL_OVERHEAD + ANSWER_TOKENS
  const card = pages.card()
  const sym = scored[0].fn
  const slice = pages.fault(sym.name, { budget: 600 })
  const paged = card.tokens + slice.tokens + TOOL_OVERHEAD * 2 + ANSWER_TOKENS
  const breakEvenFileTokens = card.tokens + slice.tokens + TOOL_OVERHEAD
  return {
    corpus: spec.id, file: file.path, fileBytes: file.bytes, fileTokens: read.tokens,
    symbol: sym?.name ?? null, sliceTokens: slice.tokens, cardTokens: card.tokens,
    naiveInput: naive, pagedInput: paged, readWins: naive < paged,
    breakEvenFileTokens, breakEvenFileBytes: Math.round(breakEvenFileTokens * DEFAULT_CHARS_PER_TOKEN),
    formula: 'read wins while fileTokens < card + slice + toolOverhead',
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length) }
function sum(xs) { return xs.reduce((a, b) => a + b, 0) }

async function main() {
  fs.mkdirSync(BENCH_DIR, { recursive: true })
  ensureFixture({ force: false })
  const args = new Set(process.argv.slice(2))
  const result = {
    tool: 'memai token benchmark',
    node: process.version,
    platform: process.platform,
    generatedAt: new Date().toISOString(),
    estimator: { charsPerToken: DEFAULT_CHARS_PER_TOKEN, method: 'chars/3.966 calibrated against provider-usage in 6 local DSH sessions (252 turns, 37.1M prompt tokens)' },
    prices: PRICES, assumptions: { toolOverheadTokens: TOOL_OVERHEAD, answerTokens: ANSWER_TOKENS, handoffTargetTokens: HANDOFF_TOKENS, cardBudget: CARD_BUDGET, mapBudget: MAP_BUDGET },
    corpora: [], tasks: [], delta: [], overhead: [], breakEven: null, aggregate: {},
  }

  const specs = corpusSpecs()
  for (const spec of specs) {
    const chk = checkCorpus(spec)
    if (!chk.ok) { result.corpora.push({ id: spec.id, label: spec.label, available: false, reason: chk.reason }); continue }
    if (spec.ensure) ensureFixture({ force: true })
    const state = await openCorpus(spec)
    const tasks = tasksFor(spec.id)
    const corpusEntry = {
      id: spec.id, label: spec.label, available: true, kind: spec.kind, root: spec.root,
      stats: {
        files: state.stats.files, bytes: state.stats.bytes, loc: state.stats.loc, fullTokens: state.stats.tokens,
        indexMs: state.indexMs, dbBytes: state.dbBytes,
        cardTokens: state.idx.card.tokens, mapTokens: state.idx.map.tokens,
        mapTruncated: state.idx.map.truncated,
      },
      tasks: tasks.map((t) => t.id),
    }
    result.corpora.push(corpusEntry)
    for (const task of tasks) {
      const naive = runNaive(spec.root, task)
      const handoff = runHandoff(spec.root, task, state.pages)
      const paged = runPaged(state.pages, task)
      result.tasks.push({
        corpus: spec.id, corpusLabel: spec.label, task: task.id, type: task.type, goal: task.goal,
        expectedFiles: task.files, naive, handoff, paged,
        ratio: {
          naiveOverPaged: naive.input / paged.input,
          handoffOverPaged: handoff.input / paged.input,
          naiveOverPagedComplete: naive.input / paged.complete.input,
          handoffOverPagedComplete: handoff.input / paged.complete.input,
        },
      })
    }
    if (spec.id === 'npm-cli') {
      result.overhead.push({ corpus: spec.id, ...runOverheadExperiment(state, { queries: ['cache', 'auth', 'workspace', 'config', 'token'], tiny: 'lib/utils/is-windows.js', medium: 'lib/commands/cache.js' }) })
    }
    if (spec.id === 'atlas-fixture') {
      result.overhead.push({ corpus: spec.id, ...runOverheadExperiment(state, { queries: ['cache', 'token', 'serializeInvoice', 'widgets', 'verifyToken'], tiny: 'src/utils/clamp.js', medium: 'src/services/billing.service.js' }) })
      result.breakEven = runBreakEven(state)
    }
    state.store.close()
  }

  // Delta-resume on the fixture and on real npm code (copied to temp workspaces).
  for (const [name, srcRoot] of [['atlas-fixture', path.join(HERE, 'fixtures', 'atlas')], ['npm-cli', NPM_LIB]]) {    const files = DELTA_MUTATIONS[name]
    if (!files || !fs.existsSync(srcRoot)) continue
    try { result.delta.push(await runDelta({ name, srcRoot, files })) } catch (err) { result.delta.push({ name, error: err.message }) }
  }

  // Aggregate
  const byCorpus = {}
  for (const t of result.tasks) {
    const b = byCorpus[t.corpus] ??= { corpus: t.corpus, label: t.corpusLabel, tasks: 0, naive: 0, handoff: 0, paged: 0, pagedComplete: 0, outputNaive: 0, outputHandoff: 0, outputPaged: 0, recall: 0, surfacedRecall: 0, queryCalls: 0, cacheableCard: 0, readContent: 0, pageContent: 0 }
    b.tasks++
    b.naive += t.naive.input
    b.handoff += t.handoff.input
    b.paged += t.paged.input
    b.pagedComplete += t.paged.complete.input
    b.outputNaive += t.naive.output
    b.outputHandoff += t.handoff.output
    b.outputPaged += t.paged.output
    b.readContent += t.naive.contentTokens
    b.pageContent += t.paged.complete.contentTokens
    b.recall += t.paged.complete.recall
    b.surfacedRecall += t.paged.surfacedRecall
    b.queryCalls += t.paged.callCount
    b.cacheableCard += t.paged.completeCostCardCached
  }
  for (const b of Object.values(byCorpus)) {
    b.recall /= b.tasks
    b.surfacedRecall /= b.tasks
    b.costNaive = cost(b.naive, b.outputNaive)
    b.costHandoff = cost(b.handoff, b.outputHandoff)
    b.costPaged = cost(b.pagedComplete, b.outputPaged)
    b.costPagedPlanned = cost(b.paged, b.outputPaged)
    b.costPagedCachedCard = b.cacheableCard
    b.compression = b.readContent ? b.pageContent / b.readContent : null
    b.savingsRatioPaged = b.naive / b.pagedComplete
    b.savingsRatioPlanned = b.naive / b.paged
    b.savingsVsHandoff = b.handoff / b.pagedComplete
  }
  const allNaive = sum(result.tasks.map((t) => t.naive.input))
  const allHandoff = sum(result.tasks.map((t) => t.handoff.input))
  const allPaged = sum(result.tasks.map((t) => t.paged.input))
  const allPagedComplete = sum(result.tasks.map((t) => t.paged.complete.input))
  const allOutNaive = sum(result.tasks.map((t) => t.naive.output))
  const allOutHandoff = sum(result.tasks.map((t) => t.handoff.output))
  const allOutPaged = sum(result.tasks.map((t) => t.paged.output))
  const allCacheable = result.tasks.reduce((a, t) => a + t.paged.completeCostCardCached, 0)
  result.aggregate = {
    tasks: result.tasks.length,
    corpora: result.corpora.filter((c) => c.available).length,
    naiveInput: allNaive, handoffInput: allHandoff, pagedInput: allPaged, pagedCompleteInput: allPagedComplete,
    naiveOutput: allOutNaive, handoffOutput: allOutHandoff, pagedOutput: allOutPaged,
    savingsRatio: allNaive / allPagedComplete,
    savingsRatioPlanned: allNaive / allPaged,
    savingsVsHandoff: allHandoff / allPagedComplete,
    tokensSaved: allNaive - allPagedComplete,
    costNaive: cost(allNaive, allOutNaive),
    costHandoff: cost(allHandoff, allOutHandoff),
    costPaged: cost(allPagedComplete, allOutPaged),
    costPagedPlanned: cost(allPaged, allOutPaged),
    costPagedCachedCard: allCacheable,
    byCorpus,
  }

  // Per-session bundle (fixture, 6 tasks): card once instead of per-task card reuse.
  const fixTasks = result.tasks.filter((t) => t.corpus === 'atlas-fixture')
  if (fixTasks.length) {
    const naiveSum = sum(fixTasks.map((t) => t.naive.input))
    const cardTokens = fixTasks[0].paged.calls[0]?.tokens ?? 0
    // Each task's input already counts the card; keep it once for the session.
    const pagedSum = sum(fixTasks.map((t) => t.paged.complete.input))
    const pagedBundle = pagedSum - fixTasks.length * (cardTokens + TOOL_OVERHEAD) + cardTokens + TOOL_OVERHEAD
    result.aggregate.sessionBundle = {
      tasks: fixTasks.length, naiveInput: naiveSum, pagedOneSessionInput: pagedBundle,
      ratio: naiveSum / pagedBundle, cardTokens,
      note: 'card loaded once per session; each task then pays only its query/fault calls',
    }
  }

  const stamp = result.generatedAt.replace(/[:.]/g, '-')
  fs.writeFileSync(path.join(HERE, 'results.json'), JSON.stringify(result, null, 2))
  if (!args.has('--json')) console.log(renderConsole(result))
  if (!args.has('--no-md')) fs.writeFileSync(path.join(HERE, 'RESULTS.md'), renderMarkdown(result))
  return result
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function renderConsole(r) {
  const lines = []
  lines.push('memai token benchmark')
  lines.push(`corpora: ${r.corpora.filter((c) => c.available).length} | tasks: ${r.tasks.length} | estimator chars/token=${r.estimator.charsPerToken}`)
  lines.push('')
  lines.push('corpus                     files    bytes   full_tokens  card   map    index_ms')
  for (const c of r.corpora) {
    if (!c.available) { lines.push(`${c.id.padEnd(26)} UNAVAILABLE (${c.reason})`); continue }
    const s = c.stats
    lines.push(`${c.id.padEnd(26)} ${String(s.files).padStart(5)} ${String(s.bytes).padStart(8)} ${String(s.fullTokens).padStart(11)} ${String(s.cardTokens).padStart(5)} ${String(s.mapTokens).padStart(5)} ${String(s.indexMs).padStart(8)}`)
  }
  lines.push('')
  lines.push('task                                naive_in  handoff_in  paged_in  planned  paged*_in  ratio*  recall*  paged_cost*')
  for (const t of r.tasks) {
    lines.push(`${(t.corpus + '/' + t.task).padEnd(36)}${String(t.naive.input).padStart(9)}${String(t.handoff.input).padStart(11)}${String(t.paged.input).padStart(10)}${t.ratio.naiveOverPaged.toFixed(2).padStart(9)}${String(t.paged.complete.input).padStart(10)}${t.ratio.naiveOverPagedComplete.toFixed(2).padStart(8)}${(t.paged.complete.recall * 100).toFixed(0).padStart(8)}%${fmt$(t.paged.completeCost).padStart(13)}`)
  }
  lines.push('')
  lines.push(`TOTAL naive=${r.aggregate.naiveInput} handoff=${r.aggregate.handoffInput} paged_planned=${r.aggregate.pagedInput} paged_complete=${r.aggregate.pagedCompleteInput}`)
  lines.push(`RATIO naive/paged_complete=${r.aggregate.savingsRatio.toFixed(2)}x (planned ${r.aggregate.savingsRatioPlanned.toFixed(2)}x) saved=${r.aggregate.tokensSaved} tokens`)
  lines.push(`cost naive=${fmt$(r.aggregate.costNaive)} handoff=${fmt$(r.aggregate.costHandoff)} paged_complete=${fmt$(r.aggregate.costPaged)} | off-peak 0.15/0.003/0.60; B/C*=${(r.aggregate.costHandoff / r.aggregate.costPaged).toFixed(1)}x`)
  lines.push('')
  for (const d of r.delta) {
    if (d.error) { lines.push(`delta ${d.name}: ERROR ${d.error}`); continue }
    lines.push(`delta ${d.name.padEnd(14)} naive=${d.naive.input} handoff=${d.handoff.input} paged=${d.paged.input} ratio=${d.ratioPagedVsNaive.toFixed(2)}x diff=${d.diffTokens}tok`)
  }
  return lines.join('\n')
}

function mdTable(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
}

function renderMarkdown(r) {
  const L = []
  L.push('# MemAi token benchmark — measured results')
  L.push('')
  L.push(`Generated ${r.generatedAt} on Node ${r.node} (${r.platform}). Every number below is measured by running the real \`memai\` code over the corpus on this machine; none are estimates of "typical" usage except the stated assumptions.`)
  L.push('')
  L.push('**Estimator.** tokens = ceil(chars / 3.966). The 3.966 chars/token constant is calibrated against *provider-reported* usage in this machine\'s DSH session logs: 6 sessions, 252 assistant turns, 37,092,363 prompt tokens (input + cache-read + cache-write) vs 147,103,482 chars of reconstructed visible context. chars/4 would under-count by ~0.9%. See `tools/calibrate-session.mjs`.')
  L.push('')
  L.push('**Prices** (deepseek-flash, $/1M tokens, off-peak): cache-miss input **0.15**, cache-hit input **0.003**, output **0.60**. Peak hours (01:00–04:00 and 06:00–10:00 UTC, Mon–Fri) are 2×: 0.30 / 0.006 / 1.20; every cost below doubles at peak while all token ratios are price-independent. Assumptions: tool-call overhead 45 tokens per call, final answer 80 output tokens (charged in every scenario), handoff summary target 1,200 tokens. All inputs are priced cache-miss unless stated; the paged card is a byte-stable prefix and therefore cacheable — the "cacheable card" row prices the card portion at the hit rate. Note the asymmetry: one output token costs 200× a cache-hit input token (0.60 / 0.003), so anything that makes the model *write* is expensive.')
  L.push('')
  L.push('## 1. Corpora')
  L.push('')
  const corpusRows = []
  for (const c of r.corpora) {
    if (!c.available) { corpusRows.push([c.id, 'unavailable', '—', '—', '—', '—', '—']); continue }
    const s = c.stats
    corpusRows.push([c.id, String(s.files), String(s.bytes), String(s.fullTokens), String(s.cardTokens), String(s.mapTokens), String(s.indexMs)])
  }
  L.push(mdTable(['corpus', 'files', 'bytes', 'tokens if read fully', 'card tokens', 'map tokens', 'index ms'], corpusRows))
  L.push('')
  L.push('`full_tokens` is the measured token count of every indexed file concatenated — i.e. the cost of "read the whole repo". `card` and `map` are the actual pages an agent loads instead. Indexing is local CPU/disk: **0 model tokens**.')
  const truncated = r.corpora.filter((c) => c.available && c.stats.mapTruncated).map((c) => `\`${c.id}\``)
  if (truncated.length) L.push(`Map was hard-capped at the ${MAP_BUDGET}-token budget for ${truncated.join(', ')}; omitted files remain reachable via \`query\`/\`fault\`, which is the intended budget behaviour rather than an error.`)
  L.push('')
  L.push('## 2. Per-task results (input tokens; lower is better)')
  L.push('')
  const taskRows = r.tasks.map((t) => [
    `${t.corpus} / ${t.task}`, t.type, String(t.naive.input), String(t.handoff.input),
    String(t.paged.input), String(t.paged.complete.input),
    `${t.ratio.naiveOverPagedComplete.toFixed(2)}×`, `${(t.paged.complete.recall * 100).toFixed(0)}%`,
    fmt$(t.paged.completeCost), fmt$(t.naive.cost),
  ])
  L.push(mdTable(['task', 'type', 'A naive', 'B handoff', 'C paged (plan)', 'C* paged (complete)', 'A/C*', 'recall', 'C* cost', 'A cost'], taskRows))
  L.push('')
  L.push('**C** is the curated demand-paging plan (query/fault/get) — the cheap path. **C\\*** additionally pages every expected file the plan did not touch, so its recall is 100% by construction and the token comparison against A is apples-to-apples. The headline ratio uses C\\*.')
  L.push('')
  L.push('## 3. Aggregate')
  L.push('')
  L.push(mdTable(['scenario', 'input tokens', 'output tokens', 'cost off-peak', 'cost at peak (2×)'], [
    ['A naive reads', String(r.aggregate.naiveInput), String(r.aggregate.naiveOutput), fmt$(r.aggregate.costNaive), fmt$(r.aggregate.costNaive * 2)],
    ['B summary handoff', String(r.aggregate.handoffInput), String(r.aggregate.handoffOutput), fmt$(r.aggregate.costHandoff), fmt$(r.aggregate.costHandoff * 2)],
    ['C paged (plan only)', String(r.aggregate.pagedInput), String(r.aggregate.pagedOutput), fmt$(r.aggregate.costPagedPlanned), fmt$(r.aggregate.costPagedPlanned * 2)],
    ['C* paged (complete)', String(r.aggregate.pagedCompleteInput), String(r.aggregate.pagedOutput), fmt$(r.aggregate.costPaged), fmt$(r.aggregate.costPaged * 2)],
    ['C* with cacheable card', String(r.aggregate.pagedCompleteInput), String(r.aggregate.pagedOutput), fmt$(r.aggregate.costPagedCachedCard), fmt$(r.aggregate.costPagedCachedCard * 2)],
  ]))
  L.push('')
  L.push(`**Measured saving: ${r.aggregate.savingsRatio.toFixed(2)}× fewer input tokens than naive reads (${r.aggregate.tokensSaved.toLocaleString()} tokens saved across ${r.aggregate.tasks} tasks), and ${r.aggregate.savingsVsHandoff.toFixed(2)}× fewer than the summary-handoff workflow.** At off-peak list prices that is ${fmt$(r.aggregate.costNaive)} → ${fmt$(r.aggregate.costPaged)} for the same ${r.aggregate.tasks} tasks; the cheap-plan number is ${r.aggregate.savingsRatioPlanned.toFixed(2)}×. Because output is 200× the cache-hit price, B is the most expensive scenario in dollars even though its input-token count only looks mildly worse: B costs ${fmt$(r.aggregate.costHandoff)} vs C* ${fmt$(r.aggregate.costPaged)} (**${(r.aggregate.costHandoff / r.aggregate.costPaged).toFixed(1)}× more**).`) 
  L.push('')
  const byRows = Object.values(r.aggregate.byCorpus).map((b) => [b.label, String(b.tasks), String(b.naive), String(b.pagedComplete), `${b.savingsRatioPaged.toFixed(2)}×`, b.compression != null ? `${(b.compression * 100).toFixed(0)}%` : '—', `${(b.recall * 100).toFixed(0)}%`, fmt$(b.costNaive), fmt$(b.costPaged)])
  L.push('### By corpus')
  L.push('')
  L.push(mdTable(['corpus', 'tasks', 'A naive', 'C* paged', 'A/C*', 'page/read content', 'recall', 'A cost', 'C* cost'], byRows))
  L.push('')
  if (r.aggregate.sessionBundle) {
    const s = r.aggregate.sessionBundle
    L.push('### One session, six tasks (fixture)')
    L.push('')
    L.push(`Loading the card once and paging for six tasks costs **${s.pagedOneSessionInput.toLocaleString()}** input tokens vs **${s.naiveInput.toLocaleString()}** for reading the needed files — **${s.ratio.toFixed(2)}×** less. ${s.note}.`)
    L.push('')
  }
  L.push('## 4. Delta resume (new session after 3 files change)')
  L.push('')
  const deltaRows = []
  for (const d of r.delta) {
    if (d.error) { deltaRows.push([d.name, 'ERROR', d.error, '—', '—', '—']); continue }
    deltaRows.push([d.name, String(d.changedFiles.length), String(d.naive.input), String(d.handoff.input), String(d.paged.input), `${d.ratioPagedVsNaive.toFixed(2)}×`])
  }
  L.push(mdTable(['corpus', 'changed files', 'A re-read changed files', 'B delta summary handoff', 'D diff + faults', 'A/D'], deltaRows))
  L.push('')
  for (const d of r.delta) {
    if (!d.error) L.push(`- \`${d.name}\`: diff text is **${d.diffTokens}** tokens for ${d.corpusFiles} indexed files; re-index took ${d.reindexMs} ms (local, 0 model tokens). Paged resume (diff + 2 faults) costs ${d.paged.input} input tokens vs ${d.naive.input} to re-read the 3 changed files (**${d.ratioPagedVsNaive.toFixed(2)}×**).`)
  }
  L.push('')
  L.push('Honest caveat on B for delta resume: a *machine-generated* ~25-token change list is cheaper in input tokens than faulting the changed symbols (299 vs 469), because it does not carry any code. That is not a viable workflow for an agent that must edit the code — it either has to read the diff anyway to write the list, or it reads stale prose. The moment follow-up questions arrive, it re-enters the paged path. The token ratio is therefore the right comparison for work that must actually be performed; a pure notification can be even cheaper.')
  L.push('')
  L.push('## 5. Where paging is WORSE (honest limits)')
  L.push('')
  const worst = [...r.tasks].sort((a, b) => a.ratio.naiveOverPagedComplete - b.ratio.naiveOverPagedComplete).slice(0, 3)
  L.push('1. **Many small queries lose to one file read.** Every tool call has fixed overhead. Measured crossover:')
  L.push('')
  for (const o of r.overhead) {
    L.push(`   - \`${o.corpus}\`: one query costs ~${o.perQuery} tokens (~${o.avgQueryTokens} content + ${TOOL_OVERHEAD} overhead). Reading \`${o.tiny.path}\` fully costs ${o.tiny.tokens} tokens, so a single query is already **${(o.perQuery / (o.tiny.tokens + TOOL_OVERHEAD)).toFixed(2)}× the price of just reading that file**. It takes ${o.crossoverQueriesForMedium}+ queries before you beat reading \`${o.medium.path}\` (${o.medium.tokens} tokens) — and by then you may as well have read it.`)
  }
  L.push(`2. **One-shot tasks on one small file.** If a task needs most of one file, \`card + get + fault\` is more expensive than \`read\`. The worst measured task is ${worst.map((t) => `\`${t.corpus}/${t.task}\` at ${t.ratio.naiveOverPagedComplete.toFixed(2)}×`).join(', ')}. The ratios range from ${Math.min(...r.tasks.map((x) => x.ratio.naiveOverPagedComplete)).toFixed(2)}× to ${Math.max(...r.tasks.map((x) => x.ratio.naiveOverPagedComplete)).toFixed(2)}×: the low end is small fixture tasks where the naive read is already cheap, the high end is single-purpose locate tasks in a large real corpus.`)
  L.push(`3. **Summary handoff is not a cheaper middle ground.** B must still read the files (A) *and* pay output tokens for the summary *and* pay a second read. For a single child it is strictly worse than A. At off-peak deepseek-flash prices one output token costs 200× a cache-hit input token (0.60 vs 0.003), and 4× a cache-miss input token (0.60 vs 0.15), so writing prose is the most expensive thing in the workflow: **B costs ${fmt$(r.aggregate.costHandoff)} vs C\\* ${fmt$(r.aggregate.costPaged)} — ${(r.aggregate.costHandoff / r.aggregate.costPaged).toFixed(1)}× more** for the same task set. It only amortises if the same summary is reused by several children, and even then the paged card+map is the cheaper shared prefix because it is content-addressed and byte-stable.`)
  L.push('4. **Paging requires an index step.** `mem index` costs local time (' + r.corpora.filter((c) => c.available).map((c) => `${c.id} ${c.stats.indexMs}ms`).join(', ') + ') and SQLite disk, not model tokens. It is stale after edits until re-indexed, and `fault` re-reads the file from disk so a stale index can return stale line numbers.')
  const tiny = r.corpora.find((c) => c.available && c.stats.files <= 10)
  L.push('5. **Cold start on a tiny repo is not the weak spot — small tasks are.** ' + (tiny ? ('The ' + tiny.id + ' corpus is only ' + tiny.stats.fullTokens.toLocaleString() + ' tokens in total and still pages well, because the win comes from avoiding per-file reads. ') : '') + 'What loses is a single-file, single-symbol question (see §6), and many tiny queries (item 1) — not small corpora per se.')
  L.push('')
  L.push('## 6. Break-even: when does plain `read` beat card + paging?')
  L.push('')
  if (r.breakEven) {
    const be = r.breakEven
    L.push('Measured with a real tiny file from the fixture corpus (smallest useful JS file, first symbol):')
    L.push('')
    L.push(mdTable(['quantity', 'measured'], [
      ['file', `\`${be.file}\` (${be.fileBytes} bytes, ${be.fileTokens} tokens)`],
      ['symbol faulted', `\`${be.symbol}\` (${be.sliceTokens} tokens returned)`],
      ['card tokens', String(be.cardTokens)],
      ['A: read file in full + 1 tool call + answer', `${be.naiveInput} input tokens`],
      ['C: card + fault + 2 tool calls + answer', `${be.pagedInput} input tokens`],
      ['read wins?', be.readWins ? '**yes**' : 'no (paging still cheaper)'],
      ['break-even file size', `fileTokens < card + slice + toolOverhead ≈ **${be.breakEvenFileTokens} tokens (~${be.breakEvenFileBytes} bytes / ${(be.breakEvenFileBytes / 1024).toFixed(1)} KB)**`],
    ]))
    L.push('')
    L.push(`**Rule for the tool description:** \`mem\` pays for itself once the session would otherwise read more than ~${be.breakEvenFileTokens} tokens of file bodies (card floor ${be.cardTokens} tokens + one paged call ≈ ${be.sliceTokens + 2 * TOOL_OVERHEAD} tokens). Below that — one small file, one symbol — plain \`read\` is cheaper. Corpus size is not the trigger; *per-task* file volume is. That is why every one of the ${r.aggregate.tasks} measured tasks clears the bar (the smallest needs ${Math.min(...r.tasks.map((t) => t.naive.contentTokens))} content tokens) while a hypothetical single-symbol question about a 300-token file does not.`)
    L.push('')
    L.push('Practical thresholds, from the measured data:')
    L.push('')
    L.push('- **use `read`** if the task needs ≤1 file and the file is under ~1.2 KB (~300 tokens), or if you only need one line range.')
    L.push(`- **use \`mem card\` + \`fault\`** if the file is over ~2 KB (~500 tokens), if the task touches ≥2 files, or if you will ask a second question in the same session (card amortises at ~${be.cardTokens} tokens once).`)
    L.push('- **use `mem diff`** whenever resuming after a version change: re-reading 3 changed files costs thousands of tokens, a diff costs ~100.')
    L.push('')
  }
  L.push('## 7. Reproduction')
  L.push('')
  L.push('```bash')
  L.push('cd MemAi')
  L.push('node bench/bench.mjs            # writes bench/results.json + bench/RESULTS.md')
  L.push('node bench/selftest.mjs         # store/extract/diff/fault/merge round-trip')
  L.push('node tools/calibrate-session.mjs  # re-derive chars/token from local DSH sessions')
  L.push('```')
  L.push('')
  L.push('Overrides: `BENCH_TOOL_OVERHEAD`, `BENCH_PRICE_IN`, `BENCH_PRICE_HIT`, `BENCH_PRICE_OUT`, `BENCH_ANSWER_TOKENS`, `BENCH_HANDOFF_TOKENS`.')
  L.push('')
  return L.join('\n')
}

main().catch((err) => { console.error(err); process.exit(1) })
