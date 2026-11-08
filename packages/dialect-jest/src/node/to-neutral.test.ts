// The reader end to end: find → load → resolve → toNeutral, then `@provino/config`'s
// `resolveNeutralProject` with `jestNodeDialect`. Checks what each Jest key becomes in the neutral
// project, that nothing in it is a `RegExp` or a function and every path is absolute, that keys read
// but not applied yet warn naming their task, and that the project resolves to a worker config.
import assert from 'node:assert/strict'
import { isAbsolute, join } from 'node:path'
import { after, test } from 'node:test'
import { resolveNeutralProject } from '@provino/config'
import { resolvePolicy } from '@provino/policy'
import { createJestConfigReader, jestNodeDialect } from './index.ts'
import { oracleRequireResolve, removeTree, type Tree, writeTree } from './internal/test-support.ts'
import { neutralEnvironmentName } from './to-neutral.ts'

const trees: string[] = []
after(() => {
  for (const tree of trees) removeTree(tree)
})

function tree(files: Tree): string {
  const root = writeTree(files)
  trees.push(root)
  return root
}

async function readNeutral(root: string) {
  const reader = createJestConfigReader({
    cwd: root,
    requireResolve: oracleRequireResolve,
    seed: 0,
  })
  const source = await reader.find(root)
  assert.ok(source !== undefined)
  const raw = await reader.load(source)
  const resolved = await reader.resolve(raw, source)
  const neutral = reader.toNeutral(resolved.value)
  return { source, resolved, neutral }
}

/** Every string in a value, with its path, and whether a RegExp or function is anywhere. */
function walk(value: unknown, path: string, out: { strings: [string, string][]; bad: string[] }) {
  if (typeof value === 'string') out.strings.push([path, value])
  else if (typeof value === 'function' || value instanceof RegExp) out.bad.push(path)
  else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) walk(item, `${path}[${i}]`, out)
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, out)
  }
}

test('a plain config: discovery, setup files, environment and policy keys', async () => {
  const root = tree({
    'jest.config.js': `module.exports = {
  displayName: 'unit',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/dist/'],
  modulePathIgnorePatterns: ['<rootDir>/build'],
  moduleFileExtensions: ['ts', 'js'],
  setupFiles: ['<rootDir>/before.js'],
  setupFilesAfterEnv: ['<rootDir>/after.js'],
  testEnvironment: 'node',
  testEnvironmentOptions: { customExportConditions: ['node'] },
  testTimeout: 1234,
  clearMocks: true,
  injectGlobals: false,
  slowTestThreshold: 2,
  passWithNoTests: true,
}
`,
    'src/x.txt': '',
    'before.js': '',
    'after.js': '',
  })
  const { neutral } = await readNeutral(root)
  assert.equal(neutral.value.length, 1)
  const [project] = neutral.value
  assert.ok(project !== undefined)
  assert.equal(project.name, 'unit')
  assert.equal(project.rootDir, root)
  assert.deepEqual(project.discovery, {
    roots: [join(root, 'src')],
    extensions: ['ts', 'js'],
    includePatterns: { kind: 'glob', patterns: ['**/*.spec.ts'] },
    excludePatterns: ['/node_modules/', `${root}/dist/`],
    crawlIgnorePatterns: [`${root}/build`],
  })
  assert.deepEqual(project.setupFiles, [join(root, 'before.js')])
  assert.deepEqual(project.setupFilesAfterEnv, [join(root, 'after.js')])
  assert.deepEqual(project.environment, {
    name: 'node',
    options: { customExportConditions: ['node'] },
  })
  const policy = resolvePolicy(project.policy)
  assert.equal(policy.core.timeouts.test, 1234)
  assert.equal(policy.core.injectGlobals, false)
  assert.equal(policy.mock.between.clear, true)
  assert.equal(policy.orchestrator.slowTestThresholdMs, 2000)
  assert.equal(policy.orchestrator.passWithNoTests, true)
  // The default babel-jest transform and the node environment are not warnings.
  assert.deepEqual(neutral.diagnostics, [])
})

test('testRegex becomes regex include patterns', async () => {
  const root = tree({ 'jest.config.js': "module.exports = { testRegex: ['\\\\.t\\\\.js$'] }\n" })
  const [project] = (await readNeutral(root)).neutral.value
  assert.deepEqual(project?.discovery.includePatterns, { kind: 'regex', patterns: ['\\.t\\.js$'] })
})

test('snapshotSerializers and snapshotFormat go to the snapshot policy, and warn about nothing', async () => {
  const root = tree({
    'jest.config.js': `module.exports = {
  snapshotSerializers: ['<rootDir>/first.js', '<rootDir>/second.js'],
  snapshotFormat: { escapeString: true, indent: 4, maxDepth: 3 },
}
`,
    'first.js': '',
    'second.js': '',
  })
  const { neutral } = await readNeutral(root)
  const [project] = neutral.value
  assert.deepEqual(project?.policy.snapshot, {
    serializers: [join(root, 'first.js'), join(root, 'second.js')],
    format: { escapeString: true, printBasicPrototype: false, extra: { indent: 4, maxDepth: 3 } },
  })
  assert.deepEqual(neutral.diagnostics, [])
})

test('no RegExp or function, and every path absolute', async () => {
  const root = tree({
    'jest.config.js': `module.exports = {
  transform: { '\\\\.ts$': ['<rootDir>/t.js', { fn: () => 1, keep: 'yes', re: /x/ }] },
  moduleNameMapper: { '^a$': ['<rootDir>/a', '<rootDir>/b'], '^c$': '<rootDir>/c' },
  snapshotSerializers: ['<rootDir>/s.js'],
  testEnvironmentOptions: { now: () => 0 },
}
`,
    't.js': '',
    's.js': '',
  })
  const { neutral } = await readNeutral(root)
  const [project] = neutral.value
  assert.ok(project !== undefined)
  const found = { strings: [] as [string, string][], bad: [] as string[] }
  walk(project, 'project', found)
  assert.deepEqual(found.bad, [])
  assert.deepEqual(project.aliases, [
    { pattern: '^a$', targets: [join(root, 'a'), join(root, 'b')] },
    { pattern: '^c$', targets: [join(root, 'c')] },
  ])
  assert.deepEqual(project.transforms, [
    { pattern: '\\.ts$', module: join(root, 't.js'), options: { keep: 'yes' } },
  ])
  for (const key of [
    'rootDir',
    'setupFiles',
    'setupFilesAfterEnv',
    'snapshotSerializers',
    'roots',
  ]) {
    for (const [path, value] of found.strings.filter(([p]) => p.includes(`.${key}`))) {
      assert.ok(isAbsolute(value), `${path}: ${value}`)
    }
  }
  const codes = neutral.diagnostics.map((d) => `${d.code} ${d.key}`)
  assert.ok(codes.includes('JEST_CONFIG_NOT_SERIALIZABLE transform["\\.ts$"].fn'))
  assert.ok(codes.includes('JEST_CONFIG_NOT_SERIALIZABLE transform["\\.ts$"].re'))
  assert.ok(codes.includes('JEST_CONFIG_NOT_SERIALIZABLE testEnvironmentOptions.now'))
})

test('keys read but not applied yet warn, naming the task (gap 9)', async () => {
  const root = tree({
    'node_modules/jest-environment-jsdom/package.json': '{ "name": "jest-environment-jsdom" }\n',
    'node_modules/jest-environment-jsdom/index.js': 'module.exports = class {}\n',
    'jest.config.js': `module.exports = {
  testEnvironment: 'jsdom',
  transform: { '\\\\.ts$': '<rootDir>/t.js' },
  moduleNameMapper: { '^a$': 'b' },
  fakeTimers: { enableGlobally: true },
}
`,
    't.js': '',
  })
  const { neutral } = await readNeutral(root)
  const messages = neutral.diagnostics.map((d) => d.message)
  assert.ok(messages.some((m) => m.startsWith('Jest config key "transform"') && m.includes('T3.8')))
  assert.ok(
    messages.some((m) => m.startsWith('Jest config key "moduleNameMapper"') && m.includes('T3.3')),
  )
  assert.ok(
    messages.some((m) => m.startsWith('Jest config key "testEnvironment"') && m.includes('T8.3')),
  )
  assert.ok(
    messages.some((m) => m.startsWith('Jest config key "fakeTimers"') && m.includes('T4.9')),
  )
  assert.equal(neutral.value[0]?.environment.name, 'jsdom')
})

test('projects: one neutral project each', async () => {
  const root = tree({
    'jest.config.js': "module.exports = { projects: ['<rootDir>/a', { displayName: 'inline' }] }\n",
    'a/jest.config.js': "module.exports = { displayName: 'a' }\n",
  })
  const { neutral } = await readNeutral(root)
  assert.deepEqual(
    neutral.value.map((project) => project.name),
    ['a', 'inline'],
  )
})

test('the neutral project resolves to a worker config through @provino/config', async () => {
  const root = tree({
    'jest.config.js':
      "module.exports = { setupFiles: ['<rootDir>/before.js'], setupFilesAfterEnv: ['<rootDir>/after.js'], testEnvironmentOptions: { a: 1 }, clearMocks: true }\n",
    'before.js': '',
    'after.js': '',
    'env.js': 'export const env = {}\n',
  })
  const [project] = (await readNeutral(root)).neutral.value
  assert.ok(project !== undefined)
  const resolved = await resolveNeutralProject(project, {
    dialect: jestNodeDialect,
    environments: { node: { module: join(root, 'env.js'), export: 'env' } },
    ci: false,
  })
  assert.equal(resolved.dialect, jestNodeDialect)
  assert.equal(resolved.environment, 'node')
  assert.equal(resolved.isolation, 'registry')
  assert.deepEqual(resolved.config.setupFiles, [join(root, 'before.js')])
  assert.deepEqual(resolved.config.setupFilesAfterEnv, [join(root, 'after.js')])
  assert.deepEqual(resolved.config.environment.options, { a: 1 })
  assert.equal(resolved.policy.mock.between.clear, true)
  assert.deepEqual(resolved.discovery, project.discovery)
  assert.ok(resolved.config.globals !== null)
})

test('neutralEnvironmentName', () => {
  assert.equal(
    neutralEnvironmentName('/x/node_modules/jest-environment-node/build/index.js'),
    'node',
  )
  assert.equal(neutralEnvironmentName('jest-environment-node'), 'node')
  assert.equal(
    neutralEnvironmentName('/x/node_modules/jest-environment-jsdom/build/index.js'),
    'jsdom',
  )
  assert.equal(
    neutralEnvironmentName('/x/node_modules/@happy-dom/jest-environment/lib/index.js'),
    'happy-dom',
  )
  assert.equal(neutralEnvironmentName('/repo/env.js'), '/repo/env.js')
})

test('the reader finds nothing above a tree with no package.json', async () => {
  const reader = createJestConfigReader()
  assert.equal(await reader.find('/'), undefined)
  await assert.rejects(reader.find('/', '/no/such/config.js'), { code: 'JEST_CONFIG_NO_ROOT' })
})

test('jestNodeDialect is jestDialect with the reader', async () => {
  const { jestDialect } = await import('@provino/dialect-jest')
  assert.equal(jestNodeDialect.name, 'jest')
  assert.equal(jestNodeDialect.policy, jestDialect.policy)
  assert.equal(jestNodeDialect.globals, jestDialect.globals)
  assert.ok(jestNodeDialect.configReader !== undefined)
  assert.ok(jestNodeDialect.configReader.candidates.includes('jest.config.ts'))
})
