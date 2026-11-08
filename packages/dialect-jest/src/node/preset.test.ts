// T11.5's in-process check: presets that resolve by path (relative, `<rootDir>`, monorepo-nested)
// and by package (`x/jest-preset` with `.json .js .cjs .mjs`), and the merge rules, each compared
// with real `jest-config` 30.5.2's `readConfig`. The real presets (ts-jest, React Native, jest-expo,
// jest-preset-angular) are `pnpm bench:jest-config presets`, in a CI job of their own.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { JestConfigError } from './errors.ts'
import {
  comparable,
  comparableWithout,
  inDirectory,
  loadOracle,
  ORACLE_ARGV,
  type Oracle,
  oracleRequireResolve,
  plainMessage,
  removeTree,
  type Tree,
  writeTree,
} from './internal/test-support.ts'
import { readJestConfig } from './normalize.ts'
import { deepMerge } from './preset.ts'

let oracle: Oracle
const trees: string[] = []

before(async () => {
  oracle = await loadOracle()
})

after(() => {
  for (const tree of trees) removeTree(tree)
})

const FULL_PRESET = `module.exports = {
  setupFiles: ['<rootDir>/preset-setup.js'],
  setupFilesAfterEnv: [require.resolve('./preset-after.js')],
  modulePathIgnorePatterns: ['<rootDir>/preset-ignored'],
  moduleNameMapper: { '^shared$': '<rootDir>/preset-shared', '^a$': '<rootDir>/preset-a' },
  transform: { '\\\\.css$': require.resolve('./css-transform.js'), '\\\\.[jt]sx?$': 'babel-jest' },
  globals: { __PRESET__: true, nested: { fromPreset: 1, both: 'preset' }, list: [1] },
  testEnvironment: 'node',
  transformIgnorePatterns: ['node_modules/(?!(react-native|@react-native)/)'],
  haste: { defaultPlatform: 'ios', platforms: ['android', 'ios', 'native'] },
  preset: 'ignored-nested-preset-key',
}
`

const SUPPORT: Tree = {
  'preset-setup.js': '',
  'own-setup.js': '',
  'presets/preset-after.js': '',
  'presets/css-transform.js': 'module.exports = {}\n',
  'own-transform.js': 'module.exports = {}\n',
}

interface Case {
  readonly name: string
  readonly tree: Tree
  readonly file?: string
}

const CASES: readonly Case[] = [
  {
    name: "a relative preset merges by Jest's rules",
    tree: {
      ...SUPPORT,
      'presets/jest-preset.js': FULL_PRESET,
      'jest.config.js': `module.exports = {
  preset: './presets/jest-preset.js',
  setupFiles: ['<rootDir>/own-setup.js'],
  modulePathIgnorePatterns: ['<rootDir>/own-ignored'],
  moduleNameMapper: { '^a$': '<rootDir>/own-a', '^b$': '<rootDir>/own-b' },
  transform: { '\\\\.ts$': '<rootDir>/own-transform.js' },
  globals: { nested: { both: 'own', fromOwn: 2 }, list: [2] },
}
`,
    },
  },
  {
    name: 'a preset fills keys the config leaves out (setupFilesAfterEnv, transform, globals)',
    tree: {
      ...SUPPORT,
      'presets/jest-preset.js': FULL_PRESET,
      'jest.config.js': "module.exports = { preset: '<rootDir>/presets/jest-preset.js' }\n",
    },
  },
  {
    name: 'a monorepo preset two levels up, as JSON',
    tree: {
      'jest-preset.base.json':
        '{ "testEnvironment": "node", "setupFiles": ["<rootDir>/s.js"], "testMatch": ["<rootDir>/src/**/*.test.js"] }\n',
      'packages/app/s.js': '',
      'packages/app/jest.config.js':
        "module.exports = { preset: '<rootDir>/../../jest-preset.base.json', displayName: 'app' }\n",
    },
    file: 'packages/app/jest.config.js',
  },
  {
    name: 'a package preset (x/jest-preset.js)',
    tree: {
      'node_modules/my-preset/package.json': '{ "name": "my-preset" }\n',
      'node_modules/my-preset/jest-preset.js':
        "module.exports = { testEnvironment: 'node', setupFilesAfterEnv: [require.resolve('./after.js')] }\n",
      'node_modules/my-preset/after.js': '',
      'jest.config.js': "module.exports = { preset: 'my-preset' }\n",
    },
  },
  {
    name: 'a scoped package preset (jest-preset.json)',
    tree: {
      'node_modules/@scope/preset/package.json': '{ "name": "@scope/preset" }\n',
      'node_modules/@scope/preset/jest-preset.json':
        '{ "clearMocks": true, "roots": ["<rootDir>"] }\n',
      'jest.config.js': "module.exports = { preset: '@scope/preset', clearMocks: false }\n",
    },
  },
  {
    name: 'a preset subpath (x/presets/y/jest-preset.js)',
    tree: {
      'node_modules/ts-like/package.json': '{ "name": "ts-like" }\n',
      'node_modules/ts-like/presets/esm/jest-preset.js':
        "module.exports = { extensionsToTreatAsEsm: ['.ts'], transform: { '^.+\\\\.tsx?$': [require.resolve('../../t.js'), { useESM: true }] } }\n",
      'node_modules/ts-like/t.js': 'module.exports = {}\n',
      'jest.config.js': "module.exports = { preset: 'ts-like/presets/esm' }\n",
    },
  },
  {
    name: 'an .mjs package preset',
    tree: {
      'node_modules/esm-preset/package.json': '{ "name": "esm-preset" }\n',
      'node_modules/esm-preset/jest-preset.mjs':
        'export default { testTimeout: 1234, verbose: true }\n',
      'jest.config.js': "module.exports = { preset: 'esm-preset' }\n",
    },
  },
  {
    name: 'a nested preset: one preset spreads another',
    tree: {
      'presets/base.js':
        "module.exports = { testEnvironment: 'node', moduleNameMapper: { '^base$': '<rootDir>/base' } }\n",
      'presets/child.js':
        "const base = require('./base.js')\nmodule.exports = { ...base, moduleNameMapper: { ...base.moduleNameMapper, '^child$': '<rootDir>/child' } }\n",
      'jest.config.js':
        "module.exports = { preset: './presets/child.js', moduleNameMapper: { '^own$': 'x' } }\n",
    },
  },
  {
    name: 'a preset that is not found',
    tree: { 'jest.config.js': "module.exports = { preset: 'no-such-preset' }\n" },
  },
  {
    name: 'a package without jest-preset',
    tree: {
      'node_modules/not-a-preset/package.json': '{ "name": "not-a-preset", "main": "index.js" }\n',
      'node_modules/not-a-preset/index.js': 'module.exports = {}\n',
      'jest.config.js': "module.exports = { preset: 'not-a-preset' }\n",
    },
  },
]

for (const fixture of CASES) {
  test(`presets as jest-config does: ${fixture.name}`, async () => {
    const root = writeTree(fixture.tree)
    trees.push(root)
    const path = join(root, fixture.file ?? 'jest.config.js')
    const ours = await readJestConfig(path, {
      cwd: root,
      requireResolve: oracleRequireResolve,
      ci: oracle.defaults.ci === true,
      seed: 0,
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
    const theirs = await inDirectory(root, () =>
      oracle.readConfig({ ...ORACLE_ARGV, _: [] }, path),
    ).then(
      (value) => ({
        value: value as { projectConfig: unknown; globalConfig: unknown },
        error: undefined,
      }),
      (error: unknown) => ({ value: undefined, error }),
    )
    if (theirs.error !== undefined) {
      assert.ok(
        ours.error instanceof JestConfigError,
        `ours should fail: ${plainMessage(theirs.error)}`,
      )
      assert.equal(ours.error.code, 'JEST_CONFIG_PRESET')
      assert.equal(ours.error.message, plainMessage(theirs.error))
      return
    }
    if (ours.error !== undefined) throw ours.error
    assert.ok(ours.value !== undefined && theirs.value !== undefined)
    assert.deepEqual(comparable(ours.value.projectConfig), comparable(theirs.value.projectConfig))
    assert.deepEqual(
      comparableWithout(ours.value.globalConfig, ['seed']),
      comparableWithout(theirs.value.globalConfig, ['seed']),
    )
  })
}

test('deepMerge: arrays concatenate, objects merge, sources are cloned', () => {
  const source = { a: { b: [2] } }
  const merged = deepMerge({ a: { b: [1], c: 1 }, d: 1 }, source) as Record<string, unknown>
  assert.deepEqual(merged, { a: { b: [1, 2], c: 1 }, d: 1 })
  assert.notEqual((merged.a as Record<string, unknown>).b, source.a.b)
})
