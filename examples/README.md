# Examples

Minimal, copy-ready snippets. Regenerate the full set for your repository with
`npx -y memai-cli init --agent all` (it writes them under `.memai/configs/`).

| File | Use |
| --- | --- |
| [`claude-code/.mcp.json`](claude-code/.mcp.json) | Claude Code project-scope MCP config (copy to `.mcp.json`) |
| [`generic/mcpServers.json`](generic/mcpServers.json) | generic `mcpServers` object for Cursor, Cline, Gemini CLI and similar clients |
| [`AGENTS.md`](AGENTS.md) | the instruction block `memai init` maintains in `AGENTS.md` (Codex, OpenCode, ZCode, generic) |

The MCP command is `npx -y -p memai-cli memai-mcp`; the CLI is
`npx -y memai-cli <command>` or `memai <command>` after `npm i -g memai-cli`.
Both resolve the project from the nearest `.git`/`.memai` ancestor; add
`"--root", "/abs/path/to/project"` to the server args if your client starts
processes elsewhere.

Per-agent setup, verification steps and the no-MCP CLI fallback:
[`../docs/install.md`](../docs/install.md).
