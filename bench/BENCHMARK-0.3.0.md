# 0.3.0 benchmark — head-to-head vs graphify, self-eval, resume economy

Re-run of the graphify comparison (see [`GRAPHIFY.md`](GRAPHIFY.md) for the
0.2.1 record) on **MemAi 0.3.0**, extended with three measurements 0.2.x could
not make: dependency-navigation questions (0.3.0's `graph` competes directly),
a retrieval-quality baseline via the new `eval` harness, and the checkpoint
resume economy. Same method discipline: one repo, one machine, one estimator
(`ceil(chars / 3.966)`) on both sides, all outputs captured.

## Setup

- Corpus: this repository at `feat/navigation-eval-pack` (0.3.0; 77 files,
  13.6K LOC, card 270 tok / map 951 tok).
- graphify `graphifyy==0.9.34`, AST build: 621 nodes / 1,326 edges /
  28 communities over 50 code files, ~10 s, 0 LLM tokens (docs still outside
  its free path).
- MemAi `index`: 407 ms, 0 tokens, all 77 files.
- Machine: Windows 11 x64, Node 24.14, ripgrep 15.1.0, Python 3.14.

## Six-question head-to-head

| # | task type | graphify (tok) | MemAi 0.3.0 (tok) | verdict |
| --- | --- | --- | --- | --- |
| B1 | how/body — "how does the watch daemon debounce events?" | 1,654 — truncated, node list, **no code** | **718** (query 127 + fault 591) — full function body | MemAi |
| B2 | callers — "what calls indexFiles?" | **54 — MISS** ("No affected nodes found") | 197 — 5 callers incl. body-level call sites | MemAi |
| B3 | reverse-deps — "what breaks if resolveDb changes?" | 1,936 (query 1,645 + affected 291) | **185** — `graph` importers (7 files) | MemAi, 10× |
| B4 | import-chain — "trace bin/memai.mjs → src/store.mjs" | **30** — `path` finds the shortest path | 256 — all 27 chains | **graphify** |
| B5 | body-only string — "where is 'circuit breaker' handled?" | 7 — "No matching nodes found" | **252** — 7 ripgrep hits (`--rg`) | MemAi |
| B6 | locate+body — "where is estTokens and what does it do?" | 58 — explain: edges, no body | 63 — fault with the body | tie on cost, MemAi complete |
| | **totals** | **3,739** + follow-up file reads | **1,671**, answers complete | **MemAi ~2.2×** |

- graphify missed **2 of 6 questions outright** (B2: dynamic-import edge not
  captured; B5: body strings are not in a code-AST graph) and truncated B1.
- Honest loss: **B4 belongs to graphify** — a pre-built graph answers
  shortest-path in 30 tokens; MemAi's `graph` currently returns *all* chains
  (richer but costlier). A `--shortest` mode is the obvious follow-up.
- B1/B2 use the identical questions as the 0.2.1 run, so the trend is
  measurable: Q-callers went from miss-plus-manual-grep to a 197-token answer;
  Q-body stayed ~718 (the 0.2.1 budget fix serving 591 instead of a stub).

## Fixed per-session overhead

| | tokens |
| --- | --- |
| MemAi MCP `mem` tool schema (0.3.0 — grew with `graph`/`pack` args) | **891** (0.2.1: 716) |
| MemAi SessionStart hook injection (rules + card) | ~370 |
| graphify SKILL.md + query reference (per invoked session) | ~14,100 |

Still ~11× less always-on instruction load than graphify's invoked-session
load, while covering 6 of its query/navigation use cases.

## Self-eval baseline (new in 0.3.0)

`memai eval --fixtures bench/eval-fixtures.json --k 5` — 12 curated
`{"q","expect"}` fixtures over this repo:

| mode | recall@5 | MRR |
| --- | --- | --- |
| index (FTS + symbols) | 50% | 0.32 |
| hybrid (union ripgrep) | 50% | 0.32 |

The six misses are conceptual phrasings ("index corpus distil", "watcher
pidfile liveness") whose individual terms fan out across many files — hybrid
did not rescue them because broad terms like `index` flood the ripgrep cap
before the right file surfaces. **This 50% is the number future retrieval work
has to move.** Candidates: per-term IDF weighting before the rg cap, title
boost for file-name matches, phrase queries. The harness to prove any of it is
now shipped.

## Resume economy (checkpoint → 3 files change → `diff --last`)

| | tokens |
| --- | --- |
| `checkpoint` + `diff --last` (286-token delta page, 3 changed files) | **286** |
| Re-reading the 3 changed files fully | 19,774 |
| | **69× fewer** |

Same ratio class as the 0.1-era resume measurement (5.6–9.5×), but without the
hash-hunting step — the agent never had to remember a version string.

## Reproduce

```bash
# corpus prep (any repo)
memai index
python -c "…graphify build per its SKILL.md Part A + Step 4…"

# head-to-head questions
graphify query "How does the watch daemon debounce filesystem events?" --graph graphify-out/graph.json
graphify affected "indexFiles" --graph graphify-out/graph.json
graphify path "memai.mjs" "store.mjs" --graph graphify-out/graph.json
memai query "watch debounce" && memai fault startWatcher
memai fault indexFiles --deep
memai graph mcp/paths.mjs --depth 1

# self-eval + resume
memai eval --fixtures bench/eval-fixtures.json --k 5
memai checkpoint --agent bench   # …edit files, re-index… then:
memai diff --last --agent bench
```

## Limits

- One repo, one machine, six questions. Questions were chosen to span task
  types (body, callers, reverse-deps, chains, body-only strings, locate) but
  are still hand-picked — `eval` fixtures make per-repo measurement repeatable,
  and the 50% baseline shows the retrieval layer has real headroom.
- graphify was driven through its CLI, which prices its *outputs* fairly but
  not its orchestration advantage: for corpus-wide discovery (communities, god
  nodes, mixed media, cross-repo merges) it remains the only tool of the two
  that can do it at all.
- "Required follow-up reads" for graphify are quoted as the same body slices
  MemAi's fault returns (e.g. +969 tok for `startWatcher`); a human might read
  less. The B2/B5 misses and the B1 truncation need no estimation at all.
