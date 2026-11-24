# `query --body` evidence picker and symbol-aware `path:line` fault — design

Date: 2026-11-24
Status: design approved in conversation; awaiting spec review; implementation not started
Baseline: `main` at `c94cf62` (0.11.0, PR #19 merged)
Branch: `fix/body-pick-and-line-fault` → proposed release 0.12.0

## Goal

Make the two one-call operations return a **correct, honestly labelled** answer,
so an agent never needs a second call to recover from a wrong one:

1. `query --body` must return the body of a callable from the file that answers
   the question, or say that it has no match.
2. `fault <path>:<line>` must print `(complete)` only when the slice really is
   the whole symbol.

Both are correctness fixes. The expected token effect is fewer follow-up calls;
it is **not** claimed as a measured saving unless the live A/B shows one.

## Problem, measured on the baseline tree

Estimator and fixtures: the repo's own (`bench/eval-fixtures*.json`, index mode,
`k=5`, 40 extended fixtures = 12 shipped + 28).

| Metric | Baseline |
| --- | ---: |
| hit list: expected file in top 5 (recall@5) | 34/40 (85 %) |
| hit list: expected file at rank 1 | 20/40 |
| `--body`: body from the expected file | **23/40 (58 %)** |
| `--body`: body is the top source callable shown in the list | 4/40 |
| `--body`: bodies under 120 tokens | 17/40 |

Reproductions on the baseline:

- `query "dispatch result text content wrap reply page" --body` → hit #1 is
  `dispatch` (`mcp/tools.mjs:257`), body is `pageTextVersion`
  (`src/extract.mjs:303`, 27 tokens).
- `query "how does fault decide a slice is complete" --body` → body is
  `isAppError` (`bench/fixture.mjs:607`, 17 tokens): the stopwords `is` and `a`
  substring-match its name.
- `fault src/page.mjs:570` → `showing 570-629 of 1172 … (complete)` while
  `query()` runs to line 688. The skill tells agents a `(complete)` slice is
  the whole symbol and not to read the file.

Root causes:

- `query()` body picker (`src/page.mjs`, the `if (body)` block): query terms are
  matched as raw substrings of the lowercased name with no stopword list; the
  candidate pool takes callables from up to 40 full-text page hits that need not
  relate to the query; a +5 bonus for any callable in a displayed page hit
  outranks the +3 name match; there is no confidence floor, so `pool[0]` is
  always returned, falling back to consts.
- `_faultLine()` returns a fixed 60-line window and appends `(complete)`
  whenever that window fits the budget.

## Scope

In scope: the body picker, `_faultLine`, the `eval` body metric, tests,
accuracy-only wording of the skill and MCP schema, the 0.12.0 release record.

Out of scope: hit-list ranking (`symbolSearch`, `searchPages`, `pageScore`);
explicit `path:a-b` ranges; fault budget tiers; hook-based bookkeeping; any
session-level feature.

The two fixes are gated separately and ship or are discarded independently.

## Fix 1 — evidence-based body selection

All work is local (no model tokens). The hit list is unchanged by `--body`, and
the success-path output is unchanged: a `body: <symbol> (<n> tok)` line
followed by the symbol's fault text.

### Terms

`terms(q)`:

1. Split the query on `/[^a-zA-Z0-9_$]+/`.
2. Split each token at inner camel-case boundaries and keep both forms
   (`verifyToken` → `verifyToken`, `verify`, `Token`).
3. Lowercase everything.
4. Drop stopwords, tokens shorter than 2 characters, and duplicates; keep at
   most 8.

Stopwords: `a an the and or of in on at to for from by with without as is are
was were be been being do does did how what when where which who whom whose why
that this these those it its their there here per one two any all some no if
then than so can could should would will shall may might must have has had`.

If `terms` is empty there is no body.

### Candidate pool

Callables only (`function`, `method`, `class`), deduplicated by
`path|name|line`, built from:

1. callables shown in the displayed hit list;
2. `symbolSearch(q, { limit: 40 })`;
3. callables of the top 40 full-text page hits (as today, capped at 120).

Every candidate carries:

- `tier`: 0 for source, 1 for support paths (top-level `bench/`,
  `benchmarks/`, `fixtures/`, `examples/`), 2 for test paths (`isTestPath`).
  Doc paths (`isDocPath`) are never candidates.
- `fileRank`: the best index of the candidate's file in the displayed hit
  list; otherwise its position in the page-hit list after the displayed files.

### Score

Per distinct term, the best of:

| Match | Weight |
| --- | ---: |
| term equals the whole lowercased name (ignoring a leading `_` or `$`) | 6 |
| term equals a name segment (camel-case, `_`, `$`, digits split) | 3 |
| term and a segment share a prefix of ≥ 4 chars covering ≥ 60 % of the shorter | 2 |
| term of ≥ 5 chars is a substring of the name | 1 |
| term not matched by the name, present as a word in the signature | 1 |
| term matched by neither, present as a word in the symbol's body | 1 |

Signature-only and body-only bonuses are each capped at 3. Body-only bonuses
are computed only for candidates in the 3 files with the lowest `fileRank` (at
most 40 candidates), using `sliceSymbol` with its 220-line cap; an unreadable
file scores 0.

### Selection

Sort by: score descending, tier ascending, `fileRank` ascending, shorter path,
path, earlier line. The first candidate is chosen.

**Floor.** If its score is below 2, no body is returned:

```text
body: none — no source callable matches; fault the hit you need
```

JSON: `body: { ok: false, reason: 'no-match' }`. A body is never a guess.

Ties are resolved by tier first so test and bench paths lose every tie to
source paths; a support or test callable still wins when it scores strictly
higher. The earlier-line tie-break keeps the existing `startWatcher` test valid.

### Deep

`deep` is passed to the fault of the chosen symbol exactly as today.

## Fix 2 — `_faultLine` returns the enclosing symbol

`(complete)` means the same thing in every fault mode: the slice is the whole
symbol.

1. Find the innermost indexed code symbol whose start line is ≤ the requested
   line (`isCodeSym`) and run `sliceSymbol` on the current file. `sliceSymbol`
   returns an exclusive end; the line is inside when
   `start ≤ line < end`. A recorded symbol line that no longer contains the
   symbol's name counts as "not inside".
2. Return lines and labels as follows:

| Situation | Returned lines | Label |
| --- | --- | --- |
| inside symbol S, whole S fits the budget | all of S, unnumbered, exactly as `path#S` renders it | `(complete)` |
| inside S, S too large, `line..end(S)` fits | numbered `line..end(S)` | `(rest of S; starts at <start>)` |
| inside S, `line..end(S)` too large | numbered prefix of that range | `(truncated: N more lines of S, which ends at <end>)` |
| not inside a symbol | the existing numbered 60-line window starting at the requested line | `(window)`, plus `(truncated: N more lines of this window)` if it overflows |

3. In the window case, when a symbol starts inside the window and continues past
   its last line, append `(<symbol> continues to <end>)` for the last such
   symbol.
4. A stale file keeps today's `[STALE …]` note in every branch. Errors and
   out-of-range lines behave as today.

Headers keep the `# fault <path>:<line>` prefix the line mode uses today:

```text
# fault query (method) src/page.mjs:570-688  119L  tokens=T/B  (complete)  (requested line 620)
# fault src/page.mjs:630  showing 630-688 of 1172  tokens=T/B  (rest of query; starts at 570)
# fault src/page.mjs:630  showing 630-680 of 1172  tokens=T/B  (truncated: 8 more lines of query, which ends at 688)
# fault src/page.mjs:100  showing 100-159 of 1172  tokens=T/B  (window)  (query continues to 688)
```

The whole-symbol header is `_faultSymbol`'s header for S; the `(requested line
…)` note appears only when the requested line is not S's first line.

Result fields: `mode` stays `'line'`; `line` and `lineEnd` are the **returned**
range (so a later `Read` uses them as offset/limit); add `symbol`, `symbolKind`
and `requestedLine`.

## Measurement

`evaluate()` gains a `body` result: for every fixture it runs
`query(q, { k, body: true })` and counts the body as right when `body.ok` and
`body.path` is the expected file (same path normalisation as recall). The text
adds one line, `body: file=<pct>%  (<n>/<total>)`, and lists misses as
`body-miss: "<q>" → expected <expect>, got <path>|none`. JSON gains
`results.body`. `--modes` and the recall/MRR figures are unaffected. Output is
additive, so the CI eval smoke keeps passing.

## Public numbers touched

Additive only; no existing benchmark page is rewritten.

| Number | Baseline | Gate |
| --- | ---: | --- |
| body from expected file, extended (40) | 23 | **≥ 34** |
| body from expected file, shipped (12) | 8 | **12** |
| fixtures right at baseline that become wrong | — | **0** |
| recall@5 / MRR, index and hybrid, both fixture sets | shipped 100 % / 0.80 · 0.74; extended 85 % / 0.61 · 90 % / 0.57 | **identical** |
| static surfaces and delivered rows (`bench/cost.mjs --check`) | `COST-BASELINE-0.11.0.md` | **exit 0** |

## Instruction surfaces

No surface grows and no sentence is added; the new replies describe themselves.
Only wording that would become inaccurate is corrected:

- `skills/memai/SKILL.md`, step 2: "the top symbol's body" → "the best-matching
  source symbol's body".
- `skills/memai/SKILL.md`, step 3: "one line range" → "the symbol containing
  that line, or a window outside symbols".
- `mcp/tools.mjs`, `body` parameter: "the top symbol body" → "the best-matching
  source symbol body".

The init block and the four adapter `AGENTS.md` files are unchanged: every
sentence in them stays true, and the fix makes "A `(complete)` fault is the
whole symbol" true for `path:line` as well.

## Tests

Fix 1, beside the existing `--body` tests in `test/retrieval.test.mjs`:

1. stopwords are ignored: `is`/`a` no longer select `isAppError`.
2. whole-segment match beats an unrelated substring match.
3. floor: nothing matches → `body.ok === false`, `reason === 'no-match'`,
   text carries `body: none`.
4. consts are never returned, including when only consts match.
5. same score: source beats support and test paths.
6. a term found only in a body selects the callable in the full-text-matched
   file.
7. an exact identifier query returns that symbol.
8. the three existing `--body` tests stay green.

Fix 2, beside the existing fault tests:

9. line at a symbol's start → whole symbol, `(complete)`, returned range = the
   symbol's range.
10. line inside a symbol that fits → whole symbol.
11. symbol larger than the budget → rest from the requested line with the
   symbol's end named; never `(complete)`.
12. line outside any symbol → `(window)`, with a continuing symbol named.
13. markdown file → `(window)`.
14. lines shifted after an edit without re-index → `(window)` plus `[STALE]`.

`evaluate`:

15. the `body` result and text line are present and correct on a small fixture
    list.

## Gates

1. `memai eval` on both fixture sets — the primary gate for fix 1; it decides
   ship or discard. Weights and the stopword list are starting values: each
   adjustment is made one at a time and recorded with its eval delta.
2. `npm test` and `npm run selftest`.
3. `node bench/cost.mjs --check` exits 0.
4. One live A/B on the composite set (C1, C2) with `tools/cost-ab.mjs`, per
   `bench/NEGATIVE-overhead.md` and the known gotchas: identical corpus in both
   arms, plan and spec docs dropped from both, watcher stopped in scratch
   trees, global config hash checked before and after. Gate: no task above
   +1 % billed input and no task with more calls. It is reported as "no
   regression" only, never as a win; a failing task is re-run up to 3 samples
   before a verdict.

If fix 1 misses its gate it is reverted and recorded as
`bench/NEGATIVE-body-pick.md` with the raw eval output. Fix 2 is judged only by
its tests and gates 2–4.

## Release

- 0.12.0: version in `package.json`, `src/mem-cli.mjs`, `mcp/paths.mjs`,
  `skills/memai/SKILL.md`; CHANGELOG entry.
- `bench/BENCHMARK-0.12.0-body-pick.md`: before/after eval, the live A/B
  result, and the parameter adjustments with their deltas.
- README: one additive line for the body metric in the eval section; no existing
  figure is edited.
- The PR is opened for the user to merge only after they explicitly confirm the
  push. The user merges; nothing is merged by the agent.

## Risks

- **More `body: none` than today.** Where today's guess happens to be right the
  agent would now fault the hit itself. Bounded by the "0 right→wrong" gate.
- **Live variance.** Sub-1 % effects are not resolvable at one sample, so no
  token saving is claimed from the live run.
- **Wording edits change behaviour unpredictably** (four prior losses). The
  edits here replace three phrases with more accurate ones that must not
  increase the measured surface tokens; gates 3 and 4 cover them.
