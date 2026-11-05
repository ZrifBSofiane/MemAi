# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
