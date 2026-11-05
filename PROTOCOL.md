# MemAi PROTOCOL v1

The contract between the MemAi store and any agent, tool or host adapter that
consumes it (the MCP server, the CLI, the DSH adapter in `adapters/dsh/`, or your
own plugin). If you implement these bytes, you can read/write a MemAi store
without sharing code.

**Design rule: compute locally, send tokens — and never inline what can be
referenced.** The store distils a repository on this machine (0 model tokens),
then hands the model small, content-addressed, budget-clamped pages. File bodies
are materialised only by an explicit `fault`/`get` call.

---

## 1. Token accounting contract

1. Every response has a token count: `tokens` in JSON, `# tokens: N` in text mode.
2. `tokens = ceil(chars / 3.966)`. 3.966 chars/token is calibrated against
   provider-reported usage in real DSH sessions (`tools/calibrate-session.mjs`).
   A host MAY recalibrate for another model and pass it as `--cpt`.
3. `tokens` measures **the payload the model ingests** — the `text` field for
   text-bearing commands, the JSON payload otherwise. Transport framing is free.
4. Every content command accepts `--budget N` (tokens). Responses MUST be clamped
   to at most `N` tokens, cutting on a line boundary and appending
   `… [truncated: K lines / ~M tokens omitted; …]`. `tokens ≤ budget` always.
5. Default budgets: card 700, map 3500, get 1200, fault 600, query 400, diff 600,
   inbox 900. A host plugin SHOULD expose these as tool-argument defaults.
6. Tool-call overhead is real but not stored here. For planning, assume ~45
   tokens per call (schema + args + envelope); a paged answer with 3 calls pays
   ~135 tokens before any page content. Use fewer, larger faults rather than many
   tiny queries.

## 2. Page model

A page is immutable text addressed by content. There are five kinds:

| page id | kind | version hash |
| --- | --- | --- |
| `project.card` | `project.card` | `sha1(EXTRACTOR \| "project.card" \| childHash \| text)` |
| `project.map` | `project.map` | `sha1(EXTRACTOR \| "project.map" \| childHash \| text)` |
| `file:<repo-relative-path>` | `file:<lang>` | `sha1(EXTRACTOR \| "file" \| path \| sha1(file bytes))` |
| `board:<topic>` | `board:<topic>` | `sha1(EXTRACTOR \| "board" \| topic \| message hashes \| edit hashes)` |
| future kinds | — | must follow `sha1(EXTRACTOR \| kind \| children \| text)` |

`childHash` is `sha1(sorted "path:filePageVersion" + EXTRACTOR)` over every
indexed file — a true Merkle tree: file bytes → file page → card/map → project.

**Project version** = `sha1("project" | EXTRACTOR | rootHash)` where `rootHash` is
`sha1(sorted "pageId:versionHash" over every page)`. The full `{pageId:
versionHash}` manifest is persisted with each version. A session starts with a
version hash `H`; `diff --since H` is answered from the manifests alone.

`EXTRACTOR = "x1"` (bump when extraction output changes; it participates in every
hash, so a bump invalidates all page versions and forces re-extraction).

## 3. Store layout (SQLite, WAL)

`<repo>/.memai/mem.db` (override with `--db` / `MEMAI_DB`). Tables: `pages`, `page_history`
(immutable old versions), `page_files`, `files`, `symbols` (fault index),
`imports`, `versions` (manifests), `messages`, `agents`, `edits`, `index_meta`,
and an FTS5 virtual table `fts`.

Writes are idempotent by content hash: re-indexing an unchanged tree is a no-op
(identical project version); posting the same message twice dedupes on
`sha1(topic|agent|kind|body)`.

## 4. CLI / tool surface

Entry point: `memai <command> [args] [--flags]` (`node bin/memai.mjs …` in a
checkout). JSON on stdout, exit 0 on success / 1 on error. Every response
contains:

```json
{ "ok": true, "cmd": "query", "tokens": 57, "budget": 400, "text": "# query …", "...": "…" }
```

`text` is what a host plugin MUST forward to the model; additional fields are for
the plugin/logs. On error: `{ "ok": false, "cmd": "...", "tokens": 0, "error": "..." }`.

| command | arguments | returns (besides `text`/`tokens`) | notes |
| --- | --- | --- | --- |
| `init` | `--root`, `--db` | `root`, `db` | creates the DB only |
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

Global flags: `--root DIR`, `--db FILE`, `--text` (human text with
`# tokens: N` header), `--cpt N`.

Modes accepted by `fault`:
1. `fault <symbol>` — resolves the best-ranked symbol (exact > prefix >
   substring, non-test files preferred) and returns its body slice.
2. `fault <path>#<symbol>` — symbol in a specific file.
3. `fault <path>:<line>` — up to 60 numbered lines from that line.
4. `fault <path>` — the file page (signatures), not the body.

## 5. Agent workflow (normative)

**Session start (once):** `mem card` (~200 tokens). Do not load `map` unless you
need the file inventory; use `query`/`fault` first.

**Locate a symbol/feature:** `mem query <terms>` → read snippets → `mem fault
<best-symbol>` for the body. Stop as soon as the question is answered. Do not
page in whole files to "look around".

**Understand a module:** `mem get file:<path>` for signatures, then `fault` only
the symbols the task needs. One file page is ~10–30% of the full file's tokens.

**Make a change:** `get file:<target>` + `query` for one sibling/example +
`fault` for the touched symbols. This is what "read the files for conventions"
costs when paged.

**Resume after edits:** record the version hash at session end; next session runs
`mem index` (local) then `mem diff --since <hash>` and faults only symbols named by
the delta. A delta is ~100 tokens; re-reading 3 changed files is thousands.

**Share state with other agents:** `note <topic> <body> --agent <id>` (or `post`
for broadcast), `inbox <agent>` to consume. Never send file bodies through
messages — send `pageId`/`symbol` references; the reader pages them if needed.
`merge board:<topic>` publishes the topic as a shared page for `get`.

**Before you write prose:** a summary costs output tokens *and* a re-read. Post a
`board:` note or a `diff` reference instead. Output tokens cost 200× a
cache-hit token at deepseek-flash off-peak prices.

## 6. Delta format (stable enough to parse line-wise)

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

## 7. Board semantics

- Topics are free-form: `handoff`, `board`, `review:<module>`, `<task>-status`.
- Messages are append-only and ordered by `seq` (global, gap-free).
- `inbox` returns messages with `seq > cursor`; the cursor is per agent and
  advances only when messages are returned (use `--no-advance` for peeking).
- `edit` stages a copy-on-write delta against a `board:<topic>` page. It does not
  mutate the current version. `merge` assembles messages + pending edits into a
  new board page version and marks edits merged.
- Corpus pages (`project.*`, `file:*`) are **immutable** from an agent's point of
  view. `merge` refuses them; re-indexing is the only writer.

## 8. When NOT to page (from the measured benchmark)

- One file under ~300 tokens (~1.2 KB) and one symbol: plain `read` is cheaper
  than card + fault.
- A single query costs ~65 tokens (content + tool overhead). Many small queries
  lose to one full read; batch with `map`/`get` or ask directly.
- `fault` requires an indexed symbol. If your target is a line range or a
  non-source file, use `fault <path>:<line>` / `read`.
- The index can be stale: `fault` reads the file from disk but line numbers and
  symbols come from the index. Re-index after edits (cheap, local) or pass
  `path:line` for exact context.

## 9. Host-adapter specification (implemented: `adapters/dsh/`, `mcp/`)

An adapter needs no changes to this store. The shipped implementations are the
stdio MCP server (`mcp/server.mjs`) and the DSH Cordis bundle (`adapters/dsh/`);
this section is the contract either can be rebuilt against.

**Tool surface.** One tool named `mem`, with an `op` enum — extra tools are
schema tokens paid on every request, so the default is one:

| `op` | arguments | when |
| --- | --- | --- |
| `card` | `{}` | session start, once |
| `status` | `{}` | diagnostics, staleness |
| `map` | `{ budget?: int <= 3500 }` | need the file inventory |
| `query` | `{ query: string, k?: int <= 8 }` | locate symbols/features |
| `fault` | `{ target: string, budget?: int <= 1200 }` | one body slice |
| `get` | `{ id: string, budget?: int <= 1200 }` | a file/board/card page |
| `diff` | `{ since: string }` | new-session resume |
| `note` / `post` | `{ topic: string, body: string }` | publish to the shared board |
| `inbox` | `{ since?: int }` | consume the shared board |
| `index` | `{ maxFiles?: int, force?: bool }` | after checkouts/edits |

Clients that prefer per-command tools can set `MEMAI_GRANULAR_TOOLS=1` to expose
the eleven `mem_*` tools instead. Each result forwards `text` (never the JSON
envelope's raw bytes) and reports `tokens`.

**Prompt injection.** Give the model a byte-stable block whose volatile part is
the card text only: `card` (~200 tokens) + the "never inline what can be
referenced / read only after a fault" rules. If the corpus did not change the
bytes do not change, so provider prefix caching can hit. For subagents, add the
parent's version hash so the child can `diff --since`.
- DSH: `systemPrompt.section` for the static rules and a required
  `systemPrompt.context` for the card — reaches every in-process agent, deduped
  and append-only.
- Claude Code: a `SessionStart`/`SubagentStart` command hook that runs
  `memai hook card` and returns `hookSpecificOutput.additionalContext`.
- Agents without hooks: put the same block in `CLAUDE.md` / `AGENTS.md` and let
  the first tool call be `mem {op:"card"}`.

**Lifecycle:** `index` lazily on the first tool call if the store is missing or
HEAD/mtime is newer than `last_index`; never on every call. Run `index` in the
background on checkout/merge events.

**Storage:** `--db <workspace>/.memai/mem.db` (or `MEMAI_DB`); the DB is per
workspace, written by one process at a time. Do not put it inside `node_modules`
or a synced folder.

**Tool result shaping:** return `{ content: [{ type: 'text', text: result.text }] }`
plus `metadata: { tokens, pageId, version }` where the host supports it.

## 10. Failure modes

- Symbol extraction is regex-based: dynamic/one-line constructs may not appear
  as symbols (`fault <path>:<line>` and `read` are the fallback).
- Non-source files (HTML/CSS/images) have pages with no symbols; `fault <path>`
  returns the file page.
- Budgets are estimates (±1 token rounding); host wrappers must not add their own
  prose between pages.
- The board is single-store: agents on different machines need a shared DB path
  or a future sync layer (out of scope for v1).
