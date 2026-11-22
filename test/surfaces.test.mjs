// Instruction-surface consistency: versions and (later) op coverage must agree.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('skill metadata version matches package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'memai', 'SKILL.md'), 'utf8')
  const m = skill.match(/^\s{2}version:\s*"([^"]+)"/m)
  assert.ok(m, 'skill frontmatter has metadata.version')
  assert.equal(m[1], pkg.version)
})
