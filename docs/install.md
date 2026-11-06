# Install & per-agent setup

MemAi has three surfaces, and any one is enough:

- an **MCP server** (`memai-mcp`) with one `mem` tool, for agents that speak MCP;
- a **CLI** (`memai`) with JSON output, for agents that can run shell commands;
- a portable **Agent Skills** package (`skills/memai/SKILL.md`), for agents that load `SKILL.md`
  (Claude Code, Codex, OpenCode, ZCode, DSH, Cursor, Gemini CLI, …).

Plus an optional in-process **DSH plugin** (`adapters/dsh/`, experimental). For the MCP server and
the CLI the store is always the same: `.memai/mem.db` inside the project, resolved from `--root`,
`MEMAI_ROOT`, or the nearest `.git`/`.memai` ancestor.

## Prerequisites

- **Node.js ≥ 22.13** (`node:sqlite` is built in; 22.5–22.12 need
  `--experimental-sqlite`). Nothing else: no npm dependencies, no build step, no
  network access at runtime.
- A repository to index. `git` is recommended (file discovery uses
  `git ls-files` when available) but not required.

## One-command setup

```bash
npx -y memai-cli init --agent all
```

or, installed:

```bash
npm i -g memai-cli
memai init --agent all
```

`npx -y memai-cli <command>` works because the package installs a `memai-cli`
alias for the same entry point as `memai`; the canonical binaries are `memai`
(CLI) and `memai-mcp` (MCP server). For clients that take an explicit command,
use `npx -y -p memai-cli memai-mcp` (or `npx -y memai-cli mcp`, which is the
same server).

`init` writes:

| Path | What it is |
| --- | --- |
| `.memai/mem.db` | the store (SQLite, WAL), indexed locally — 0 model tokens |
| `CLAUDE.md` | an instruction block between `<!-- memai:start -->` / `<!-- memai:end -->` (Claude Code) |
| `AGENTS.md` | the same block for every `AGENTS.md`-reading agent (Codex, OpenCode, ZCode, generic) |
| `.memai/configs/claude-mcp.json` | project `.mcp.json` entry (`mcpServers.memai`, `type: stdio`) |
| `.memai/configs/claude-settings-hooks.json` | `SessionStart` + `SubagentStart` hooks that inject the card |
| `.memai/configs/codex-config.toml` | `[mcp_servers.memai]` block for `~/.codex/config.toml` |
| `.memai/configs/opencode.json` | OpenCode v2 `mcp.servers.memai` entry |
| `.memai/configs/zcode-config.json` | ZCode `mcp.servers` entry + process hook |
| `.memai/configs/generic-mcp.json` | generic `mcpServers` object |
| `.agents/skills/memai/SKILL.md` | the Agent Skills package — portable root (Codex, OpenCode, ZCode, DSH, Cursor, Gemini, generic) |
| `.claude/skills/memai/SKILL.md` | the same skill for Claude Code (its only project skill root; also read by OpenCode/Cursor) |

The snippets in `.memai/configs/` are generated for **this checkout** with absolute
`node`/`bin` paths (they work offline). The portable, commit-friendly forms are in
[`../adapters/`](../adapters/) and [`../examples/`](../examples/).

Useful flags:

| Flag | Effect |
| --- | --- |
| `--agent claude,codex,opencode,zcode,dsh,generic` | limit which instruction files/configs/skill roots are produced (repeatable; default: auto-detect) |
| `--md` | print the instruction block and write nothing (preview) |
| `--write-configs` | also merge `.mcp.json` (Claude Code) and `opencode.json` safely, preserving every other key |
| `--no-skill` | do not install the Agent Skills package (`memai skill install` can add it later) |
| `--no-index` | create the store without indexing the repository |
| `--max-files N` | cap indexed files (default 4000) |
| `--force` | re-extract unchanged files |
| `--root DIR` / `--db FILE` | override the project root / store file |

`init` is idempotent: a second run reports `changed: 0 file(s)` and leaves the
store, instruction blocks and configs untouched; the skill copies are compared by
content hash and report `already installed`. It never rewrites source files.

After the first index, the usual loop is:

```bash
memai card                          # once per session: ~200 tokens
memai query "where is auth checked"
memai fault verifyToken             # one function body, budget-clamped
memai index                         # local, after edits/checkouts
memai diff --since <version>        # in the next session or a subagent
```

## Agent Skills (one skill, every agent)

The skill is the third surface: a portable `SKILL.md` that tells the agent *when* to page versus
read. It is standard Agent Skills frontmatter only (`name`, `description`, `license`,
`compatibility`, `metadata`) — no provider-specific fields — so strict clients accept it.
`init` installs it by default; manage it with:

```bash
memai skill install            # project scope, all agents (default)
memai skill install --agent claude          # one agent alias
memai skill install --global   # user scope: ~/.agents/skills + ~/.claude/skills
memai skill install --link     # symlink/junction instead of copying (checkout workflow)
memai skill install --force    # replace a target that differs
memai skill list               # where it is installed / missing / differs
memai skill status             # same, with a summary count
```

Per the verified Agent Skills matrix, **two project roots cover everything**:

| Install path | Agents that scan it | Status |
| --- | --- | --- |
| `<root>/.agents/skills/memai/SKILL.md` | Codex (cwd upward), OpenCode v2, ZCode (depth-1), DSH (rank 200), Cursor, Gemini CLI (alias), generic SKILL.md hosts | documented; DSH from its shipped `dsh-skill-filesystem` README |
| `<root>/.claude/skills/memai/SKILL.md` | Claude Code (its **only** project skill root — verified: it does not scan `.agents/skills`), also OpenCode and Cursor | ✅ verified live on Claude Code 2.1.140 |

`--global` writes the two user equivalents: `~/.agents/skills/memai/` and
`~/.claude/skills/memai/`. Per-agent flags are aliases that map onto those two roots
(`claude` → `.claude`; `codex|opencode|zcode|dsh|generic` → `.agents`); they never create extra
copies. Optional roots some agents also scan — `~/.zcode/skills`, `~/.gemini/skills`,
`~/.dsh/skills`, `<root>/.zcode/skills`, `<root>/.gemini/skills`, `<root>/.codex/skills` — are
redundant aliases of `~/.agents/skills`/`.agents/skills` and are **not** written by default; add
them only if your agent version ignores the shared root.

Rules the installer enforces:

- **depth-1 layout**: `.agents/skills/memai/SKILL.md` (never an umbrella `skills/memai/` dir with
  the file one level deeper);
- both copies are **byte-identical** to `skills/memai/SKILL.md` and re-runs are content-hash
  idempotent (`unchanged`, no rewrite, no timestamp churn);
- an existing `memai` skill directory with different content is **never clobbered** without
  `--force` (the CLI exits 1 so scripts notice; `init` reports it as a manual step);
- `--link` uses a directory symlink (junction on Windows) when the OS allows it and falls back to
  a copy otherwise.

**Verify.** The skill's name + description (a few hundred tokens) appear in the agent's skill
catalog while the body loads only when activated:

- Claude Code: `/skills` lists `memai`, and `/memai` runs it. Debug evidence:
  `claude --init-only --debug-file log` shows `Loading skills from: … project=[<proj>\.claude\skills]`
  and `Loaded N unique skills (… project: 1 …)`.
- OpenCode: the skill appears in the `<available_skills>` catalog (docs).
- DSH: the skill catalog lists it from `.agents/skills` (rank 200).
- Codex/ZCode/Cursor/Gemini: the skill appears in each agent's skills list (documented; those
  CLIs are not installed on the build machine).

Docs: https://agentskills.io/specification · per-agent links in
[`compatibility.md`](compatibility.md#agent-skills-skillmd-support).

## Claude Code

**MCP, project scope (recommended).** Create `.mcp.json` in the project root
(this is `adapters/claude-code/mcp.json`, verified with `claude` 2.1.140):

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

`${CLAUDE_PROJECT_DIR:-.}` is expanded by Claude Code in `.mcp.json`, so the
store stays pinned even when the server is launched from a subdirectory; you can
also drop `--root` entirely (the server walks up to the nearest `.git`/`.memai`).
Or let the CLI add it:

```bash
claude mcp add -s project memai -- npx -y -p memai-cli memai-mcp --root .
# user scope: claude mcp add -s user memai -- npx -y -p memai-cli memai-mcp
```

`memai init --agent claude --write-configs` merges the `memai` entry into
`.mcp.json` without touching other servers.

Claude Code shows the tool as `mcp__memai__mem`. If your client starts servers
from an unexpected directory, keep the explicit `--root` argument.

**Instructions.** `init` maintains the block in `CLAUDE.md` (above).

**Automatic card injection (hook).** Copy
[`../adapters/claude-code/settings-hooks.json`](../adapters/claude-code/settings-hooks.json)
into `.claude/settings.json` (project) or `~/.claude/settings.json` (user):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y -p memai-cli memai hook card",
            "timeout": 30
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx -y -p memai-cli memai hook card --event SubagentStart",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

`memai hook card` prints exactly one JSON object with
`hookSpecificOutput.hookEventName` set to the event and the project card as
`additionalContext`; when no store/card exists it prints nothing (empty stdout)
and exits 0, so it can never break a session start. `--text` prints the raw card instead (for hosts
without the hook schema). No model call is involved: the hook only reads
`.memai/mem.db`. `memai init` also writes a `.memai/configs/claude-settings-hooks.json`
variant that uses this checkout's absolute `node`/`bin` paths (handy offline); the
adapter file above is the portable, committed form.

**Skill.** `init` installs it to `.claude/skills/memai/SKILL.md`; to manage it directly:

```bash
memai skill install --agent claude            # project
memai skill install --agent claude --global   # ~/.claude/skills
```

Claude Code's project skill root is `.claude/skills/` only — it does **not** scan
`.agents/skills/` (verified), which is why `--agent all` writes both roots. `/skills` lists it and
`/memai` invokes it; the body loads on demand.

**Verify.** `claude mcp list` should show `memai` as connected (the client starts
the server for its health check); `/mcp` inside Claude Code shows the tool list.

## Codex

**MCP.** Append to `~/.codex/config.toml` (global; project-local `config.toml`
support is not documented, so treat it as global):

```toml
[mcp_servers.memai]
command = "npx"
args = ["-y", "-p", "memai-cli", "memai-mcp"]
```

(The same block is in `.memai/configs/codex-config.toml`.) If your Codex build
starts MCP servers from a fixed directory, add `"--root"` and the absolute path.

**Instructions.** `init` maintains the block in `AGENTS.md`.

**Skill.** Codex scans `.agents/skills/` (walking cwd upward) and `~/.agents/skills/`;
`memai skill install --agent codex` (already done by `init`) puts the canonical skill there.
Docs: https://developers.openai.com/codex/skills

**Verify.** Restart Codex and ask it to list MCP tools; `mem` should be present, and the skill
should appear in its skills catalog.

## OpenCode

**MCP.** OpenCode v2 reads MCP servers from `mcp.servers.<name>` in
`opencode.json` / `opencode.jsonc` (project, or `.opencode/opencode.jsonc`), or
from `~/.config/opencode/opencode.json` (global). Merge this entry (verified with
`opencode` v2.2.5; this is `adapters/opencode/opencode.json`):

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

The CLI writes exactly this shape:

```bash
opencode mcp add memai -- npx -y -p memai-cli memai-mcp
```

Verified v2 facts: a v1-era bare `mcp.memai` entry is **ignored** (the server
does not appear in `opencode mcp list`); use `disabled: true` to keep an entry
without connecting (v2 does not read an `enabled` field); `command` is an argv
array and `cwd`/`environment`/`timeout` are per-server options.

`memai init --agent opencode --write-configs` merges the same `memai` entry into
the project `opencode.json` without touching other keys.

**Instructions.** `init` maintains the block in `AGENTS.md` (OpenCode v2 reads
`AGENTS.md`, not `CLAUDE.md`).

**Auto-inject.** OpenCode has no documented SessionStart command hook; the card
arrives through the tool call. OpenCode appends a server's
`initialize.instructions` to the system prompt, so MemAi's short paging contract
arrives without a tool call. The tool is named `memai_mem` in this client.

**Skill.** OpenCode v2 scans `.agents/skills/` and `.claude/skills/` (project) plus
`~/.agents/skills/` and `~/.claude/skills/` (user); `memai skill install --agent opencode`
installs the shared `.agents` copy. The skill shows up in OpenCode's `<available_skills>` catalog
once the project/session reloads. Docs: https://opencode.ai/docs/skills/

**Verify.** `opencode mcp list` should report `✓ memai connected`.

## ZCode

ZCode is Z.ai's coding-agent harness. Its MCP configuration and hook system are
documented in its CLI source/README but were **not verified on this machine**
(`zcode` is not installed), so treat the exact keys as *documented only* and keep
the generic fallback handy.

**MCP.** ZCode reads servers from `~/.zcode/cli/config.json` under `mcp.servers`
(MCP is enabled by default; `features.mcp` toggles it):

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

**Hook (optional).** ZCode hooks are off by default; enable them and register
`SessionStart` in the same file. Note the handler type is `"process"` with a
separate `args` array (argv execution), not Claude Code's shell-string
`"command"`:

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "SessionStart": [
        {
          "matcher": "startup|resume",
          "hooks": [
            { "type": "process", "command": "npx", "args": ["-y", "-p", "memai-cli", "memai", "hook", "card"], "timeoutMs": 20000 }
          ]
        }
      ]
    }
  }
}
```

ZCode process hooks receive JSON on stdin and may print one JSON object on
stdout; `memai hook card` emits exactly the documented
`hookSpecificOutput`/`additionalContext` shape, and prints nothing before the
store exists (a no-op, exit 0).

**Instructions.** `init` writes the guarded block into `AGENTS.md` (ZCode reads
`AGENTS.md`, capped at 100 KiB) and `.memai/configs/zcode-config.json` holds the
mergeable snippet. Full shapes and sources: [`../adapters/zcode/`](../adapters/zcode/).

**Skill.** ZCode scans `.agents/skills/` and `.zcode/skills/` at project scope (depth-1: the
skill dir itself must contain `SKILL.md`) and `~/.agents/skills/` + `~/.zcode/skills/` at user
scope. The default install writes the shared `.agents` copy; `.zcode/skills/memai` is an optional
alias if your ZCode build ignores `.agents`. `memai skill install --agent zcode` (or `init`) is
enough. Docs: https://zcode.z.ai/en/docs/skill

**Fallback if a ZCode version changes the keys:** use
`.memai/configs/generic-mcp.json` (or the CLI-only workflow below) and keep the
`AGENTS.md` block.

## DeepSeek Harness (DSH)

**MCP server (supported path).** Point DSH's MCP client at the same stdio
command:

```bash
npx -y -p memai-cli memai-mcp --root /abs/path/to/project
```

Then configure DSH's MCP client entry the way it documents stdio servers
(`command` + `args`). MemAi does not modify DSH profiles.

**CLI.** DSH agents can run `memai card`, `memai query`, `memai fault` from a
shell tool without any MCP configuration.

**Skill.** DSH's `dsh-skill-filesystem` scans `<project>/.dsh/skills/` (rank 100) and
`<project>/.agents/skills/` (rank 200), plus `~/.agents/skills/`; the default `memai skill
install --agent dsh` writes `.agents/skills/memai/`, so no `.dsh/` copy is needed. Add
`.dsh/skills/memai` manually only if a host configuration disables the `.agents` root.

**In-process plugin (experimental).** `adapters/dsh/` is a Cordis bundle that
registers a `mem` tool and appends a project card to every in-process agent's
prompt. It is verified only against a fake host (`node
adapters/dsh/test/apply.test.mjs`); it keeps its own board/store SQLite file under
`$DSH_HOME` and reads pages produced by the indexer. It is not yet wired to the
project's `.memai/mem.db`. Install it only if you are working on that adapter:

```
plugin_manager({ action: "install_bundle", target: "<repo>/adapters/dsh" })
```

## Generic MCP clients (Cursor, Zed, Cline, Gemini CLI, …)

Most MCP clients accept a `mcpServers` object (Cursor, Cline, Gemini CLI, …);
copy [`../examples/generic/mcpServers.json`](../examples/generic/mcpServers.json)
into the client's MCP config file:

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

Zed is the exception: it reads **`context_servers`** (not `mcpServers`) from its
settings file. The per-client paths, keys and instruction files, with links to
each vendor's docs, are in [`../adapters/generic/README.md`](../adapters/generic/README.md).
The server needs no environment variables; optionally set `MEMAI_ROOT` if the
client's working directory is not the project root.

**Skill.** Agents in this group that support Agent Skills scan `.agents/skills/` (project) and
`~/.agents/skills/` (user) — `memai skill install --agent generic` writes the project copy, and
`--global` the user one. Cursor also reads `.claude/skills/`; Gemini CLI also scans
`.gemini/skills/` (alias of `.agents`). Docs:
https://agentskills.io/specification, https://cursor.com/docs/skills,
https://geminicli.com/docs/cli/skills/

## No MCP? Use the CLI

Every paged operation is one command with JSON on stdout and a `tokens` field.
This is enough for any agent that can run shell commands — no config files:

```bash
memai card --text                        # human-readable card
memai status                             # corpus/store/version summary
memai query "verify token" --k 5         # ranked path:line hits, snippets only
memai fault verifyToken --budget 400     # one body slice
memai get file:src/auth.mjs              # signatures, not bodies
memai diff --since <version>             # ~100-token resume delta
memai note handoff "auth move: see file:src/auth.mjs" --agent lead
memai inbox lead                         # consume board messages
```

Rules of thumb (measured, see [`../bench/RESULTS.md`](../bench/RESULTS.md)):

- load `card` once per session, not per task;
- do not use MemAi for a single file under ~1.3 KB (~346 tokens) — plain `read`
  is cheaper;
- prefer one `fault` over many small `query` calls; stop when the question is
  answered;
- re-index after edits/checkouts and `diff` on resume instead of re-reading.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `no MemAi store at ...` | run `memai init` (or `memai index`) in the project root |
| MCP server exits immediately | check `node --version` is ≥ 22.13; run `memai-mcp --help`; logs go to stderr (`MEMAI_DEBUG=1`) |
| Client starts the server in the wrong directory | add `"--root", "/abs/project/path"` to the server args or set `MEMAI_ROOT` |
| Tool results look stale | `memai index`; line numbers/symbols come from the index, `fault <path>:<line>` reads the file directly |
| Card never injected in Claude Code | the hook must be in `.claude/settings.json` (project) or user settings; test `memai hook card` by hand — once the store is indexed it must print one JSON object, before that it prints nothing (a safe no-op) |
| Agent ignores the memory block | it is advisory text; make sure `CLAUDE.md`/`AGENTS.md` is actually read by that agent, or use the MCP tool descriptions |
| Skill does not appear in the agent | run `memai skill list`; if the target is `missing`, `memai skill install --agent <name>`; if `differs`, re-run with `--force`. Confirm the agent scans that root (Claude Code: `.claude/skills` only; others: `.agents/skills`), then restart/reload the agent |
| `memai skill install` exits 1 with `conflict` | a `memai` skill directory with different content exists; review it, then re-run with `--force` to replace it |

## Uninstall

```bash
rm -rf .memai/                     # store + generated config snippets
rm -rf .agents/skills/memai .claude/skills/memai   # skill copies (project scope)
# then remove the <!-- memai:start --> … <!-- memai:end --> block from CLAUDE.md / AGENTS.md
# and the "memai" entry from .mcp.json / opencode.json / ~/.codex/config.toml
# user-scope skill copies: rm -rf ~/.agents/skills/memai ~/.claude/skills/memai
```

MemAi writes only inside the project (and, with `--global`, the two user skill roots
`~/.agents/skills` / `~/.claude/skills`) apart from the config edits you apply yourself.
