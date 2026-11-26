// B25c, T11.15: the reader end to end over temp trees. The values the reader applies are held to
// Vitest 5.0.5's own `resolveConfig(...).test`, run in-process (the oracle loads Vite, which a test
// may); what has no oracle here (`test.projects`, the neutral shape) is asserted from Vitest's rules.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { resolveConfig } from 'vitest/node'
import { VitestConfigError } from './errors.ts'
import { createVitestConfigReader, readVitestConfig } from './index.ts'
import { removeTrees, writeTree } from './test-support.ts'

after(removeTrees)

async function oracle(root: string, test?: object): Promise<Record<string, unknown>> {
  const resolved = (await resolveConfig({
    root,
    ...(test === undefined ? {} : test),
  })) as unknown as {
    test: Record<string, unknown>
  }
  return resolved.test
}

const PLAIN = `export default {
  test: {
    include: ['spec/**/*.spec.ts'],
    exclude: ['**/skip/**'],
    globals: true,
    testTimeout: 1234,
    hookTimeout: 4321,
    environment: 'jsdom',
    clearMocks: false,
    restoreMocks: true,
    isolate: false,
    setupFiles: ['./setup.ts'],
    sequence: { hooks: 'list', seed: 7, shuffle: { tests: true } },
    snapshotFormat: { printBasicPrototype: true },
  },
}
`

test('the keys the reader applies equal vitest resolveConfig(...).test', async () => {
  const root = writeTree({ 'vitest.config.mjs': PLAIN, 'setup.ts': 'export {}\n' })
  const expected = await oracle(root)
  const { projects, diagnostics } = await readVitestConfig({ cwd: root })
  assert.equal(projects.length, 1)
  const project = projects[0]
  assert.ok(project)
  assert.deepEqual(diagnostics, [])
  assert.deepEqual(project.discovery.includePatterns.patterns, expected.include)
  assert.equal(project.environment.name, expected.environment)
  assert.deepEqual(project.setupFilesAfterEnv, expected.setupFiles)
  const policy = project.policy
  assert.equal(policy.core?.injectGlobals, expected.globals)
  assert.equal(policy.core?.timeouts?.test, expected.testTimeout)
  assert.equal(policy.core?.timeouts?.hook, expected.hookTimeout)
  assert.equal(policy.mock?.between?.clear, expected.clearMocks)
  assert.equal(policy.mock?.between?.restore, expected.restoreMocks)
  assert.equal(policy.mock?.between?.reset, expected.mockReset)
  assert.equal(policy.orchestrator?.isolationDefault?.default, 'none')
  assert.equal(expected.isolate, false)
  assert.equal(project.seed, (expected.sequence as { seed: number }).seed)
  assert.equal(project.randomize, true)
  assert.equal(policy.core?.hookOrder?.afterEach, 'declaration')
})

test("with no config file the defaults are Vitest's", async () => {
  const root = writeTree({ 'package.json': '{"name":"plain"}' })
  const expected = await oracle(root)
  const { projects } = await readVitestConfig({ cwd: root })
  const project = projects[0]
  assert.ok(project)
  assert.equal(project.rootDir, root)
  assert.deepEqual(project.discovery.includePatterns.patterns, expected.include)
  assert.deepEqual(project.environment.name, expected.environment)
  assert.equal(project.policy.core?.injectGlobals, expected.globals)
  assert.equal(project.policy.mock?.between?.clear, expected.clearMocks)
  assert.equal(project.policy.orchestrator?.pool?.default, expected.pool)
})

test('the command line wins over the file, as Vitest has it', async () => {
  const root = writeTree({ 'vitest.config.mjs': PLAIN, 'setup.ts': 'export {}\n' })
  const expected = await oracle(root, { testTimeout: 99, include: ['cli/**'] })
  const { projects } = await readVitestConfig({
    cwd: root,
    test: { testTimeout: 99, include: ['cli/**'] },
  })
  const project = projects[0]
  assert.ok(project)
  assert.equal(project.policy.core?.timeouts?.test, expected.testTimeout)
  assert.deepEqual(project.discovery.includePatterns.patterns, expected.include)
})

test('vitest.config wins over vite.config, and a function export gets the serve command and the mode', async () => {
  const root = writeTree({
    'vite.config.mjs': 'export default { test: { testTimeout: 1 } }\n',
    'vitest.config.mjs':
      'export default (env) => ({ test: { name: env.command + ":" + env.mode, testTimeout: 2 } })\n',
  })
  const { projects } = await readVitestConfig({ cwd: root })
  assert.equal(projects[0]?.name, 'serve:test')
  assert.equal(projects[0]?.policy.core?.timeouts?.test, 2)
  const staging = await readVitestConfig({ cwd: root, mode: 'staging' })
  assert.equal(staging.projects[0]?.name, 'serve:staging')
})

test('vitest/config is served without Vitest: defineConfig, mergeConfig, configDefaults', async () => {
  const root = writeTree({
    'vitest.config.ts': `import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
const base = defineConfig({ test: { include: ['a/**/*.test.ts'], globals: true } })
export default defineConfig(({ mode }) =>
  mergeConfig(base, {
    test: { exclude: [...configDefaults.exclude, 'b/**'], name: mode as string },
  }),
)
`,
  })
  const { projects } = await readVitestConfig({ cwd: root })
  const project = projects[0]
  assert.ok(project)
  assert.equal(project.name, 'test')
  assert.deepEqual(project.discovery.includePatterns.patterns, ['a/**/*.test.ts'])
  assert.equal(project.policy.core?.injectGlobals, true)
  assert.equal(project.discovery.excludePatterns.length, 3)
})

test('mode and the .env files make import.meta.env', async () => {
  const root = writeTree({
    'vitest.config.mjs': 'export default { test: {} }\n',
    '.env': 'VITE_A=1\nPRIVATE=2\n',
    '.env.test': 'VITE_B=two\n',
    '.env.staging': 'VITE_C=3\n',
  })
  const test_ = await readVitestConfig({ cwd: root, env: { NODE_ENV: 'test' } })
  assert.deepEqual(test_.projects[0]?.importMetaEnv, {
    VITE_A: '1',
    VITE_B: 'two',
    BASE_URL: '/',
    MODE: 'test',
    DEV: true,
    PROD: false,
    SSR: true,
  })
  const staging = await readVitestConfig({
    cwd: root,
    mode: 'staging',
    env: { NODE_ENV: 'production' },
  })
  assert.equal(staging.projects[0]?.importMetaEnv?.VITE_C, '3')
  assert.equal(staging.projects[0]?.importMetaEnv?.PROD, true)
  assert.equal(staging.projects[0]?.importMetaEnv?.MODE, 'staging')
})

test('plugins mark the config for the Vite bridge; none, and falsy ones, do not', async () => {
  const withPlugin = writeTree({
    'vitest.config.mjs': "export default { plugins: [false, [{ name: 'p' }]], test: {} }\n",
  })
  assert.equal((await readVitestConfig({ cwd: withPlugin })).needsVite, true)
  const without = writeTree({
    'vitest.config.mjs': 'export default { plugins: [false, []], test: {} }\n',
  })
  assert.equal((await readVitestConfig({ cwd: without })).needsVite, false)
})

test('test.projects: inline objects, directories, config files and globs', async () => {
  const root = writeTree({
    'vitest.config.mjs': `export default {
  test: {
    testTimeout: 11,
    projects: [
      { extends: false, test: { name: 'inline', include: ['inline/**/*.test.ts'] } },
      { test: { name: 'implicit' } },
      { extends: true, test: { name: 'extended' } },
      'packages/*',
      'tools/vitest.config.mjs',
    ],
  },
}
`,
    'packages/a/package.json': '{"name":"pkg-a"}',
    'packages/a/vitest.config.mjs': 'export default { test: { testTimeout: 22 } }\n',
    'packages/b/package.json': '{}',
    'tools/vitest.config.mjs': "export default { test: { name: 'tools' } }\n",
  })
  const { projects } = await readVitestConfig({ cwd: root })
  assert.deepEqual(
    projects.map((project) => project.name),
    ['inline', 'implicit', 'extended', 'pkg-a', 'b', 'tools'],
  )
  const byName = Object.fromEntries(projects.map((project) => [project.name, project]))
  assert.equal(byName.inline?.rootDir, root)
  assert.equal(byName.inline?.policy.core?.timeouts?.test, undefined)
  assert.equal(byName.extended?.policy.core?.timeouts?.test, 11)
  // Since Vitest 5 an inline project extends the declaring config unless it says `extends: false`.
  assert.equal(byName.implicit?.policy.core?.timeouts?.test, 11)
  assert.equal(byName['pkg-a']?.rootDir, `${root}/packages/a`)
  assert.equal(byName['pkg-a']?.policy.core?.timeouts?.test, 22)
  assert.equal(byName.b?.rootDir, `${root}/packages/b`)
  assert.equal(byName.tools?.rootDir, `${root}/tools`)
})

test('two projects with one name, and a projects glob with no match, are errors', async () => {
  const same = writeTree({
    'vitest.config.mjs':
      "export default { test: { projects: [{ test: { name: 'x' } }, { test: { name: 'x' } }] } }\n",
  })
  await assert.rejects(readVitestConfig({ cwd: same }), { code: 'VITEST_CONFIG_INVALID' })
  const none = writeTree({
    'vitest.config.mjs': "export default { test: { projects: ['nothing/*'] } }\n",
  })
  await assert.rejects(readVitestConfig({ cwd: none }), { code: 'VITEST_CONFIG_INVALID' })
})

test('what Vitest 5 refuses or provides no more is refused with its text or a coded error', async () => {
  const workspace = writeTree({
    'vitest.config.mjs': "export default { test: { workspace: 'x' } }\n",
  })
  await assert.rejects(readVitestConfig({ cwd: workspace }), {
    code: 'VITEST_CONFIG_UNSUPPORTED',
    message:
      'The `test.workspace` option was removed in Vitest 4. Please, migrate to `test.projects` instead. See https://vitest.dev/guide/projects for examples.',
  })
  for (const body of [
    "{ pool: 'vmThreads' }",
    "{ pool: 'vmForks' }",
    '{ browser: { enabled: true } }',
    '{ typecheck: { enabled: true } }',
  ]) {
    const root = writeTree({ 'vitest.config.mjs': `export default { test: ${body} }\n` })
    await assert.rejects(readVitestConfig({ cwd: root }), VitestConfigError, body)
  }
})

test('a vitest.workspace file is not read, and the reader says so', async () => {
  const root = writeTree({ 'vitest.workspace.ts': "export default ['packages/*']\n" })
  const { projects, diagnostics } = await readVitestConfig({ cwd: root })
  assert.equal(projects.length, 1)
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['VITEST_WORKSPACE_FILE_IGNORED'],
  )
})

test('a key read and not applied warns', async () => {
  const root = writeTree({
    'vitest.config.mjs':
      'export default { define: { A: 1 }, test: { retry: 2, minWorkers: 1, bail: 1, coverage: { enabled: true } } }\n',
  })
  const { diagnostics } = await readVitestConfig({ cwd: root })
  const keys = diagnostics.map((entry) => entry.key).sort()
  // `bail` is the run's, which `provino vitest` applies (B25g): no warning.
  assert.deepEqual(keys, ['define', 'test.coverage', 'test.minWorkers', 'test.retry'])
  for (const entry of diagnostics) {
    assert.equal(entry.code, 'VITEST_CONFIG_NOT_APPLIED')
    assert.match(entry.message, /is read and not applied/)
  }
})

test('an explicit config that is not there, and one that throws, are coded errors', async () => {
  const root = writeTree({ 'bad.config.mjs': "throw new Error('boom')\n" })
  const reader = createVitestConfigReader({ cwd: root })
  await assert.rejects(reader.find(root, 'missing.mjs'), { code: 'VITEST_CONFIG_NOT_FOUND' })
  const source = await reader.find(root, 'bad.config.mjs')
  assert.ok(source)
  await assert.rejects(reader.load(source), { code: 'VITEST_CONFIG_LOAD_FAILED' })
})

test('a relative --root and the file it holds', async () => {
  const root = writeTree({
    'app/vitest.config.mjs': "export default { test: { name: 'app' } }\n",
  })
  const { projects } = await readVitestConfig({ cwd: root, root: 'app' })
  assert.equal(projects[0]?.name, 'app')
  assert.equal(projects[0]?.rootDir, `${root}/app`)
})

// B25c: a config is read as Vite's bundler reads it, and each class of file the sample showed a
// native import refusing is held to what `resolveConfig` makes of the same tree.
const BUNDLED: readonly (readonly [string, Record<string, string>])[] = [
  [
    'a JSON import with no import attribute',
    {
      'package.json': '{ "name": "from-json", "version": "1.0.0" }\n',
      'vitest.config.ts':
        "import pkg from './package.json'\nexport default { test: { name: pkg.name } }\n",
    },
  ],
  [
    'a type imported as a value',
    {
      'package.json': '{ "name": "typed" }\n',
      'vitest.config.ts':
        "import { UserConfig } from 'vite'\nconst config: UserConfig = { test: { name: 'typed' } }\nexport default config\n",
    },
  ],
  [
    'import syntax in a CommonJS-typed .js config',
    {
      'package.json': '{ "name": "cjs-typed", "type": "commonjs" }\n',
      'vitest.config.js':
        "import { join } from 'node:path'\nexport default { test: { name: join('esm', 'in-cjs') } }\n",
    },
  ],
  [
    'an import without an extension and __dirname in an ES module',
    {
      'package.json': '{ "name": "bundled", "type": "module" }\n',
      'shared/index.ts': "export const base = 'shared'\n",
      'vitest.config.ts':
        "import { base } from './shared'\nexport default { test: { name: base + ':' + __dirname.split('/').pop() } }\n",
    },
  ],
]

for (const [name, files] of BUNDLED) {
  test(`${name}: the reader gives what resolveConfig gives`, async () => {
    const root = writeTree(files)
    const expected = await oracle(root)
    const { projects } = await readVitestConfig({ cwd: root })
    assert.equal(projects.length, 1)
    const label = (expected.name as { label?: string } | string | undefined) ?? ''
    assert.equal(projects[0]?.name, typeof label === 'string' ? label : label.label)
  })
}

test('a projects negation removes what it names from the other patterns', async () => {
  const root = writeTree({
    'vitest.config.mjs':
      "export default { test: { projects: ['./packages/*', '!./packages/tsconfig.base.json', './scripts'] } }\n",
    'packages/a/package.json': '{ "name": "pkg-a" }\n',
    'packages/tsconfig.base.json': '{}\n',
    'scripts/package.json': '{ "name": "scripts" }\n',
  })
  const { projects } = await readVitestConfig({ cwd: root })
  assert.deepEqual(
    projects.map((project) => project.name),
    ['pkg-a', 'scripts'],
  )
})

test('a relative vite root resolves once, from the directory; inline plugins that are falsy need no Vite', async () => {
  const root = writeTree({
    'vitest.config.mjs':
      "export default { root: 'sub', plugins: [false, [null]], test: { name: 'r' } }\n",
    'sub/x.txt': '',
  })
  const { projects, needsVite } = await readVitestConfig({ cwd: root })
  assert.equal(projects[0]?.rootDir, `${root}/sub`)
  assert.equal(needsVite, false)
  const real = writeTree({
    'vitest.config.mjs': "export default { plugins: [{ name: 'p' }], test: {} }\n",
  })
  assert.equal((await readVitestConfig({ cwd: real })).needsVite, true)
})

test("an inline project is rooted at its own test.root or root, from the declaring config's root", async () => {
  const root = writeTree({
    'vitest.config.mjs':
      "export default { test: { projects: [{ test: { name: 'a', root: './sdk' } }, { root: 'lib', test: { name: 'b' } }, { test: { name: 'c' } }] } }\n",
  })
  const { projects } = await readVitestConfig({ cwd: root })
  assert.deepEqual(
    projects.map((project) => [project.name, project.rootDir]),
    [
      ['a', `${root}/sdk`],
      ['b', `${root}/lib`],
      ['c', root],
    ],
  )
})

// Vitest 5.0.5 hands a child project only the command line's `PROJECT_CLI_OVERRIDES`
// (resolveProjects.ts L52-L79), which has neither `environment` nor `dom`; `--dom` reaches
// `resolveTestConfig` for the root alone (`cli/vitest-dom-projects` records the first case).
test('--dom and --environment leave a child project on its own environment', async () => {
  const root = writeTree({
    'vitest.config.mjs': `export default {
  test: { projects: [{ test: { name: 'child', environment: 'jsdom' } }, { test: { name: 'bare' } }] },
}
`,
  })
  for (const cli of [{ dom: true }, { environment: 'node' }, { dom: true, environment: 'node' }]) {
    const { projects } = await readVitestConfig({ cwd: root, test: cli })
    assert.deepEqual(
      projects.map((project) => [project.name, project.environment.name]),
      [
        ['child', 'jsdom'],
        ['bare', 'node'],
      ],
      JSON.stringify(cli),
    )
  }
})

test('--dom over a root config that names jsdom is happy-dom', async () => {
  const root = writeTree({
    'vitest.config.mjs': "export default { test: { environment: 'jsdom' } }\n",
  })
  const { projects } = await readVitestConfig({ cwd: root, test: { dom: true } })
  assert.deepEqual(
    projects.map((project) => project.environment.name),
    ['happy-dom'],
  )
  const environment = await readVitestConfig({ cwd: root, test: { environment: 'edge-runtime' } })
  assert.deepEqual(
    environment.projects.map((project) => project.environment.name),
    ['edge-runtime'],
  )
})
