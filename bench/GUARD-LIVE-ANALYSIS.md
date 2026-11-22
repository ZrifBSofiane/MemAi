# Live guard A/B — analysis (2026-11-22)

The first *behavioural* measurement of the read guard: real headless sessions,
billed tokens from the ZCode app DB, not a simulation. Result: **in the regime
where the guard fires, the shipped override policy makes it cost more than no
guard at all** — a negative result worth publishing.

Raw run-2 artifact: [`guard-live-2026-11-22.md`](guard-live-2026-11-22.md).

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

## What this means

1. **Where instructions already work, the guard is inert** — no benefit, only
   the per-read hook spawn. That is consistent with the design premise ("for
   models that ignore instructions"), but it means the guard's value cannot be
   shown in a repo where the MemAi instruction surfaces are present.
2. **Where the guard does fire, the advertised override defeats it.** The deny
   page says "Read this path again to override for this session"; the model
   takes that offer immediately and the session pays deny + full read. Measured
   cost: **+62–65% billed input** versus no guard.
3. The next iteration is therefore a *design* change, not another prompt trick:
   remove the override invitation from the deny page and stop granting the
   override on a repeat read by default (explicit allowlist / env only), then
   re-measure the command-prompt regime. If models then fault instead of
   retrying, the guard works; if they loop on denied reads, the guard should
   stay opt-in and this document says why.

## Reproduce

```bash
# one-time: install + trust the hook (ZCode UI grants trust; config alone is inert)
# then:
node tools/guard-ab.mjs          # 3 tasks × 2 arms, writes bench/guard-live-<date>.{json,md}
node tools/zcode-session-report.mjs --session <sess_id>   # per-session detail
```
