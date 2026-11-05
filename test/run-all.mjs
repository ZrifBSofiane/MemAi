// Entry point that makes `node --test test/` work on Node 24.x.
//
// Node 24.14 resolves a directory positional argument as a module entry (CJS/ESM resolution) rather
// than recursively discovering test files, so without this file `node --test test/` fails with
// "Cannot find module '…/test'" (verified on v24.14.0, Windows and POSIX argument forms). The
// package.json next to this file points `main` here, and this module imports the suites, so the
// single-file form runs them all in one process.
//
// The preferred invocation (per-file isolation) is still:
//   node --test "test/*.test.mjs"
// which skips this file entirely (it does not match the glob).
import './mcp.test.mjs'
import './init.test.mjs'
import './hook.test.mjs'
