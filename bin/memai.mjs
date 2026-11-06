#!/usr/bin/env node
// `memai` — the MemAi CLI entry point.
//
// Thin dispatch layer:
//   memai init ...        -> src/init.mjs (store + index + instruction blocks + configs + skill)
//   memai skill ...       -> src/skill.mjs (Agent Skills installer: install|list|status)
//   memai mcp ...         -> mcp/server.mjs (stdio MCP server)
//   memai hook card ...   -> mcp/hook.mjs (SessionStart additionalContext JSON)
//   memai <command> ...   -> src/cli.mjs core (index|status|card|map|diff|get|query|
//                            fault|note|post|inbox|agents|edit|merge), with the
//                            store defaulting to <root>/.memai/mem.db
//
// Root resolution: --root arg > MEMAI_ROOT > nearest ancestor with .git/.memai > cwd.
// Every forwarded command gets an explicit --root/--db so the public CLI and the
// MCP server always read the same store.
import path from 'node:path'
import fs from 'node:fs'
import { run, render } from '../src/mem-cli.mjs'
import { runInit } from '../src/init.mjs'
import { runSkillCommand } from '../src/skill.mjs'
import { startServer } from '../mcp/server.mjs'
import { hookCardPayload } from '../mcp/hook.mjs'
import { PRODUCT, VERSION, resolveRoot, resolveDb } from '../mcp/paths.mjs'

// The CLI reports the published package version (package.json is always shipped); the MCP
// server's advertised version lives in mcp/paths.mjs and is bumped separately there.
const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || VERSION } catch { return VERSION }
})()

const HELP = `${PRODUCT} ${PKG_VERSION} — paged project memory for coding agents

Usage:
  memai init [--agent claude|codex|opencode|zcode|dsh|generic|all] [--write-configs] [--no-skill] [--md]
             Create .memai/ store, index the repo, write instruction blocks
             (CLAUDE.md / AGENTS.md), ready MCP config snippets and the Agent Skills package.
  memai skill install|list|status [--agent NAME|all] [--global] [--link] [--force] [--root DIR]
                                  Install/verify the portable skill (skills/memai/) in the roots
                                  agents scan (.agents/skills, .claude/skills).
  memai mcp [--root DIR]          Run the stdio MCP server (same as memai-mcp).
  memai hook card [--event E]     Print Claude Code SessionStart hook JSON with the
                                  project card as additionalContext (--text for raw text).
  memai index [--max-files N] [--force]   Distil the repo into pages (local, 0 model tokens).
  memai status|card|map|diff|get|query|fault|note|post|inbox|agents|edit|merge ...
                                  Core paging commands (JSON on stdout, tokens on every reply).
  memai help                      This help.

Global: --root DIR  --db FILE  --text  --cpt N   (env: MEMAI_ROOT, MEMAI_DB, MEMAI_AGENT)

Examples:
  memai init --agent all
  memai skill install --agent all
  memai skill list
  memai card
  memai query "verify token" && memai fault verifyToken --budget 400
  memai diff --since <version>
`

function parseArgv(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++ } else flags[key] = true
    } else positional.push(a)
  }
  return { positional, flags }
}

/** Resolve the project root/db and inject them into forwarded core arguments. */
function forwardArgs(argv, parsed) {
  const suppressed = new Set(['root', 'db'])
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root' || a === '--db') { i++; continue }
    if (a.startsWith('--root=') || a.startsWith('--db=')) continue
    rest.push(a)
  }
  const root = resolveRoot({ root: parsed.flags.root === true ? null : parsed.flags.root })
  const db = resolveDb(root, { db: parsed.flags.db === true ? null : parsed.flags.db })
  return { rest, root, db, args: [...rest, `--root=${root}`, `--db=${db}`] }
}

async function main() {
  const argv = process.argv.slice(2)
  const parsed = parseArgv(argv)
  const cmd = parsed.positional[0] ?? 'help'
  const sub = parsed.positional[1] ?? ''

  if (cmd === '--version' || cmd === '-v' || cmd === 'version' || parsed.flags.version) {
    process.stdout.write(`${PRODUCT.toLowerCase()} ${PKG_VERSION}\n`)
    return 0
  }
  if (cmd === 'help' || parsed.flags.help) { process.stdout.write(HELP); return 0 }

  if (cmd === 'init') {
    const result = await runInit(argv, {})
    process.stdout.write((result.text ?? '') + (result.text?.endsWith('\n') ? '' : '\n'))
    return result.ok ? 0 : 1
  }

  if (cmd === 'skill') {
    const skillArgs = argv.slice(argv.indexOf('skill') + 1)
    const root = resolveRoot({ root: parsed.flags.root === true ? null : parsed.flags.root })
    const result = runSkillCommand(skillArgs, { root, env: process.env, cwd: process.cwd() })
    if (result.text) process.stdout.write(result.text)
    return result.code
  }

  if (cmd === 'mcp') {
    const mcpArgs = argv.slice(argv.indexOf('mcp') + 1)
    await startServer({ argv: mcpArgs })
    return 0
  }

  if (cmd === 'hook') {
    if (sub !== 'card' && sub !== 'session-start') {
      process.stderr.write('usage: memai hook card [--event SessionStart|SubagentStart] [--text] [--root DIR]\n')
      return 2
    }
    const event = sub === 'session-start' ? 'SessionStart'
      : parsed.flags.event && parsed.flags.event !== true ? String(parsed.flags.event) : 'SessionStart'
    const root = resolveRoot({ root: parsed.flags.root === true ? null : parsed.flags.root })
    const db = resolveDb(root, { db: parsed.flags.db === true ? null : parsed.flags.db })
    try {
      const payload = hookCardPayload({ root, db, event })
      if (parsed.flags.text) process.stdout.write(payload.text ? payload.text + '\n' : '')
      // No card yet -> print nothing at all. A SessionStart/SubagentStart hook may stay silent;
      // printing `{}` would still be valid JSON but this keeps hook output truly side-effect free.
      else if (payload.json) process.stdout.write(JSON.stringify(payload.json) + '\n')
      return 0
    } catch (err) {
      process.stderr.write(`[memai hook] ${err?.message ?? err}\n`)
      return 0 // never break a session start
    }
  }

  // Everything else is the core paging CLI, pinned to this project's store.
  const forwarded = forwardArgs(argv, parsed)
  const result = await run(forwarded.args)
  process.stdout.write(render(result, { text: !!parsed.flags.text || !!parsed.flags.t }) + '\n')
  return result.ok ? 0 : 1
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[memai] fatal: ${err?.stack ?? err}\n`)
    process.exit(1)
  })
