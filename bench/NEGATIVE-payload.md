# Negative result — payload lever (`--text` + compact renderers)

Date: 2026-11-22
Branch: `feat/token-payload` (stacked on `feat/token-harness`)
Baseline: 0.7.0 (`adfbaea`)

## What was tried

1. Document `--text` as the agent CLI path in the init block, skill, four adapter
   samples and README (the default JSON envelope repeats the rendered text and is
   2–3× larger).
2. Compact `query` page-hit previews (drop duplicate path, bytes, sha1) and `get`
   signature lines (drop column padding and repeated kind).
3. Bump `EXTRACTOR_VERSION` to `x2` so existing stores re-extract the new page
   text.

## Static result — the renderer trims are real but small

| row | 0.7.0 text | branch text | delta |
| --- | ---: | ---: | ---: |
| B1-query | 132 | 121 | −11 |
| B1-fault | 595 | 595 | 0 |
| B2 | 125 | 125 | 0 |
| B3 | 192 | 192 | 0 |
| B5 | 218 | 215 | −3 |
| B6 | 66 | 66 | 0 |
| G1 (`get`) | 824 | 765 | −59 |
| total | 2,152 | 2,079 | **−73** |

`init` grew 518 → 552 (+34) for the `--text` line. Same-tree eval (old renderer
vs compact renderer, identical corpus) was identical: shipped 100 % recall /
MRR 0.74 index, 0.67 hybrid; extended 85 % / 90 %. The historical MRR drop was
corpus drift from the new plan/spec docs, not the renderer.

## Live CLI A/B — every task worse

3 tasks × 2 arms, ZCode headless, billed input (`input + cache-read + cache-write`)
from the app DB. Tasks forced the locally checked-out CLI (`node bin/memai.mjs`).

| task | baseline | treatment | delta |
| --- | ---: | ---: | ---: |
| P1 (watcher debounce) | 453,100 | 537,086 | **+18.5 %** |
| P2 (symbolSearch rank) | 284,290 | 364,214 | **+28.1 %** |
| P3 (pack op) | 118,416 | 119,768 | **+1.1 %** |
| **total** | **855,806** | **1,021,068** | **+19.3 %** |

All answers were correct. Treatment used `--text` on P1/P2 (6/6 and 3/3 calls)
but not P3, which was answered from `node bin/memai.mjs --help` — help is already
plain text, so `--text` does not apply.

## Why it lost

- **More exploration, not smaller output.** P1 treatment made 6 CLI calls
  (query, get, four faults) against the baseline's 4 (query, get, three faults,
  then a `grep` fallback). The smaller text output did not stop the extra faults.
- **Corpus mismatch.** The baseline worktree is the 0.7.0 tree (90 files); the
  treatment is the 104-file tree with the new plans/specs/tests. Queries can
  surface the extra docs and change the exploration path.
- **Cache invalidation.** Changing the instruction block and skill changes the
  system prompt, so the treatment's first session pays cache-write tokens. The
  metric counts cache writes as billed input.
- **Single sample per task.** The guard analysis measured 201K–652K billed-input
  variance across identical-prompt runs; a +19 % difference on one sample is not
  separable from path variance.
- **P3 was not a paged task.** It was answered by `--help` in both arms, so its
  `--text` compliance failure is a task-design artifact, not a behavior result.

## Decision

**Discard the payload lever.** Do not ship the `--text` documentation campaign
or the renderer trims. The `--text` flag itself remains available from 0.7.0;
only the instruction change and the renderer compaction are discarded. The
branch is kept as the raw record; it is not merged.

Reasoning: the live gate failed on every task, and the static win (−73 tokens
across all seven probe calls) is too small to justify a release without the
`--text` behavior change. The instruction campaign is the same class of
intervention as the removed read guard: it changes agent behavior in a direction
that costs more billed input than it saves.

The harness (step 0) stays. Its cost bench, session report and A/B runner are
what made this negative result measurable; they are reused by the turns and
overhead levers.

Raw artifacts: `bench/cost-ab-2026-11-22-payload.json` and `.md`.
