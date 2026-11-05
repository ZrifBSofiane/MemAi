// MCP transport + surface tests: raw JSON-RPC over stdio against mcp/server.mjs, bin/memai-mcp.mjs
// and `memai mcp`. No network, no model calls; Windows-safe (no POSIX-only APIs).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SELF, RpcClient, tempDir, makeCorpus, indexPath, textOf, assertProtocolClean } from '../scripts/test-helpers.mjs'

let root
let db
const cleanup = []

test.before(async () => {
  const dir = tempDir()
  cleanup.push(dir)
  root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  makeCorpus(root)
  const indexed = await indexPath(root, path.join(root, '.memai', 'mem.db'))
  db = indexed.dbPath
  assert.ok(fs.statSync(db).isFile(), 'test store should exist')
})

test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may hold the db briefly */ }
  }
})

function serverClient({ env = {} } = {}) {
  return RpcClient.spawn([SELF.server, '--root', root, '--db', db], { cwd: root, env })
}

async function withClient(fn, { env } = {}) {
  const client = serverClient({ env })
  try {
    return await fn(client)
  } finally {
    await client.shutdown()
  }
}

test('initialize negotiates the protocol version, advertises capabilities and instructions', async () => {
  await withClient(async (client) => {
    const res = await client.initialize()
    assert.equal(res.error, undefined)
    const r = res.result
    assert.equal(r.protocolVersion, '2025-06-18')
    assert.equal(r.serverInfo.name, 'memai-mcp')
    assert.equal(typeof r.serverInfo.version, 'string')
    assert.equal(r.capabilities.tools.listChanged, false)
    assert.equal(r.capabilities.resources.subscribe, false)
    assert.ok(r.capabilities.prompts, 'prompts capability missing')
    assert.equal(typeof r.instructions, 'string')
    assert.ok(r.instructions.length > 100, 'initialize.instructions should carry the paging contract')
    assert.match(r.instructions, /MemAi/)
    assert.match(r.instructions, /\{"op":"card"\}/)
    // Stdout must contain only that one response.
    assert.equal(client.stdoutLines.length, 1)
    assert.deepEqual(client.badStdoutLines, [])
  })
})

test('unsupported protocol version falls back to the latest supported one', async () => {
  await withClient(async (client) => {
    const res = await client.initialize({ protocolVersion: '1999-01-01' })
    assert.equal(res.result.protocolVersion, '2025-06-18')
  })
})

test('requests before initialize are rejected with -32002', async () => {
  await withClient(async (client) => {
    const res = await client.rpc('tools/list', {})
    assert.equal(res.error.code, -32002)
  })
})

test('tools/list default surface is exactly one tight `mem` tool', async () => {
  await withClient(async (client) => {
    await client.initialize()
    const res = await client.rpc('tools/list', {})
    assert.equal(res.error, undefined)
    const tools = res.result.tools
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'mem')
    assert.equal(tools[0].inputSchema.type, 'object')
    assert.deepEqual(tools[0].inputSchema.properties.op.enum,
      ['card', 'map', 'query', 'fault', 'get', 'diff', 'status', 'index', 'note', 'post', 'inbox'])
    assert.deepEqual(tools[0].inputSchema.required, ['op'])
    assert.equal(tools[0].inputSchema.additionalProperties, false)
    assert.ok(tools[0].description.length > 80)
    assert.match(tools[0].description, /346 tokens/)
  })
})

test('tools/call mem status, card, query, fault and index return token-headed text', async () => {
  await withClient(async (client) => {
    await client.initialize()

    const status = await client.rpc('tools/call', { name: 'mem', arguments: { op: 'status' } })
    assert.equal(status.error, undefined)
    assert.notEqual(status.result.isError, true)
    const statusText = textOf(status)
    assert.ok(statusText.length > 0)
    assert.match(statusText, /token/i)
    assert.match(statusText, /store|version|pages/i)

    const card = await client.rpc('tools/call', { name: 'mem', arguments: { op: 'card' } })
    assert.notEqual(card.result.isError, true)
    const cardText = textOf(card)
    assert.match(cardText, /MemAi|card/i)
    assert.ok((card.result.structuredContent?.tokens ?? 0) > 0)

    const query = await client.rpc('tools/call', { name: 'mem', arguments: { op: 'query', q: 'verifyToken' } })
    assert.notEqual(query.result.isError, true)
    assert.match(textOf(query), /verifyToken/)

    const fault = await client.rpc('tools/call', { name: 'mem', arguments: { op: 'fault', target: 'verifyToken' } })
    assert.notEqual(fault.result.isError, true)
    assert.match(textOf(fault), /verifyToken/)
    assert.match(textOf(fault), /token/, 'fault should include the symbol body lines')

    const indexed = await client.rpc('tools/call', { name: 'mem', arguments: { op: 'index' } })
    assert.notEqual(indexed.result.isError, true)
    assert.match(textOf(indexed), /index/i)
    assert.match(textOf(indexed), /0 model tokens/)
  })
})

test('tool errors are isError results or JSON-RPC errors, never silent successes', async () => {
  await withClient(async (client) => {
    await client.initialize()

    const noOp = await client.rpc('tools/call', { name: 'mem', arguments: {} })
    assert.equal(noOp.error, undefined)
    assert.equal(noOp.result.isError, true)
    assert.match(textOf(noOp), /unknown op/)

    const badTool = await client.rpc('tools/call', { name: 'mem_nope', arguments: {} })
    assert.equal(badTool.error.code, -32602)

    const granularDisabled = await client.rpc('tools/call', { name: 'mem_card', arguments: {} })
    assert.equal(granularDisabled.error.code, -32602)

    const missingPage = await client.rpc('tools/call', { name: 'mem', arguments: { op: 'get', pageId: 'file:does/not/exist.js' } })
    assert.equal(missingPage.error, undefined)
    assert.equal(missingPage.result.isError, true)
  })
})

test('unknown methods return -32601 and notifications never get a response', async () => {
  await withClient(async (client) => {
    await client.initialize()
    const res = await client.rpc('not/a/method', {})
    assert.equal(res.error.code, -32601)
    const before = client.stdoutLines.length
    client.notify('notifications/cancelled', { requestId: 1 })
    client.notify('some/unknown/notification', {})
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(client.stdoutLines.length, before, 'notifications must not produce stdout responses')
  })
})

test('resources/list and resources/read expose the card and file pages without a tool call', async () => {
  await withClient(async (client) => {
    await client.initialize()
    const list = await client.rpc('resources/list', {})
    assert.equal(list.error, undefined)
    const uris = list.result.resources.map((r) => r.uri)
    for (const uri of ['memai://card', 'memai://map', 'memai://status']) assert.ok(uris.includes(uri), `missing ${uri}`)
    // Page ids are URI-encoded in message content: memai://page/file%3Asrc%2Fauth.js
    const fileUris = uris
      .filter((u) => u.startsWith('memai://page/'))
      .map((u) => ({ uri: u, pageId: decodeURIComponent(u.slice('memai://page/'.length)) }))
    assert.ok(fileUris.length > 0, 'file pages should be listed')
    assert.ok(fileUris.some((p) => p.pageId === 'file:src/auth.js'), `expected a page for src/auth.js, got ${JSON.stringify(fileUris.map((p) => p.pageId))}`)
    for (const r of list.result.resources) {
      assert.equal(typeof r.name, 'string')
      assert.equal(typeof r.mimeType, 'string')
    }

    const card = await client.rpc('resources/read', { uri: 'memai://card' })
    assert.equal(card.error, undefined)
    assert.equal(card.result.contents[0].uri, 'memai://card')
    assert.ok(card.result.contents[0].text.length > 50)
    assert.equal(card.result.contents[0].mimeType, 'text/markdown')

    const fileUri = fileUris.find((p) => p.pageId === 'file:src/auth.js').uri
    const file = await client.rpc('resources/read', { uri: fileUri })
    assert.equal(file.error, undefined)
    assert.match(file.result.contents[0].text, /verifyToken/)

    const unknown = await client.rpc('resources/read', { uri: 'memai://nope' })
    assert.equal(unknown.error.code, -32002)
  })
})

test('prompts/list and prompts/get return the MemAi onboarding prompt', async () => {
  await withClient(async (client) => {
    await client.initialize()
    const list = await client.rpc('prompts/list', {})
    assert.equal(list.result.prompts[0].name, 'memai-card')
    const got = await client.rpc('prompts/get', { name: 'memai-card' })
    assert.equal(got.error, undefined)
    assert.equal(got.result.messages[0].role, 'user')
    assert.match(got.result.messages[0].content.text, /MemAi/)
  })
})

test('stdout stays protocol-clean through a full session and shutdown exits 0', async () => {
  const client = serverClient()
  await client.initialize()
  await client.rpc('tools/list', {})
  await client.rpc('resources/list', {})
  await client.rpc('prompts/list', {})
  const shutdown = await client.rpc('shutdown', {})
  assert.equal(shutdown.error, undefined)
  const code = await client.waitExit()
  assert.equal(code, 0)
  try { client.rl.close() } catch { /* noop */ }
  await assertProtocolClean(client, assert)
})

test('MEMAI_GRANULAR_TOOLS=1 exposes 11 granular tools and still serves data', async () => {
  await withClient(async (client) => {
    await client.initialize()
    const res = await client.rpc('tools/list', {})
    const names = res.result.tools.map((t) => t.name)
    assert.equal(names.length, 11)
    for (const name of ['mem_card', 'mem_map', 'mem_query', 'mem_fault', 'mem_get', 'mem_diff', 'mem_status', 'mem_index', 'mem_note', 'mem_post', 'mem_inbox']) {
      assert.ok(names.includes(name), `missing granular tool ${name}`)
    }
    const card = await client.rpc('tools/call', { name: 'mem_card', arguments: {} })
    assert.notEqual(card.result.isError, true)
    assert.ok(textOf(card).length > 0)
    const single = await client.rpc('tools/call', { name: 'mem', arguments: { op: 'card' } })
    assert.equal(single.error.code, -32602)
  }, { env: { MEMAI_GRANULAR_TOOLS: '1' } })
})

test('bin/memai-mcp.mjs starts the same server', async () => {
  const client = RpcClient.spawn([SELF.binMcp, '--root', root, '--db', db], { cwd: root })
  try {
    const res = await client.initialize()
    assert.equal(res.result.serverInfo.name, 'memai-mcp')
    const tools = await client.rpc('tools/list', {})
    assert.equal(tools.result.tools[0].name, 'mem')
    const call = await client.rpc('tools/call', { name: 'mem', arguments: { op: 'status' } })
    assert.notEqual(call.result.isError, true)
  } finally {
    const code = await client.shutdown()
    assert.equal(code, 0)
  }
})

test('`memai mcp` subcommand starts the MCP server', async () => {
  const client = RpcClient.spawn([SELF.bin, 'mcp', '--root', root, '--db', db], { cwd: root })
  try {
    const res = await client.initialize()
    assert.equal(res.result.serverInfo.name, 'memai-mcp')
    const call = await client.rpc('tools/call', { name: 'mem', arguments: { op: 'card' } })
    assert.notEqual(call.result.isError, true)
    assert.match(textOf(call), /token/i)
  } finally {
    const code = await client.shutdown()
    assert.equal(code, 0)
  }
})

test('parse errors get -32700 and invalid requests get -32600 without crashing', async () => {
  await withClient(async (client) => {
    await client.initialize()
    client.child.stdin.write('this is not json\n')
    const parseError = await client.waitForMessage((m) => m.error?.code === -32700)
    assert.ok(parseError, 'expected a -32700 parse error response')
    const invalid = await client.rpc('tools/call', { name: 123, arguments: 'nope' })
    assert.equal(invalid.error.code, -32602)
    const ping = await client.rpc('ping', {})
    assert.equal(ping.error, undefined)
  })
})
