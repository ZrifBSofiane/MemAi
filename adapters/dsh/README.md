# MemAi — DeepSeek Harness (DSH) adapter

A persistent DSH bundle that gives **every in-process agent** (lead, spawned subagent, forked subagent, team
member) a *tiny* project card in its runtime context, plus one `mem` tool that pages project knowledge in on
demand instead of re-reading files. It is the DSH-native half of MemAi; the cross-agent path is the MCP
server or the CLI (see the repo root [`README.md`](../../README.md) and [`docs/install.md`](../../docs/install.md)).

Why a native adapter at all: DSH has a first-class *required runtime context*, so the card is injected
automatically, append-only and cache-stable — no hook, no tool call, no per-session prompt build. MCP/CLI
agents get the same pages, but they have to call `mem`/`memai` to see them.

## How it works

| Piece | Mechanism | Why |
| --- | --- | --- |
| Project card in every agent | `systemPrompt.context({ name: 'memai:project-card', order: 130, required: true, text: () => cardText() })` at profile scope | reaches every in-process agent; append-only + deduped, so an unchanged card costs nothing and never rewrites the cached prefix; a *required* context also survives compaction and complete-mode personas |
| Static instructions | `systemPrompt.section({ order: 1500 })` | guidance belongs in the cached system prefix; it must never change per step |
| On-demand paging | one plain-object `tools.register({ name: 'mem', … })` tool | a tool call is ~150–400 tokens; a whole-file read is ~2–3k, and that result then rides in context for every later step |
| Shared board | `board` table in the same SQLite store (`note`/`post`/`inbox`) | agent-to-agent state without steering messages; delivery is pull/next-step, not mid-step prefix mutation |

The plugin is dependency-free: linked workspace bundles cannot import `@deepseek-ai/*`, so it uses only
`node:` builtins and the runtime service objects (`systemPrompt`, `tools`). Storage is the core MemAi SQLite
store (`pages` table), so the CLI and this adapter can share one database.

## Config

`cordis.patch.yml` (installed row); config is applied unvalidated, defaults in code:

```yaml
- insert:
    - id: memai
      name: '@local/dsh-memai'
      config:
        dbPath: ''          # empty -> $DSH_HOME/memai/mem.db; point it at <project>/.memai/mem.db to share with the CLI
        cardMaxTokens: 120  # header-only soft cap; the card text is bounded by the indexer
        toolName: 'mem'
```

## Install

```powershell
# from the DSH Web GUI / agent: plugin_manager({ action: 'install_bundle', target: '<abs path to adapters/dsh>' })
```

`install_bundle` performs the profile `package.json` + `cordis.patch.yml` edits; do **not** hand-edit the
profile or run pnpm. Install requires approval; after install a new session shows the card as a sourced
runtime-context snapshot.

## Seed the store

The adapter only *reads* pages. Generate them with the MemAi CLI (zero model tokens):

```powershell
npx -y memai-cli index --root C:\path\to\project
npx -y memai-cli status
```

Then point the adapter at that database (`dbPath: 'C:\path\to\project\.memai\memai.db'`), or run the
indexer with `--db`/`MEMAI_DB` to write to `$DSH_HOME/memai/mem.db` instead.

## Test

```powershell
node --check index.js
node test/apply.test.mjs   # fake Cordis host: registrations, card rendering, mem ops, board, diff, dispose
```

## Limits

- **Out-of-process subagents** (ACP / SDK / Codex / Claude Code) never see host plugin context — only
  in-process spawn/fork/team children do.
- The card must stay tiny and rarely change: per-step churn would burn the prefix-cache savings it exists
  to create. Batch page rebuilds; treat a merge as a deliberate cache reset.
- No custom third-party session event types and no cross-process bus: per-session cursors and the board
  live in this adapter's SQLite, owned by one host process.
