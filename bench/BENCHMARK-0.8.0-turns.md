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
  `rgNote: "auto-rg: …"`. In this repo, `query "unref"` returns the body line
  from `src/watch.mjs` in one call.
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

## Reproduce

```bash
npm test
node bench/cost.mjs
node bin/memai.mjs eval --fixtures bench/eval-fixtures.json --k 5
node bin/memai.mjs eval --fixtures bench/eval-fixtures-ext.json --k 5
```
