// T3.8: the Jest transformer host, against the three real transformers the brief names (babel-jest
// 30.5.2, ts-jest 29.4 on TypeScript 5.9.3 and @swc/jest 0.2.39) on the rebuilt fixture
// `fixtures/jest-host`: a TypeScript test whose `jest.mock` calls sit below its imports, a factory
// reading a `mock`-prefixed variable and a `__mocks__` file. The same fixture runs end to end, with
// real Jest's statuses beside it, in `packages/provino/test/transformers.test.ts`.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { JsonValue, SerializedTransformConfig, TransformRequest } from '@provino/types'
import { blockPolicy } from '../hoist/test-policies.ts'
import { createPipeline } from '../pipeline.ts'
import { createJestHost } from './index.ts'

const fixture = fileURLToPath(new URL('../../fixtures/jest-host/', import.meta.url)).replace(
  /\/$/,
  '',
)
const testFile = join(fixture, 'src/greeter.test.ts')
const source = readFileSync(testFile, 'utf8')

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

function projectConfig(rootDir: string): Record<string, JsonValue> {
  return {
    rootDir,
    cwd: rootDir,
    id: 'fixture',
    globals: {},
    testMatch: [],
    testRegex: [],
    moduleFileExtensions: ['js', 'ts'],
    transform: [],
    extensionsToTreatAsEsm: [],
    testPathIgnorePatterns: [],
    cacheDirectory: join(rootDir, '.cache'),
    fakeTimers: {},
    setupFiles: [],
    testEnvironmentOptions: {},
    injectGlobals: true,
  }
}

function request(filename: string, text: string): TransformRequest {
  return { filename, source: text, role: 'test', consumer: 'require', instrument: false }
}

function config(
  module: string,
  options: JsonValue,
  extra: Partial<SerializedTransformConfig> = {},
  pattern = '^.+\\.tsx?$',
): SerializedTransformConfig {
  return {
    rules: [{ pattern, transformer: { module, export: 'default' }, options }],
    ignorePatterns: ['/node_modules/'],
    config: projectConfig(fixture),
    hoistedMarkers: ['_getJestObj'],
    ...extra,
  }
}

const tools = {
  'babel-jest': { module: fileURLToPath(import.meta.resolve('babel-jest')), options: {} },
  'ts-jest': {
    module: fileURLToPath(import.meta.resolve('ts-jest')),
    options: { tsconfig: 'tsconfig.json', diagnostics: false },
  },
  '@swc/jest': {
    module: fileURLToPath(import.meta.resolve('@swc/jest')),
    options: { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' } },
  },
} as const

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

describe('the three real transformers on the fixture', () => {
  for (const [name, tool] of Object.entries(tools)) {
    test(`${name}: types are erased and each mock call is hoisted once, above the requires`, async () => {
      const host = await createJestHost(config(tool.module, tool.options))
      assert.equal(host.handles(testFile), true)
      assert.equal(host.handles(join(fixture, 'node_modules/x/index.ts')), false)
      const pipeline = createPipeline({
        root: fixture,
        typescript: 'oxc',
        tsconfig: false,
        hoist: blockPolicy,
        cache: false,
        transformers: host,
      })
      const record = pipeline.transform(request(testFile, source))
      assert.deepEqual(
        record.diagnostics.filter((entry) => entry.severity === 'error'),
        [],
      )
      assert.ok(!record.code.includes(': string'), 'types are erased')
      assert.equal(count(record.code, "mock('./deps')"), 1)
      assert.equal(count(record.code, "mock('./counter'"), 1)
      assert.equal(record.format, 'cjs')
      const firstRequire = record.code.indexOf('require("./')
      assert.ok(record.code.indexOf("mock('./deps')") < firstRequire, 'above the first require')
      assert.ok(record.code.indexOf("mock('./counter'") < firstRequire)
      // babel-plugin-jest-hoist's `_getJestObj` also requires `@jest/globals` (the runner's own).
      assert.deepEqual(
        record.imports.filter((entry) => entry.kind === 'require').map((entry) => entry.specifier),
        name === 'babel-jest'
          ? ['./counter.ts', './deps.ts', './greeter.ts', '@jest/globals']
          : ['./counter.ts', './deps.ts', './greeter.ts'],
      )
    })

    test(`${name}: its getCacheKey result is on the host and keys the record`, async () => {
      const host = await createJestHost(config(tool.module, tool.options))
      const key = host.cacheKey(request(testFile, source))
      assert.equal(typeof key, 'string')
      assert.ok((key ?? '').length > 0)
      const hosted = host.transform(request(testFile, source))
      assert.equal(hosted.transformerCacheKey, key)
      const pipeline = createPipeline({
        root: fixture,
        typescript: 'oxc',
        tsconfig: false,
        hoist: blockPolicy,
        cache: false,
        transformers: host,
      })
      const first = pipeline.transform(request(testFile, source)).cacheKey
      assert.equal(pipeline.transform(request(testFile, source)).cacheKey, first)
      assert.notEqual(pipeline.transform(request(testFile, `${source}\n`)).cacheKey, first)
      assert.equal(await host.cacheKeyAsync(request(testFile, source)), key)
    })

    test(`${name}: the async form is called as Jest's async path calls it`, async () => {
      const host = await createJestHost(config(tool.module, tool.options))
      const sync = host.transform(request(testFile, source))
      const async = await host.transformAsync(request(testFile, source))
      assert.equal(async.transformerCacheKey, sync.transformerCacheKey)
      assert.ok(async.code.includes("mock('./deps')"))
      // `@swc/jest`'s `processAsync` is always ESM ("async transform is always ESM"), as Jest's
      // native-ESM path wants; the other two give the sync form's CommonJS.
      assert.equal(/^import /m.test(async.code), name === '@swc/jest')
    })
  }

  test('babel-jest hoists by itself and the host leaves it alone; ts-jest and swc meet our hoister, which moves nothing', async () => {
    for (const [name, tool] of Object.entries(tools)) {
      const host = await createJestHost(config(tool.module, tool.options))
      const hosted = host.transform(request(testFile, source))
      const pipeline = createPipeline({
        root: fixture,
        typescript: 'oxc',
        tsconfig: false,
        hoist: blockPolicy,
        cache: false,
        transformers: host,
      })
      const record = pipeline.transform(request(testFile, source))
      if (name === 'babel-jest') {
        assert.ok(hosted.code.includes('_getJestObj'))
        assert.equal(record.code, hosted.code)
        assert.deepEqual(record.staticMocks, [])
      } else {
        assert.ok(!hosted.code.includes('_getJestObj'))
        // The hoister meets calls already at the top and leaves exactly one of each, above the
        // requires; it may move them past a prologue statement.
        assert.equal(count(record.code, "mock('./deps')"), 1)
        assert.equal(count(record.code, "mock('./counter'"), 1)
        assert.equal(record.code.replace(/\s+/g, '').length, hosted.code.replace(/\s+/g, '').length)
      }
    }
  })
})

describe('routing', () => {
  const babel = tools['babel-jest']

  test('the first matching rule wins and a file with none keeps the Oxc path', async () => {
    const host = await createJestHost({
      rules: [
        {
          pattern: '\\.tsx?$',
          transformer: { module: babel.module, export: 'default' },
          options: {},
        },
      ],
      ignorePatterns: [],
      config: projectConfig(fixture),
      hoistedMarkers: [],
    })
    const pipeline = createPipeline({
      root: fixture,
      typescript: 'oxc',
      tsconfig: false,
      hoist: null,
      cache: false,
      transformers: host,
    })
    const js = request(join(fixture, 'x.js'), 'export const a = 1')
    assert.equal(host.handles(js.filename), false)
    // Oxc leaves plain JavaScript as it is.
    assert.equal(pipeline.transform(js).code, js.source)
    assert.notEqual(pipeline.transform(request(testFile, source)).code, source)
  })

  test('transformIgnorePatterns opt a file out, joined with |', async () => {
    const host = await createJestHost(
      config(babel.module, babel.options, { ignorePatterns: ['/skip/', 'greeter\\.test'] }),
    )
    assert.equal(host.handles(testFile), false)
    assert.equal(host.handles(join(fixture, 'src/deps.ts')), true)
    assert.equal(host.handles(join(fixture, 'skip/deps.ts')), false)
  })

  test('a transformer that throws is a TRANSFORMER_FAILED error on the record', async () => {
    const host = await createJestHost(config(babel.module, babel.options))
    const pipeline = createPipeline({
      root: fixture,
      typescript: 'oxc',
      tsconfig: false,
      hoist: null,
      cache: false,
      transformers: host,
    })
    const record = pipeline.transform(request(testFile, 'const = ;'))
    assert.equal(record.diagnostics[0]?.severity, 'error')
    assert.equal(record.diagnostics[0]?.code, 'TRANSFORMER_FAILED')
  })
})

describe('what a transformer module may be', () => {
  function write(files: Readonly<Record<string, string>>): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'provino-jest-host-')))
    temps.push(dir)
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    return dir
  }

  async function hostFor(file: string, options: JsonValue = {}) {
    return await createJestHost(config(file, options, {}, '\\.ts$'))
  }

  const target = request('/project/a.ts', 'const a = 1')

  test('a CommonJS module.exports with createTransformer gets the rule options', async () => {
    const dir = write({
      't.cjs': `module.exports = { createTransformer: (options) => ({ process: (src) => ({ code: '// ' + JSON.stringify(options) + '\\n' + src }) }) }`,
    })
    const host = await hostFor(join(dir, 't.cjs'), { flag: 1 })
    assert.equal(host.transform(target).code, '// {"flag":1}\nconst a = 1')
  })

  test('an ES module default export that is the transformer itself', async () => {
    const dir = write({
      't.mjs': `export default { process: (src) => ({ code: src.toUpperCase() }) }`,
    })
    const host = await hostFor(join(dir, 't.mjs'))
    assert.equal(host.transform(target).code, 'CONST A = 1')
  })

  test('an ES module with a named createTransformer, which may be async', async () => {
    const dir = write({
      't.mjs': `export const createTransformer = async () => ({ process: (src) => ({ code: src + '!' }) })`,
    })
    const host = await hostFor(join(dir, 't.mjs'))
    assert.equal(host.transform(target).code, 'const a = 1!')
  })

  test('a module that is not a transformer is TRANSFORM_TRANSFORMER_INVALID', async () => {
    const dir = write({ 't.cjs': 'module.exports = { nope: 1 }' })
    await assert.rejects(hostFor(join(dir, 't.cjs')), {
      code: 'TRANSFORM_TRANSFORMER_INVALID',
    })
  })

  test('a module that cannot be loaded is TRANSFORM_TRANSFORMER_LOAD_FAILED', async () => {
    await assert.rejects(hostFor(join(tmpdir(), 'provino-no-such-transformer.cjs')), {
      code: 'TRANSFORM_TRANSFORMER_LOAD_FAILED',
    })
  })

  test('processAsync only: the async form works and the sync form says why it cannot', async () => {
    const dir = write({
      't.cjs': `module.exports = { processAsync: async (src) => ({ code: src + '//async' }) }`,
    })
    const host = await hostFor(join(dir, 't.cjs'))
    assert.equal((await host.transformAsync(target)).code, 'const a = 1//async')
    assert.throws(() => host.transform(target), { code: 'TRANSFORM_TRANSFORMER_INVALID' })
  })

  test('a result with no code string is refused', async () => {
    const dir = write({ 't.cjs': `module.exports = { process: () => ({}) }` })
    const host = await hostFor(join(dir, 't.cjs'))
    assert.throws(() => host.transform(target), { code: 'TRANSFORM_TRANSFORMER_INVALID' })
  })

  test('a map as an object, as JSON text, or inlined in the code is read; none is null', async () => {
    const map = {
      version: 3,
      sources: ['a.ts'],
      names: [],
      mappings: 'AAAA',
    }
    const inline = `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`
    const dir = write({
      'object.cjs': `module.exports = { process: (s) => ({ code: s, map: ${JSON.stringify(map)} }) }`,
      'text.cjs': `module.exports = { process: (s) => ({ code: s, map: ${JSON.stringify(JSON.stringify(map))} }) }`,
      'inline.cjs': `module.exports = { process: (s) => ({ code: s + '\\n' + ${JSON.stringify(inline)} }) }`,
      'none.cjs': `module.exports = { process: (s) => ({ code: s }) }`,
    })
    for (const name of ['object', 'text', 'inline']) {
      const host = await hostFor(join(dir, `${name}.cjs`))
      assert.equal(host.transform(target).map?.mappings, 'AAAA', name)
    }
    assert.equal((await hostFor(join(dir, 'none.cjs'))).transform(target).map, null)
  })

  test('a transformer with no getCacheKey has a null key', async () => {
    const dir = write({ 't.cjs': `module.exports = { process: (s) => ({ code: s }) }` })
    const host = await hostFor(join(dir, 't.cjs'))
    assert.equal(host.cacheKey(target), null)
  })

  test('the options a transformer is called with are the CommonJS path of Jest', async () => {
    const dir = write({
      't.cjs': `module.exports = { process: (s, path, o) => ({ code: '// ' + JSON.stringify({ path, instrument: o.instrument, esm: o.supportsStaticESM, dyn: o.supportsDynamicImport, tla: o.supportsTopLevelAwait, ns: o.supportsExportNamespaceFrom, root: o.config.rootDir, cfg: JSON.parse(o.configString).id, tc: o.transformerConfig }) }) }`,
    })
    const host = await hostFor(join(dir, 't.cjs'), { k: 'v' })
    assert.deepEqual(JSON.parse(host.transform(target).code.slice(3)), {
      path: '/project/a.ts',
      instrument: false,
      esm: false,
      dyn: false,
      tla: false,
      ns: false,
      root: fixture,
      cfg: 'fixture',
      tc: { k: 'v' },
    })
  })
})
