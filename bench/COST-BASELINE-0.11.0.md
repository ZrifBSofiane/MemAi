# Context-cost baseline — 0.11.0

Static measurement of the surfaces a model pays for before and during a MemAi
session. Estimator: `ceil(chars / 3.966)`. No model calls.

```text
# MemAi context cost — D:\Projects\MemAi
fixed: schema 1058 · instructions 208 · init 590 · skill 222 · card 287 · total 2365
delivered (tokens) — json / text:
  B1-query  405 / 132
  B1-fault  635 / 557
  B2  231 / 128
  B3  445 / 192
  B5  689 / 218
  B6  129 / 69
turn model (10 turns): once 495 + 10 × per-request 1870 = 19195
```

Reproduce:

```bash
node bench/cost.mjs
node bench/cost.mjs --check   # exit 1 if a surface or text payload grew
```

## What changed from 0.10.0

- **init 518 → 590.** The instruction block now documents the 0.9–0.11 workflow:
  complete fault slices labelled `(complete)`/`(truncated)`, `query --body --deep`
  for one-hop callers/callees, and `diff --faults` for resume plus slices.
- No compaction: the fixed-surface reduction was measured and discarded (see
  `NEGATIVE-overhead.md`); the schema declined slightly (1,061 → 1,058) from the
  composite-op descriptions.
- The 0.11.0 win is elsewhere: scenario benchmark **3.78×** fewer input tokens
  than naive reads, and the ranking raised shipped MRR to 0.80/0.74 with no
  recall loss (`BENCHMARK-0.11.0.md`).
