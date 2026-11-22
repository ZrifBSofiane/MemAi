// Static context-cost bench for MemAi: fixed surfaces + delivered payload.
// No model calls, no network. See docs/superpowers/specs/2026-11-22-token-savings-design.md
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { memTool, INSTRUCTIONS } from '../mcp/tools.mjs'
import { instructionBlock } from '../src/init.mjs'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'
import { render } from '../src/mem-cli.mjs'
import { estTokens } from '../src/tokens.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.join(HERE, '..')
const SKILL_PATH = path.join(PKG_ROOT, 'skills', 'memai', 'SKILL.md')
export const BASELINE_PATH = path.join(HERE, 'cost-baseline.json')

// Mirrors the six-question benchmark B1-B6 (bench/BENCHMARK-0.5.0.md).
export const CANONICAL_CALLS = [
  { id: 'B1-query', op: 'query', q: 'watch debounce' },
  { id: 'B1-fault', op: 'fault', target: 'startWatcher' },
  { id: 'B2', op: 'fault', target: 'indexFiles', deep: true },
  { id: 'B3', op: 'graph', target: 'resolveDb' },
  { id: 'B5', op: 'query', q: 'estTokens', rg: true },
  { id: 'B6', op: 'fault', target: 'estTokens' },
]

function openPages(root) {
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root, create: false })
  const pages = new MemoryPages({ store, root })
  pages.staleCheck = false
  return { store, pages }
}

export function measureSurfaces(pages, { skillPath = SKILL_PATH, agents = ['claude'] } = {}) {
  const card = pages.card()
  const skill = fs.readFileSync(skillPath, 'utf8')
  const frontmatter = skill.match(/^---\r?\n[\s\S]*?\r?\n---/)?.[0] ?? ''
  const surfaces = {
    schema: estTokens(JSON.stringify(memTool())),
    instructions: estTokens(JSON.stringify(INSTRUCTIONS)),
    initBlock: estTokens(instructionBlock({ agents })),
    skillFrontmatter: estTokens(frontmatter),
    card: card.tokens ?? 0,
  }
  surfaces.total = surfaces.schema + surfaces.instructions + surfaces.initBlock + surfaces.skillFrontmatter + surfaces.card
  return surfaces
}

export function measureCall(pages, call) {
  let res
  if (call.op === 'query') {
    res = pages.query(call.q, { k: call.k ?? 5, budget: call.budget ?? 400, rg: !!call.rg, body: !!call.body })
  } else if (call.op === 'fault') {
    res = pages.fault(call.target, { budget: call.budget ?? 600, deep: !!call.deep })
  } else if (call.op === 'get') {
    res = pages.get(call.pageId, { budget: call.budget ?? 1200 })
  } else if (call.op === 'graph') {
    res = pages.graph(call.target, { budget: call.budget ?? 500 })
  } else {
    throw new Error(`unknown op ${call.op}`)
  }
  return {
    id: call.id,
    op: call.op,
    reported: res.tokens ?? 0,
    jsonTokens: estTokens(render(res, {})),
    textTokens: estTokens(render(res, { text: true })),
  }
}

export function turnModel(surfaces, turns) {
  const perRequest = surfaces.schema + surfaces.initBlock + surfaces.skillFrontmatter
  const once = surfaces.instructions + surfaces.card
  return { turns, perRequest, once, total: once + turns * perRequest }
}

export function measure({ root = process.cwd(), calls = CANONICAL_CALLS, skillPath = SKILL_PATH, agents = ['claude'], turns = 10 } = {}) {
  const { store, pages } = openPages(root)
  try {
    const surfaces = measureSurfaces(pages, { skillPath, agents })
    const delivered = calls.map((c) => measureCall(pages, c))
    return { ok: true, root, surfaces, delivered, model: turnModel(surfaces, turns) }
  } finally {
    try { store.close() } catch { /* already closed */ }
  }
}

export function renderReport(r) {
  const s = r.surfaces
  const lines = [
    `# MemAi context cost — ${r.root}`,
    `fixed: schema ${s.schema} · instructions ${s.instructions} · init ${s.initBlock} · skill ${s.skillFrontmatter} · card ${s.card} · total ${s.total}`,
    'delivered (tokens) — json / text:',
  ]
  for (const d of r.delivered) lines.push(`  ${d.id}  ${d.jsonTokens} / ${d.textTokens}`)
  const m = r.model
  lines.push(`turn model (${m.turns} turns): once ${m.once} + ${m.turns} × per-request ${m.perRequest} = ${m.total}`)
  return lines.join('\n')
}

export function baselineFrom(r) {
  return {
    surfaces: { ...r.surfaces },
    delivered: r.delivered.map(({ id, jsonTokens, textTokens }) => ({ id, jsonTokens, textTokens })),
  }
}

export function compareBaseline(r, baseline) {
  const worse = []
  for (const key of ['schema', 'instructions', 'initBlock', 'skillFrontmatter', 'card', 'total']) {
    if (r.surfaces[key] > baseline.surfaces[key]) {
      worse.push({ kind: 'surface', name: key, now: r.surfaces[key], base: baseline.surfaces[key] })
    }
  }
  for (const d of r.delivered) {
    const b = baseline.delivered.find((x) => x.id === d.id)
    if (b && d.textTokens > b.textTokens) {
      worse.push({ kind: 'call', name: d.id, now: d.textTokens, base: b.textTokens })
    }
  }
  return worse
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null
}

function main() {
  const argv = process.argv.slice(2)
  const root = flag(argv, '--root') ?? process.cwd()
  const turns = Number(flag(argv, '--turns') ?? 10)
  const r = measure({ root, turns })
  process.stdout.write((argv.includes('--json') ? JSON.stringify(r, null, 2) : renderReport(r)) + '\n')
  if (argv.includes('--write-baseline')) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baselineFrom(r), null, 2) + '\n')
    process.stderr.write(`baseline written to ${BASELINE_PATH}\n`)
  }
  if (argv.includes('--check')) {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    const worse = compareBaseline(r, baseline)
    if (worse.length) {
      process.stderr.write(`cost regression:\n${worse.map((w) => `  ${w.kind} ${w.name}: ${w.base} -> ${w.now}`).join('\n')}\n`)
      process.exitCode = 1
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main()
