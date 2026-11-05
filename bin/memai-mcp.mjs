#!/usr/bin/env node
// `memai-mcp` — stdio MCP server binary (thin wrapper around mcp/server.mjs).
//
// MCP clients spawn this as their `command`. It resolves the project root from
// --root / MEMAI_ROOT / the nearest .git|.memai ancestor / cwd, and the store
// from --db / MEMAI_DB / <root>/.memai/mem.db.
import { startServer } from '../mcp/server.mjs'

startServer()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[memai-mcp] fatal: ${err?.stack ?? err}\n`)
    process.exit(1)
  })
