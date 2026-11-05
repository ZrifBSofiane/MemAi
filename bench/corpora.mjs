// Benchmark corpora + task definitions.
//
// Corpora are resolved from this repository and the Node installation, so a
// fresh clone can run the benchmark with no external checkouts:
//   - a deterministically generated 200-file fixture with known ground truth;
//   - the npm CLI shipped with Node (if present on the machine);
//   - this repository itself (self-hosted);
//   - the DeepSeek Harness adapter bundled in adapters/dsh (a small real plugin).
//
// Task file sets are curated (what an agent would actually need to read). For
// locate-style tasks the paged plan is also curated: the sequence of `query` /
// `fault` / `get` calls a competent agent would make. Recall is then measured
// against the ground-truth file set -- paging that misses files is penalised,
// not just paging that is cheap.
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
export const REPO_ROOT = path.resolve(HERE, '..')
export const MEMORY_PAGES_ROOT = REPO_ROOT // kept for older imports
export const FIXTURE_ROOT = path.join(HERE, 'fixtures', 'atlas')

export function nodeNpmLib() {
  const exe = path.dirname(process.execPath)
  const candidates = [
    path.resolve(exe, '..', 'lib', 'node_modules', 'npm', 'lib'), // POSIX / setup-node / nvm
    path.resolve(exe, 'node_modules', 'npm', 'lib'),              // Windows Node installer
    '/usr/local/lib/node_modules/npm/lib',
    '/usr/lib/node_modules/npm/lib',
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]
}

export const NPM_LIB = nodeNpmLib()
export const NPM_ROOT = path.resolve(NPM_LIB, '..')
export const DSH_ADAPTER_ROOT = path.join(REPO_ROOT, 'adapters', 'dsh')
const require = createRequire(import.meta.url)

/** Tasks with curated file sets and paged plans for a real/self corpus. */
export function realTasks() {
  return {
    'npm-cli': [
      {
        id: 'understand-workspaces', type: 'understand',
        goal: 'How does npm resolve workspace filters and re-sync workspace node_modules after a version bump?',
        terms: ['workspace', 'getWorkspaces', 'updateWorkspaces'],
        files: ['lib/utils/get-workspaces.js', 'lib/utils/update-workspaces.js', 'lib/commands/install.js', 'lib/arborist-cmd.js'],
        plan: [
          { op: 'get', id: 'file:lib/utils/get-workspaces.js' },
          { op: 'fault', target: 'getWorkspaces' },
          { op: 'get', id: 'file:lib/utils/update-workspaces.js' },
        ],
      },
      {
        id: 'locate-auth', type: 'locate',
        goal: 'Where is registry authentication / one-time-password handling implemented?',
        terms: ['otplease', 'adduser', 'token'],
        files: ['lib/utils/auth.js', 'lib/commands/token.js', 'lib/utils/oidc.js'],
        plan: [
          { op: 'query', q: 'otplease' },
          { op: 'fault', target: 'otplease' },
          { op: 'get', id: 'file:lib/commands/token.js' },
        ],
      },
      {
        id: 'review-cache', type: 'review',
        goal: 'Review the npm cache command for risky assumptions before changing its key lookup.',
        terms: ['searchCachePackage', 'cacache', 'cache'],
        files: ['lib/commands/cache.js', 'lib/utils/tar.js', 'lib/base-cmd.js'],
        plan: [
          { op: 'get', id: 'file:lib/commands/cache.js' },
          { op: 'fault', target: 'searchCachePackage' },
          { op: 'fault', target: 'Cache' },
        ],
      },
    ],
    'memai': [
      {
        id: 'understand-page-model', type: 'understand',
        goal: 'How do resolve/diff/fault enforce token budgets and Merkle versions?',
        terms: ['resolve', 'diff', 'version'],
        files: ['src/page.mjs', 'src/store.mjs', 'src/tokens.mjs'],
        plan: [
          { op: 'get', id: 'file:src/page.mjs' },
          { op: 'fault', target: 'resolve' },
          { op: 'fault', target: 'diff' },
        ],
      },
      {
        id: 'locate-extractor', type: 'locate',
        goal: 'Where are symbols extracted and page text rendered?',
        terms: ['extractSymbols', 'renderProjectMap', 'renderFilePage'],
        files: ['src/extract.mjs', 'src/store.mjs'],
        plan: [
          { op: 'query', q: 'extractSymbols' },
          { op: 'fault', target: 'extractSymbols' },
          { op: 'fault', target: 'renderProjectMap' },
        ],
      },
      {
        id: 'review-cli', type: 'review',
        goal: 'Review the agent-facing CLI surface and its response envelope.',
        terms: ['run', 'render', 'command'],
        files: ['src/mem-cli.mjs', 'src/cli.mjs', 'src/page.mjs'],
        plan: [
          { op: 'get', id: 'file:src/mem-cli.mjs' },
          { op: 'fault', target: 'run' },
          { op: 'query', q: 'tokens envelope' },
        ],
      },
    ],
    'dsh-adapter': [
      {
        id: 'understand-dsh-adapter', type: 'understand',
        goal: 'How does the DeepSeek Harness adapter inject the card into every agent and serve content paging?',
        terms: ['systemPrompt', 'context', 'tools', 'mem'],
        files: ['index.js', 'package.json', 'README.md'],
        plan: [
          { op: 'get', id: 'file:index.js' },
          { op: 'fault', target: 'apply' },
          { op: 'fault', target: 'openStore' },
        ],
      },
      {
        id: 'locate-tool-surface', type: 'locate',
        goal: 'Where does the adapter register itself with the host and expose the mem tool?',
        terms: ['register', 'execute', 'section'],
        files: ['index.js', 'cordis.patch.yml', 'package.json'],
        plan: [
          { op: 'query', q: 'register' },
          { op: 'get', id: 'file:index.js' },
          { op: 'query', q: 'execute' },
        ],
      },
    ],
  }
}

export function corpusSpecs() {
  return [
    { id: 'atlas-fixture', label: 'atlas-api fixture (generated, 200 files)', root: FIXTURE_ROOT, kind: 'fixture', ensure: true },
    { id: 'npm-cli', label: 'npm CLI (real, shipped with Node)', root: NPM_ROOT, kind: 'real' },
    { id: 'memai', label: 'MemAi itself (real, self-host)', root: REPO_ROOT, kind: 'real-self', ignore: ['bench/results.json', 'bench/RESULTS.md', 'bench/.bench', 'bench/fixtures'] },
    { id: 'dsh-adapter', label: 'DeepSeek Harness adapter (real, bundled in this repo)', root: DSH_ADAPTER_ROOT, kind: 'real' },
  ]
}

/** Resolve a corpus root; returns {ok, reason} when unavailable. */
export function checkCorpus(spec) {
  if (!fs.existsSync(spec.root)) return { ok: false, reason: `missing: ${spec.root}` }
  return { ok: true }
}

export function tasksFor(corpusId) {
  if (corpusId === 'atlas-fixture') return require('./fixture.mjs').fixtureTasks()
  return realTasks()[corpusId] ?? []
}

export function npmAvailable() { return fs.existsSync(NPM_LIB) }
