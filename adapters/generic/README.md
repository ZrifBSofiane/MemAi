# MemAi — generic MCP client adapter (and CLI fallback)

For any agent that speaks MCP over stdio but has no dedicated adapter here. The server is one
binary; every client just needs `command` + `args`. Add `--root /abs/path` (or set `MEMAI_ROOT`) if
the client does not launch the server from the repository root — the server otherwise walks up from
its working directory to the nearest `.git`/`.memai`.

```json
{
  "mcpServers": {
    "memai": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "memai-cli", "memai-mcp"]
    }
  }
}
```

(`"type": "stdio"` is accepted by Claude/Cursor-style configs; clients that infer stdio from
`command` can drop it. See `mcpServers.json`.)

## Client-specific locations and keys (documented)

| Client | Config file | Key/shape | Instructions file |
| --- | --- | --- | --- |
| Cursor | `~/.cursor/mcp.json` (global), `.cursor/mcp.json` (project) | `mcpServers.<name>` with `type`, `command`, `args`, `env` | `AGENTS.md` in the repo root/subdirs, or `.cursor/rules/*.mdc` |
| Zed | Zed settings (`zed: open settings file`) | **`context_servers`** (not `mcpServers`): `command`, `args`, `env` | `AGENTS.md` / `.rules` — see Zed docs |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` (override with `CLINE_MCP_SETTINGS_PATH`) | `mcpServers.<name>` with `command`, `args` | `.clinerules` or `AGENTS.md` |
| Gemini CLI | `~/.gemini/settings.json` (user), `.gemini/settings.json` (project) | `mcpServers.<name>` with `command`, `args`, `env`, `cwd`, `timeout`, `trust` | `GEMINI.md` |
| DSH | in-process plugin | see `../dsh/` — no MCP needed | `AGENTS.md` + plugin-injected card |

Docs:

- Cursor MCP: https://cursor.com/docs/mcp — rules/`AGENTS.md`: https://cursor.com/docs/rules
- Zed MCP (`context_servers`): https://zed.dev/docs/ai/mcp
- Cline MCP: https://docs.cline.bot/mcp/mcp-overview
- Gemini CLI MCP: https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
- MCP specification: https://modelcontextprotocol.io

Zed's key is genuinely different (`context_servers`, no top-level `mcpServers`); do not paste the
generic JSON into Zed unchanged. Gemini CLI appends a server's `initialize.instructions` to the
system prompt, so MemAi's paging contract arrives without a tool call.

## No MCP? Use the CLI

Every operation is also a thin CLI over the same store, so any agent with a shell can use MemAi.
Output is JSON by default, with a token count in every reply; pass `--text` for prose.

```sh
npx -y memai-cli init --agent all     # once per repo: store + index + instruction blocks
npx -y memai-cli status               # corpus size, pages, versions, board state
npx -y memai-cli card                 # ~200-token orientation page
npx -y memai-cli map                  # file inventory + top symbols (most expensive page)
npx -y memai-cli query "auth token"   # ranked hits with snippets
npx -y memai-cli fault verifyToken    # one symbol body (or path:line / path#symbol)
npx -y memai-cli get file:src/auth.js # signatures for one file
npx -y memai-cli diff --since <ver>   # resume delta
npx -y memai-cli index                # re-index after edits (local, 0 model tokens)
npx -y memai-cli note handoff "..."   # shared board
npx -y memai-cli inbox me             # board messages since your cursor
```

Budgets: `--budget N` (tokens) on content commands. Note that a shell round-trip per call is
cheaper than a whole-file read only above the measured break-even (~346 tokens / ~1.3 KB of needed
content), so batch commands and prefer one `fault` over several reads.

If the host supports MCP but you cannot edit its config, `memai-mcp` can be launched manually and
driven over JSON-RPC on stdio; `node scripts/mcp-probe.mjs` performs a handshake and prints the
tool list, which is also a quick way to verify the server.

## Verification status

The server and CLI are verified on this machine (MCP handshake and tool calls via
`scripts/mcp-probe.mjs` and `test/mcp.test.mjs`; CLI via `test/init.test.mjs`). The per-client
paths above are **documented** from each vendor's docs and were not executed here because only
Claude Code and OpenCode are installed.
