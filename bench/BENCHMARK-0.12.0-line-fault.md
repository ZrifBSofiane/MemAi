# MemAi 0.12.0 — honest fault labels (line-fault correctness)

Date: 2026-11-24. Baseline `c94cf62` (0.11.0) vs `fix/body-pick-and-line-fault`.
Estimator `ceil(chars/3.966)`; eval numbers are local, no model calls.
Spec: `docs/superpowers/specs/2026-11-24-body-pick-and-line-fault-design.md`.

## What shipped

`fault <path>:<line>` returns the enclosing indexed symbol with honest labels
(`0e71ebf`), and cap-limited slices never claim completeness (`b4d23a4`):

| situation | label |
| --- | --- |
| whole symbol fits the budget | `(complete)` — only here |
| symbol larger than the budget, rest fits | `(rest of <sym>; starts at <start>)` |
| rest also too large | `(truncated: N more lines of <sym>, which ends at <end>)` |
| slice capped at the 220-line `sliceSymbol` limit | `(head of <sym>; slice capped at 220 lines — the symbol's end was not verified)` — both fault modes |
| line outside any symbol | `(window)` + `(<sym> continues to <end>)` when one continues past it |
| stale index | `[STALE …]` in every branch; shifted lines degrade to `(window)` |

Before/after on the motivating case (a mid-function line fault of a 119-line
method): 0.11.0 printed `showing 570-629 of 1172 … (complete)` — a false
completeness claim the skill tells agents to trust; 0.12.0 returns the whole
symbol with `(complete)`, or an honest partial label. `startServer`
(`mcp/server.mjs`, 324 lines) demonstrates the cap path:
`# fault startServer (function) mcp/server.mjs:81-300  220L  …  (head of
startServer; slice capped at 220 lines — the symbol's end was not verified)`.

## Gates

| gate | result |
| --- | --- |
| unit/behaviour tests (`npm test`) | **138/138** (7 fault-honesty tests; 1 new cap test) |
| `npm run selftest` | **18/18** |
| `bench/cost.mjs --check` | exit 0 — fixed total **2,364** ≤ 2,365 baseline |
| eval, shipped 12 | recall@5 **100 %**, MRR **0.80 / 0.74** — identical to 0.11.0 |
| eval, extended 40 | recall@5 **85 % / 90 %**, MRR **0.61 / 0.57** — identical to 0.11.0 |

## Live A/B — no-regression gate (PASS, 1 run)

Composite task set, headless sessions, billed input (input + cache-read +
cache-write), identical corpus in both arms, `--swap-config` harness transplanted
verbatim from `feat/token-overhead@86aa490` for this run (verified, not
persisted — `tools/cost-ab.mjs` on this branch is byte-identical to 0.11.0's):

| task | baseline (0.11.0) | treatment (0.12.0) | delta | correct |
| --- | ---: | ---: | ---: | --- |
| C1 (caller chain of the reuse gate) | 1,087,402 (11 CLI calls) | 367,694 (4) | −66.2 % | yes |
| C2 (card-version delta + reuse-gate body) | 567,852 (8) | 383,424 (6) | −32.4 % | yes |

`verdict.ok = true` — no task above the +1 % tolerance, none with more calls.
Single sample per task: the deltas are dominated by exploration-path variance
(prior rounds measured 100k–450k run-to-run spread); **no token saving is
claimed** — this is a no-regression gate only. Raw:
`bench/cost-ab-2026-11-24-composite.json` / `.md`.

## What was discarded in this round

The round's other fix — an evidence-based `query --body` picker — measured
better than baseline (body-from-expected-file 23 → 28/40 extended, 8 → 11/12
shipped, 0 right→wrong, recall/MRR unchanged) but missed its approved gate
(≥ 34/40). It was reverted under the round's discard rule and the full data is
kept in [`NEGATIVE-body-pick.md`](NEGATIVE-body-pick.md) (probe:
`tools/body-eval.mjs`).

## Reproduce

```bash
npm test
npm run selftest
node bench/cost.mjs --check
node bin/memai.mjs eval --fixtures bench/eval-fixtures.json --k 5 --text
node bin/memai.mjs eval --fixtures bench/eval-fixtures-ext.json --k 5 --text
node bin/memai.mjs fault src/page.mjs:585 --text      # whole-symbol (complete) + (requested line)
node bin/memai.mjs fault startServer --budget 3000 --text   # cap-limited head label
```
