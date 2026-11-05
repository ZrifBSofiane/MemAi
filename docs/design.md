# Design: paged memory for coding agents

> Derived from the project's design note. Local paths, session ids and
> host-internal citations have been removed; the measurements are unchanged.

## 1. The problem

Sessions and subagents re-derive the same project state over and over. Every new
session reads files again; every subagent gets a prose summary written by a
model (expensive output tokens, lossy); agent-to-agent coordination goes through
steering messages that mutate a cached prompt prefix.

**Claim.** You cannot transfer *knowledge* without tokens — a model only knows
what is in its context window. But you can stop paying repeatedly for the same
bytes, and stop paying a model to restate them. The right analogy is **not an
mmap**; it is a **pager**: an immutable, content-addressed page store, a
manifest ("page table") that costs ~1–3k tokens, demand faults by page id,
copy-on-write deltas, and eviction. That is buildable today, in a host plugin or
a local MCP server.

This document is grounded in two things: **measurements of real session logs**
([`evidence.md`](evidence.md)) and a **runnable prototype with a reproducible
benchmark** ([`../bench/RESULTS.md`](../bench/RESULTS.md)).

## 2. What "burning tokens" actually is (measured)

Decoded from the provider-billed usage events of one completed two-agent task
(125-step lead + 45-step research subagent):

| metric | value |
| --- | --- |
| model steps | 170 |
| tokens billed | **32.77M** (uncached input 0.41M · cache-read 32.21M · output 0.15M) |
| share that is re-sent context (cache-read) | **98.3%** |
| share that is new input / output | 1.3% / 0.5% |
| prompt tokens attributable to tool results | **91.4%** (files 22.8%, shell 11.6%, inspection 49.9%) |
| average further steps each tool result rides in context | **~39** |
| tool-output bytes that are byte-identical repeats | 14.9% (266 results → 212 unique) |
| context at step 1 → step 125 | 4.1k → 310k tokens |
| cost at off-peak deepseek-flash prices | **$0.248** ($0.062 + $0.097 + $0.089) |

Three things follow:

1. **The bootstrap is not the problem.** The first model call of a session is
   ~4k tokens (system prompt + task). Re-reading the project at session start is
   a rounding error next to what happens after.
2. **The problem is accumulation × re-transmission.** A tool result is paid once
   when it arrives, then again on *every subsequent step* as part of the prefix.
   125 steps × a context that grows monotonically = tens of millions of prompt
   tokens for one session.
3. **Cross-session and cross-agent duplication is a multiplier on top.** In the
   measured task the research subagent alone billed 6.1M prompt tokens
   re-deriving the same project facts its parent already owned.

So the target is not "avoid reading files once" — it is **keep the per-step
working set small and shared**, and **make what is shared byte-identical across
agents** so it bills at the cache-hit rate.

The counterfactual simulation on the same logs is the size of the prize: keeping
only the last 8 tool results inline (each capped at 600 tokens, older ones
replaced by a ~200-char handle with a page id) would have cut prompt tokens
**32.6M → 4.2M (7.8×)** and cost **$0.248 → $0.110 (−56%)** for the same task.
The residual 36% of the bill is output/reasoning — the second lever, addressed by
giving agents structure instead of raw material to reason about.

## 3. Three laws to design against

**L1 — Inclusion.** A model can only reason over tokens in its context. There is
no mmap, no shared memory page, no side channel into the weights. Whatever the
agent must *decide* on, it must have read. (This kills the dream of "transfer all
knowledge with zero tokens".)

**L2 — Multiplicity.** A token in context is billed again at every later step of
that session, and again in every agent that re-reads or inherits it. Agent cost
≈ `Σ_steps (prefix tokens)` × agents. Every saved byte is saved `steps × agents`
times.

**L3 — Price asymmetry** (deepseek-flash, fetched 2026-11):

| trade | rate | consequence |
| --- | --- | --- |
| cache-hit input vs cache-miss input | **1 : 50** | a byte-identical reused prefix is almost free; a shuffled one is not |
| output vs cache-miss input | **4 : 1** | model-written handoff prose is 4× the price of sending the same facts as input tokens |
| output vs cache-hit input | **200 : 1** | writing a 1.5k-token summary for a child costs the same as a child *reading* 300k cached tokens |
| peak vs off-peak | **2 : 1** | indexing/backfill/merge work belongs off-peak |

Corollary: **the cheapest token is one you never send; the second cheapest is one
sent again as an identical prefix.** Prose is the luxury good; deterministic
artifacts + references are the cheap good.

## 4. The OS analogy, mapped honestly

| OS concept | agent analogue | buildable? |
| --- | --- | --- |
| page | immutable, content-addressed text block | yes |
| page table | manifest: `page_id → {kind, version, tokens, anchors}`, plus a symbol index | yes — this is the ~1–3k-token thing an agent actually gets |
| page fault | a tool call that materialises page bytes into the context | yes — **the only way in** |
| shared memory / mmap | identical prefix bytes in many agents' prompts | only via the provider's **prefix cache** (50× discount). No provider lets you hand a child agent a KV cache; agents do not share an address space |
| copy-on-write | shared pages read-only; agents append deltas/notes; a merge bumps the Merkle version | yes |
| eviction | drop old pages from the live context; they remain on disk and can be re-faulted | yes — the biggest immediate win |
| TLB / fault cost | tool-call round trip + framing (~150–400 tokens overhead) | real cost; keep faults coarse (hundreds of tokens, not lines) |

**Conclusion: build a pager, not an mmap.** The "shared memory" that actually
exists between two agents is (a) the same store they can both fault from, and
(b) the same bytes at the front of their prompts producing a cache hit.
Everything else is a tool call — which is fine, because a tool call costs
~150–400 tokens against the ~4–6k tokens a raw file read costs.

This is also why the file system is not enough by itself: files are shared
storage but have no page table (the agent does not know what is in them without
reading) and no token-delta protocol (any change forces a re-read). The page
store adds the missing two.

## 5. Architecture

```
           ┌──────────────────────────────────────────────┐
agents →   │  MCP tools / memai CLI (get/query/fault/diff) │  ← pager; token budget in every response
           └───────────────┬──────────────────────────────┘
                           │ page ids, hashes, deltas
           ┌───────────────▼──────────────────────────────┐
           │  page layer: immutable pages, Merkle versions │
           │  card · map · file · module · task · board    │
           └───────────────┬──────────────────────────────┘
                           │ deterministic extraction (no LLM)
           ┌───────────────▼──────────────────────────────┐
           │  extractors: git · language symbols · tests   │
           │  build files · docs · notes                   │
           └───────────────┬──────────────────────────────┘
                           │ content-addressed blobs + FTS index
           ┌───────────────▼──────────────────────────────┐
           │  store: SQLite (WAL), one per workspace       │
           │  .memai/mem.db                                │
           └───────────────────────────────────────────────┘
```

### 5.1 Store

SQLite, one file per workspace (`.memai/mem.db`), WAL mode, one writer and many
readers. Content-addressed pages dedupe by hash automatically.

A sketch of the shape (the normative schema is `PROTOCOL.md` §3; the readable
description is [`protocol.md`](protocol.md)):

```sql
pages(id TEXT PRIMARY KEY,        -- page_id = 'kind:name'
      kind TEXT, version TEXT,    -- version = Merkle hash of children + extractor rev
      text TEXT, tokens INT, producer TEXT, created_at INT)
page_history(page_id, version, text, tokens, created_at)  -- immutable old versions
page_refs(page_id, child_id)      -- DAG; version = hash(child versions, extractor version)
files(path TEXT PRIMARY KEY, content_hash TEXT, page_id TEXT, mtime INT, lang TEXT)
symbols(name TEXT, kind TEXT, path TEXT, line INT, sig TEXT, page_id TEXT)  -- + FTS5
messages(topic TEXT, seq INTEGER, agent TEXT, kind TEXT, body TEXT, refs TEXT, ts INT)
agents(id TEXT, role TEXT, status TEXT, page_version TEXT, last_seen INT)
meta(key TEXT PRIMARY KEY, value TEXT)   -- extractor_version, workspace_hash, last_index
```

### 5.2 Page kinds and budgets (hard caps are the point)

| page | content | budget | lifetime |
| --- | --- | --- | --- |
| `project.card` | stack, entrypoints, build/test/lint commands, layout, conventions, "don't read these" | **≤ 700 tok** (typically ~200–250 rendered) | rebuilt on manifest change |
| `project.map` | ranked symbol list: `path:line name(signature)` + one-line file purpose | **≤ 3500 tok** (default budget) | rebuilt on code change (batched) |
| `file.page` | per-file: exports, symbols, signatures, imports, tests that touch it — **never bodies** | ~10–30% of file | per file hash |
| `module.page` | directory/module: responsibilities, public API, dependency edges | ≤ 800 tok | per subtree hash |
| `task.page` | current task, plan, open questions, decisions, touched pages | ≤ 600 tok | append-only per turn |
| `decision.page` | ADR-style records distilled from agent notes (deterministic template) | ≤ 300 tok | append-only |
| `board:<topic>` | shared agent bulletin board, rebuilt by `merge` | budget-clamped | append-only |
| `diff --since H` | added/changed/removed files + symbol churn | ≤ 600 tok | per version pair |

Rule of thumb: **an agent should receive ≤ 8k tokens of shared context at start**
(card + map slice + task page), and fault in ≤ 2–4k per step. The average file
read in the logs was 2.2k tokens *per file*, and 91% of prompt volume was these
reads accumulating.

### 5.3 Deterministic extraction (no LLM in the hot path)

Per language: regex/heuristic symbol extraction (exported functions/classes/
routes/tests), imports, and signature lines. Sources of truth: `git ls-files`
(respects `.gitignore`), `package.json` / `pyproject.toml` / `Cargo.toml` /
`go.mod` for commands and stack, lockfiles for dependency versions, test layout
heuristics, README headings. The prototype does this with no external
dependencies.

Model-assisted extraction happens **only** for prose knowledge (decisions,
gotchas, "why"), batched off-peak, and is written as append-only deltas — never
re-generated at session start.

### 5.4 Versioning: Merkle pages, delta protocol

- `version(page) = H(sorted(child versions) ⊕ extractor revision)`.
- `project.version = H(card.version, map.version, …)` — one hash a session can quote.
- `diff(since_version)` returns only added/changed/removed pages, as compact text:
  `~ project.map (changed: 3 files)`, `+ src/auth/token.ts`.
- Any agent (or the host) can ask "what changed since the version my parent gave
  me" for the price of a small tool result — no re-read.
- Pages are append-only in practice: a merge produces a new version, old versions
  stay readable (cheap audit + cheap re-fault).

### 5.5 Tool surface (the pager API)

Every response is machine-readable JSON with a `tokens` field and a `budget` echo.
No tool returns more than its cap; content past the cap is replaced by a page id
+ hash + line anchors.

```
memai status                      -> {version, pages, files, dirty, tokens}
memai card [--budget]             -> project card (<= 700 tok)
memai map [--budget]              -> ranked symbol map slice (budget-capped)
memai get <page_id> [--budget]    -> page text (capped; over-budget -> ranges list)
memai fault <symbol|path:line> [--budget] -> exact lines for one symbol/file region
memai query <q> [--k N] [--budget] -> FTS/BM25 hits: path:line + signature, not bodies
memai diff --since <version>      -> compact delta since a version
memai note <topic> <body>         -> append a typed note (board + candidate delta)
memai inbox <agent> [--since N]   -> unread board events (delta only)
```

Over MCP the same surface is one `mem` tool whose `op` argument selects the
operation above (the 11 `mem_*` tools are opt-in via `MEMAI_GRANULAR_TOOLS=1`,
because every tool schema is billed in the request prefix).

Design rules:

1. **Return references, not payloads.** A fault must be cheaper than the file
   read it replaces; enforce with budgets, and let the response say
   `truncated: 3 ranges not shown`.
2. **Deterministic ordering inside a page** (stable sort) so repeated renders are
   byte-identical → cache hits.
3. **Anchors.** Every fact carries `path:line` so an agent can verify or edit
   without a full read.
4. **Freshness.** `mem_status` exposes `dirty`/`stale` and the extractor revision;
   a page older than the file hash is flagged.

### 5.6 Prompt integration and cache discipline

The compiled prompt is ordered **most-stable → least-stable**:

```
[system prompt] [project.card] [project.map@version] [conventions]
[tool definitions] [task.page] [conversation / tool results …]
```

Rules:

- The card+map block must be **byte-identical** across sessions/agents whenever
  the project has not changed. No timestamps, no session ids, no ordering jitter.
- **Append only.** Steering messages and tool results go after the shared prefix;
  splicing inside it turns ~all cached tokens into misses (a 50k-token prefix:
  $0.00015 hit vs $0.0074 miss — a 50× mistake on that span).
- **Batch page merges.** A merge is a deliberate cache reset; do it at natural
  boundaries, not per edit.
- Log `prefix_hash` + provider `prompt_cache_hit_tokens`/`miss_tokens` per request
  so cache discipline is measurable, not aspirational.
- Forking a short session reuses the parent's prefix (good for cache, bad for
  volume once the parent is large). For long parents, prefer a fresh agent with
  the card + page ids over a fork.

## 6. Transfer protocols

### 6.1 Session bootstrap — "resume, don't re-derive"

```
card + map-slice + task.page + diff(since last session's version) = ~1.5–3k tokens
```

The session starts by *reading a version stamp*, not by exploring. If nothing
changed, the diff is empty and the agent knows the store is current. Compare with
today: 100+ tool calls re-establishing state at 2.2k tokens each, then re-billed
every step.

### 6.2 Subagent spawn — "artifact + reference", never a prose summary

Parent → child:

```json
{ "task": "...", "page_ids": ["project.card@v…", "module.page:src/auth@v…"],
  "version": "H(…)", "budget_tokens": 6000,
  "return_schema": { "changed_pages": [], "facts": [], "blockers": [] } }
```

Child → parent: page ids + a ≤300-token typed result. The parent faults pages in
if it needs detail. Cost of the handoff: ~100 input tokens + the child faulting
2k tokens it actually needs. Compare a 1.5k-token prose summary: 1.5k output
(4× the per-token price of input) + the child still re-reading files to verify it,
and it is lossy.

### 6.3 Agent-to-agent, real time — a board, not a steering queue

The board table is an append-only, typed, per-topic log (SQLite WAL). Agents
`post` (≤300-token typed messages with page refs) and read `inbox(since_seq)`.
Delivery is **pull-on-your-next-step plus a compact unread digest injected once**,
which gives shared state in real time without mutating anyone's cached prefix
mid-step:

- messages are small, typed (`handoff | blocker | decision | claim | done`) and
  carry refs instead of content;
- the board is the shared memory; no agent has to "steer" another through the LLM;
- an urgent interrupt remains available, but it is the exception, not the
  channel — each interrupt splices the prefix and costs ~50× on that span.

Nothing can force a model to read a message without spending a turn — that is
physics, not an API gap. That is exactly why the board carries *pointers* and the
card carries the *digest*.

### 6.4 Eviction — the within-session half of the same mechanism

- Every tool result carries a page id; results over the cap are returned as
  handle + 150-token excerpt, full text stored.
- The live context keeps the **last N tool results** (N ≈ 6–8) and replaces older
  ones with their handles (which the agent can re-fault in one call).
- Retention classes: `pinned` (card, map, task, decisions) · `working` (recent
  results) · `ephemeral` (raw output, web pages). Compaction evicts `ephemeral`
  first — never project facts.
- This is deterministic host policy, not model behaviour: measurable,
  enforceable, and worth the measured 7.8× prompt reduction.

### 6.5 Knowledge that is genuinely new

Some knowledge exists only in a session: the reasoning behind a decision, a
discovered gotcha, the fact that a test is flaky. That is the *only* thing worth
writing down — as a `decision.page` / `task.page` delta from a strict template
(claim, evidence refs, alternatives, consequence), not as a transcript. One
model-written sentence with `path:line` refs replaces a paragraph of prose, and is
append-only so it never invalidates the prefix.

## 7. Host integration

A host that can register a tool can host the pager. The shipped, supported
integration is the **MCP server** (`mcp/server.mjs`) plus the `memai` CLI; an
in-process DeepSeek Harness (DSH) plugin (`adapters/dsh/`) is an experimental
reference for hosts that can inject prompt context directly.

| need | mechanism | availability |
| --- | --- | --- |
| card in **every** agent (lead, spawned, forked, team member) | required runtime-context snapshot, append-only and deduped, restored after compaction | verified for in-process DSH agents; host context never reaches out-of-process children (ACP/SDK/Codex/Claude Code) — those use the MCP server instead |
| static instructions in the cached prefix | system-prompt section, kept byte-stable | verified in DSH, 2026-11 |
| one-shot per-agent delta | inbox splice into the next admitted step | verified in DSH |
| tools | register a plain-object tool with schema + execute | verified in DSH; MCP `tools/list`/`tools/call` elsewhere |
| store | `node:sqlite` (`DatabaseSync`, WAL), single writer | verified in DSH's Node runtime and on Node 22.13+/24 |
| session history / "what changed" | host event bus (in-process only) + the store's own versions | partial: no cross-process bus — the SQLite store is the shared channel |
| prompt cache | provider-side automatic prefix caching; hits reported as cache-read tokens | verified with DeepSeek |

Hard constraints that shaped the skeleton: a linked host bundle cannot import
host-private packages (plain JS + `node:` builtins only), third-party plugins get
no custom session event types, and the event bus is single-process. Hence: the
store is the cross-agent channel, the card is the always-present digest, and MCP
is the door for out-of-process agents.

**Integration options**, in order of strength: (a) MCP server via config-only
setup — the shipped path for every agent; it exposes the pager tools but cannot
inject the card into the prompt by itself (a session hook or instruction block
does that); (b) `AGENTS.md`/`CLAUDE.md` instruction block + the `memai` CLI —
zero integration, works today, but content is file-bound and cannot carry a
per-version card; (c) an in-process host plugin (the DSH skeleton) — the only
option that puts the card in every in-process child's prompt, but host-specific
and experimental. `memai init` sets up (a) and (b).

## 8. Economics

Per 1M tokens, deepseek-flash (off-peak / peak): miss $0.15/$0.30 · hit
$0.003/$0.006 · output $0.60/$1.20.

Measured task (32.8M tokens, off-peak, $0.248):

| lever | effect on the same task | notes |
| --- | --- | --- |
| evict/cap tool results (last 8, ≤600 tok, handles for the rest) | **7.8× fewer prompt tokens, −56% cost** | measured by replaying the real logs |
| cross-agent page sharing instead of re-derivation | removes the subagent's 6.1M-token re-derivation (≈ −19% of this task's tokens, more in agent-heavy tasks) | 45-step child re-read the parent's project |
| stable, append-only prefix | 50× cheaper on every reused span | ordering discipline, not new code |
| deterministic pages instead of prose handoffs | ~3× cheaper handoff + no loss | 1.5k out ≈ $0.0009 vs 100-token ref ≈ $0.000015 + 2k fault ≈ $0.0003 |
| off-peak scheduling of indexing/backfill | 2× | peak = 01–04 & 06–10 UTC Mon–Fri |

Break-even intuition: a page is worth caching after **2 uses** (hit is 50× cheaper
than miss; no write price on DeepSeek). A page is worth *distilling* whenever
`tokens_saved × steps_saved > extraction_cost` — deterministic extraction is free
at the margin, so distill aggressively; model-written distillation only for prose.

What does **not** pay: embedding the whole repo (retrieval quality on code
structure is weak, and the index build itself burns tokens); broadcasting
transcripts (15× multiplier); summarizing everything into prose (output-priced,
lossy); raising the context budget (context rot: recall degrades with input length
on every model tested).

## 9. Rollout

| stage | work | effort | win |
| --- | --- | --- | --- |
| **v0 — CLI + contract** | `memai` CLI, page generation on demand, contract block in instructions, session-end `memai note` for decisions | ~1 day | no re-reading for orientation; handoffs by page id |
| **v1 — host plugin / MCP** | store + the `mem` tool + automatic card/map injection + tool-result caps/handles + eviction policy | ~3–5 days | measured 5–8× prompt reduction |
| **v2 — multi-agent** | subagent handoff payloads, shared board + unread digests, team integration, delta resume between sessions | ~3–5 days | removes re-derivation across agents; real-time without steering |
| **v3 — cache-first prompt compiler** | prefix hash logging, stable ordering, batch merges, off-peak backfill; optional embeddings rerank for prose only | ongoing | 50× on reused spans; measurable cache-hit rate |

Guardrails to keep correctness: raw file access stays available (the page is an
index, not a cage); every fact has `path:line`; the `status` page's `dirty` flag
and page-vs-file hash checks flag staleness; a merge never rewrites history, only
appends versions; secrets never land in pages.

## 10. Failure modes to design against

| failure | guard |
| --- | --- |
| stale page → wrong answer | version = Merkle of file hashes; `dirty` flag; page includes `updated_at` + anchors; agent can `diff` before trusting |
| wrong abstraction (map misses code) | fall back to `fault`/`grep`; keep map ranked and budgeted, not exhaustive |
| query overhead > savings | cap queries per step; budgets; batch (one call returns several pages) |
| prefix mutation kills cache | append-only ordering; batched merges; log prefix hash + hit/miss |
| agents fighting over shared pages | pages immutable; agents only append notes/deltas; merge is deterministic and single-writer |
| over-compression loses the detail that mattered | keep raw bodies in the store; handles are re-faultable; never delete, only evict |
| board noise | typed messages, ≤300 tokens, page refs; no transcripts; digest, not firehose |

## 11. How we prove it

1. **Replay (done):** counterfactual on real session logs → **7.8× fewer prompt
   tokens, −56% cost** for the same task ([`evidence.md`](evidence.md)).
2. **Benchmark (done):** 14 agent tasks over four corpora. Scenario A reads the
   files the task needs; B uses a model-written summary handoff; C pages in via
   `query`/`get`/`fault`; C\* additionally touches every expected file so recall
   is 100% by construction; D resumes a new session from a version delta.
   Measured: **3.06× fewer input tokens than naive reads** (67.1k → 22.0k over
   14 tasks, 45,191 tokens saved), **4.7× cheaper than the summary-handoff
   workflow** (C\* $0.003966 vs B $0.018707), and **5.6–9.5× fewer tokens for a
   delta resume** after three files change (~102-token diff). The per-task ratio
   ranges from 1.17× (a tiny single-file task) to 5.50× (a locate task on a real
   288-file corpus). The tool's own honest limits are in
   [`../bench/RESULTS.md`](../bench/RESULTS.md): many small queries lose to one
   direct read, a single small file beats card+paging, and a stale index needs
   re-indexing. The measured break-even is a task-size rule: `read` wins while
   the needed content is **≤ ~346 tokens (~1.3 KB)**; use `memai` when the target
   is >~2 KB, when ≥2 files are involved, or for a second question in the same
   session; always `diff` on resume.
3. **A/B in production (open):** run representative tasks with and without
   paging; record tokens, cache-hit rate and $/task. Success = ≥5× fewer total
   tokens and ≥90% of shared-prefix tokens billed as cache hits, with no accuracy
   regression on a task checklist.

Metrics to log per session: `prefix_hash`, `cache_hit_tokens`,
`cache_miss_tokens`, prompt tokens attributable to tool results, pages faulted,
bytes shared vs unique, handoff payload tokens, `$`.
