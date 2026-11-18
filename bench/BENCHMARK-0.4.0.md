# 0.4.0 benchmark — head-to-head vs graphify, self-eval, resume economy

Full re-run of the graphify comparison on **MemAi 0.4.0** (retrieval sprint +
`graph --shortest`/`affected` + CI). Same method discipline as
[`BENCHMARK-0.3.0.md`](BENCHMARK-0.3.0.md) (whose B4 loss this run closes):
one repo, one machine, one estimator (`ceil(chars / 3.966)`) on both sides,
all outputs captured.

## Setup

- Corpus: this repository at `main` (0.4.0; 81 files indexed, card 281 tok /
  map 973 tok), identical working tree served to both tools (fresh clone).
- graphify `graphifyy==0.9.34`, AST build: 888 nodes / 1,631 edges /
  61 communities over the code files, ~14 s, 0 LLM tokens (7 config files
  produced no nodes; docs still outside its free path).
- MemAi `index`: 0.7 s, 0 tokens, all 81 files.
- Machine: Windows 11 x64, Node 24.14, ripgrep 15.1.0, Python 3.14.

## Six-question head-to-head

| # | task type | graphify 0.9.34 (tok) | MemAi 0.4.0 (tok) | verdict |
| --- | --- | --- | --- | --- |
| B1 | how/body — "how does the watch daemon debounce events?" | 1,653 — truncated (88 of 153 nodes), **no code** | **731** (query 140 + fault 591) — full function body | MemAi |
| B2 | callers — "what calls indexFiles?" | **54 — MISS** ("No affected nodes found") | **184** — `fault --deep`: callers incl. body-level call sites | MemAi |
| B3 | reverse-deps — "what breaks if resolveDb changes?" | 1,934 (query 1,643 truncated + affected 291) | **189** — `graph` importers | MemAi, 10× |
| B4 | import-chain — "trace bin/memai.mjs → src/store.mjs" | **87 — MISS**: "No directed path found" + `--undirected` retry also finds no path (52 + 35) | **39** — `graph --shortest`, 2 hops with edge specs | **MemAi** (graphify won this leg in 0.3.0; its rebuild dropped the bin entry chain) |
| B5 | body-only string — "where is 'circuit breaker' handled?" | **7 — MISS** ("No matching nodes found") | **255** — 7 ripgrep hits (`--rg`) | MemAi |
| B6 | locate+body — "where is estTokens and what does it do?" | 438 — ambiguous-name bail (58) + retry with full node id (380): edges, **no body** | **63** — `fault` with the body, one call | MemAi |
| | **totals** | **4,173** — 3 outright misses, 2 truncated, 1 two-round disambiguation | **1,461** — every answer complete | **MemAi ~2.9×** |

- graphify missed **3 of 6 questions outright** on this rebuild: B2 (the
  dynamic-import call edge is still not captured), B5 (body strings are not in
  a code-AST graph) — as in 0.3.0 — and **B4, which it won last time**: its
  0.9.34 rebuild no longer connects `bin/memai.mjs` to `src/store.mjs` even
  with `--undirected`.
- The 0.3.0 honest loss is closed: `graph --shortest` answers B4 in 39 tokens
  (2 hops, edge specs `[../src/mem-cli.mjs]`, `[./store.mjs]` included —
  something graphify's path output does not carry).
- B1/B2 use the identical questions as the 0.2.1 and 0.3.0 runs; both stay in
  the same regime (truncated node list vs complete body).

## Fixed per-session overhead

| | tokens |
| --- | --- |
| MemAi MCP `mem` tool schema (0.4.0 — grew with `affected`/`target2` args) | **986** (0.3.0: 891) |
| graphify `skill.md` (v0.9.34 package, loaded per invocation) | **10,351** (41,051 chars) |

~10.5× less always-on instruction load than graphify's invoked-session load,
while covering 7 of its query/navigation use cases (query, affected, path,
explain, god-nodes-lite via `graph`, blast radius, shortest path).

## Self-eval

`memai eval --fixtures bench/eval-fixtures.json --k 5` — 12 curated
`{"q","expect"}` fixtures over this repo:

| mode | recall@5 | MRR |
| --- | --- | --- |
| index (FTS + per-term symbols) | **100%** | 0.67 |
| hybrid (union ripgrep) | **100%** | 0.68 |

(On the pristine, un-edited repo the same run reports MRR 0.68 / 0.69 — the
clone carries three one-line marker edits from the resume-economy measurement
below.) The 0.3.0 baseline was 50% / 0.32 on both modes: the multi-word
ripgrep sweep was searching only the first term, and symbol ranking matched
whole queries as one substring. Both fixed in 0.4.0, TDD'd in
`test/retrieval.test.mjs`.

## Resume economy (checkpoint → 3 files change → `diff --last`)

| | tokens |
| --- | --- |
| `checkpoint` + one-line edits to 3 core files + `index` + `diff --last` | **176** (0.3.0 measured 286 on a different 3-file edit set) |

## Reproduce

```bash
# graphify side (0-LLM AST build on this repo, then:)
pip install graphifyy
graphify update <clone-of-this-repo>
graphify query "How does the watch daemon debounce events?" --graph graphify-out/graph.json
graphify affected "indexFiles" --graph graphify-out/graph.json
graphify query "what breaks if resolveDb changes?" --graph graphify-out/graph.json
graphify affected "resolveDb" --graph graphify-out/graph.json
graphify path "bin/memai.mjs" "src/store.mjs" --graph graphify-out/graph.json   # + --undirected retry
graphify query "circuit breaker" --graph graphify-out/graph.json
graphify explain "estTokens" --graph graphify-out/graph.json    # then retry with the full node id

# MemAi side
memai index
memai query "watch daemon debounce events" && memai fault startWatcher
memai fault indexFiles --deep
memai graph resolveDb
memai graph --shortest bin/memai.mjs src/store.mjs
memai query "circuit breaker" --rg
memai fault estTokens
memai eval --fixtures bench/eval-fixtures.json --k 5
```

## What graphify still does better

Stated plainly, because a benchmark that hides the other tool's strengths is
marketing, not measurement: community detection over the whole graph (27–61
communities with LLM naming), god-node/architectural-hub analysis, mixed
corpora (papers, images, video via its LLM extraction path), cross-repo
merged graphs, and human-facing HTML/GraphRAG exports. MemAi does none of
that; graphify does not demand-page bodies, carry budgets, or hand a session
a 200-token card. They are complements.

## Method notes

- Token counts measured with the same `chars / 3.966` estimator on both sides
  (`tools/calibrate-session.mjs` calibration); graphify queried through its
  CLI at its default 2,000-token budget. graphify token figures count its
  stdout; MemAi figures are the envelopes' own `tokens` fields (clamped text).
- The mem-tool overhead is the full tool definition (name + description +
  schema), `JSON.stringify(memTool())` = 3,909 chars. graphify's is its
  packaged `skill.md`, the file loaded into an assistant session on
  invocation.
- One repo, one machine, same day — a navigation benchmark, **not** a
  feature-parity claim.
