# Security

MemAi is a **local** tool. It reads the repository you point it at, writes a
SQLite store under `.memai/` in that repository, and serves pages over stdio to
an agent you already run. It makes no network calls, has no dependencies, and
collects no telemetry.

## Reporting a vulnerability

Please do **not** open a public issue for a security bug. Use GitHub's private
vulnerability reporting on the repository (Security → Report a vulnerability),
or contact the maintainers listed in `package.json`. We aim to acknowledge
reports within a week.

## What you should know

- **The store contains your source code.** `.memai/mem.db` holds distilled file
  content, symbols and snippets. It is git-ignored by default, but treat it like
  the source tree itself: do not copy it to shared drives or attach it to bug
  reports. Delete `.memai/` to remove it.
- **Secrets in files can reach the store.** If a secret is committed in the
  working tree, it can be indexed like any other text. Keep secrets out of the
  tree (`.env` files, credentials) and out of `memai note` bodies. `memai` does
  not attempt to detect secrets; that is the repository's job.
- **Instruction blocks and the shared board are agent input.** Pages and board
  messages are fed to a model, so treat content written by another agent (or
  pasted from an untrusted source) as untrusted data. The MCP server does not
  execute page content; it only returns text.
- **The MCP server trusts its caller.** `memai-mcp` is a stdio server: anything
  that can spawn it can read and write the store. It deliberately has no
  authentication. Do not expose it over a network socket.
- **Hooks and instruction blocks are agent input.** `memai init` writes an
  instruction block into `CLAUDE.md`/`AGENTS.md` and may merge an MCP entry and a
  `SessionStart` hook into project config. The hook runs a command you configured
  (`memai hook card`); review it like any other shell command. The hook is
  read-only: it opens the store, reads the card, and never indexes or creates
  files.
- **What `memai init` writes.** `.memai/` (store + `configs/`), the marked block
  in `CLAUDE.md`/`AGENTS.md`, and — only with `--write-configs` — the `memai`
  entry in `.mcp.json`/`opencode.json`. It never rewrites source files and is
  idempotent. Delete `.memai/` and the marked blocks to remove it.
- **`--root` follows the directory you already trust.** Like any CLI, `memai`
  reads files under the root you pass it. Do not point it at directories you do
  not trust to be parseable (regex extraction is bounded, but large or hostile
  files are still work).
- **No credential handling.** MemAi never asks for, stores, or forwards API keys
  or session credentials. If you see otherwise, treat it as a compromise of your
  local setup, not of this project.

## Supported versions

Security fixes target the latest release on the default branch. The project is
pre-1.0; pin a commit or version if you need stability.
