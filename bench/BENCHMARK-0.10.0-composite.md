# 0.10.0 composite-ops benchmark

Baseline: 0.9.0 (`82d73e8`, fault completeness). Estimator `ceil(chars / 3.966)`.

## Change

- **`query --body --deep`**: locate, materialise the selected body, and append its
  one-hop callees/callers in one call.
- **`diff --faults a,b`**: append slices of the named symbols to a resume delta.
- **Same-file callers**: `fault --deep` no longer discards call sites that live in
  the same file; it resolves them to the enclosing function, so a body slice can
  name its callers.

## Live A/B (2 tasks × 2 arms, same corpus, CLI-only)

| task | baseline | treatment | delta | CLI calls |
| --- | ---: | ---: | ---: | --- |
| C1 callers of the reuse function | 1,459,696 | 764,310 | **−47.6 %** | 13 → 7 |
| C2 resume delta + reuse body | 818,401 | 864,533 | +5.6 % | 12 → 11 |
| **total** | **2,278,097** | **1,628,843** | **−28.5 %** | **25 → 18** |

All answers correct.

- **C1 is the target case.** The treatment’s one `query --body --deep` named
  `indexFiles` and `indexCorpus`; the baseline’s body had no callers and it took
  13 calls to reconstruct them.
- **C2** used one fewer call but +5.6 % billed input: the appended `distilFile`
  slice and a longer exploration path outweighed the removed turn. The total and
  the call count are clearly better; this trade is recorded rather than hidden.

Verdict: **ship on the total** (−28.5 %, −7 CLI calls), with C2’s +5.6 % accepted.

## Reproduce

```bash
node bin/memai.mjs query "distil file contentHash force" --body --deep --text
node bin/memai.mjs diff --since <card version> --faults distilFile --text
node tools/cost-ab.mjs --baseline ../MemAi-cobase --treatment ../MemAi-cotreat --tasks composite --label composite
```

Raw artifacts: `bench/cost-ab-2026-11-23-composite.json` and `.md`.
