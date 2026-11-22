// Guard threshold simulation: does the 8 KB default hold up on the benchmark
// corpora? For every file the 14 tasks touch, compare a whole-file read with
// the guard-forced alternative (signature page + one fault estimate).
//
// Run: node bench/guard-sim.mjs
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { corpusSpecs, tasksFor, checkCorpus } from './corpora.mjs'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'
import { estTokens } from '../src/tokens.mjs'
import { SIG_BUDGET, FAULT_EST_TOKENS } from '../src/guard.mjs'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const TOOL_OVERHEAD = 45
export const THRESHOLDS = [4096, 8192, 16384]

function freshDb(id) {
  const dir = path.join(HERE, '.tmp')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `guard-${id}.db`)
  for (const suf of ['', '-wal', '-shm']) fs.rmSync(p + suf, { force: true })
  return p
}

export async function guardSim({ specIds = null, thresholds = THRESHOLDS } = {}) {
  const rows = []
  for (const spec of corpusSpecs()) {
    if (specIds && !specIds.includes(spec.id)) continue
    if (!checkCorpus(spec).ok) continue
    const dbPath = freshDb(spec.id)
    const store = new MemoryStore({ dbPath, root: spec.root })
    const pages = new MemoryPages({ store, root: spec.root })
    try {
      await pages.index({ maxFiles: 5000, ignore: spec.ignore ?? [] })
      const seen = new Set()
      for (const task of tasksFor(spec.id)) {
        for (const rel of task.files) {
          if (seen.has(rel)) continue
          seen.add(rel)
          let text
          try { text = fs.readFileSync(path.join(spec.root, rel), 'utf8') } catch { continue }
          const bytes = Buffer.byteLength(text)
          const readTokens = estTokens(text)
          const sig = pages.get(`file:${rel}`, { budget: SIG_BUDGET })
          const sigTokens = sig.ok ? sig.tokens : null
          rows.push({
            corpus: spec.id, path: rel, bytes, readTokens, sigTokens,
            forcedTokens: sig.ok ? sigTokens + FAULT_EST_TOKENS : null,
          })
        }
      }
    } finally { store.close() }
    for (const suf of ['', '-wal', '-shm']) fs.rmSync(dbPath + suf, { force: true })
  }

  const byThreshold = {}
  const totalRead = rows.reduce((a, r) => a + r.readTokens, 0)
  for (const t of thresholds) {
    const denied = rows.filter((r) => r.bytes >= t && r.sigTokens != null)
    const deniedRead = denied.reduce((a, r) => a + r.readTokens, 0)
    byThreshold[t] = {
      denied: denied.length,
      interceptedShare: totalRead ? deniedRead / totalRead : 0,
      forcedVsRead: denied.reduce((a, r) => a + r.forcedTokens, 0) / (deniedRead || 1),
      overridePenalty: denied.reduce((a, r) => Math.max(a, r.sigTokens + TOOL_OVERHEAD), 0),
      rows: denied.map((r) => ({ ...r, ratio: r.readTokens / r.forcedTokens })),
    }
  }
  return { rows, byThreshold, totalRead }
}

export function renderTable(sim) {
  const lines = ['| threshold | files denied | intercepted share of read tokens | forced/read | max override penalty |', '| --- | --- | --- | --- | --- |']
  for (const [t, v] of Object.entries(sim.byThreshold)) {
    lines.push(`| ${Number(t) / 1024} KB | ${v.denied} | ${(v.interceptedShare * 100).toFixed(0)}% | ${v.forcedVsRead.toFixed(2)} | ${v.overridePenalty} tok |`)
  }
  return lines.join('\n')
}

if (process.argv[1] && url.pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const sim = await guardSim()
  process.stdout.write(renderTable(sim) + '\n')
  const t8 = sim.byThreshold[8192]
  const worst = t8.rows.reduce((a, r) => (r.ratio < a.ratio ? r : a), t8.rows[0])
  if (worst) process.stdout.write(`worst 8 KB file: ${worst.path} — read ${worst.readTokens} vs forced ${worst.forcedTokens} (${worst.ratio.toFixed(2)}x)\n`)
}
