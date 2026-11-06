// Agent Skills tests: canonical frontmatter portability, installer behavior (copy/link/global/
// idempotency/force), list/status output, and `memai init` integration.
// No network, no model calls, temp directories only, Windows-safe.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SELF, REPO, tempDir, makeCorpus, runNode } from '../scripts/test-helpers.mjs'
import {
  SKILL_NAME, SKILL_AGENTS, SKILL_TARGETS, canonicalSkillDir, readCanonicalSkill,
  parseSkillFrontmatter, installSkills, listSkills, skillTargets,
} from '../src/skill.mjs'

const cleanup = []
test.after(() => {
  for (const dir of cleanup) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows may hold handles briefly */ }
  }
})

function workspace(prefix = 'memai-skill-') {
  const dir = tempDir(prefix)
  cleanup.push(dir)
  return dir
}

function homeDir() {
  const dir = workspace('memai-skill-home-')
  return dir
}

const read = (file) => fs.readFileSync(file, 'utf8')
const exists = (file) => fs.existsSync(file)

function runSkill(args, { cwd, env = {} } = {}) {
  return runNode([SELF.bin, 'skill', ...args], { cwd: cwd ?? process.cwd(), env })
}

// ---------------------------------------------------------------------------
// Canonical skill
// ---------------------------------------------------------------------------

test('canonical SKILL.md parses and is portable Agent Skills frontmatter', () => {
  const skill = readCanonicalSkill()
  assert.equal(skill.ok, true, `frontmatter errors: ${skill.errors.join('; ')}`)
  assert.equal(skill.data.name, SKILL_NAME)
  assert.match(skill.data.name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
  assert.ok(skill.data.name.length <= 64)
  assert.equal(skill.data.license, 'MIT')
  assert.ok(typeof skill.data.description === 'string' && skill.data.description.length > 0)
  assert.ok(skill.data.description.length <= 1024, 'description must be <= 1024 chars')
  assert.ok(typeof skill.data.compatibility === 'string' && skill.data.compatibility.length <= 500)
  assert.ok(skill.data.metadata && typeof skill.data.metadata === 'object' && !Array.isArray(skill.data.metadata))
  for (const [k, v] of Object.entries(skill.data.metadata)) {
    assert.equal(typeof v, 'string', `metadata.${k} must be a string`)
  }
  // Provider-specific fields would be ignored or could break strict clients.
  for (const key of ['allowed-tools', 'context', 'agent', 'disable-model-invocation', 'user-invocable', 'argument-hint']) {
    assert.equal(Object.prototype.hasOwnProperty.call(skill.data, key), false, `provider-only field ${key} present`)
  }
  // The body is the portable part: workflow, both surfaces, measured break-even.
  const bodyLines = skill.body.split(/\r?\n/).length
  assert.ok(bodyLines < 150, `body should stay focused (<150 lines), got ${bodyLines}`)
  for (const needle of ['{"op":"card"}', 'memai card', 'query', 'fault', 'diff', 'note', '346', '1.3 KB']) {
    assert.ok(skill.body.includes(needle), `body should mention ${needle}`)
  }
  assert.ok(exists(path.join(canonicalSkillDir(), 'SKILL.md')))
})

test('parseSkillFrontmatter rejects missing name/description and provider-only fields', () => {
  assert.equal(parseSkillFrontmatter('no frontmatter').ok, false)
  const noName = parseSkillFrontmatter('---\ndescription: something useful\n---\nbody\n')
  assert.equal(noName.ok, false)
  assert.match(noName.errors.join('\n'), /name/)
  const badName = parseSkillFrontmatter('---\nname: Not_Valid\ndescription: x\n---\n')
  assert.equal(badName.ok, false)
  const longDescription = parseSkillFrontmatter(`---\nname: memai\ndescription: ${'x'.repeat(1025)}\n---\n`)
  assert.equal(longDescription.ok, false)
  const provider = parseSkillFrontmatter('---\nname: memai\ndescription: ok\nallowed-tools: Bash\n---\n')
  assert.equal(provider.ok, false)
  assert.match(provider.errors.join('\n'), /provider-specific/)
  const longCompat = parseSkillFrontmatter(`---\nname: memai\ndescription: ok\ncompatibility: ${'c'.repeat(501)}\n---\n`)
  assert.equal(longCompat.ok, false)
  const good = parseSkillFrontmatter('---\nname: memai\ndescription: ok\nmetadata:\n  version: "0.1.1"\n---\nbody\n')
  assert.equal(good.ok, true)
  assert.deepEqual(good.data.metadata, { version: '0.1.1' })
})

test('agent aliases map onto exactly two install roots', () => {
  const root = workspace()
  const shared = path.join(root, '.agents', 'skills', 'memai')
  const claude = path.join(root, '.claude', 'skills', 'memai')
  const cases = {
    claude: [claude],
    codex: [shared],
    opencode: [shared],
    zcode: [shared],
    dsh: [shared],
    generic: [shared],
    all: [shared, claude],
  }
  for (const [agent, expected] of Object.entries(cases)) {
    const dirs = skillTargets({ agents: [agent], root }).map((t) => t.dir).sort()
    assert.deepEqual(dirs, [...expected].sort(), `agent ${agent} roots`)
  }
  assert.equal(SKILL_TARGETS.length, 2)
  assert.deepEqual(SKILL_AGENTS, ['claude', 'codex', 'opencode', 'zcode', 'dsh', 'generic'])
})

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

test('install --agent all writes both roots byte-identically and is idempotent', async () => {
  const root = workspace()
  const source = read(path.join(canonicalSkillDir(), 'SKILL.md'))

  const first = await runSkill(['install', '--root', root, '--agent', 'all'])
  assert.equal(first.code, 0, first.stdout + first.stderr)
  assert.match(first.stdout, /created/)
  for (const rel of ['.agents/skills/memai/SKILL.md', '.claude/skills/memai/SKILL.md']) {
    const file = path.join(root, ...rel.split('/'))
    assert.ok(exists(file), `${rel} missing`)
    assert.equal(read(file), source, `${rel} must be byte-identical to skills/memai/SKILL.md`)
  }

  const second = await runSkill(['install', '--root', root, '--agent', 'all'])
  assert.equal(second.code, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /unchanged/)
  assert.doesNotMatch(second.stdout, /created/)
  assert.match(second.stdout, /already up to date/)
  // Third-party changes are not made: content is still identical.
  assert.equal(read(path.join(root, '.agents', 'skills', 'memai', 'SKILL.md')), source)
})

test('per-agent installs create only that agent root', async () => {
  const claudeRoot = workspace()
  const claude = await runSkill(['install', '--root', claudeRoot, '--agent', 'claude'])
  assert.equal(claude.code, 0, claude.stdout + claude.stderr)
  assert.ok(exists(path.join(claudeRoot, '.claude', 'skills', 'memai', 'SKILL.md')))
  assert.equal(exists(path.join(claudeRoot, '.agents')), false, '--agent claude must not create .agents')

  const codexRoot = workspace()
  const codex = await runSkill(['install', '--root', codexRoot, '--agent', 'codex'])
  assert.equal(codex.code, 0, codex.stdout + codex.stderr)
  assert.ok(exists(path.join(codexRoot, '.agents', 'skills', 'memai', 'SKILL.md')))
  assert.equal(exists(path.join(codexRoot, '.claude')), false, '--agent codex must not create .claude')

  const bad = await runSkill(['install', '--root', workspace(), '--agent', 'nope'])
  assert.equal(bad.code, 2)
  assert.match(bad.stdout + bad.stderr, /unknown agent/)
})

test('a conflicting target is preserved without --force and replaced with it', async () => {
  const root = workspace()
  const dest = path.join(root, '.claude', 'skills', 'memai', 'SKILL.md')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const custom = '---\nname: memai\ndescription: locally customised\n---\n\n# Custom\n'
  fs.writeFileSync(dest, custom)

  const conflict = await runSkill(['install', '--root', root, '--agent', 'claude'])
  assert.equal(conflict.code, 1, 'a conflict must be a non-zero exit')
  assert.match(conflict.stdout, /conflict/)
  assert.match(conflict.stdout, /--force/)
  assert.equal(read(dest), custom, 'conflicting content must be preserved without --force')

  const forced = await runSkill(['install', '--root', root, '--agent', 'claude', '--force'])
  assert.equal(forced.code, 0, forced.stdout + forced.stderr)
  assert.match(forced.stdout, /updated/)
  assert.equal(read(dest), read(path.join(canonicalSkillDir(), 'SKILL.md')))
})

test('--global installs under the HOME override, not the project', async () => {
  const home = homeDir()
  const root = workspace()
  const res = await runSkill(['install', '--global', '--agent', 'all'], { env: { HOME: home, USERPROFILE: home } })
  assert.equal(res.code, 0, res.stdout + res.stderr)
  for (const rel of ['.agents/skills/memai/SKILL.md', '.claude/skills/memai/SKILL.md']) {
    assert.ok(exists(path.join(home, ...rel.split('/'))), `global ${rel} missing`)
  }
  assert.equal(exists(path.join(root, '.agents')), false, 'project root untouched by --global')
})

test('--link creates a directory link to the canonical skill', async () => {
  const root = workspace()
  const res = await runSkill(['install', '--root', root, '--agent', 'claude', '--link'])
  assert.equal(res.code, 0, res.stdout + res.stderr)
  const dest = path.join(root, '.claude', 'skills', 'memai')
  const stat = fs.lstatSync(dest)
  assert.ok(stat.isSymbolicLink(), 'expected a directory symlink/junction')
  assert.equal(read(path.join(dest, 'SKILL.md')), read(path.join(canonicalSkillDir(), 'SKILL.md')))
  const again = await runSkill(['install', '--root', root, '--agent', 'claude', '--link'])
  assert.equal(again.code, 0)
  assert.match(again.stdout, /unchanged|linked/)
  assert.match(again.stdout, /already up to date|symlink/)
})

test('install copies every file of the skill package, not just SKILL.md', () => {
  const sourceDir = workspace()
  fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), read(path.join(canonicalSkillDir(), 'SKILL.md')))
  fs.mkdirSync(path.join(sourceDir, 'references'), { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'references', 'notes.md'), '# notes\n')
  const root = workspace()

  const result = installSkills({ root, agents: ['claude'], sourceDir })
  assert.equal(result.ok, true)
  assert.equal(result.changed, 1)
  const installed = path.join(root, '.claude', 'skills', 'memai')
  assert.equal(fs.readFileSync(path.join(installed, 'references', 'notes.md'), 'utf8'), '# notes\n')
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), read(path.join(sourceDir, 'SKILL.md')))
})

// ---------------------------------------------------------------------------
// list / status
// ---------------------------------------------------------------------------

test('skill list and status report installed and missing targets', async () => {
  const root = workspace()
  const home = homeDir()
  await runSkill(['install', '--root', root, '--agent', 'all'], { env: { HOME: home, USERPROFILE: home } })

  const list = await runSkill(['list', '--root', root], { env: { HOME: home, USERPROFILE: home } })
  assert.equal(list.code, 0, list.stdout + list.stderr)
  assert.match(list.stdout, /\.agents/)
  assert.match(list.stdout, /\.claude/)
  assert.match(list.stdout, /installed/)
  assert.match(list.stdout, /missing/)
  assert.match(list.stdout, /summary:/)

  const json = await runSkill(['list', '--root', root, '--json'], { env: { HOME: home, USERPROFILE: home } })
  const parsed = JSON.parse(json.stdout)
  assert.equal(parsed.rows.length, 4, 'two targets x two scopes')
  assert.equal(parsed.installed, 2)

  const status = await runSkill(['status', '--root', root], { env: { HOME: home, USERPROFILE: home } })
  assert.equal(status.code, 0)
  assert.match(status.stdout, /status:/)
})

test('skill with no subcommand or an unknown one prints usage and exits 2', async () => {
  const none = await runSkill([])
  assert.equal(none.code, 2)
  assert.match(none.stdout, /missing command/)
  const bad = await runSkill(['frobnicate'])
  assert.equal(bad.code, 2)
  assert.match(bad.stdout, /unknown command/)
})

test('the CLI reports the published package version', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  const version = await runNode([SELF.bin, '--version'])
  assert.equal(version.code, 0, version.stderr)
  assert.equal(version.stdout.trim(), `memai ${pkg.version}`)
})

// ---------------------------------------------------------------------------
// init integration
// ---------------------------------------------------------------------------

test('memai init installs the skill by default and --no-skill skips it', async () => {
  const installed = workspace()
  const rootA = path.join(installed, 'project')
  fs.mkdirSync(rootA, { recursive: true })
  makeCorpus(rootA)
  const init = await runNode([SELF.bin, 'init', '--root', rootA, '--agent', 'claude'], { cwd: rootA })
  assert.equal(init.code, 0, init.stdout + init.stderr)
  assert.match(init.stdout, /skills: 1 installed/)
  assert.ok(exists(path.join(rootA, '.claude', 'skills', 'memai', 'SKILL.md')))
  assert.equal(exists(path.join(rootA, '.agents')), false, '--agent claude should not install the shared root')

  const skipped = workspace()
  const rootB = path.join(skipped, 'project')
  fs.mkdirSync(rootB, { recursive: true })
  makeCorpus(rootB)
  const noSkill = await runNode([SELF.bin, 'init', '--root', rootB, '--agent', 'claude', '--no-skill'], { cwd: rootB })
  assert.equal(noSkill.code, 0, noSkill.stdout + noSkill.stderr)
  assert.match(noSkill.stdout, /skills: skipped \(--no-skill\)/)
  assert.equal(exists(path.join(rootB, '.claude', 'skills', 'memai')), false)
})
