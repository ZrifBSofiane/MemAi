# Context-cost baseline — 0.7.0

Static measurement of the surfaces a model pays for before and during a MemAi
session. Estimator: `ceil(chars / 3.966)`. No model calls.

```text
# MemAi context cost — D:\Projects\MemAi
fixed: schema 996 · instructions 208 · init 518 · skill 222 · card 282 · total 2226
delivered (tokens) — json / text:
  B1-query  405 / 132
  B1-fault  673 / 595
  B2  228 / 125
  B3  445 / 192
  B5  689 / 218
  B6  126 / 66
turn model (10 turns): once 490 + 10 × per-request 1736 = 17850
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

The `B1-fault` row uses `startWatcher`, the correct answer to the B1 question,
not the best-effort symbol 0.7.0's `query --body` happened to pick. The lever
plans use this baseline to prove that a change does not grow any row.
