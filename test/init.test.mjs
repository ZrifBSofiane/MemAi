// `memai init` tests: store creation, idempotency, instruction markers, config merges.
// Each test runs in its own temp directory; no network, no git commands, no model calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SELF, tempDir, makeCorpus, runNode } from '../scripts/test-helpers.mjs'

const read = (file) => fs.readFileSync(file, 'utf8')
const readJson = (file) => JSON.parse(read(file))
const exists = (file) => fs.existsSync(file)
const count = (text, needle) => text.split(needle).length - 1

const cleanup = []
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may hold the db briefly */ }
  }
})

function projectWithExistingConfigs() {
  const dir = tempDir()
  cleanup.push(dir)
  const root = diffRoot(dir)
  makeCorpus(root)
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({
    mcpServers: { other: { command: 'node', args: ['other-server.mjs'] } },
    customKey: { keep: true },
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(root, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: { servers: { other: { type: 'local', command: ['node', 'other.js'] } } },
    theme: 'kept',
  }, null, 2) + '\n')
  return root
}

const diffRoot = (dir) => path.join(dir, 'project')

function initArgs(root, extra = []) {
  return [SELF.bin, 'init', '--root', root, '--agent', 'all', ...extra]
}

test('memai init creates .memai/, indexes locally, and writes instruction + config files', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = diffRoot(dir)
  makeCorpus(root)

  const res = await runNode(initArgs(root, ['--write-configs']), { cwd: root })
  assert.equal(res.code, 0, `init failed: ${res.stdout}\n${res.stderr}`)
  assert.match(res.stdout, /MemAi init/)
  assert.match(res.stdout, /store: \.memai[\\/]mem\.db \(created\)/)
  assert.match(res.stdout, /index: \d+ files/)
  assert.match(res.stdout, /0 model tokens/)
  assert.ok(exists(path.join(root, '.memai', 'mem.db')), 'store missing')

  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = path.join(root, name)
    assert.ok(exists(file), `${name} missing`)
    const text = read(file)
    assert.equal(count(text, '<!-- memai:start -->'), 1, `${name} should have exactly one start marker`)
    assert.equal(count(text, '<!-- memai:end -->'), 1, `${name} should have exactly one end marker`)
    assert.match(text, /paged project memory/i)
    assert.match(text, /op":"card"/)
  }

  const snippets = [
    'claude-mcp.json', 'generic-mcp.json', 'opencode.json', 'zcode-config.json',
    'codex-config.toml', 'claude-settings-hooks.json',
  ]
  for (const name of snippets) assert.ok(exists(path.join(root, '.memai', 'configs', name)), `config snippet ${name} missing`)

  // OpenCode v2 shape: mcp.servers.memai (a bare mcp.memai is ignored by v2, verified).
  const opencode = readJson(path.join(root, 'opencode.json'))
  assert.ok(opencode.mcp.servers.memai, 'opencode.json should have mcp.servers.memai')
  assert.equal(opencode.mcp.servers.memai.type, 'local')
  assert.ok(Array.isArray(opencode.mcp.servers.memai.command))
  assert.equal(opencode.mcp.memai, undefined, 'v1 mcp.memai shape must not be written')
  assert.equal(opencode.mcp.servers.memai.enabled, undefined, 'v2 does not read `enabled`')

  // Claude Code project scope: mcpServers.memai with type + command + args.
  const mcp = readJson(path.join(root, '.mcp.json'))
  assert.equal(mcp.mcpServers.memai.type, 'stdio')
  assert.equal(typeof mcp.mcpServers.memai.command, 'string')
  assert.ok(Array.isArray(mcp.mcpServers.memai.args))

  // ZCode hook snippet uses its documented `process` argv shape.
  const zcode = readJson(path.join(root, '.memai', 'configs', 'zcode-config.json'))
  assert.ok(zcode.mcp.servers.memai)
  assert.equal(zcode.hooks.enabled, true)
  const zcodeHook = zcode.hooks.events.SessionStart[0].hooks[0]
  assert.equal(zcodeHook.type, 'process')
  assert.deepEqual(zcodeHook.args.slice(-2), ['hook', 'card'])
})

test('a second init run is idempotent and preserves existing config keys', async () => {
  const root = projectWithExistingConfigs()

  const first = await runNode(initArgs(root, ['--write-configs']), { cwd: root })
  assert.equal(first.code, 0, first.stdout + first.stderr)

  const mcpAfterFirst = read(path.join(root, '.mcp.json'))
  const opencodeAfterFirst = read(path.join(root, 'opencode.json'))
  const claudeAfterFirst = read(path.join(root, 'CLAUDE.md'))
  const agentsAfterFirst = read(path.join(root, 'AGENTS.md'))

  // Existing keys survive the merge.
  const mcp = JSON.parse(mcpAfterFirst)
  assert.ok(mcp.mcpServers.other, '.mcp.json lost the pre-existing server')
  assert.ok(mcp.mcpServers.memai, '.mcp.json missing the memai entry')
  assert.deepEqual(mcp.customKey, { keep: true }, '.mcp.json lost an unrelated top-level key')
  const opencode = JSON.parse(opencodeAfterFirst)
  assert.ok(opencode.mcp.servers.other, 'opencode.json lost the pre-existing server')
  assert.equal(opencode.theme, 'kept', 'opencode.json lost an unrelated key')
  assert.ok(opencode.mcp.servers.memai, 'opencode.json missing the memai entry')

  const second = await runNode(initArgs(root, ['--write-configs']), { cwd: root })
  assert.equal(second.code, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /changed: 0 file\(s\)/)
  // The first run's instruction/config files become indexable input on the next run, so the
  // index settles on the run after that; from then on it is fully unchanged.
  const third = await runNode(initArgs(root, ['--write-configs']), { cwd: root })
  assert.equal(third.code, 0, third.stdout + third.stderr)
  assert.match(third.stdout, /changed: 0 file\(s\)/)
  assert.match(third.stdout, /index: unchanged/)

  assert.equal(read(path.join(root, '.mcp.json')), mcpAfterFirst, '.mcp.json changed on the second run')
  assert.equal(read(path.join(root, 'opencode.json')), opencodeAfterFirst, 'opencode.json changed on the second run')
  assert.equal(read(path.join(root, 'CLAUDE.md')), claudeAfterFirst, 'CLAUDE.md changed on the second run')
  assert.equal(read(path.join(root, 'AGENTS.md')), agentsAfterFirst, 'AGENTS.md changed on the second run')
  assert.equal(count(claudeAfterFirst, '<!-- memai:start -->'), 1)
  assert.equal(count(agentsAfterFirst, '<!-- memai:start -->'), 1)
})

test('an unrelated instruction file is preserved and the block is appended', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = diffRoot(dir)
  makeCorpus(root)
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Existing instructions\n\nKeep me.\n')

  const res = await runNode(initArgs(root, ['--agent', 'generic']), { cwd: root })
  assert.equal(res.code, 0, res.stdout + res.stderr)
  const text = read(path.join(root, 'AGENTS.md'))
  assert.match(text, /# Existing instructions/)
  assert.match(text, /Keep me\./)
  assert.equal(count(text, '<!-- memai:start -->'), 1)
})

test('a partial marker pair is refused instead of duplicated', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = diffRoot(dir)
  makeCorpus(root)
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n\n<!-- memai:start -->\nhalf a block\n')

  const res = await runNode(initArgs(root, ['--agent', 'claude']), { cwd: root })
  assert.equal(res.code, 1, 'init should fail on a partial marker block')
  assert.match(res.stdout + res.stderr, /partial MemAi marker block/)
  assert.ok(exists(path.join(root, '.memai', 'mem.db')), 'store may already exist from the index step')
})

test('--md previews the instruction block and writes nothing', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = diffRoot(dir)
  makeCorpus(root)

  const res = await runNode(initArgs(root, ['--md']), { cwd: root })
  assert.equal(res.code, 0, res.stdout + res.stderr)
  assert.match(res.stdout, /init preview/)
  assert.match(res.stdout, /CLAUDE\.md/)
  assert.match(res.stdout, /AGENTS\.md/)
  assert.equal(exists(path.join(root, '.memai')), false, '--md must not create the store')
  assert.equal(exists(path.join(root, 'CLAUDE.md')), false, '--md must not write CLAUDE.md')
})

test('--no-index creates the store without indexing', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = diffRoot(dir)
  makeCorpus(root)
  const res = await runNode(initArgs(root, ['--no-index']), { cwd: root })
  assert.equal(res.code, 0, res.stdout + res.stderr)
  assert.match(res.stdout, /index: skipped \(--no-index\)/)
  assert.ok(exists(path.join(root, '.memai', 'mem.db')))
})

test('an invalid --agent name fails with a clear message', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = diffRoot(dir)
  makeCorpus(root)
  const res = await runNode([SELF.bin, 'init', '--root', root, '--agent', 'nope'], { cwd: root })
  assert.equal(res.code, 1)
  assert.match(res.stdout + res.stderr, /unknown agent: nope/)
})
