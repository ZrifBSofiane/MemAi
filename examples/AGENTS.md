<!-- memai:start -->
## MemAi — paged project memory (read this first)

This repository has a MemAi store in `.memai/` (local SQLite, no network,
gitignored). It distils the repo locally — 0 model tokens — into small budgeted
pages: a project card, a symbol map, per-file signature pages, and a shared
multi-agent board.

MCP: server `memai`, tool `mem` (`{"op":"card"}`, `{"op":"query", ...}`, …).
If MCP is not configured, run the same operations with the `memai` CLI.

**At session start**, load the card once: `memai card` (~200 tokens). Then page
in only what you need:

- locate: `memai query "<terms>"` then `memai fault <symbol>` for one body slice;
- understand a module: `memai get file:<path>` for signatures, then fault only
  the symbols the task touches;
- resume after edits: `memai diff --since <version>` — do not re-read changed
  files. Re-index after edits: `memai index` (local, 0 model tokens);
- share state with other agents: `memai note <topic> "<body>"` and
  `memai inbox <agent>`. Send page ids and symbol names, never file bodies.

**Rules:** never inline content that can be referenced; prefer one `fault` over
reading a whole file. Do NOT use MemAi for a single file under ~1.3 KB
(~346 tokens) — a plain read is cheaper.
<!-- memai:end -->
