// Offline test: loads index.js with a fake Cordis host, exercises the registrations and the mem tool.
// node test/apply.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, resolveDbPath } from '../index.js'

const dir = mkdtempSync(join(tmpdir(), 'mem-pages-'))
const dbPath = join(dir, 'mem.db')

// --- minimal Cordis-like context -------------------------------------------------
const disposers = []
const registered = { tools: [], sections: [], contexts: [] }
const ctx = {
  effect (fn, label) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return d
  },
  tools: { register: (tool) => (registered.tools.push(tool), () => {}) },
  systemPrompt: {
    section: (s) => (registered.sections.push(s), () => {}),
    context: (c) => (registered.contexts.push(c), () => {})
  }
}

apply(ctx, { dbPath, cardMaxTokens: 120 })

// --- assertions ------------------------------------------------------------------
assert.equal(registered.tools.length, 1, 'one tool registered')
const tool = registered.tools[0]
assert.equal(tool.name, 'mem')
assert.deepEqual(tool.parameters.required, ['op'])

assert.equal(registered.sections.length, 1, 'one guidance section')
assert.equal(registered.sections[0].name, 'memai:guidance')
assert.equal(registered.sections[0].order, 1500)

assert.equal(registered.contexts.length, 1, 'one card context')
const cardCtx = registered.contexts[0]
assert.equal(cardCtx.name, 'memai:project-card')
assert.equal(cardCtx.required, true, 'card must be a required context')
assert.equal(cardCtx.order, 130)
assert.equal(typeof cardCtx.text, 'function', 'card text is lazily rendered')

// empty store
assert.match(await tool.execute({ op: 'card' }, { agent: { id: 's1' } }), /no project card indexed/)

// seed pages the way an indexer would
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(dbPath)
const ins = db.prepare('INSERT OR REPLACE INTO pages (id, kind, version_hash, text, tokens, updated_at) VALUES (?,?,?,?,?,?)')
const card = 'app: atlas-api (Node ESM) · build: npm run build · test: npm test\nentry: src/server.js · src/app.js\nrule: never read node_modules'
ins.run('project.card@v1', 'project.card', 'v1', card, Math.ceil(card.length / 3.966), Date.now())
ins.run('project.map@v1', 'project.map', 'v1', 'src/server.js:12 startServer()\nsrc/db.js:8 connect()', 12, Date.now())
ins.run('file.page:src/server.js@v1', 'file.page', 'v1', 'export function startServer(port) - boots express app', 14, Date.now())
db.close()

const r = await tool.execute({ op: 'card' }, { agent: { id: 's1' } })
assert.ok(r.includes('atlas-api'), 'card op returns the card')
assert.ok(r.startsWith('tokens≈'), 'responses carry a token header')
assert.equal(cardCtx.text(), card, 'context renders the latest card')

const map = await tool.execute({ op: 'map' }, { agent: { id: 's1' } })
assert.ok(map.includes('startServer'), 'map op returns the symbol map')

const q = await tool.execute({ op: 'query', query: 'startServer' }, { agent: { id: 's1' } })
assert.ok(JSON.parse(q).length >= 2, 'query searches page text')

const f = await tool.execute({ op: 'fault', path: 'server.js' }, { agent: { id: 's1' } })
assert.ok(JSON.parse(f).some((p) => p.id.includes('file.page')), 'fault returns file pages by path')

assert.equal(await tool.execute({ op: 'post', topic: 'handoff', body: 'card v1 ready' }, { agent: { id: 'a1' } }), 'ok')
const inbox = JSON.parse(await tool.execute({ op: 'inbox', since: 0 }, { agent: { id: 'a2' } }))
assert.equal(inbox[0].agent, 'a1', 'board records the producing agent')
assert.equal(inbox[0].body, 'card v1 ready')

const diff = JSON.parse(await tool.execute({ op: 'diff', since: 0 }, { agent: { id: 's1' } }))
assert.ok(diff.length >= 3, 'diff lists pages newer than a version/time')

// dispose closes the store without throwing
for (const d of disposers) d()
rmSync(dir, { recursive: true, force: true })

console.log('PASS memai-dsh-adapter: registrations + mem tool + board + diff')
