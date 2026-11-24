# Negative result — `query --body` evidence picker (fix 1 of the 0.12.0 round)

Date: 2026-11-24
Branch: `fix/body-pick-and-line-fault` (revert commits `c1a4aab`, `3811bcb`)
Baseline: `main` at `c94cf62` (0.11.0)
Spec: `docs/superpowers/specs/2026-11-24-body-pick-and-line-fault-design.md` (fix 1 gate: body from the
expected file ≥ 34/40 extended, 12/12 shipped, 0 right→wrong, recall/MRR identical)
Raw artifacts: `.tmp/120-gate.md`, `.tmp/120-iterations.md`, `.tmp/120-base-body-*.json`,
`.tmp/120-after-body-*.json`; probe committed as `tools/body-eval.mjs`

## What was built (commit `a118251`, reverted by `c1a4aab`)

An evidence-based picker for `query --body`, replacing the substring guess:
stopword-filtered camel-case term matching (whole-name 6 / segment 3 / prefix 2 / substring 1),
candidate tiers (source > support > test), file-rank preference, signature- and body-only term
bonuses (capped 3+3), a 120-candidate pool over displayed hits + `symbolSearch(40)` +
`searchPages(40)` callables, deterministic sort, and a `body: none` confidence floor replacing
the old always-guess behaviour. A companion eval metric (`evaluate()` body result, commit
`8917477`, reverted by `3811bcb`) measured body-from-expected-file per fixture.

## Measured result — better than baseline, below the gate

40-fixture extended eval, index mode (12-fixture shipped set is a verbatim subset):

| metric | baseline (0.11.0) | picker (committed) | best iteration | gate |
| --- | ---: | ---: | ---: | --- |
| body from expected file, ext | 23/40 | 27/40 | **28/40** | ≥ 34 — **FAIL** |
| body from expected file, shipped | 8/12 | 11/12 | 11/12 | 12/12 — **FAIL** |
| fixtures right at baseline turned wrong | — | 0 | 0 | 0 — pass |
| recall@5 / MRR (index/hybrid) | 85/90 %, 0.61/0.57 | 88/93 %, 0.63/0.58 | same | ≥ baseline — pass |
| tiny (<120 tok) bodies | 17/40 | — | — | (floor removes the worst) |

Iterations (one lever at a time, `.tmp/120-iterations.md`): prefix rule 4→3 chars **−1** (worse,
reverted); substring weight 1→2 **0**; floor 2→3 **0**; body-only files 3→6 + budget 40→60 **+1**
(best). No stacking was tried because the best lever moved +1 against a +7 gap. Full suites,
selftest and the cost check were green in every configuration.

## Why it failed

The gate's premise: the expected file is in the hit list 34/40 times, so a picker should be able
to reach 34. The residual 12 misses are structural, not weight problems:

- **Confident wrong-file picks on vocabulary the scorer over-weights**: "resolve project root"
  picks a stronger name match in `src/page.mjs` over `mcp/paths.mjs` in every configuration
  (this one fixture alone kept shipped at 11/12); "cli boolean flag parsing" picks
  `tools/cost-ab.mjs` over `src/mem-cli.mjs`; "mcp server jsonrpc stdio transport" picks
  `src/init.mjs` over `mcp/server.mjs`.
- **Recall-bounded misses**: for "reverse importer chains cycle" and "transitive importers blast
  radius" the expected file is not among the page hits feeding the pool — the picker correctly
  answers `none`, but the gate wants the right file, which no candidate weight can produce.
- **Naming-vocabulary gaps**: "token calibration chars per token" needs `calibration~calibrate`
  stemming; the pool has no such identifier, so `src/tokens.mjs` wins on the shared `token`.

Closing these needs new mechanisms (stemming, pool expansion, test-helper demotion), each with
its own eval-iteration cycle — out of scope for the approved lever list.

## Decision

**Discard fix 1** under the round's rule (gate missed → revert and record; do not soften the
claim). Reverts: `c1a4aab` (picker + tests), `3811bcb` (eval metric — shipping a "body: file=58 %"
metric without the picker would advertise a regression publicly). `tools/body-eval.mjs` stays:
it is the measurement probe for any future attempt.

**Fix 2 (symbol-aware `path:line` faults + the cap-limited honesty fix) ships**: it passed its
own tests and review independently (`0e71ebf`, `b4d23a4`) and does not depend on the picker.

## What a future attempt must solve (from the miss catalogue)

1. The `resolve project root` class: name-match strength must incorporate file-path evidence
   (`paths.mjs` vs `page.mjs`), not just identifier segments.
2. The two `none`-by-recall-loss fixtures: body candidates need a wider pool (auto-rg callables
   or import-graph neighbours of the top hits).
3. Stemming (`calibration~calibrate`, `detection~detect`) with the same eval gate and the
   0-right→wrong bound.
4. The shipped set's arithmetic: it is a subset of ext, so ext ≥ 34 with 0 regressions implies
   shipped ≥ 11; the 12th shipped fixture is the `resolve project root` class above.
