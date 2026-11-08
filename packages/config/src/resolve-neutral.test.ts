// `resolveNeutralProject`: a project a dialect's config reader produced, resolved by the same steps
// as `resolveProject` after its input is read. Fake dialects only (this package names none).
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { defineDialect, moduleRef } from '@provino/policy'
import type { NeutralProject } from '@provino/types'
import { makeTempDir, rejectsWith, type TempDir } from './internal/test-support.ts'
import { resolveNeutralProject } from './resolve.ts'

const ENVIRONMENTS = {
  node: { module: 'file:///env/node.mjs', export: 'nodeEnvironment' },
  dom: { module: 'file:///env/dom.mjs', export: 'domEnvironment' },
}

const reader = defineDialect({
  name: 'reader',
  version: '1',
  policy: {
    core: { testNamePatternFlags: 'i', injectGlobals: true },
    mock: { between: { clear: false } },
  },
  globals: { factory: moduleRef('file:///globals.mjs', 'globals'), names: ['describe'] },
})

let temp: TempDir
before(async () => {
  temp = await makeTempDir()
})
after(() => temp.dispose())

function neutral(overrides: Partial<NeutralProject> = {}): NeutralProject {
  return {
    name: 'p',
    rootDir: temp.dir,
    discovery: {
      roots: [temp.dir],
      extensions: ['js'],
      includePatterns: { kind: 'glob', patterns: ['**/*.test.js'] },
      excludePatterns: ['/node_modules/'],
      crawlIgnorePatterns: [],
    },
    setupFiles: [],
    setupFilesAfterEnv: [],
    globalSetup: [],
    globalTeardown: [],
    environment: { name: 'node', options: {} },
    aliases: [],
    transforms: [],
    transformIgnorePatterns: [],
    snapshotSerializers: [],
    policy: {},
    ...overrides,
  }
}

test('the project policy goes over the dialect policy', async () => {
  const resolved = await resolveNeutralProject(
    neutral({ policy: { mock: { between: { clear: true } }, core: { timeouts: { test: 42 } } } }),
    { dialect: reader, environments: ENVIRONMENTS, ci: true },
  )
  assert.equal(resolved.policy.core.testNamePatternFlags, 'i')
  assert.equal(resolved.policy.mock.between.clear, true)
  assert.equal(resolved.policy.core.timeouts.test, 42)
  assert.equal(resolved.config.ci, true)
  assert.equal(resolved.name, 'p')
  assert.deepEqual(resolved.config.globals, reader.globals?.factory)
})

test('setup files stay in their phases, environment options reach the worker, discovery is carried', async () => {
  const before = await temp.write('before.js', '')
  const afterEnv = await temp.write('after.js', '')
  const project = neutral({
    setupFiles: [before],
    setupFilesAfterEnv: [afterEnv],
    environment: { name: 'dom', options: { url: 'http://x/' } },
  })
  const resolved = await resolveNeutralProject(project, {
    dialect: reader,
    environments: ENVIRONMENTS,
    ci: false,
  })
  assert.deepEqual(resolved.config.setupFiles, [before])
  assert.deepEqual(resolved.config.setupFilesAfterEnv, [afterEnv])
  assert.deepEqual(resolved.config.environment, {
    ...ENVIRONMENTS.dom,
    options: { url: 'http://x/' },
  })
  assert.equal(resolved.environment, 'dom')
  assert.deepEqual(resolved.discovery, project.discovery)
})

test('neutral (no dialect): no globals', async () => {
  const resolved = await resolveNeutralProject(neutral(), {
    dialect: null,
    environments: ENVIRONMENTS,
    ci: false,
  })
  assert.equal(resolved.dialect, null)
  assert.equal(resolved.config.globals, null)
})

test('a relative setup file, a missing one, a missing root, an unknown environment', async () => {
  const options = { dialect: reader, environments: ENVIRONMENTS, ci: false }
  const relative = await rejectsWith(
    resolveNeutralProject(neutral({ setupFilesAfterEnv: ['./x.js'] }), options),
    'CONFIG_INVALID',
  )
  assert.match(relative.message, /setupFilesAfterEnv must hold absolute paths/)
  const missing = await rejectsWith(
    resolveNeutralProject(neutral({ setupFiles: [`${temp.dir}/nope.js`] }), options),
    'CONFIG_INVALID',
  )
  assert.match(missing.message, /setupFiles\[0\]/)
  await rejectsWith(
    resolveNeutralProject(neutral({ rootDir: `${temp.dir}/nope` }), options),
    'CONFIG_INVALID',
  )
  await rejectsWith(
    resolveNeutralProject(neutral({ environment: { name: 'jsdom', options: {} } }), options),
    'CONFIG_UNKNOWN_ENVIRONMENT',
  )
})
