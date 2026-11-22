# Guard — PreToolUse interception of whole-file reads (0.5.0 design)

Status: approved design, pre-implementation.
Date: 2026-11-22.

## Problem

MemAi changes what a model *can* page, not what it *does*. Instructions (skill,
`init` blocks) ask the model to prefer `fault` over whole-file reads; measured
sessions show that ask is not reliably followed as context grows, and 98.3% of
billed tokens on a real two-agent task were re-sent context, 91.4% of prompt
tokens were tool results riding the window for ~39 further steps
(`docs/evidence.md`).

The strongest lever left without retraining is **environment interception**: a
PreToolUse hook that denies a whole-file read above a measured threshold and
returns the index's signature page instead. The model does not have to choose
the cheap path; the cheap path is what happens.

## Goals

- Deny whole-file reads only when the paged alternative is **measurably
  cheaper**, and say exactly what to do next.
- Never break a session: hooks exit 0 always, are silent when not applicable,
  and every deny is overridable in one step.
- Ship on **verified** harness facts (below), and record what is verified vs
  assumed in `docs/compatibility.md`.
- Measurable: extend the 14-task benchmark with a guard simulation that picks
  the default threshold from data.

## Non-goals (v1)

- Intercepting `Bash: cat`, `Grep`, `Glob`, or LSP-style reads — documented
  bypass, not hidden.
- Per-symbol call-graph analysis to predict which symbols a task needs.
- Any change to page formats, MCP ops, or the store schema.
- Cross-harness config for adapters whose interception contract is unverified.

## Verified harness facts

| fact | evidence |
| --- | --- |
| Claude Code PreToolUse hooks can deny with a reason the model sees | `adapters/claude-code/README.md` (verified on 2.1.140), `docs/compatibility.md` |
| ZCode exposes a `PreToolUse` event with `matcher` + process hooks | `~/.zcode/cli/config.json` schema (`hooks.events.PreToolUse`, process hooks) |
| ZCode implements the same deny contract | strings in the installed `zcode.cjs` runtime: `permissionDecision`, `permissionDecisionReason`, `hookSpecificOutput`, `"deny"` |

The design therefore reuses one payload contract for both harnesses. Any
divergence discovered during implementation is recorded in
`docs/compatibility.md`, not papered over.

## Mechanism

A third hook verb next to the existing `memai hook card` (SessionStart) and
`memai hook index` (PostToolUse):

```
harness ──PreToolUse JSON on stdin──► memai hook guard
                                        │
              allow: exit 0, no stdout ◄─┤  (invisible, zero-token cost)
                                          │
    deny: stdout {hookSpecificOutput:{ ◄─┘
      hookEventName:"PreToolUse",
      permissionDecision:"deny",
      permissionDecisionReason:"<guard page>"}}
```

### PreToolUse invariants

1. **Exit 0 always.** Any internal error → allow. A guard must never be the
   reason a session fails.
2. **stdout is empty or one JSON object.** Diagnostics go to stderr only when
   `MEMAI_DEBUG=1`.
3. **Read shapes.** The hook is a guard only for whole-file reads: the tool name
   matches `Read` (Claude Code) or the configured ZCode equivalent, and neither
   `offset` nor `limit` is set. `file_path` is read from `tool_input.file_path`,
   falling back to `path` / `filePath` / `file`.
4. **Allow, always, when:** the path is outside the project root; the extension
   is binary/media; the file has no page in the store; the file changed on disk
   since the last index (a stale signature page would be a lie); the guard is
   disabled (`MEMAI_GUARD=off`, `guard.json {"enabled": false}`); or the path
   matches `guard.json`'s `allow` globs.

## Decision rule

Deny only when a full read is worth at least twice the paged alternative:

```
file_tokens  = ceil(bytes / 3.966)                  # same estimator as bench
sig_tokens   = tokens of the store's file page (signatures, clamped to 400)
deny  iff  bytes ≥ minBytes
       and file_tokens ≥ 2 × (sig_tokens + 400)     # 400 ≈ one default fault
```

The `+400` term is the measured cost of one typical `fault` (default budget
600, typical slice 300–500). The `2×` factor means the guard only fires where
paging halves the cost or better:

| file | full read | sig + 1 fault | decision |
| --- | --- | --- | --- |
| 1.3 KB | ~330 tok | ~450 tok | allow (deny would cost tokens) |
| 4 KB | ~1,000 tok | ~600 tok | allow at default floor |
| 8 KB | ~2,000 tok | ~900 tok | deny |
| 18 KB (`src/page.mjs`) | ~4,600 tok | ~1,000 tok | deny |

Configuration, resolved from `<root>/.memai/guard.json` then env:

```json
{
  "enabled": true,
  "minBytes": 8192,
  "allow": ["docs/**", "**/*.lock"],
  "toolNames": ["Read", "read_file"]
}
```

`MEMAI_GUARD=off` forces enabled=false. `minBytes` default 8192; the benchmark
simulation (below) is the evidence for that default. Missing/invalid
`guard.json` → defaults, never an error.

## Deny payload (the teaching moment)

The reason is a small page, ~500 tokens (400-token signature excerpt + header and
moves), shaped like every other MemAi page:

```
# MemAi guard — src/page.mjs withheld (18.2 KB ≈ 4,600 tok)
Whole-file reads above 8.0 KB return signatures first.
Signatures (index page):
  symbol map excerpts …
Next moves:
  fault query              # one body slice (~300–600 tok)
  fault evaluate --deep    # body + callers
```

The signature excerpt is the store's existing file page, clamped to 400 tokens;
the suggested symbols are the first three non-heading symbols with lines. The
override sentence is always present.

## Override semantics (revised 0.5.1)

The 0.5.0 design granted a repeat-read override (1 h TTL) and advertised it in the
deny page. The live A/B (`bench/GUARD-LIVE-ANALYSIS.md`) showed models take the
advertised offer immediately and pay deny + full read: **+62–65% billed input**.
0.5.1 removes it:

- **Repeat reads stay denied.** No session state grants a pass; the deny page
  does not mention any override.
- **Allowlist.** `guard.json` `allow` globs (project-relative, `**` supported)
  always pass.
- **Kill switch.** `MEMAI_GUARD=off` disables the hook entirely.

## Measurement

Add `bench/guard-sim.mjs` (reusing `bench/corpora.mjs`, kept out of the already-679-line
`bench.mjs`): for every file referenced by the 14 benchmark tasks, compare a whole-file
read against the guard-forced alternative (signature page at 400 tok + one fault
estimate) at thresholds 4 / 8 / 16 KB, and report per threshold: files denied,
intercepted share of naive-read tokens, forced/read savings ratio, and the worst
override penalty.

The default `minBytes` is validated by three criteria, all mechanically checkable:

- **(a) rule invariant** — every denied file satisfies `read ≥ 2 × forced`;
- **(b) share** — intercepted read tokens ≥ 25% of the naive-read total across tasks;
- **(c) override cost** — per-denial penalty (`sig + one tool call`) ≤ 500 tokens.

8 KB ships unless (b) fails there; then 4 KB is tried, provided (c) still holds. The
sim's output is committed next to the other benchmark records; if a criterion fails,
the default changes before merge — the number follows the data.

The live-harness A/B (same tasks, guard on vs off, real sessions) is documented as the
follow-up the maintainer runs; it is not claimed by this design.

## Surfaces (all four, per the PR #7 lesson)

| surface | change |
| --- | --- |
| CLI | `memai hook guard` in help; `memai guard status` prints effective config plus the deny count and last deny (allow decisions are never logged unless `MEMAI_DEBUG=1`) |
| MCP | none — guard is a CLI-side hook |
| skill (`skills/memai/SKILL.md`) | one line: reads above the guard threshold return signatures; repeats stay denied, config-level escapes only |
| init template (`src/init.mjs`) | one line in the injected block |
| adapters | `adapters/claude-code/settings-hooks.json` PreToolUse entry; `adapters/zcode/` PreToolUse snippet (verified shape); both READMEs state what was verified |
| `docs/compatibility.md` | guard row per harness: verified / documented-only |

## Tests

- Decision matrix: allow (small, unindexed, binary, stale, offset set, disabled,
  allowlisted, outside root) and deny (large indexed fresh) — table-driven.
- Payload shape: Claude Code and ZCode variants; stdout is empty-or-one-JSON;
  exit 0 on malformed stdin, missing store, and throwing store.
- Override: first deny, second allow (same session); different session still
  denied; TTL expiry re-denies.
- State file: atomic, pruned, tolerant of corruption.
- Bench simulation: asserts guard-forced totals and the chosen default.
- No regressions: full suite green; `node scripts/mcp-probe.mjs`.

## Risks

- **Threshold mis-calibration** → the simulation picks it; `guard.json` lets
  users tune it; the deny reason is honest about sizes.
- **Harness payload drift** → one `memai guard status --last` diagnostic and
  a "no decision" metric; any allow-on-error path is logged under
  `MEMAI_DEBUG=1`.
- **Annoyance** → one-step override always available; TTL not longer than 1 h.
- **Bypass** (`cat`, `Grep`) → documented in Limitations; the guard is a
  reduction, not a enforcement boundary.
