# MemAi

**Paged memory for coding agents.** MemAi distils your repository locally into a
~200-token project card plus a symbol manifest, then lets each session and
subagent *demand-page* only the detail it needs, and resume after edits from a
Merkle delta instead of re-reading files or consuming a model-written handoff.
One stdio MCP server and one dependency-free CLI serve Claude Code, Codex,
OpenCode, ZCode and DeepSeek Harness.

[![CI](https://github.com/ZrifBSofiane/MemAi/actions/workflows/ci.yml/badge.svg)](https://github.com/ZrifBSofiane/MemAi/actions/workflows/ci.yml)

> **v0.1.1 preview.** The measured numbers below are real runs on one machine
> (Windows 11, Node 24.14); the compatibility matrix labels what was verified on
> an installed agent versus documented from vendor docs. npm package:
> `memai-cli` · CLI binary: `memai` · MCP binary: `memai-mcp` · store: `.memai/`
> · root env: `MEMAI_ROOT`.

## The problem, in one measurement

On one completed two-agent coding task (170 model steps, 32.8M tokens billed):

- **98.3%** of billed tokens were re-sent context, not new input;
- **91.4%** of prompt tokens were tool results — file reads, shell output,
  inspection dumps — each riding in the window for **~39 further steps**;
- **14.9%** of tool-output bytes were byte-identical repeats.

Re-reading files is not the expensive part. *Re-sending* everything that was ever
read is. See [`docs/evidence.md`](docs/evidence.md) for the method and the
counterfactual replay: keeping only the last 8 tool results inline would have cut
prompt tokens **7.8×** and cost **−56%** on that task.

## What MemAi does

| Idea | In practice |
| --- | --- |
| **One small card** | `memai card` → stack, entrypoints, build/test commands, layout, conventions, paging rules. ~200 tokens, byte-stable, content-addressed. |
| **One manifest** | `memai map` → one line per file with LOC + top symbols, budget-capped. The agent knows what exists without reading it. |
| **Demand paging** | `memai query` returns ranked `path:line` snippets; `memai fault` materialises one symbol body; `get file:<path>` returns signatures, not bodies. Every response is token-counted and clamped to a hard budget. |
| **Merkle deltas** | `memai diff --since <hash>` returns added/changed/removed files plus symbol churn in ~100 tokens. A new session or a fresh subagent resumes from a version stamp. |
| **A shared board** | `note`/`post`/`inbox`/`merge` — append-only typed messages carrying page ids, never file bodies. Agents share state without model-written summaries or steering messages. |
| **One integration surface** | A stdio [MCP](https://modelcontextprotocol.io) server (`memai-mcp`) plus a CLI (`memai`). `memai init` writes the per-agent instruction blocks and config snippets. |

Local-first: extraction runs on CPU/disk with **zero model tokens** and **zero
dependencies** — no `npm install`, no embeddings, no server, no network.

## Measured

14 tasks across four corpora, all self-contained in this repo: a generated
200-file API fixture, a real 288-file npm CLI (shipped with Node), MemAi itself
(self-host), and the bundled DSH adapter. All numbers are reproducible from a
fresh clone (`node bench/bench.mjs`); full method, per-task table and honest
limits are in [`bench/RESULTS.md`](bench/RESULTS.md).

| scenario (14 tasks) | input tokens | cost (off-peak) |
| --- | --- | --- |
| A — grep + read the needed files | 67,149 | $0.010744 |
| B — read + model-written summary handoff + re-read | 78,774 | $0.018707 |
| C — card + curated paging plan | 14,861 | $0.002901 |
| **C\* — card + paging + completion to 100% recall** | **21,958** | **$0.003966** |

- **3.06× fewer input tokens** than naive file reads (45,191 tokens saved across
  the 14 tasks), and **3.59×** fewer than the summary-handoff workflow.
- **4.7× cheaper in dollars** than model-written handoffs (C\* $0.003966 vs B
  $0.018707): one output token costs 200× a cache-hit input token, so writing
  prose is the expensive way to move facts.
- **5.6–9.5× fewer tokens to resume** after three files change: a ~102-token
  diff + two faults (469 / 436 tokens) versus re-reading the changed files
  (2,607 / 4,127 tokens).
- Counterfactual on real logs: **7.8×** fewer prompt tokens, **−56%** cost for
  a last-8-tool-results retention policy ([`docs/evidence.md`](docs/evidence.md)).

Every one of the 14 paged runs has **100% coverage** of the curated ground-truth
file set; C\* includes the cost of paging every file the cheap plan missed. The
per-task ratio ranges from 1.17× (a tiny single-file fixture task, where plain
reads are already cheap) to 5.50× (a locate task on the real 288-file corpus).

> **Method note.** Token counts come from the shipped code over the real corpora,
> with `tokens = ceil(chars / 3.966)` calibrated against provider-reported usage
> (`tools/calibrate-session.mjs`). Prices are deepseek-flash off-peak list
> ($0.15 / $0.003 / $0.60 per 1M miss / hit / output tokens); at peak (2×) every
> dollar figure doubles, while all token ratios are price-independent. This is a
> controlled benchmark, not a production A/B.

## How it works

```
                    ┌──────────────────────────────────────────────┐
  Claude Code       │  MCP server (memai-mcp)   CLI (memai)         │
  Codex             │  one `mem` tool, 11 ops    same surface       │
  OpenCode     ───► │  JSON-RPC over stdio       JSON on stdout     │
  ZCode             └──────────────────┬───────────────────────────┘
  DSH plugin                           │ page ids · symbol anchors · version hashes
                    ┌──────────────────▼───────────────────────────┐
                    │  pages: project.card · project.map · file:*  │
                    │         board:* · Merkle versions · deltas   │
                    └──────────────────┬───────────────────────────┘
                                       │ deterministic extraction (0 model tokens)
                    ┌──────────────────▼───────────────────────────┐
                    │  git ls-files · symbol/import regexes ·      │
                    │  build files · tests · FTS5 symbol index     │
                    └──────────────────┬───────────────────────────┘
                                       ▼
                    .memai/mem.db  (SQLite, WAL, one writer, many readers)
```

**Session loop:** `card` once → `query` → `fault` the one symbol the task needs →
edit → `index` (local, cheap) → next session `diff --since <hash>` → fault only
what the delta names. Subagents get the same card plus the parent's version hash
instead of a prose summary. Other agents read the board, not a steering queue.

**The rule that makes it pay:** never inline what can be referenced; keep the
shared prefix byte-identical so the provider's prefix cache can hit; page in
hundreds of tokens, not thousands.

## Quick start

> **npm publish is pending.** Until `memai-cli` is on npm, install straight from
> this repo — `npm i -g github:ZrifBSofiane/MemAi` — or clone it and run
> `node bin/memai.mjs …`. The `npx` commands below are the intended published
> form (the `memai-cli` name was free on npm at release time).

```bash
# 1. Create the store, index the repo, install the Agent Skills package,
#    write per-agent instructions and MCP snippets
npx -y memai-cli init --agent all

# 2. Distil the repo locally (0 model tokens, no network)
npx -y memai-cli index

# 3. Use it
npx -y memai-cli card                  # ~200-token orientation, once per session
npx -y memai-cli query "where is auth checked"
npx -y memai-cli fault verifyToken     # one body slice, budget-clamped
npx -y memai-cli diff --since <version>  # on the next session / in a subagent
```

Or install once — there is nothing to compile and no runtime dependency:

```bash
npm i -g memai-cli
memai init --agent all
```

`init` writes an idempotent instruction block between
`<!-- memai:start -->` / `<!-- memai:end -->` markers into `CLAUDE.md` and/or
`AGENTS.md`, drops ready-to-paste MCP config snippets under `.memai/configs/`,
and (with `--write-configs`) safely merges project-scope MCP entries. It never
touches source files, and a second run changes nothing. `--md` previews the
instruction block without writing.

MCP clients start the server directly:

```bash
npx -y -p memai-cli memai-mcp --root .   # stdio JSON-RPC; logs on stderr only
node bin/memai-mcp.mjs --root .          # from a checkout
```

The store lives in `.memai/mem.db` under the project root. Override the root or
the store file with `--root` / `--db`, or with `MEMAI_ROOT` / `MEMAI_DB`.

## Connect your agent

`memai init --agent all` generates config snippets for all of these. Exact keys,
verification steps and the **no-MCP CLI fallback** are in
[`docs/install.md`](docs/install.md); the per-agent evidence (what was verified on
an install vs copied from vendor docs) is in
[`docs/compatibility.md`](docs/compatibility.md) and in each adapter README.

| Agent | Instructions | MCP | Auto-inject | Adapter |
| --- | --- | --- | --- | --- |
| **Claude Code** | `CLAUDE.md` block | project `.mcp.json` → `mcpServers.memai`, or `claude mcp add` | `SessionStart`/`SubagentStart` hooks (`memai hook card`) + skill | [`adapters/claude-code/`](adapters/claude-code/) |
| **Codex** | `AGENTS.md` block | `~/.codex/config.toml` → `[mcp_servers.memai]` | instruction block only | [`adapters/codex/`](adapters/codex/) |
| **OpenCode** | `AGENTS.md` block | `opencode.json` → `mcp.servers.memai` (v2 shape) | `initialize.instructions` appended by OpenCode | [`adapters/opencode/`](adapters/opencode/) |
| **ZCode** | `AGENTS.md` block | `~/.zcode/cli/config.json` → `mcp.servers.memai` | process hook on `SessionStart` (opt-in) | [`adapters/zcode/`](adapters/zcode/) |
| **DeepSeek Harness (DSH)** | in-process plugin guidance + `AGENTS.md` | MCP server (supported path) | experimental in-process bundle | [`adapters/dsh/`](adapters/dsh/) |
| **Generic MCP** (Cursor, Zed, Cline, Gemini CLI, …) | the agent's rules file | `mcpServers` JSON (Zed: `context_servers`) | — | [`adapters/generic/`](adapters/generic/) |

MemAi never invents vendor config keys: each adapter states what it verified on a
real install (and the version), what comes from vendor documentation, and what is
unknown. The evidence matrix is [`docs/compatibility.md`](docs/compatibility.md).

## Skills — one file, every agent

[`skills/memai/SKILL.md`](skills/memai/SKILL.md) is a portable
[Agent Skills](https://agentskills.io/specification) package. It teaches an agent *when* MemAi is
worth using versus a plain file read — card → query → fault → diff, the `mem` MCP tool **and** the
`memai` CLI fallback, the measured ~346-token / ~1.3 KB break-even, and the common pitfalls — and
uses standard frontmatter only (`name`, `description`, `license`, `compatibility`, `metadata`), so
strict clients accept it unchanged.

`memai init` installs it by default into the two roots agents actually scan:

| Install path | Agents that scan it |
| --- | --- |
| `.agents/skills/memai/SKILL.md` | Codex, OpenCode, ZCode, DSH, Cursor, Gemini CLI, generic SKILL.md hosts |
| `.claude/skills/memai/SKILL.md` | Claude Code (its only project skill root — verified); OpenCode and Cursor also read it |

```bash
memai skill install                         # project scope, all agents (default)
memai skill install --agent claude          # one agent alias
memai skill install --global                # ~/.agents/skills + ~/.claude/skills
memai skill install --link --force          # symlink/junction; replace a differing target
memai skill list                            # installed / missing / differs
memai skill status                          # same, with a summary
```

The installer is content-hash idempotent (re-runs report `unchanged`, no timestamp churn), keeps
both copies byte-identical to the repo source, and never overwrites a different `memai` skill
directory without `--force`. Verify with `memai skill list` and the agent's own skill catalog
(Claude Code: `/skills`, then `/memai`). Per-agent roots and optional fallbacks:
[`docs/install.md#agent-skills-one-skill-every-agent`](docs/install.md#agent-skills-one-skill-every-agent).

## Verified here vs documented only

**Verified on this machine** (Windows 11, Node 24.14, SQLite 3.53):

- the store, extractor, pager, budget clamping, delta and board: **18/18**
  `node bench/selftest.mjs` checks pass;
- the benchmark numbers above (`node bench/bench.mjs`, rerun);
- the MCP stdio handshake, tool list (one `mem` tool by default, 11 granular
  tools under `MEMAI_GRANULAR_TOOLS=1`), `tools/call`, resources and the
  clean-stdout invariant (`node --test "test/*.test.mjs"`,
  `node scripts/mcp-probe.mjs`);
- `memai init` idempotency, instruction markers, hook payload shape and safe
  `.mcp.json` merging (`node --test "test/*.test.mjs"`);
- the DSH plugin against a fake host (`node adapters/dsh/test/apply.test.mjs`);
- Claude Code 2.1.140: project `.mcp.json` registration + health check,
  `claude mcp add -s project|user`, `${CLAUDE_PROJECT_DIR:-.}` expansion, and
  project settings hooks being loaded/fired by the CLI (no model calls made);
- OpenCode v2.2.5: the `mcp.servers` config shape, `opencode mcp add`, and the
  `opencode mcp list` health check showing `✓ memai connected` (a v1-era
  `mcp.memai` entry is ignored by v2);
- the `memai skill` installer: byte-identical copies in `.agents/skills` and
  `.claude/skills`, content-hash idempotency, `--force`/`--link`/`--global`
  behavior and the init integration (`node --test "test/*.test.mjs"`, 12 skill
  tests), plus Claude Code 2.1.140 skill discovery
  (`Loaded N unique skills (… project: 1 …)` after `memai skill install`).

**Documented only** (not installed on the build machine, so not executed): the
Codex config shape, the ZCode `mcp.servers`/process-hook shapes (taken from the
ZCode CLI source and README), the rendering of the injected card inside a live
model session, and the generic-MCP client entries (Cursor/Zed/Cline/Gemini,
with per-client links in `adapters/generic/`). Each adapter README says which is
which; if a vendor changes its schema, the adapter is the place to fix it — no
core code.

**Not claimed:** a production A/B. The benchmark and the replay are controlled
measurements; the next experiment is a real with/without trial (success bar:
≥5× fewer total tokens, ≥90% cache-hit share on the shared prefix, no accuracy
regression).

## Limitations

MemAi is honest about where paging loses. All of these are measured, not guessed:

- **Small tasks lose.** If the task needs one file under ~1.2 KB (~300 tokens)
  or one symbol, plain `read` is cheaper. Measured break-even: **≤ ~346 tokens
  (~1.3 KB)** of file bodies. Paging pays when the target is >~2 KB, when ≥2
  files are involved, or for a second question in the same session.
- **Query overhead is real.** A tool call costs ~45 tokens before content; many
  tiny queries lose to one full read. Use fewer, larger faults; stop when the
  question is answered.
- **The index can be stale.** Re-index after checkouts/edits (local, tens to
  hundreds of ms). `fault` reads the file from disk but line numbers come from
  the index — use `fault <path>:<line>` if exactness matters.
- **Extraction is regex-based.** One-line or dynamic constructs can be missed;
  `fault <path>:<line>` and raw `read` are the fallbacks.
- **Single store, single writer.** The board coordinates agents on one machine
  sharing one `.memai/mem.db`. Cross-machine sharing needs a shared path or a
  sync layer (not in v1).
- **Out-of-process agents don't inherit host context.** A DSH in-process plugin
  can inject the card into every in-process child; Claude Code / Codex /
  OpenCode / ZCode reach MemAi through MCP or the CLI, and inject the card via
  their own instruction/hook mechanism.
- **The DSH plugin is experimental.** `adapters/dsh/` is an in-process bundle
  that keeps its own board store (under `$DSH_HOME`) and reads pages produced by
  the indexer; it is tested against a fake host, not installed in a live profile.
  The supported way to use MemAi from DSH is the MCP server or the CLI.
- **Node.js ≥ 22.13.** The store uses the built-in `node:sqlite` (still marked
  experimental by Node; its warning is filtered so stdout stays clean JSON).
  There are no native modules.
- **No embeddings.** Structure first; semantic reranking is a possible future
  option for prose notes, not the core.

## Repository layout

```
src/          store (SQLite/WAL/FTS5), extractor, pager, token estimator, core CLI, skill installer
mcp/          stdio MCP server, tool definitions, resources, SessionStart hook
bin/          memai, memai-mcp executables (root resolution, init, skill, hook, mcp)
skills/       portable Agent Skills package (skills/memai/SKILL.md), installed by init / memai skill
adapters/     claude-code · codex · opencode · zcode · generic · dsh
bench/        fixture generator, corpora/tasks, benchmark, selftest, RESULTS.md
test/         unit + MCP protocol + init/hook/skill tests (node --test)
scripts/      mcp-probe.mjs (live handshake probe for CI/humans)
examples/     minimal copy-ready configs
tools/        token-estimator calibration against real session logs
docs/         install · compatibility · protocol · design · evidence · faq
PROTOCOL.md   normative page/version/delta/tool contract for implementers
```

## Docs

- [Install & per-agent setup](docs/install.md)
- [Compatibility matrix](docs/compatibility.md)
- [Protocol v1](docs/protocol.md) · normative [PROTOCOL.md](PROTOCOL.md)
- [Design & cost model](docs/design.md)
- [Evidence: where the tokens go](docs/evidence.md)
- [Benchmark results](bench/RESULTS.md)
- [FAQ](docs/faq.md)

## Development

```bash
node bench/selftest.mjs           # 18/18 end-to-end checks
node --test "test/*.test.mjs"     # unit + MCP protocol + init/hook/skill tests
node --check mcp/server.mjs       # syntax
node scripts/mcp-probe.mjs        # live JSON-RPC handshake + tool list
node bench/bench.mjs              # regenerate bench/RESULTS.md
```

There is nothing to install: zero dependencies, plain ESM `.mjs`. CI runs the
suite on Node 22 and 24 with no install step. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the adapter-adding guide and the documentation rules.

## License & security

MIT — see [LICENSE](LICENSE). MemAi is local-only and has no dependencies; it
never sends your code anywhere. Read [SECURITY.md](SECURITY.md) before indexing
repositories that contain secrets.
