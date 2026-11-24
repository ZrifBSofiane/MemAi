# MemAi token benchmark — measured results

Generated 2026-11-24T00:42:20.153Z on Node v24.14.0 (win32). Every number below is measured by running the real `memai` code over the corpus on this machine; none are estimates of "typical" usage except the stated assumptions.

**Estimator.** tokens = ceil(chars / 3.966). The 3.966 chars/token constant is calibrated against *provider-reported* usage in this machine's DSH session logs: 6 sessions, 252 assistant turns, 37,092,363 prompt tokens (input + cache-read + cache-write) vs 147,103,482 chars of reconstructed visible context. chars/4 would under-count by ~0.9%. See `tools/calibrate-session.mjs`.

**Prices** (deepseek-flash, $/1M tokens, off-peak): cache-miss input **0.15**, cache-hit input **0.003**, output **0.60**. Peak hours (01:00–04:00 and 06:00–10:00 UTC, Mon–Fri) are 2×: 0.30 / 0.006 / 1.20; every cost below doubles at peak while all token ratios are price-independent. Assumptions: tool-call overhead 45 tokens per call, final answer 80 output tokens (charged in every scenario), handoff summary target 1,200 tokens. All inputs are priced cache-miss unless stated; the paged card is a byte-stable prefix and therefore cacheable — the "cacheable card" row prices the card portion at the hit rate. Note the asymmetry: one output token costs 200× a cache-hit input token (0.60 / 0.003), so anything that makes the model *write* is expensive.

## 1. Corpora

| corpus | files | bytes | tokens if read fully | card tokens | map tokens | index ms |
| --- | --- | --- | --- | --- | --- | --- |
| atlas-fixture | 199 | 289488 | 73043 | 248 | 3499 | 482 |
| npm-cli | 288 | 2107230 | 531439 | 200 | 2334 | 664 |
| memai | 118 | 966111 | 242670 | 272 | 1464 | 281 |
| dsh-adapter | 7 | 17077 | 4283 | 227 | 70 | 16 |

`full_tokens` is the measured token count of every indexed file concatenated — i.e. the cost of "read the whole repo". `card` and `map` are the actual pages an agent loads instead. Indexing is local CPU/disk: **0 model tokens**.
Map was hard-capped at the 3500-token budget for `atlas-fixture`; omitted files remain reachable via `query`/`fault`, which is the intended budget behaviour rather than an error.

## 2. Per-task results (input tokens; lower is better)

| task | type | A naive | B handoff | C paged (plan) | C* paged (complete) | A/C* | recall | C* cost | A cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| atlas-fixture / locate-auth | locate | 2848 | 3929 | 1083 | 1490 | 1.91× | 100% | $0.000271 | $0.000475 |
| atlas-fixture / understand-billing | understand | 2532 | 3495 | 986 | 1368 | 1.85× | 100% | $0.000253 | $0.000428 |
| atlas-fixture / add-endpoint | change | 2816 | 4033 | 1385 | 2096 | 1.34× | 100% | $0.000362 | $0.000470 |
| atlas-fixture / refactor-invoice | refactor | 2532 | 3495 | 930 | 1250 | 2.03× | 100% | $0.000236 | $0.000428 |
| atlas-fixture / locate-cache | locate | 1286 | 2075 | 721 | 1172 | 1.10× | 100% | $0.000224 | $0.000241 |
| atlas-fixture / review-auth-service | review | 2348 | 3262 | 1099 | 1338 | 1.75× | 100% | $0.000249 | $0.000400 |
| npm-cli / understand-workspaces | understand | 2777 | 3559 | 750 | 1105 | 2.51× | 100% | $0.000214 | $0.000465 |
| npm-cli / locate-auth | locate | 5828 | 6615 | 988 | 1179 | 4.94× | 100% | $0.000225 | $0.000922 |
| npm-cli / review-cache | review | 5820 | 6649 | 1364 | 1757 | 3.31× | 100% | $0.000312 | $0.000921 |
| memai / understand-page-model | understand | 22171 | 23169 | 2286 | 3695 | 6.00× | 100% | $0.000602 | $0.003374 |
| memai / locate-extractor | locate | 15648 | 16472 | 1780 | 2972 | 5.27× | 100% | $0.000494 | $0.002395 |
| memai / review-cli | review | 18952 | 19813 | 931 | 1891 | 10.02× | 100% | $0.000332 | $0.002891 |
| dsh-adapter / understand-dsh-adapter | understand | 3346 | 4064 | 1624 | 1895 | 1.77× | 100% | $0.000332 | $0.000550 |
| dsh-adapter / locate-tool-surface | locate | 2561 | 3219 | 797 | 1008 | 2.54× | 100% | $0.000199 | $0.000432 |

**C** is the curated demand-paging plan (query/fault/get) — the cheap path. **C\*** additionally pages every expected file the plan did not touch, so its recall is 100% by construction and the token comparison against A is apples-to-apples. The headline ratio uses C\*.

## 3. Aggregate

| scenario | input tokens | output tokens | cost off-peak | cost at peak (2×) |
| --- | --- | --- | --- | --- |
| A naive reads | 91465 | 1120 | $0.014392 | $0.028784 |
| B summary handoff | 103849 | 12244 | $0.022924 | $0.045847 |
| C paged (plan only) | 16724 | 1120 | $0.003181 | $0.006361 |
| C* paged (complete) | 24216 | 1120 | $0.004304 | $0.008609 |
| C* with cacheable card | 24216 | 1120 | $0.003779 | $0.007558 |

**Measured saving: 3.78× fewer input tokens than naive reads (67,249 tokens saved across 14 tasks), and 4.29× fewer than the summary-handoff workflow.** At off-peak list prices that is $0.014392 → $0.004304 for the same 14 tasks; the cheap-plan number is 5.47×. Because output is 200× the cache-hit price, B is the most expensive scenario in dollars even though its input-token count only looks mildly worse: B costs $0.022924 vs C* $0.004304 (**5.3× more**).

### By corpus

| corpus | tasks | A naive | C* paged | A/C* | page/read content | recall | A cost | C* cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| atlas-api fixture (generated, 200 files) | 6 | 14362 | 8714 | 1.65× | 51% | 100% | $0.002442 | $0.001595 |
| npm CLI (real, shipped with Node) | 3 | 14425 | 4041 | 3.57× | 22% | 100% | $0.002308 | $0.000750 |
| MemAi itself (real, self-host) | 3 | 56771 | 8558 | 6.63× | 13% | 100% | $0.008660 | $0.001428 |
| DeepSeek Harness adapter (real, bundled in this repo) | 2 | 5907 | 2903 | 2.03× | 41% | 100% | $0.000982 | $0.000531 |

### One session, six tasks (fixture)

Loading the card once and paging for six tasks costs **7,174** input tokens vs **14,362** for reading the needed files — **2.00×** less. card loaded once per session; each task then pays only its query/fault calls.

## 4. Delta resume (new session after 3 files change)

| corpus | changed files | A re-read changed files | B delta summary handoff | D diff + faults | A/D |
| --- | --- | --- | --- | --- | --- |
| atlas-fixture | 3 | 2607 | 299 | 477 | 5.47× |
| npm-cli | 3 | 4127 | 296 | 444 | 9.30× |

- `atlas-fixture`: diff text is **104** tokens for 199 indexed files; re-index took 238 ms (local, 0 model tokens). Paged resume (diff + 2 faults) costs 477 input tokens vs 2607 to re-read the 3 changed files (**5.47×**).
- `npm-cli`: diff text is **102** tokens for 111 indexed files; re-index took 140 ms (local, 0 model tokens). Paged resume (diff + 2 faults) costs 444 input tokens vs 4127 to re-read the 3 changed files (**9.30×**).

Honest caveat on B for delta resume: a *machine-generated* ~25-token change list is cheaper in input tokens than faulting the changed symbols (299 vs 469), because it does not carry any code. That is not a viable workflow for an agent that must edit the code — it either has to read the diff anyway to write the list, or it reads stale prose. The moment follow-up questions arrive, it re-enters the paged path. The token ratio is therefore the right comparison for work that must actually be performed; a pure notification can be even cheaper.

## 5. Where paging is WORSE (honest limits)

1. **Many small queries lose to one file read.** Every tool call has fixed overhead. Measured crossover:

   - `atlas-fixture`: one query costs ~186 tokens (~141 content + 45 overhead). Reading `src/utils/clamp.js` fully costs 76 tokens, so a single query is already **1.54× the price of just reading that file**. It takes 7+ queries before you beat reading `src/services/billing.service.js` (1431 tokens) — and by then you may as well have read it.
   - `npm-cli`: one query costs ~181 tokens (~136 content + 45 overhead). Reading `lib/utils/is-windows.js` fully costs 46 tokens, so a single query is already **1.99× the price of just reading that file**. It takes 17+ queries before you beat reading `lib/commands/cache.js` (3069 tokens) — and by then you may as well have read it.
2. **One-shot tasks on one small file.** If a task needs most of one file, `card + get + fault` is more expensive than `read`. The worst measured task is `atlas-fixture/locate-cache` at 1.10×, `atlas-fixture/add-endpoint` at 1.34×, `atlas-fixture/review-auth-service` at 1.75×. The ratios range from 1.10× to 10.02×: the low end is small fixture tasks where the naive read is already cheap, the high end is single-purpose locate tasks in a large real corpus.
3. **Summary handoff is not a cheaper middle ground.** B must still read the files (A) *and* pay output tokens for the summary *and* pay a second read. For a single child it is strictly worse than A. At off-peak deepseek-flash prices one output token costs 200× a cache-hit input token (0.60 vs 0.003), and 4× a cache-miss input token (0.60 vs 0.15), so writing prose is the most expensive thing in the workflow: **B costs $0.022924 vs C\* $0.004304 — 5.3× more** for the same task set. It only amortises if the same summary is reused by several children, and even then the paged card+map is the cheaper shared prefix because it is content-addressed and byte-stable.
4. **Paging requires an index step.** `mem index` costs local time (atlas-fixture 482ms, npm-cli 664ms, memai 281ms, dsh-adapter 16ms) and SQLite disk, not model tokens. It is stale after edits until re-indexed, and `fault` re-reads the file from disk so a stale index can return stale line numbers.
5. **Cold start on a tiny repo is not the weak spot — small tasks are.** The dsh-adapter corpus is only 4,283 tokens in total and still pages well, because the win comes from avoiding per-file reads. What loses is a single-file, single-symbol question (see §6), and many tiny queries (item 1) — not small corpora per se.

## 6. Break-even: when does plain `read` beat card + paging?

Measured with a real tiny file from the fixture corpus (smallest useful JS file, first symbol):

| quantity | measured |
| --- | --- |
| file | `src/utils/env.js` (285 bytes, 72 tokens) |
| symbol faulted | `envOf` (55 tokens returned) |
| card tokens | 263 |
| A: read file in full + 1 tool call + answer | 197 input tokens |
| C: card + fault + 2 tool calls + answer | 488 input tokens |
| read wins? | **yes** |
| break-even file size | fileTokens < card + slice + toolOverhead ≈ **363 tokens (~1440 bytes / 1.4 KB)** |

**Rule for the tool description:** `mem` pays for itself once the session would otherwise read more than ~363 tokens of file bodies (card floor 263 tokens + one paged call ≈ 145 tokens). Below that — one small file, one symbol — plain `read` is cheaper. Corpus size is not the trigger; *per-task* file volume is. That is why every one of the 14 measured tasks clears the bar (the smallest needs 981 content tokens) while a hypothetical single-symbol question about a 300-token file does not.

Practical thresholds, from the measured data:

- **use `read`** if the task needs ≤1 file and the file is under ~1.2 KB (~300 tokens), or if you only need one line range.
- **use `mem card` + `fault`** if the file is over ~2 KB (~500 tokens), if the task touches ≥2 files, or if you will ask a second question in the same session (card amortises at ~263 tokens once).
- **use `mem diff`** whenever resuming after a version change: re-reading 3 changed files costs thousands of tokens, a diff costs ~100.

## 7. Reproduction

```bash
cd MemAi
node bench/bench.mjs            # writes bench/results.json + bench/RESULTS.md
node bench/selftest.mjs         # store/extract/diff/fault/merge round-trip
node tools/calibrate-session.mjs  # re-derive chars/token from local DSH sessions
```

Overrides: `BENCH_TOOL_OVERHEAD`, `BENCH_PRICE_IN`, `BENCH_PRICE_HIT`, `BENCH_PRICE_OUT`, `BENCH_ANSWER_TOKENS`, `BENCH_HANDOFF_TOKENS`.
