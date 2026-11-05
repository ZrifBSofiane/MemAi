# Contributing to MemAi

Thanks for helping. MemAi is a small, dependency-free Node.js project with an
unusual design constraint: **the product is the output bytes**, so every change
is judged first on how many tokens it makes a model ingest.

## Development setup

You need Node.js ≥ 22.13 (the store uses the built-in `node:sqlite`) and `git`.
There is **nothing to install** — no `npm install`, no build step.

```bash
node bench/selftest.mjs        # 18/18 end-to-end checks: index, paging, budget, diff, merge
node --test "test/*.test.mjs"  # unit + MCP protocol + init/hook tests
node --check mcp/server.mjs    # syntax check
node scripts/mcp-probe.mjs     # live JSON-RPC handshake + tool list
node bench/bench.mjs           # regenerate bench/RESULTS.md (slow; needs the fixtures)
```

The same commands are wired as `npm run selftest`, `npm test`, `npm run probe`
and `npm run bench` (no install required to run them).

`node bench/bench.mjs` writes `bench/results.json` and `bench/RESULTS.md`. Do not
hand-edit those files; rerun the benchmark and commit both.

## Ground rules

- **Zero dependencies.** Only `node:` builtins and the code in this repo. PRs
  that add a runtime dependency will be declined; dev-only tooling is also
  discouraged.
- **ESM `.mjs` only.** No transpilers, no TypeScript in the shipped tree.
- **Determinism is a feature.** Same tree → same hashes → same bytes. Do not put
  timestamps, session ids, absolute paths, random ids or environment-dependent
  ordering into page content; it breaks content addressing and prefix caching.
- **Respect the write scopes.** The store layer (`src/store.mjs`, `src/page.mjs`,
  `src/extract.mjs`) has one owner per change; do not reformat it in unrelated
  PRs. Additive changes beat rewrites.
- **Token accounting is normative.** Every command response keeps `tokens` and
  respects `--budget`. If you add a command, add it to `PROTOCOL.md` and
  `docs/protocol.md`, and clamp it.
- **Never inline what can be referenced.** New pages should carry `path:line`
  anchors and page ids, not pasted bodies.

## Adding an adapter

An adapter is documentation plus config, not code:

1. Create `adapters/<agent>/` with a `README.md` stating exactly what is
   verified on a real install and what is copied from vendor docs.
2. Add the MCP snippet (`mcpServers` / `servers` / TOML — match the vendor's
   documented key; do not invent keys).
3. Add the instruction block for that agent's file (`CLAUDE.md`, `AGENTS.md`,
   rules dir). Keep the `<!-- memai:start -->` / `<!-- memai:end -->` markers so
   `memai init` can update it idempotently.
4. If the agent has session hooks, wire `memai hook card` and say how you tested
   it. If not, say so in the README.
5. Add the adapter directory, then mention it in `docs/install.md` (setup steps),
   `docs/compatibility.md` (the evidence matrix) and, if it changes the support
   level, in the compatibility table in `README.md`. Mark the support level
   honestly: *verified* (say the version and how you tested), *documented*
   (link the vendor doc), or *unknown/fallback*.

## Documentation rules

- Cite measured numbers from `bench/RESULTS.md`, never invented ones. If a
  number is a counterfactual or an assumption, say so in the same sentence.
- Label claims **verified on this machine** (with the agent's version) or
  **documented only** (with a link), and keep
  [`docs/compatibility.md`](docs/compatibility.md) as the single place that
  records which is which.
- No absolute paths, usernames, session ids, API keys or host-specific details
  in public docs. Examples use relative paths and generic placeholders.
- Keep the root `PROTOCOL.md` and `docs/protocol.md` consistent. The root file is
  the normative contract; the docs copy is the readable version.
- Keep the product identifiers stable: repo **MemAi**, CLI `memai`, npm package
  `memai-cli`, MCP binary `memai-mcp`, store `.memai/`, root env `MEMAI_ROOT`.

## Pull requests

1. Run the four verification commands above; paste their output in the PR.
2. Keep the diff scoped. Mixed refactor + feature PRs are hard to review.
3. If behaviour changes, update `CHANGELOG.md` under *Unreleased*.
4. If token/benchmark numbers change, rerun the benchmark and explain the delta.
5. New config keys or CLI flags need a docs update in the same PR
   (`docs/install.md` for user-facing setup, `docs/protocol.md` + `PROTOCOL.md`
   for the contract).

## Code of conduct

Be civil and technical. Critique bytes, not people. Reports of harassment can go
to the maintainers via the security contact in `SECURITY.md`.
