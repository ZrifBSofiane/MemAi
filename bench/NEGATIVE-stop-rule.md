# Negative result — stop-rule line

Date: 2026-11-24
Branch: `feat/stop-rule` (unmerged)
Baseline: 0.11.0 (`67f4099`)

## What was tried

Complete fault slices ended with:

```
# complete — answer from this slice; do not read the file
```

A contextual stop rule, not a prompt compaction: it costs ~13 tokens only when a
slice is complete and directly follows the body the model is reading.

## Live A/B (2 tasks × 2 arms, same corpus, local CLI)

| task | baseline | treatment | delta | CLI calls |
| --- | ---: | ---: | ---: | --- |
| S1 watcher debounce | 363,778 | 375,229 | +3.1 % | 4 → 3 |
| S2 index reuse | 372,676 | 553,041 | **+48.4 %** | 4 → 5 |
| **total** | **736,454** | **928,270** | **+26.0 %** | **8 → 8** |

All answers correct.

S1 used one fewer call but still cost 3.1 % more; S2 took one more call and
nearly 50 % more billed input. The line did not reduce exploration — the model
kept querying/reading — and its tokens are pure overhead in the cases where no
read was avoided. This is the same failure mode as the payload and block/skill
compaction experiments: advisory guidance does not reliably change the turn
path.

## Decision

Discard. No version bump; the branch stays unmerged as the raw record. 0.11.0
(ranking) remains the last shipped lever; 0.9.0/0.10.0 are the turn levers.

Raw artifacts: `bench/cost-ab-2026-11-23-stoprule.json` and `.md`.
