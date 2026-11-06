# MemAi — Claude Code adapter

Three independent pieces; use any subset.

| Piece | File here | Copy/merge to | What it does |
| --- | --- | --- | --- |
| MCP server (project scope) | `mcp.json` | `.mcp.json` at the repo root | exposes one `mem` tool (`mcp__memai__mem`) |
| SessionStart hook (optional) | `settings-hooks.json` | `.claude/settings.json` (project) or `~/.claude/settings.json` (user) | injects the ~200-token project card as `additionalContext` before the first prompt |
| Skill (optional) | [`../../skills/memai/SKILL.md`](../../skills/memai/SKILL.md) | `.claude/skills/memai/SKILL.md` (installed for you) | tells Claude when and how to page |

Fastest path: `npx -y memai-cli init --agent claude --write-configs` writes the store, a
`CLAUDE.md` instruction block, merges the `memai` entry into `.mcp.json`, and installs the Agent
Skills package into `.claude/skills/memai/` (other keys preserved). Then merge
`settings-hooks.json` into `.claude/settings.json` if you want the card pre-injected.

## MCP registration

Project scope — commit `.mcp.json` (this file's shape):

```json
{
  "mcpServers": {
    "memai": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "memai-cli", "memai-mcp", "--root", "${CLAUDE_PROJECT_DIR:-.}"]
    }
  }
}
```

`${CLAUDE_PROJECT_DIR:-.}` is expanded by Claude Code in `.mcp.json` (verified: `claude mcp list`
health-checks the spawned server). `--root` can be dropped entirely because the server walks up
from its cwd to the nearest `.git`/`.memai`; it is shown here so the store stays pinned even when
the server is launched from a subdirectory.

Other scopes:

```sh
# project scope (writes .mcp.json)
claude mcp add -s project memai -- npx -y -p memai-cli memai-mcp --root .

# user scope (writes ~/.claude.json)
claude mcp add -s user memai -- npx -y -p memai-cli memai-mcp
```

Verify (this spawns the server for a health check — allowed and cheap):

```sh
claude mcp list          # expect: memai: ... - ✓ Connected
claude mcp get memai
```

If you installed from a local checkout instead of npm, point the command at the checkout:

```json
{ "mcpServers": { "memai": { "type": "stdio", "command": "node",
  "args": ["D:/path/to/MemAi/bin/memai-mcp.mjs"] } } }
```

> Note: `memai init --write-configs` writes snippets with the local checkout's absolute `node`
> path (`node <checkout>/bin/memai-mcp.mjs --root <abs>`) so it works offline without `npx`; this
> adapter uses the portable `npx -y -p memai-cli memai-mcp` form instead. Both start the same
> server — pick whichever fits the machine. Same for the hook: init's generated
> `claude-settings-hooks.json` uses the absolute path and a 30 s timeout, this adapter's uses `npx`.

## SessionStart hook

Hooks live in `.claude/settings.json` (committed) or `.claude/settings.local.json` (personal).
`memai hook card` prints exactly:

```json
{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "<card + rules>" } }
```

and prints nothing when no card exists yet (never fails a session, always exit 0). The same JSON
shape is accepted for `SubagentStart`, so a spawned Claude Code subagent also starts oriented.

Notes:

- `additionalContext` is capped at 10,000 characters by Claude Code; the card is capped well below
  (~700 tokens).
- The card is content-addressed and byte-stable while the repo is unchanged, so it does not
  churn the prompt prefix and provider prefix caching can still hit.
- Hook commands run through a shell (PowerShell on Windows when Git Bash is absent); keep the
  command a plain one-liner as above. If `npx` is slow or unavailable offline, use
  `node "<abs>/bin/memai.mjs" hook card`.
- Hook-time output goes to stdout only; MemAi writes diagnostics to stderr.
- Docs: https://code.claude.com/docs/en/hooks (SessionStart, `hookSpecificOutput.additionalContext`).

## Skill

The canonical skill is **not duplicated in this adapter**; the single source of truth is
[`../../skills/memai/SKILL.md`](../../skills/memai/SKILL.md) (portable Agent Skills format).

```sh
memai skill install --agent claude     # project: .claude/skills/memai/SKILL.md
memai skill install --agent claude --global   # user: ~/.claude/skills/memai/SKILL.md
```

`memai init --agent claude` installs it by default (`--no-skill` to skip), and re-runs are
content-hash idempotent. Claude Code's project skill root is `.claude/skills/` (it does **not**
scan `.agents/skills/`), which is why the installer writes both roots for `--agent all`.
Claude loads the skill when the task matches its description or when the user types `/memai`;
the body loads on demand, so it costs nothing until used.
Docs: https://code.claude.com/docs/en/skills

## Instruction file

`memai init` writes a guarded `<!-- memai:start --> … <!-- memai:end -->` block into `CLAUDE.md`.
Claude Code reads `CLAUDE.md`/`.claude/CLAUDE.md` at every session start (user-level
`~/.claude/CLAUDE.md` too). Docs: https://code.claude.com/docs/en/memory

## Subagent inheritance

- Project instructions (`CLAUDE.md`) and the session's MCP servers are available to subagents.
- Hooks configured in settings files also run inside subagents (Claude Code documents this), so a
  `SubagentStart` hook keeps the child oriented without a model-written handoff.
- Auto memory is **not** inherited by subagents; that is another reason the MemAi store — not a
  model summary — is the handoff channel.
- Docs: https://code.claude.com/docs/en/sub-agents

## Verification status

Verified on this machine with `claude` 2.1.140: project `.mcp.json` registration and health check,
`claude mcp add -s project|user` + `claude mcp remove`, `${CLAUDE_PROJECT_DIR:-.}` expansion,
`.claude/settings.json` hooks being loaded and fired by the CLI (sentinel files, `--init-only`),
the `memai hook card` payload, and **project skill discovery** after `memai skill install --agent
all` (`claude --init-only --debug-file` logged `Loading skills from: … project=[<proj>\.claude\skills]`
and `Loaded N unique skills (… project: 1 …)`; a skill placed only in `.agents/skills` was not
picked up, which is why the installer writes both roots). Not executed here: a full interactive
session (no model calls were made), so in-session rendering of the injected card is documented
behavior rather than observed.
