// T3.8: a neutral project's `transform` entries as the worker's `SerializedTransformConfig`.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { NeutralProject } from '@provino/types'
import { makeTempDir, rejectsWith, type TempDir } from './internal/test-support.ts'
import { resolveNeutralProject } from './resolve.ts'

const ENVIRONMENTS = { node: { module: 'file:///env/node.mjs', export: 'nodeEnvironment' } }
const options = { dialect: null, environments: ENVIRONMENTS, ci: false } as const

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

test('a project with no transform has none in its loader config', async () => {
  const resolved = await resolveNeutralProject(neutral(), options)
  assert.equal(resolved.config.loader.transform, undefined)
})

test('transform entries become refs plus JSON options, with the ignore patterns and config', async () => {
  const transformer = await temp.write('t.cjs', 'module.exports = {}')
  const resolved = await resolveNeutralProject(
    neutral({
      transforms: [{ pattern: '\\.ts$', module: transformer, options: { a: [1] } }],
      transformIgnorePatterns: ['/node_modules/'],
      transformConfig: { rootDir: temp.dir },
      transformHoistedMarkers: ['_marker'],
    }),
    options,
  )
  assert.deepEqual(resolved.config.loader.transform, {
    rules: [
      {
        pattern: '\\.ts$',
        transformer: { module: transformer, export: 'default' },
        options: { a: [1] },
      },
    ],
    ignorePatterns: ['/node_modules/'],
    config: { rootDir: temp.dir },
    hoistedMarkers: ['_marker'],
  })
  assert.deepEqual(structuredClone(resolved.config), resolved.config)
})

test('a bare transformer name resolves from the project root; one that does not is CONFIG_INVALID', async () => {
  await temp.write(
    'node_modules/my-transformer/package.json',
    '{ "name": "my-transformer", "main": "i.js" }',
  )
  const entry = await temp.write('node_modules/my-transformer/i.js', 'module.exports = {}')
  const resolved = await resolveNeutralProject(
    neutral({ transforms: [{ pattern: 'x', module: 'my-transformer', options: {} }] }),
    options,
  )
  assert.equal(resolved.config.loader.transform?.rules[0]?.transformer.module, entry)
  const missing = await rejectsWith(
    resolveNeutralProject(
      neutral({ transforms: [{ pattern: 'x', module: 'no-such-transformer', options: {} }] }),
      options,
    ),
    'CONFIG_INVALID',
  )
  assert.match(missing.message, /transform\[0\]: cannot resolve the transformer/)
})

test('a transform or ignore pattern that is not a regular expression is CONFIG_INVALID', async () => {
  const transformer = await temp.write('t2.cjs', 'module.exports = {}')
  const bad = await rejectsWith(
    resolveNeutralProject(
      neutral({ transforms: [{ pattern: '(', module: transformer, options: {} }] }),
      options,
    ),
    'CONFIG_INVALID',
  )
  assert.match(bad.message, /transform\[0\]\.pattern/)
  const ignore = await rejectsWith(
    resolveNeutralProject(
      neutral({
        transforms: [{ pattern: 'x', module: transformer, options: {} }],
        transformIgnorePatterns: ['['],
      }),
      options,
    ),
    'CONFIG_INVALID',
  )
  assert.match(ignore.message, /transformIgnorePatterns\[0\]/)
})
