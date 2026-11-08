// T11.6's warnings: an unknown key gets Jest's "did you mean" text, a global-only key inside a
// project gets "move it to the root configuration", and a deprecated key its message; a key of the
// wrong type fails with Jest's error. Each is compared with what real `jest-config` 30.5.2 prints
// through `console.warn` (colours stripped) or throws.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { JestConfigError } from './errors.ts'
import {
  captureWarnings,
  inDirectory,
  loadOracle,
  ORACLE_ARGV,
  type Oracle,
  oracleRequireResolve,
  plainMessage,
  removeTree,
  writeTree,
} from './internal/test-support.ts'
import { readJestConfig, readJestConfigs } from './normalize.ts'
import { didYouMean, formatValue, leven } from './text.ts'
import { GLOBAL_ONLY_OPTIONS } from './valid-config.ts'
import { validateJestConfig } from './validate.ts'

let oracle: Oracle
const trees: string[] = []

before(async () => {
  oracle = await loadOracle()
})

after(() => {
  for (const tree of trees) removeTree(tree)
})

function configTree(body: string): string {
  const root = writeTree({ 'jest.config.js': `module.exports = ${body}\n` })
  trees.push(root)
  return root
}

const options = (root: string) => ({
  cwd: root,
  requireResolve: oracleRequireResolve,
  ci: oracle.defaults.ci === true,
  seed: 0,
})

async function compareWarnings(body: string): Promise<readonly string[]> {
  const root = configTree(body)
  const path = join(root, 'jest.config.js')
  const ours = await readJestConfig(path, options(root))
  const theirs = await inDirectory(root, () =>
    captureWarnings(() => oracle.readConfig({ ...ORACLE_ARGV, _: [] }, path)),
  )
  if (theirs.error !== undefined) throw theirs.error
  const messages = ours.diagnostics.map((diagnostic) => diagnostic.message)
  assert.deepEqual(messages, theirs.warnings)
  return messages
}

test('an unknown key: "did you mean" the first close key', async () => {
  const [warning] = await compareWarnings(`{ testEnviroment: 'node', setupFilesAfterEach: [] }`)
  assert.match(warning ?? '', /Did you mean "testEnvironment"\?/)
})

test('unknown keys: their values printed as pretty-format prints them', async () => {
  await compareWarnings(
    `{ foo: 'a"b\\\\c', bar: [1, 'x', { b: 2, a: 1 }, null, undefined], baz: /re/g, qux: () => 1, quux: { nested: function named() {} }, n: -0, big: 10n, sym: Symbol('s'), d: new Date(0), m: new Map([['k', 1]]), s: new Set([1]), e: new Error('boom'), u: undefined }`,
  )
})

test('a typo inside a known object names its path', async () => {
  const [warning] = await compareWarnings(
    `{ fakeTimers: { enableGlobaly: true }, haste: { platfoms: [] } }`,
  )
  assert.match(warning ?? '', /"fakeTimers\.enableGlobaly"/)
})

test('deprecated keys warn with their messages', async () => {
  await compareWarnings(
    `{ testURL: 'http://x', timers: 'fake', testPathPattern: 'x', setupTestFrameworkScriptFile: './s.js', testPathDirs: ['x'], browser: true, extraGlobals: [] }`,
  )
})

test('denied paths are not walked; a "//" key is allowed', async () => {
  const warnings = await compareWarnings(
    `{ '//': 'comment', globals: { anything: 1 }, transform: {}, moduleNameMapper: { x: 'y' }, testEnvironmentOptions: { custom: true }, coverageThreshold: { './src/': { lines: 1 } } }`,
  )
  assert.deepEqual(warnings, [])
})

test("a known key of the wrong type fails with Jest's text", async () => {
  for (const body of [`{ testMatch: 5 }`, `{ maxWorkers: true }`, `{ fakeTimers: { now: 'x' } }`]) {
    const root = configTree(body)
    const path = join(root, 'jest.config.js')
    const ours = await readJestConfig(path, options(root)).catch((error: unknown) => error)
    const theirs = await inDirectory(root, () =>
      oracle.readConfig({ ...ORACLE_ARGV, _: [] }, path).catch((error: unknown) => error),
    )
    assert.ok(ours instanceof JestConfigError, body)
    assert.equal(ours.code, 'JEST_CONFIG_INVALID')
    assert.equal(ours.message, plainMessage(theirs), body)
  }
})

test('inside projects: global-only keys say to move them; typos still get "did you mean"', async () => {
  const root = writeTree({
    'jest.config.js': `module.exports = { projects: [{ displayName: 'p', collectTests: true, maxWorkers: 2, reporters: [], coverageThreshold: { global: {} }, testEnviroment: 'node' }] }\n`,
  })
  trees.push(root)
  const ours = await readJestConfigs([root], options(root))
  const theirs = await inDirectory(root, () =>
    captureWarnings(() => oracle.readConfigs({ ...ORACLE_ARGV, _: [] }, [root])),
  )
  if (theirs.error !== undefined) throw theirs.error
  const messages = ours.diagnostics.map((diagnostic) => diagnostic.message)
  assert.deepEqual(messages, theirs.warnings)
  assert.ok(
    messages.some((message) =>
      message.includes('is not supported in an individual project configuration'),
    ),
  )
  assert.ok(ours.diagnostics.some((d) => d.code === 'JEST_CONFIG_GLOBAL_ONLY_OPTION'))
})

test('the global-only keys are the root table minus the project table', () => {
  for (const key of [
    'projects',
    'reporters',
    'maxWorkers',
    'coverageThreshold',
    'watchPlugins',
    'bail',
  ]) {
    assert.ok(GLOBAL_ONLY_OPTIONS.has(key), key)
  }
  for (const key of ['testEnvironment', 'transform', 'collectCoverage', 'silent', 'verbose']) {
    assert.ok(!GLOBAL_ONLY_OPTIONS.has(key), key)
  }
})

test('validateJestConfig reports, and leaves valid configs alone', () => {
  assert.deepEqual(validateJestConfig({ testEnvironment: 'node', rootDir: '/' }, false), {
    diagnostics: [],
    hasDeprecationWarnings: false,
  })
  assert.equal(validateJestConfig({ timers: 'fake' }, false).hasDeprecationWarnings, true)
})

test('leven and didYouMean', () => {
  assert.equal(leven('kitten', 'sitting'), 3)
  assert.equal(leven('', 'abc'), 3)
  assert.equal(leven('same', 'same'), 0)
  assert.equal(didYouMean('rots', ['roots', 'rootDir']), 'Did you mean "roots"?')
  assert.equal(didYouMean('zzzzzz', ['roots']), '')
  assert.equal(formatValue('x'), '"x"')
})
