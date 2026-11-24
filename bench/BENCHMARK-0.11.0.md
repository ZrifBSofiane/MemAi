# MemAi 0.11.0 — complete benchmark

Date: 2026-11-24. Tree: `0.11.0` (main + the 0.9/0.10/0.11 levers). Node v24.14.
Estimator: `ceil(chars / 3.966)`, calibrated against provider-reported usage.
All numbers are local: no model calls in the scenario/eval/cost harnesses.

## 1. Scenario benchmark — 14 tasks, 4 corpora

Full per-task table and method: [`RESULTS.md`](RESULTS.md). Corpora: generated
200-file API fixture, real 288-file npm CLI, MemAi itself (self-host), bundled
DSH adapter.

| scenario | input tokens | cost (off-peak) |
| --- | ---: | ---: |
| A — grep + read the needed files | 91,465 | $0.014392 |
| B — read + model-written summary handoff + re-read | 103,849 | $0.022924 |
| C — card + curated paging plan | 16,724 | $0.003181 |
| **C\* — card + paging + completion to 100 % recall** | **24,216** | **$0.004304** |

- **3.78× fewer input tokens** than naive reads (**67,249 saved**); the cheap
  plan is **5.47×**.
- **4.29× fewer** than the summary-handoff workflow; **5.3× cheaper in dollars**
  (output is 200× a cache-hit input token).
- **100 % recall on all 14 tasks**; per-task ratio 1.10×–10.02×.
- By corpus (A/C\*): atlas fixture 1.65×, npm CLI 3.57×, MemAi self-host
  **6.63×**, DSH adapter 2.03×.
- One session, six fixture tasks: card + paging **7,174** vs **14,362** to read
  the needed files (**2.00×**).
- Delta resume after 3 files change: **5.47×** (atlas) and **9.30×** (npm CLI);
  diff text is ~102–104 tokens.

## 2. Context cost — fixed and delivered

| surface | tokens | cadence |
| --- | ---: | --- |
| MCP schema | 1,058 | per request |
| MCP instructions | 208 | session init |
| init block | 590 | session |
| skill frontmatter | 222 | skill catalog |
| card (incl. version line) | 287 | session |
| **total fixed** | **2,365** | |

Delivered text: `B1-query 132`, `B1-fault 557`, `B2 128`, `B3 192`, `B5 218`,
`B6 69`. Fault rows carry the completeness marker (+3 tokens on complete slices).
Ten-turn model: 495 once + 10 × 1,870 = 19,195.

The fixed-overhead compaction was measured and **discarded** (see negatives);
0.9–0.11 reduce turns and improve ranking instead.

## 3. Retrieval eval

| fixtures | index | hybrid |
| --- | --- | --- |
| shipped (12) | **100 %** recall, MRR **0.80** | **100 %** recall, MRR **0.74** |
| extended (40) | **85 %** recall, MRR **0.61** | **90 %** recall, MRR **0.57** |

The 0.11.0 ranking fix (docs cap) raised shipped index MRR from 0.68 to 0.80 and
extended recall from 83/88 to 85/90 without a recall loss. Remaining extended
misses are the three graph-intent queries plus granular-tools and token-calibration.

## 4. Feature A/Bs since 0.7.0

| lever | gate | result |
| --- | --- | --- |
| 0.9.0 fault completeness | live billed A/B, 3 tasks | **−31.5 %** total; target **−58.2 %** (grep+Read removed) |
| 0.10.0 composite ops | live billed A/B, 2 tasks | **−28.5 %**, **25 → 18** local CLI calls |
| 0.11.0 ranking | same-tree eval A/B | shipped MRR **0.68/0.61 → 0.80/0.74**; extended recall **83/88 → 85/90 %** |
| payload `--text` docs | live billed A/B | **+19 %** — discarded |
| compact block/skill/card | live billed A/B | **+151 %** — discarded |
| compact schema/instructions | live billed A/B | **+9 %** — unproven, not shipped |
| stop-rule line | live billed A/B | **+26 %** — discarded |

Records: [0.9.0](BENCHMARK-0.9.0-fault-complete.md),
[0.10.0](BENCHMARK-0.10.0-composite.md), [0.11.0](BENCHMARK-0.11.0-ranking.md),
[payload negative](NEGATIVE-payload.md),
[block/skill negative](NEGATIVE-overhead-B.md),
[overhead negative](NEGATIVE-overhead.md),
[stop-rule negative](NEGATIVE-stop-rule.md).

The consistent result: changes that remove a **turn** or make the **first hit
correct** win; advisory instruction changes add tokens without reliably changing
the model's exploration path.

## 5. Reproduce

```bash
npm test                       # 120+ unit/protocol/init/hook tests
npm run selftest               # 18/18 end-to-end checks
node bench/bench.mjs           # regenerate RESULTS.md
node bench/cost.mjs            # fixed surfaces + delivered payloads
node bin/memai.mjs eval --fixtures bench/eval-fixtures.json --k 5
node bin/memai.mjs eval --fixtures bench/eval-fixtures-ext.json --k 5
```
