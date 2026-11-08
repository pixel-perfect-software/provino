// T11.3's check: for 12 trees, `findJestConfig` returns the file real `jest-config` 30.5.2 reads
// (`readInitialOptions`, since `resolveConfigPath` isn't in jest-config's `exports`), and the
// errors carry Jest's text, "Multiple configurations found" included.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { JestConfigError } from './errors.ts'
import { findJestConfig, JEST_CONFIG_CANDIDATES } from './find.ts'
import {
  loadOracle,
  type Oracle,
  plainMessage,
  removeTree,
  type Tree,
  writeTree,
} from './internal/test-support.ts'

const CJS = 'module.exports = { testTimeout: 1 }\n'
const ESM = 'export default { testTimeout: 1 }\n'
const TS = "import type {} from 'node:fs'\nexport default { testTimeout: 1 as number }\n"
const CTS = 'module.exports = { testTimeout: 1 as number }\n'

interface Case {
  readonly name: string
  readonly tree: Tree
  /** Where the search starts (relative to the tree). */
  readonly from: string
  /** `--config`, relative to the tree. */
  readonly explicit?: string
  /** The file both should find (relative to the tree). */
  readonly expected: string
  readonly kind: 'file' | 'package-json'
}

const CASES: readonly Case[] = [
  {
    name: '.js',
    tree: { 'jest.config.js': CJS },
    from: '.',
    expected: 'jest.config.js',
    kind: 'file',
  },
  {
    name: '.ts',
    tree: { 'jest.config.ts': TS },
    from: '.',
    expected: 'jest.config.ts',
    kind: 'file',
  },
  {
    name: '.mjs',
    tree: { 'jest.config.mjs': ESM },
    from: '.',
    expected: 'jest.config.mjs',
    kind: 'file',
  },
  {
    name: '.mts',
    tree: { 'jest.config.mts': TS },
    from: '.',
    expected: 'jest.config.mts',
    kind: 'file',
  },
  {
    name: '.cjs',
    tree: { 'jest.config.cjs': CJS },
    from: '.',
    expected: 'jest.config.cjs',
    kind: 'file',
  },
  {
    name: '.cts',
    tree: { 'jest.config.cts': CTS },
    from: '.',
    expected: 'jest.config.cts',
    kind: 'file',
  },
  {
    name: '.json',
    tree: { 'jest.config.json': '{ "testTimeout": 1 }\n' },
    from: '.',
    expected: 'jest.config.json',
    kind: 'file',
  },
  {
    name: 'package.json#jest object',
    tree: { 'package.json': '{ "name": "a", "jest": { "testTimeout": 1 } }\n' },
    from: '.',
    expected: 'package.json',
    kind: 'package-json',
  },
  {
    name: 'package.json#jest string',
    tree: {
      'package.json': '{ "name": "a", "jest": "./config/jest.js" }\n',
      'config/jest.js': CJS,
    },
    from: '.',
    expected: 'config/jest.js',
    kind: 'file',
  },
  {
    name: 'upward walk to a parent config',
    tree: { 'jest.config.js': CJS, 'src/deep/er/x.txt': '' },
    from: 'src/deep/er',
    expected: 'jest.config.js',
    kind: 'file',
  },
  {
    name: 'a package.json without jest ends the walk',
    tree: {
      'jest.config.js': CJS,
      'packages/a/package.json': '{ "name": "a" }\n',
      'packages/a/src/x.txt': '',
    },
    from: 'packages/a/src',
    expected: 'packages/a/package.json',
    kind: 'package-json',
  },
  {
    name: 'explicit path, beside another config',
    tree: { 'jest.config.js': CJS, 'jest.ci.config.js': CJS, 'jest.config.ts': TS },
    from: '.',
    explicit: 'jest.ci.config.js',
    expected: 'jest.ci.config.js',
    kind: 'file',
  },
]

let oracle: Oracle
const trees: string[] = []

before(async () => {
  oracle = await loadOracle()
})

after(() => {
  for (const tree of trees) removeTree(tree)
})

function tree(files: Tree): string {
  const root = writeTree(files)
  trees.push(root)
  return root
}

async function oracleConfigPath(root: string, from: string, explicit?: string): Promise<string> {
  const before = process.cwd()
  process.chdir(join(root, from))
  try {
    const read = (await oracle.readInitialOptions(
      explicit === undefined ? undefined : join(root, explicit),
      { packageRootOrConfig: join(root, from) },
    )) as { configPath: string }
    return read.configPath
  } finally {
    process.chdir(before)
  }
}

test('the candidates are the 7 extensions in order, then package.json', () => {
  assert.deepEqual(JEST_CONFIG_CANDIDATES, [
    'jest.config.js',
    'jest.config.ts',
    'jest.config.mjs',
    'jest.config.mts',
    'jest.config.cjs',
    'jest.config.cts',
    'jest.config.json',
    'package.json',
  ])
})

for (const fixture of CASES) {
  test(`finds what jest-config finds: ${fixture.name}`, async () => {
    const root = tree(fixture.tree)
    const cwd = join(root, fixture.from)
    const ours = findJestConfig(
      cwd,
      fixture.explicit === undefined ? undefined : join(root, fixture.explicit),
    )
    const theirs = await oracleConfigPath(root, fixture.from, fixture.explicit)
    assert.equal(theirs, join(root, fixture.expected))
    assert.deepEqual(ours, { kind: fixture.kind, path: theirs })
  })
}

test('there are 12 fixture trees', () => {
  assert.equal(CASES.length, 12)
})

async function bothFail(root: string, from: string, explicit?: string) {
  let ours: unknown
  try {
    findJestConfig(join(root, from), explicit === undefined ? undefined : join(root, explicit))
  } catch (error) {
    ours = error
  }
  let theirs: unknown
  try {
    await oracleConfigPath(root, from, explicit)
  } catch (error) {
    theirs = error
  }
  assert.ok(ours instanceof JestConfigError, 'ours throws')
  assert.ok(theirs instanceof Error, 'jest-config throws')
  return { ours, theirs }
}

test('several configs in one directory: Jest\'s "Multiple configurations found" text', async () => {
  const root = tree({ 'jest.config.js': CJS, 'jest.config.ts': TS })
  const { ours, theirs } = await bothFail(root, '.')
  assert.equal(ours.code, 'JEST_CONFIG_MULTIPLE')
  assert.match(ours.message, /Multiple configurations found/)
  assert.equal(ours.message, plainMessage(theirs))
})

test('a config file and a package.json jest key: the "`jest` key in" line', async () => {
  const root = tree({
    'jest.config.mjs': ESM,
    'package.json': '{ "name": "a", "jest": { "testTimeout": 2 } }\n',
  })
  const { ours, theirs } = await bothFail(root, '.')
  assert.match(ours.message, /\* `jest` key in /)
  assert.equal(ours.message, plainMessage(theirs))
})

test("a package.json jest string that names no file: Jest's validation text", async () => {
  const root = tree({ 'package.json': '{ "name": "a", "jest": "./missing.js" }\n' })
  const { ours, theirs } = await bothFail(root, '.')
  assert.equal(ours.code, 'JEST_CONFIG_INVALID')
  assert.equal(ours.message, plainMessage(theirs))
})

test("an explicit path that does not exist: Jest's text", async () => {
  const root = tree({ 'jest.config.js': CJS })
  const { ours, theirs } = await bothFail(root, '.', 'nope')
  assert.equal(ours.code, 'JEST_CONFIG_NO_ROOT')
  assert.equal(ours.message, plainMessage(theirs))
})

test('inline JSON (`--config {…}`) is an inline source', () => {
  assert.deepEqual(findJestConfig('/x', '{"testTimeout":1}'), {
    kind: 'inline',
    path: '/x',
    text: '{"testTimeout":1}',
  })
})
