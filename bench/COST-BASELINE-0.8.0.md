# Context-cost baseline — 0.8.0

Static measurement of the surfaces a model pays for before and during a MemAi
session. Estimator: `ceil(chars / 3.966)`. No model calls.

```text
# MemAi context cost — D:\Projects\MemAi
fixed: schema 1061 · instructions 208 · init 518 · skill 222 · card 287 · total 2296
delivered (tokens) — json / text:
  B1-query  405 / 132
  B1-fault  673 / 595
  B2  228 / 125
  B3  445 / 192
  B5  689 / 218
  B6  126 / 66
turn model (10 turns): once 495 + 10 × per-request 1801 = 18505
```

Reproduce:

```bash
node bench/cost.mjs
node bench/cost.mjs --check   # exit 1 if a surface or text payload grew
```

Interpretation:

- `schema`, `init`, `skill` are re-sent per request in the hosts that inject
  them; `instructions` and `card` are once per session.
- `json / text` is the same call rendered by the CLI. The text column is what a
  model should ingest; JSON is transport and may be larger.
- This is a static model, not a billed-token measurement. Billed input comes
  from `tools/cost-ab.mjs` in the lever plans.

## What changed from 0.7.0

- **schema 996 → 1,061 (+65).** The flat MCP schema now declares `body` boolean
  (query), `content` string (note/post) and `sinceSeq` integer (inbox) as four
  distinct properties instead of two colliding ones. This is the cost of making
  `query --body` discoverable; the live A/B measures the turn saving it buys.
- **card 282 → 287 (+5).** The card ends with `version: <8 hex>`, which lets a
  resume call `diff --since` without a `status` call. The resume A/B used 8 fewer
  local CLI calls in the treatment arm.

The `B1-fault` row uses `startWatcher`, the correct answer to the B1 question,
not the best-effort symbol 0.7.0's `query --body` happened to pick.
