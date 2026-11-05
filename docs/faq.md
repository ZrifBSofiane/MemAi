# FAQ

### Isn't this just RAG over a codebase?

No. RAG usually means: chunk everything, embed it, retrieve top-k by vector
similarity at query time. MemAi is a **pager**, not a search engine:

- **Deterministic structure, not similarity.** The card, map and file pages are
  built by deterministic extraction (`git ls-files`, language-aware symbol
  regexes, build files). Same tree → same bytes. Retrieval is by symbol, path or
  page id first; FTS/BM25 is the fallback for prose-ish queries.
- **Content-addressed and Merkle-versioned.** Every page has a version hash and a
  manifest; `diff --since H` is answered without touching file bodies.
- **Cache-stable by construction.** Because the card+map bytes are identical
  across sessions until the repo changes, they sit at the front of the prompt as
  a reusable prefix and bill at the provider's cache-hit rate. Vector retrieval
  returns a different mixture every time, which defeats prefix caching.
- **Budgeted, not "top-k".** Every response is clamped to a token budget and
  carries `tokens`, so the cost is explicit at each step.

### Why not embeddings?

Code structure is explicit: files, symbols, imports, routes, tests. Extracting it
deterministically is cheaper, exact, auditable, and byte-stable; an embedding
index is lossy, costs a build step, needs a model, and shuffles ordering — which
breaks the prefix cache that makes the shared block nearly free. Embeddings are
a reasonable *optional* reranker for prose knowledge (decisions, notes) later;
they are not the core.

### Does it work with multiple agents at once?

Yes, on one machine and one workspace. The store is a single SQLite database
(WAL) with one writer and many readers, so a lead agent, its subagents and a
parallel tool can all page from it. Coordination uses the shared board
(`note`/`post`/`inbox`): append-only typed messages carrying page ids, not file
bodies. Agents on different machines need a shared DB path or a sync layer —
not in v1.

### What happens when pages are stale?

Content hashes make staleness detectable. The index is local and fast (tens to
hundreds of milliseconds), and `memai index` is idempotent: re-indexing an
unchanged tree is a no-op. After edits, re-index and the version changes; other
agents learn about it with `diff --since`. `fault` re-reads the file from disk
but line numbers and symbols come from the index, so a stale index can return
stale line numbers — that is why `status` reports freshness and why re-indexing
after a checkout is the norm. Raw `read` is always available when correctness
demands it.

### How much does it actually save?

Measured, not estimated, in [`../bench/RESULTS.md`](../bench/RESULTS.md):

- **3.06× fewer input tokens** than naive file reads (67,149 → 21,958 tokens
  across 14 tasks on four self-contained corpora).
- **4.7× cheaper in dollars** than a model-written summary-handoff workflow
  (C\* $0.003966 vs B $0.018707 per 14 tasks at off-peak deepseek-flash prices;
  B is also 3.59× worse on input tokens).
- **5.6–9.5× fewer tokens for a delta resume** after three files change
  (~102-token diff + two faults vs re-reading the changed files).
- Counterfactual on real logs: a last-8-tool-results retention policy would cut
  prompt tokens **7.8×** and cost **−56%** on a 32.8M-token, 170-step task
  ([`evidence.md`](evidence.md)).

It also *loses* in specific cases: one small file, one symbol, or many tiny
queries. The measured break-even is ~346 tokens (~1.3 KB) of file bodies; use
plain `read` below that. Every number above is from this machine's runs, with
the caveats stated in those files.

### Why not just use a bigger context window?

Bigger windows raise the ceiling but not the bill: a token in context is re-sent
(and re-billed) at every subsequent step, and 98.3% of the measured bill was
exactly that re-transmission. Long contexts also degrade — recall over
mid-context material drops as input grows, on every model family tested. Paging
attacks cost per step and keeps the working set small; a bigger window just makes
the leakier bucket bigger.

### Does MemAi send my code anywhere?

No. It has no network code, no dependencies, and no telemetry. It reads the repo
you point it at and writes a local SQLite store plus, if you run `memai init`,
instruction blocks and MCP config snippets. The store is git-ignored. See
[`../SECURITY.md`](../SECURITY.md) for handling secrets.

### Do I have to use MCP?

No. The CLI is a first-class surface: every paged operation is one command with
JSON output and a token count. If your agent can run shell commands, it can use
`memai` without MCP. MCP exists so agents get typed tools and resources without
shell plumbing; a host plugin (e.g. the DeepSeek Harness adapter) can additionally
inject the card into every agent's context.

### Will it modify my repository?

`memai init` writes: the `.memai/` store (git-ignored), an instruction block
between `<!-- memai:start -->` / `<!-- memai:end -->` markers in `CLAUDE.md` /
`AGENTS.md` (created if missing, merged carefully otherwise), and config snippets
under `.memai/configs/`. With `--write-configs` it also merges MCP entries into
`.mcp.json` / `opencode.json` without clobbering other keys. It is idempotent: a
second run changes nothing. It never rewrites source files.

### Which Node version do I need?

Node.js **≥ 22.13** (the store uses the built-in `node:sqlite`; 22.5–22.12 need
the `--experimental-sqlite` flag). No native modules, no `npm install`. CI runs
the suite on Node 22 and 24.

### Where does the store live, and how do I move or share it?

`<project>/.memai/mem.db`, where `<project>` is `--root`, `$MEMAI_ROOT`, or the
nearest ancestor with `.git`/`.memai`. Override the file with `--db` or
`$MEMAI_DB`. The store is per workspace and git-ignored; copy it only if you
mean to copy the distilled source content (see [`../SECURITY.md`](../SECURITY.md)).
Cross-machine sharing needs a shared path or a sync layer, which v1 does not
provide.

### Does it work on Windows, macOS and Linux?

Yes. Paths are handled with `node:path`, store paths are relative to the project
root, and no POSIX-only shell calls are required. CI runs on Linux; the reference
measurements and development happened on Windows, so both are exercised.

### How is this different from Cursor/Sourcegraph codebase indexing?

Those tools build an index so a *search UI* can find code. MemAi builds page
artifacts and version deltas so an *agent's prompt* can be composed under a hard
token budget, across sessions and across agents, with a stable cacheable prefix.
The two are complementary: MemAi does not need a server, does not do embeddings,
and is consumed by tool calls rather than by a human search box.

### Can I add my agent?

Yes — see the adapter guide in [`../CONTRIBUTING.md`](../CONTRIBUTING.md). An
adapter is a directory with a README, an MCP config snippet and an instruction
block; no code is required. Mark honestly what you verified on a real install
versus copied from vendor docs.

### What is the license?

MIT. Use it, fork it, ship it.
