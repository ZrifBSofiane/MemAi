# MemAi — Codex adapter

Codex has no hook mechanism for injecting session context, so this adapter is two static pieces:
an MCP server entry and an `AGENTS.md` instruction block.

| Piece | File here | Copy/merge to |
| --- | --- | --- |
| MCP server | `config.toml` | append to `~/.codex/config.toml` (global) |
| Instructions | `AGENTS.md` | `AGENTS.md` at the repo root (or a parent directory) |

`npx -y memai-cli init --agent codex` writes the store, the `AGENTS.md` block and a ready
`codex-config.toml` snippet under `.memai/configs/`.

## MCP registration

```toml
[mcp_servers.memai]
command = "npx"
args = ["-y", "-p", "memai-cli", "memai-mcp"]
```

Optional: `env = { MEMAI_ROOT = "/absolute/path/to/project" }` when the MCP client's cwd is not the
repository (the server otherwise resolves the root from `MEMAI_ROOT`, then the nearest
`.git`/`.memai` ancestor, then cwd).

After editing, restart Codex and check the server is listed (per Codex docs, `/mcp` in the TUI lists
configured servers and their status).

## Instructions

Codex reads `AGENTS.md` from the repository root (and files in parent directories). The block in
this directory's `AGENTS.md` is the instruction text; `memai init` writes an equivalent block with
`<!-- memai:start -->` / `<!-- memai:end -->` markers, so copy only one of the two.

Docs: https://developers.openai.com/codex/guides/agents-md

## Skill (Agent Skills)

Codex scans the shared Agent Skills root (cwd upward) and `~/.agents/skills`; the canonical
[`../../skills/memai/SKILL.md`](../../skills/memai/SKILL.md) is installed there by
`memai skill install --agent codex` (or by `memai init`, which does it by default). No copy of the
skill lives in this adapter. Docs: https://developers.openai.com/codex/skills

## Config reference

- MCP: https://developers.openai.com/codex/mcp
- Config keys: https://developers.openai.com/codex/config-reference
- The repo's own pointer docs: https://github.com/openai/codex/blob/main/docs/config.md and
  https://github.com/openai/codex/blob/main/docs/agents_md.md

## Verification status

**Documented, not verified on this machine** — `codex` is not installed here, so the keys above
come from the official docs and the `openai/codex` repository (not from a live config parse). The
MCP server itself is the same binary verified through Claude Code and OpenCode; only Codex's config
loader is unverified. If your Codex version rejects `mcp_servers`, fall back to the CLI workflow in
`../generic/README.md`.

Codex also documents lifecycle hooks for administrators (`allow_managed_hooks_only` in
`requirements.toml`); this adapter does not use them because no stable user-facing
"inject context at SessionStart" hook is documented.
