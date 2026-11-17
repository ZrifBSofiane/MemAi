// CI eval smoke: index the repo, run the shipped fixtures, assert a recall floor.
// Cross-platform on purpose — no shell quoting, spawnSync with process.execPath.
// Usage: node scripts/eval-smoke.mjs [floor=0.75]
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import url from 'node:url'

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const BIN = path.join(REPO, 'bin', 'memai.mjs')
const floor = Number(process.argv[2] ?? 0.75)

const run = (args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: REPO, encoding: 'utf8', timeout: 120_000 })
  if (r.status !== 0) throw new Error(`memai ${args[0]} exited ${r.status}: ${(r.stderr ?? '').slice(0, 400)}`)
  return r.stdout
}

run(['index', '--max-files', '4000'])
const r = JSON.parse(run(['eval', '--fixtures', path.join(REPO, 'bench', 'eval-fixtures.json'), '--k', '5']))
if (!r.ok) throw new Error(`eval reported not-ok: ${r.error ?? '?'}`)
const idx = r.results.index.recallAtK
const hyb = r.results.hybrid.recallAtK
if (!(idx >= floor) || !(hyb >= floor)) throw new Error(`recall below floor ${floor}: index=${idx} hybrid=${hyb}`)
console.log(`eval smoke ok: index=${idx} hybrid=${hyb} (floor ${floor})`)
