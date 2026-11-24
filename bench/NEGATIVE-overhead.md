# Negative result — fixed-overhead lever (A and B)

Date: 2026-11-23
Branch: `feat/token-overhead` (unmerged)
Baseline: 0.8.0 (`720e52c`)

## What was tried

**A — code surfaces:** compact the MCP schema (1,061 → 625) and MCP
instructions (208 → 67). Static fixed total 2,296 → 1,719 (−577, −25.1%).

**B — guidance surfaces:** compact the init block (518 → 168), skill
frontmatter (222 → 118), adapter samples and card (287 → 146). Combined with A,
static fixed total 2,296 → 1,124 (−1,172, −51.0%).

Both were measured with a live same-corpus A/B that loaded each arm's MCP
server, hooks and skill through a backup-guarded ZCode config swap.

## B failed first (A+B together)

| task | baseline | treatment | delta |
| --- | ---: | ---: | ---: |
| O1 watcher debounce | 205,529 | 436,508 | +112 % |
| O2 test command/entrypoints | 39,269 | 282,172 | +619 % |
| O3 importers of `src/store.mjs` | 119,324 | 194,665 | +63 % |
| **total** | **364,122** | **913,345** | **+151 %** |

All answers correct, no tool errors. The treatment stopped invoking the `memai`
skill (the compact frontmatter no longer triggered it) and substituted extra
queries, `get` calls and whole-file reads. B was reverted; full trace analysis in
`bench/NEGATIVE-overhead-B.md`.

## A alone also failed the live gate

| task | baseline | treatment | delta |
| --- | ---: | ---: | ---: |
| O1 watcher debounce | 452,396 | 279,371 | −38 % |
| O2 test command/entrypoints | 119,767 | 203,404 | +70 % |
| O3 importers of `src/store.mjs` | 201,889 | 361,043 | +79 % |
| **total** | **774,052** | **843,818** | **+9 %** |

All answers correct. The per-task gate fails; the total is worse.

## Why the live gate cannot resolve this lever

The expected fixed saving is ~577 tokens per request. The observed run-to-run
variance is far larger: baseline O1 was 205,529 in the B run and 452,396 in the A
run; treatment O1 was 436,508 and 279,371. Exploration paths differ by 100k–450k
billed tokens while the effect under test is 0.1–1.5 %. One sample per task is
underpowered by two orders of magnitude.

The two honest conclusions:

1. **B is dead.** Compact guidance changes agent behavior and costs turns; the
   same failure mode as the payload lever and the removed read guard.
2. **A is unproven, not disproven.** Its static win is real and deterministic,
   but a single-sample A/B cannot show it. Shipping it on the static bench alone
   would violate the "benchmark-gate, discard if not better" rule.

## Decision

Discard the fixed-overhead lever under the round's rule. No version bump; the
branch stays unmerged as the raw record. 0.8.0 (turns) remains the shipped token
win.

If this is revisited, the measurement must change first: either many samples per
task (3+ per arm) or a deterministic accounting of fixed tokens × requests, with
behavior checked separately for tool errors. Keep the full guidance surfaces;
only A (schema/instructions) is a viable candidate.

The config-swap harness (`tools/zcode-config.mjs`, `--swap-config`) is reusable
for that future test. Raw artifacts:
`bench/cost-ab-2026-11-23-overhead.json`, `bench/cost-ab-2026-11-23-overhead-a.json`.
