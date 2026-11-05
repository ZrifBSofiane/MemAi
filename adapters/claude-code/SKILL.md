---
name: memai
description: Read and navigate this repository through the MemAi paged memory store instead of re-reading files. Use at the start of a task in a repository with a .memai/ store, when you need orientation (stack, commands, entrypoints), when locating a symbol or feature, or when resuming work after edits.
---

# MemAi — paged project memory

MemAi is a local, token-budgeted index of this repository (`<repo>/.memai/mem.db`, SQLite, no
network). One `mem` MCP tool (or the `memai` CLI) serves small pages on demand. Prefer it over
re-reading files, and never inline content that can be referenced.

## Contract

- MCP tool: `mem` with an `op` enum. Full name in Claude Code: `mcp__memai__mem`.
- CLI fallback if MCP is unavailable: `memai <op> ...` with the same operations in kebab case.
- Every reply is budget-clamped and starts with a token count. Default budgets are already
  tuned; only lower them for a cheap peek.
- Do NOT use MemAi for a single file under ~1.3 KB (~346 tokens): a plain `Read` is cheaper.

## Recommended flow

1. **Session start (once):** `{"op":"card"}` (~200 tokens) — stack, build/test/lint commands,
   entrypoints, conventions, paging protocol. A `SessionStart` hook may already have injected it;
   if the card is in context, skip this call.
2. **Locate:** `{"op":"query","q":"auth token verify"}` → ranked symbols/files with snippets.
3. **Read one slice:** `{"op":"fault","target":"verifyToken"}` (or `"src/auth.js:120"` for a line
   range, or `"src/auth.js#verifyToken"`). Prefer one larger `fault` over many tiny ones.
4. **Understand a file's surface:** `{"op":"get","pageId":"file:src/auth.js"}` → signatures only
   (~10–30% of the file), then fault the symbols the task touches.
5. **Resume after edits:** `{"op":"diff","since":"<version>"}` — added/changed/removed pages without
   bodies. Re-index locally with `{"op":"index"}` (0 model tokens) after edits.
6. **Share state:** `{"op":"note","topic":"handoff","body":"..."}` and `{"op":"inbox","agent":"me"}`.
   Send page ids and symbol names, never file bodies.

## Budgets

| op | default | max | use |
| --- | --- | --- | --- |
| card | 700 | 1500 | once per session |
| map | 3500 | 3500 | only to enumerate the repo |
| query | 400 | 1200 | locate, never to read |
| fault | 600 | 2500 | the default way to read code |
| get | 1200 | 4000 | signatures of one file/page |
| diff | 600 | 1500 | new session / resume |
| inbox | 900 | 2000 | board messages |

## CLI equivalents

```sh
memai card
memai query "verify token" && memai fault verifyToken --budget 400
memai get file:src/auth.js
memai diff --since <version>
memai index          # after edits, local only
memai note handoff "auth refactor half done; see file:src/auth.js"
```
