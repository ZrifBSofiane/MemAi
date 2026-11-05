# MemAi token benchmark — measured results

Generated 2026-11-05T16:09:18.315Z on Node v24.14.0 (win32). Every number below is measured by running the real `memai` code over the corpus on this machine; none are estimates of "typical" usage except the stated assumptions.

**Estimator.** tokens = ceil(chars / 3.966). The 3.966 chars/token constant is calibrated against *provider-reported* usage in this machine's DSH session logs: 6 sessions, 252 assistant turns, 37,092,363 prompt tokens (input + cache-read + cache-write) vs 147,103,482 chars of reconstructed visible context. chars/4 would under-count by ~0.9%. See `tools/calibrate-session.mjs`.

**Prices** (deepseek-flash, $/1M tokens, off-peak): cache-miss input **0.15**, cache-hit input **0.003**, output **0.60**. Peak hours (01:00–04:00 and 06:00–10:00 UTC, Mon–Fri) are 2×: 0.30 / 0.006 / 1.20; every cost below doubles at peak while all token ratios are price-independent. Assumptions: tool-call overhead 45 tokens per call, final answer 80 output tokens (charged in every scenario), handoff summary target 1,200 tokens. All inputs are priced cache-miss unless stated; the paged card is a byte-stable prefix and therefore cacheable — the "cacheable card" row prices the card portion at the hit rate. Note the asymmetry: one output token costs 200× a cache-hit input token (0.60 / 0.003), so anything that makes the model *write* is expensive.

## 1. Corpora

| corpus | files | bytes | tokens if read fully | card tokens | map tokens | index ms |
| --- | --- | --- | --- | --- | --- | --- |
| atlas-fixture | 199 | 289488 | 73043 | 239 | 3499 | 598 |
| npm-cli | 288 | 2107230 | 531439 | 200 | 2334 | 711 |
| memai | 65 | 487774 | 122370 | 270 | 671 | 217 |
| dsh-adapter | 7 | 17077 | 4283 | 218 | 70 | 14 |

`full_tokens` is the measured token count of every indexed file concatenated — i.e. the cost of "read the whole repo". `card` and `map` are the actual pages an agent loads instead. Indexing is local CPU/disk: **0 model tokens**.
Map was hard-capped at the 3500-token budget for `atlas-fixture`; omitted files remain reachable via `query`/`fault`, which is the intended budget behaviour rather than an error.

## 2. Per-task results (input tokens; lower is better)

| task | type | A naive | B handoff | C paged (plan) | C* paged (complete) | A/C* | recall | C* cost | A cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| atlas-fixture / locate-auth | locate | 2848 | 3915 | 1062 | 1469 | 1.94× | 100% | $0.000268 | $0.000475 |
| atlas-fixture / understand-billing | understand | 2532 | 3481 | 965 | 1347 | 1.88× | 100% | $0.000250 | $0.000428 |
| atlas-fixture / add-endpoint | change | 2816 | 3808 | 1352 | 2063 | 1.37× | 100% | $0.000357 | $0.000470 |
| atlas-fixture / refactor-invoice | refactor | 2532 | 3481 | 913 | 1233 | 2.05× | 100% | $0.000233 | $0.000428 |
| atlas-fixture / locate-cache | locate | 1286 | 2061 | 649 | 1100 | 1.17× | 100% | $0.000213 | $0.000241 |
| atlas-fixture / review-auth-service | review | 2348 | 3248 | 1077 | 1316 | 1.78× | 100% | $0.000245 | $0.000400 |
| npm-cli / understand-workspaces | understand | 2777 | 3555 | 741 | 1096 | 2.53× | 100% | $0.000212 | $0.000465 |
| npm-cli / locate-auth | locate | 5828 | 6610 | 979 | 1170 | 4.98× | 100% | $0.000224 | $0.000922 |
| npm-cli / review-cache | review | 5820 | 6644 | 1352 | 1745 | 3.34× | 100% | $0.000310 | $0.000921 |
| memai / understand-page-model | understand | 11488 | 12284 | 1273 | 2634 | 4.36× | 100% | $0.000443 | $0.001771 |
| memai / locate-extractor | locate | 12905 | 13743 | 1202 | 2346 | 5.50× | 100% | $0.000400 | $0.001984 |
| memai / review-cli | review | 8062 | 8689 | 911 | 1572 | 5.13× | 100% | $0.000284 | $0.001257 |
| dsh-adapter / understand-dsh-adapter | understand | 3346 | 4050 | 1602 | 1873 | 1.79× | 100% | $0.000329 | $0.000550 |
| dsh-adapter / locate-tool-surface | locate | 2561 | 3205 | 783 | 994 | 2.58× | 100% | $0.000197 | $0.000432 |

**C** is the curated demand-paging plan (query/fault/get) — the cheap path. **C\*** additionally pages every expected file the plan did not touch, so its recall is 100% by construction and the token comparison against A is apples-to-apples. The headline ratio uses C\*.

## 3. Aggregate

| scenario | input tokens | output tokens | cost off-peak | cost at peak (2×) |
| --- | --- | --- | --- | --- |
| A naive reads | 67149 | 1120 | $0.010744 | $0.021489 |
| B summary handoff | 78774 | 11485 | $0.018707 | $0.037414 |
| C paged (plan only) | 14861 | 1120 | $0.002901 | $0.005802 |
| C* paged (complete) | 21958 | 1120 | $0.003966 | $0.007931 |
| C* with cacheable card | 21958 | 1120 | $0.003463 | $0.006925 |

**Measured saving: 3.06× fewer input tokens than naive reads (45,191 tokens saved across 14 tasks), and 3.59× fewer than the summary-handoff workflow.** At off-peak list prices that is $0.010744 → $0.003966 for the same 14 tasks; the cheap-plan number is 4.52×. Because output is 200× the cache-hit price, B is the most expensive scenario in dollars even though its input-token count only looks mildly worse: B costs $0.018707 vs C* $0.003966 (**4.7× more**).

### By corpus

| corpus | tasks | A naive | C* paged | A/C* | page/read content | recall | A cost | C* cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| atlas-api fixture (generated, 200 files) | 6 | 14362 | 8528 | 1.68× | 50% | 100% | $0.002442 | $0.001567 |
| npm CLI (real, shipped with Node) | 3 | 14425 | 4011 | 3.60× | 22% | 100% | $0.002308 | $0.000746 |
| MemAi itself (real, self-host) | 3 | 32455 | 6552 | 4.95× | 17% | 100% | $0.005012 | $0.001127 |
| DeepSeek Harness adapter (real, bundled in this repo) | 2 | 5907 | 2867 | 2.06× | 40% | 100% | $0.000982 | $0.000526 |

### One session, six tasks (fixture)

Loading the card once and paging for six tasks costs **7,058** input tokens vs **14,362** for reading the needed files — **2.03×** less. card loaded once per session; each task then pays only its query/fault calls.

## 4. Delta resume (new session after 3 files change)

| corpus | changed files | A re-read changed files | B delta summary handoff | D diff + faults | A/D |
| --- | --- | --- | --- | --- | --- |
| atlas-fixture | 3 | 2607 | 299 | 469 | 5.56× |
| npm-cli | 3 | 4127 | 296 | 436 | 9.47× |

- `atlas-fixture`: diff text is **104** tokens for 199 indexed files; re-index took 245 ms (local, 0 model tokens). Paged resume (diff + 2 faults) costs 469 input tokens vs 2607 to re-read the 3 changed files (**5.56×**).
- `npm-cli`: diff text is **102** tokens for 111 indexed files; re-index took 157 ms (local, 0 model tokens). Paged resume (diff + 2 faults) costs 436 input tokens vs 4127 to re-read the 3 changed files (**9.47×**).

Honest caveat on B for delta resume: a *machine-generated* ~25-token change list is cheaper in input tokens than faulting the changed symbols (299 vs 469), because it does not carry any code. That is not a viable workflow for an agent that must edit the code — it either has to read the diff anyway to write the list, or it reads stale prose. The moment follow-up questions arrive, it re-enters the paged path. The token ratio is therefore the right comparison for work that must actually be performed; a pure notification can be even cheaper.

## 5. Where paging is WORSE (honest limits)

1. **Many small queries lose to one file read.** Every tool call has fixed overhead. Measured crossover:

   - `atlas-fixture`: one query costs ~197 tokens (~152 content + 45 overhead). Reading `src/utils/clamp.js` fully costs 76 tokens, so a single query is already **1.63× the price of just reading that file**. It takes 7+ queries before you beat reading `src/services/billing.service.js` (1431 tokens) — and by then you may as well have read it.
   - `npm-cli`: one query costs ~183 tokens (~138 content + 45 overhead). Reading `lib/utils/is-windows.js` fully costs 46 tokens, so a single query is already **2.01× the price of just reading that file**. It takes 17+ queries before you beat reading `lib/commands/cache.js` (3069 tokens) — and by then you may as well have read it.
2. **One-shot tasks on one small file.** If a task needs most of one file, `card + get + fault` is more expensive than `read`. The worst measured task is `atlas-fixture/locate-cache` at 1.17×, `atlas-fixture/add-endpoint` at 1.37×, `atlas-fixture/review-auth-service` at 1.78×. The ratios range from 1.17× to 5.50×: the low end is small fixture tasks where the naive read is already cheap, the high end is single-purpose locate tasks in a large real corpus.
3. **Summary handoff is not a cheaper middle ground.** B must still read the files (A) *and* pay output tokens for the summary *and* pay a second read. For a single child it is strictly worse than A. At off-peak deepseek-flash prices one output token costs 200× a cache-hit input token (0.60 vs 0.003), and 4× a cache-miss input token (0.60 vs 0.15), so writing prose is the most expensive thing in the workflow: **B costs $0.018707 vs C\* $0.003966 — 4.7× more** for the same task set. It only amortises if the same summary is reused by several children, and even then the paged card+map is the cheaper shared prefix because it is content-addressed and byte-stable.
4. **Paging requires an index step.** `mem index` costs local time (atlas-fixture 598ms, npm-cli 711ms, memai 217ms, dsh-adapter 14ms) and SQLite disk, not model tokens. It is stale after edits until re-indexed, and `fault` re-reads the file from disk so a stale index can return stale line numbers.
5. **Cold start on a tiny repo is not the weak spot — small tasks are.** The dsh-adapter corpus is only 4,283 tokens in total and still pages well, because the win comes from avoiding per-file reads. What loses is a single-file, single-symbol question (see §6), and many tiny queries (item 1) — not small corpora per se.

## 6. Break-even: when does plain `read` beat card + paging?

Measured with a real tiny file from the fixture corpus (smallest useful JS file, first symbol):

| quantity | measured |
| --- | --- |
| file | `src/utils/env.js` (285 bytes, 72 tokens) |
| symbol faulted | `envOf` (52 tokens returned) |
| card tokens | 249 |
| A: read file in full + 1 tool call + answer | 197 input tokens |
| C: card + fault + 2 tool calls + answer | 471 input tokens |
| read wins? | **yes** |
| break-even file size | fileTokens < card + slice + toolOverhead ≈ **346 tokens (~1372 bytes / 1.3 KB)** |

**Rule for the tool description:** `mem` pays for itself once the session would otherwise read more than ~346 tokens of file bodies (card floor 249 tokens + one paged call ≈ 142 tokens). Below that — one small file, one symbol — plain `read` is cheaper. Corpus size is not the trigger; *per-task* file volume is. That is why every one of the 14 measured tasks clears the bar (the smallest needs 981 content tokens) while a hypothetical single-symbol question about a 300-token file does not.

Practical thresholds, from the measured data:

- **use `read`** if the task needs ≤1 file and the file is under ~1.2 KB (~300 tokens), or if you only need one line range.
- **use `mem card` + `fault`** if the file is over ~2 KB (~500 tokens), if the task touches ≥2 files, or if you will ask a second question in the same session (card amortises at ~249 tokens once).
- **use `mem diff`** whenever resuming after a version change: re-reading 3 changed files costs thousands of tokens, a diff costs ~100.

## 7. Reproduction

```bash
cd MemAi
node bench/bench.mjs            # writes bench/results.json + bench/RESULTS.md
node bench/selftest.mjs         # store/extract/diff/fault/merge round-trip
node tools/calibrate-session.mjs  # re-derive chars/token from local DSH sessions
```

Overrides: `BENCH_TOOL_OVERHEAD`, `BENCH_PRICE_IN`, `BENCH_PRICE_HIT`, `BENCH_PRICE_OUT`, `BENCH_ANSWER_TOKENS`, `BENCH_HANDOFF_TOKENS`.
