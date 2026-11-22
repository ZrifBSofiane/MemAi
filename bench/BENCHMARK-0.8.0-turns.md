# 0.8.0 turns benchmark

Baseline: 0.7.0 (`adfbaea`) with the harness and the same corpus. The payload
lever was discarded (`bench/NEGATIVE-payload.md`), so this is the first candidate
release of the round.

## Unit results

- **MCP schema repaired.** `query` keeps `body: boolean`; `note`/`post` use
  `content: string`; `inbox` uses `sinceSeq: integer`. Dispatch accepts the new
  names and the legacy aliases. `query --body` is discoverable through the MCP
  schema again.
- **Source-aware `--body`.** `query --body "how does the watcher debounce work"`
  selects `startWatcher` (was `workspace`, a README heading); the existing
  `verifyToken` and callable-over-const tests still pass.
- **Card version.** The card ends with `version: <8 hex>` and `diff --since`
  accepts it (prefix resolution added to `store.getVersion`; the CLI already
  printed 12-char prefixes that did not resolve).
- **Auto-rg.** A zero-hit `query` runs the ripgrep pass and returns
  `rgNote: "auto-rg: …"`. A body-only token in `src/watch.mjs` is returned in
  one call without an explicit `rg` flag.
- **Eval.** Shipped recall@5 100 %; extended 85 % index / 90 % hybrid. Recall is
  unchanged from the harness tree; the MRR values (0.74 / 0.67 and 0.58 / 0.54)
  are the same-tree numbers after the plan/spec docs entered the corpus.

## Cost

| surface | 0.7.0 | branch | delta |
| --- | ---: | ---: | ---: |
| MCP schema | 996 | 1,061 | +65 |
| card | 282 | 287 | +5 |
| total fixed | 2,226 | 2,296 | +70 |

The schema growth buys the collision repair (`body` boolean + `content` string +
`sinceSeq` integer are now four distinct properties instead of two colliding
ones). The card growth buys the version line. Both are per-request/session costs;
the lever's payoff is one fewer CLI call per question, which removes a whole
turn's re-sent context — the dominant cost. The live A/B is the arbiter.

## Live CLI A/B (3 tasks × 2 arms, same corpus)

Same corpus in both arms; the baseline is `adfbaea` (0.7.0) with the current
docs/bench/tests/tools copied in, the treatment is `feat/token-turns`. The plan
and spec docs were removed from both arms so a body-only query token does not hit
the plan page.

| task | arm | billed-in | local CLI calls | correct |
| --- | --- | ---: | ---: | --- |
| T1 (body selection) | baseline | 118,918 | 1 | no |
| T1 (body selection) | treatment | 119,029 | 1 | yes |
| T2 (resume) | baseline | 1,062,399 | 10 | yes |
| T2 (resume) | treatment | 198,205 | 2 | yes |
| T3 (auto-rg) | baseline | 118,839 | 1 | no |
| T3 (auto-rg) | treatment | 118,131 | 1 | yes |
| **total** | **baseline** | **1,300,156** | **12** | |
| **total** | **treatment** | **435,365** | **4** | |

Verdict: **PASS**.

- T2 is the call-count probe: **8 fewer local CLI calls (−80 %)** and **81.3 %
  less billed input**. The baseline's own answer diagnosed the truncated-hash
  bug this branch fixes; the treatment completed the same resume in two calls.
- T1 and T3 force one call in both arms, so they are correctness probes: the
  baseline picked `workspace` (T1) and returned no file (T3); the treatment
  answered correctly. T1 costs +0.09 % (111 tokens), inside the 1 % tolerance;
  T3 costs −0.6 %.
- Combined billed input is **−66.5 %** with two of three tasks fixing an
  incorrect answer.

## Reproduce

```bash
npm test
node bench/cost.mjs
node bin/memai.mjs eval --fixtures bench/eval-fixtures.json --k 5
node bin/memai.mjs eval --fixtures bench/eval-fixtures-ext.json --k 5
```
