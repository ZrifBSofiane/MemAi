# Protocol (v1)

This document is the readable, product-level version of the memai page protocol.
The normative contract — the one other implementations should match byte-for-byte
— is the root [`PROTOCOL.md`](../PROTOCOL.md). If the two disagree, the root file
wins; please open an issue.

**Design rule: compute locally, send tokens — and never inline what can be
referenced.** A MemAi store distils a repository on the local machine (0 model
tokens), then hands the model small, content-addressed, budget-clamped pages.
File bodies are materialised only by an explicit `fault`/`get` call.

## 1. Token accounting

1. Every response has a token count: `tokens` in JSON, `# tokens: N` in text mode.
2. `tokens = ceil(chars / 3.966)`. That constant is calibrated against
   provider-reported usage in real harness sessions. A host may recalibrate for
   another model and pass it as `--cpt N`.
3. `tokens` measures **the payload the model ingests** — the `text` field for
   text-bearing commands, the JSON payload otherwise. Transport framing is free.
4. Every content command accepts `--budget N` (tokens). Responses are clamped to
   at most `N` tokens, cutting on a line boundary and appending
   `… [truncated: K lines / ~M tokens omitted; …]`. `tokens ≤ budget` always.
5. Default budgets: card 700, map 3500, get 1200, fault 600, query 400, diff 600,
   inbox 900. Hosts should expose these as tool-argument defaults.
6. Tool-call overhead is real but not stored here. For planning, assume ~45 tokens
   per call (schema + arguments + envelope). Use fewer, larger faults rather than
   many tiny queries.

## 2. Page model

A page is immutable text addressed by content. Page kinds:

| page id | kind | version hash |
| --- | --- | --- |
| `project.card` | `project.card` | `sha1(EXTRACTOR \| "project.card" \| childHash \| text)` |
| `project.map` | `project.map` | `sha1(EXTRACTOR \| "project.map" \| childHash \| text)` |
| `file:<repo-relative-path>` | `file:<lang>` | `sha1(EXTRACTOR \| "file" \| path \| sha1(file bytes))` |
| `board:<topic>` | `board:<topic>` | `sha1(EXTRACTOR \| "board" \| topic \| message hashes \| edit hashes)` |
| future kinds | — | must follow `sha1(EXTRACTOR \| kind \| children \| text)` |

`childHash` is `sha1(sorted "path:filePageVersion" + EXTRACTOR)` over every indexed
file — a true Merkle tree: file bytes → file page → card/map → project.

**Project version** = `sha1("project" | EXTRACTOR | rootHash)` where `rootHash` is
`sha1(sorted "pageId:versionHash" over every page)`. The full
`{pageId: versionHash}` manifest is persisted with each version. A session starts
with a version hash `H`; `diff --since H` is answered from the manifests alone.

`EXTRACTOR` is a version string (currently `x1`); bump it when extraction output
changes. It participates in every hash, so a bump invalidates all page versions
and forces re-extraction.

## 3. Store layout

SQLite, WAL mode, at `<repo>/.memai/mem.db` (override with `--db`). Tables:
`pages`, `page_history` (immutable old versions), `page_files`, `files`,
`symbols` (fault index), `imports`, `versions` (manifests), `messages`, `agents`,
`edits`, `index_meta`, and an FTS5 virtual table over page text and symbols.

Writes are idempotent by content hash: re-indexing an unchanged tree is a no-op
(identical project version); posting the same message twice dedupes on
`sha1(topic|agent|kind|body)`.

One writer, many readers. The store is per workspace and must not live inside
`node_modules` or a synced folder.

## 4. CLI surface

Entry point: `memai <command> [args] [--flags]` (from a checkout,
`node bin/memai.mjs …`; the binary pins the store to `<root>/.memai/mem.db` and
forwards one explicit root/db to every command). JSON on stdout, exit 0 on
success / 1 on error. Every response contains:

```json
{ "ok": true, "cmd": "query", "tokens": 57, "budget": 400, "text": "# query …", "...": "…" }
```

`text` is what a host must forward to the model; additional fields are for the
host/logs. On error:
`{ "ok": false, "cmd": "...", "tokens": 0, "error": "..." }`.

| command | arguments | returns (besides `text`/`tokens`) | notes |
| --- | --- | --- | --- |
| `init` | `--root`, `--db`, `--agent`, `--write-configs`, `--md` | `root`, `db`, files changed | creates `.memai/` + instruction blocks/configs |
| `index` | `--max-files`, `--force` | corpus stats, `version`, `card`, `map`, `readFiles`, `elapsedMs` | local CPU/disk only, 0 model tokens |
| `status` | — | corpus stats, page/version/board counts, latest version | cheap orientation |
| `card` | `--budget` | `version`, `truncated` | load once per session |
| `map` | `--budget` | `version`, `truncated` | one line per file + top symbols |
| `diff` | `--since <hash>`, `--budget` | `from`, `to`, `added[]`, `changed[]`, `removed[]` | tiny resume delta |
| `get` | `<pageId>`, `--budget` | `pageId`, `kind`, `version` | full page (file/board/card/map) |
| `query` | `<terms…>`, `--k`, `--budget` | `hits[]` (`pageId`, `path`, `symbol`, `line`, `snippet`, `score`) | ranked snippets, no bodies |
| `fault` | `<sym>`, `<path>#<sym>`, `<path>:<line>`, `<path>` | `mode`, `symbol`, `path`, `line`, `lines`, `also[]` | demand-pages one slice |
| `note` | `<topic> <body…>` `--agent` | `seq`, `deduped` | append-only board post |
| `post` | same as note | `seq`, `deduped` | broadcast kind |
| `inbox` | `<agent>` `--since N` `--topic T` `--no-advance` | `from`, `to`, `messages[]` | advances the agent's read cursor |
| `agents` | — | `agents[]` (`id`, `status`, `read_seq`, `last_seen`) | presence |
| `edit` | `<pageId> <body…>` `--agent` | `id`, `deduped` | stage a COW delta |
| `merge` | `<pageId>` `--agent` | `version`, `topic`, `messages`, `editsMerged`, `changed` | rebuild a `board:` page |
| `hook card` | `--root` | hook JSON on stdout | session-start injection payload |

Global flags: `--root DIR`, `--db FILE`, `--text` (human text with
`# tokens: N` header), `--cpt N`.

`fault` modes:

1. `fault <symbol>` — best-ranked symbol (exact > prefix > substring, non-test
   files preferred), returns its body slice.
2. `fault <path>#<symbol>` — that symbol in that file.
3. `fault <path>:<line>` — up to 60 numbered lines from that line.
4. `fault <path>` — the file page (signatures), not the body.

## 5. MCP mapping

`memai-mcp` (or `node bin/memai-mcp.mjs`, or `memai mcp`) speaks JSON-RPC 2.0
over newline-delimited stdio and exposes the same surface. Logs go to stderr
only; stdout is protocol bytes exclusively. `initialize` returns `instructions`
(a short per-session contract), `tools`, `resources` and `prompts`
capabilities, and the negotiated `protocolVersion`.

**Default surface: one `mem` tool.** Arguments are
`{ op: "index"|"status"|"card"|"map"|"query"|"get"|"fault"|"diff"|"note"|"post"|"inbox", … }`
with `q`, `target`, `pageId`, `since`, `topic`, `body`, `agent`, `k`, `budget`
as the op requires. One schema keeps the billed tool block small; the server
rejects an `op`/argument combination it cannot dispatch.

**Opt-in: 11 granular tools.** With `MEMAI_GRANULAR_TOOLS=1` the server exposes
`mem_index`, `mem_status`, `mem_card`, `mem_map`, `mem_query`, `mem_fault`,
`mem_get`, `mem_diff`, `mem_note`, `mem_post`, `mem_inbox` instead — useful for
hosts that cannot dispatch on `op`, for benchmarks, and for compatibility tests.
Each returns `content: [{type: "text", text}]` plus `isError` on failure; the
text is the core envelope's `text` field, so token counts travel with it.

**Resources and prompts.** Pages are readable without a tool call:
`memai://card`, `memai://map`, `memai://status`, and
`memai://page/<url-encoded-page-id>` (plus `memai://file/<path>` as a shortcut).
Prompts expose an "onboard me" payload that works even before a store exists.

Protocol versions `2024-11-05`, `2025-03-26` and `2025-06-18` are accepted at
`initialize`; the requested version is echoed when supported, otherwise the
latest (`2025-06-18`) is returned per the MCP lifecycle rules.

## 6. Agent workflow (normative)

**Session start (once).** `memai card` (~200 tokens). Do not load `map` unless you
need the file inventory; use `query`/`fault` first.

**Locate a symbol/feature.** `memai query <terms>` → read snippets → `memai fault
<best-symbol>` for the body. Stop as soon as the question is answered. Do not page
in whole files to "look around".

**Understand a module.** `memai get file:<path>` for signatures, then `fault` only
the symbols the task needs. One file page is ~10–30% of the full file's tokens.

**Make a change.** `get file:<target>` + `query` for one sibling/example + `fault`
for the touched symbols.

**Resume after edits.** Record the version hash at session end; next session runs
`memai index` (local) then `memai diff --since <hash>` and faults only symbols
named by the delta. A delta is ~100 tokens; re-reading 3 changed files is
thousands.

**Share state with other agents.** `note <topic> <body> --agent <id>` (or `post`
for broadcast), then `inbox <agent>`. Never send file bodies through messages —
send page ids/symbol references; the reader pages them if needed. `merge
board:<topic>` publishes the topic as a shared page for `get`.

**Before you write prose.** A summary costs output tokens *and* a re-read. Post a
board note or a diff reference instead. At deepseek-flash off-peak prices one
output token costs 200× a cache-hit input token.

## 7. Delta format (stable enough to parse line-wise)

```
# delta <to8> since <from8>  (+A added, ~C changed, -R removed)
aggregate: project.card, project.map rebuilt (do not re-read; the map is the delta)
+ <added path>
- <removed path>
~ <changed path>  <tokens>tok  +sym:<names>  -sym:<names>
# next: get file:<path> for signatures | fault <symbol> for a body slice
```

`aggregate:` lines mean the aggregate pages changed but their content is derivable
from the changed file pages — never page the whole map to learn a delta.

## 8. Board semantics

- Topics are free-form: `handoff`, `board`, `review:<module>`, `<task>-status`.
- Messages are append-only and ordered by `seq` (global, gap-free).
- `inbox` returns messages with `seq > cursor`; the cursor is per agent and
  advances only when messages are returned (`--no-advance` peeks).
- `edit` stages a copy-on-write delta against a `board:<topic>` page. It does not
  mutate the current version. `merge` assembles messages + pending edits into a
  new board page version and marks edits merged.
- Corpus pages (`project.*`, `file:*`) are **immutable** from an agent's point of
  view. `merge` refuses them; re-indexing is the only writer.

## 9. When NOT to page

- One file under ~300 tokens (~1.2 KB) and one symbol: plain `read` is cheaper
  than card + fault.
- A single query costs ~65 tokens (content + tool overhead). Many small queries
  lose to one full read; batch with `map`/`get` or ask directly.
- `fault` requires an indexed symbol. If your target is a line range or a
  non-source file, use `fault <path>:<line>` / `read`.
- The index can be stale: `fault` reads the file from disk but line numbers and
  symbols come from the index. Re-index after edits (cheap, local) or pass
  `path:line` for exact context.

## 10. Failure modes

- Symbol extraction is regex-based: dynamic/one-line constructs may not appear as
  symbols (`fault <path>:<line>` and `read` are the fallback).
- Non-source files (HTML/CSS/images) have pages with no symbols; `fault <path>`
  returns the file page.
- Budgets are estimates (±1 token rounding); host wrappers must not add their own
  prose between pages.
- The board is single-store: agents on different machines need a shared DB path
  or a sync layer (out of scope for v1).
