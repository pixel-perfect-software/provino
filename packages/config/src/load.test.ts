import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { ConfigEnv } from '@provino/types'
import { ConfigError } from './errors.ts'
import { makeTempDir, rejectsWith, type TempDir } from './internal/test-support.ts'
import { loadConfigFile, loadProject } from './load.ts'

const ENV: ConfigEnv = { command: 'run', mode: 'test' }

describe('loadConfigFile', () => {
  let temp: TempDir
  before(async () => {
    temp = await makeTempDir()
  })
  after(() => temp.dispose())

  test('returns the default export of an .mjs file', async () => {
    const path = await temp.write(
      'plain.mjs',
      "export default { name: 'plain', include: ['a/**'] }\n",
    )
    assert.deepEqual(await loadConfigFile(path, ENV), { name: 'plain', include: ['a/**'] })
  })

  test('calls a default-exported function with the ConfigEnv', async () => {
    const path = await temp.write(
      'fn.mjs',
      "export default (env) => ({ name: env.command + ':' + env.mode })\n",
    )
    assert.deepEqual(await loadConfigFile(path, { command: 'watch', mode: 'dev' }), {
      name: 'watch:dev',
    })
  })

  test('awaits an async function', async () => {
    const path = await temp.write('async.mjs', "export default async () => ({ name: 'async' })\n")
    assert.deepEqual(await loadConfigFile(path, ENV), { name: 'async' })
  })

  test('loads a .ts file through Node, types stripped', async () => {
    const path = await temp.write(
      'typed.ts',
      "const name: string = 'typed'\nexport default { name } satisfies Record<string, unknown>\n",
    )
    assert.deepEqual(await loadConfigFile(path, ENV), { name: 'typed' })
  })

  test('loads a .mts file', async () => {
    const path = await temp.write('typed.mts', "export default { name: 'mts' as string }\n")
    assert.deepEqual(await loadConfigFile(path, ENV), { name: 'mts' })
  })

  test('loads a .cjs file: module.exports is the default export', async () => {
    const path = await temp.write('config.cjs', "module.exports = { name: 'cjs' }\n")
    assert.deepEqual(await loadConfigFile(path, ENV), { name: 'cjs' })
  })

  test('a missing file is CONFIG_LOAD_FAILED, with the import error as the cause', async () => {
    const error = await rejectsWith(
      loadConfigFile(`${temp.dir}/nope.mjs`, ENV),
      'CONFIG_LOAD_FAILED',
    )
    assert.ok(error.cause instanceof Error)
    assert.match(error.message, /nope\.mjs/)
  })

  test('a file that throws while loading is CONFIG_LOAD_FAILED', async () => {
    const path = await temp.write('throws.mjs', "throw new Error('boom in config')\n")
    const error = await rejectsWith(loadConfigFile(path, ENV), 'CONFIG_LOAD_FAILED')
    assert.ok(error.cause instanceof Error)
    assert.equal(error.cause.message, 'boom in config')
  })

  test('a syntax error is CONFIG_LOAD_FAILED', async () => {
    const path = await temp.write('syntax.mjs', 'export default {\n')
    const error = await rejectsWith(loadConfigFile(path, ENV), 'CONFIG_LOAD_FAILED')
    assert.ok(error.cause instanceof SyntaxError)
  })

  test('a config function that throws is CONFIG_LOAD_FAILED, and so is a rejection', async () => {
    const sync = await temp.write(
      'fn-throws.mjs',
      "export default () => { throw new Error('sync boom') }\n",
    )
    const error = await rejectsWith(loadConfigFile(sync, ENV), 'CONFIG_LOAD_FAILED')
    assert.ok(error.cause instanceof Error)
    assert.equal(error.cause.message, 'sync boom')
    const rejecting = await temp.write(
      'fn-rejects.mjs',
      "export default async () => { throw new Error('async boom') }\n",
    )
    const rejected = await rejectsWith(loadConfigFile(rejecting, ENV), 'CONFIG_LOAD_FAILED')
    assert.ok(rejected.cause instanceof Error)
    assert.equal(rejected.cause.message, 'async boom')
  })

  test('a file with no default export is CONFIG_INVALID', async () => {
    const path = await temp.write('no-default.mjs', 'export const name = 1\n')
    const error = await rejectsWith(loadConfigFile(path, ENV), 'CONFIG_INVALID')
    assert.match(error.message, /no default export/)
  })

  const NOT_OBJECTS: readonly (readonly [string, string])[] = [
    ['a string', "'text'"],
    ['a number', '3'],
    ['null', 'null'],
    ['an array', '[]'],
    ['undefined', 'undefined'],
  ]
  for (const [what, expression] of NOT_OBJECTS) {
    test(`a default export of ${what} is CONFIG_INVALID`, async () => {
      const path = await temp.write(
        `not-object-${what.replace(/\W/g, '')}.mjs`,
        `export default ${expression}\n`,
      )
      await rejectsWith(loadConfigFile(path, ENV), 'CONFIG_INVALID')
    })
  }

  test('a function that returns something other than an object is CONFIG_INVALID', async () => {
    const path = await temp.write('fn-number.mjs', 'export default () => 3\n')
    await rejectsWith(loadConfigFile(path, ENV), 'CONFIG_INVALID')
  })

  test('every failure is a ConfigError', async () => {
    const path = await temp.write('any.mjs', 'export default 1\n')
    await assert.rejects(loadConfigFile(path, ENV), ConfigError)
  })
})

describe('loading the same file again', () => {
  let temp: TempDir
  before(async () => {
    temp = await makeTempDir()
  })
  after(() => temp.dispose())

  const esmSource = (include: string): string =>
    `export default { include: [${JSON.stringify(include)}] }\n`
  const cjsSource = (include: string): string =>
    `module.exports = { include: [${JSON.stringify(include)}] }\n`

  // Node reloads an ES module for a new URL, but a CommonJS one by file name, so both families
  // are covered: the extension alone, and the extension under each `package.json` `type`.
  interface Case {
    readonly name: string
    /** The `type` of a `package.json` written beside the file, if any. */
    readonly packageType?: 'module' | 'commonjs'
    readonly file: string
    readonly source: (include: string) => string
  }
  const CASES: readonly Case[] = [
    { name: '.mjs', file: 'mjs/provino.config.mjs', source: esmSource },
    { name: '.mts', file: 'mts/provino.config.mts', source: esmSource },
    { name: '.cjs', file: 'cjs/provino.config.cjs', source: cjsSource },
    {
      name: '.js in an ES module package',
      packageType: 'module',
      file: 'js-esm/c.js',
      source: esmSource,
    },
    {
      name: '.js in a CommonJS package',
      packageType: 'commonjs',
      file: 'js-cjs/c.js',
      source: cjsSource,
    },
    {
      name: '.ts in an ES module package',
      packageType: 'module',
      file: 'ts-esm/c.ts',
      source: esmSource,
    },
    {
      name: '.ts in a CommonJS package',
      packageType: 'commonjs',
      file: 'ts-cjs/c.ts',
      source: cjsSource,
    },
  ]
  for (const { name, packageType, file, source } of CASES) {
    test(`a ${name} file edited between two loads gives the new contents`, async () => {
      if (packageType !== undefined) {
        const manifest = file.replace(/[^/]+$/, 'package.json')
        await temp.write(manifest, JSON.stringify({ type: packageType }))
      }
      const path = await temp.write(file, source('first/**'))
      assert.deepEqual(await loadConfigFile(path, ENV), { include: ['first/**'] })
      await temp.write(file, source('second/**'))
      assert.deepEqual(await loadConfigFile(path, ENV), { include: ['second/**'] })
      await temp.write(file, source('third/**'))
      assert.deepEqual(await loadConfigFile(path, ENV), { include: ['third/**'] })
    })
  }

  test('a file that reads the environment as it loads sees the environment of each load', async () => {
    const path = await temp.write(
      'module-level-env.mjs',
      'const name = process.env.PROVINO_TEST_LOAD_ENV\nexport default { name }\n',
    )
    const before = process.env.PROVINO_TEST_LOAD_ENV
    try {
      process.env.PROVINO_TEST_LOAD_ENV = 'one'
      assert.deepEqual(await loadConfigFile(path, ENV), { name: 'one' })
      process.env.PROVINO_TEST_LOAD_ENV = 'two'
      assert.deepEqual(await loadConfigFile(path, ENV), { name: 'two' })
    } finally {
      if (before === undefined) delete process.env.PROVINO_TEST_LOAD_ENV
      else process.env.PROVINO_TEST_LOAD_ENV = before
    }
  })

  test('a config function runs again on every load, in ES module and CommonJS files alike', async () => {
    const esm = await temp.write(
      'fn-env.mjs',
      'export default () => ({ name: process.env.PROVINO_TEST_LOAD_ENV })\n',
    )
    const cjs = await temp.write(
      'fn-env.cjs',
      'module.exports = () => ({ name: process.env.PROVINO_TEST_LOAD_ENV })\n',
    )
    const before = process.env.PROVINO_TEST_LOAD_ENV
    try {
      for (const path of [esm, cjs]) {
        process.env.PROVINO_TEST_LOAD_ENV = 'one'
        assert.deepEqual(await loadConfigFile(path, ENV), { name: 'one' }, path)
        process.env.PROVINO_TEST_LOAD_ENV = 'two'
        assert.deepEqual(await loadConfigFile(path, ENV), { name: 'two' }, path)
      }
    } finally {
      if (before === undefined) delete process.env.PROVINO_TEST_LOAD_ENV
      else process.env.PROVINO_TEST_LOAD_ENV = before
    }
  })

  test('a file that is fixed after a failed load loads', async () => {
    const path = await temp.write('fixed-later.mjs', 'export default {\n')
    await rejectsWith(loadConfigFile(path, ENV), 'CONFIG_LOAD_FAILED')
    await temp.write('fixed-later.mjs', esmSource('fixed/**'))
    assert.deepEqual(await loadConfigFile(path, ENV), { include: ['fixed/**'] })
  })

  test('import.meta of an ES module config still names its file', async () => {
    const path = await temp.write(
      'meta/provino.config.mjs',
      'export default { name: import.meta.filename, root: import.meta.dirname }\n',
    )
    assert.deepEqual(await loadConfigFile(path, ENV), { name: path, root: `${temp.dir}/meta` })
  })

  test('loadProject reads the edited file too', async () => {
    const path = await temp.write('project/provino.config.mjs', esmSource('before/**'))
    const environments = { node: { module: '/env/node.mjs', export: 'nodeEnvironment' } }
    const options = { dialects: [], environments, ci: false }
    assert.deepEqual((await loadProject(path, options)).include, ['before/**'])
    await temp.write('project/provino.config.mjs', esmSource('after/**'))
    assert.deepEqual((await loadProject(path, options)).include, ['after/**'])
  })
})

describe('loadProject', () => {
  let temp: TempDir
  before(async () => {
    temp = await makeTempDir()
  })
  after(() => temp.dispose())

  const environments = { node: { module: '/env/node.mjs', export: 'nodeEnvironment' } }

  test('loads the file and resolves it against its own directory', async () => {
    const path = await temp.write(
      'nested/provino.config.mjs',
      "export default { name: 'app', root: '..', include: ['t/**/*.test.ts'] }\n",
    )
    const project = await loadProject(path, { dialects: [], environments, ci: true })
    assert.equal(project.name, 'app')
    assert.equal(project.rootDir, temp.dir)
    assert.deepEqual(project.include, ['t/**/*.test.ts'])
    assert.equal(project.config.ci, true)
  })

  test('hands the config function the env it was given, else run/test', async () => {
    const path = await temp.write(
      'by-env.mjs',
      "export default (env) => ({ name: env.command + '/' + env.mode })\n",
    )
    const base = { dialects: [], environments, ci: false }
    assert.equal((await loadProject(path, base)).name, 'run/test')
    const watch = await loadProject(path, { ...base, env: { command: 'watch', mode: 'dev' } })
    assert.equal(watch.name, 'watch/dev')
  })

  test('a load failure stays a ConfigError', async () => {
    await rejectsWith(
      loadProject(`${temp.dir}/missing.mjs`, { dialects: [], environments, ci: false }),
      'CONFIG_LOAD_FAILED',
    )
  })
})
