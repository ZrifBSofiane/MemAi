# Body pick + line fault correctness (0.12.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `query --body` pick the right file's callable (or say `none`) and `fault <path>:<line>` label `(complete)` only for a whole symbol, gated by the repo's own eval and a live no-regression A/B.

**Architecture:** Two independent fixes in `src/page.mjs`: an evidence-based candidate scorer for the `--body` block of `query()`, and a symbol-aware rewrite of `_faultLine()`. A new `body` metric in `evaluate()` is the primary gate. No ranking, budget, or instruction-surface growth.

**Tech Stack:** Node ≥ 22.13 ESM, `node --test`, SQLite store via `src/store.mjs`, estimator `ceil(chars/3.966)`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-11-24-body-pick-and-line-fault-design.md` (branch `fix/body-pick-and-line-fault`, baseline `c94cf62`).
- Version bump: **0.12.0** in lockstep across exactly 4 files: `package.json`, `src/mem-cli.mjs` (`VERSION`), `mcp/paths.mjs` (`VERSION`), `skills/memai/SKILL.md` (`metadata.version`); `test/surfaces.test.mjs` asserts them.
- Guidance surfaces must not grow: `node bench/cost.mjs --check` must exit 0 after every task that touches `mcp/tools.mjs` or `skills/memai/SKILL.md`.
- Gates (spec §Gates): extended body ≥ **34/40**; shipped body **12/12**; right→wrong **0**; recall/MRR identical to `BENCHMARK-0.11.0.md` (shipped 100 % / 0.80 · 0.74; extended 85 % / 0.61 · 90 % / 0.57); live A/B no task above **+1 %** billed input and none with more calls.
- Never gate a test run through a pipe (`node --test … | tail`) — run it plain and read the summary (project gotcha).
- Stop any resident `memai watch` in a scratch/measured tree before index-dependent steps: `node bin/memai.mjs watch --stop`.
- The user (Sofiane) merges PRs. **Never push or open a PR without the user's explicit confirmation.**
- Commit after every task; message style: conventional (`fix:`, `feat:`, `tools:`, `docs:`, `release:`).

---

### Task 1: Body-pick probe + baseline capture

**Files:**
- Create: `tools/body-eval.mjs`
- Create (untracked, gitignored): `.tmp/120-base-body-ext.json`, `.tmp/120-base-body-shipped.json`

**Interfaces:**
- Consumes: `MemoryStore`/`MemoryPages` (`src/store.mjs`, `src/page.mjs`), fixture files `bench/eval-fixtures.json`, `bench/eval-fixtures-ext.json`.
- Produces: `node tools/body-eval.mjs <fixtures.json> [--out FILE] [--json]` — prints `body: file=<pct>%  (<n>/<total>)` + `body-miss:` lines; with `--out`, writes rows `[{q, expect, hit, got}]`. Tasks 5/7/8 re-run it for after-numbers and the right→wrong diff.

- [ ] **Step 1: Create the probe tool**

```js
#!/usr/bin/env node
// Body-pick gate probe: run `query --body` over an eval fixture file and report,
// per fixture, whether the picked body comes from the expected file.
//   node tools/body-eval.mjs bench/eval-fixtures-ext.json [--out FILE] [--json]
import fs from 'node:fs'
import path from 'node:path'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)
const fixturesFile = process.argv[2]
if (!fixturesFile) {
  process.stderr.write('usage: node tools/body-eval.mjs <fixtures.json> [--out FILE] [--json]\n')
  process.exit(1)
}
const root = process.cwd()
const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root, create: false })
const pages = new MemoryPages({ store, root })
const fixtures = JSON.parse(fs.readFileSync(fixturesFile, 'utf8'))
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
const rows = fixtures.map((f) => {
  const r = pages.query(String(f.q), { k: 5, body: true })
  const expect = norm(f.expect)
  const got = r.body?.ok ? norm(r.body.path) : 'none'
  const hit = got !== 'none' && (got === expect || got.endsWith('/' + expect))
  return { q: String(f.q), expect, hit, got }
})
const hits = rows.filter((r) => r.hit).length
const text = [
  `# body-eval — ${fixtures.length} fixtures`,
  `body: file=${Math.round((100 * hits) / fixtures.length)}%  (${hits}/${fixtures.length})`,
  ...rows.filter((r) => !r.hit).map((r) => `body-miss: "${r.q}" → expected ${r.expect}, got ${r.got}`),
].join('\n')
const out = arg('out')
if (out) {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(rows, null, 2))
}
process.stdout.write((has('json') ? JSON.stringify({ hits, total: fixtures.length, rows }) : text) + '\n')
store.close()
```

- [ ] **Step 2: Verify the tool runs and matches the measured baseline**

Run:
```bash
cd /d/Projects/MemAi
node tools/body-eval.mjs bench/eval-fixtures-ext.json --out .tmp/120-base-body-ext.json
node tools/body-eval.mjs bench/eval-fixtures.json --out .tmp/120-base-body-shipped.json
```
Expected: ext prints `body: file=58%  (23/40)`; shipped prints `body: file=83%  (10/12)`. These two numbers are the baseline in the spec gate table. (Ext rows must match the analysis recorded in the spec: same fixture order, same right-set.)

- [ ] **Step 3: Commit**

```bash
git add tools/body-eval.mjs
git commit -m "tools: body-pick gate probe with baseline capture"
```

---

### Task 2: Fix 1 — evidence-based body picker

**Files:**
- Modify: `src/page.mjs` (module helpers near `pageScore`, ~line 43–68; replace the `if (body)` block inside `query()`, lines 638–686)
- Test: `test/retrieval.test.mjs` (add tests beside the existing `--body` tests, after line 476)

**Interfaces:**
- Consumes: `this.store.symbolSearch`, `this.store.searchPages`, `this.store.symbolsForPage`, `this.fault(path#sym, {budget, deep})`, module helpers `isTestPath`/`isDocPath` (imported from `src/extract.mjs`), `sliceSymbol`, `langOf`, `estTokens`, `DEFAULTS` (all already in `src/page.mjs`).
- Produces (module-scope in `src/page.mjs`, used by Tasks 2/4): `bodyTerms(q) -> string[]`; `bodyTier(p) -> 0|1|2`; `scoreBodyCandidate(c, terms, bodyWords) -> number` where `c = {name, kind, path, line, signature, key}`. Query body contract: success `{ok:true, target, symbol, path, tokens, text}`; floor `{ok:false, reason:'no-match', target:null, tokens, text}` — Task 4's `evaluate()` reads `r.body.ok` and `r.body.path`.

- [ ] **Step 1: Write the failing tests**

Add to `test/retrieval.test.mjs` after the test ending at line 476 (`query --body prefers the matching source callable over docs headings`). The shared helpers `tempDir`, `cleanup`, `MemoryStore`, `MemoryPages`, `fs`, `path` already exist in this file; the fixture-writer pattern copies the existing two `--body` tests. A small local builder keeps the six tests short:

```js
/** Build an indexed mini-project from `{ 'src/x.js': '…', … }`; returns { root, store, pages }. */
async function fileProject(files) {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"body-pick-fix","version":"1.0.0","type":"module"}')
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  return { root, store, pages }
}

test('query --body matches remaining terms after stopwords are dropped', async () => {
  const { store, pages } = await fileProject({
    'bench/fixture.js': 'export function isAppError(e) {\n  return e instanceof Error\n}\n',
  })
  try {
    // `is`/`an` are stopwords; `error` still segment-matches isAppError.
    const r = pages.query('is an error', { body: true })
    assert.equal(r.body.ok, true)
    assert.equal(r.body.symbol, 'isAppError')
  } finally { store.close() }
})

test('query --body: whole-segment match beats a substring match', async () => {
  const { store, pages } = await fileProject({
    'src/render.js': 'export function renderMarkdown(text) {\n  return text\n}\n',
    'src/alt.js': 'export function markdownify(text) {\n  return text\n}\n',
  })
  try {
    const r = pages.query('render markdown', { body: true })
    assert.equal(r.body.ok, true)
    assert.equal(r.body.symbol, 'renderMarkdown', `got ${r.body.symbol}`)
  } finally { store.close() }
})

test('query --body returns no-match when the pool is empty', async () => {
  const { store, pages } = await fileProject({
    'src/only.js': 'export const FETCH_TIMEOUT_MS = 30_000\n',
  })
  try {
    const r = pages.query('fetch timeout', { body: true })
    assert.equal(r.body.ok, false)
    assert.equal(r.body.reason, 'no-match')
    assert.match(r.text, /body: none — no source callable matches/)
  } finally { store.close() }
})

test('query --body never guesses below the confidence floor', async () => {
  const { store, pages } = await fileProject({
    'src/only.js': 'export const FETCH_TIMEOUT_MS = 30_000\n\nexport function handler(req) {\n  return req\n}\n',
  })
  try {
    // The only callable (`handler`) matches neither term; the const matches but is not a candidate.
    const r = pages.query('fetch timeout', { body: true })
    assert.equal(r.body.ok, false, `must not guess ${r.body?.symbol}`)
    assert.equal(r.body.reason, 'no-match')
  } finally { store.close() }
})

test('query --body: source beats support paths on a score tie', async () => {
  const { store, pages } = await fileProject({
    'src/budget.js': 'export function budgetFor(n) {\n  return Math.max(200, n)\n}\n',
    'bench/fixture.js': 'export function measureBudget(n) {\n  return n\n}\n',
  })
  try {
    const r = pages.query('budget', { body: true })
    assert.equal(r.body.ok, true)
    assert.equal(r.body.path, 'src/budget.js', `got ${r.body.path}`)
  } finally { store.close() }
})

test('query --body: a term found only in the body can decide', async () => {
  const { store, pages } = await fileProject({
    'src/store.js': 'export function openStore(file) {\n  const db = new Database(file) // sqlite database handle\n  return db\n}\n',
    'src/db.js': 'export function openStore(url) {\n  return url\n}\n',
  })
  try {
    // Both candidates segment-match `open`; only src/store.js mentions sqlite in its body.
    // The old picker tie-broke to the shorter path (src/db.js).
    const r = pages.query('open sqlite', { body: true })
    assert.equal(r.body.ok, true)
    assert.equal(r.body.path, 'src/store.js', `got ${r.body.path}`)
  } finally { store.close() }
})
```

- [ ] **Step 2: Run to verify the new tests fail (or are documented guards)**

Run: `node --test test/retrieval.test.mjs`
Expected: `never guesses below the confidence floor` FAILS (old picker returns `handler`), `returns no-match when the pool is empty` FAILS (no `reason`, no `body: none` text), `a term found only in the body can decide` FAILS (old tie-break returns `src/db.js`). The stopword, segment, and tie tests may already pass on the old picker — they are regression guards; the eval gate (Task 5) is the real fix-1 proof. All pre-existing tests must still pass.

- [ ] **Step 3: Add the module helpers to `src/page.mjs`**

Insert directly after the `pageScore` function (ends line 68):

```js
// -------------------------------------------------------------- body pick ---

const BODY_STOPWORDS = new Set(('a an the and or of in on at to for from by with without as is are was ' +
  'were be been being do does did how what when where which who whom whose why that this these those ' +
  'it its their there here per one two any all some no if then than so can could should would will ' +
  'shall may might must have has had').split(' '))

/** Query terms for body matching: word split, camel-case split (both forms kept),
 *  lowercased, stopwords and 1-char tokens dropped, at most 8. */
function bodyTerms(q) {
  const out = []
  const seen = new Set()
  for (const tok of String(q).split(/[^a-zA-Z0-9_$]+/)) {
    if (!tok) continue
    for (const part of [tok, ...tok.split(/(?<=[a-z0-9])(?=[A-Z])/)]) {
      const t = part.toLowerCase()
      if (t.length < 2 || BODY_STOPWORDS.has(t) || seen.has(t)) continue
      seen.add(t)
      out.push(t)
      if (out.length >= 8) return out
    }
  }
  return out
}

const camelSegments = (name) =>
  String(name).split(/(?<=[a-z0-9])(?=[A-Z])|[_$]+|\d+/).map((t) => t.toLowerCase()).filter(Boolean)

const SUPPORT_PATH = /(^|\/)(bench|benchmarks|fixtures|examples)\//
const bodyTier = (p) => (isTestPath(p) ? 2 : SUPPORT_PATH.test(p) ? 1 : 0)

const commonPrefix = (a, b) => {
  let i = 0
  const n = Math.min(a.length, b.length)
  while (i < n && a[i] === b[i]) i++
  return i
}

/** Score one candidate against the body terms (0.12.0 spec): whole-name 6,
 *  segment 3, shared prefix ≥4 chars covering ≥60 % of the shorter 2, long
 *  substring 1; unmatched terms earn +1 as a signature word or a body word,
 *  each bonus capped at 3. */
function scoreBodyCandidate(c, terms, bodyWords) {
  const lowName = String(c.name).toLowerCase().replace(/^[_$]+/, '')
  const segs = camelSegments(c.name)
  const sigWords = new Set(String(c.signature ?? '').toLowerCase().split(/[^a-z0-9_$]+/))
  let score = 0
  let sigOnly = 0
  let bodyOnly = 0
  for (const t of terms) {
    let m = 0
    if (lowName === t) m = 6
    else if (segs.includes(t)) m = 3
    else {
      for (const seg of segs) {
        const cp = commonPrefix(t, seg)
        if (cp >= 4 && cp * 10 >= 6 * Math.min(t.length, seg.length)) { m = 2; break }
      }
      if (!m && t.length >= 5 && lowName.includes(t)) m = 1
    }
    if (m) { score += m; continue }
    if (sigWords.has(t)) sigOnly++
    else if (bodyWords?.has(t)) bodyOnly++
  }
  return score + Math.min(3, sigOnly) + Math.min(3, bodyOnly)
}
```

- [ ] **Step 4: Replace the `if (body)` block in `query()`**

In `src/page.mjs`, replace everything from `if (body) {` (line 638) through the closing brace before `return { ok: true, query: q, …` (line 686) with:

```js
    if (body) {
      // Evidence-based pick (0.12.0 spec): the body must come from the file the
      // question is about (hit list) or match the query terms as an identifier —
      // never a guess from an unrelated full-text page.
      const terms = bodyTerms(q)
      const dispRank = new Map()
      top.forEach((h, i) => {
        if (!h.path) return
        const cur = dispRank.get(h.path)
        if (cur === undefined || i < cur) dispRank.set(h.path, i)
      })
      const pool = []
      const poolKeys = new Set()
      const addCandidate = (s, rank) => {
        if (!s?.path || !['function', 'method', 'class'].includes(s.kind)) return
        if (isDocPath(s.path)) return
        const key = `${s.path}|${s.name}|${s.line}`
        if (poolKeys.has(key)) {
          const c = pool.find((x) => x.key === key)
          if (rank < c.fileRank) c.fileRank = rank
          return
        }
        poolKeys.add(key)
        pool.push({ key, name: s.name, kind: s.kind, path: s.path, line: s.line, signature: s.signature, tier: bodyTier(s.path), fileRank: dispRank.get(s.path) ?? rank, score: 0 })
      }
      // 1) callables shown in the hit list
      for (const h of top) {
        if (h.kind !== 'symbol') continue
        addCandidate({ name: h.symbol, kind: h.symbolKind, path: h.path, line: h.line, signature: h.snippet }, Infinity)
      }
      // 2) identifier search
      for (const s of this.store.symbolSearch(q, { limit: 40 })) addCandidate(s, Infinity)
      // 3) callables of the full-text page hits (rank = their page position)
      const pageHits = this.store.searchPages(q, { limit: 40 })
      for (let i = 0; i < pageHits.length; i++) {
        const p = pageHits[i]
        if (!p.pageId.startsWith('file:') || !p.path) continue
        for (const s of this.store.symbolsForPage(p.pageId)) addCandidate(s, i)
      }
      if (pool.length > 120) pool.length = 120
      // Body-only evidence: the 3 best-ranked files, at most 40 candidates.
      const byRank = pool.slice().sort((a, b) => a.fileRank - b.fileRank || a.path.localeCompare(b.path) || a.line - b.line)
      const bodyFiles = []
      for (const c of byRank) {
        if (!bodyFiles.includes(c.path)) bodyFiles.push(c.path)
        if (bodyFiles.length === 3) break
      }
      const bodyFileSet = new Set(bodyFiles)
      let bodyBudget = 40
      const linesByPath = new Map()
      const wordsBySym = new Map()
      const bodyWordsFor = (c) => {
        if (!bodyFileSet.has(c.path) || bodyBudget <= 0) return null
        if (wordsBySym.has(c.key)) return wordsBySym.get(c.key)
        bodyBudget--
        let fileLines = linesByPath.get(c.path)
        if (fileLines === undefined) {
          try { fileLines = fs.readFileSync(path.join(this.root, c.path)).toString('utf8').split('\n') } catch { fileLines = null }
          linesByPath.set(c.path, fileLines)
        }
        let words = null
        if (fileLines) {
          const sl = sliceSymbol(fileLines, c.line, langOf(c.path) || 'js')
          words = new Set(fileLines.slice(sl.start, sl.end).join('\n').toLowerCase().split(/[^a-z0-9_$]+/))
        }
        wordsBySym.set(c.key, words)
        return words
      }
      for (const c of pool) c.score = scoreBodyCandidate(c, terms, bodyWordsFor(c))
      pool.sort((a, b) => b.score - a.score || a.tier - b.tier || a.fileRank - b.fileRank || a.path.length - b.path.length || a.path.localeCompare(b.path) || a.line - b.line)
      const chosen = pool[0]
      if (!chosen || chosen.score < 2) {
        const noneText = 'body: none — no source callable matches; fault the hit you need'
        bodySection = { ok: false, reason: 'no-match', target: null, tokens: estTokens(noneText), text: noneText }
        text += `\n\n${noneText}`
        tokens += bodySection.tokens
      } else {
        const f = this.fault(`${chosen.path}#${chosen.name}`, { budget: DEFAULTS.fault, deep })
        bodySection = f.ok
          ? { ok: true, target: chosen.name, symbol: chosen.name, path: f.path ?? chosen.path, tokens: f.tokens, text: f.text }
          : { ok: false, target: chosen.name, error: f.error }
        if (bodySection.ok) {
          text += `\n\nbody: ${bodySection.symbol} (${bodySection.tokens} tok)\n${bodySection.text}`
          tokens += bodySection.tokens
        }
      }
    }
```

Also delete the now-dead comment lines directly above the old block (`// \`--body\`: locate *and* materialise…` through `// tests are fallbacks…`, lines 633–642) — the new block carries its own comment.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/retrieval.test.mjs`
Expected: all tests pass, including the six new ones and the three pre-existing `--body` tests (lines 370, 419, 445).

- [ ] **Step 6: Spot-check the two baseline repros on the real repo**

Run:
```bash
node bin/memai.mjs query "dispatch result text content wrap reply page" --text --body | grep -E "^body:|^sym file:mcp/tools"
node bin/memai.mjs query "how does fault decide a slice is complete" --text --body | grep -E "^body:|^body-miss|^sym file:src/page"
```
Expected: first call's `body:` line names `dispatch`; second call names a `src/page.mjs` symbol (e.g. `fault` or `_faultSymbol`) or `body: none` — never `pageTextVersion` or `isAppError`.

- [ ] **Step 7: Commit**

```bash
git add src/page.mjs test/retrieval.test.mjs
git commit -m "fix(query): evidence-based body pick with a no-match floor"
```

---

### Task 3: Fix 2 — `_faultLine` returns the enclosing symbol

**Files:**
- Modify: `src/page.mjs` (add module `isCodeSym` near the body-pick helpers; delete the local `isCodeSym` in `_deepContext` at line 376; replace `_faultLine`, lines 474–487)
- Test: `test/staleness.test.mjs` (replace the test at lines 130–141; add five tests after it)

**Interfaces:**
- Consumes: module `isCodeSym` (defined in this task), `sliceSymbol`, `langOf`, `fitWithHeader`, `this.store.symbolsForPage`, `this._fileStale`.
- Produces: `_faultLine(p, line, {budget})` result — `{ok:true, target, mode:'line', path, line, lineEnd, symbol?, symbolKind?, requestedLine, stale, tokens, budget, truncated, text}` where `line`/`lineEnd` are the returned range. Nothing else consumes `_faultLine` besides `fault()` dispatch.

- [ ] **Step 1: Rewrite/replace the failing tests**

In `test/staleness.test.mjs`, replace the whole test `fault path:line reply carries lineEnd and staleness` (lines 130–141) with the six tests below. The file's helpers `indexedProject`, `cleanup`, `fs`, `path`, `MemoryStore`, `MemoryPages`, `tempDir` already exist.

```js
test('fault path:line returns the enclosing symbol', async () => {
  const { root, store, pages } = await indexedProject()
  try {
    // auth.js lines: 4-7 verifyToken, so :4 is the symbol's first line.
    const f = pages.fault('src/auth.js:4')
    assert.ok(f.ok, f.error)
    assert.equal(f.mode, 'line')
    assert.equal(f.symbol, 'verifyToken')
    assert.equal(f.line, 4)
    assert.equal(f.lineEnd, 7)
    assert.equal(f.truncated, false)
    assert.equal(f.requestedLine, 4)
    assert.match(f.text, /\(complete\)/)
    assert.ok(!f.text.includes('(window)'))
    assert.equal(f.stale, false)
  } finally { store.close() }
})

test('fault path:line mid-symbol still returns the whole symbol', async () => {
  const { store, pages } = await indexedProject()
  try {
    const f = pages.fault('src/auth.js:6')
    assert.ok(f.ok, f.error)
    assert.equal(f.symbol, 'verifyToken')
    assert.equal(f.line, 4)
    assert.equal(f.lineEnd, 7)
    assert.match(f.text, /\(complete\)/)
    assert.match(f.text, /\(requested line 6\)/)
    assert.match(f.text, /token\.split/)
  } finally { store.close() }
})

test('fault path:line on an oversized symbol labels the rest and the truncation', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"line-big","version":"1.0.0","type":"module"}')
  const big = ['// big fixture', 'export function bigThing(input) {']
  for (let i = 0; i < 38; i++) big.push(`  const step${i} = input + ${i}`)
  big.push('  return step0', '}', '')
  fs.writeFileSync(path.join(root, 'src', 'big.js'), big.join('\n'))
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  try {
    // bigThing spans lines 2-42 (~290 tokens): the whole never fits 150.
    const rest = pages.fault('src/big.js:30', { budget: 150 })
    assert.ok(rest.ok, rest.error)
    assert.equal(rest.symbol, 'bigThing')
    assert.equal(rest.line, 30)
    assert.equal(rest.lineEnd, 42)
    assert.match(rest.text, /\(rest of bigThing; starts at 2\)/)
    assert.ok(!rest.text.includes('(complete)'))

    const cut = pages.fault('src/big.js:2', { budget: 150 })
    assert.ok(cut.ok, cut.error)
    assert.match(cut.text, /\(truncated: \d+ more lines of bigThing, which ends at 42\)/)
    assert.ok(cut.lineEnd < 42)
    assert.ok(!cut.text.includes('(complete)'))
    assert.ok(!cut.text.includes('(rest of'))
  } finally { store.close() }
})

test('fault path:line outside symbols keeps the window and names a continuing symbol', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"line-window","version":"1.0.0","type":"module"}')
  const w = ['// window fixture', 'export function tiny() {', '  return 1', '}', '']
  w.push('export function longThing(a) {')
  for (let i = 0; i < 69; i++) w.push(`  const x${i} = a + ${i}`)
  w.push('  return x0', '}', '')
  fs.writeFileSync(path.join(root, 'src', 'w.js'), w.join('\n'))
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  try {
    // Line 5 sits between tiny (2-4) and longThing (6-77); the window 5-64 cuts longThing.
    const f = pages.fault('src/w.js:5', { budget: 400 })
    assert.ok(f.ok, f.error)
    assert.equal(f.mode, 'line')
    assert.equal(f.line, 5)
    assert.equal(f.lineEnd, 64)
    assert.match(f.text, /\(window\)/)
    assert.match(f.text, /\(longThing continues to 77\)/)
    assert.equal(f.symbol, undefined)
  } finally { store.close() }
})

test('fault path:line on a markdown file stays a window', async () => {
  const { store, pages } = await indexedProject()
  try {
    const f = pages.fault('docs/auth.md:1')
    assert.ok(f.ok, f.error)
    assert.equal(f.mode, 'line')
    assert.match(f.text, /\(window\)/)
  } finally { store.close() }
})

test('fault path:line after an unindexed edit degrades to a stale window', async () => {
  const { root, store, pages } = await indexedProject()
  try {
    const file = path.join(root, 'src', 'auth.js')
    fs.writeFileSync(file, '// shifted\n// shifted\n' + fs.readFileSync(file, 'utf8'))
    const f = pages.fault('src/auth.js:6')
    assert.ok(f.ok, f.error)
    assert.match(f.text, /\(window\)/)
    assert.match(f.text, /STALE: file changed since index/)
  } finally { store.close() }
})
```

- [ ] **Step 2: Run to verify they fail on the old `_faultLine`**

Run: `node --test test/staleness.test.mjs`
Expected: the first two new tests FAIL (`symbol` undefined, `lineEnd` 18 ≠ 7, no `(complete)`); the oversized test FAILS (`(rest of …)` absent); the window test FAILS (no `continues to` note). The markdown and stale tests may pass on the old code (guards). All other staleness tests pass.

- [ ] **Step 3: Add module `isCodeSym` and remove the local copy**

Insert after `commonPrefix` in `src/page.mjs` (the helpers added in Task 2):

```js
/** Symbols whose slice can stand in for a body: code declarations, not
 *  prose headings or test names. */
const isCodeSym = (r) => ['function', 'method', 'class', 'type', 'route', 'export'].includes(r.kind)
```

Delete line 376 (`const isCodeSym = (r) => […].includes(r.kind)`) inside `_deepContext` — the module-level copy is identical, so `_deepContext`'s three uses resolve to it.

- [ ] **Step 4: Replace `_faultLine`**

Replace the whole method (lines 474–487) with:

First add a module-scope helper next to `fitWithHeader` (a class body cannot hold a bare `const`):

```js
/** Last `NNN| ` line number appearing in a numbered fault slice. */
const lastShownLine = (text) => {
  let last = null
  for (const m of String(text).matchAll(/^(\d+)\| /gm)) last = Number(m[1])
  return last
}
```

Then replace the whole `_faultLine` method (lines 474–487) with:

```js
  _faultLine(p, line, { budget }) {
    const f = this._findFile(p)
    if (!f) return { ok: false, error: `no such file: ${p}`, tokens: 0 }
    let buf
    try { buf = fs.readFileSync(path.join(this.root, f.path)) } catch { return { ok: false, error: `file vanished: ${f.path}`, tokens: 0 } }
    const lines = buf.toString('utf8').split('\n')
    const s = this._fileStale(f)
    const stale = s ? s.stale : null
    const staleNote = stale ? '  [STALE: file changed since index — lines approximate]' : ''
    const lang = langOf(f.path) || 'js'
    // Enclosing indexed symbol: innermost start <= line whose name still sits
    // on its recorded line and whose slice covers the line. `(complete)` means
    // the same thing in every fault mode: the slice is the whole symbol.
    const syms = this.store.symbolsForPage(f.page_id).filter(isCodeSym).sort((a, b) => b.line - a.line)
    let enc = null
    let encSlice = null
    for (const sym of syms) {
      if (sym.line > line) continue
      if (!String(lines[sym.line - 1] ?? '').includes(sym.name)) continue
      const sl = sliceSymbol(lines, sym.line, lang)
      if (line < sl.end) { enc = sym; encSlice = sl; break }
    }
    if (enc) {
      const whole = lines.slice(encSlice.start, encSlice.end).join('\n')
      const reqNote = line > enc.line ? `  (requested line ${line})` : ''
      const rWhole = fitWithHeader(whole, budget, (b) =>
        `# fault ${enc.name} (${enc.kind}) ${f.path}:${enc.line}-${encSlice.end}  ${encSlice.end - enc.line}L  tokens=${b.tokens}/${budget}  (complete)${staleNote}${reqNote}`)
      if (!rWhole.truncated) {
        return { ok: true, target: `${p}:${line}`, mode: 'line', path: f.path, line: enc.line, lineEnd: encSlice.end, symbol: enc.name, symbolKind: enc.kind, requestedLine: line, stale, tokens: rWhole.tokens, budget, truncated: false, text: rWhole.text }
      }
      const restText = lines.slice(line - 1, encSlice.end).map((l, i) => `${line + i}| ${l}`).join('\n')
      const rRest = fitWithHeader(restText, budget, (b) => {
        const shownEnd = b.truncated ? lastShownLine(b.text) ?? line : encSlice.end
        const label = b.truncated
          ? `(truncated: ${encSlice.end - shownEnd} more lines of ${enc.name}, which ends at ${encSlice.end})`
          : `(rest of ${enc.name}; starts at ${enc.line})`
        return `# fault ${f.path}:${line}  showing ${line}-${shownEnd} of ${lines.length}  tokens=${b.tokens}/${budget}  ${label}${staleNote}`
      })
      const shownEnd = rRest.truncated ? lastShownLine(rRest.text) ?? line : encSlice.end
      return { ok: true, target: `${p}:${line}`, mode: 'line', path: f.path, line, lineEnd: shownEnd, symbol: enc.name, symbolKind: enc.kind, requestedLine: line, stale, tokens: rRest.tokens, budget, truncated: rRest.truncated, text: rRest.text }
    }
    // Not inside a symbol: the historical 60-line window.
    const from = Math.max(0, line - 1)
    const to = Math.min(lines.length, from + 60)
    let contName = null
    let contEnd = null
    let contLine = 0
    for (const sym of syms) {
      if (sym.line <= from || sym.line > to) continue
      if (!String(lines[sym.line - 1] ?? '').includes(sym.name)) continue
      const sl = sliceSymbol(lines, sym.line, lang)
      if (sl.end > to && sym.line > contLine) { contName = sym.name; contEnd = sl.end; contLine = sym.line }
    }
    const code = lines.slice(from, to).map((l, i) => `${from + i + 1}| ${l}`).join('\n')
    const r = fitWithHeader(code, budget, (b) => {
      const shownEnd = b.truncated ? lastShownLine(b.text) ?? (from + 1) : to
      let label = b.truncated ? `(truncated: ${to - shownEnd} more lines of this window)` : '(window)'
      if (!b.truncated && contName) label += `  (${contName} continues to ${contEnd})`
      return `# fault ${f.path}:${line}  showing ${from + 1}-${shownEnd} of ${lines.length}  tokens=${b.tokens}/${budget}  ${label}${staleNote}`
    })
    const shownEnd = r.truncated ? lastShownLine(r.text) ?? (from + 1) : to
    return { ok: true, target: `${p}:${line}`, mode: 'line', path: f.path, line: from + 1, lineEnd: shownEnd, requestedLine: line, stale, tokens: r.tokens, budget, truncated: r.truncated, text: r.text }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/staleness.test.mjs && node --test test/retrieval.test.mjs`
Expected: all pass in both files (the `fault --deep` same-file-caller test in retrieval uses `_rgSearch`, unaffected).

- [ ] **Step 6: Spot-check on the real repo**

Run: `node bin/memai.mjs fault src/page.mjs:570 --text | head -2`
Expected: header names `query`, spans `570-688`, and ends `(complete)` — no `showing … of 1172` window.

- [ ] **Step 7: Commit**

```bash
git add src/page.mjs test/staleness.test.mjs
git commit -m "fix(fault): line faults return the enclosing symbol"
```

---

### Task 4: Eval body metric

**Files:**
- Modify: `src/page.mjs` (`evaluate()`, lines 899–925)
- Test: `test/navigation.test.mjs` (new test after the existing eval test, ends line 152)

**Interfaces:**
- Consumes: Task 2's query body contract (`r.body.ok`, `r.body.path`).
- Produces: `evaluate(fixtures, {k, modes})` gains `results.body = {recallAtK, hits, total, rows}` (rows `{q, expect, hit, got}`); text gains `body: file=<pct>%  (<n>/<total>)` and `body-miss: "<q>" → expected <expect>, got <path>|none` lines. Task 5's gate reads the text line; the CI eval smoke is unaffected (additive).

- [ ] **Step 1: Write the failing test**

Add to `test/navigation.test.mjs` directly after the test ending at line 152:

```js
test('eval: body metric counts bodies from the expected file', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  makeCorpus(root)
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 500 })
  try {
    const r = pages.evaluate([
      { q: 'verifyToken', expect: 'src/auth.js' },
      { q: 'totally unrelated xyzzy', expect: 'src/auth.js' },
    ], { modes: ['index'] })
    assert.ok(r.ok)
    assert.equal(r.results.body.total, 2)
    assert.equal(r.results.body.hits, 1)
    assert.match(r.text, /body: file=50%  \(1\/2\)/)
    assert.match(r.text, /body-miss: "totally unrelated xyzzy" → expected src\/auth\.js, got none/)
  } finally { store.close() }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/navigation.test.mjs`
Expected: FAIL — `r.results.body` is `undefined`.

- [ ] **Step 3: Extend `evaluate()`**

Replace the whole method (lines 899–925) with:

```js
  evaluate(fixtures, { k = 5, modes = ['index', 'hybrid'] } = {}) {
    if (!Array.isArray(fixtures) || !fixtures.length) return { ok: false, error: 'no fixtures', tokens: 0 }
    const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
    const results = {}
    for (const mode of modes) {
      let hits = 0
      let mrrSum = 0
      const rows = []
      for (const fx of fixtures) {
        const r = this.query(String(fx.q), { k, rg: mode === 'hybrid' })
        const expect = norm(fx.expect)
        const rank = r.hits.findIndex((h) => {
          const hp = norm(h.path)
          return hp === expect || hp.endsWith('/' + expect)
        })
        if (rank >= 0) { hits++; mrrSum += 1 / (rank + 1) }
        rows.push({ q: String(fx.q), expect, hit: rank >= 0, rank: rank >= 0 ? rank + 1 : null })
      }
      results[mode] = { recallAtK: hits / fixtures.length, mrr: mrrSum / fixtures.length, hits, total: fixtures.length, rows }
    }
    // Body metric (0.12.0): does `--body` pick a body from the expected file?
    let bodyHits = 0
    const bodyRows = []
    for (const fx of fixtures) {
      const r = this.query(String(fx.q), { k, body: true })
      const expect = norm(fx.expect)
      const got = r.body?.ok ? norm(r.body.path) : 'none'
      const hit = got !== 'none' && (got === expect || got.endsWith('/' + expect))
      if (hit) bodyHits++
      bodyRows.push({ q: String(fx.q), expect, hit, got })
    }
    results.body = { recallAtK: bodyHits / fixtures.length, hits: bodyHits, total: fixtures.length, rows: bodyRows }
    const lines = [`# eval — ${fixtures.length} fixtures, k=${k}`]
    for (const mode of modes) {
      const r = results[mode]
      lines.push(`${mode}: recall@${k}=${Math.round(r.recallAtK * 100)}%  mrr=${r.mrr.toFixed(2)}  (${r.hits}/${r.total})`)
    }
    lines.push(`body: file=${Math.round(results.body.recallAtK * 100)}%  (${bodyHits}/${fixtures.length})`)
    const first = results[modes[0]]
    for (const row of first?.rows ?? []) if (!row.hit) lines.push(`miss: "${row.q}" → expected ${row.expect}`)
    for (const row of bodyRows) if (!row.hit) lines.push(`body-miss: "${row.q}" → expected ${row.expect}, got ${row.got}`)
    const text = lines.join('\n')
    return { ok: true, k, results, tokens: estTokens(text), text }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/navigation.test.mjs`
Expected: PASS — the new test and the pre-existing eval test (`results.index.recallAtK` between 0.6 and 0.7) both hold.

- [ ] **Step 5: Commit**

```bash
git add src/page.mjs test/navigation.test.mjs
git commit -m "feat(eval): body-from-expected-file metric"
```

---

### Task 5: Static gates + picker iteration

**Files:**
- Read-only over: `src/page.mjs` (weight tweaks only if the gate misses)
- Create (untracked): `.tmp/120-after-body-ext.json`, `.tmp/120-after-body-shipped.json`

**Interfaces:**
- Consumes: `tools/body-eval.mjs` (Task 1), baseline rows `.tmp/120-base-body-*.json` (Task 1), `evaluate()` (Task 4).
- Produces: the recorded after-numbers used verbatim by Task 8's benchmark record: ext body `N/40`, shipped body `N/12`, recall/MRR per mode, the right→wrong diff, and (if iterations happened) each weight delta.

- [ ] **Step 1: Stop the resident watcher for this tree**

Run: `node bin/memai.mjs watch --stop && node bin/memai.mjs index`
Expected: watcher stops (restart later with `watch --ensure`); index exits 0 with the version hash.

- [ ] **Step 2: Run both evals**

Run:
```bash
node bin/memai.mjs eval --fixtures bench/eval-fixtures.json --k 5 --text
node bin/memai.mjs eval --fixtures bench/eval-fixtures-ext.json --k 5 --text
```
Expected against the gate table:
- shipped: `index: recall@5=100%`, `hybrid` recall 100 %, MRR 0.80/0.74, `body: file=100%  (12/12)`
- extended: `index` recall 85 % MRR 0.61, `hybrid` recall 90 % MRR 0.57, `body: file>=85%  (>=34/40)`

- [ ] **Step 3: Right→wrong diff against the baseline rows**

Run:
```bash
node tools/body-eval.mjs bench/eval-fixtures-ext.json --out .tmp/120-after-body-ext.json > /dev/null
node tools/body-eval.mjs bench/eval-fixtures.json --out .tmp/120-after-body-shipped.json > /dev/null
node --no-warnings -e "
const fs = require('node:fs')
for (const name of ['ext', 'shipped']) {
  const base = JSON.parse(fs.readFileSync('.tmp/120-base-body-' + name + '.json', 'utf8'))
  const after = JSON.parse(fs.readFileSync('.tmp/120-after-body-' + name + '.json', 'utf8'))
  const regressed = base.filter((b, i) => b.ok && b.path === b.expect && !(after[i].ok && after[i].path === after[i].expect))
  console.log(name, 'right->wrong:', regressed.length, regressed.map((r) => r.q).join('; '))
}
"
```
Expected: `ext right->wrong: 0` and `shipped right->wrong: 0`.

- [ ] **Step 4: Full test suite + selftest + cost check**

Run:
```bash
npm test
npm run selftest
node bench/cost.mjs --check
```
Expected: `npm test` green (121+ tests), selftest `18/18`, cost check exit 0 (no surface has grown yet).

- [ ] **Step 5: If the body gate missed — iterate weights one at a time**

Only if `body: file` < 34/40 ext or < 12/12 shipped. Adjust exactly one lever in `src/page.mjs`, re-run Step 2 + Step 3, and note the delta for the benchmark record. Levers in priority order:

1. Prefix rule cheaper: `cp >= 4 && cp * 10 >= 6 * Math.min(...)` → `cp >= 3 && cp * 10 >= 6 * Math.min(...)` (promotes near-name matches like `distil`→`distilFile`).
2. Substring weight 1 → 2 (line `if (!m && t.length >= 5 && lowName.includes(t)) m = 1`).
3. Floor 2 → 3 (line `chosen.score < 2`), trading recall for fewer wrong picks.
4. Body-only bonus applied to the 6 best-ranked files (`bodyFiles.length === 3` → 6, `bodyBudget` 40 → 60).

Stop at the first configuration that passes all gates with 0 right→wrong; record every tried configuration and its delta in `.tmp/120-iterations.md` (one line each: lever, before, after). If no configuration passes, **stop**: `git revert` the Task 2 and Task 4 commits, record `bench/NEGATIVE-body-pick.md` with the raw eval output, and report the discard to the user per the spec. The fixes ship independently: fix 2 (Task 3) is unaffected by this discard — ask the user whether to release fix 2 alone; if yes, run Task 6 with only the line-fault wording edit (skip both body-wording replacements), Task 7, and Task 8 with a CHANGELOG/BENCHMARK describing only fix 2.

- [ ] **Step 6: Record the gate numbers**

Write `.tmp/120-gate.md` with the exact outputs of Steps 2–4 (paste the eval text blocks and the diff lines). Task 8 copies these numbers into `bench/BENCHMARK-0.12.0-body-pick.md` — keep the file until Task 8 is done.

---

### Task 6: Instruction-surface wording (accuracy-only, token-neutral)

**Files:**
- Modify: `skills/memai/SKILL.md` (lines 63–64 and 69)
- Modify: `mcp/tools.mjs` (the `body` param description at line 80; the `mem_query` description at line 139)

**Interfaces:**
- Consumes: the new reply shapes from Tasks 2/3 (`body: none`, `(rest of …)`, `(window)`).
- Produces: wording that stays true of the new behaviour; net character delta ≤ 0 on the MCP schema so `bench/cost.mjs --check` keeps passing. Skill **body** text is not cost-tracked (only its frontmatter is), but keep rewraps to the same two lines anyway.

- [ ] **Step 1: Skill edits**

In `skills/memai/SKILL.md`, replace:

```
   Add `"body": true` (CLI `--body`) to get the top symbol's body in the same call — one model
   turn instead of query + fault.
```

with:

```
   Add `"body": true` (CLI `--body`) to get the best-matching source body in the same call — one
   model turn instead of query + fault.
```

and replace:

```
   - `{"op":"fault","target":"src/auth.js:120"}` — one line range.
```

with:

```
   - `{"op":"fault","target":"src/auth.js:120"}` — the symbol containing that line, or a window outside symbols.
```

- [ ] **Step 2: Schema edits**

In `mcp/tools.mjs` line 80, replace the description value:

```
'query: also return the top symbol body in the same call — locate and read in one model turn.'
```

with:

```
'query: also return the best-match source body in one call — locate and read in one turn.'
```

In `mcp/tools.mjs` line 139 (inside the `mem_query` description), replace:

```
body: true also returns the top symbol body — locate and read in one call. Use to locate a symbol or feature, then fetch the winner with mem_fault.
```

with:

```
body: true also returns the best-match source body — locate and read in one call. Locate a symbol or feature, then fetch the winner with mem_fault.
```

- [ ] **Step 3: Verify zero growth and green tests**

Run:
```bash
node bench/cost.mjs --check
npm test
```
Expected: cost check exit 0 (schema row ≤ 1,058 tokens: the two replacements are net −4 chars); tests green (`test/surfaces.test.mjs` still passes — versions untouched in this task).

- [ ] **Step 4: Commit**

```bash
git add skills/memai/SKILL.md mcp/tools.mjs
git commit -m "docs(skill+schema): accurate wording for body and line faults"
```

---

### Task 7: Live A/B — composite set, no-regression gate

**Files:**
- Create: scratch worktrees `D:/Projects/MemAi-120base` and `D:/Projects/MemAi-120treat` (removed at the end)
- Create: `bench/cost-ab-<date>-composite-0120.json` + `.md` (written by the runner; committed in Task 8)

**Interfaces:**
- Consumes: `tools/cost-ab.mjs` (`TASK_SETS.composite`, `--swap-config`), the gotchas: identical corpus in both arms, watchers stopped, config hash verified, restore before removing worktrees.
- Produces: the live A/B record and verdict (no-regression only — never claimed as a saving).

- [ ] **Step 1: Snapshot the global config hash**

Run: `sha1sum "$USERPROFILE/.zcode/cli/config.json"`
Record the hash — it must be identical after the run.

- [ ] **Step 2: Build identical arms**

Run:
```bash
git worktree add ../MemAi-120base c94cf62
git worktree add ../MemAi-120treat fix/body-pick-and-line-fault
```
Then in **both** arm directories:
```bash
cp -r /d/Projects/MemAi/docs /d/Projects/MemAi/bench /d/Projects/MemAi/test /d/Projects/MemAi/tools .
rm -rf docs/superpowers
node bin/memai.mjs watch --stop
node bin/memai.mjs index
```
(The arms already contain docs/bench/test/tools from the checkout; the `cp -r` re-syncs them to the identical working-tree versions, `rm -rf docs/superpowers` drops the plan/spec docs from BOTH arms so prompts can't hit them. If `cp -r docs` copied a `superpowers` dir, the `rm` removes it after.)

Verify identical file lists:
```bash
cd /d/Projects/MemAi-120base && git ls-files > /tmp/120-base-files.txt
cd /d/Projects/MemAi-120treat && git ls-files > /tmp/120-treat-files.txt
diff /tmp/120-base-files.txt /tmp/120-treat-files.txt
```
Expected: no diff output.

- [ ] **Step 3: Run the A/B**

Run:
```bash
cd /d/Projects/MemAi
node tools/cost-ab.mjs --baseline D:/Projects/MemAi-120base --treatment D:/Projects/MemAi-120treat --tasks composite --swap-config
```
Expected: the runner prints per-task rows for C1/C2 and a verdict. Gate: `verdict.ok === true` (no task above +1 % tolerance, none with more calls). Copy the produced `bench/cost-ab-<date>-composite*.json`/`.md` paths for Task 8.

- [ ] **Step 4: On a failed task — re-run for samples before a verdict**

If `verdict.ok` is false, re-run Step 3 up to 3 times total (the runner rewrites its dated output; keep all JSONs). Verdict rule: if any task stays above +1 % or above its baseline call count in the majority of samples, the live gate fails → revert the Task 6 wording commits (`git revert <task-6-commit>`) as the likely cause, re-run once more; if it still fails, discard per spec and report to the user. Do not claim any saving from this run regardless of outcome.

- [ ] **Step 5: Restore and clean up**

Run:
```bash
sha1sum "$USERPROFILE/.zcode/cli/config.json"   # must equal the Step 1 hash; if not: node tools/zcode-config.mjs --restore
cd /d/Projects/MemAi-120base && node bin/memai.mjs watch --stop || true
cd /d/Projects/MemAi-120treat && node bin/memai.mjs watch --stop || true
cd /d/Projects/MemAi
git worktree remove ../MemAi-120base
git worktree remove ../MemAi-120treat
node bin/memai.mjs watch --ensure
```
Expected: config hash matches Step 1; both worktrees gone; resident watcher running again on the main checkout.

---

### Task 8: Release 0.12.0

**Files:**
- Modify: `package.json` (line 3), `src/mem-cli.mjs` (line 14), `mcp/paths.mjs` (line 27), `skills/memai/SKILL.md` (line 7)
- Modify: `CHANGELOG.md` (new section at the top of the `##` list), `README.md` (one additive line under the eval results table), `bench/BENCHMARK-0.12.0-body-pick.md` (create)

**Interfaces:**
- Consumes: `.tmp/120-gate.md` (Task 5), the A/B artifacts (Task 7).
- Produces: the release commit; `npm test`'s `surfaces` assertions pin 0.12.0 everywhere.

- [ ] **Step 1: Version bump in 4 files**

```bash
# package.json:   "version": "0.11.0",  ->  "version": "0.12.0",
# src/mem-cli.mjs:14  export const VERSION = '0.11.0'  ->  '0.12.0'
# mcp/paths.mjs:27    export const VERSION = '0.11.0'  ->  '0.12.0'
# skills/memai/SKILL.md:7  version: "0.11.0"  ->  version: "0.12.0"
```

- [ ] **Step 2: CHANGELOG entry**

Insert directly below the first `## ` heading region of `CHANGELOG.md` (match the neighbouring heading style exactly; if the file starts with an intro paragraph, insert after it):

```markdown
## 0.12.0 — correctness: body pick and line fault

- `query --body` picks the body by identifier evidence — whole-name/segment/prefix
  matches with stopwords dropped, file rank, and body-only terms — with a
  confidence floor: below it the reply says `body: none` instead of guessing a
  tiny unrelated function. Body-from-expected-file on the eval fixtures:
  extended 23 → <EXT_AFTER> of 40, shipped 10 → 12 of 12.
- `fault <path>:<line>` returns the enclosing indexed symbol: `(complete)` only
  when the whole symbol is shown, `(rest of …)`/`(truncated: …)` inside an
  oversized symbol, `(window)` outside symbols. The 60-line mid-function window
  previously printed `(complete)`.
- `memai eval` reports the body metric (`body: file=N%`, `body-miss:` lines);
  `tools/body-eval.mjs` is the standalone probe.
- Recall/MRR unchanged: shipped 100 % (MRR 0.80/0.74), extended 85/90 %.
- Live composite A/B: no task above tolerance (see `bench/cost-ab-*-composite-0120.*`).
```

Fill `<EXT_AFTER>` with the Task 5 ext count (expected 34–40). If the shipped count is not 12, the gate already failed in Task 5 — do not release.

- [ ] **Step 3: Benchmark record**

Create `bench/BENCHMARK-0.12.0-body-pick.md`:

```markdown
# MemAi 0.12.0 — body pick + line fault correctness

Date: <YYYY-MM-DD>. Baseline `c94cf62` (0.11.0) vs `fix/body-pick-and-line-fault`.
Estimator `ceil(chars/3.966)`; all eval numbers local, no model calls.

## Gate results

| metric | baseline | 0.12.0 | gate |
| --- | ---: | ---: | --- |
| body from expected file, extended (40) | 23 | <EXT_AFTER> | ≥ 34 |
| body from expected file, shipped (12) | 10 | 12 | 12 |
| fixtures right at baseline that turned wrong | — | 0 | 0 |
| recall@5 shipped (index/hybrid) | 100 % / 100 % | <paste> | identical |
| MRR shipped (index/hybrid) | 0.80 / 0.74 | <paste> | identical |
| recall@5 extended (index/hybrid) | 85 % / 90 % | <paste> | identical |
| MRR extended (index/hybrid) | 0.61 / 0.57 | <paste> | identical |

`<paste>` cells: copy from the Task 5 eval outputs (`.tmp/120-gate.md`).

## Reproduce

    node tools/body-eval.mjs bench/eval-fixtures-ext.json
    node bin/memai.mjs eval --fixtures bench/eval-fixtures-ext.json --k 5 --text
    node bin/memai.mjs eval --fixtures bench/eval-fixtures.json --k 5 --text

## Weight iterations

<One line per configuration tried in Task 5 Step 5: lever, before, after, delta.
If none: "none — the initial weights passed all gates.">

## Live A/B (no-regression gate)

<task-set composite, date, per-task billed input + calls for both arms, verdict.ok,
sample count. Paste the runner's summary table from the Task 7 artifacts. No
token saving is claimed from this run.>
```

- [ ] **Step 4: README additive line**

In `README.md`, directly below the existing eval results table (the table whose rows are the shipped/extended recall/MRR figures — find it with `grep -n "recall" README.md`), add one line:

```markdown
Body pick (`query --body` returning a body from the expected file): **23 → <EXT_AFTER>/40** extended, **12/12** shipped (0.12.0 `eval` body metric).
```

No existing figure is edited.

- [ ] **Step 5: Full gates on the release tree**

Run:
```bash
npm test
npm run selftest
node bench/cost.mjs --check
node bin/memai.mjs eval --fixtures bench/eval-fixtures.json --k 5 --text
node bin/memai.mjs eval --fixtures bench/eval-fixtures-ext.json --k 5 --text
```
Expected: all green; eval numbers identical to Task 5 (nothing ranking-related changed since).

- [ ] **Step 6: Commit**

```bash
git add package.json src/mem-cli.mjs mcp/paths.mjs skills/memai/SKILL.md CHANGELOG.md README.md bench/BENCHMARK-0.12.0-body-pick.md bench/cost-ab-*-composite-0120.json bench/cost-ab-*-composite-0120.md
git commit -m "release: 0.12.0 body pick and line fault"
```

---

### Task 9: PR (only after explicit user confirmation)

**Files:** none (remote operation)

**Interfaces:**
- Consumes: the release commit on `fix/body-pick-and-line-fault`.
- Produces: the PR the user merges.

- [ ] **Step 1: Ask the user to confirm the push**

Show repo (`ZrifBSofiane/MemAi`), base (`main`), head (`fix/body-pick-and-line-fault`), title and body summary, and wait for an explicit yes. Do not push without it.

- [ ] **Step 2: Push and open the PR (after confirmation)**

```bash
git push -u origin fix/body-pick-and-line-fault
gh pr create --base main --title "fix: evidence-based body pick and symbol-aware line faults (0.12.0)" --body "Correctness fixes gated by eval + live A/B. See bench/BENCHMARK-0.12.0-body-pick.md and the spec in docs/superpowers/specs/."
```

- [ ] **Step 3: Report**

Report the PR URL, the gate table, the A/B verdict, and remind: the user merges; after merge, `git fetch && git merge --ff-only origin/main`, refresh the global skill (`node bin/memai.mjs skill install --global --force`), and `watch --stop && watch --ensure`.
