# Live guard A/B — analysis (2026-11-22)

The first *behavioural* measurement of the read guard: real headless sessions,
billed tokens from the ZCode app DB, not a simulation. Result: **in the regime
where the guard fires, the shipped override policy makes it cost more than no
guard at all** — a negative result worth publishing.

Raw artifacts: [`guard-live-2026-11-22.md`](guard-live-2026-11-22.md) (run 2) and [`guard-live-2026-11-22-command.md`](guard-live-2026-11-22-command.md) (run 3).

## Setup

- Harness: ZCode 0.17.1, headless `-p/--prompt`, model `deepseek-flash`
  (provider `deepseek`), same model in both arms.
- Project: this repository with a fresh `.memai` index; the PreToolUse hook
  (`memai hook guard`) installed in `~/.zcode/cli/config.json` and **trusted
  through the app** (ZCode refuses to run untrusted hooks — see
  `adapters/zcode/README.md`).
- Arm control: `.memai/guard.json` `{"enabled": false}` (baseline) vs
  `{"enabled": true}` (treatment). The hook is installed in **both** arms, so
  its spawn overhead is identical.
- Measurement: `tools/zcode-session-report.mjs` over the app DB —
  `turn_usage` (billed input = input + cache-read + cache-write), `part` tool
  calls (inputs + outputs), and deny detection (a denied call is `status:
  error` with the reason in `metadata.modelContent`).
- Runner: `tools/guard-ab.mjs`.

## Run 1 — command prompts ("Read … in full")

| task | file | baseline billed-in | treatment billed-in | delta | treatment reads |
| --- | --- | --- | --- | --- | --- |
| T1 | src/page.mjs | *invalid run (empty session)* | 214,076 | — | 1 denied + 1 full read |
| T2 | src/store.mjs | 123,753 | 203,725 | **+64.6%** | 1 denied + 1 full read |
| T3 | src/extract.mjs | 129,386 | 209,598 | **+62.0%** | 1 denied + 1 full read |

Every treatment run shows the same trace: `Read` denied (492-token guard page),
then `Read` of the same path **again**, allowed by the session override, then
the full 50 KB body enters the context. The guard page is pure overhead on top
of the read it failed to prevent.

The first T1 baseline session was empty (one part, zero tokens) — an isolated
run failure, excluded rather than averaged in.

## Run 2 — question prompts (no "read in full" order)

Question-style tasks (e.g. "which function has the largest body?"), three tasks
× two arms. What actually happened:

| arm | tool mix (example) | whole-file reads | denies |
| --- | --- | --- | --- |
| baseline T1 | `mcp__memai__mem×3 Read×2` | 0 | 0 |
| baseline T2 | `Skill×1 mcp__memai__mem×1` | 0 | 0 |
| baseline T3 | `Bash×7 Skill×1` | 0 | 0 |
| treatment T1 | `mcp__memai__mem×3 Bash×1` | 0 | 0 |
| treatment T2 | `mcp__memai__mem×3 Read×3 Bash×3` | 0 | 0 |
| treatment T3 | `mcp__memai__mem×5 Skill×1` | 0 | 0 |

**The guard never fired.** The agent already has the MemAi MCP server, the
instruction block and the skill in this project, so it pages (MCP ops) and
takes *partial* reads (`offset`/`limit`) — it never attempts a whole-file read
above the threshold. Billed input varied 201K–652K across runs because the
exploration path differed; with zero interception events that variance says
nothing about the guard, so this run is context, not a comparison.

## Run 3 — command prompts, tightened guard (0.5.1: no override)

The 0.5.0 override and its advertisement were removed (`CHANGELOG` 0.5.1) and the
same command prompts were re-run.

| task | file | baseline billed-in | treatment billed-in | delta | treatment trace |
| --- | --- | --- | --- | --- | --- |
| C1 | src/page.mjs | 132,949 | 330,707 | **+148.7%** | 1 deny, then `Read×4` |
| C2 | src/store.mjs | 203,071 | 207,812 | +2.3% | 1 deny, `Bash×2` + `Read×1` |
| C3 | src/extract.mjs | 129,920 | 210,352 | **+61.9%** | 1 deny, then `Read×4` |

Zero whole-file reads completed in treatment — and **zero faults**. The model does
not retry the denied read; it switches to *partial* reads (`offset`/`limit`, always
allowed) and assembles the file across several calls. Chunking re-sends the context
per step, so the session costs more, not less. C2's smaller delta is the same
mechanism with fewer chunks.

So the deny does change behaviour — just not toward paging. When the task genuinely
needs the whole file, the guard converts one cheap read into several expensive ones.

## What this means (updated)

1. **Where instructions already work, the guard is inert** — no benefit, only
   the per-read hook spawn. Measured: zero whole-file reads and zero denies in
   both arms when the agent has MemAi's MCP tools and instruction block.
2. **Where the guard does fire, it makes the session more expensive.** 0.5.0's
   advertised override was taken immediately (+62–65%). 0.5.1 removed it; the
   model then chunked into partial reads (+2% to +149%), still never faulting.
3. **Therefore the guard does not save tokens in any measured regime.** It is a
   *policy* control (enforce "no whole-file reads") at a token cost, not a
   savings feature. The honest product options are: keep it **opt-in/off by
   default**, or retire it. The simulation's savings (80% of read tokens at 13%
   cost) assume the agent faults instead of chunking — a behaviour this model
   does not exhibit.

## Reproduce

```bash
# one-time: install + trust the hook (ZCode UI grants trust; config alone is inert)
# then:
node tools/guard-ab.mjs          # 3 tasks × 2 arms, writes bench/guard-live-<date>.{json,md}
node tools/zcode-session-report.mjs --session <sess_id>   # per-session detail
```
