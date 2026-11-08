// T11.6's in-process check: distilled configs covering the keys real repositories use (Track 11
// F4) and the rules the normalizer must get right (transform tuples, mapper arrays, `<rootDir>`,
// `projects` strings and objects, `testMatch` against `testRegex`, `babel-jest` injection), each
// read by ours and by real `jest-config` 30.5.2 (`readConfig`), and compared key for key: every key
// of the project config and of the global config except `seed` (random). Where Jest fails, ours
// fails with the same text. Jest's own packages resolve from jest-config's install on both sides.
// The full sample (Jest configs from real repositories) is `pnpm bench:jest-config sample`.
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
import { readJestConfig, readJestConfigs } from './normalize.ts'

let oracle: Oracle
const trees: string[] = []

before(async () => {
  oracle = await loadOracle()
})

after(() => {
  for (const tree of trees) removeTree(tree)
})

const CJS_MODULE = 'module.exports = {}\n'

/** Small packages a config can name, written into the tree's node_modules. */
const PACKAGES: Tree = {
  'node_modules/fake-transformer/package.json':
    '{ "name": "fake-transformer", "main": "index.js" }\n',
  'node_modules/fake-transformer/index.js': 'module.exports = { process: () => ({ code: "" }) }\n',
  'node_modules/fake-setup/package.json': '{ "name": "fake-setup", "main": "setup.js" }\n',
  'node_modules/fake-setup/setup.js': CJS_MODULE,
  'node_modules/fake-serializer/package.json': '{ "name": "fake-serializer" }\n',
  'node_modules/fake-serializer/index.js':
    'module.exports = { test: () => false, print: () => "" }\n',
  'node_modules/jest-environment-jsdom/package.json':
    '{ "name": "jest-environment-jsdom", "main": "build/index.js" }\n',
  'node_modules/jest-environment-jsdom/build/index.js': 'module.exports = class {}\n',
  'node_modules/fake-reporter/package.json': '{ "name": "fake-reporter" }\n',
  'node_modules/fake-reporter/index.js': 'module.exports = class {}\n',
  'node_modules/jest-watch-typeahead/package.json':
    '{ "name": "jest-watch-typeahead", "exports": { "./filename": "./filename.js" } }\n',
  'node_modules/jest-watch-typeahead/filename.js': 'module.exports = class {}\n',
  'node_modules/jest-runner-eslint/package.json': '{ "name": "jest-runner-eslint" }\n',
  'node_modules/jest-runner-eslint/index.js': CJS_MODULE,
  'node_modules/prettier/package.json': '{ "name": "prettier", "main": "index.cjs" }\n',
  'node_modules/prettier/index.cjs': CJS_MODULE,
  'node_modules/conditional/package.json':
    '{ "name": "conditional", "exports": { "import": "./esm.mjs", "require": "./cjs.js" } }\n',
  'node_modules/conditional/esm.mjs': 'export default {}\n',
  'node_modules/conditional/cjs.js': CJS_MODULE,
}

function config(body: string, extra: Tree = {}): Tree {
  return { ...PACKAGES, 'jest.config.js': `module.exports = ${body}\n`, ...extra }
}

interface Case {
  readonly name: string
  readonly tree: Tree
  /** The file to read, relative to the tree. Default `jest.config.js`. */
  readonly file?: string
}

const CASES: readonly Case[] = [
  { name: 'an empty config: every default', tree: config('{}') },
  {
    name: 'transform tuple keeps its options and gets no babel-jest',
    tree: config(
      `{ transform: { '^.+\\\\.tsx?$': ['fake-transformer', { isolatedModules: true }] } }`,
    ),
  },
  {
    name: "transform 'babel-jest' is Jest's own copy",
    tree: config(
      `{ transform: { '\\\\.[jt]sx?$': 'babel-jest', '\\\\.css$': '<rootDir>/css.js' } }`,
      {
        'css.js': CJS_MODULE,
      },
    ),
  },
  {
    name: "transform ['babel-jest', options] is Jest's own copy",
    tree: config(`{ transform: { '^.+\\\\.(js|ts)$': ['babel-jest', { rootMode: 'upward' }] } }`),
  },
  {
    name: 'moduleNameMapper keeps order, string[] targets and <rootDir>',
    tree: config(
      `{ moduleNameMapper: { '^@/(.*)$': ['<rootDir>/src/$1', '<rootDir>/lib/$1'], '\\\\.(css|less)$': 'identity-obj-proxy', '^~(.*)': '<rootDir>/$1' } }`,
    ),
  },
  {
    name: 'roots and modulePaths with <rootDir>',
    tree: config(
      `{ roots: ['<rootDir>/src', '<rootDir>'], modulePaths: ['<rootDir>/src', 'lib'] }`,
      {
        'src/x.txt': '',
      },
    ),
  },
  {
    name: 'testMatch with <rootDir> and a single string',
    tree: config(`{ testMatch: '<rootDir>/src/**/*.test.[jt]s?(x)' }`),
  },
  {
    name: 'testMatch array',
    tree: config(`{ testMatch: ['**/?(*.)+(spec).ts', '<rootDir>/t/**'] }`),
  },
  {
    name: 'testRegex string',
    tree: config(`{ testRegex: '(/__tests__/.*|(\\\\.|/)(test|spec))\\\\.[jt]sx?$' }`),
  },
  { name: 'testRegex array', tree: config(`{ testRegex: ['/a/', '\\\\.spec\\\\.js$'] }`) },
  {
    name: 'setupFiles and setupFilesAfterEnv: paths and packages',
    tree: config(
      `{ setupFiles: ['<rootDir>/setup.js', './setup2.js', 'fake-setup'], setupFilesAfterEnv: ['<rootDir>/after.js'] }`,
      { 'setup.js': '', 'setup2.js': '', 'after.js': '' },
    ),
  },
  {
    name: 'snapshotSerializers and a conditional package (require condition)',
    tree: config(`{ snapshotSerializers: ['fake-serializer', 'conditional'] }`),
  },
  { name: "testEnvironment 'node'", tree: config(`{ testEnvironment: 'node' }`) },
  {
    name: "testEnvironment 'jsdom'",
    tree: config(`{ testEnvironment: 'jsdom', testEnvironmentOptions: { url: 'http://x/' } }`),
  },
  {
    name: 'testEnvironment as a path',
    tree: config(`{ testEnvironment: '<rootDir>/env.js' }`, { 'env.js': CJS_MODULE }),
  },
  { name: 'displayName string', tree: config(`{ displayName: 'unit' }`) },
  { name: 'displayName object', tree: config(`{ displayName: { name: 'unit', color: 'blue' } }`) },
  {
    name: 'coverage keys',
    tree: config(
      `{ collectCoverage: true, collectCoverageFrom: ['<rootDir>/src/**/*.ts', '!<rootDir>/src/**/*.d.ts', 'lib/*.js'], coverageDirectory: 'out/coverage', coveragePathIgnorePatterns: ['<rootDir>/build/', '/node_modules/'], coverageReporters: ['text', ['lcov', { projectRoot: '..' }]], coverageThreshold: { global: { lines: 80 }, './src/': { branches: 50 } }, coverageProvider: 'v8' }`,
    ),
  },
  {
    name: 'ignore patterns with <rootDir> and a negative lookahead',
    tree: config(
      `{ testPathIgnorePatterns: ['/node_modules/', '<rootDir>/dist/'], transformIgnorePatterns: ['node_modules/(?!(react-native|@react-native)/)'], modulePathIgnorePatterns: ['<rootDir>/build'], watchPathIgnorePatterns: ['<rootDir>/tmp'] }`,
    ),
  },
  {
    name: 'moduleFileExtensions with js',
    tree: config(`{ moduleFileExtensions: ['ts', 'tsx', 'js', 'json'] }`),
  },
  {
    name: 'moduleFileExtensions without js fails',
    tree: config(`{ moduleFileExtensions: ['ts'] }`),
  },
  {
    name: 'testMatch and testRegex together fail',
    tree: config(`{ testMatch: ['**/*.t.js'], testRegex: 'x' }`),
  },
  {
    name: 'projects: directories, a glob and inline objects',
    tree: config(
      `{ projects: ['<rootDir>/packages/*', '<rootDir>/apps/web', { displayName: 'inline', testMatch: ['<rootDir>/inline/**'] }, 'missing-dir'] }`,
      {
        'packages/zeta/jest.config.js': CJS_MODULE,
        'packages/alpha/jest.config.js': CJS_MODULE,
        'packages/Beta/package.json': '{ "name": "b" }\n',
        'packages/readme.md': '',
        'apps/web/jest.config.js': CJS_MODULE,
      },
    ),
  },
  {
    name: 'globals, fakeTimers, haste, snapshotFormat',
    tree: config(
      `{ globals: { __DEV__: true, 'ts-jest': { tsconfig: '<rootDir>/tsconfig.json' } }, fakeTimers: { enableGlobally: true, doNotFake: ['nextTick'] }, haste: { defaultPlatform: 'ios', platforms: ['ios', 'android'], hasteImplModulePath: '<rootDir>/haste.js' }, snapshotFormat: { printBasicPrototype: true } }`,
      { 'haste.js': CJS_MODULE },
    ),
  },
  {
    name: 'workers and memory',
    tree: config(`{ maxWorkers: '50%', workerIdleMemoryLimit: '512MB', maxConcurrency: 2 }`),
  },
  {
    name: 'maxWorkers number and a percentage memory limit',
    tree: config(`{ maxWorkers: 2, workerIdleMemoryLimit: 0.5 }`),
  },
  {
    name: 'reporters and watchPlugins',
    tree: config(
      `{ reporters: ['default', ['fake-reporter', { out: 'x' }], 'github-actions'], watchPlugins: ['jest-watch-typeahead/filename', ['jest-watch-typeahead/filename', { key: 'k' }]] }`,
    ),
  },
  {
    name: 'bail true, testTimeout, verbose, silent',
    tree: config(`{ bail: true, testTimeout: 30000, verbose: true, silent: false }`),
  },
  { name: 'bail as a number', tree: config(`{ bail: 3 }`) },
  {
    name: "runner 'eslint' (jest-runner-eslint) and testRunner 'jest-circus'",
    tree: config(`{ runner: 'eslint', testRunner: 'jest-circus', displayName: 'lint' }`),
  },
  {
    name: 'runner tuple with options',
    tree: config(`{ runner: ['jest-runner-eslint', { cliOptions: {} }] }`),
  },
  { name: 'prettierPath', tree: config(`{ prettierPath: 'prettier' }`) },
  {
    name: 'a custom resolver resolves the other paths',
    tree: config(`{ resolver: '<rootDir>/resolver.js', setupFiles: ['fake-setup'] }`, {
      'resolver.js':
        'module.exports = (path, options) => options.defaultResolver(path.replace(/^@@/, ""), options)\n',
    }),
  },
  {
    name: 'globalSetup and globalTeardown',
    tree: config(`{ globalSetup: '<rootDir>/gs.js', globalTeardown: './gt.js' }`, {
      'gs.js': CJS_MODULE,
      'gt.js': CJS_MODULE,
    }),
  },
  {
    name: 'mock keys, injectGlobals, cacheDirectory',
    tree: config(
      `{ clearMocks: true, resetMocks: true, restoreMocks: true, automock: false, injectGlobals: false, cacheDirectory: '<rootDir>/.cache', resetModules: true, slowTestThreshold: 2 }`,
    ),
  },
  { name: 'extensionsToTreatAsEsm', tree: config(`{ extensionsToTreatAsEsm: ['.ts', '.tsx'] }`) },
  {
    name: "extensionsToTreatAsEsm with '.js' fails",
    tree: config(`{ extensionsToTreatAsEsm: ['.js'] }`),
  },
  { name: 'a missing setup file fails', tree: config(`{ setupFiles: ['<rootDir>/nope.js'] }`) },
  { name: 'a missing root fails', tree: config(`{ roots: ['<rootDir>/nope'] }`) },
  {
    name: 'package.json config',
    tree: {
      ...PACKAGES,
      'package.json':
        '{ "name": "p", "jest": { "testEnvironment": "node", "roots": ["<rootDir>"] } }\n',
    },
    file: 'package.json',
  },
  {
    name: 'unknown and deprecated keys come out undefined',
    tree: config(`{ testURL: 'http://x', ci: true, foo: 1 }`),
  },
  {
    name: 'a relative rootDir',
    tree: {
      ...PACKAGES,
      'config/jest.config.js': "module.exports = { rootDir: '..', roots: ['<rootDir>/src'] }\n",
      'src/x.txt': '',
    },
    file: 'config/jest.config.js',
  },
]

async function readBoth(root: string, file: string) {
  const path = join(root, file)
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
  return { ours, theirs }
}

for (const fixture of CASES) {
  test(`normalizes as jest-config does: ${fixture.name}`, async () => {
    const root = writeTree(fixture.tree)
    trees.push(root)
    const { ours, theirs } = await readBoth(root, fixture.file ?? 'jest.config.js')
    if (theirs.error !== undefined) {
      assert.ok(
        ours.error instanceof JestConfigError,
        `ours should fail too: ${plainMessage(theirs.error)}`,
      )
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

test('about 30 distilled configs', () => {
  assert.ok(CASES.length >= 30, `${CASES.length}`)
})

test('projects: readJestConfigs reads each one as readConfigs does', async () => {
  const root = writeTree({
    ...PACKAGES,
    'jest.config.js':
      "module.exports = { projects: ['<rootDir>/packages/*', { displayName: 'inline', rootDir: '<rootDir>/inline' }], coverageReporters: ['text'] }\n",
    'packages/a/jest.config.js': "module.exports = { displayName: 'a', testEnvironment: 'node' }\n",
    'packages/b/package.json': '{ "name": "b", "jest": { "displayName": "b" } }\n',
    'inline/x.txt': '',
  })
  trees.push(root)
  const ours = await readJestConfigs([root], {
    cwd: root,
    requireResolve: oracleRequireResolve,
    ci: oracle.defaults.ci === true,
    seed: 0,
  })
  const theirs = (await inDirectory(root, () =>
    oracle.readConfigs({ ...ORACLE_ARGV, _: [] }, [root]),
  )) as {
    configs: unknown[]
    globalConfig: unknown
  }
  assert.equal(ours.configs.length, 3)
  assert.deepEqual(comparable(ours.configs), comparable(theirs.configs))
  assert.deepEqual(
    comparableWithout(ours.globalConfig, ['seed']),
    comparableWithout(theirs.globalConfig, ['seed']),
  )
})
