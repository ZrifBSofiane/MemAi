# Context-cost baseline — 0.9.0

Static measurement of the surfaces a model pays for before and during a MemAi
session. Estimator: `ceil(chars / 3.966)`. No model calls.

```text
# MemAi context cost — D:\Projects\MemAi
fixed: schema 1061 · instructions 208 · init 518 · skill 222 · card 287 · total 2296
delivered (tokens) — json / text:
  B1-query  405 / 132
  B1-fault  635 / 557
  B2  231 / 128
  B3  445 / 192
  B5  689 / 218
  B6  129 / 69
turn model (10 turns): once 495 + 10 × per-request 1801 = 18505
```

Reproduce:

```bash
node bench/cost.mjs
node bench/cost.mjs --check   # exit 1 if a surface or text payload grew
```

## What changed from 0.8.0

- **No fixed surface changed.** Schema, instructions, init block, skill
  frontmatter and card are byte-for-byte the same sizes.
- **Fault rows carry the completeness marker.** `B2` and `B6` grow by 3 tokens
  (`(complete)` / `(truncated: N more lines)`); `B1-fault` shrinks slightly
  because the longer header changes line-granular clamping. The 0.9.0 default
  fault budget is 1,200, but the canonical probe uses an explicit 600, so the
  lever's turn saving is measured live, not here.

The `B1-fault` row uses `startWatcher`, the correct answer to the B1 question.
