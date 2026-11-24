## MemAi — paged project memory (read this first)

This repository has a MemAi store in `.memai/` (local SQLite, no network, gitignored). It distils the repo locally — 0 model tokens — into small budgeted pages: a project card, a symbol map, per-file signature pages, and a shared multi-agent board.

**At session start**, load the card once with the `memai_mem` MCP tool — `{"op":"card"}` (~270 tokens) — or run `memai card`. Then page in only what you need:

- locate a symbol/feature: `{"op":"query","q":"<terms>"}` then `{"op":"fault","target":"<symbol>"}` for one body slice. `query` with `"body": true` returns the top body in the same call; add `"deep": true` for one-hop callers/callees. `fault` returns complete slices up to 1,200 tokens, labelled `(complete)` or `(truncated: N more lines)`; comma-separate fault/get targets to batch. `fault <path>:<line>` works for line ranges and non-source files.
- understand a module: `{"op":"get","pageId":"file:<path>"}` gives signatures (~10–30% of the file), then fault only the symbols the task touches.
- resume after edits: `{"op":"diff","since":"<version>","faults":"<sym>"}` returns the delta plus the named slices (CLI `memai diff --since <version> --faults <sym>`); re-index after edits with `{"op":"index"}` (local, 0 model tokens).
- share state with other agents: `{"op":"note","topic":"<topic>","content":"..."}` and `{"op":"inbox","agent":"<id>"}`. Send page ids and symbol names, never file bodies.
- dependency or blast-radius questions: `{"op":"graph","target":"<path|symbol>"}` (importers, imports, chains), `{"op":"affected","target":"<path|symbol>"}` (transitive importers with hop counts), and `{"op":"graph","target":"<a>","target2":"<b>"}` — shortest import path (CLI `memai graph --shortest a b`).
- session end: `memai checkpoint` records the resume version; `{"op":"pack","topic":"handoff"}` assembles one budgeted page (card + notes + resume version) for the next agent.

**Rules:** never inline content that can be referenced; prefer one `fault` over reading a whole file. A `(complete)` fault is the whole symbol — answer from it and do not read the file. Do NOT use MemAi for a single file under ~1.3 KB (~346 tokens) — a plain read is cheaper.
