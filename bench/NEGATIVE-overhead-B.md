# Negative result — compact block/skill/card (B subset)

Date: 2026-11-23
Branch: `feat/token-overhead`
Baseline: 0.8.0 (`720e52c`)

The overhead lever was split into two sub-experiments:

- **A:** compact MCP schema + MCP instructions (code surfaces).
- **B:** compact init block + skill frontmatter + adapter samples + card.

The first live run tested **A and B together**. It failed badly.

## Live A/B (A+B together, 3 tasks × 2 arms, same corpus)

| task | baseline billed-in | treatment billed-in | delta |
| --- | ---: | ---: | ---: |
| O1 watcher debounce | 205,529 | 436,508 | **+112 %** |
| O2 test command/entrypoints | 39,269 | 282,172 | **+619 %** |
| O3 importers of `src/store.mjs` | 119,324 | 194,665 | **+63 %** |
| **total** | **364,122** | **913,345** | **+151 %** |

All six answers were correct and the MCP tool returned no errors. The cost came
from exploration, not failures:

- Baseline O1: `Skill(memai)` → 2 `mem` calls. Treatment O1: 3 `mem` calls + 2
  `Read` calls.
- Baseline O2 answered from the card with **zero tools**; the treatment used a
  query, three `Read`s and a Bash call.
- Baseline O3: 2 tools; treatment O3: 2 tools, but the treatment context was
  larger (extra query/affected output).

## Cause

The compact **skill frontmatter** stopped the agent from invoking the `memai`
skill (the baseline invoked it), and the shorter init block/card removed the
workflow guidance the skill would otherwise supply. The agent substituted extra
queries and whole-file reads. The fixed saving (~1,172 tokens) was outweighed by
one extra turn by a wide margin — the same failure mode as the payload lever and
the removed read guard.

## Decision

Revert the B surfaces (init block, skill frontmatter, adapter samples, card) to
0.8.0. Keep the A surfaces (schema + MCP instructions) and gate them alone: they
are per-request costs and do not remove the guidance that drives skill use.

Raw artifacts: `bench/cost-ab-2026-11-23-overhead.json` and `.md`.
