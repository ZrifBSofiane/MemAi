# Compatibility — agents, configs and how to verify them

MemAi is one zero-dependency Node process: `memai-mcp` (stdio MCP server) plus the `memai` CLI
over the same `.memai/mem.db` store. Everything below is about *how each agent reaches it* and
*how confidently we know that*.

**Legend**

| Badge | Meaning |
| --- | --- |
| ✅ **verified on this machine** | Executed here against the real agent CLI, with the command shown |
| 📖 **documented** | Taken from the vendor's official docs or the agent's own source; not executed locally |
| ❓ **unknown** | No reliable public contract found; use the generic/CLI fallback |

**Environment used for verification (2026-11-05, Windows 11, pwsh 7)**

| Tool | Version | Installed |
| --- | --- | --- |
| Node.js | v24.14.0 (npm 11.9.0) | yes |
| `claude` (Claude Code) | 2.1.140 | yes |
| `opencode` | v2.2.5 | yes |
| `codex` | — | no |
| `zcode` | — | no |
| Cursor / Zed / Cline / Gemini CLI | — | no |
| DSH (DeepSeek Harness) | this checkout | yes (plugin shipped in `adapters/dsh/`) |

**Reproduce the whole verification**

```sh
node bench/selftest.mjs                 # 18/18 core checks
node --test test/                       # contract form (test/run-all.mjs is an entry shim for Node 24.x)
node --test "test/*.test.mjs"           # preferred: per-file isolation, skips the shim
node scripts/mcp-probe.mjs              # live handshake + tool/resource/prompt surface
node --check mcp/server.mjs
node adapters/dsh/test/apply.test.mjs   # DSH plugin against a fake Cordis host
node bin/memai.mjs skill install --root /tmp/scratch --agent all   # Agent Skills installer
node bin/memai.mjs skill list --root /tmp/scratch
```

---

## Matrix

| Agent | Instructions file | MCP stdio config (file → keys) | Auto-injection at session start | Subagent inheritance | Status |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `CLAUDE.md` (or `.claude/CLAUDE.md`) | `.mcp.json` → `mcpServers.<name>` (project) / `~/.claude.json` (user/local) | `SessionStart` + `SubagentStart` command hooks → `hookSpecificOutput.additionalContext` | hooks from settings run inside subagents; project instructions shared; auto-memory not inherited | ✅ MCP + hook payload |
| OpenCode v2 | `AGENTS.md` only (no `CLAUDE.md` fallback) | project `opencode.json(c)` or `.opencode/opencode.json(c)` → `mcp.servers.<name>`; global `~/.config/opencode/opencode.json(c)` | none documented (MCP `initialize.instructions` is added to the system prompt) | MCP tools are agent-visible; per-agent tool config documented, subagent context inherit not verified | ✅ MCP config + connection |
| Codex CLI | `AGENTS.md` (repo root and parents) | `~/.codex/config.toml` → `[mcp_servers.<name>]` `command`/`args` | none (static `AGENTS.md` only) | ❓ | 📖 documented, not installed |
| ZCode (Z.ai) | `AGENTS.md` (workspace + `~/.zcode/AGENTS.md`) | `~/.zcode/cli/config.json` → `mcp.servers.<name>` | `hooks.events.SessionStart` process hooks (opt-in via `hooks.enabled`) | ❓ | 📖 documented from CLI source |
| DSH (DeepSeek Harness) | `AGENTS.md` + plugin-injected runtime context | not needed in-process: `adapters/dsh/` Cordis bundle registers one `mem` tool and injects the card | plugin `systemPrompt.context` (every in-process agent) | spawn/fork/team children inherit; out-of-process children do not | ✅ offline plugin test |
| Generic MCP (Cursor/Zed/Cline/Gemini) | Cursor `AGENTS.md`/`.cursor/rules`; Zed `.rules`/`AGENTS.md`; Cline `.clinerules`/`AGENTS.md`; Gemini `GEMINI.md` | see per-client paths below (`mcpServers` or Zed's `context_servers`) | none for Cursor/Zed/Cline; Gemini appends MCP `instructions` to system instructions | client-specific | 📖 documented |

---

## Hook output compatibility

`memai hook card` prints exactly one JSON object on stdout and nothing else; it exits 0 even when
there is no card yet (silent no-op) and never creates/updates the store.

```json
{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "…card + rules…" } }
```

| Agent | Hook event name | Handler shape | Status |
| --- | --- | --- | --- |
| Claude Code | `SessionStart`, `SubagentStart` | `{ "type": "command", "command": "<shell string>", "timeout": 30 }` | ✅ executed end-to-end |
| ZCode | `SessionStart` | `{ "type": "process", "command": "...", "args": [...], "timeoutMs": 20000 }` (argv, **not** a shell string) | 📖 documented |
| OpenCode | — | no documented config-level hook; MCP `instructions` used instead | n/a |
| Codex | — | no stable user-facing context-injection hook documented | n/a |

Note the argument names differ between Claude Code and ZCode (`command` shell string vs `process` +
`args` argv). Do not copy one block to the other unchanged.

---

## Agent Skills (SKILL.md) support

MemAi ships **one** portable skill: [`skills/memai/SKILL.md`](../skills/memai/SKILL.md). It uses
standard Agent Skills frontmatter only (`name`, `description`, `license`, `compatibility`,
`metadata` string map). Provider-only fields (`allowed-tools`, `context`, `agent`,
`disable-model-invocation`, `user-invocable`, DSH `whenToUse`, dynamic `` !`cmd` `` injection) are
deliberately absent, so strict clients accept the file unchanged. Format:
[agentskills.io/specification](https://agentskills.io/specification).

`memai skill install` writes exactly two destinations per scope; per-agent flags are aliases that
map onto them (they never create extra copies):

| Scope | Destination | Agents that scan it | Status |
| --- | --- | --- | --- |
| project | `<root>/.agents/skills/memai/` | Codex (cwd upward), OpenCode v2, ZCode (depth-1), DSH (rank 200), Cursor, Gemini CLI (alias), generic SKILL.md hosts | 📖 documented |
| project | `<root>/.claude/skills/memai/` | Claude Code (**only** project skill root), OpenCode, Cursor | ✅ verified live |
| global | `~/.agents/skills/memai/` | Codex, OpenCode, ZCode, DSH, Cursor, Gemini CLI, generic | 📖 documented |
| global | `~/.claude/skills/memai/` | Claude Code, OpenCode, Cursor | ✅ verified live (root list) |

Agent → alias → destination: `claude` → `.claude`; `codex`, `opencode`, `zcode`, `dsh`, `generic`
→ `.agents`. `--agent all` (the default, and what `memai init` uses) writes both project roots.
Redundant per-agent roots some implementations also scan (`.zcode/skills`, `.gemini/skills`,
`.dsh/skills`, `.codex/skills`, `~/.zcode/skills`, `~/.gemini/skills`) are documented in
[`install.md`](install.md#agent-skills-one-skill-every-agent) and are not written by default.

| Agent | Skill root(s) | Status / source |
| --- | --- | --- |
| Claude Code | `.claude/skills/<name>/SKILL.md`; `~/.claude/skills/` | ✅ verified live: `claude --init-only --debug-file` printed `Loading skills from: … project=[<proj>\.claude\skills]` and `Loaded N unique skills (… project: 1 …)` after installing `memai`. Docs: https://code.claude.com/docs/en/skills |
| OpenCode v2 | `.agents/skills`, `.claude/skills`, `.opencode/skills` (+ user equivalents) | 📖 documented: https://opencode.ai/docs/skills/ |
| Codex CLI | `.agents/skills` (scans cwd upward), `~/.agents/skills` | 📖 documented: https://developers.openai.com/codex/skills |
| ZCode | `.agents/skills`, `.zcode/skills` (depth-1), user equivalents | 📖 documented: https://zcode.z.ai/en/docs/skill |
| DSH | `.agents/skills` (rank 200), `.dsh/skills` (rank 100), `~/.agents/skills` | ✅ documented from the shipped `@deepseek-ai/dsh-skill-filesystem` README (asar) |
| Cursor | `.agents/skills`, `.cursor/skills`, also `.claude/skills`, `.codex/skills` | 📖 documented: https://cursor.com/docs/skills |
| Gemini CLI | `.agents/skills` (alias), `.gemini/skills` | 📖 documented: https://geminicli.com/docs/cli/skills/ |

Cost: clients inject only the skill's name + description per turn (a few hundred tokens; body
loads on activation), so one shared skill is cheap — which is why the installer never plants
multiple overlapping copies.

Verify:

```sh
memai skill list                 # installed / missing / differs per scope
memai skill status
claude --init-only --debug-file log   # Claude Code: "Loaded N unique skills (… project: 1)"
```

---

## Claude Code (verified)

Docs: [hooks](https://code.claude.com/docs/en/hooks) · [MCP](https://code.claude.com/docs/en/mcp) ·
[memory/CLAUDE.md](https://code.claude.com/docs/en/memory) · [skills](https://code.claude.com/docs/en/skills) ·
[sub-agents](https://code.claude.com/docs/en/sub-agents)

**MCP (project scope)** — commit `.mcp.json` (shape in `adapters/claude-code/mcp.json`):

```json
{ "mcpServers": { "memai": { "type": "stdio", "command": "npx",
  "args": ["-y", "-p", "memai-cli", "memai-mcp", "--root", "${CLAUDE_PROJECT_DIR:-.}"] } } }
```

Other scopes: `claude mcp add -s project memai -- npx -y -p memai-cli memai-mcp`,
`claude mcp add -s user …`; project scope writes `.mcp.json`, user/local scope writes
`~/.claude.json` (`projects[<cwd>].mcpServers` for local).

**Hook** — merge `adapters/claude-code/settings-hooks.json` into `.claude/settings.json`
(project) or `~/.claude/settings.json` (user). `additionalContext` is capped at 10,000 chars; the
card is ~200–700 tokens. Hooks in settings files are documented to run inside subagents too, hence
the optional `SubagentStart` entry.

**What was actually executed here**

| Check | Command | Result |
| --- | --- | --- |
| project `.mcp.json` registration + health check | `claude mcp list` in a scratch project | `memai: node …memai-mcp.mjs --root . - ✓ Connected` |
| `${CLAUDE_PROJECT_DIR:-.}` expansion | same, with that arg in `.mcp.json` | expanded, ✓ Connected |
| add/get/remove across scopes | `claude mcp add -s user memai-verify -- …`, `claude mcp get`, `claude mcp remove` | all succeeded, user config restored |
| hooks load + fire | `claude --init-only --debug-file <f>` with generated `.claude/settings.json` | `Hook SessionStart:startup … provided additionalContext (896 chars)`, validated JSON |
| MCP server seen by the session | same `--debug-file` log | `MCP server "memai": Successfully connected (transport: stdio)` |
| project skill discovery | `memai skill install --agent all` then `claude --init-only --debug-file <f>` | `Loading skills from: … project=[<proj>\.claude\skills]`; `Loaded 2 unique skills (… project: 1 …)` |

Not executed: an interactive/`-p` model session (no model calls were made), so the model *reading*
the injected card is documented behavior, not observed.

Adapter: [`adapters/claude-code/`](../adapters/claude-code/) — `mcp.json`, `settings-hooks.json`,
`README.md` (the skill is **not** duplicated there; single source is [`skills/memai/`](../skills/memai/),
installed by `memai skill install --agent claude` / `memai init`). `memai init --agent claude
--write-configs` generates local equivalents with absolute `node` paths (offline-safe); the adapter
uses `npx` for published installs.

---

## OpenCode v2 (verified)

Docs: [MCP servers](https://opencode.ai/v2/docs/mcp-servers) · [config](https://opencode.ai/v2/docs/config) ·
[instructions](https://opencode.ai/v2/docs/instructions). The old v1 docs
([`/docs/mcp-servers`](https://opencode.ai/docs/mcp-servers/)) describe a **different shape**.

```json
{ "$schema": "https://opencode.ai/config.json",
  "mcp": { "servers": { "memai": { "type": "local",
    "command": ["npx", "-y", "-p", "memai-cli", "memai-mcp"], "cwd": "." } } } }
```

- v2 reads `mcp.servers.<name>`; a bare `mcp.<name>` (v1 shape) is **ignored** — verified: no
  server appeared in `opencode mcp list`.
- v2 uses `disabled: true` to keep an entry disconnected; an `enabled` field is not read (v1 used
  it).
- `opencode mcp add memai -- npx -y -p memai-cli memai-mcp` writes exactly this shape.
- OpenCode names MCP tools `<server>_<tool>`, so MemAi's tool is **`memai_mem`**.
- A server's MCP `initialize.instructions` is appended to OpenCode's system prompt, so the paging
  contract arrives without a call. Prompts become commands (`memai:memai-card`).
- Instructions: `AGENTS.md` only (v2 does not fall back to `CLAUDE.md`); global
  `~/.config/opencode/AGENTS.md` also loads.

**What was actually executed here**

| Check | Command | Result |
| --- | --- | --- |
| config shape | `opencode mcp add memai -- node …/memai-mcp.mjs --root …` in a scratch project | wrote `opencode.json` with `mcp.servers.memai` |
| connection | `opencode mcp list` in that project | `✓ memai  connected` |
| v1 shape ignored | `opencode mcp list` with `{ "mcp": { "memai": … } }` | `No MCP servers configured` |
| generated by MemAi | `memai init --agent opencode --write-configs` then `opencode mcp list` | `✓ memai  connected` |

Caveat observed: the **first** `opencode mcp list` invocation in a brand-new directory can report
`No MCP servers configured` while OpenCode's background service picks up the project config; run it
again (or start OpenCode once in that directory) and the server connects. Not a config problem.

Adapter: [`adapters/opencode/`](../adapters/opencode/).

---

## Codex CLI (documented — not installed here)

Docs: [Codex MCP](https://developers.openai.com/codex/mcp) ·
[config reference](https://developers.openai.com/codex/config-reference) ·
[AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md). Repository pointers:
[`docs/config.md`](https://github.com/openai/codex/blob/main/docs/config.md),
[`docs/agents_md.md`](https://github.com/openai/codex/blob/main/docs/agents_md.md).

```toml
# ~/.codex/config.toml (global)
[mcp_servers.memai]
command = "npx"
args = ["-y", "-p", "memai-cli", "memai-mcp"]
# env = { MEMAI_ROOT = "/abs/path" }   # optional pin
```

Instructions come from `AGENTS.md` in the repo root (and parents) — Codex has no documented
session-start context-injection hook for users; `allow_managed_hooks_only` in `requirements.toml`
is an admin feature, not a place to inject the card. Verify after install with `/mcp` in the TUI
(per Codex docs) and `codex --version`.

Status: the keys above are from official docs and the `openai/codex` repository; **the config
loader was not exercised on this machine** (codex not installed). The MCP server itself is the same
binary verified through Claude Code and OpenCode. If a Codex version rejects `mcp_servers`, use the
CLI fallback in [`adapters/generic/README.md`](../adapters/generic/README.md).

Adapter: [`adapters/codex/`](../adapters/codex/).

---

## ZCode — Z.ai's harness (documented from source — not installed here)

Canonical source: [github.com/hyudryu/ZCode](https://github.com/hyudryu/ZCode), agent CLI under
`apps/zcode-cli/`. Its CLI README documents MCP and hooks; the context loader source documents the
instruction file. There is no separate docs website.

**MCP** — main JSON config, default `~/.zcode/cli/config.json`, servers under `mcp.servers`
(`features.mcp` only needed to force on/off; stdio requires `command`, optional `args`, `cwd`,
`env`, `enabled`, `timeoutMs`). Tools are exposed as `mcp__<server>__<tool>` →
**`mcp__memai__mem`**. ZCode does not auto-discover a standalone `.mcp.json` outside enabled
plugins. Sources:
[`apps/zcode-cli/README.md` → MCP Configuration](https://github.com/hyudryu/ZCode/blob/main/apps/zcode-cli/README.md).

**Hooks** — same config file, **disabled by default**. Enable `hooks.enabled: true`, then
`hooks.events.SessionStart` entries of `{ "type": "process", "command": "...", "args": [...] }`.
Process hooks get JSON on stdin and print one JSON object; empty stdout is a no-op; exit code 2
blocks. The documented `SessionStart` output example is exactly MemAi's shape
(`hookSpecificOutput.hookEventName` + `additionalContext`). Source: same README, "Hooks
Configuration".

**Instructions** — `AGENTS.md`: the workspace file walking up to the project root plus a
user-level `~/.zcode/AGENTS.md`, capped at 100 KiB. Verified from source:
`NodeContextSourceAdapter`, `DEFAULT_PRIORITY_FILES = ["AGENTS.md"]`
([`context/index.ts`](https://github.com/hyudryu/ZCode/blob/main/apps/zcode-cli/packages/adapters/src/context/index.ts)).

Status: **documented from the ZCode CLI source/README, not executed** (zcode not installed).
Subagent context inheritance is ❓ unknown — use `AGENTS.md` + the CLI fallback if a ZCode
subagent does not see the card. A ZCode plugin (`.zcode-plugin/plugin.json` with `mcpServers`) is
a documented alternative distribution path, not used here.

Adapter: [`adapters/zcode/`](../adapters/zcode/) (`config.json`, `AGENTS.md`, `README.md`).

---

## DSH — DeepSeek Harness (verified offline)

DSH is the only host where MemAi is an **in-process plugin** instead of an MCP server:
`adapters/dsh/` is a Cordis bundle that injects a tiny project card with `systemPrompt.context`
into every agent the host runs (lead, spawned subagent, forked subagent, team member) and registers
one `mem` tool over the same SQLite page format. This is what makes the card reach DSH subagents
without a hook or a handoff summary.

- No MCP, no per-project config file, no shell hook; one plugin install into the DSH profile
  (`plugin_manager({ action: 'install_bundle', target: '<abs path to adapters/dsh>' })`, requires
  approval).
- Out-of-process children (ACP / SDK / Codex / Claude Code) never see host plugin context.
- Verification here: `node adapters/dsh/test/apply.test.mjs` passes against a fake Cordis host
  (registrations, card rendering, `mem` ops, board, diff, dispose). The live plugin install was not
  performed in this session (approval prompts disabled), and nothing about that plugin was modified
  for this adapter work.

Adapter: [`adapters/dsh/`](../adapters/dsh/).

---

## Generic MCP clients (documented)

| Client | File | Key shape | Docs |
| --- | --- | --- | --- |
| Cursor | `~/.cursor/mcp.json`, `.cursor/mcp.json` | `mcpServers.<name>`: `type:"stdio"`, `command`, `args`, `env`, `envFile` | [cursor.com/docs/mcp](https://cursor.com/docs/mcp) · [rules](https://cursor.com/docs/rules) |
| Zed | Zed settings (`zed: open settings file`) | **`context_servers`** (not `mcpServers`): `command`, `args`, `env` | [zed.dev/docs/ai/mcp](https://zed.dev/docs/ai/mcp) |
| Cline | CLI: `~/.cline/data/settings/cline_mcp_settings.json` (override `CLINE_MCP_SETTINGS_PATH`); IDE: MCP Servers → Configure | `mcpServers.<name>`: `command`, `args` | [docs.cline.bot/mcp/mcp-overview](https://docs.cline.bot/mcp/mcp-overview) |
| Gemini CLI | `~/.gemini/settings.json` (user), `.gemini/settings.json` (project) | `mcpServers.<name>`: `command`, `args`, `env`, `cwd`, `timeout`, `trust`; MCP `instructions` appended to system instructions | [gemini-cli MCP docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md) |
| Any other MCP host | its own config | `{ "command": "npx", "args": ["-y","-p","memai-cli","memai-mcp"] }` | [modelcontextprotocol.io](https://modelcontextprotocol.io) |

Zed is the odd one out: it uses `context_servers` at the settings top level, so the generic
`mcpServers` JSON must be reshaped. Cursor supports `AGENTS.md` in the repo root and
subdirectories, `.cursor/rules/*.mdc`, or both. Gemini CLI also appends a server's
`initialize.instructions` to the system prompt, which is where MemAi's paging contract arrives.
Config keys are from the vendor docs; **no generic client was executed on this machine**.

Adapter: [`adapters/generic/`](../adapters/generic/) — `mcpServers.json`, `AGENTS.md`, `README.md`
(also documents the CLI-only workflow for agents with no MCP support).

---

## Unknown / not claimed

- **Codex** user-facing hooks for context injection: not documented; do not rely on them.
- **ZCode** subagent inheritance of `AGENTS.md`/MCP tools: not documented. Its MCP/hook config
  keys are from the CLI README and may change between versions.
- **OpenCode** config-level hooks (vs plugin API): no documented "run this at session start"
  setting; MemAi uses the tool + `AGENTS.md` + `initialize.instructions` instead.
- **Cline / Zed / Gemini** exact instruction-file precedence: documented per vendor but not
  verified here; each agent also reads its own proprietary rules format, so the `AGENTS.md`-based
  instruction block is the portable common denominator.
- **MCP `2026-07-28` / Streamable HTTP**: MemAi speaks newline-framed stdio and the classic
  `initialize` handshake; protocol versions 2024-11-05, 2025-03-26 and 2025-06-18 are negotiated.
  A client that requires a newer revision needs the proxy path of that client.
- **Auto-approval / trust**: project-scope servers may require an interactive approval (Claude
  Code `.mcp.json`, OpenCode/codex configs, MCP clients' trust prompts). Non-interactive CI runs
  usually see them as pending; that is client policy, not a MemAi bug.
- **Skill discovery in non-installed agents**: the `.agents`/`.claude` roots and the portable
  frontmatter are documented from vendor docs; only Claude Code's discovery was executed here.
  If an agent version ignores `.agents/skills`, use its native root (see optional roots in
  [`install.md`](install.md#agent-skills-one-skill-every-agent)) — no change to the canonical file.

## Product identifiers (canonical)

Repo **MemAi**, CLI **`memai`**, npm package **`memai-cli`**, MCP binary **`memai-mcp`**, store
**`.memai/`** (SQLite `mem.db`), env `MEMAI_ROOT` / `MEMAI_DB` / `MEMAI_AGENT` /
`MEMAI_GRANULAR_TOOLS` / `MEMAI_DEBUG`. The MCP server is `memai-mcp`; the agent-facing tool is
`mem` (one tool with an `op` enum; `MEMAI_GRANULAR_TOOLS=1` switches to 11 `mem_*` tools).
