# Head-to-head: MemAi vs graphify (2026-11-17)

> **0.3.0 re-run:** this comparison was repeated against MemAi 0.3.0 with six
> questions, dependency-navigation legs, an `eval` baseline and the resume
> economy — see [`BENCHMARK-0.3.0.md`](BENCHMARK-0.3.0.md). The numbers below
> are the original 0.2.1 record, kept for trend comparison.

Measured comparison of token economy for the agent codebase-navigation
workload. **One repo, one machine, two questions** — a navigation benchmark,
not a feature-parity claim.

## Setup

- Corpus: this repository at `main` (75 files, 13,137 LOC, ~161,925 tokens if
  read fully), copied to a temp dir so neither tool touched the checkout.
- Machine: Windows 11 x64, Node 24.14, ripgrep 15.1.0, Python 3.14.
- graphify `graphifyy==0.9.34` (pip); MemAi 0.2.1 working tree.
- Token estimator on both sides: `ceil(chars / 3.966)` — MemAi's shipped
  estimator, applied to graphify's output bytes as well for parity.

## Build (zero-LLM paths of both tools)

| | MemAi `index` | graphify AST build |
| --- | --- | --- |
| LLM tokens | 0 | 0 |
| Wall time | 0.31 s | ~9.8 s (detect + extract + build + cluster) |
| Coverage | 75 file pages + symbols (code, md, json, toml) | 608 nodes / 1,268 edges / 27 communities over **48 code files only** |
| Output size | 5.6 MB store (SQLite) | 594 KB `graph.json` |

graphify's graph covers code only; adding the 25 markdown docs requires its
semantic extraction path (subagent or Gemini reads every doc — its own docs
estimate ~45 s per 22-file agent batch), which costs real model tokens. MemAi
indexes markdown for 0 tokens (headings + keys only; no semantic understanding
of prose on either side's free path).

## Per-session instruction overhead

| | chars | tokens |
| --- | --- | --- |
| MemAi MCP tool (name + description + schema, loaded in every session) | 2,839 | **716** |
| MemAi SessionStart hook injection (rules + card) | ~1,400 | ~370 |
| graphify SKILL.md (loaded when the skill is invoked) | 42,439 | ~10,700 |
| graphify `references/query.md` (loaded on query flows) | 13,456 | ~3,390 |

An agent that invokes graphify pays ~14.1K tokens of instructions before its
first answer; MemAi's always-on cost is the 716-token schema plus a one-time
~370-token card.

## Query head-to-head

**Q1 — "How does the watch daemon debounce filesystem events?"**

- `graphify query "<Q>"` (default 2,000-token budget): 6,555 chars ≈ **1,652
  tokens**, hit its budget and truncated (101 of 171 nodes shown). Output is a
  node/edge list with locations — it localizes correctly (`DEBOUNCE_MS`,
  `startWatcher`) but contains no code. Answering the question still requires
  reading `src/watch.mjs` L92–255 (~+1–2K tokens).
- MemAi: `query "watch debounce"` (93 tokens) → `fault startWatcher` (599
  tokens, the whole function). **Total 692 tokens, answer complete.**

**Q2 — "What calls indexFiles?"**

- `graphify affected "indexFiles"`: 214 chars — **"No affected nodes found."**
  The dynamic-import call edge (`import('./extract.mjs').then(({ indexFiles })
  => …)`) is not captured by its AST relations.
- MemAi: `fault indexFiles --deep` (121 tokens) — callers listed from the
  signature scan (and 0.3+ augments remaining slots with a ripgrep body sweep
  for exactly this class of call site).

`graphify explain startWatcher` (802 chars ≈ 202 tokens) returns the call
edges around the symbol — a good lightweight neighbor list, but still no body;
MemAi's `fault --deep` pairs the same neighbor information with the code.

## Numbers, honestly

- ~20× less per-session instruction overhead (716 vs ~14.1K when invoked).
- ~2.4× fewer tokens per answered question on Q1 (692 vs 1,652 + required
  file reads), with a complete answer instead of an address.
- Build is 0-LLM-token on both sides for a code-only corpus; MemAi covers the
  whole tree, graphify covers code only.

## Reproduce

```bash
# graphify side
pip install graphifyy
# build per the graphify SKILL.md Part A + Step 4 (AST path), then:
graphify query "How does the watch daemon debounce filesystem events?" \
  --graph graphify-out/graph.json
graphify affected "indexFiles" --graph graphify-out/graph.json

# MemAi side
memai index && memai query "watch debounce" && memai fault startWatcher
memai fault indexFiles --deep
```

## What graphify does better

Stated plainly, because a benchmark that hides the other tool's strengths is
marketing, not measurement: community detection over the whole graph (27
communities with cohesion scores), god nodes and "surprising connections",
cross-repo merged graphs, mixed corpora (papers, images, video transcription),
Obsidian/Neo4j/GraphRAG exports, an interactive HTML visualization, a
cumulative cost tracker, and extraction caching keyed by prompt version.
MemAi does none of those. If your question is "which subsystems connect to
which" over a large corpus, graphify is the right tool; if it is "where is X,
what does it do, what changed since yesterday", MemAi answers with fewer
tokens and a complete result.
