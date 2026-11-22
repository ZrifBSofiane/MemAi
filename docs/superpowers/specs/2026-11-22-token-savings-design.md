# Token-savings round (after 0.7.0) — design

Date: 2026-11-22
Status: approved in conversation; implementation not started
Baseline: `main` at `adfbaea` (0.7.0, PR #12 merged)

## Goal

Reduce the tokens a model actually pays when it uses MemAi, without degrading
retrieval quality, agent behaviour, or any published GitHub-visible number.

Three levers, each with its own benchmark and its own discard decision:

1. **Payload** — what a single call returns.
2. **Turns** — how many calls a question needs.
3. **Overhead** — what MemAi adds before any call.

A lever ships only if its gate shows every task at or below the 0.7.0 baseline
and the total strictly lower. A failing lever is reverted and recorded as a
negative result in `bench/`, following the guard precedent (0.6.0).

## What is actually being paid

Measured on this tree (0.7.0). Estimator: `ceil(chars / 3.966)`, the repo's own.

### Fixed overhead (before the first tool call)

| Surface | Tokens | Cadence |
| --- | ---: | --- |
| MCP `mem` tool schema | 996 | every model request |
| init `AGENTS.md` / `CLAUDE.md` block | 518 | every session (system prompt) |
| SessionStart card (delivered) | 282 | once per session |
| skill frontmatter (`skills/memai/SKILL.md`) | 222 | skill catalog |
| MCP `instructions` | 208 | session init |
| **Total** | **2,226** | |

The schema (996) and instruction block (518) are re-sent per request; with the
skill catalogue entry (222) where the host injects it, the per-request part is
~1,700 tokens. That is comparable to the 1,438 tokens the six-question benchmark
counts for all six answers, so for short sessions overhead dominates.

### Delivered payload vs reported payload

`memai ... --text` is the shape the model should ingest. The default JSON
envelope carries the structured fields **and** the same rendered `text`, so the
CLI path is 2–3× the reported size:

| Call | Reported `tokens` | CLI JSON (actual) | `--text` |
| --- | ---: | ---: | ---: |
| `query "watch debounce"` | 129 | 426 | 132 |
| `fault watcherAlive` | 58 | 121 | 62 |

`src/mem-cli.mjs:230` documents the intent: `text` is what a wrapper should
forward; the JSON envelope is transport. The instruction surfaces never tell
CLI users to pass `--text`, so subagents following `AGENTS.md` pay the envelope.

### Turns

0.7.0 cut one turn where it could, but two defects block the rest:

1. **MCP cannot express `query --body`.** The flat schema declares `body` twice:
   a boolean for `query` (`mcp/tools.mjs:80`) and a string for `note`/`post`
   (`mcp/tools.mjs:95`). The later property wins, so the shipped schema types
   `body` as `string`. `dispatch` checks `!!args.body`, so a string accidentally
   triggers the feature, but a model following the schema cannot discover the
   flag. `since` has the same collision: string for `diff`
   (`mcp/tools.mjs:93`), integer for `inbox` in dispatch.
2. **`query --body` picks the wrong body.** Selection is "first callable in the
   global symbol list" (`src/page.mjs:591-592`), with no source-page or
   body-content scoring:
   - `"watch debounce"` → `watcherAlive`, not `startWatcher` (the function that
     implements debouncing via `flushDelayMs`).
   - `"how does the watcher debounce work"` → `workspace`, a README heading
     function, because headings outrank code symbols in the pool.

A third, smaller gap: `diff --since` needs a version, and the card does not
carry one, so a resuming agent spends a `status` call to get it.

## Non-goals

- No ranking changes. The extended eval MRR is 0.54–0.59 and several fixtures
  depend on rank 5, but ranking is a separate round; this round measures token
  cost at constant retrieval quality.
- No adaptive `k`. A 25 % score cutoff was measured and loses 1/12 shipped and
  7/40 extended fixtures. Rank 5 is load-bearing until ranking improves.
- No read guard, no per-call interception. 0.6.0 settled that.
- No new MCP tools or ops. The surface stays 15 ops; only arg names and
  descriptions may change.
- No changes to the six-question public benchmark totals beyond additive,
  clearly-labelled new measurements.

## Architecture of the work

Three branches, each independently mergeable and independently discardable:

| Branch | Lever | Gate type |
| --- | --- | --- |
| `feat/token-payload` | Payload | static + 3-task live compliance |
| `feat/token-turns` | Turns + schema repair | 4-task live A/B |
| `feat/token-overhead` | Fixed overhead | two 6-task live A/Bs |

Shared step 0 is measurement tooling and ships on its own (no runtime change).

## Step 0 — measurement harness

### `tools/zcode-session-report.mjs`

Restore from `959654f^` (removed with the guard, still in git history). It reads
the ZCode app DB and reports billed input (`input + cache-read + cache-write`),
turn count, tool mix, tool errors, and denies. No changes to its semantics.

### `bench/cost.mjs` (new, deterministic, no model calls)

Reports three layers for a fixed task script:

1. **fixed** — MCP schema, MCP instructions, init block (via
   `instructionBlock()`), skill frontmatter, card (via the live store). Output
   JSON and token counts per surface and total.
2. **delivered** — per task, the model-visible payload for the default JSON and
   for `--text`; asserts `--text` ≤ JSON.
3. **turn model** — given a turn count `T`, total =
   `fixed_once + T × per_request_fixed + Σ delivered × remaining_turns`. This
   is a model, not a measurement; it exists to rank levers, not to claim wins.

`bench/cost.mjs` is CI-safe and must exit non-zero if a surface grows relative
to a checked-in baseline file (`bench/cost-baseline.json`).

### `tools/cost-ab.mjs` (new, live)

Paired headless runs in ZCode, same model in both arms (`deepseek-flash`,
provider `deepseek`), same prompts. Both arms run from separate worktrees of the
same corpus; the only difference is the branch or toggle under test. Reports per
task: billed input, turns, tool calls by name, tool-error rate (`isError` calls /
total tool calls), and correctness. Correctness is scored against a per-task
expectation (expected symbol, path, or a one-line answer rubric checked by the
runner). The runner refuses to compare runs where the treatment checkout differs
from the branch under test.

Live cost: ~26 sessions total across all three levers. If that is too much, cut
the optional `--deep` experiment first, then reduce L1 to 4 tasks. No lever is
declared shipped without at least one live run unless it is purely renderer
output (payload's static part).

## Lever 1 — payload (`feat/token-payload`)

### Changes

1. **Document `--text` as the agent path.** Update the init block
   (`src/init.mjs`), `skills/memai/SKILL.md`, every `adapters/*/AGENTS.md`
   sample, and the README examples. One explicit line: CLI calls that a model
   will read must pass `--text`; JSON is for parsers.
2. **Trim query previews.** File-page hits currently repeat the path and carry
   `js 285L 13.6KB sha1:…` (`src/page.mjs`, query renderer). Drop sha1 and byte
   size; render the path once. Keep the imports line when it is the only useful
   snippet; otherwise show a short signature or nothing.
3. **Compact `get` / `map` symbol lines.** Remove the column padding and the
   repeated `export const` / `export function` prefix where the kind column
   already says it (`src/page.mjs`, `get` and `renderProjectMap`).
4. **`fault` header:** keep the file-page hint but drop the duplicated token
   counter inside the text header when the envelope already carries `tokens`.

### Gate

- Static: the six tasks from `bench/BENCHMARK-0.5.0.md` (B1–B6), delivered
  tokens lower than 0.7.0 on **every** task; `--text` ≤ default JSON on every
  task; total lower.
- Retrieval: `memai eval` on both fixture sets unchanged (100 % / 85 % index,
  100 % / 93 % hybrid at k=5).
- Live: 3 tasks in two arms — instruction block says `--text` vs says nothing.
  Pass only if the treatment arm's billed input is lower on every task. If
  compliance is poor (agents keep using JSON), do **not** ship docs-only;
  escalate to a separate experiment: `--text` default when stdout is piped,
  with `--json` opt-out, gated on script compatibility. That escalation is a
  new decision, not part of this branch.

### Discard

If any static task is worse, or eval recall drops, revert. Renderer-only changes
cannot affect retrieval, but the benchmark still has to show the payload win.

## Lever 2 — turns (`feat/token-turns`)

### Changes

1. **Schema repair** (`mcp/tools.mjs`):
   - `query` keeps `body: boolean`.
   - `note` / `post` use `content: string`; dispatch accepts
     `content ?? (typeof body === 'string' ? body : '')` for compatibility.
   - `inbox` uses `sinceSeq: integer`; dispatch accepts `sinceSeq` or a numeric
     `since`.
   - Update the op descriptions and `memai help` examples to match.
   - The granular tool schemas (`mcp/tools.mjs:115-199`) are per-tool and
     conflict-free; leave them unchanged to avoid churn.
   - Add `test/surface.test.mjs`: `body` is boolean, `sinceSeq` is integer, every
     op in `OPS` appears in the schema enum and in the init block, and no
     property is declared twice with conflicting types. This closes the drift
     class the user has audited before.
2. **Source-aware `query --body`** (`src/page.mjs`):
   - Candidate pool = callables on the top-ranked `file:` pages, excluding docs
     and test pages when a source page exists.
   - Score = name/signature term overlap + body term coverage (read locally from
     the page store; 0 model tokens) + rank bonus.
   - Fall back to the current global pool only when no source callable exists.
   - Keep the returned shape (`body: {ok, target, symbol, path, tokens, text}`)
     so wrappers do not change.
3. **Card carries a version.** Append `version: <8>` at resolve time from
   `store.latestVersion()` rather than baking it into the stored page (the index
   version is computed from the card text, so embedding it at index time is
   circular). A resuming agent can then call `diff --since <version>` without a
   `status` call. Label it `version` (current indexed state), not "last session".
4. **Auto-rg on zero index hits.** When `symbolSearch` and `searchPages` both
   return nothing and `rg` was not requested, run the existing `_rgSearch`
   automatically and say so in the output. One call instead of two.
5. **Optional, discardable: `query --body --deep`.** Add `deep` to the query op
   so the returned body includes one-hop callers/callees via the existing fault
   path. Only keep it if a "who calls X" task goes from two calls to one with
   lower total tokens and a correct answer.

### Gate

- Fixture: 12–15 "how does X work" queries with an expected symbol. Pass at
  ≥80 % correct selection. B1 must select `startWatcher`.
- Live: 4 target tasks (B1-style, B2-style callers, B3-style reverse deps,
  resume). Each target must use one fewer call **and** lower total tokens, with
  the same answer. Any task worse → discard that sub-change; keep the rest.
- Schema test passes; a MCP client can call `{op:"query", q:"…", body:true}`
  and receive `body.ok === true`.
- Card version: a new session's `card` output contains an 8-char version that
  `diff --since` accepts and resolves. If it does not save a call in the resume
  task, discard sub-change 3.

### Discard

The branch may ship partially: schema repair and auto-rg are independent of body
selection. If body selection cannot reach the fixture bar, ship the repair and
auto-rg and record the selection negative result. If neither shows a turn or
token win, discard the branch.

## Lever 3 — fixed overhead (`feat/token-overhead`)

### Changes (all in one branch, two sub-experiments)

| Surface | Now | Target | Change |
| --- | ---: | ---: | --- |
| MCP `mem` schema | 996 | ~590 | terse per-arg descriptions; drop min/max where the server clamps; shorten the tool description |
| MCP `instructions` | 208 | ~80 | keep the paging protocol only |
| init block | 518 | ~150 | keep store location, MCP name, card-once, query/fault/get/diff one-liner, rules; move arg syntax to the schema/help |
| skill frontmatter | 222 | ~80 | trigger keywords only; body unchanged |
| card | 282 | ~120 | drop the marketing `description`, conventions, sha1/bytes; one-line layout; 4-line protocol |
| **Total** | **2,226** | **~1,020** | −54 % |

All four instruction surfaces (skill, init template, adapter `AGENTS.md`, MCP
schema) change together. The surface test from Lever 2 must still pass, and its
op-coverage assertions are extended to the compacted block.

### Gate (two independent live A/Bs)

- **A: per-request** — schema + instructions, six benchmark tasks, two arms.
  Every task's billed input ≤ baseline; total lower; tool-error rate not higher;
  answers correct.
- **B: per-session** — block + skill + card, six benchmark tasks, two arms.
  Same criteria.
- A regression discards only that subset. If A regresses and B wins, ship B.

### Discard

If neither subset wins, revert the branch. If A wins only by making agents call
MemAi less often (fewer, larger faults), treat that as a warning: correctness
and tool-error rate decide, not the token number alone.

## Measurement rules

- Same estimator on both sides (`ceil(chars / 3.966)`), same corpus, same store
  settings, no concurrent indexing during a run.
- Static comparison is same-tree: baseline and treatment checkouts on identical
  input.
- Live comparison is same model, same harness, same prompt text; the only
  difference is the branch/toggle under test. Any run with an empty session or a
  tool crash is excluded and re-run once, then reported as excluded.
- Report per task, not just totals. A total win with one task worse is a fail.
- Negative results are published as `bench/NEGATIVE-<lever>.md` with the raw
  JSON artifacts, as with the guard analysis.

## Release

- One changelog entry per shipped branch, under the next minor version at merge
  time (`0.8.0`, then `0.9.0`, then `0.10.0` if all ship). Do not pre-allocate
  version numbers that a discard would leave unused.
- Each branch adds `bench/BENCHMARK-<version>-<lever>.md`; existing benchmark
  docs are not edited.
- Version strings live in the package manifest, changelog, and skill/adapter
  surfaces; the surface test asserts they agree.
- The user merges PRs; no direct pushes to `main`.

## Risks

1. **Schema compression degrades tool choice.** Mitigated by the per-request
   live A/B and tool-error rate; the schema is the only surface whose wording
   directly teaches the model what to call.
2. **Init-block compression reduces MemAi usage**, causing more whole-file
   reads. Mitigated by the per-session A/B; correctness and total cost decide.
3. **Body scoring adds local CPU** (reading candidate bodies). Bodies are already
   in the store; cap candidates at 20 and abort scoring at a time budget.
4. **Card version semantics confuse resume.** It is labelled as the current
   indexed version, not the agent's checkpoint; `diff --last` remains the
   checkpoint path.
5. **Live A/B cost.** ~26 sessions; cut optional experiments first.

## Definition of done

- Step 0 merged: `bench/cost.mjs`, restored session report, baseline artifact.
- For each lever: a gate table with per-task numbers, a keep/discard decision,
  and a changelog entry (shipped) or a negative-result note (discarded).
- No existing benchmark number changes; all new numbers are additive and
  reproducible from a documented command.
