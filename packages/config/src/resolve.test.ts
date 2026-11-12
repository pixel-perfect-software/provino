import assert from 'node:assert/strict'
import { symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { defineDialect, moduleRef, resolvePolicy, serializePolicy } from '@provino/policy'
import type {
  Dialect,
  EnvironmentConditions,
  GlobalsFactory,
  HoistPolicy,
  ModuleScopeFactory,
  ProvinoConfigInput,
} from '@provino/types'
import { ConfigError } from './errors.ts'
import { makeTempDir, rejectsWith, type TempDir } from './internal/test-support.ts'
import { type ResolvedProject, type ResolveProjectOptions, resolveProject } from './resolve.ts'

const NODE_ENV = { module: 'file:///env/node.mjs', export: 'nodeEnvironment' }
const DOM_ENV = { module: 'file:///env/dom.mjs', export: 'domEnvironment' }
const ENVIRONMENTS = { node: NODE_ENV, dom: DOM_ENV }

/** A dialect that changes one report key, so a test can see its policy was layered in. */
const pipe = defineDialect({
  name: 'pipe',
  version: '1',
  policy: { report: { displaySeparator: ' | ' } },
})
const dash = defineDialect({
  name: 'dash',
  version: '1',
  policy: { report: { displaySeparator: ' - ' } },
})

describe('resolveProject', () => {
  let temp: TempDir
  let configPath: string
  before(async () => {
    temp = await makeTempDir()
    configPath = join(temp.dir, 'provino.config.mjs')
  })
  after(() => temp.dispose())

  function resolveWith(
    input: ProvinoConfigInput,
    options: Partial<ResolveProjectOptions> = {},
  ): Promise<ResolvedProject> {
    return resolveProject(input, {
      configPath,
      dialects: [],
      environments: ENVIRONMENTS,
      ci: false,
      ...options,
    })
  }

  describe('a project with no dialect', () => {
    test('is neutral: no dialect, the neutral policy, no globals', async () => {
      const project = await resolveWith({})
      assert.equal(project.dialect, null)
      assert.deepEqual(project.policy, resolvePolicy())
      assert.equal(project.config.globals, null)
      assert.deepEqual(project.config.policy, serializePolicy(resolvePolicy()))
    })

    test('has the name "" and the config file’s directory as its root', async () => {
      const project = await resolveWith({})
      assert.equal(project.name, '')
      assert.equal(project.rootDir, temp.dir)
      assert.equal(project.config.name, '')
      assert.equal(project.config.rootDir, temp.dir)
    })

    test('takes include and exclude from the policy', async () => {
      const project = await resolveWith({})
      assert.deepEqual(project.include, resolvePolicy().orchestrator.include)
      assert.deepEqual(project.exclude, resolvePolicy().orchestrator.exclude)
    })

    test('uses the policy’s environment and isolation defaults', async () => {
      const project = await resolveWith({})
      assert.equal(project.environment, 'node')
      assert.equal(project.isolation, 'registry')
    })

    test('builds the worker config the bench builds by hand, with the project’s own choices', async () => {
      const project = await resolveWith({ name: 'web' }, { ci: true })
      assert.deepEqual(project.config.environment, { ...NODE_ENV, options: {} })
      assert.deepEqual(project.config.setupFiles, [])
      assert.deepEqual(project.config.setupFilesAfterEnv, [])
      assert.equal(project.config.ci, true)
      assert.deepEqual(project.config.loader, {
        hoist: null,
        moduleScope: [],
        extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.json'],
        conditions: ['node'],
        tsconfig: 'auto',
        mappers: [],
        typescript: 'oxc',
      })
      assert.equal(project.config.moduleScope, null)
    })

    test('gives a worker config that survives structuredClone', async () => {
      await temp.write('setup.ts', '')
      const { config } = await resolveWith({ setupFiles: ['./setup.ts'] })
      assert.deepEqual(structuredClone(config), config)
    })

    test('gives every behaviour ref in the policy an absolute module (D21)', async () => {
      const { config } = await resolveWith({})
      const refs: string[] = []
      const walk = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) return
        if ('module' in value && 'export' in value && typeof value.module === 'string') {
          refs.push(value.module)
          return
        }
        for (const item of Object.values(value)) walk(item)
      }
      walk(config.policy)
      assert.ok(refs.length > 0)
      for (const module of refs) assert.match(module, /^file:\/\/\//, module)
    })
  })

  describe('root', () => {
    test('is resolved against the config file’s directory', async () => {
      await temp.write('packages/app/.keep', '')
      const project = await resolveWith({ root: 'packages/app' })
      assert.equal(project.rootDir, join(temp.dir, 'packages/app'))
      const up = await resolveWith({ root: '../' })
      assert.equal(up.rootDir, dirname(temp.dir))
    })

    test('stays as it is when absolute', async () => {
      await temp.write('abs-root/.keep', '')
      const root = join(temp.dir, 'abs-root')
      const project = await resolveWith({ root })
      assert.equal(project.rootDir, root)
    })

    test('a root that doesn’t exist is CONFIG_INVALID, with or without a detecting dialect', async () => {
      const error = await rejectsWith(resolveWith({ root: 'no-such-root' }), 'CONFIG_INVALID')
      assert.match(error.message, /"root"/)
      await rejectsWith(
        resolveWith({ root: 'no-such-root' }, { dialects: [pipe] }),
        'CONFIG_INVALID',
      )
    })

    test('a root that is a file is CONFIG_INVALID', async () => {
      await temp.write('root-is-file.txt', 'x\n')
      const error = await rejectsWith(resolveWith({ root: 'root-is-file.txt' }), 'CONFIG_INVALID')
      assert.match(error.message, /"root"/)
    })

    test('must belong to an absolute config path', async () => {
      const error = await rejectsWith(
        resolveWith({}, { configPath: 'provino.config.mjs' }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /absolute/)
    })
  })

  describe('dialect', () => {
    test('is picked by name, and its policy is layered in', async () => {
      const project = await resolveWith({ dialect: 'pipe' as never }, { dialects: [dash, pipe] })
      assert.equal(project.dialect, pipe)
      assert.equal(project.policy.report.displaySeparator, ' | ')
      assert.deepEqual(project.config.policy.report.displaySeparator, ' | ')
    })

    test('with an unknown name is CONFIG_UNKNOWN_DIALECT, naming the known ones', async () => {
      const error = await rejectsWith(
        resolveWith({ dialect: 'nope' as never }, { dialects: [pipe, dash] }),
        'CONFIG_UNKNOWN_DIALECT',
      )
      assert.match(error.message, /"nope"/)
      assert.match(error.message, /"pipe", "dash"/)
    })

    test('with an unknown name and no dialects says none are known', async () => {
      const error = await rejectsWith(
        resolveWith({ dialect: 'nope' as never }),
        'CONFIG_UNKNOWN_DIALECT',
      )
      assert.match(error.message, /none/)
    })

    test('a config’s own `dialects` replaces the caller’s', async () => {
      const mine = defineDialect({ name: 'mine', version: '1', policy: {} })
      const project = await resolveWith(
        { dialects: [mine], dialect: 'mine' as never },
        { dialects: [pipe] },
      )
      assert.equal(project.dialect, mine)
      await rejectsWith(
        resolveWith({ dialects: [mine], dialect: 'pipe' as never }, { dialects: [pipe] }),
        'CONFIG_UNKNOWN_DIALECT',
      )
    })

    test('a `dialects` entry that is not a dialect is CONFIG_INVALID', async () => {
      await rejectsWith(resolveWith({ dialects: [{ name: 'x' }] as never }), 'CONFIG_INVALID')
    })

    test('a dialect whose policy has an unknown key is CONFIG_INVALID, with the policy error as the cause', async () => {
      const broken = defineDialect({
        name: 'broken',
        version: '1',
        policy: { report: { noSuchKey: 1 } } as never,
      })
      const error = await rejectsWith(
        resolveWith({ dialect: 'broken' as never }, { dialects: [broken] }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /report\.noSuchKey/)
      assert.ok(error.cause instanceof Error)
    })

    test('a dialect whose policy holds a closure is CONFIG_INVALID: it can’t go to a worker', async () => {
      const closure: EnvironmentConditions = () => ['node']
      const withClosure = defineDialect({
        name: 'closure',
        version: '1',
        policy: { orchestrator: { environmentConditions: closure } },
      })
      const error = await rejectsWith(
        resolveWith({ dialect: 'closure' as never }, { dialects: [withClosure] }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /orchestrator\.environmentConditions/)
    })
  })

  describe('detecting the dialect', () => {
    function scoring(name: string, score: number | (() => number | Promise<number>)): Dialect {
      return defineDialect({
        name,
        version: '1',
        policy: { report: { displaySeparator: ` ${name} ` } },
        detect: typeof score === 'number' ? () => score : score,
      })
    }

    test('picks the dialect with the highest score', async () => {
      const project = await resolveWith(
        {},
        { dialects: [scoring('low', 1), scoring('high', 5), scoring('mid', 3)] },
      )
      assert.equal(project.dialect?.name, 'high')
      assert.equal(project.policy.report.displaySeparator, ' high ')
    })

    test('waits for an async detect', async () => {
      const project = await resolveWith(
        {},
        { dialects: [scoring('slow', async () => 2), scoring('fast', 1)] },
      )
      assert.equal(project.dialect?.name, 'slow')
    })

    test('a tie is CONFIG_DIALECT_TIE, naming the tied dialects', async () => {
      const error = await rejectsWith(
        resolveWith({}, { dialects: [scoring('a', 4), scoring('b', 4), scoring('c', 1)] }),
        'CONFIG_DIALECT_TIE',
      )
      assert.match(error.message, /"a", "b"/)
      assert.doesNotMatch(error.message, /"c"/)
    })

    test('a name skips detection, so a tie can’t happen', async () => {
      const project = await resolveWith(
        { dialect: 'b' as never },
        { dialects: [scoring('a', 4), scoring('b', 4)] },
      )
      assert.equal(project.dialect?.name, 'b')
    })

    test('no positive score is neutral', async () => {
      const project = await resolveWith(
        {},
        { dialects: [scoring('zero', 0), scoring('negative', -1), scoring('nan', Number.NaN)] },
      )
      assert.equal(project.dialect, null)
      assert.equal(project.policy.report.displaySeparator, resolvePolicy().report.displaySeparator)
    })

    test('a dialect without detect never wins by detection', async () => {
      const project = await resolveWith({}, { dialects: [pipe] })
      assert.equal(project.dialect, null)
    })

    test('a detect that throws is CONFIG_LOAD_FAILED, with the error as the cause', async () => {
      const boom = new Error('detect broke')
      const error = await rejectsWith(
        resolveWith(
          {},
          {
            dialects: [
              scoring('bad', () => {
                throw boom
              }),
            ],
          },
        ),
        'CONFIG_LOAD_FAILED',
      )
      assert.equal(error.cause, boom)
      assert.match(error.message, /"bad"/)
    })

    test('sees the root, the file names in it and its package.json', async () => {
      const root = join(temp.dir, 'detect-root')
      await temp.write('detect-root/package.json', JSON.stringify({ name: 'under-test', jest: {} }))
      await temp.write('detect-root/jest.config.mjs', 'export default {}\n')
      await temp.write('detect-root/sub/ignored.txt', 'a file in a subdirectory\n')
      const seen: unknown[] = []
      const spy = defineDialect({
        name: 'spy',
        version: '1',
        policy: {},
        detect: (context) => {
          seen.push(context)
          return 1
        },
      })
      await resolveWith({ root: 'detect-root' }, { dialects: [spy] })
      assert.deepEqual(seen, [
        {
          root,
          packageJson: { name: 'under-test', jest: {} },
          configFiles: ['jest.config.mjs', 'package.json'],
        },
      ])
    })

    test('sees a symlink to a file, and not a dangling link or a link to a directory', async () => {
      await temp.write('link-root/real/target.config.js', 'x\n')
      await temp.write('link-root/dir/.keep', '')
      await symlink(
        join(temp.dir, 'link-root/real/target.config.js'),
        join(temp.dir, 'link-root/x.config.js'),
      )
      await symlink(
        join(temp.dir, 'link-root/missing'),
        join(temp.dir, 'link-root/dangling.config.js'),
      )
      await symlink(join(temp.dir, 'link-root/dir'), join(temp.dir, 'link-root/dirlink'))
      let seen: readonly string[] = []
      const spy = defineDialect({
        name: 'linkspy',
        version: '1',
        policy: {},
        detect: (context) => {
          seen = context.configFiles
          return 1
        },
      })
      await resolveWith({ root: 'link-root' }, { dialects: [spy] })
      assert.deepEqual(seen, ['x.config.js'])
    })

    test('has no package.json to show when the root has none', async () => {
      await temp.write('bare-root/only.txt', 'x\n')
      const seen: unknown[] = []
      const spy = defineDialect({
        name: 'spy',
        version: '1',
        policy: {},
        detect: (context) => {
          seen.push(context.packageJson)
          return 0
        },
      })
      await resolveWith({ root: 'bare-root' }, { dialects: [spy] })
      assert.deepEqual(seen, [undefined])
    })

    test('a package.json that isn’t JSON is CONFIG_INVALID', async () => {
      await temp.write('bad-json/package.json', '{ not json')
      await rejectsWith(
        resolveWith({ root: 'bad-json' }, { dialects: [scoring('d', 1)] }),
        'CONFIG_INVALID',
      )
    })
  })

  describe('a dialect with options', () => {
    interface PrefixOptions {
      readonly prefix: string
    }
    const calls: PrefixOptions[] = []
    const prefixed = defineDialect<'prefixed', PrefixOptions>({
      name: 'prefixed',
      version: '1',
      policy: (options) => {
        calls.push(options)
        return { report: { displaySeparator: options.prefix } }
      },
      options: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value) => {
            if (value === undefined) return { value: { prefix: ' default ' } }
            if (typeof value === 'object' && value !== null && 'prefix' in value) {
              return typeof value.prefix === 'string'
                ? { value: { prefix: value.prefix } }
                : { issues: [{ message: 'must be a string', path: ['prefix'] }] }
            }
            return { issues: [{ message: 'must be an object' }] }
          },
        },
      },
    })
    const dialects = [prefixed]

    test('hands the factory config[name], checked by the schema', async () => {
      const project = await resolveWith(
        { dialect: 'prefixed' as never, prefixed: { prefix: ' :: ' } } as ProvinoConfigInput,
        { dialects },
      )
      assert.equal(project.policy.report.displaySeparator, ' :: ')
      assert.deepEqual(calls.at(-1), { prefix: ' :: ' })
    })

    test('hands the factory what the schema returns, defaults included', async () => {
      const project = await resolveWith({ dialect: 'prefixed' as never }, { dialects })
      assert.equal(project.policy.report.displaySeparator, ' default ')
    })

    test('options the schema rejects are CONFIG_BAD_DIALECT_OPTIONS, with the issues', async () => {
      const error = await rejectsWith(
        resolveWith(
          { dialect: 'prefixed' as never, prefixed: { prefix: 3 } } as ProvinoConfigInput,
          {
            dialects,
          },
        ),
        'CONFIG_BAD_DIALECT_OPTIONS',
      )
      assert.deepEqual(error.issues, [{ path: 'prefix', message: 'must be a string' }])
      assert.match(error.message, /prefix: must be a string/)
    })

    test('an issue with no path is reported for the options as a whole', async () => {
      const error = await rejectsWith(
        resolveWith(
          { dialect: 'prefixed' as never, prefixed: 7 } as unknown as ProvinoConfigInput,
          {
            dialects,
          },
        ),
        'CONFIG_BAD_DIALECT_OPTIONS',
      )
      assert.deepEqual(error.issues, [{ path: '', message: 'must be an object' }])
    })

    test('reads a path segment given as { key }', async () => {
      const nested = defineDialect<'nested', undefined>({
        name: 'nested',
        version: '1',
        policy: () => ({}),
        options: {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate: () => ({
              issues: [{ message: 'bad', path: ['a', { key: 'b' }, 0] }],
            }),
          },
        },
      })
      const error = await rejectsWith(
        resolveWith({ dialect: 'nested' as never }, { dialects: [nested] }),
        'CONFIG_BAD_DIALECT_OPTIONS',
      )
      assert.deepEqual(error.issues, [{ path: 'a.b.0', message: 'bad' }])
    })

    test('awaits an async schema', async () => {
      const later = defineDialect<'later', { readonly n: number }>({
        name: 'later',
        version: '1',
        policy: (options) => ({ orchestrator: { slowTestThresholdMs: options.n } }),
        options: {
          '~standard': { version: 1, vendor: 'test', validate: async () => ({ value: { n: 42 } }) },
        },
      })
      const project = await resolveWith({ dialect: 'later' as never }, { dialects: [later] })
      assert.equal(project.policy.orchestrator.slowTestThresholdMs, 42)
    })

    test('a schema that throws is CONFIG_BAD_DIALECT_OPTIONS, with the error as the cause', async () => {
      const boom = new Error('schema broke')
      const throwing = defineDialect<'throwing', undefined>({
        name: 'throwing',
        version: '1',
        policy: () => ({}),
        options: {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate: () => {
              throw boom
            },
          },
        },
      })
      const error = await rejectsWith(
        resolveWith({ dialect: 'throwing' as never }, { dialects: [throwing] }),
        'CONFIG_BAD_DIALECT_OPTIONS',
      )
      assert.equal(error.cause, boom)
    })

    test('a factory that throws is CONFIG_BAD_DIALECT_OPTIONS, with the error as the cause', async () => {
      const boom = new Error('factory broke')
      const throwing = defineDialect<'factory-throws', undefined>({
        name: 'factory-throws',
        version: '1',
        policy: () => {
          throw boom
        },
      })
      const error = await rejectsWith(
        resolveWith({ dialect: 'factory-throws' as never }, { dialects: [throwing] }),
        'CONFIG_BAD_DIALECT_OPTIONS',
      )
      assert.equal(error.cause, boom)
    })

    test('without a schema the factory gets config[name] as it is', async () => {
      const seen: unknown[] = []
      const bare = defineDialect<'bare', unknown>({
        name: 'bare',
        version: '1',
        policy: (options) => {
          seen.push(options)
          return {}
        },
      })
      await resolveWith(
        { dialect: 'bare' as never, bare: { anything: [1] } } as ProvinoConfigInput,
        { dialects: [bare] },
      )
      await resolveWith({ dialect: 'bare' as never }, { dialects: [bare] })
      assert.deepEqual(seen, [{ anything: [1] }, undefined])
    })

    test('a plain policy never sees config[name]', async () => {
      const project = await resolveWith(
        { dialect: 'pipe' as never, pipe: { ignored: true } } as ProvinoConfigInput,
        { dialects: [pipe] },
      )
      assert.equal(project.policy.report.displaySeparator, ' | ')
    })
  })

  describe('include and exclude', () => {
    const withGlobs = defineDialect({
      name: 'globs',
      version: '1',
      policy: { orchestrator: { include: ['dialect/**'], exclude: ['dialect-skip/**'] } },
    })

    test('come from the dialect’s policy when config gives none', async () => {
      const project = await resolveWith({ dialect: 'globs' as never }, { dialects: [withGlobs] })
      assert.deepEqual(project.include, ['dialect/**'])
      assert.deepEqual(project.exclude, ['dialect-skip/**'])
    })

    test('config replaces them, whole, and the policy agrees', async () => {
      const project = await resolveWith(
        { dialect: 'globs' as never, include: ['mine/**'], exclude: [] },
        { dialects: [withGlobs] },
      )
      assert.deepEqual(project.include, ['mine/**'])
      assert.deepEqual(project.exclude, [])
      assert.deepEqual(project.policy.orchestrator.include, ['mine/**'])
      assert.deepEqual(project.config.policy.orchestrator.exclude, [])
    })

    test('replacing one leaves the other alone', async () => {
      const project = await resolveWith({ include: ['only/**'] })
      assert.deepEqual(project.include, ['only/**'])
      assert.deepEqual(project.exclude, resolvePolicy().orchestrator.exclude)
    })
  })

  describe('environment', () => {
    const domDefault = defineDialect({
      name: 'dom-default',
      version: '1',
      policy: { orchestrator: { envDefault: 'dom' } },
    })

    test('is the config’s, as the table’s ref', async () => {
      const project = await resolveWith({ environment: 'dom' })
      assert.equal(project.environment, 'dom')
      assert.deepEqual(project.config.environment, { ...DOM_ENV, options: {} })
    })

    test('is the policy’s envDefault when config gives none', async () => {
      const project = await resolveWith(
        { dialect: 'dom-default' as never },
        { dialects: [domDefault] },
      )
      assert.equal(project.environment, 'dom')
      assert.equal(project.config.environment.module, DOM_ENV.module)
    })

    test('one the table doesn’t have is CONFIG_UNKNOWN_ENVIRONMENT, naming the known ones', async () => {
      const error = await rejectsWith(
        resolveWith({ environment: 'jsdom' }),
        'CONFIG_UNKNOWN_ENVIRONMENT',
      )
      assert.match(error.message, /"jsdom"/)
      assert.match(error.message, /"node", "dom"/)
    })

    test('an inherited property name is not an environment', async () => {
      await rejectsWith(resolveWith({ environment: 'toString' }), 'CONFIG_UNKNOWN_ENVIRONMENT')
      await rejectsWith(resolveWith({ environment: 'constructor' }), 'CONFIG_UNKNOWN_ENVIRONMENT')
    })

    test('an empty table has no environments', async () => {
      const error = await rejectsWith(
        resolveWith({}, { environments: {} }),
        'CONFIG_UNKNOWN_ENVIRONMENT',
      )
      assert.match(error.message, /none/)
    })
  })

  describe('isolation', () => {
    test('is the config’s when it gives one', async () => {
      for (const tier of ['none', 'registry', 'realm', 'process'] as const) {
        assert.equal((await resolveWith({ isolation: tier })).isolation, tier)
      }
    })

    test('is the policy’s per-environment default, else its default', async () => {
      const perEnvironment = defineDialect({
        name: 'per-env',
        version: '1',
        policy: {
          orchestrator: {
            isolationDefault: { default: 'none', byEnvironment: { dom: 'realm' } },
          },
        },
      })
      const options = { dialects: [perEnvironment] }
      const dialect = 'per-env' as never
      assert.equal((await resolveWith({ dialect }, options)).isolation, 'none')
      assert.equal((await resolveWith({ dialect, environment: 'dom' }, options)).isolation, 'realm')
      assert.equal(
        (await resolveWith({ dialect, environment: 'dom', isolation: 'registry' }, options))
          .isolation,
        'registry',
      )
    })

    test('doesn’t take an inherited property of byEnvironment for an entry', async () => {
      const project = await resolveWith(
        { environment: 'constructor' },
        { environments: { ...ENVIRONMENTS, constructor: NODE_ENV } },
      )
      assert.equal(project.isolation, 'registry')
    })
  })

  describe('globals', () => {
    const factory = moduleRef<GlobalsFactory>('file:///dialect/globals.mjs', 'makeGlobals')
    const injecting = defineDialect({
      name: 'injecting',
      version: '1',
      policy: { core: { injectGlobals: true } },
      globals: { factory, names: ['describe', 'it'] },
    })
    const quiet = defineDialect({
      name: 'quiet',
      version: '1',
      policy: {},
      globals: { factory, names: ['describe'] },
    })
    const options = { dialects: [injecting, quiet] }

    test('are the dialect’s factory when its policy injects them', async () => {
      const project = await resolveWith({ dialect: 'injecting' as never }, options)
      assert.deepEqual(project.config.globals, { module: factory.module, export: factory.export })
      assert.equal(project.policy.core.injectGlobals, true)
    })

    test('config `globals: false` turns them off, in the policy too', async () => {
      const project = await resolveWith({ dialect: 'injecting' as never, globals: false }, options)
      assert.equal(project.config.globals, null)
      assert.equal(project.policy.core.injectGlobals, false)
      assert.equal(project.config.policy.core.injectGlobals, false)
    })

    test('config `globals: true` turns them on for a dialect whose policy doesn’t', async () => {
      const off = await resolveWith({ dialect: 'quiet' as never }, options)
      assert.equal(off.config.globals, null)
      const on = await resolveWith({ dialect: 'quiet' as never, globals: true }, options)
      assert.deepEqual(on.config.globals, { module: factory.module, export: factory.export })
      assert.equal(on.policy.core.injectGlobals, true)
    })

    test('are null with no dialect, whatever config says', async () => {
      const project = await resolveWith({ globals: true })
      assert.equal(project.config.globals, null)
    })

    test('are null for a dialect with no globals factory', async () => {
      const project = await resolveWith(
        { dialect: 'pipe' as never, globals: true },
        { dialects: [pipe] },
      )
      assert.equal(project.config.globals, null)
    })
  })

  describe('mock hoisting and per-module bindings (B13c)', () => {
    const scopeFactory = moduleRef<ModuleScopeFactory>('file:///dialect/scope.mjs', 'perModule')
    const hoist: HoistPolicy = {
      id: 'test-hoist',
      objects: [{ kind: 'name', name: 'mocker' }],
      hoistCalls: { mock: 'any' },
      hoistValues: [],
      rewriteImportArg: [],
      chainable: true,
      placement: 'enclosing-block',
      topLevelGuards: [],
      factoryReferences: {
        allowGlobals: new Set(['Math']),
        allowPattern: /^mock/i,
        hoistPureConsts: false,
      },
      runnerModules: [],
      reExports: 'in-order',
      rewrittenCalls: 'detached',
      messages: {
        HOIST_FACTORY_OUT_OF_SCOPE: 'out of scope',
        HOIST_FACTORY_NOT_FUNCTION: 'not a function',
        HOIST_NOT_TOP_LEVEL: 'not top level',
        HOIST_NESTED: 'nested',
        HOIST_EXPORTED: 'exported',
        HOIST_EXPORTED_VALUE: 'exported value',
      },
    }
    const hoisting = defineDialect({
      name: 'hoisting',
      version: '1',
      policy: { core: { injectGlobals: false } },
      loader: { hoist },
      moduleScope: { names: ['mocker'], factory: scopeFactory },
    })

    test('the dialect’s hoist policy crosses by value, RegExp and Set included', async () => {
      const project = await resolveWith({ dialect: 'hoisting' as never }, { dialects: [hoisting] })
      assert.deepEqual(project.config.loader.hoist, hoist)
      assert.deepEqual(structuredClone(project.config).loader.hoist, hoist)
    })

    test('the factory crosses with globals off, but no binding is declared (injectGlobals)', async () => {
      const project = await resolveWith({ dialect: 'hoisting' as never }, { dialects: [hoisting] })
      assert.equal(project.config.globals, null)
      assert.deepEqual(project.config.loader.moduleScope, [])
      assert.deepEqual(project.config.moduleScope, scopeFactory)
    })

    test('the per-module names cross with globals on', async () => {
      const project = await resolveWith(
        { dialect: 'hoisting' as never, globals: true },
        { dialects: [hoisting] },
      )
      assert.deepEqual(project.config.loader.moduleScope, ['mocker'])
    })

    test('a dialect with neither gives no hoisting and no bindings', async () => {
      const project = await resolveWith({ dialect: 'pipe' as never }, { dialects: [pipe] })
      assert.equal(project.config.loader.hoist, null)
      assert.deepEqual(project.config.loader.moduleScope, [])
      assert.equal(project.config.moduleScope, null)
    })

    test('a relative module-scope factory is CONFIG_INVALID, naming moduleScope.module', async () => {
      const relative = defineDialect({
        name: 'relscope',
        version: '1',
        policy: {},
        moduleScope: {
          names: ['mocker'],
          factory: moduleRef<ModuleScopeFactory>('./scope.ts', 'f'),
        },
      })
      const error = await rejectsWith(
        resolveWith({ dialect: 'relscope' as never }, { dialects: [relative] }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /moduleScope\.module/)
    })
  })

  describe('dialect options', () => {
    test('are read from an own key only: `constructor` is not an option', async () => {
      let received: unknown = 'unset'
      const named = defineDialect({
        name: 'constructor',
        version: '1',
        policy: (options: unknown) => {
          received = options
          return {}
        },
      })
      await resolveWith({ dialect: 'constructor' as never }, { dialects: [named] })
      assert.equal(received, undefined)
    })
  })

  describe('setup files', () => {
    before(async () => {
      await temp.write('app/setup.ts', '')
      await temp.write('app/nested/setup2.ts', '')
      await temp.write('abs-setup.ts', '')
      await temp.write('app/a dir/setup 4.ts', '')
    })

    test('go to setupFilesAfterEnv, absolute against the root, and setupFiles stays empty', async () => {
      const project = await resolveWith({
        root: 'app',
        setupFiles: [
          './setup.ts',
          './nested/setup2.ts',
          join(temp.dir, 'abs-setup.ts'),
          '../abs-setup.ts',
        ],
      })
      const root = join(temp.dir, 'app')
      assert.deepEqual(project.config.setupFilesAfterEnv, [
        join(root, 'setup.ts'),
        join(root, 'nested/setup2.ts'),
        join(temp.dir, 'abs-setup.ts'),
        join(temp.dir, 'abs-setup.ts'),
      ])
      assert.deepEqual(project.config.setupFiles, [])
    })

    test('a file: URL goes through fileURLToPath', async () => {
      const path = join(temp.dir, 'app/a dir/setup 4.ts')
      const project = await resolveWith({ root: 'app', setupFiles: [pathToFileURL(path).href] })
      assert.deepEqual(project.config.setupFilesAfterEnv, [path])
    })

    for (const entry of [
      '@testing-library/jest-dom/vitest',
      'setup-pkg',
      'nested/setup2.ts',
      '<rootDir>/setup.ts',
    ]) {
      test(`${JSON.stringify(entry)} is CONFIG_INVALID: package specifiers aren't supported yet`, async () => {
        const error = await rejectsWith(
          resolveWith({ root: 'app', setupFiles: [entry] }),
          'CONFIG_INVALID',
        )
        assert.match(error.message, /setupFiles\[0\]/)
        assert.match(error.message, /T1\.4/)
      })
    }

    test('an entry that doesn’t exist is CONFIG_INVALID, naming it', async () => {
      const error = await rejectsWith(
        resolveWith({ root: 'app', setupFiles: ['./setup.ts', './missing.ts'] }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /setupFiles\[1\]/)
      assert.match(error.message, /missing\.ts/)
    })

    test('an entry that is a directory is CONFIG_INVALID', async () => {
      const error = await rejectsWith(
        resolveWith({ root: 'app', setupFiles: ['./nested'] }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /setupFiles\[0\]/)
    })
  })

  describe('loader extensions', () => {
    test('include the JSX, TSX and module-flavoured TypeScript extensions', async () => {
      const { loader } = (await resolveWith({})).config
      for (const extension of ['.jsx', '.tsx', '.mts', '.cts']) {
        assert.ok(loader.extensions.includes(extension), extension)
      }
    })

    test('are a fresh frozen array per project', async () => {
      const a = (await resolveWith({})).config.loader.extensions
      const b = (await resolveWith({})).config.loader.extensions
      assert.notEqual(a, b)
      assert.ok(Object.isFrozen(a))
    })
  })

  describe('refs that must cross to a worker (D21)', () => {
    const globalsFactory = moduleRef<GlobalsFactory>('file:///dialect/globals.mjs', 'makeGlobals')
    const fakeEnvironments = { node: NODE_ENV }

    test('a bare policy ref is CONFIG_INVALID, naming the key path', async () => {
      const bare = defineDialect({
        name: 'bare',
        version: '1',
        policy: { core: { formatEachTitle: moduleRef('some-package/titles', 'format') } },
      })
      const error = await rejectsWith(
        resolveWith({ dialect: 'bare' as never }, { dialects: [bare] }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /policy\.core\.formatEachTitle\.module/)
    })

    test('a relative policy ref is CONFIG_INVALID, naming the key path', async () => {
      const relative = defineDialect({
        name: 'relative',
        version: '1',
        policy: { snapshot: { key: moduleRef('./key.ts', 'key') } },
      })
      const error = await rejectsWith(
        resolveWith({ dialect: 'relative' as never }, { dialects: [relative] }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /policy\.snapshot\.key\.module/)
    })

    test('a closure in the policy is CONFIG_INVALID, naming the key path', async () => {
      const closure = defineDialect({
        name: 'closure',
        version: '1',
        policy: { core: { formatEachTitle: (() => 'x') as never } },
      })
      const error = await rejectsWith(
        resolveWith({ dialect: 'closure' as never }, { dialects: [closure] }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /core\.formatEachTitle/)
    })

    test('a relative globals module is CONFIG_INVALID, naming globals.module', async () => {
      const relative = defineDialect({
        name: 'relglobals',
        version: '1',
        policy: { core: { injectGlobals: true } },
        globals: { factory: moduleRef<GlobalsFactory>('./globals.ts', 'make'), names: ['it'] },
      })
      const error = await rejectsWith(
        resolveWith({ dialect: 'relglobals' as never }, { dialects: [relative] }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /globals\.module/)
    })

    test('a closure as the globals factory is CONFIG_INVALID, naming globals', async () => {
      const closure = defineDialect({
        name: 'fnglobals',
        version: '1',
        policy: { core: { injectGlobals: true } },
        globals: { factory: (() => ({})) as never, names: ['it'] },
      })
      const error = await rejectsWith(
        resolveWith({ dialect: 'fnglobals' as never }, { dialects: [closure] }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /globals/)
    })

    test('a relative environment module is CONFIG_INVALID, naming environment.module', async () => {
      const error = await rejectsWith(
        resolveWith({}, { environments: { node: { module: 'env-pkg', export: 'node' } } }),
        'CONFIG_INVALID',
      )
      assert.match(error.message, /environment\.module/)
    })

    test('absolute paths and URLs pass', async () => {
      const ok = defineDialect({
        name: 'okrefs',
        version: '1',
        policy: {
          core: { injectGlobals: true, formatEachTitle: moduleRef('/abs/titles.mjs', 'f') },
        },
        globals: { factory: globalsFactory, names: ['it'] },
      })
      const project = await resolveWith(
        { dialect: 'okrefs' as never },
        { dialects: [ok], environments: fakeEnvironments },
      )
      assert.equal(project.config.globals?.module, globalsFactory.module)
    })
  })

  describe('the loader’s conditions', () => {
    test('come from the policy’s environmentConditions behaviour, called with the environment', async () => {
      const module = await temp.write(
        'conditions.mjs',
        'export const conditionsFor = (env) => ["for-" + env.name, "custom"]\n',
      )
      const custom = defineDialect({
        name: 'conditions',
        version: '1',
        policy: {
          orchestrator: {
            environmentConditions: moduleRef<EnvironmentConditions>(module, 'conditionsFor'),
          },
        },
      })
      const options = { dialects: [custom] }
      const node = await resolveWith({ dialect: 'conditions' as never }, options)
      assert.deepEqual(node.config.loader.conditions, ['for-node', 'custom'])
      const dom = await resolveWith({ dialect: 'conditions' as never, environment: 'dom' }, options)
      assert.deepEqual(dom.config.loader.conditions, ['for-dom', 'custom'])
    })

    test('the neutral behaviour gives browser for a DOM environment and node otherwise', async () => {
      const table = { ...ENVIRONMENTS, jsdom: DOM_ENV }
      const project = await resolveWith({ environment: 'jsdom' }, { environments: table })
      assert.deepEqual(project.config.loader.conditions, ['browser'])
    })

    test('a behaviour that can’t be loaded is CONFIG_LOAD_FAILED', async () => {
      const missing = defineDialect({
        name: 'missing',
        version: '1',
        policy: {
          orchestrator: {
            environmentConditions: moduleRef<EnvironmentConditions>(
              join(temp.dir, 'no-such-module.mjs'),
              'conditions',
            ),
          },
        },
      })
      const error = await rejectsWith(
        resolveWith({ dialect: 'missing' as never }, { dialects: [missing] }),
        'CONFIG_LOAD_FAILED',
      )
      assert.match(error.message, /environmentConditions/)
      assert.ok(error.cause instanceof Error)
    })

    test('a behaviour that doesn’t return strings is CONFIG_INVALID', async () => {
      const module = await temp.write('bad-conditions.mjs', 'export const conditions = () => [1]\n')
      const bad = defineDialect({
        name: 'bad-conditions',
        version: '1',
        policy: {
          orchestrator: {
            environmentConditions: moduleRef<EnvironmentConditions>(module, 'conditions'),
          },
        },
      })
      await rejectsWith(
        resolveWith({ dialect: 'bad-conditions' as never }, { dialects: [bad] }),
        'CONFIG_INVALID',
      )
    })
  })

  describe('keys that have no owner yet', () => {
    const CASES: readonly (readonly [string, ProvinoConfigInput])[] = [
      ['projects', { projects: ['./a'] }],
      ['plugins', { plugins: [{ name: 'p' }] as never }],
      ['alsoServe', { alsoServe: ['x'] as never }],
    ]
    for (const [key, input] of CASES) {
      test(`a non-empty \`${key}\` is CONFIG_UNSUPPORTED, naming the key and T1.4`, async () => {
        const error = await rejectsWith(resolveWith(input), 'CONFIG_UNSUPPORTED')
        assert.match(error.message, new RegExp(`"${key}"`))
        assert.match(error.message, /T1\.4/)
      })

      test(`an empty \`${key}\` is fine`, async () => {
        const empty = { [key]: [] } as ProvinoConfigInput
        assert.equal((await resolveWith(empty)).dialect, null)
      })
    }

    test('a `projects` that isn’t an array is CONFIG_INVALID', async () => {
      await rejectsWith(resolveWith({ projects: 'a' as never }), 'CONFIG_INVALID')
    })
  })

  describe('a config that is not what its type says', () => {
    const CASES: readonly (readonly [string, unknown])[] = [
      ['name', 3],
      ['root', ['x']],
      ['dialect', 1],
      ['include', 'src/**'],
      ['include', [1]],
      ['exclude', { a: 1 }],
      ['environment', true],
      ['isolation', 'vm'],
      ['isolation', 1],
      ['globals', 'yes'],
      ['setupFiles', 'setup.ts'],
      ['setupFiles', [null]],
    ]
    for (const [key, value] of CASES) {
      test(`${key}: ${JSON.stringify(value)} is CONFIG_INVALID, naming the key`, async () => {
        const error = await rejectsWith(
          resolveWith({ [key]: value } as ProvinoConfigInput),
          'CONFIG_INVALID',
        )
        assert.match(error.message, new RegExp(`"${key}"`))
      })
    }

    test('a config that is not an object is CONFIG_INVALID', async () => {
      await rejectsWith(resolveWith(null as never), 'CONFIG_INVALID')
      await rejectsWith(resolveWith([] as never), 'CONFIG_INVALID')
    })
  })

  test('every failure is a ConfigError', async () => {
    await assert.rejects(resolveWith({ include: 'x' } as never), ConfigError)
  })
})
