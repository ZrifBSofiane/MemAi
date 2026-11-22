# 0.7.0 benchmark — head-to-head vs graphify, and a same-tree A/B against 0.5.0

Re-run after the round-trip reducers and ranking fixes. Two measurements:

1. the six-question head-to-head against graphify on the current tree;
2. a **same-tree A/B of 0.5.0 code vs 0.7.0 code**, so the ranking change is
   judged on identical input, not on a different corpus.

## Setup

- Corpus: this repository at `feat/round-trip-reducers` **with the bench archives
  removed**, so it matches the 0.5.0-era tree shape: 81 files, 15.1K LOC,
  card 296 tok, map 988 tok.
- graphify `graphifyy==0.9.34`: **902 nodes / 1,650 edges / 51 communities**,
  ~14 s, 0 LLM tokens.
- MemAi `index`: 0.7 s, 0 tokens.
- Machine: Windows 11 x64, Node 24.14, ripgrep 15.1.0, Python 3.14.

## Same-tree A/B — 0.5.0 code vs 0.7.0 code

Both arms run on the identical working tree (0.5.0 code checked out into a
second copy), same store settings, same queries.

| # | task | 0.5.0 | **0.7.0** | delta |
| --- | --- | --- | --- | --- |
| B1 | how/body — watch debounce (query + fault) | 731 | **729** | −2 |
| B2 | callers — `fault indexFiles --deep` | 184 | **184** | 0 |
| B3 | reverse-deps — `graph resolveDb` | 189 | **189** | 0 |
| B4 | import-chain — `graph --shortest` | 39 | **39** | 0 |
| B5 | body-only — `query --rg` | 255 | **234** | −21 |
| B6 | locate+body — `fault estTokens` | 63 | **63** | 0 |
| | **totals** | **1,461** | **1,438** | **−23 (−1.6%)** |

The gain is the query renderer: locator previews are 80 chars instead of 120,
which trims every `query` response (B5 drops 21 tokens) without changing which
files are found. No task got more expensive.

## Six-question head-to-head (0.7.0 vs graphify 0.9.34)

| # | graphify (tok) | MemAi 0.7.0 (tok) | verdict |
| --- | --- | --- | --- |
| B1 | 1,646 — truncated, no code | **729** | MemAi |
| B2 | **54 — MISS** | **184** | MemAi |
| B3 | 1,929 (query 1,638 + affected 291) | **189** | MemAi, 10× |
| B4 | **87 — MISS** (directed + undirected) | **39** | MemAi |
| B5 | **7 — MISS** | **234** | MemAi |
| B6 | 436 — two rounds, no body | **63** | MemAi |
| | **4,159** | **1,438** | **2.89×** |

Same outcome shape as 0.5.0: graphify misses B2/B4/B5, truncates B1/B3, needs two
rounds on B6.

## Self-eval

`memai eval --fixtures bench/eval-fixtures.json --k 5` on this tree: **100%
recall@5** both modes, MRR **0.80** index / **0.80** hybrid. (On the full repo
tree the hybrid MRR reads 0.73 — the extra bench/doc pages change ranks, not
recall.) The 40-fixture development matrix (`bench/eval-fixtures-ext.json`) went
70% → **85%** index and 75% → **93%** hybrid across the ranking fixes.

## New in 0.7.0: round-trip reducers

- `query --body` returns hits **plus** the top callable symbol's body in one
  call. Honest limit measured here: the chosen symbol is *best-effort* — for B1
  it returned `watcherAlive` (58 tok), not the curated `startWatcher`. It saves a
  model turn when the symbol name is unknown; it does not replace a curated
  choice, so the scored B1 answer still uses query + explicit fault.
- `fault a,b,c` and `get file:a.js,file:b.js` batch slices into one call.

## Reproduce

```bash
git clone -b feat/round-trip-reducers <repo> && cd <clone>
rm bench/BENCHMARK-0.4.0.md bench/BENCHMARK-0.5.0.md bench/GUARD-LIVE-ANALYSIS.md bench/eval-fixtures-ext.json
graphify update . && memai index
# six questions: see BENCHMARK-0.5.0.md (same commands, 0.7.0 flags unchanged)
```

## Method notes

- Same estimator on both sides (`ceil(chars / 3.966)`); graphify at its default
  2,000-token budget, MemAi from each envelope's `tokens` field.
- The same-tree A/B is the regression gate: **0.7.0 must not exceed 0.5.0 on any
  task**, and does not (B5 is 21 lower, B1 2 lower, the rest equal).
