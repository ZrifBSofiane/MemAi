---
name: memai
description: Use MemAi's paged memory in a repository with a .memai store instead of re-reading files. Trigger for orientation (stack, build/test commands, entrypoints), locating a symbol or feature, reading one function body or line range, dependency or blast-radius questions (what imports this, what breaks if it changes, shortest import path), or resuming after edits in a new session. Skip it for a single small file (under ~1.3 KB): a plain read is cheaper.
license: MIT
compatibility: Requires a project with a MemAi store (`memai init`, Node >= 22.13) and either the `mem` MCP tool or the `memai` CLI on PATH. Local-only; no network. Works in Agent Skills clients including Claude Code, OpenCode, Codex, ZCode, DSH and generic SKILL.md hosts.
metadata:
  version: "0.11.0"
  docs: https://github.com/ZrifBSofiane/MemAi
  pager: .memai/mem.db
---

# MemAi — paged project memory

MemAi indexes this repository locally into `.memai/mem.db` (SQLite, zero model tokens, no
network). It serves small, budget-clamped pages on demand. One call returns the page you need;
the alternative is reading whole files into context.

## Use MemAi when

- You are starting work in this repository and need orientation: stack, commands, entrypoints,
  conventions. One `card` call (~270 tokens) covers it.
- You know what you are looking for but not where it is: `query` finds symbols and paths.
- You need one function, method or line range: `fault` returns just that slice — complete up to
  1,200 tokens and labelled `(complete)` or `(truncated: N more lines)`.
- You need a body plus its callers/callees in one call: `{"op":"query","q":"...","body":true,
  "deep":true}` (CLI `memai query "..." --body --deep`) locates the symbol and returns the body
  with one-hop context.
- You want a file's surface without its body: `get file:<path>` returns signatures.
- You are resuming after edits or in a new session: `diff --since <version>` lists what changed;
  add `"faults":"<sym>"` (CLI `--faults`) to include the named slices in the same reply.
  At session end run `checkpoint` (CLI) so the next session can use `diff --last` — no hash hunting.
- You need dependency answers ("what breaks if this changes", "who uses this module"): use
  `{"op":"graph","target":"<path|symbol>","depth":2}` (CLI `memai graph`) — importers, imports,
  transitive chains and cycles from the stored imports table. No body reads.
- You need the blast radius or a route between files: `{"op":"affected","target":"<path|symbol>"}`
  (CLI `memai affected`) lists every file that transitively imports the target with hop counts;
  `{"op":"graph","target":"<a>","target2":"<b>"}` (CLI `memai graph --shortest a b`) returns the
  BFS shortest import path between two files or symbols. Endpoints can be symbol names.
- You are handing work to the next agent: assemble one budgeted page with
  `{"op":"pack","topic":"handoff"}` (CLI `memai pack`) — card + board notes + resume version.
  Optionally `--fault "sym1,sym2"` for small slices of hot code.
- You want to know whether the index can be trusted: `memai eval` over `.memai/eval.json`
  fixtures (recall@k + MRR per mode) and `miss --stats` for organic misses.
- Other agents are working in the same repo: `note`, `post`, `inbox` share page ids and short
  state without pasting file bodies.

## Do not use MemAi when

- The task needs one file under roughly **1.3 KB / ~346 tokens**: a plain file read is cheaper
  and simpler. Measured break-even, not a guess.
- The file you need is already in context or was just read.
- The answer is a single line you can find with a plain search and read directly.
- The store is missing or obviously stale and re-indexing is not worth the local seconds
  (tiny one-file repositories).

## Workflow

1. **Orient once.** Call the `mem` MCP tool with `{"op":"card"}`, or run `memai card`. Do this
   once per session, not per task. The client may already inject the card through a hook or
   MCP instructions; if it is in context, skip this step.
2. **Locate.** `{"op":"query","q":"verify token"}` (CLI: `memai query "verify token"`) returns
   ranked pages and symbols with snippets. Do not read content with `query`; it is a finder.
   Add `"body": true` (CLI `--body`) to get the top symbol's body in the same call — one model
   turn instead of query + fault. Add `"deep": true` (CLI `--deep`) to include one-hop
   callers/callees with that body. Comma-separated targets batch too: `fault a,b,c`,
   `get file:a.js,file:b.js`.
3. **Page.** Fetch one slice:
   - `{"op":"fault","target":"verifyToken"}` — one symbol body (default budget 1,200).
   - `{"op":"fault","target":"src/auth.js:120"}` — the symbol containing that line, or a window outside symbols.
   - `{"op":"get","pageId":"file:src/auth.js"}` — signatures for a whole file.
   CLI equivalents: `memai fault verifyToken`, `memai get file:src/auth.js`.
   A slice marked `(complete)` is the whole symbol; answer from it and do not read the file.
4. **Resume.** With a version hash from the last session: `{"op":"diff","since":"<version>"}`
   (CLI `memai diff --since <version>`). Add `"faults":"sym1,sym2"` (CLI `--faults`) to append
   those slices to the delta. Re-index locally after edits with `{"op":"index"}` or
   `memai index` (no model tokens).
5. **Share.** `{"op":"note","topic":"handoff","content":"auth move: see file:src/auth.js"}`,
   `{"op":"post",...}`, `{"op":"inbox","agent":"<id>"}`; CLI `memai note/post/inbox`.

If MCP is unavailable, every step has a CLI equivalent. If the CLI is unavailable but MCP is
not, use the tool. Do not mix two stores.

## Budget discipline

- Every reply starts with a token count and is clamped to a budget.
- Defaults are tuned: card 700, map 3500, get 1200, fault 1200, query 400, diff 600, inbox 900, graph 500, affected 500, pack 1500. Fault replies label `(complete)` or `(truncated: N more lines)`.
- Lower a budget (`"budget": 300`, `--budget 300`) for a cheap peek; raise it only when the
  previous page was truncated and the rest is genuinely needed.
- Prefer one larger `fault` over many tiny `query` calls. Stop when the question is answered.
- Never inline what can be referenced: send page ids and symbol names in notes, not bodies.

## Pitfalls

- **Stale index.** Pages and line numbers come from the last `index`. Every serving
  command self-checks: replies carry a `stale` field and `[STALE]` markers when the file changed
  on disk — treat those pages as navigation hints, not truth. Re-index mechanically instead of
  memorizing it: `memai hook index` (PostToolUse, fires after every agent edit) and the resident
  `memai watch --ensure` daemon cover agent and external edits; `{"op":"index"}` remains the
  manual fallback. For a precise line range prefer `fault path:line`, which reads the current file.
- **Bodies are not in the index.** File pages carry signatures; body-only strings (error messages,
  literals) are invisible to `query`. Use `query --rg` (`"rg": true`) to union a ripgrep sweep
  over file bodies — the ground-truth net for content the index does not page.
- **Retrieval misses.** When a lookup fails here but succeeds elsewhere (grep, manual), record it:
  `memai miss "<query>" --found-by rg --path <where>`; `miss --stats` shows per-repo recall gaps.
- **No store.** `card`, `get` and `diff` fail until `memai init` (or `{"op":"index"}`) has run.
  Run the init once in the repository root; it is local and idempotent. `--read-only` serves an
  existing store without ever creating one.
- **Wrong root.** If the tool reports a store from another directory, set `MEMAI_ROOT` or pass
  `--root`. MCP servers should be started from the project root.
- **Whole-file reads despite a fault.** Do not fall back to reading the file before trying
  `fault`; try the symbol first (`fault --deep` adds callees/callers in one call), then read only
  if the slice was truncated or insufficient — fault replies carry `line`+`lineEnd`, so read
  exactly that range.
- **Repeated orientation.** Do not call `card`, `status` or `inbox` in a loop or per step; they
  are once-per-session operations.

## Verify

`memai status` (or `{"op":"status"}`) reports corpus size, page/version counts, board state and
the store path. A healthy store prints a token count and a version hash.
