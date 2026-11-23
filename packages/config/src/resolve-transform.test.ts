// T3.8: a neutral project's `transform` entries as the worker's `SerializedTransformConfig`.
import assert from 'node:assert/strict'
import type { NeutralProject } from '@provino/types'
import { afterAll, beforeAll, test } from 'provino'
import { makeTempDir, rejectsWith, type TempDir } from './internal/test-support.ts'
import { resolveNeutralProject } from './resolve.ts'

const ENVIRONMENTS = { node: { module: 'file:///env/node.mjs', export: 'nodeEnvironment' } }
const options = { dialect: null, environments: ENVIRONMENTS, ci: false } as const

let temp: TempDir
beforeAll(async () => {
  temp = await makeTempDir()
})
afterAll(() => temp.dispose())

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

test("a rule's checksMockFactories crosses only when it is true", async () => {
  const transformer = await temp.write('t.cjs', 'module.exports = {}')
  const resolved = await resolveNeutralProject(
    neutral({
      transforms: [
        { pattern: 'a', module: transformer, options: {}, checksMockFactories: true },
        { pattern: 'b', module: transformer, options: {}, checksMockFactories: false },
        { pattern: 'c', module: transformer, options: {} },
      ],
    }),
    options,
  )
  assert.deepEqual(
    resolved.config.loader.transform?.rules.map((rule) => [rule.pattern, rule.checksMockFactories]),
    [
      ['a', true],
      ['b', undefined],
      ['c', undefined],
    ],
  )
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

test('the files the transforms take reach the loader, stand-ins included, even with no transform', async () => {
  const none = await resolveNeutralProject(neutral(), options)
  assert.equal(none.config.loader.transformClaims, undefined)
  // Jest's default babel-jest, which the Oxc path stands in for: `transforms` is empty.
  const standIn = await resolveNeutralProject(
    neutral({
      standInTransformPatterns: ['\\.[jt]sx?$'],
      transformIgnorePatterns: ['/node_modules/(?!(esm-pkg)/)'],
    }),
    options,
  )
  assert.equal(standIn.config.loader.transform, undefined)
  assert.deepEqual(standIn.config.loader.transformClaims, {
    patterns: ['\\.[jt]sx?$'],
    ignorePatterns: ['/node_modules/(?!(esm-pkg)/)'],
  })
  const transformer = await temp.write('t3.cjs', 'module.exports = {}')
  const named = await resolveNeutralProject(
    neutral({
      transforms: [
        { pattern: '\\.ts$', module: transformer, options: {} },
        { pattern: '\\.js$', module: transformer, options: {} },
      ],
      transformIgnorePatterns: ['/node_modules/(?!(esm-pkg)/)'],
    }),
    options,
  )
  assert.deepEqual(named.config.loader.transformClaims, {
    patterns: ['\\.ts$', '\\.js$'],
    ignorePatterns: ['/node_modules/(?!(esm-pkg)/)'],
  })
  assert.deepEqual(structuredClone(named.config), named.config)
})

test('a stand-in or ignore pattern that is not a regular expression is CONFIG_INVALID with no rule', async () => {
  const bad = await rejectsWith(
    resolveNeutralProject(neutral({ standInTransformPatterns: ['('] }), options),
    'CONFIG_INVALID',
  )
  assert.match(bad.message, /standInTransformPatterns\[0\]/)
  const ignore = await rejectsWith(
    resolveNeutralProject(
      neutral({ standInTransformPatterns: ['x'], transformIgnorePatterns: ['['] }),
      options,
    ),
    'CONFIG_INVALID',
  )
  assert.match(ignore.message, /transformIgnorePatterns\[0\]/)
})

test('transformIgnorePatterns are checked with no transform at all (`transform: {}`), alone and joined with |', async () => {
  // Jest builds `new RegExp(transformIgnorePatterns.join('|'))` in its ScriptTransformer whatever
  // `transform` holds, and every test file fails on it; here it is one config error, before a run.
  const single = await rejectsWith(
    resolveNeutralProject(neutral({ transformIgnorePatterns: ['['] }), options),
    'CONFIG_INVALID',
  )
  assert.match(single.message, /transformIgnorePatterns\[0\] is not a regular expression/)
  // Each compiles alone (no named group, `\k<b>` is the letters); joined, the second's group makes
  // the first a reference to a group named `b`, which there is none of. On every V8.
  for (const project of [
    neutral({ transformIgnorePatterns: ['\\k<b>', '(?<a>x)'] }),
    neutral({
      standInTransformPatterns: ['\\.js$'],
      transformIgnorePatterns: ['\\k<b>', '(?<a>x)'],
    }),
  ]) {
    const joined = await rejectsWith(resolveNeutralProject(project, options), 'CONFIG_INVALID')
    assert.match(
      joined.message,
      /transformIgnorePatterns \(joined with "\|", as Jest joins them\) is not a regular expression/,
    )
  }
  const transformer = await temp.write('t4.cjs', 'module.exports = {}')
  const named = await rejectsWith(
    resolveNeutralProject(
      neutral({
        transforms: [{ pattern: 'x', module: transformer, options: {} }],
        transformIgnorePatterns: ['\\k<b>', '(?<a>x)'],
      }),
      options,
    ),
    'CONFIG_INVALID',
  )
  assert.match(named.message, /joined with "\|"/)
})

test('a project with a bad rule pattern and a bad ignore pattern reports the ignore pattern first', async () => {
  const transformer = await temp.write('t5.cjs', 'module.exports = {}')
  const both = await rejectsWith(
    resolveNeutralProject(
      neutral({
        transforms: [{ pattern: '(', module: transformer, options: {} }],
        standInTransformPatterns: ['('],
        transformIgnorePatterns: ['['],
      }),
      options,
    ),
    'CONFIG_INVALID',
  )
  assert.match(both.message, /transformIgnorePatterns\[0\]/)
})

test("Jest's default ignore patterns take no node_modules file: no claims, and the patterns are still checked", async () => {
  // Every spelling of "ignore every package" turns the claims off, so no worker asks about a file.
  for (const ignore of [
    ['/node_modules/', '\\.pnp\\.[^\\/]+$'],
    ['/node_modules'],
    ['node_modules/'],
    ['node_modules'],
  ]) {
    const resolved = await resolveNeutralProject(
      neutral({ standInTransformPatterns: ['\\.[jt]sx?$'], transformIgnorePatterns: ignore }),
      options,
    )
    assert.equal(resolved.config.loader.transformClaims, undefined, ignore.join(' '))
  }
  // An allowlist ignores some packages only: the claims stay.
  const allowlist = await resolveNeutralProject(
    neutral({
      standInTransformPatterns: ['\\.[jt]sx?$'],
      transformIgnorePatterns: ['/node_modules/(?!(esm-pkg)/)'],
    }),
    options,
  )
  assert.notEqual(allowlist.config.loader.transformClaims, undefined)
  // Off, and still validated: a pair that fails joined is one config error.
  const joined = await rejectsWith(
    resolveNeutralProject(
      neutral({
        standInTransformPatterns: ['\\.js$'],
        transformIgnorePatterns: ['/node_modules/', '\\k<b>', '(?<a>x)'],
      }),
      options,
    ),
    'CONFIG_INVALID',
  )
  assert.match(joined.message, /joined with "\|"/)
})
