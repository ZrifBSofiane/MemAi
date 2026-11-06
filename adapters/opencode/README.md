# MemAi — OpenCode adapter

OpenCode v2 reads project rules from `AGENTS.md` only (it does not fall back to `CLAUDE.md`) and
MCP servers from `mcp.servers` in `opencode.json` / `opencode.jsonc` (or
`.opencode/opencode.json(c)`).

| Piece | File here | Copy/merge to |
| --- | --- | --- |
| MCP server | `opencode.json` | `opencode.json` (project) or `~/.config/opencode/opencode.json(c)` (global) |
| Instructions | `AGENTS.md` | `AGENTS.md` at the repo root |

`npx -y memai-cli init --agent opencode --write-configs` merges the `memai` server into the project
`opencode.json` and writes the `AGENTS.md` block.

## MCP registration (verified shape, OpenCode v2)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "memai": {
        "type": "local",
        "command": ["npx", "-y", "-p", "memai-cli", "memai-mcp"],
        "cwd": "."
      }
    }
  }
}
```

Facts verified against the installed CLI (`opencode` v2.2.5) and the v2 docs:

- v2 uses `mcp.servers.<name>`. A v1-era `mcp.<name>` entry is **ignored** by v2 (verified: the
  server did not appear in `opencode mcp list`).
- `opencode mcp add memai -- npx -y -p memai-cli memai-mcp` writes exactly this shape and
  `opencode mcp list` then reports `✓ memai  connected`.
- Use `disabled: true` to keep an entry without connecting; v2 does not read an `enabled` field
  (v1 used `enabled: true`).
- `command` is an argv array; `cwd`, `environment`, `timeout` are the documented per-server
  options.
- No hook is used: OpenCode has no documented "run a command at SessionStart" config. The card is
  loaded through the tool/`AGENTS.md` instead. A plugin could call it, but only with the plugin API
  (not used here — unverified for this purpose).
- OpenCode prefixes MCP tool names: server `memai` + tool `mem` → **`memai_mem`**.
- OpenCode appends a server's MCP `initialize.instructions` to the system prompt, so MemAi's
  `instructions` string arrives automatically without a tool call.

Docs: https://opencode.ai/v2/docs/mcp-servers and https://opencode.ai/v2/docs/config
(older v1 docs, different shape: https://opencode.ai/docs/mcp-servers/).

## Instructions

OpenCode loads `AGENTS.md` from the workspace up to the project root (and a global
`~/.config/opencode/AGENTS.md`), plus any files listed in the `instructions` config array.
`memai init` writes a guarded `<!-- memai:start -->` block into the project `AGENTS.md`.
Docs: https://opencode.ai/v2/docs/instructions

## Skill (Agent Skills)

OpenCode v2 scans `.agents/skills` (project) and `~/.agents/skills` (user), so the canonical
[`../../skills/memai/SKILL.md`](../../skills/memai/SKILL.md) is picked up after
`memai skill install --agent opencode` (or `memai init`); OpenCode also reads `.claude/skills`.
The skill appears in OpenCode's `<available_skills>` catalog. No copy lives in this adapter.
Docs: https://opencode.ai/docs/skills/

## Verification status

Verified on this machine with `opencode` v2.2.5: config shape (`mcp.servers`), `opencode mcp add`
writing `opencode.json`, `opencode mcp list` health check showing `✓ memai connected`, and v1 shape
being ignored. Not run: a model session (no `opencode run`), so the in-session tool listing is
verified through the CLI's connection check rather than a conversation.
