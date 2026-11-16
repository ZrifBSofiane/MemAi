// Watcher + hook-index tests: the daemon must keep the store fresh without
// anyone remembering to run `memai index`, and `memai hook index` must distil
// an edited file silently and never fail a session.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { SELF, tempDir, makeCorpus, indexPath, runNode } from '../scripts/test-helpers.mjs'
import { eventToRel, planBatch, FULL_KEY } from '../src/watch.mjs'
import { MemoryStore } from '../src/store.mjs'

const cleanup = []
const watchers = [] // roots with a possibly-running daemon; --stop in test.after
test.after(async () => {
  for (const root of watchers) {
    try { await runNode([SELF.bin, 'watch', '--stop', '--root', root], { cwd: root }) } catch { /* already gone */ }
  }
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may hold the db briefly */ }
  }
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Index a corpus fixture and register it for daemon cleanup. */
async function indexedProject() {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  makeCorpus(root)
  await indexPath(root)
  watchers.push(root)
  return root
}

const lastVersion = (root) => {
  const store = new MemoryStore({ dbPath: path.join(root, '.memai', 'mem.db'), root, create: false })
  try { return store.getMeta('last_version') } finally { store.close() }
}

test('eventToRel: windows paths, .memai and non-indexable files are filtered, null filename = full sync', () => {
  const rules = []
  assert.equal(eventToRel('D:/proj', rules, 'src\\auth.js'), 'src/auth.js')
  assert.equal(eventToRel('D:/proj', rules, 'D:/proj/src/auth.js'), 'src/auth.js', 'absolute event paths are relativised')
  assert.equal(eventToRel('D:/proj', rules, '.memai/mem.db'), null, 'the daemon must not react to its own writes')
  assert.equal(eventToRel('D:/proj', rules, '.memai'), null)
  assert.equal(eventToRel('D:/proj', rules, 'image.png'), null)
  assert.equal(eventToRel('D:/proj', rules, 'node_modules/pkg/index.js'), null)
  assert.equal(eventToRel('D:/proj', rules, null), FULL_KEY)
})

test('planBatch: small batches incremental, bursts and the sentinel go full', () => {
  assert.deepEqual(planBatch(['a.js', 'b.js']), { mode: 'files', paths: ['a.js', 'b.js'] })
  assert.equal(planBatch([FULL_KEY, 'a.js']).mode, 'full')
  assert.equal(planBatch(Array.from({ length: 51 }, (_, i) => `${i}.js`)).mode, 'full')
  assert.equal(planBatch([]).mode, 'full', 'empty batch = nothing to do, full pass is the safe no-op')
})

test('watch --status and --ensure are harmless without a store', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'README.md'), '# no store\n')

  const st = await runNode([SELF.bin, 'watch', '--status', '--root', root], { cwd: root })
  assert.equal(st.code, 0, st.stderr)
  const status = JSON.parse(st.stdout.trim())
  assert.equal(status.running, false)
  assert.equal(status.version ?? null, null)

  const en = await runNode([SELF.bin, 'watch', '--ensure', '--root', root], { cwd: root })
  assert.equal(en.code, 0, 'ensure must never fail a session')
  assert.equal(fs.existsSync(path.join(root, '.memai')), false, 'ensure must not create a store')
})

test('detached watcher distils external edits into a fresher store', async () => {
  const root = await indexedProject()
  const before = lastVersion(root)

  const en = await runNode([SELF.bin, 'watch', '--ensure', '--root', root], { cwd: root })
  assert.equal(en.code, 0, en.stderr)
  assert.match(en.stdout, /watch (started|already running)/)

  // External edit — nobody runs `memai index`.
  fs.appendFileSync(path.join(root, 'src', 'auth.js'), '\nexport function watcherProbe() { return "seen by the daemon" }\n')

  // Wait for the daemon to fold the edit in (debounce 800ms + distil).
  let fresh = false
  for (let i = 0; i < 100 && !fresh; i++) {
    await sleep(200)
    fresh = lastVersion(root) !== before
  }
  assert.ok(fresh, 'watcher must update the store version after an external edit')

  const q = await runNode([SELF.bin, 'query', 'watcherProbe', '--root', root], { cwd: root })
  assert.equal(q.code, 0, q.stderr)
  const parsed = JSON.parse(q.stdout.trim())
  assert.equal(parsed.ok, true)
  assert.ok(parsed.hits.length >= 1, 'the new symbol must be queryable')
  assert.equal(parsed.hits[0].stale, false, 'and it must not be flagged stale')

  const stop = await runNode([SELF.bin, 'watch', '--stop', '--root', root], { cwd: root })
  assert.equal(stop.code, 0, stop.stderr)
  assert.match(stop.stdout, /watch stopped/)
  assert.equal(fs.existsSync(path.join(root, '.memai', 'watch.pid')), false, 'pidfile cleaned on stop')
})

test('memai hook index distils the edited file and stays silent on failure', async () => {
  const root = await indexedProject()
  const before = lastVersion(root)

  const file = path.join(root, 'src', 'billing.js')
  fs.appendFileSync(file, '\nexport function hookProbe() { return "indexed by the hook" }\n')
  const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file } })

  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF.bin, 'hook', 'index', '--root', root], {
      cwd: root, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.stdin.write(payload + '\n')
    child.stdin.end()
    child.once('exit', (code) => resolve({ code, stdout, stderr }))
    setTimeout(() => { try { child.kill() } catch { /* noop */ } }, 30000)
  })
  assert.equal(res.code, 0, `hook must never fail: ${res.stderr}`)
  assert.equal(res.stdout.trim(), '', 'hook index stays silent on stdout')

  assert.notEqual(lastVersion(root), before, 'hook index must update the store')
  const q = await runNode([SELF.bin, 'query', 'hookProbe', '--root', root], { cwd: root })
  assert.ok(JSON.parse(q.stdout.trim()).hits.length >= 1, 'hook-indexed symbol queryable')

  // No file_path / malformed payload: silent no-op, exit 0.
  for (const bad of ['', '{"tool_name":"Edit"}', 'not json at all']) {
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [SELF.bin, 'hook', 'index', '--root', root], {
        cwd: root, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      })
      let stdout = ''
      child.stdout.on('data', (d) => { stdout += d })
      child.stdin.end(bad)
      child.once('exit', (code) => resolve({ code, stdout }))
      setTimeout(() => { try { child.kill() } catch { /* noop */ } }, 10000)
    })
    assert.equal(r.code, 0, `malformed payload "${bad}" must stay a no-op`)
    assert.equal(r.stdout.trim(), '')
  }
})

test('hook index finds the owning project from the file path alone', async () => {
  const dir = tempDir()
  cleanup.push(dir)
  const root = path.join(dir, 'project')
  fs.mkdirSync(path.join(root, 'deep', 'nested'), { recursive: true })
  makeCorpus(root)
  await indexPath(root)
  const before = lastVersion(root)

  // No --root: the hook must discover the project by walking up from the file.
  const nestedFile = path.join(root, 'deep', 'nested', 'probe.js')
  fs.writeFileSync(nestedFile, 'export function nestedProbe() { return 1 }\n')
  const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: nestedFile } })

  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF.bin, 'hook', 'index'], {
      cwd: path.join(root, 'deep', 'nested'), env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.stdin.write(payload + '\n')
    child.stdin.end()
    child.once('exit', (code) => resolve({ code, stderr }))
    setTimeout(() => { try { child.kill() } catch { /* noop */ } }, 30000)
  })
  assert.equal(res.code, 0, res.stderr)
  assert.notEqual(lastVersion(root), before, 'store of the ancestor project must be updated')
  const q = await runNode([SELF.bin, 'query', 'nestedProbe', '--root', root], { cwd: root })
  assert.ok(JSON.parse(q.stdout.trim()).hits.length >= 1)
})
