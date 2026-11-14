// The reader end to end: find → load → resolve → toNeutral, then `@provino/config`'s
// `resolveNeutralProject` with `jestNodeDialect`. Checks what each Jest key becomes in the neutral
// project, that nothing in it is a `RegExp` or a function and every path is absolute, that keys read
// but not applied yet warn naming their task, and that the project resolves to a worker config.
import assert from 'node:assert/strict'
import { delimiter, isAbsolute, join } from 'node:path'
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
  assert.equal(project.environment.name, 'node')
  // One shape for every environment: the options live under `projectConfig`; no `module` for `node`.
  assert.equal('module' in project.environment.options, false)
  assert.deepEqual(
    (project.environment.options.projectConfig as { testEnvironmentOptions: unknown })
      .testEnvironmentOptions,
    { customExportConditions: ['node'] },
  )
  const policy = resolvePolicy(project.policy)
  assert.equal(policy.core.timeouts.test, 1234)
  assert.equal(policy.core.injectGlobals, false)
  assert.equal(policy.mock.between.clear, true)
  assert.equal(policy.orchestrator.slowTestThresholdMs, 2000)
  assert.equal(policy.orchestrator.passWithNoTests, true)
  // The default babel-jest transform and the node environment are not warnings.
  assert.deepEqual(neutral.diagnostics, [])
})

test('testFailureExitCode is what a failed run and an unhandled error exit with', async () => {
  const root = tree({ 'jest.config.js': 'module.exports = { testFailureExitCode: 7 }\n' })
  const [project] = (await readNeutral(root)).neutral.value
  assert.ok(project !== undefined)
  const policy = resolvePolicy(project.policy)
  assert.equal(policy.orchestrator.exitCodes.failure, 7)
  assert.equal(policy.orchestrator.exitCodes.unhandled, 7)
  // The codes for no tests and for a refused command line are not that config's.
  assert.equal(policy.orchestrator.exitCodes.noTests, 1)
})

// `jestAdapterInit.ts` L79-L81: `if (globalConfig.testTimeout) state.testTimeout = ...`, so the
// circus state a `handleTestEvent` reads holds the project's timeout from `setup` on.
test("testTimeout reaches the environment's globalConfig; Jest's default and 0 leave it out", async () => {
  const globalOf = async (config: string): Promise<Record<string, unknown>> => {
    const [project] = (await readNeutral(tree({ 'jest.config.js': config }))).neutral.value
    assert.ok(project !== undefined)
    return project.environment.options.globalConfig as Record<string, unknown>
  }
  assert.equal((await globalOf('module.exports = { testTimeout: 1234 }\n')).testTimeout, 1234)
  assert.equal('testTimeout' in (await globalOf('module.exports = { testTimeout: 0 }\n')), false)
  assert.equal('testTimeout' in (await globalOf('module.exports = {}\n')), false)
})

test('a cache directory inside the root is not crawled, as jest-runtime builds the ignore pattern', async () => {
  const root = tree({
    'jest.config.js':
      "module.exports = { cacheDirectory: '<rootDir>/.cache/jest', modulePathIgnorePatterns: ['<rootDir>/build'] }\n",
  })
  const [project] = (await readNeutral(root)).neutral.value
  assert.deepEqual(project?.discovery.crawlIgnorePatterns, [`${root}/build`, `${root}/.cache/jest`])
  // The default cache directory is in the temp directory: nothing to ignore.
  const plain = tree({ 'jest.config.js': 'module.exports = {}\n' })
  const [other] = (await readNeutral(plain)).neutral.value
  assert.deepEqual(other?.discovery.crawlIgnorePatterns, [])
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
  const { inline, ...rest } = project?.policy.snapshot ?? {}
  assert.deepEqual(rest, {
    serializers: [join(root, 'first.js'), join(root, 'second.js')],
    format: { escapeString: true, printBasicPrototype: false, extra: { indent: 4, maxDepth: 3 } },
  })
  // The default `prettierPath` (B23d B1): Prettier as Jest's install finds it, absolute.
  assert.match(String(inline?.prettierPath), /[\\/]prettier[\\/]index\.cjs$/)
  assert.deepEqual(neutral.diagnostics, [])
})

test('prettierPath: an explicit null stays null, a path resolves, and snapshotResolver is carried (B23d B1)', async () => {
  const root = tree({
    'jest.config.js': `module.exports = { prettierPath: null, snapshotResolver: '<rootDir>/resolver.js' }\n`,
    'resolver.js': '',
  })
  const { neutral } = await readNeutral(root)
  const [project] = neutral.value
  assert.equal(project?.policy.snapshot?.inline?.prettierPath, null)
  assert.equal(project?.snapshotResolver, join(root, 'resolver.js'))
  // No "not applied" warning for the resolver any more.
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
  // T3.8 applies `transform`: it is no longer a warning.
  assert.ok(!messages.some((m) => m.startsWith('Jest config key "transform"')))
  // T3.3 applies the mapper, so it no longer warns, and the resolver keys reach the neutral project.
  assert.ok(!messages.some((m) => m.startsWith('Jest config key "moduleNameMapper"')))
  assert.deepEqual(neutral.value[0]?.aliases, [{ pattern: '^a$', targets: ['b'] }])
  assert.deepEqual(neutral.value[0]?.resolution?.moduleDirectories, ['node_modules'])
  // D44: jsdom is the project's own environment class, run through the adapter, so it no longer warns.
  assert.ok(!messages.some((m) => m.startsWith('Jest config key "testEnvironment"')))
  // `fakeTimers` applies through @provino/timers, so it no longer warns (T4.9).
  assert.ok(!messages.some((m) => m.startsWith('Jest config key "fakeTimers"')))
  const environment = neutral.value[0]?.environment
  assert.match(environment?.name ?? '', /jest-environment-jsdom/)
  assert.equal(environment?.options.module, environment?.name)
})

test('globalSetup and globalTeardown reach the neutral project with the two configs a hook is called with (T9.15)', async () => {
  const root = tree({
    'jest.config.js': `module.exports = {
  globalSetup: '<rootDir>/setup.js',
  globalTeardown: './teardown.js',
  testMatch: ['**/*.spec.ts'],
}
`,
    'setup.js': '',
    'teardown.js': '',
  })
  const { neutral, resolved } = await readNeutral(root)
  const [project] = neutral.value
  assert.deepEqual(project?.globalSetup, [join(root, 'setup.js')])
  assert.deepEqual(project?.globalTeardown, [join(root, 'teardown.js')])
  // It is applied now: no "not applied" warning for either key.
  assert.ok(!neutral.diagnostics.some((d) => /globalS|globalT/.test(d.message)))
  const args = project?.globalSetupArgs
  assert.ok(args !== undefined)
  assert.equal(Reflect.get(args.globalConfig, 'rootDir'), root)
  assert.equal(Reflect.get(args.projectConfig, 'rootDir'), root)
  assert.deepEqual(Reflect.get(args.projectConfig, 'testMatch'), ['**/*.spec.ts'])
  // The project's config is Jest's own normalized object, not a copy of it.
  assert.equal(args.projectConfig, resolved.value.configs[0])
})

test('a hook is called with the configs as they are: nothing is lost to JSON, and the run’s global config is built once (T9.15)', async () => {
  const root = tree({
    'jest.config.js': `module.exports = {
  globalSetup: '<rootDir>/setup.js',
  projects: ['<rootDir>/one', '<rootDir>/two'],
}
`,
    'setup.js': '',
    'one/jest.config.js': `module.exports = {
  displayName: 'one',
  transform: { '\\\\.ts$': ['<rootDir>/t.js', { fn: () => 1, keep: 'yes' }] },
}
`,
    'one/t.js': '',
    'two/jest.config.js': "module.exports = { displayName: 'two' }\n",
  })
  const { neutral, resolved } = await readNeutral(root)
  const [one, two] = neutral.value
  assert.ok(one?.globalSetupArgs !== undefined && two?.globalSetupArgs !== undefined)
  // A function in a transformer's options reaches the hook, and no warning says it was left out.
  const transform = Reflect.get(one.globalSetupArgs.projectConfig, 'transform') as [
    string,
    string,
    { fn(): number; keep: string },
  ][]
  assert.equal(transform[0]?.[2].fn(), 1)
  assert.ok(!neutral.diagnostics.some((d) => /^(projectConfig|globalConfig)/.test(d.key ?? '')))
  assert.ok(
    !neutral.diagnostics.some(
      (d) => d.code === 'JEST_CONFIG_NOT_SERIALIZABLE' && /global/.test(d.message),
    ),
  )
  // One global config for every project, with `testPathPatterns` as Jest 30's object.
  assert.equal(one.globalSetupArgs.globalConfig, two.globalSetupArgs.globalConfig)
  const { globalConfig } = one.globalSetupArgs
  assert.equal(Reflect.get(globalConfig, 'rootDir'), resolved.value.globalConfig.rootDir)
  const patterns = Reflect.get(globalConfig, 'testPathPatterns') as {
    constructor: { name: string }
    isSet(): boolean
    toPretty(): string
  }
  assert.equal(patterns.constructor.name, 'TestPathPatterns')
  assert.equal(patterns.isSet(), resolved.value.globalConfig.testPathPatterns.length > 0)
  assert.equal(patterns.toPretty(), resolved.value.globalConfig.testPathPatterns.join('|'))
  // Reading again builds another one: it is per read, not a module-level singleton.
  const again = (await readNeutral(root)).neutral.value[0]?.globalSetupArgs?.globalConfig
  assert.notEqual(again, globalConfig)
})

test('the root config’s hooks, with projects, leave every project the two configs a hook is called with, though a project has no hook of its own', async () => {
  const root = tree({
    'jest.config.js': `module.exports = {
  globalSetup: '<rootDir>/root-setup.js',
  globalTeardown: '<rootDir>/root-teardown.js',
  projects: ['<rootDir>/one', '<rootDir>/two'],
}
`,
    'root-setup.js': '',
    'root-teardown.js': '',
    'one/jest.config.js':
      "module.exports = { displayName: 'one', globalSetup: '<rootDir>/own.js' }\n",
    'one/own.js': '',
    'two/jest.config.js': "module.exports = { displayName: 'two' }\n",
  })
  const { neutral } = await readNeutral(root)
  const [one, two] = neutral.value
  assert.deepEqual(one?.globalSetup, [join(root, 'one/own.js')])
  assert.deepEqual(two?.globalSetup, [])
  for (const project of [one, two]) {
    const args = project?.globalSetupArgs
    assert.ok(args !== undefined)
    assert.equal(Reflect.get(args.globalConfig, 'globalSetup'), join(root, 'root-setup.js'))
    assert.equal(
      Reflect.get(args.projectConfig, 'rootDir'),
      project === one ? join(root, 'one') : join(root, 'two'),
    )
  }
})

test('a value in a transformer’s options that is no JSON is still dropped, with a warning, from the worker’s copy; a project with no hook carries no hook arguments', async () => {
  const transform = `transform: { '\\\\.ts$': ['<rootDir>/t.js', { fn: () => 1, keep: 'yes' }] },`
  const noHook = tree({
    'jest.config.js': `module.exports = { ${transform} }\n`,
    't.js': '',
  })
  const quiet = (await readNeutral(noHook)).neutral
  // The transformer's options cross to a worker, so only their JSON does: the function is named.
  assert.ok(
    quiet.diagnostics.some(
      (d) => d.code === 'JEST_CONFIG_NOT_SERIALIZABLE' && d.key === 'transform["\\.ts$"].fn',
    ),
    quiet.diagnostics.map((d) => `${d.code} ${d.key}`).join('\n'),
  )
  assert.equal(quiet.value[0]?.globalSetupArgs, undefined)
})

test('a project with no global setup or teardown carries no hook arguments', async () => {
  const { neutral } = await readNeutral(tree({ 'jest.config.js': 'module.exports = {}\n' }))
  const [project] = neutral.value
  assert.deepEqual(project?.globalSetup, [])
  assert.equal(project?.globalSetupArgs, undefined)
})

test('fakeTimers: enableGlobally is the timers policy, the rest are the defaults of every install', async () => {
  const root = tree({
    'jest.config.js': `module.exports = {
  fakeTimers: { enableGlobally: true, doNotFake: ['nextTick'], timerLimit: 500, now: 1000 },
}
`,
  })
  const { neutral } = await readNeutral(root)
  const [project] = neutral.value
  assert.equal(project?.policy.timers?.enableGlobally, true)
  assert.deepEqual(project?.fakeTimers, { doNotFake: ['nextTick'], timerLimit: 500, now: 1000 })
  assert.equal(typeof project?.seed, 'number')
  assert.ok(!neutral.diagnostics.some((d) => d.message.includes('fakeTimers')))
})

test('no fakeTimers key: the timers policy is left to the dialect and no defaults cross', async () => {
  const root = tree({ 'jest.config.js': 'module.exports = {}\n' })
  const { neutral } = await readNeutral(root)
  const [project] = neutral.value
  assert.equal(project?.policy.timers, undefined)
  assert.deepEqual(project?.fakeTimers, {})
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
  // One shape for every environment: the options live under `projectConfig`.
  assert.deepEqual(
    (resolved.config.environment.options.projectConfig as { testEnvironmentOptions: unknown })
      .testEnvironmentOptions,
    { a: 1 },
  )
  assert.equal(resolved.policy.mock.between.clear, true)
  assert.deepEqual(resolved.discovery, project.discovery)
  assert.ok(resolved.config.globals !== null)
})

test('skipNodeResolution reaches the loader config the coordinator resolves edges with (B23c)', async () => {
  const root = tree({
    'jest.config.js': 'module.exports = { skipNodeResolution: true }\n',
    'env.js': 'export const env = {}\n',
  })
  const [project] = (await readNeutral(root)).neutral.value
  assert.ok(project !== undefined)
  assert.equal(project.resolution?.skipNodeResolution, true)
  const resolved = await resolveNeutralProject(project, {
    dialect: jestNodeDialect,
    environments: { node: { module: join(root, 'env.js'), export: 'env' } },
    ci: false,
  })
  assert.equal(resolved.config.loader.skipNodeResolution, true)
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

test('the default babel-jest transform stays on the Oxc path: no entries, no config, no marker', async () => {
  const root = tree({ 'jest.config.js': 'module.exports = {}\n' })
  const { neutral } = await readNeutral(root)
  const [project] = neutral.value
  assert.deepEqual(project?.transforms, [])
  assert.equal(project?.transformConfig, undefined)
  assert.equal(project?.transformHoistedMarkers, undefined)
})

test('a named transform carries the project config as JSON and the hoisted marker', async () => {
  const root = tree({
    'jest.config.js': `module.exports = { transform: { '\\\\.ts$': ['<rootDir>/t.js', { a: 1 }] } }\n`,
    't.js': '',
  })
  const { neutral } = await readNeutral(root)
  const [project] = neutral.value
  assert.equal(project?.transforms.length, 1)
  assert.equal(project?.transformConfig?.rootDir, project?.rootDir)
  assert.equal(project?.transformConfig?.cwd, project?.rootDir)
  assert.deepEqual(project?.transformHoistedMarkers, ['_getJestObj'])
  // It must clone, since it crosses to a worker.
  assert.deepEqual(structuredClone(project?.transformConfig), project?.transformConfig)
})

test("an explicit cacheDirectory is carried; Jest's own default is not (D70)", async () => {
  const explicit = tree({
    'jest.config.js': "module.exports = { cacheDirectory: '<rootDir>/.ci-cache' }\n",
  })
  const [withDir] = (await readNeutral(explicit)).neutral.value
  assert.equal(withDir?.cacheDirectory, join(explicit, '.ci-cache'))
  const implicit = tree({ 'jest.config.js': 'module.exports = {}\n' })
  const [without] = (await readNeutral(implicit)).neutral.value
  assert.equal(without?.cacheDirectory, undefined)
  assert.equal(Object.hasOwn(without ?? {}, 'cacheDirectory'), false)
})

test('collectCoverage: the files that count, as shouldInstrument reads the config (B23b)', async () => {
  const root = tree({
    'jest.config.js': `module.exports = {
  collectCoverage: true,
  collectCoverageFrom: ['<rootDir>/src/**/*.ts', '!**/*.d.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/gen/'],
  forceCoverageMatch: ['**/*.fixture.ts'],
  testMatch: ['**/*.spec.ts'],
  setupFiles: ['<rootDir>/before.js'],
}
`,
    'before.js': '',
  })
  const { neutral } = await readNeutral(root)
  assert.ok(!neutral.diagnostics.some((d) => d.key === 'collectCoverage'))
  assert.deepEqual(neutral.value[0]?.coverage, {
    provider: 'istanbul',
    globalRoot: root,
    projectRoot: root,
    // `<rootDir>/` comes off a collectCoverageFrom glob (normalize.ts).
    include: ['src/**/*.ts', '!**/*.d.ts'],
    includeRoot: true,
    force: ['**/*.fixture.ts'],
    testFiles: ['**/*.spec.ts'],
    testRegex: [],
    testIgnorePatterns: ['/node_modules/'],
    excludePatterns: ['/node_modules/', `${root}/gen/`],
    excludePaths: [join(root, 'before.js')],
  })
})

test('no coverage without collectCoverage; v8 and thresholds are read but not applied yet', async () => {
  const off = tree({ 'jest.config.js': 'module.exports = {}\n' })
  const [plain] = (await readNeutral(off)).neutral.value
  assert.equal(Object.hasOwn(plain ?? {}, 'coverage'), false)

  const v8 = tree({
    'jest.config.js': "module.exports = { collectCoverage: true, coverageProvider: 'v8' }\n",
  })
  const read = await readNeutral(v8)
  assert.equal(read.neutral.value[0]?.coverage, undefined)
  assert.ok(
    read.neutral.diagnostics.some(
      (d) => d.key === 'coverageProvider' && d.message.includes('T8.12'),
    ),
  )

  const thresholds = tree({
    'jest.config.js':
      'module.exports = { collectCoverage: true, coverageThreshold: { global: { lines: 90 } } }\n',
  })
  const withThresholds = await readNeutral(thresholds)
  assert.ok(withThresholds.neutral.value[0]?.coverage !== undefined)
  assert.ok(
    withThresholds.neutral.diagnostics.some(
      (d) => d.key === 'coverageThreshold' && d.message.includes('T8.11'),
    ),
  )
})

test('NODE_PATH entries are module search paths ahead of modulePaths, as jest-resolve has them', async () => {
  const root = tree({ 'jest.config.js': "module.exports = { modulePaths: ['/from/config'] }\n" })
  const saved = process.env.NODE_PATH
  process.env.NODE_PATH = ['/abs/one', 'rel/two', ''].join(delimiter)
  try {
    const { neutral } = await readNeutral(root)
    const paths = neutral.value[0]?.resolution?.modulePaths
    assert.deepEqual(paths, ['/abs/one', join(root, 'rel/two'), '/from/config'])
  } finally {
    if (saved === undefined) delete process.env.NODE_PATH
    else process.env.NODE_PATH = saved
  }
})
