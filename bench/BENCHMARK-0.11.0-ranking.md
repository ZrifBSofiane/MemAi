# 0.11.0 ranking benchmark

Baseline: 0.10.0 (`01c5d7f`). This is a same-tree A/B: identical corpus, only the
ranking code differs. The retrieval eval is the correct gate for a ranking lever;
a live billed A/B on the fixture strings is contaminated because the fixture
JSONs live in the corpus and contain the queries and expected paths.

## Change

- **Docs page cap.** A docs filename match could add +3 `pathBoost` to a page
  (`3.4` total) and drown every code page for token/doc queries. Docs now score
  `0.4 + pathBoost × 0.1` (max 0.7); tests keep their page demotion.
- **Ripgrep docs/test cap.** The same cap applies to `--rg` text hits, which
  previously used the raw `pathBoost` and kept the docs flood in hybrid mode.

A path-matched page injection was tested and **rejected**: it lowered shipped
index MRR (0.80 → 0.76) and the extended MRR without gaining recall.

## Same-tree eval A/B

| set | baseline | treatment |
| --- | --- | --- |
| shipped recall@5 | 100 % | **100 %** |
| shipped MRR index / hybrid | 0.68 / 0.61 | **0.80 / 0.74** |
| extended recall index / hybrid | 83 % / 88 % | **85 % / 90 %** |
| extended MRR index / hybrid | 0.56 / 0.50 | **0.62 / 0.58** |

No recall dropped. Two fixtures flipped from miss to hit:

- `benchmark naive handoff scenarios` → `bench/bench.mjs` (index).
- `retrieval miss statistics per tool` → `src/store.mjs` (hybrid).

The remaining extended misses are the three graph-intent queries plus the
granular-tools and token-calibration fixtures; those need lexical/semantic help,
not another score cap.

## Reproduce

```bash
node bin/memai.mjs eval --fixtures bench/eval-fixtures.json --k 5
node bin/memai.mjs eval --fixtures bench/eval-fixtures-ext.json --k 5
```
