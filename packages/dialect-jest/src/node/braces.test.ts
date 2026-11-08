// Brace expansion for `projects` globs equals brace-expansion 5.0.12's (what glob 13's minimatch
// calls). The expected lists were recorded from that package's `expand` on 2026-11-08; a `projects`
// glob is also checked end to end against real jest-config (padding and steps). Past
// brace-expansion's 100,000-result limit, ours throws instead of stopping silently.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { expandBraces } from './braces.ts'
import { JestConfigError } from './errors.ts'
import {
  comparableWithout,
  inDirectory,
  loadOracle,
  ORACLE_ARGV,
  type Oracle,
  oracleRequireResolve,
  removeTree,
  writeTree,
} from './internal/test-support.ts'
import { readJestConfig } from './normalize.ts'

/** A `$` before the braces keeps them (a shell variable), so the pattern is its own result. */
const DOLLAR_BRACES = `\${a,b}`

/** brace-expansion 5.0.12's `expand(pattern)`, recorded. */
const RECORDED: Readonly<Record<string, readonly string[]>> = {
  'a{b,c}d': ['abd', 'acd'],
  '{01..03}': ['01', '02', '03'],
  '{1..10..2}': ['1', '3', '5', '7', '9'],
  '{10..1..3}': ['10', '7', '4', '1'],
  '{-2..2}': ['-2', '-1', '0', '1', '2'],
  '{-05..5..5}': ['-05', '000', '005'],
  '{a..e}': ['a', 'b', 'c', 'd', 'e'],
  '{a..e..2}': ['a', 'c', 'e'],
  '{e..a}': ['e', 'd', 'c', 'b', 'a'],
  'x{1..3}{a,b}': ['x1a', 'x1b', 'x2a', 'x2b', 'x3a', 'x3b'],
  '{a,{b,c},d}': ['a', 'b', 'c', 'd'],
  'a{b}c': ['a{b}c'],
  'a{2..}b': ['a{2..}b'],
  '{,a}b': ['b', 'ab'],
  'a{,b}': ['a', 'ab'],
  [DOLLAR_BRACES]: [DOLLAR_BRACES],
  'pkg/{x,y}/{1..2}': ['pkg/x/1', 'pkg/x/2', 'pkg/y/1', 'pkg/y/2'],
  '{}x': ['{}x'],
  '{a,b}{}': ['a{}', 'b{}'],
  'nested{a,b{1..2}}': ['nesteda', 'nestedb1', 'nestedb2'],
  '{007..010}': ['007', '008', '009', '010'],
  '{1..3..0}': ['1', '2', '3'],
}

for (const [pattern, expected] of Object.entries(RECORDED)) {
  test(`expands as brace-expansion does: ${pattern}`, () => {
    assert.deepEqual(expandBraces(pattern), expected)
  })
}

test("an expansion that reaches brace-expansion's limit is refused with a clear error", () => {
  assert.throws(
    () => expandBraces('<rootDir>/{1..200000}'),
    (error: unknown) =>
      error instanceof JestConfigError &&
      error.code === 'JEST_CONFIG_INVALID' &&
      /expands to 100000 patterns or more/.test(error.message),
  )
})

let oracle: Oracle
const trees: string[] = []
before(async () => {
  oracle = await loadOracle()
})
after(() => {
  for (const tree of trees) removeTree(tree)
})

test('padded and stepped projects globs find what jest-config finds', async () => {
  const root = writeTree({
    'jest.config.js':
      "module.exports = { projects: ['<rootDir>/p{01..03}', '<rootDir>/q{1..5..2}'] }\n",
    'p01/jest.config.js': 'module.exports = {}\n',
    'p02/jest.config.js': 'module.exports = {}\n',
    'p03/jest.config.js': 'module.exports = {}\n',
    'q1/jest.config.js': 'module.exports = {}\n',
    'q3/jest.config.js': 'module.exports = {}\n',
    'q5/jest.config.js': 'module.exports = {}\n',
    'q2/jest.config.js': 'module.exports = {}\n',
  })
  trees.push(root)
  const path = join(root, 'jest.config.js')
  const ours = await readJestConfig(path, {
    cwd: root,
    requireResolve: oracleRequireResolve,
    seed: 0,
  })
  const theirs = (await inDirectory(root, () =>
    oracle.readConfig({ ...ORACLE_ARGV, _: [] }, path),
  )) as { globalConfig: unknown }
  const projects = (value: unknown) => comparableWithout(value, ['seed']).projects
  assert.deepEqual(projects(ours.globalConfig), projects(theirs.globalConfig))
  assert.equal((projects(ours.globalConfig) as unknown[]).length, 6)
})
