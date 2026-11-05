## MemAi — paged project memory (read this first)

This repository has a MemAi store in `.memai/` (local SQLite, no network, gitignored). It distils
the repo locally — 0 model tokens — into small budgeted pages: a project card, a symbol map,
per-file signature pages, and a shared multi-agent board.

**At session start**, load the card once with the `mem` MCP tool — `{"op":"card"}` (~200 tokens) —
or run `memai card`. Then page in only what you need:

- locate a symbol/feature: `{"op":"query","q":"<terms>"}` then `{"op":"fault","target":"<symbol>"}`
  for one body slice (`fault <path>:<line>` works for line ranges and non-source files).
- understand a module: `{"op":"get","pageId":"file:<path>"}` gives signatures (~10–30% of the
  file), then fault only the symbols the task touches.
- resume after edits: `{"op":"diff","since":"<version>"}` — do not re-read changed files. Re-index
  after edits with `{"op":"index"}` (local, 0 model tokens).
- share state with other agents: `{"op":"note","topic":"<topic>","body":"..."}` and
  `{"op":"inbox","agent":"<id>"}`. Send page ids and symbol names, never file bodies.

**Rules:** never inline content that can be referenced; prefer one `fault` over reading a whole
file. Do NOT use MemAi for a single file under ~1.3 KB (~346 tokens) — a plain read is cheaper.
