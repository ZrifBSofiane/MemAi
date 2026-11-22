# MemAi Token-Savings Harness (Step 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore and extend the measurement tooling needed to gate the three token-savings levers, and publish a reproducible 0.7.0 baseline.

**Architecture:** Static measurement (`bench/cost.mjs`) reports fixed surfaces and delivered payload without any model calls; live measurement restores the ZCode session report and adds a two-worktree A/B runner (`tools/cost-ab.mjs`). The static bench is CI-checkable; the live runner is exercised in later plans.

**Tech Stack:** Node 24 ESM, `node:test`, `node:sqlite` (read-only over the ZCode app DB), SQLite FTS5, ZCode 0.17.x headless (`-p --cwd`).

## Global Constraints

- Node `>=22.13`; no new runtime dependencies.
- Token estimator is `estTokens` from `src/tokens.mjs` (`ceil(chars / 3.966)`), the same estimator used by every existing benchmark.
- Static bench (`bench/cost.mjs`) must make **no model calls and no network calls**.
- Tests run with `node --test "test/*.test.mjs"`; a single file with `node --test test/<name>.test.mjs`.
- Do not commit to `main`; work on `feat/token-harness` and let the user merge.
- Live commands in this plan are dry-run only. Real A/B runs happen in the payload/turns/overhead plans.
- The restored files come from `959654f^` (the commit before the guard removal). Do not re-implement them.
- Windows Git Bash is the shell; use forward slashes in commands and absolute paths in code.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `tools/zcode-session-report.mjs` | Read one ZCode session from the app DB: billed tokens, turns, tool calls, tool events, reads. Restored from history. |
| `test/session-report.test.mjs` | Hermetic SQLite fixture for the report tool. Restored from history, plus a `toolEvents` assertion. |
| `bench/cost.mjs` | Static cost model: fixed surfaces, delivered payload (JSON vs `--text`), turn model, baseline write/check. |
| `test/cost.test.mjs` | Fixture-project tests for `bench/cost.mjs`. |
| `bench/cost-baseline.json` | Generated baseline for `bench/cost.mjs --check`. |
| `bench/COST-BASELINE-0.7.0.md` | Human-readable baseline table and reproduce command. |
| `tools/cost-ab.mjs` | Live paired runner: same prompt, two worktrees, billed input from ZCode, gate verdict. |
| `test/cost-ab.test.mjs` | Pure tests for the gate and table renderer; no live calls. |
| `test/surfaces.test.mjs` | Version-agreement test between `package.json` and the skill frontmatter. |
| `package.json` | Add `bench:cost` and `bench:ab` scripts. |

---

### Task 1: Restore the session report and its test

**Files:**
- Create: `tools/zcode-session-report.mjs` (restored)
- Create: `test/session-report.test.mjs` (restored)

**Interfaces:**
- Produces: `sessionsSince({ dbPath, sinceMs, cwd }) -> {id, directory, title, created, parentId}[]`
- Produces: `sessionReport({ dbPath, sessionId }) -> {ok, session, turns, tokens, billedInput, toolCalls, reads, wholeFileReads, denyCount, denied}`
- Produces: `summaryText(report) -> string`

- [ ] **Step 1: Create the working branch**

```bash
cd /d/Projects/MemAi
git switch -c feat/token-harness
```

Expected: `Switched to a new branch 'feat/token-harness'`.

- [ ] **Step 2: Restore both files from history**

```bash
git checkout 959654f^ -- tools/zcode-session-report.mjs test/session-report.test.mjs
```

Expected: both paths appear in `git status --short` as new files.

- [ ] **Step 3: Run the restored test**

```bash
node --test test/session-report.test.mjs
```

Expected: 5 tests pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add tools/zcode-session-report.mjs test/session-report.test.mjs
git commit -m "tools: restore the ZCode session report for cost measurement"
```

---

### Task 2: Expose per-call tool events

The A/B runner needs each tool call's input to detect `--text` usage and to attribute turns. The restored report aggregates counts only.

**Files:**
- Modify: `tools/zcode-session-report.mjs` (parts loop and return object)
- Test: `test/session-report.test.mjs`

**Interfaces:**
- Produces: `sessionReport(...).toolEvents: {tool: string, input: object, status: string|null, outputBytes: number}[]`

- [ ] **Step 1: Write the failing test**

Append to `test/session-report.test.mjs`:

```js
test('toolEvents exposes per-call inputs for A/B attribution', () => {
  const dbPath = fixtureDb()
  const r = sessionReport({ dbPath, sessionId: 'sess_a' })
  assert.ok(Array.isArray(r.toolEvents), 'toolEvents is an array')
  assert.equal(r.toolEvents.filter((e) => e.tool === 'Read').length, 3)
  const fault = r.toolEvents.find((e) => e.tool === 'fault')
  assert.equal(fault.input.target, 'query')
  assert.equal(fault.status, 'completed')
  assert.ok(fault.outputBytes > 0)
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test test/session-report.test.mjs
```

Expected: the new test fails with `toolEvents is an array` (actual `undefined`); the other 5 pass.

- [ ] **Step 3: Implement**

In `tools/zcode-session-report.mjs`, find:

```js
    const reads = []
    const denied = []
    const calls = new Map()
```

Replace with:

```js
    const reads = []
    const denied = []
    const calls = new Map()
    const toolEvents = []
```

Then find:

```js
      entry.count += 1
      if (st.status === 'error') entry.errors += 1
      entry.outputBytes += typeof st.output === 'string' ? st.output.length : 0
      calls.set(d.tool, entry)
```

Replace with:

```js
      const outputBytes = typeof st.output === 'string' ? st.output.length : 0
      entry.count += 1
      if (st.status === 'error') entry.errors += 1
      entry.outputBytes += outputBytes
      calls.set(d.tool, entry)
      toolEvents.push({ tool: d.tool, input: st.input ?? {}, status: st.status ?? null, outputBytes })
```

Then find the return object's `toolCalls` line and add `toolEvents` immediately after it:

```js
      toolCalls: [...calls.values()].sort((a, b) => b.count - a.count),
      toolEvents,
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/session-report.test.mjs
```

Expected: 6 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add tools/zcode-session-report.mjs test/session-report.test.mjs
git commit -m "tools: expose per-call tool events in the session report"
```

---

### Task 3: Add the static cost bench

**Files:**
- Create: `bench/cost.mjs`
- Test: `test/cost.test.mjs`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces: `CANONICAL_CALLS` — six `{id, op, ...}` entries mirroring B1–B6.
- Produces: `measureSurfaces(pages, { skillPath, agents }) -> {schema, instructions, initBlock, skillFrontmatter, card, total}`.
- Produces: `measureCall(pages, call) -> {id, op, reported, jsonTokens, textTokens}`.
- Produces: `measure({ root, calls, skillPath, agents, turns }) -> {ok, root, surfaces, delivered, model}`.
- Produces: `turnModel(surfaces, turns) -> {turns, perRequest, once, total}`.
- Produces: `renderReport(report) -> string`.
- Produces: `baselineFrom(report) -> {surfaces, delivered}`.
- Produces: `compareBaseline(report, baseline) -> violation[]`.
- CLI flags: `--root`, `--turns`, `--json`, `--write-baseline`, `--check`.

- [ ] **Step 1: Write the failing test**

Create `test/cost.test.mjs`:

```js
// Static cost-bench tests: a hermetic fixture project, no model calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDir } from '../scripts/test-helpers.mjs'
import { MemoryStore } from '../src/store.mjs'
import { MemoryPages } from '../src/page.mjs'
import { measure, renderReport, baselineFrom, compareBaseline } from '../bench/cost.mjs'

const cleanup = []
test.after(() => { for (const d of cleanup) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* windows */ } } })

async function fixture() {
  const root = tempDir()
  cleanup.push(root)
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"cost-fixture","version":"1.0.0","type":"module"}')
  fs.writeFileSync(path.join(root, 'src', 'auth.js'), [
    'export const TOKEN_TTL = 60',
    'export function verifyToken(token) {',
    "  const [head] = token.split('.')",
    "  return head === 'ok'",
    '}',
    '',
  ].join('\n'))
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  store.close()
  return root
}

const CALLS = [
  { id: 'q1', op: 'query', q: 'verifyToken' },
  { id: 'f1', op: 'fault', target: 'verifyToken' },
  { id: 'g1', op: 'graph', target: 'src/auth.js' },
]

test('measure reports every fixed surface and a total', async () => {
  const root = await fixture()
  const r = measure({ root, calls: CALLS, turns: 10 })
  assert.equal(r.ok, true)
  for (const k of ['schema', 'instructions', 'initBlock', 'skillFrontmatter', 'card']) {
    assert.ok(r.surfaces[k] > 0, `${k} must be positive`)
  }
  const sum = r.surfaces.schema + r.surfaces.instructions + r.surfaces.initBlock + r.surfaces.skillFrontmatter + r.surfaces.card
  assert.equal(r.surfaces.total, sum)
  assert.equal(r.model.turns, 10)
  assert.equal(r.model.perRequest, r.surfaces.schema + r.surfaces.initBlock + r.surfaces.skillFrontmatter)
  assert.equal(r.model.once, r.surfaces.instructions + r.surfaces.card)
})

test('text payload is never larger than the JSON envelope', async () => {
  const root = await fixture()
  const r = measure({ root, calls: CALLS })
  assert.equal(r.delivered.length, 3)
  for (const d of r.delivered) {
    assert.ok(d.textTokens > 0, `${d.id} text tokens`)
    assert.ok(d.textTokens <= d.jsonTokens, `${d.id}: text ${d.textTokens} > json ${d.jsonTokens}`)
  }
})

test('renderReport names the surfaces and every call', async () => {
  const root = await fixture()
  const out = renderReport(measure({ root, calls: CALLS }))
  assert.match(out, /schema \d+/)
  assert.match(out, /q1/)
  assert.match(out, /turn model/)
})

test('compareBaseline reports growth per surface and per call', async () => {
  const root = await fixture()
  const r = measure({ root, calls: CALLS })
  const base = baselineFrom(r)
  assert.deepEqual(compareBaseline(r, base), [])
  const shrunk = JSON.parse(JSON.stringify(base))
  shrunk.surfaces.schema = Math.max(1, shrunk.surfaces.schema - 1)
  shrunk.delivered[0].textTokens = Math.max(1, shrunk.delivered[0].textTokens - 1)
  const worse = compareBaseline(r, shrunk)
  assert.equal(worse.length, 2)
  assert.match(worse.map((w) => w.name).join(' '), /schema|q1/)
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test test/cost.test.mjs
```

Expected: fails with `Cannot find package`/`ERR_MODULE_NOT_FOUND` for `../bench/cost.mjs`.

- [ ] **Step 3: Implement `bench/cost.mjs`**

Create `bench/cost.mjs`:

```js
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
```

- [ ] **Step 4: Add package scripts**

In `package.json`, find:

```json
    "probe": "node scripts/mcp-probe.mjs"
```

Replace with:

```json
    "probe": "node scripts/mcp-probe.mjs",
    "bench:cost": "node bench/cost.mjs",
    "bench:ab": "node tools/cost-ab.mjs"
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
node --test test/cost.test.mjs
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add bench/cost.mjs test/cost.test.mjs package.json
git commit -m "bench: static context-cost measurement for fixed surfaces and payloads"
```

---

### Task 4: Add baseline write/check

The CLI code exists in Task 3; this task proves the behavior and generates the real baseline.

**Files:**
- Create: `bench/cost-baseline.json` (generated)
- Modify: `test/cost.test.mjs` (CLI-level check)

**Interfaces:**
- Consumes: `measure`, `baselineFrom`, `compareBaseline`, `BASELINE_PATH` from `bench/cost.mjs`.
- Produces: `--baseline-file <path>` (defaults to `bench/cost-baseline.json`) on the CLI.
- Produces: `bench/cost-baseline.json` consumed by `node bench/cost.mjs --check`.

- [ ] **Step 1: Write the failing CLI test**

Add to the top of `test/cost.test.mjs`, next to the existing imports:

```js
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
```

Then append this test:

```js
const SELF = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const COST = path.join(SELF, 'bench', 'cost.mjs')

test('CLI --write-baseline then --check passes, and fails on a shrunken baseline', async () => {
  const root = await fixture()
  const base = path.join(root, 'baseline.json')
  const run = (...args) => spawnSync(process.execPath, [COST, '--root', root, '--baseline-file', base, ...args], { cwd: SELF, encoding: 'utf8' })
  const write = run('--write-baseline')
  assert.equal(write.status, 0, write.stderr)
  const clean = run('--check')
  assert.equal(clean.status, 0, clean.stderr)
  const shrunk = JSON.parse(fs.readFileSync(base, 'utf8'))
  shrunk.surfaces.schema = Math.max(1, shrunk.surfaces.schema - 1)
  fs.writeFileSync(base, JSON.stringify(shrunk) + '\n')
  const bad = run('--check')
  assert.equal(bad.status, 1, 'a shrunken baseline must fail the check')
  assert.match(bad.stderr, /cost regression/)
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test test/cost.test.mjs
```

Expected: fails because `--baseline-file` is not handled yet (the CLI writes to the repo baseline and the temp file is absent), so the test errors on the missing file/status.

- [ ] **Step 3: Implement `--baseline-file`**

In `bench/cost.mjs`, find:

```js
  const root = flag(argv, '--root') ?? process.cwd()
  const turns = Number(flag(argv, '--turns') ?? 10)
  const r = measure({ root, turns })
```

Replace with:

```js
  const root = flag(argv, '--root') ?? process.cwd()
  const turns = Number(flag(argv, '--turns') ?? 10)
  const baselineFile = flag(argv, '--baseline-file') ?? BASELINE_PATH
  const r = measure({ root, turns })
```

Then replace both `BASELINE_PATH` uses inside `main` with `baselineFile`:

```js
  if (argv.includes('--write-baseline')) {
    fs.writeFileSync(baselineFile, JSON.stringify(baselineFrom(r), null, 2) + '\n')
    process.stderr.write(`baseline written to ${baselineFile}\n`)
  }
  if (argv.includes('--check')) {
    const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
```

Leave the exported `BASELINE_PATH` constant in place; it is the default.

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/cost.test.mjs
```

Expected: 5 tests pass, 0 fail.

- [ ] **Step 5: Generate the real baseline from this repository**

```bash
node bench/cost.mjs --write-baseline
```

Expected output (0.7.0, this tree):

```text
# MemAi context cost — D:\Projects\MemAi
fixed: schema 996 · instructions 208 · init 518 · skill 222 · card 282 · total 2226
delivered (tokens) — json / text:
  B1-query  405 / 132
  B1-fault  673 / 595
  B2  228 / 125
  B3  445 / 192
  B5  689 / 218
  B6  126 / 66
turn model (10 turns): once 490 + 10 × per-request 1736 = 17850
```

The `baseline written to …` line goes to stderr. If the numbers differ, stop and reconcile before committing; a mismatch means `measureSurfaces` is reading a different surface than the design's measurement.

- [ ] **Step 6: Verify the check is clean**

```bash
node bench/cost.mjs --check
```

Expected: same table, exit 0, no `cost regression` on stderr.

- [ ] **Step 7: Commit**

```bash
git add bench/cost.mjs bench/cost-baseline.json test/cost.test.mjs
git commit -m "bench: pin the 0.7.0 context-cost baseline"
```

---

### Task 5: Add the live A/B runner

**Files:**
- Create: `tools/cost-ab.mjs`
- Test: `test/cost-ab.test.mjs`

**Interfaces:**
- Consumes: `sessionsSince`, `sessionReport` from `./zcode-session-report.mjs`.
- Produces: `TASK_SETS.payload` — three `{id, prompt, expect}` tasks.
- Produces: `gate(rows) -> {ok, failures, baseTotal, treatTotal}`.
- Produces: `renderTable(rows) -> string`.
- CLI flags: `--baseline <dir>`, `--treatment <dir>`, `--tasks payload`, `--label <name>`, `--dry-run`.

- [ ] **Step 1: Write the failing test**

Create `test/cost-ab.test.mjs`:

```js
// Pure tests for the live A/B gate. No ZCode sessions are started.
import test from 'node:test'
import assert from 'node:assert/strict'
import { gate, renderTable, TASK_SETS } from '../tools/cost-ab.mjs'

test('gate passes only when every task is non-worse and the total is lower', () => {
  const rows = [
    { id: 'P1', arm: 'baseline', billedInput: 1000, correct: true },
    { id: 'P1', arm: 'treatment', billedInput: 900, correct: true },
    { id: 'P2', arm: 'baseline', billedInput: 1000, correct: true },
    { id: 'P2', arm: 'treatment', billedInput: 950, correct: true },
  ]
  const v = gate(rows)
  assert.equal(v.ok, true)
  assert.equal(v.baseTotal, 2000)
  assert.equal(v.treatTotal, 1850)
})

test('gate fails when one task is worse even if the total is lower', () => {
  const rows = [
    { id: 'P1', arm: 'baseline', billedInput: 1000, correct: true },
    { id: 'P1', arm: 'treatment', billedInput: 1100, correct: true },
    { id: 'P2', arm: 'baseline', billedInput: 1000, correct: true },
    { id: 'P2', arm: 'treatment', billedInput: 500, correct: true },
  ]
  const v = gate(rows)
  assert.equal(v.ok, false)
  assert.match(v.failures.join(' '), /P1/)
})

test('gate fails on an incorrect treatment answer', () => {
  const rows = [
    { id: 'P1', arm: 'baseline', billedInput: 1000, correct: true },
    { id: 'P1', arm: 'treatment', billedInput: 900, correct: false },
  ]
  assert.equal(gate(rows).ok, false)
})

test('gate fails when an arm is missing', () => {
  const v = gate([{ id: 'P1', arm: 'baseline', billedInput: 1000, correct: true }])
  assert.equal(v.ok, false)
  assert.match(v.failures.join(' '), /missing arm/)
})

test('renderTable includes both arms and the correctness column', () => {
  const t = renderTable([
    { id: 'P1', arm: 'baseline', billedInput: 1, turns: 2, toolCalls: 3, bashTextCalls: 0, correct: true },
    { id: 'P1', arm: 'treatment', billedInput: 2, turns: 2, toolCalls: 3, bashTextCalls: 2, correct: true },
  ])
  assert.match(t, /baseline/)
  assert.match(t, /treatment/)
  assert.match(t, /--text calls/)
})

test('payload task set has stable ids and expectations', () => {
  assert.deepEqual(TASK_SETS.payload.map((t) => t.id), ['P1', 'P2', 'P3'])
  for (const t of TASK_SETS.payload) assert.ok(t.expect instanceof RegExp)
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test test/cost-ab.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `../tools/cost-ab.mjs`.

- [ ] **Step 3: Implement `tools/cost-ab.mjs`**

Create `tools/cost-ab.mjs`:

```js
// Live cost A/B: same prompt, two worktrees, billed input from the ZCode DB.
//
// Both directories must have a fresh .memai index:
//   (cd <dir> && node bin/memai.mjs index)
//
// Usage:
//   node tools/cost-ab.mjs --dry-run
//   node tools/cost-ab.mjs --baseline ../MemAi-base --treatment ../MemAi-payload --label payload
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionsSince, sessionReport } from './zcode-session-report.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const OUT = path.join(ROOT, 'bench')
const ZCODE = process.env.ZCODE_BIN || 'C:/Program Files/ZCode/resources/glm/zcode.cjs'

export const TASK_SETS = {
  payload: [
    {
      id: 'P1',
      expect: /flushDelayMs|startWatcher/,
      prompt: 'Use the memai CLI via Bash (not MCP) to find where the watcher debounce is implemented in this project. Answer with the function name only.',
    },
    {
      id: 'P2',
      expect: /bm25|rank/i,
      prompt: 'Use the memai CLI via Bash (not MCP) to find how symbolSearch ranks results. Answer with the scoring column or function name.',
    },
    {
      id: 'P3',
      expect: /pack/,
      prompt: 'Use the memai CLI via Bash (not MCP) to list the MemAi MCP operations. Answer with the operation names.',
    },
  ],
}

export function gate(rows) {
  const byTask = new Map()
  for (const r of rows) {
    const t = byTask.get(r.id) ?? {}
    t[r.arm] = r
    byTask.set(r.id, t)
  }
  const failures = []
  let baseTotal = 0
  let treatTotal = 0
  for (const [id, t] of byTask) {
    if (!t.baseline || !t.treatment) { failures.push(`${id}: missing arm`); continue }
    if (!Number.isFinite(t.baseline.billedInput) || !Number.isFinite(t.treatment.billedInput)) {
      failures.push(`${id}: missing billedInput`)
      continue
    }
    baseTotal += t.baseline.billedInput
    treatTotal += t.treatment.billedInput
    if (t.treatment.billedInput > t.baseline.billedInput) {
      failures.push(`${id}: treatment ${t.treatment.billedInput} > baseline ${t.baseline.billedInput}`)
    }
    if (t.treatment.correct === false) failures.push(`${id}: incorrect answer`)
  }
  if (treatTotal >= baseTotal) failures.push(`total ${treatTotal} >= baseline ${baseTotal}`)
  return { ok: failures.length === 0, failures, baseTotal, treatTotal }
}

export function renderTable(rows) {
  const lines = [
    '| task | arm | billed-in | turns | tool calls | --text calls | correct |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
  ]
  for (const r of rows) {
    lines.push(`| ${r.id} | ${r.arm} | ${r.billedInput ?? '-'} | ${r.turns ?? '-'} | ${r.toolCalls ?? '-'} | ${r.bashTextCalls ?? '-'} | ${r.correct === null ? '-' : r.correct ? 'yes' : 'no'} |`)
  }
  return lines.join('\n')
}

function runOne({ dir, task, arm }) {
  const sinceMs = Date.now() - 2000
  const res = spawnSync(process.execPath, [ZCODE, '-p', task.prompt, '--cwd', dir], {
    cwd: dir, encoding: 'utf8', timeout: 600_000,
  })
  const session = sessionsSince({ sinceMs, cwd: dir }).filter((s) => !s.parentId)[0]
  if (!session) return { id: task.id, arm, dir, ok: false, error: 'no session recorded', exit: res.status }
  const rep = sessionReport({ sessionId: session.id })
  if (!rep.ok) return { id: task.id, arm, dir, ok: false, error: rep.error, session: session.id }
  const events = rep.toolEvents ?? []
  const commandOf = (e) => typeof e.input?.command === 'string' ? e.input.command : ''
  const bashTextCalls = events.filter((e) => e.tool === 'Bash' && commandOf(e).includes('--text')).length
  const memCalls = events.filter((e) => /mem/i.test(e.tool)).length
    + events.filter((e) => e.tool === 'Bash' && /memai\s/.test(commandOf(e))).length
  return {
    id: task.id, arm, dir, session: session.id, exit: res.status, ok: true,
    billedInput: rep.billedInput, turns: rep.turns,
    toolCalls: events.length,
    toolErrors: events.filter((e) => e.status === 'error').length,
    bashTextCalls, memCalls,
    correct: task.expect ? task.expect.test(res.stdout ?? '') : null,
    stdoutTail: (res.stdout ?? '').slice(-400),
  }
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null
}

function main() {
  const argv = process.argv.slice(2)
  const setName = flag(argv, '--tasks') ?? 'payload'
  const tasks = TASK_SETS[setName]
  if (!tasks) {
    process.stderr.write(`unknown --tasks ${setName}; use ${Object.keys(TASK_SETS).join('|')}\n`)
    process.exitCode = 2
    return
  }
  const baseline = flag(argv, '--baseline')
  const treatment = flag(argv, '--treatment')
  if (argv.includes('--dry-run')) {
    process.stdout.write(`# dry run [${setName}] — ${tasks.length} tasks × 2 arms = ${tasks.length * 2} sessions\n`)
    process.stdout.write(`baseline:  ${baseline ?? '(missing --baseline)'}\n`)
    process.stdout.write(`treatment: ${treatment ?? '(missing --treatment)'}\n`)
    for (const t of tasks) process.stdout.write(`${t.id}: ${t.prompt.slice(0, 80)}…\n`)
    return
  }
  if (!baseline || !treatment) {
    process.stderr.write('usage: node tools/cost-ab.mjs --baseline <dir> --treatment <dir> [--tasks payload] [--label name]\n')
    process.exitCode = 2
    return
  }
  const rows = []
  for (const [arm, dir] of [['baseline', baseline], ['treatment', treatment]]) {
    for (const task of tasks) {
      let r = runOne({ dir, task, arm })
      if (r.billedInput === 0) r = runOne({ dir, task, arm })
      rows.push(r)
      process.stderr.write(`${arm} ${task.id}: billedIn=${r.billedInput ?? '-'} textCalls=${r.bashTextCalls ?? '-'}\n`)
    }
  }
  const verdict = gate(rows)
  const label = flag(argv, '--label') ?? setName
  const stamp = new Date().toISOString().slice(0, 10)
  const md = `# live cost A/B [${label}] — ${stamp}\n\n${renderTable(rows)}\n\n${verdict.ok ? 'PASS' : 'FAIL'}: ${verdict.failures.length ? verdict.failures.join('; ') : `total ${verdict.treatTotal} < ${verdict.baseTotal}`}\n`
  fs.writeFileSync(path.join(OUT, `cost-ab-${stamp}-${label}.json`), JSON.stringify({ date: stamp, set: setName, dirs: { baseline, treatment }, verdict, rows }, null, 2) + '\n')
  fs.writeFileSync(path.join(OUT, `cost-ab-${stamp}-${label}.md`), md)
  process.stdout.write(md)
  process.exitCode = verdict.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main()
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/cost-ab.test.mjs
```

Expected: 6 tests pass, 0 fail.

- [ ] **Step 5: Dry-run the runner**

```bash
node tools/cost-ab.mjs --dry-run --baseline ../MemAi-base --treatment ../MemAi-payload
```

Expected: `# dry run [payload] — 3 tasks × 2 arms = 6 sessions`, then the two directory lines and three task prompts.

- [ ] **Step 6: Commit**

```bash
git add tools/cost-ab.mjs test/cost-ab.test.mjs
git commit -m "tools: live cost A/B runner with a per-task gate"
```

---

### Task 6: Add the version-agreement surface test

The skill metadata version is stale at `0.4.0` while `package.json` is `0.7.0`. The design's surface test starts here and is extended in the turns plan.

**Files:**
- Create: `test/surfaces.test.mjs`
- Modify: `skills/memai/SKILL.md` (metadata version)

**Interfaces:**
- Produces: a test that later plans extend with op-coverage and schema-type assertions.

- [ ] **Step 1: Write the failing test**

Create `test/surfaces.test.mjs`:

```js
// Instruction-surface consistency: versions and (later) op coverage must agree.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('skill metadata version matches package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'memai', 'SKILL.md'), 'utf8')
  const m = skill.match(/^\s{2}version:\s*"([^"]+)"/m)
  assert.ok(m, 'skill frontmatter has metadata.version')
  assert.equal(m[1], pkg.version)
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test test/surfaces.test.mjs
```

Expected: fails with `0.4.0 !== 0.7.0`.

- [ ] **Step 3: Fix the stale version**

In `skills/memai/SKILL.md`, find:

```yaml
  version: "0.4.0"
```

Replace with:

```yaml
  version: "0.7.0"
```

- [ ] **Step 4: Run it to verify it passes**

```bash
node --test test/surfaces.test.mjs
```

Expected: 1 test passes, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add test/surfaces.test.mjs skills/memai/SKILL.md
git commit -m "test: assert skill and package versions agree"
```

---

### Task 7: Publish the baseline and verify the full suite

**Files:**
- Create: `bench/COST-BASELINE-0.7.0.md`

**Interfaces:**
- Consumes: the table produced by `node bench/cost.mjs`.
- Produces: the human-readable baseline referenced by later gate docs.

- [ ] **Step 1: Write the baseline doc**

Create `bench/COST-BASELINE-0.7.0.md` with the exact output from Task 4 Step 3 plus the reproduce command:

```markdown
# Context-cost baseline — 0.7.0

Static measurement of the surfaces a model pays for before and during a MemAi
session. Estimator: `ceil(chars / 3.966)`. No model calls.

```text
# MemAi context cost — D:\Projects\MemAi
fixed: schema 996 · instructions 208 · init 518 · skill 222 · card 282 · total 2226
delivered (tokens) — json / text:
  B1-query  405 / 132
  B1-fault  673 / 595
  B2  228 / 125
  B3  445 / 192
  B5  689 / 218
  B6  126 / 66
turn model (10 turns): once 490 + 10 × per-request 1736 = 17850
```

Reproduce:

```bash
node bench/cost.mjs
node bench/cost.mjs --check   # exit 1 if a surface or text payload grew
```

Interpretation:

- `schema`, `init`, `skill` are re-sent per request in the hosts that inject
  them; `instructions` and `card` are once per session.
- `json / text` is the same call rendered by the CLI. The text column is what a
  model should ingest; JSON is transport and may be larger.
- This is a static model, not a billed-token measurement. Billed input comes
  from `tools/cost-ab.mjs` in the lever plans.
```

- [ ] **Step 2: Run the full suite**

```bash
npm test
```

Expected: all test files pass, including the restored session-report test and the three new files; no failures.

- [ ] **Step 3: Run the cost check**

```bash
node bench/cost.mjs --check
```

Expected: exit 0, no `cost regression` line.

- [ ] **Step 4: Commit**

```bash
git add bench/COST-BASELINE-0.7.0.md
git commit -m "docs: publish the 0.7.0 context-cost baseline"
```

---

## Self-Review

**Spec coverage:** Step 0 in the spec names `tools/zcode-session-report.mjs`, `bench/cost.mjs`, `bench/cost-baseline.json`, and `tools/cost-ab.mjs`. Tasks 1–7 cover all four, plus the baseline doc and the version-agreement test. The live runs named in the spec are deliberately deferred to the lever plans; this plan only proves the runner with a dry run.

**Placeholder scan:** No TBD/TODO. Every code step contains the full code. The expected baseline numbers are concrete; a mismatch is a stop condition, not a fill-in.

**Type consistency:** `measureSurfaces(pages, ...)` is called only from `measure`, which owns the store; `measureCall` uses the same `pages`. `toolEvents` entries use `{tool, input, status, outputBytes}` consistently in the report, the tests, and the A/B runner. `gate` rows use `{id, arm, billedInput, correct}` in both tests and `runOne`.

**Known deviation:** Task 4's CLI test writes its own temp baseline, so it passes without `bench/cost-baseline.json`. That is intentional: it tests the comparison path, while Task 4 Step 3 generates and pins the real baseline.

---

## Next Plans

- `docs/superpowers/plans/2026-11-22-token-savings-01-payload.md`
- `docs/superpowers/plans/2026-11-22-token-savings-02-turns.md`
- `docs/superpowers/plans/2026-11-22-token-savings-03-overhead.md`
