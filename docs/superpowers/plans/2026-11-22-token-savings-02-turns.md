# MemAi Turns Lever (Lever 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the number of CLI calls a question needs — repair the MCP `body`/`since` schema collisions, make `query --body` choose a source callable that actually matches the question, put the indexed version in the card so resume skips `status`, and auto-run ripgrep when the index has no hits.

**Architecture:** Four independent fixes on one branch stacked on `feat/token-harness`. Three are local code changes validated by unit tests; the fourth is a live CLI A/B on the same corpus, gated per task on fewer local CLI calls plus lower total billed input. The payload lever was discarded (see `bench/NEGATIVE-payload.md`), so this is the first candidate release of the round.

**Tech Stack:** Node 24 ESM, `node:test`, the step-0 harness (`bench/cost.mjs`, `tools/cost-ab.mjs`), ZCode 0.17.x headless.

## Global Constraints

- Base branch: `feat/token-harness`. Work on `feat/token-turns`; do not commit to `main`.
- Node `>=22.13`; no new runtime dependencies.
- No ranking changes: `query` hit order and `memai eval` recall@5 must be unchanged. Body selection changes only which symbol `--body` materializes.
- The live gate uses the locally checked-out CLI (`node bin/memai.mjs`), not the globally installed `memai` or MCP; the runner invalidates a run otherwise.
- Same corpus in both live arms: the baseline worktree gets the treatment's `docs/`, `bench/`, `test/`, `tools/`, `README.md`, `CHANGELOG.md`, while its `src/`, `mcp/`, `bin/` stay at `adfbaea`.
- Ship only if every live task uses fewer local CLI calls and total billed input is lower; discard on any regression.
- Windows Git Bash; forward slashes in commands.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `mcp/tools.mjs` | Flat schema: `body` boolean (query), `content` string (note/post), `sinceSeq` integer (inbox); dispatch aliases. |
| `test/mcp.test.mjs` | Schema types and note/post/inbox dispatch. |
| `test/surface.test.mjs` | Extended surface checks (op coverage, version constants). |
| `src/page.mjs` | Source-aware `--body` selection; card version; auto-rg on zero hits. |
| `test/retrieval.test.mjs` | Body-selection regression tests. |
| `test/render.test.mjs` | Card version and auto-rg tests. |
| `src/init.mjs`, `skills/memai/SKILL.md`, `adapters/*/AGENTS.md` | Note examples move from `body` to `content`. |
| `tools/cost-ab.mjs`, `test/cost-ab.test.mjs` | `turns` task set and fewer-calls gate. |
| `bench/BENCHMARK-0.8.0-turns.md` | Unit results, eval, live A/B table, decision. |
| `CHANGELOG.md`, version files | 0.8.0 bump only if the live gate passes. |

---

### Task 1: Repair the `body` / `since` schema collisions

The flat MCP schema declares `body` twice (`mcp/tools.mjs:80` boolean for `query`, `:95` string for `note`/`post`); the later wins, so `query --body` is undiscoverable through MCP. `since` is a string for `diff` but an integer for `inbox`.

**Files:**
- Modify: `mcp/tools.mjs`
- Test: `test/mcp.test.mjs`
- Modify: `src/init.mjs`, `skills/memai/SKILL.md`, `adapters/{codex,generic,opencode,zcode}/AGENTS.md`

**Interfaces:**
- Produces: `memTool().inputSchema.properties.body.type === 'boolean'`.
- Produces: `content` string for `note`/`post`; dispatch accepts `content` or legacy `body` string.
- Produces: `sinceSeq` integer for `inbox`; dispatch accepts `sinceSeq` or numeric legacy `since`.

- [ ] **Step 1: Create the branch**

```bash
cd /d/Projects/MemAi
git switch -c feat/token-turns
```

- [ ] **Step 2: Write the failing tests**

In `test/mcp.test.mjs`, add the import:

```js
import { dispatch, memTool } from '../mcp/tools.mjs'
```

Append:

```js
test('flat schema keeps query body boolean and note content string', () => {
  const p = memTool().inputSchema.properties
  assert.equal(p.body.type, 'boolean', 'query body must be a boolean')
  assert.equal(p.content.type, 'string', 'note/post content must be a string')
  assert.equal(p.since.type, 'string', 'diff since must be a string')
  assert.equal(p.sinceSeq.type, 'integer', 'inbox sinceSeq must be an integer')
})

test('note accepts content and the legacy body string; inbox accepts sinceSeq', async () => {
  const a = await dispatch({ root, db }, 'note', { topic: 'schema', content: 'hello' })
  assert.equal(a.isError, false)
  assert.match(a.content[0].text, /note/)
  const b = await dispatch({ root, db }, 'note', { topic: 'schema', body: 'legacy' })
  assert.equal(b.isError, false)
  const c = await dispatch({ root, db }, 'inbox', { agent: 'schema-agent', sinceSeq: 0 })
  assert.equal(c.isError, false)
})
```

- [ ] **Step 3: Run them to verify they fail**

```bash
node --test test/mcp.test.mjs
```

Expected: the schema test fails (`body.type` is `string`); `content` is `undefined`; `sinceSeq` is `undefined`.

- [ ] **Step 4: Repair the schema**

In `mcp/tools.mjs`, find:

```js
      body: { type: 'string', description: 'note/post: message body. Send page ids and symbol names, never file bodies.' },
```

Replace with:

```js
      content: { type: 'string', description: 'note/post: message body. Send page ids and symbol names, never file bodies.' },
```

Find:

```js
      since: { type: 'string', description: 'diff: previous project version hash; omit to just see the current version.' },
```

Replace with:

```js
      since: { type: 'string', description: 'diff: previous project version hash; omit to just see the current version.' },
      sinceSeq: { type: 'integer', minimum: 0, description: 'inbox: read messages after this sequence number (default 0).' },
```

In `dispatch`, find the note/post body:

```js
        const body = typeof args.body === 'string' ? args.body : ''
```

Replace with:

```js
        const body = typeof args.content === 'string' ? args.content : (typeof args.body === 'string' ? args.body : '')
```

In the inbox case, find:

```js
          since: args.since == null || args.since === true ? null : clampInt(args.since, 0, 0, Number.MAX_SAFE_INTEGER),
```

Replace with:

```js
          since: args.sinceSeq == null
            ? (args.since == null || args.since === true ? null : clampInt(args.since, 0, 0, Number.MAX_SAFE_INTEGER))
            : clampInt(args.sinceSeq, 0, 0, Number.MAX_SAFE_INTEGER),
```

- [ ] **Step 5: Update the note examples on every instruction surface**

In `src/init.mjs`, find:

```js
    '- share state with other agents: `{"op":"note","topic":"<topic>","body":"..."}` and',
```

Replace with:

```js
    '- share state with other agents: `{"op":"note","topic":"<topic>","content":"..."}` and',
```

In `skills/memai/SKILL.md`, find:

```markdown
5. **Share.** `{"op":"note","topic":"handoff","body":"auth move: see file:src/auth.js"}`,
```

Replace with:

```markdown
5. **Share.** `{"op":"note","topic":"handoff","content":"auth move: see file:src/auth.js"}`,
```

In each of `adapters/codex/AGENTS.md`, `adapters/generic/AGENTS.md`, `adapters/opencode/AGENTS.md`, `adapters/zcode/AGENTS.md`, find:

```markdown
- share state with other agents: `{"op":"note","topic":"<topic>","body":"..."}` and
```

Replace with:

```markdown
- share state with other agents: `{"op":"note","topic":"<topic>","content":"..."}` and
```

Leave the `query` `"body": true` examples unchanged; only the note examples move.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
node --test test/mcp.test.mjs test/surfaces.test.mjs
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add mcp/tools.mjs test/mcp.test.mjs src/init.mjs skills/memai/SKILL.md adapters/codex/AGENTS.md adapters/generic/AGENTS.md adapters/opencode/AGENTS.md adapters/zcode/AGENTS.md
git commit -m "fix(mcp): separate query body, note content and inbox sinceSeq"
```

---

### Task 2: Source-aware `query --body` selection

Current selection is the first callable in the global symbol pool (`src/page.mjs:591-592`). It picks `watcherAlive` for "watch debounce" and `workspace` for "how does the watcher debounce work"; docs headings outrank code.

**Files:**
- Modify: `src/page.mjs`
- Test: `test/retrieval.test.mjs`

**Interfaces:**
- Consumes: `top` hits, `store.symbolSearch`, `isTestPath`, `isDocPath`.
- Produces: `body.symbol` is a source callable scored on name/signature term overlap plus a top-page bonus; `fault` is called as `path#symbol`.

- [ ] **Step 1: Write the failing test**

Append to `test/retrieval.test.mjs`:

```js
test('query --body prefers the matching source callable over docs headings', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"body-docs","version":"1.0.0","type":"module"}')
  fs.writeFileSync(path.join(root, 'README.md'), [
    '# How does the watcher debounce work?',
    '',
    'This page explains the watcher debounce design.',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(root, 'src', 'watch.js'), [
    'export const DEBOUNCE_MS = 800',
    'export function startWatcher() {',
    '  const pidfile = ".memai/watch.pid"',
    '  return pidfile',
    '}',
    'export function watcherAlive() {',
    '  return true',
    '}',
    '',
  ].join('\n'))
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root })
  store.setMeta('root', root)
  const pages = new MemoryPages({ store, root })
  await pages.index({ maxFiles: 100 })
  try {
    const r = pages.query('how does the watcher debounce work', { body: true })
    assert.equal(r.body.ok, true)
    assert.equal(r.body.symbol, 'startWatcher', `expected startWatcher, got ${r.body.symbol}`)
    assert.match(r.body.text, /pidfile/)
  } finally { store.close() }
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test test/retrieval.test.mjs
```

Expected: the new test fails with `workspace` or another docs-derived symbol.

- [ ] **Step 3: Implement**

In `src/page.mjs`, add `isDocPath` to the extract import:

```js
import { EXTRACTOR_VERSION, KEYWORDS, langOf, isTestPath, isDocPath } from './extract.mjs'
```

Then in the `if (body)` block, replace:

```js
      const cands = this.store.symbolSearch(q, { limit: 20 })
      const chosen = cands.find((s) => ['function', 'method', 'class'].includes(s.kind)) ?? cands[0]
```

with:

```js
      const terms = String(q).toLowerCase().split(/[^a-z0-9_$]+/i).filter((t) => t.length >= 2)
      const all = this.store.symbolSearch(q, { limit: 20 })
      const callables = all.filter((s) => ['function', 'method', 'class'].includes(s.kind))
      const source = callables.filter((s) => !isTestPath(s.path) && !isDocPath(s.path))
      const preferred = new Set(top.filter((h) => h.kind === 'page' && h.path).map((h) => h.path))
      const score = (s) => {
        const name = String(s.name).toLowerCase()
        const sig = String(s.signature ?? '').toLowerCase()
        let n = preferred.has(s.path) ? 5 : 0
        for (const t of terms) {
          if (name.includes(t)) n += 3
          else if (sig.includes(t)) n += 1
        }
        return n
      }
      const pool = (source.length ? source : callables.length ? callables : all).slice()
        .sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path) || a.line - b.line)
      const chosen = pool[0]
```

Then change the fault target from the bare name to the path-qualified symbol:

```js
        const f = this.fault(`${chosen.path}#${chosen.name}`, { budget: DEFAULTS.fault })
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test test/retrieval.test.mjs
```

Expected: the new test passes, including `startWatcher`; the existing `verifyToken` and "callable over const" tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/page.mjs test/retrieval.test.mjs
git commit -m "fix(query): choose the source callable that matches the question"
```

---

### Task 3: Put the indexed version in the card

`diff --since` needs a version; the card does not carry one, so a resuming agent spends a `status` call. Append the current project version at resolve time (the stored card cannot embed it: the project version is hashed from the card text).

**Files:**
- Modify: `src/page.mjs` (`card`)
- Test: `test/render.test.mjs`

**Interfaces:**
- Produces: `pages.card().text` ends with `version: <8 hex>`.
- Produces: the version is accepted by `pages.diff({since: version})`.

- [ ] **Step 1: Write the failing test**

Append to `test/render.test.mjs`:

```js
test('card carries the current project version for resume', async () => {
  const { store, pages } = await fixture()
  try {
    const card = pages.card()
    const m = card.text.match(/^version: ([0-9a-f]{8})$/m)
    assert.ok(m, `card has no version line:\n${card.text}`)
    const d = pages.diff({ since: m[1] })
    assert.equal(d.ok, true)
  } finally { store.close() }
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test test/render.test.mjs
```

Expected: fails with `card has no version line`.

- [ ] **Step 3: Implement**

In `src/page.mjs`, replace:

```js
  card(opts = {}) { return this.resolve('project.card', { budget: opts.budget ?? DEFAULTS.card, ...opts }) }
```

with:

```js
  card(opts = {}) {
    const r = this.resolve('project.card', { budget: opts.budget ?? DEFAULTS.card, ...opts })
    if (!r.ok) return r
    if (/^version: [0-9a-f]{8}$/m.test(r.text)) return r
    const latest = this.store.latestVersion()
    const v = latest?.version_hash?.slice(0, 8)
    if (!v) return r
    const text = `${r.text}\nversion: ${v}`
    return { ...r, text, tokens: estTokens(text) }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/render.test.mjs
```

Expected: all render tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/page.mjs test/render.test.mjs
git commit -m "feat(card): carry the indexed version for resume"
```

---

### Task 4: Auto-rg on zero index hits

A query for a body-only string returns no hits, so the agent spends a second call on `query --rg` or grep. Run the existing ripgrep pass automatically when the index returns nothing.

**Files:**
- Modify: `src/page.mjs` (`query`)
- Test: `test/render.test.mjs`

**Interfaces:**
- Produces: a zero-hit `query` returns ripgrep `text` hits and an `rgNote` starting with `auto-rg:`.
- Produces: a query with index hits is unchanged; `rg: true` keeps its existing note.

- [ ] **Step 1: Write the failing test**

In `test/render.test.mjs`, extend the fixture `src/watch.js` with a body-only string. Replace the file contents in `fixture()` with:

```js
  fs.writeFileSync(path.join(root, 'src', 'watch.js'), [
    'export const DEBOUNCE_MS = 800',
    'export function startWatcher() {',
    '  const pidfile = ".memai/watch.pid"',
    '  return pidfile',
    '}',
    '',
  ].join('\n'))
```

Then append:

```js
test('query auto-runs ripgrep when the index has no hits', async () => {
  const { store, pages } = await fixture()
  try {
    const r = pages.query('pidfile', { k: 5 })
    assert.ok(r.hits.some((h) => h.path === 'src/watch.js'), `expected a text hit:\n${r.text}`)
    assert.match(r.rgNote ?? '', /auto-rg/)
  } finally { store.close() }
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test test/render.test.mjs
```

Expected: `hits` is empty and `rgNote` is null.

- [ ] **Step 3: Implement**

In `src/page.mjs`'s `query`, find:

```js
    let rgNote = null
    if (rg) {
      const extra = this._rgSearch(q, { cap: 5 })
      rgNote = extra.note
```

Replace with:

```js
    let rgNote = null
    const autoRg = !rg && hits.length === 0
    if (rg || autoRg) {
      const extra = this._rgSearch(q, { cap: 5 })
      rgNote = autoRg ? `auto-rg: ${extra.note ?? 'no index hits'}` : extra.note
```

Leave the rest of the block unchanged.

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test test/render.test.mjs
```

Expected: all render tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/page.mjs test/render.test.mjs
git commit -m "feat(query): auto-run ripgrep on zero index hits"
```

---

### Task 5: Verify units and record the static results

**Files:**
- Create: `bench/BENCHMARK-0.8.0-turns.md`

- [ ] **Step 1: Run the full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Record the card cost delta**

```bash
node bench/cost.mjs
```

Expected: the `card` surface is ~10 tokens larger (the `version:` line); all other fixed surfaces are unchanged. The delivered rows are unchanged (the turns fixes change call count, not the per-call text of the B1–B6 probe set).

- [ ] **Step 3: Verify recall is unchanged**

```bash
node bin/memai.mjs eval --fixtures bench/eval-fixtures.json --k 5
node bin/memai.mjs eval --fixtures bench/eval-fixtures-ext.json --k 5
```

Expected: shipped recall@5 100 %; extended recall@5 85 % index. MRR may shift only from corpus growth; compare to the harness branch at the same corpus, not the historical 0.70. If recall drops, stop.

- [ ] **Step 4: Write the static benchmark doc**

Create `bench/BENCHMARK-0.8.0-turns.md` with:

```markdown
# 0.8.0 turns benchmark

Baseline: 0.7.0 (`adfbaea`) with the harness plus the same corpus. The payload
lever was discarded (`bench/NEGATIVE-payload.md`).

## Unit results

- MCP schema: `body` is boolean, `content` is string, `since` is string,
  `sinceSeq` is integer; note/post/inbox dispatch accepts the new names and the
  legacy aliases.
- `query --body` on "how does the watcher debounce work" selects `startWatcher`
  (was `workspace`); the existing `verifyToken` and callable-over-const tests pass.
- `card` ends with `version: <8 hex>` and `diff --since` accepts it.
- Zero-hit `query "pidfile"` returns the ripgrep hit and `rgNote` starts with
  `auto-rg:`.
- Eval: shipped recall@5 100 %, extended 85 % index (unchanged).

## Cost

`card` grows by <fill> tokens from the version line; the resume task saves a
`status` call.

Reproduce: `npm test`, `node bench/cost.mjs`, the two eval commands above.
```

Replace `<fill>` with the measured card delta. No placeholders.

- [ ] **Step 5: Commit**

```bash
git add bench/BENCHMARK-0.8.0-turns.md
git commit -m "bench: static turns measurements"
```

---

### Task 6: Live CLI A/B on the same corpus

**Files:**
- Modify: `tools/cost-ab.mjs`, `test/cost-ab.test.mjs`
- Modify: `bench/BENCHMARK-0.8.0-turns.md` (append the live table)

**Interfaces:**
- Produces: `TASK_SETS.turns` with `T1` body selection, `T2` resume, `T3` auto-rg; `requireFewerCalls: true`.
- Produces: `gate` failure `<id>: treatment did not use fewer local CLI calls`.

- [ ] **Step 1: Write the failing tests**

Append to `test/cost-ab.test.mjs`:

```js
test('turns tasks require fewer local CLI calls', () => {
  assert.deepEqual(TASK_SETS.turns.map((t) => t.id), ['T1', 'T2', 'T3'])
  for (const t of TASK_SETS.turns) {
    assert.equal(t.requireCli, true)
    assert.equal(t.requireFewerCalls, true)
    assert.match(t.prompt, /node bin\/memai\.mjs/)
  }
})

test('gate fails when the treatment does not use fewer local CLI calls', () => {
  const rows = [
    { id: 'T1', arm: 'baseline', billedInput: 1000, correct: true, valid: true, cliCalls: 2 },
    { id: 'T1', arm: 'treatment', billedInput: 900, correct: true, valid: true, cliCalls: 2, requireFewerCalls: true },
  ]
  const v = gate(rows)
  assert.equal(v.ok, false)
  assert.match(v.failures.join(' '), /fewer local CLI calls/)
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
node --test test/cost-ab.test.mjs
```

Expected: `TASK_SETS.turns` is undefined; `gate` ignores the flag.

- [ ] **Step 3: Implement the task set**

In `tools/cost-ab.mjs`, add to `TASK_SETS` after `payload`:

```js
  turns: [
    {
      id: 'T1',
      requireCli: true,
      requireFewerCalls: true,
      expect: /flushDelayMs|startWatcher/,
      prompt: 'Use exactly one local CLI call: `node bin/memai.mjs query "how does the watcher debounce work" --body --text`. Answer with the function that computes the delay. Do not use the MCP tool, a globally installed `memai`, or any other lookup.',
    },
    {
      id: 'T2',
      requireCli: true,
      requireFewerCalls: true,
      expect: /src\/|no changes|up to date/i,
      prompt: 'Call `node bin/memai.mjs card --text` once. If the card carries a `version:` line, call `node bin/memai.mjs diff --since <that version> --text` once and list the changed files. If it does not, call `node bin/memai.mjs status --text` once to get the version, then the same diff. Answer with the changed files.',
    },
    {
      id: 'T3',
      requireCli: true,
      requireFewerCalls: true,
      expect: /watch\.mjs/,
      prompt: 'Use exactly one local CLI call: `node bin/memai.mjs query "breakerLogged" --text`. Answer with the file path that contains that token. Do not use the MCP tool, a globally installed `memai`, or grep.',
    },
  ],
```

- [ ] **Step 4: Implement the row flag and gate check**

In `runOne`'s return object, add:

```js
    requireFewerCalls: !!task.requireFewerCalls,
```

In `gate`, after the `--text` check, add:

```js
    if (t.treatment.requireFewerCalls && !(Number.isFinite(t.baseline.cliCalls) && t.treatment.cliCalls < t.baseline.cliCalls)) {
      failures.push(`${id}: treatment did not use fewer local CLI calls (${t.treatment.cliCalls} vs ${t.baseline.cliCalls})`)
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --test test/cost-ab.test.mjs
```

Expected: 11 tests pass.

- [ ] **Step 6: Prepare the same-corpus baseline worktree**

```bash
cd /d/Projects/MemAi
git worktree list   # remove ../MemAi-base first if it is registered
git worktree add ../MemAi-base adfbaea
for d in docs bench test tools; do
  rm -rf "../MemAi-base/$d"
  cp -r "$d" "../MemAi-base/$d"
done
cp README.md CHANGELOG.md "../MemAi-base/" 2>/dev/null || true
(cd ../MemAi-base && node bin/memai.mjs init --agent zcode)
```

Expected: the baseline worktree has the treatment's docs/bench/tests/tools and 0.7.0 `src/`, `mcp/`, `bin/`. Its `AGENTS.md` has the 0.7.0 block.

- [ ] **Step 7: Prepare the treatment checkout**

```bash
cd /d/Projects/MemAi
node bin/memai.mjs init --agent zcode
node bin/memai.mjs index
```

Expected: the treatment `AGENTS.md` is current; the store is fresh.

- [ ] **Step 8: Dry-run and run the A/B**

```bash
node tools/cost-ab.mjs --dry-run --baseline ../MemAi-base --treatment D:/Projects/MemAi --tasks turns
node tools/cost-ab.mjs --baseline ../MemAi-base --treatment D:/Projects/MemAi --tasks turns --label turns
```

Expected: 3 tasks × 2 arms = 6 sessions. Gate: every treatment `cliCalls` < baseline, total billed input lower, answers correct, local CLI used.

- [ ] **Step 9: Apply the gate**

Pass requires all of:

- every treatment `cliCalls` < its baseline;
- total treatment `billedInput` < total baseline;
- `correct` is true for every treatment row;
- `cliCalls > 0` for both arms.

If any task fails, record the table and stop; do not ship.

- [ ] **Step 10: Append the live table**

Append to `bench/BENCHMARK-0.8.0-turns.md`:

```markdown
## Live CLI A/B (3 tasks × 2 arms, same corpus)

| task | arm | billed-in | local CLI calls | correct |
| --- | --- | ---: | ---: | --- |
| T1 | baseline | <fill> | <fill> | <fill> |
| T1 | treatment | <fill> | <fill> | <fill> |
| T2 | baseline | <fill> | <fill> | <fill> |
| T2 | treatment | <fill> | <fill> | <fill> |
| T3 | baseline | <fill> | <fill> | <fill> |
| T3 | treatment | <fill> | <fill> | <fill> |

Verdict: <PASS/FAIL>.
```

Fill from `bench/cost-ab-<date>-turns.json`; no placeholders. Remove the worktree:

```bash
git worktree remove --force ../MemAi-base
```

- [ ] **Step 11: Commit**

```bash
git add tools/cost-ab.mjs test/cost-ab.test.mjs bench/BENCHMARK-0.8.0-turns.md bench/cost-ab-*-turns.json bench/cost-ab-*-turns.md
git commit -m "bench: live turns A/B against 0.7.0"
```

---

### Task 7: Ship or discard

**Files (ship):**
- Modify: `package.json`, `mcp/paths.mjs`, `src/mem-cli.mjs`, `skills/memai/SKILL.md`, `CHANGELOG.md`
- Modify: `bench/cost-baseline.json`, create `bench/COST-BASELINE-0.8.0.md`

**Files (discard):**
- Create: `bench/NEGATIVE-turns.md` on `feat/token-harness`

- [ ] **Step 1: If the gate failed, record and discard**

Do not bump versions. Write `bench/NEGATIVE-turns.md` with the Task 6 table, the failure list, and the per-task tool traces. Commit it on `feat/token-turns`; the branch stays unmerged as the raw record.

- [ ] **Step 2: If the gate passed, bump the four version surfaces**

In `package.json`, `mcp/paths.mjs`, `src/mem-cli.mjs`, and `skills/memai/SKILL.md`, replace `0.7.0` with `0.8.0`.

- [ ] **Step 3: Add the changelog entry**

Insert at the top of `CHANGELOG.md`:

```markdown
## [0.8.0] — 2026-11-22

### Fixed

- **MCP schema collisions.** `query` keeps `body: boolean`; `note`/`post` use
  `content: string`; `inbox` uses `sinceSeq: integer`. Dispatch accepts the
  legacy names. `query --body` is now discoverable through the MCP schema.
- **`query --body` selection.** Source callables are scored on name/signature
  term overlap with a top-page bonus; docs and tests are fallbacks. "How does
  the watcher debounce work" now selects `startWatcher`, not a README heading.

### Added

- **Card version.** The card ends with `version: <hash>`; `diff --since` accepts
  it, so resume skips `status`.
- **Auto-rg.** A zero-hit `query` runs the ripgrep pass automatically instead of
  asking the agent for a second call.

### Measured

- Live: <fill> fewer local CLI calls and <fill> lower billed input across three
  tasks (same corpus). See `bench/BENCHMARK-0.8.0-turns.md`.
```

Fill the measured values; no placeholders.

- [ ] **Step 4: Pin the 0.8.0 baseline**

```bash
node bench/cost.mjs --write-baseline
cp bench/COST-BASELINE-0.7.0.md bench/COST-BASELINE-0.8.0.md
```

Update the new doc's title, table and card note. Keep the 0.7.0 doc unchanged.

- [ ] **Step 5: Run the full suite and the cost check**

```bash
npm test
node bench/cost.mjs --check
```

Expected: all tests pass; the cost check is clean against the 0.8.0 baseline.

- [ ] **Step 6: Commit**

```bash
git add package.json mcp/paths.mjs src/mem-cli.mjs skills/memai/SKILL.md CHANGELOG.md bench/cost-baseline.json bench/COST-BASELINE-0.8.0.md
git commit -m "release: 0.8.0 turns lever"
```

---

## Self-Review

**Spec coverage:** The turns lever's four changes are Tasks 1–4. The schema repair includes the non-circular card-version decision (read-time append). The live gate covers body selection, resume, and auto-rg; the schema repair is validated by unit and dispatch tests because the global MCP server runs the published package (the same environment limitation documented in the payload plan). The optional `query --body --deep` experiment is deferred: the design marked it discardable, and the three core fixes already target the call count.

**Placeholder scan:** The benchmark and changelog templates use `<fill>` markers with explicit replacement steps; no code placeholders.

**Type consistency:** `sinceSeq` is integer, `content` string, `body` boolean. `requireFewerCalls` is set by `runOne` and read by `gate`. `card()` returns the same envelope shape with a longer `text` and recomputed `tokens`. `signatureLine`/`compactPageSnippet` are not part of this branch (payload discarded).

**Known limitation:** The live A/B uses the current checkout as treatment and a same-corpus `adfbaea` worktree as baseline. The global MCP server still runs the installed package; all tasks force `node bin/memai.mjs`, and the runner invalidates otherwise.

---

## Next Plan

`docs/superpowers/plans/2026-11-22-token-savings-03-overhead.md`
