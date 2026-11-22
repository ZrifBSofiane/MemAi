# 0.5.0 benchmark — head-to-head vs graphify, read guard, self-eval, resume

Full re-run on **MemAi 0.5.0** (read guard + 0.4.0 retrieval/navigation), same
method discipline as [`BENCHMARK-0.4.0.md`](BENCHMARK-0.4.0.md): one clone served
to both tools, one machine, one estimator (`ceil(chars / 3.966)`), all outputs
captured.

## Setup

- Corpus: this repository at `main` @ `d856628` (0.5.0; 87 files indexed,
  card 282 tok / map 1,060 tok), fresh clone.
- graphify `graphifyy==0.9.34`, AST build: **961 nodes / 1,782 edges /
  58 communities**, ~14 s, 0 LLM tokens (7 config files produced no nodes;
  docs still outside its free path).
- MemAi `index`: 0.77 s, 0 tokens, all 87 files.
- Machine: Windows 11 x64, Node 24.14, ripgrep 15.1.0, Python 3.14.

## Six-question head-to-head

| # | task type | graphify 0.9.34 (tok) | MemAi 0.5.0 (tok) | verdict |
| --- | --- | --- | --- | --- |
| B1 | how/body — "how does the watch daemon debounce events?" | 1,654 — truncated (88 of 159 nodes), **no code** | **731** (query 140 + fault 591) | MemAi |
| B2 | callers — "what calls indexFiles?" | **54 — MISS** ("No affected nodes found") | **184** — `fault --deep` | MemAi |
| B3 | reverse-deps — "what breaks if resolveDb changes?" | 1,947 (query 1,644 truncated + affected 303) | **189** — `graph` importers | MemAi, 10× |
| B4 | import-chain — "trace bin/memai.mjs → src/store.mjs" | **87 — MISS**: no directed path, `--undirected` also finds none (52 + 35) | **39** — `graph --shortest`, 2 hops with edge specs | MemAi |
| B5 | body-only string — "where is 'circuit breaker' handled?" | **7 — MISS** | **266** — 7 ripgrep hits (`--rg`) | MemAi |
| B6 | locate+body — "where is estTokens and what does it do?" | 464 — ambiguous bail (58) + id retry (406): edges, **no body** | **63** — `fault` with the body | MemAi |
| | **totals** | **4,213** — 3 outright misses, 2 truncated, 1 two-round disambiguation | **1,472** — every answer complete | **MemAi ~2.9×** |

- Same outcome shape as 0.4.0: graphify misses B2/B4/B5 outright, truncates
  B1/B3, and needs two rounds on B6. Its node count grew with the corpus
  (888 → 961), the misses did not change.
- B4 remains MemAi's: graphify's rebuild still does not connect
  `bin/memai.mjs` to `src/store.mjs` in either direction.

## Read guard (new in 0.5.0 — no graphify equivalent)

A PreToolUse hook denies whole-file reads only where paging halves the cost
(`bytes ≥ 8 KB` and `file_tokens ≥ 2 × (sig + 400)`), returning signatures.

Measured on this repo, real hook invocation:

| | tokens |
| --- | --- |
| `Read src/page.mjs` (whole file, 50.1 KB) | 12,926 |
| MemAi guard deny page instead (signatures + 3 biggest-body `fault` moves) | **492** |

**26× fewer tokens for that read**, and the model gets the file's surface plus
concrete next moves (`fault _rgSearch`, `fault diff --deep`, `fault query --deep`,
"read again to override").

`node bench/guard-sim.mjs` — 14 tasks across 4 corpora:

| threshold | files denied | intercepted share of read tokens | paged cost vs read | max override penalty |
| --- | --- | --- | --- | --- |
| 4 KB | 10 | 90% | 0.15 | 446 tok |
| **8 KB (default)** | **7** | **80%** | **0.13** | **446 tok** |
| 16 KB | 3 | 57% | 0.08 | 446 tok |

Worst 8 KB file still saves 3.4×. The default is not a claim about live model
behaviour: the on/off A/B over real sessions is the follow-up this benchmark
does not make.

## Fixed per-session overhead

| | tokens |
| --- | --- |
| MemAi MCP `mem` tool schema (unchanged in 0.5.0 — guard is CLI/hook only) | **986** |
| graphify `skill.md` (v0.9.34 package, loaded per invocation) | **10,351** (41,051 chars) |

~10.5× less always-on instruction load, while covering 8 of graphify's
query/navigation use cases (query, affected, path, explain, blast radius,
shortest path, guard, card).

## Self-eval

`memai eval --fixtures bench/eval-fixtures.json --k 5` on the clone:

| mode | recall@5 | MRR |
| --- | --- | --- |
| index | **100%** | 0.69 |
| hybrid | **100%** | 0.70 |

## Resume economy (checkpoint → 3 files change → `diff --last`)

| | tokens |
| --- | --- |
| delta page (3 changed files, 0 symbols added/removed) | **75** |
| re-reading those 3 files (797 + 1,134 + 159) | 2,090 |

**27.9× fewer tokens to resume.**

> Correction to the 0.4.0 record: its "176" was the first `changed[].tokens`
> entry (a changed file's size), not the delta page — a field-reading slip in
> that run. The delta page for the same shape of edit is 75 tokens; the 0.4.0
> archive carries a pointer to this correction.

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
graphify explain "estTokens" --graph graphify-out/graph.json   # then retry with src_tokens_esttokens

# MemAi side
memai index
memai query "watch daemon debounce events" && memai fault startWatcher
memai fault indexFiles --deep
memai graph resolveDb
memai graph --shortest bin/memai.mjs src/store.mjs
memai query "circuit breaker" --rg
memai fault estTokens
echo '{"tool_name":"Read","tool_input":{"file_path":"src/page.mjs"},"session_id":"s"}' | memai hook guard
memai eval --fixtures bench/eval-fixtures.json --k 5
node bench/guard-sim.mjs
```

## What graphify still does better

Stated plainly, because a benchmark that hides the other tool's strengths is
marketing, not measurement: community detection (58 communities with LLM
naming), god-node analysis, mixed corpora (papers, images, video via its LLM
extraction path), cross-repo merged graphs, and human-facing HTML graph
exports. MemAi does none of that; graphify does not demand-page bodies, carry
budgets, or guard reads. They are complements.

## Method notes

- Token counts use the same `chars / 3.966` estimator on both sides; graphify
  through its CLI at the default 2,000-token budget, MemAi from each envelope's
  own `tokens` field (clamped text). The guard reason is measured by
  `chars / 3.966` on its text.
- One clone, one machine, same day — a navigation benchmark, **not** a
  feature-parity claim.
