---
name: memai
description: Use MemAi's paged memory in a repository with a .memai store instead of re-reading files. Trigger for orientation (stack, build/test commands, entrypoints), locating a symbol or feature, reading one function body or line range, or resuming after edits in a new session. Skip it for a single small file (under ~1.3 KB): a plain read is cheaper.
license: MIT
compatibility: Requires a project with a MemAi store (`memai init`, Node >= 22.13) and either the `mem` MCP tool or the `memai` CLI on PATH. Local-only; no network. Works in Agent Skills clients including Claude Code, OpenCode, Codex, ZCode, DSH and generic SKILL.md hosts.
metadata:
  version: "0.1.1"
  docs: https://github.com/ZrifBSofiane/MemAi
  pager: .memai/mem.db
---

# MemAi — paged project memory

MemAi indexes this repository locally into `.memai/mem.db` (SQLite, zero model tokens, no
network). It serves small, budget-clamped pages on demand. One call returns the page you need;
the alternative is reading whole files into context.

## Use MemAi when

- You are starting work in this repository and need orientation: stack, commands, entrypoints,
  conventions. One `card` call (~200 tokens) covers it.
- You know what you are looking for but not where it is: `query` finds symbols and paths.
- You need one function, method or line range: `fault` returns just that slice.
- You want a file's surface without its body: `get file:<path>` returns signatures.
- You are resuming after edits or in a new session: `diff --since <version>` lists what changed.
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
3. **Page.** Fetch one slice:
   - `{"op":"fault","target":"verifyToken"}` — one symbol body.
   - `{"op":"fault","target":"src/auth.js:120"}` — one line range.
   - `{"op":"get","pageId":"file:src/auth.js"}` — signatures for a whole file.
   CLI equivalents: `memai fault verifyToken`, `memai get file:src/auth.js`.
4. **Resume.** With a version hash from the last session: `{"op":"diff","since":"<version>"}`
   (CLI `memai diff --since <version>`). Re-index locally after edits with `{"op":"index"}` or
   `memai index` (no model tokens).
5. **Share.** `{"op":"note","topic":"handoff","body":"auth move: see file:src/auth.js"}`,
   `{"op":"post",...}`, `{"op":"inbox","agent":"<id>"}`; CLI `memai note/post/inbox`.

If MCP is unavailable, every step has a CLI equivalent. If the CLI is unavailable but MCP is
not, use the tool. Do not mix two stores.

## Budget discipline

- Every reply starts with a token count and is clamped to a budget.
- Defaults are tuned: card 700, map 3500, get 1200, fault 600, query 400, diff 600, inbox 900.
- Lower a budget (`"budget": 300`, `--budget 300`) for a cheap peek; raise it only when the
  previous page was truncated and the rest is genuinely needed.
- Prefer one larger `fault` over many tiny `query` calls. Stop when the question is answered.
- Never inline what can be referenced: send page ids and symbol names in notes, not bodies.

## Pitfalls

- **Stale index.** Pages and line numbers come from the last `index`. After edits, checkouts or
  branch switches, run `{"op":"index"}` / `memai index` before trusting `get`/`query`; for a
  precise line range prefer `fault path:line`, which reads the current file.
- **No store.** `card`, `get` and `diff` fail until `memai init` (or `{"op":"index"}`) has run.
  Run the init once in the repository root; it is local and idempotent.
- **Wrong root.** If the tool reports a store from another directory, set `MEMAI_ROOT` or pass
  `--root`. MCP servers should be started from the project root.
- **Whole-file reads despite a fault.** Do not fall back to reading the file before trying
  `fault`; try the symbol first, then read only if the slice was truncated or insufficient.
- **Repeated orientation.** Do not call `card`, `status` or `inbox` in a loop or per step; they
  are once-per-session operations.
- **Large repos.** `map` is the most expensive page; prefer `query` when you can name the target.

## Verify

`memai status` (or `{"op":"status"}`) reports corpus size, page/version counts, board state and
the store path. A healthy store prints a token count and a version hash.
