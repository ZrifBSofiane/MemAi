# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-11-17

### Fixed

- **Fault pages could collapse to a header-only stub.** For symbols whose clamped body
  could not shrink by less than one line (~5-15 tokens of granularity), the budget
  loop stalled at ~602 tokens for four iterations and fell through to the
  header-only fallback — serving 28 of 600 tokens for dense 80+ line functions.
  The loop now overshoots proportionally (1.2x the excess, bounded by line
  granularity) and, on exhaustion, serves the closest attempt: a few percent
  over budget beats losing the entire body.

## [0.2.0] — 2026-11-16

Staleness made visible, then made impossible; hybrid retrieval; deeper faults.

### Added

- **Serve-time staleness flags** — `query`, `get`, `card`, `map` and `fault`
  now compare the store against disk on every serve and say so when they lie:
  `stale` fields on hits/replies, `[STALE]` markers in text, a
  `[STALE: N changed, M missing of K files — re-run index]` header on card/map.
  File pages are hash-checked; the corpus-wide sweep is stat-only
  (mtime+size). `--no-stale` / `MEMAI_NO_STALE=1` disables.
- **`memai watch`** — a resident daemon that keeps the store fresh by watching
  the working tree (`fs.watch` recursive). Single-file incremental distils
  after an 800 ms debounce; bursts >50 paths (branch switches, builds) fall
  back to one full index pass, which reuses unchanged files anyway. `.memai/**`
  is always ignored (no feedback loop), per-file errors go to
  `.memai/watch.log`, the pidfile lifecycle supports `--ensure` (lazily spawn
  detached; safe in a SessionStart hook), `--stop` and `--status` (one JSON
  line). The watcher never creates a store and exits when the project vanishes.
- **`memai hook index`** — a PostToolUse hook (`Edit|Write|MultiEdit`): reads
  the Claude-style `{tool_name, tool_input:{file_path}}` payload from stdin,
  discovers the owning project by walking up from the file, and distils exactly
  that file. Silent, exit 0 always — re-indexing can no longer be forgotten.
  `memai init`'s generated ZCode config (`adapters/zcode/config.json`,
  `.memai/configs/zcode-config.json`) wires both hooks.
- **`query --rg`** — unions a ripgrep sweep over file bodies with the ranked
  index hits (rg honors .gitignore, 5 s timeout, smart-case). Catches exactly
  what the signature-only index cannot page; `kind: "text"` hits, and
  degradation (rg missing / timeout) is a note, never an error. Exit code 2
  with partial stdout still parses its matches (unreadable-file noise).
- **`fault --deep`** — one-hop context appended to the slice within the same
  budget: callees (identifiers of the slice that are known code symbols) and
  best-effort callers (declaration lines mentioning the name). Structured
  `deep: {callees, callers}` on the reply.
- **`memai miss "<query>"` / `miss --stats`** — a recall log: record that a
  lookup failed here and what found it instead (`--found-by rg|grep|manual
  --path p`); stats give totals, top missed queries and the per-tool breakdown.
  Retrieval misses stop being invisible.
- **`--read-only` / `MEMAI_READONLY=1`** — the core CLI opens the store
  read-only: no store creation on read paths (the old write-on-read hazard),
  clean `no MemAi store at <path>; run memai init` error.
- **`lineEnd` on fault replies** — symbol and line faults now report the exact
  structured range (`path`, `line`, `lineEnd`; header `path:start-end`), so an
  agent can read exactly the reported slice with a bounded file read.

### Changed

- **Incremental indexing internals** — the per-file loop of `indexCorpus` was
  extracted into `distilFile`, the shared card/map/manifest tail into
  `finalizeIndex` (fed by `buildRecordsFromStore`, no disk reads), and new
  `indexFiles(store, {root, paths})` distils exactly the given paths without
  listing the tree. Full-index output is byte-identical to 0.1.x (verified by
  a version-hash oracle); `indexFiles` after mutations converges to the same
  project version as a full re-index.
- **MCP surface** — `op` gains `miss`; `query` accepts `rg`, `fault` accepts
  `deep`; staleness flags flow through `page.mjs` to every surface for free.
  The granular surface gains `mem_miss`.

### Fixed

- **The ESM/CJS card conventions never fired.** `readConfigInfo` read
  `looksEsm`/`looksCjs` off store rows — fields that only ever existed on
  in-memory records — so the line was dead since 0.1.0. Both flags are now
  persisted on the `files` table at distil time (additive migration for
  existing stores), reconstructed by `buildRecordsFromStore`, and
  `readConfigInfo` consumes the records. Pure-ESM repos now get
  `ES module imports (import/export)`, pure-CJS repos get
  `CommonJS (require/module.exports)`; mixed and non-JS repos intentionally
  stay silent. Card hashes change only for repos where the line appears.

## [0.1.1] — 2026-11-06

Portable Agent Skills package + `memai skill` installer.

### Added

- **One portable skill** — [`skills/memai/SKILL.md`](skills/memai/SKILL.md) in
  standard Agent Skills format (`name`, `description`, `license`,
  `compatibility`, `metadata` string map only; no provider-specific fields, so
  strict clients accept it unchanged). The body covers when MemAi wins vs a plain
  file read (measured ~346-token / ~1.3 KB break-even), the card → query → fault
  → get → diff workflow, the `mem` MCP tool **and** the `memai` CLI fallback,
  token-budget discipline and the common pitfalls.
- **`memai skill install|list|status`** — installs the canonical skill into the
  two roots agents actually scan: `.agents/skills/memai/SKILL.md` (Codex,
  OpenCode, ZCode, DSH, Cursor, Gemini CLI, generic SKILL.md hosts) and
  `.claude/skills/memai/SKILL.md` (Claude Code — its only project skill root —
  also read by OpenCode and Cursor). Flags: `--agent
  all|claude|codex|opencode|zcode|dsh|generic`, `--global` (`~/.agents/skills`,
  `~/.claude/skills`), `--link` (symlink/junction, copy fallback), `--force`.
  Content-hash idempotent (re-runs report `unchanged`); a differing `memai`
  skill directory is never overwritten without `--force`.
- **`memai init` installs the skill by default** and reports it in the summary;
  `--no-skill` skips it. Init re-runs stay idempotent.
- **`test/skill.test.mjs`** — frontmatter portability, both install roots,
  per-agent aliases, idempotency, `--force` conflict handling, `--link`,
  `--global` with a HOME override, `list`/`status` output, and the init
  integration (`node --test "test/*.test.mjs"` now covers 42 tests).

### Changed

- Adapters no longer duplicate the skill: `adapters/claude-code/SKILL.md` is
  removed and every adapter README points at `skills/memai/` as the single
  source of truth; the config snippets are unchanged.
- Docs: README gains a "Skills — one file, every agent" section;
  [`docs/install.md`](docs/install.md) documents per-agent skill roots, global
  scope, optional fallback roots and verification (Claude Code `/skills`,
  OpenCode `<available_skills>`, DSH catalog);
  [`docs/compatibility.md`](docs/compatibility.md) gains an Agent Skills matrix
  with vendor doc links and the live Claude Code discovery evidence.
- `package.json`: version `0.1.1`, `files` now ships `skills/`.

## [0.1.0] — 2026-11-05

First public preview.

### Added

- **Paged memory store** — SQLite (WAL) page store with content-addressed,
  Merkle-versioned pages, an FTS5 symbol index, and idempotent writes.
  `src/store.mjs`, `src/page.mjs`, `src/extract.mjs`, `src/tokens.mjs`.
- **Deterministic extraction** — `git`-aware file discovery plus regex symbol,
  import and command extraction for JS/TS, Python, Go, Rust, Java, C#, JSON,
  YAML and Markdown. Emits `project.card`, `project.map` and `file:<path>` pages.
  Zero model tokens, no dependencies.
- **Demand paging** — `card`, `map`, `get`, `query`, `fault`, `diff`, plus a
  shared append-only board (`note`, `post`, `inbox`, `edit`, `merge`). Every
  response is token-counted and clamped to a hard budget.
- **CLI** — `memai <command>` and the repo-local `node src/cli.mjs <command>`;
  JSON on stdout, `--text` for humans, `--root`/`--db`/`--budget` overrides.
- **MCP stdio server** — `memai-mcp` (also `node mcp/server.mjs`) exposes the
  pager as MCP tools and resources for any MCP-capable agent. JSON-RPC over
  newline-delimited stdio; logs go to stderr only.
- **`memai init`** — one command creates `.memai/`, writes idempotent instruction
  blocks (`<!-- memai:start -->` … `<!-- memai:end -->`) into `CLAUDE.md` /
  `AGENTS.md`, and drops ready-to-paste MCP config snippets per agent.
- **Adapters** — Claude Code (`.mcp.json`, `SessionStart` hook, skill), Codex
  (`config.toml`, `AGENTS.md`), OpenCode (`opencode.json`), ZCode, a generic MCP
  fallback, and an experimental DeepSeek Harness host plugin (`adapters/dsh/`).
- **Docs and examples** — [`docs/install.md`](docs/install.md) per-agent setup,
  [`docs/compatibility.md`](docs/compatibility.md) (verified vs documented),
  copy-ready [`examples/`](examples/), plus the design/evidence/FAQ/protocol
  pages.
- **Benchmark and evidence** — 14 tasks over four corpora with a reproducible
  harness (`bench/`), a measured write-up (`bench/RESULTS.md`), a session-log
  counterfactual (`docs/evidence.md`), and the design rationale
  (`docs/design.md`).
- **Protocol** — `PROTOCOL.md` (root, normative) and `docs/protocol.md`
  (narrative) describe page kinds, versioning, delta format and the tool
  contract for other implementations.
- **CI** — zero-install workflow on Node 22 and 24: self-test, unit tests, MCP
  syntax check and a live MCP handshake probe.

### Fixed

- **MCP tool surface** — the opt-in granular tools were emitted without a `name`;
  all 11 are now named, and the dispatcher rejects `mem_*` names when the single
  `mem` surface is active.
- **MCP server startup** — no stderr banner unless `MEMAI_DEBUG=1`, so clients
  that log server stderr (Claude Code) see no spurious error lines.
- **`memai hook card`** — prints nothing (empty stdout, exit 0) when no card
  exists yet, exactly the no-op a session-start hook needs.
- **Generated hooks** — hook command paths use forward slashes so the generated
  Claude Code hook works under Git Bash and PowerShell on Windows.
- **`memai init --write-configs`** — merges the OpenCode v2 `mcp.servers.memai`
  shape (and a ZCode `mcp.servers` + process-hook snippet), preserving every
  other key in the target file.

### Notes

- Requires Node.js ≥ 22.13 (the store uses the built-in `node:sqlite` module).
  No native modules, no install step, no network.
- `node:sqlite` is still marked experimental by Node; the warning is filtered so
  CLI JSON stays clean.
- npm package name: `memai-cli`; CLI binary: `memai`; MCP binary: `memai-mcp`.
  The package also installs a `memai-cli` alias so `npx -y memai-cli <command>`
  works without `-p`. The store is `.memai/mem.db`; the root override env is
  `MEMAI_ROOT`.
