# MemAi — ZCode adapter

ZCode is Z.ai's coding-agent harness (desktop, web and terminal); its CLI sources are in
[`hyudryu/ZCode`](https://github.com/hyudryu/ZCode) under `apps/zcode-cli/`. It has **first-class
MCP support and a SessionStart hook system**, so MemAi can inject the card the same way it does in
Claude Code.

| Piece | File here | Copy/merge to |
| --- | --- | --- |
| MCP server + hook | `config.json` | `~/.zcode/cli/config.json` (user config; merge keys, do not replace) |
| Instructions | `AGENTS.md` | `AGENTS.md` at the repo root |

## MCP registration

ZCode reads MCP servers from its main JSON config (default `~/.zcode/cli/config.json`) under
`mcp.servers`; MCP is on by default and can be toggled with `features.mcp`.

```json
{
  "mcp": {
    "servers": {
      "memai": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "-p", "memai-cli", "memai-mcp"],
        "timeoutMs": 30000
      }
    }
  }
}
```

Documented server options for `type: "stdio"`: `command` (required), `args`, `cwd`, `env`,
`enabled`, `timeoutMs`. MCP tools surface as `mcp__memai__mem`. Manage from inside the CLI with
`/mcp list`, `/mcp status`, `/mcp connect memai`. ZCode does not auto-discover a standalone
`.mcp.json` outside enabled plugins — put the entry in `config.json` (or ship a ZCode plugin whose
`.zcode-plugin/plugin.json` has `mcpServers`).

Source: https://github.com/hyudryu/ZCode/blob/main/apps/zcode-cli/README.md ("MCP Configuration")

## SessionStart hook (card injection)

ZCode hooks are **off by default**; enable them and register the event in the same `config.json`:

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart": [
        {
          "matcher": "startup|resume",
          "hooks": [
            {
              "type": "process",
              "command": "npx",
              "args": ["-y", "-p", "memai-cli", "memai", "hook", "card"],
              "timeoutMs": 20000
            }
          ]
        }
      ]
    }
  }
}
```

ZCode process hooks receive JSON on stdin and may print one JSON object on stdout. Its documented
example output is exactly MemAi's shape:

```json
{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "…" } }
```

Empty stdout is a no-op, so `memai hook card` printing nothing before the store exists is safe.
Exit code `2` blocks; MemAi always exits 0. Source:
https://github.com/hyudryu/ZCode/blob/main/apps/zcode-cli/README.md ("Hooks Configuration").

## Instructions

ZCode resolves agent instructions from `AGENTS.md`: the workspace file (walking up to the project
root) plus a user-level `~/.zcode/AGENTS.md`, capped at 100 KiB. Verified from the CLI source
(`NodeContextSourceAdapter`, `DEFAULT_PRIORITY_FILES = ["AGENTS.md"]`):
https://github.com/hyudryu/ZCode/blob/main/apps/zcode-cli/packages/adapters/src/context/index.ts

`memai init --agent zcode` writes the guarded `<!-- memai:start -->` block into `AGENTS.md`.

## Skill (Agent Skills)

ZCode scans the project `.agents/skills` (depth-1: `<name>/SKILL.md`) and user `~/.agents/skills`
in addition to its own `.zcode/skills` roots. The canonical
[`../../skills/memai/SKILL.md`](../../skills/memai/SKILL.md) is installed by
`memai skill install --agent zcode` (or `memai init`). The `.zcode/skills` path is an optional
alias and is not written by default (see `docs/install.md`). Docs: https://zcode.z.ai/en/docs/skill

## Verification status

**Documented from the ZCode CLI source and README; not verified on this machine** — `zcode` is not
installed here. The shapes above come from `apps/zcode-cli/README.md` (MCP + hooks) and
`packages/adapters/src/context/index.ts` (AGENTS.md resolution), not from a live config parse.
Note ZCode's hook handler type is `"process"` with a separate `args` array (argv execution), not
Claude Code's shell-string `"command"` — do not copy one hook block to the other tool unchanged.

There is no upstream documentation website for ZCode; the GitHub repository is the canonical
source. If a future ZCode version changes these keys, fall back to the generic adapter
(`../generic/README.md`) and the CLI-only workflow.
