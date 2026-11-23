# Fault-completeness lever implementation plan

**Goal:** Stop making agents pay a whole-file read after a truncated `fault`. Raise the default fault budget to 1,200 and mark each slice `(complete)` or `(truncated: N more lines)`, so one call usually finishes the answer.

**Architecture:** One default change plus a response marker. The CLI, MCP and `query --body` all read `DEFAULTS.fault`; an explicit `--budget` still wins. A live CLI A/B on three large-function questions measures billed input and whole-file reads; a turn saved dominates the extra slice tokens.

## Global Constraints

- Base `main` `720e52c`; branch `feat/fault-complete`.
- Explicit budgets are never overridden; only the default moves 600 → 1,200.
- No ranking changes, no instruction-surface changes (the B lesson).
- A/B same corpus, CLI-only (`node bin/memai.mjs`), 3 tasks × 2 arms.
- Ship only if every task is non-worse (1 % tolerance), total lower, answers correct; discard otherwise.

## Task 1: Raise the default and mark completeness

**Files:** `src/page.mjs`, `test/render.test.mjs`.

**Interfaces:** `pages.fault(sym)` returns a complete body up to 1,200 tokens; `text` contains `(complete)`; an explicit smaller budget returns `(truncated: N more lines)`.

- [ ] **Step 1: Write the failing test**

Append to `test/render.test.mjs` a fixture with a large function (60 lines is enough to exceed 300 tokens):

```js
test('fault returns a complete large body by default and marks it', async () => {
  const { store, pages } = await fixture()
  try {
    const big = Array.from({ length: 80 }, (_, i) => `  const v${i} = ${i}`).join('\n')
    const file = path.join(store.root, 'src', 'big.js')
    fs.writeFileSync(file, `export function bigFunction() {\n${big}\n  return v79\n}\n`)
    await pages.index({ maxFiles: 100 })
    const full = pages.fault('bigFunction')
    assert.equal(full.truncated, false, 'default should complete an 80-line body')
    assert.match(full.text, /\(complete\)/)
    const small = pages.fault('bigFunction', { budget: 200 })
    assert.equal(small.truncated, true)
    assert.match(small.text, /\(truncated: \d+ more lines?\)/)
  } finally { store.close() }
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --test test/render.test.mjs
```

Expected: default still truncates at 600 (or the marker is absent).

- [ ] **Step 3: Implement**

In `src/page.mjs`, change:

```js
  card: 700, map: 3500, get: 1200, fault: 600, query: 400, diff: 600, graph: 500, pack: 1500,
```

to:

```js
  card: 700, map: 3500, get: 1200, fault: 1200, query: 400, diff: 600, graph: 500, pack: 1500,
```

In `_faultSymbol`, find the header:

```js
      `# fault ${best.name} (${best.kind}) ${best.path}:${startLine}-${sl.end}  ${sl.end - sl.start}L  tokens=${body.tokens}/${budget}` +
```

Replace with:

```js
      `# fault ${best.name} (${best.kind}) ${best.path}:${startLine}-${sl.end}  ${sl.end - sl.start}L  tokens=${body.tokens}/${budget}` +
      (body.truncated ? `  (truncated: ${body.omittedLines ?? '?'} more lines)` : '  (complete)') +
```

In `_faultLine`, find:

```js
    const r = fitWithHeader(code, budget, (body) => `# fault ${f.path}:${line}  showing ${from + 1}-${to} of ${lines.length}  tokens=${body.tokens}/${budget}${stale ? '  [STALE: file changed since index]' : ''}`)
```

Replace with:

```js
    const r = fitWithHeader(code, budget, (body) => `# fault ${f.path}:${line}  showing ${from + 1}-${to} of ${lines.length}  tokens=${body.tokens}/${budget}${body.truncated ? `  (truncated: ${body.omittedLines ?? '?'} more lines)` : '  (complete)'}${stale ? '  [STALE: file changed since index]' : ''}`)
```

- [ ] **Step 4: Run the tests**

```bash
node --test test/render.test.mjs test/retrieval.test.mjs
npm test
npm run selftest
```

Expected: all pass; the explicit-budget self-test still respects 40/80/150/400.

- [ ] **Step 5: Commit**

```bash
git add src/page.mjs test/render.test.mjs
git commit -m "feat(fault): complete large bodies by default and mark them"
```

## Task 2: Static measurement

- [ ] **Step 1: Measure the default fault**

```bash
node bin/memai.mjs fault startWatcher --text | head -1
node bin/memai.mjs fault "src/page.mjs#query" --text | head -1
```

Expected: `tokens=.../1200 (complete)`; the old default was `/600` with a truncated tail.

- [ ] **Step 2: Verify explicit budgets still clamp**

```bash
node bin/memai.mjs fault startWatcher --budget 300 --text | head -1
```

Expected: `/300 (truncated: N more lines)`.

- [ ] **Step 3: Record in `bench/BENCHMARK-0.9.0-fault-complete.md`**

Include: default 600→1,200; the two fault sizes before/after; explicit budget unchanged; tests/self-test; live section pending.

## Task 3: Live A/B

**Files:** `tools/cost-ab.mjs`, `test/cost-ab.test.mjs`.

- [ ] **Step 1: Add the task set**

```js
  faultcomplete: [
    { id: 'FC1', requireCli: true, tolerancePct: 1, expect: /flushDelayMs|DEBOUNCE_MS/,
      prompt: 'Use exactly one local CLI call: `node bin/memai.mjs fault startWatcher --text`. Explain how the watcher debounce delay is computed. Answer with the function name.' },
    { id: 'FC2', requireCli: true, tolerancePct: 1, expect: /reuse|content_hash|version/i,
      prompt: 'Use exactly one local CLI call: `node bin/memai.mjs fault indexFiles --text`. Explain how it decides to reuse a file.' },
    { id: 'FC3', requireCli: true, tolerancePct: 1, expect: /body|source|score/i,
      prompt: 'Use exactly one local CLI call: `node bin/memai.mjs fault "src/page.mjs#query" --text`. Explain how `--body` chooses a symbol.' },
  ],
```

- [ ] **Step 2: Test and commit**

```bash
node --test test/cost-ab.test.mjs
git add tools/cost-ab.mjs test/cost-ab.test.mjs
git commit -m "tools: add the fault-completeness A/B set"
```

- [ ] **Step 3: Prepare same-corpus arms**

```bash
git worktree add ../MemAi-fcbase 720e52c
git worktree add ../MemAi-fctreat HEAD
for d in docs bench test tools; do rm -rf "../MemAi-fcbase/$d"; cp -r "$d" "../MemAi-fcbase/$d"; done
cd ../MemAi-fcbase && git add -A && git rm --cached -q AGENTS.md .agents/skills/memai/SKILL.md 2>/dev/null
node bin/memai.mjs init --agent zcode
cd ../MemAi-fctreat && git add -A && node bin/memai.mjs init --agent zcode
```

- [ ] **Step 4: Run the A/B**

```bash
cd /d/Projects/MemAi
node tools/cost-ab.mjs --baseline ../MemAi-fcbase --treatment ../MemAi-fctreat --tasks faultcomplete --label faultcomplete
```

- [ ] **Step 5: Gate**

Pass: every treatment `billedInput` ≤ baseline × 1.01; total lower; `correct` true; no tool errors. Inspect `toolCalls`/`Read` counts: the treatment should skip whole-file reads that the baseline needed. If the treatment's larger slices cost more without removing reads, discard.

- [ ] **Step 6: Fill the live table and clean up**

Append the six-row table to the benchmark doc; fill values. Remove both worktrees.

## Task 4: Ship or discard

If pass: bump to **0.9.0** in `package.json`, `mcp/paths.mjs`, `src/mem-cli.mjs`, `skills/memai/SKILL.md`; changelog; `node bench/cost.mjs --write-baseline`; create `bench/COST-BASELINE-0.9.0.md`; tests; commit.

If fail: write `bench/NEGATIVE-fault-complete.md` with the table and traces; leave the branch unmerged.
