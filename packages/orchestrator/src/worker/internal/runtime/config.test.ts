import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { moduleRef, neutralPolicy, serializePolicy } from '@provino/policy'
import type { SerializedProjectConfig } from '@provino/types'
import { WorkerError } from '../../errors.ts'
import { parseProjectConfig } from './config.ts'

const valid: SerializedProjectConfig = {
  name: 'p',
  rootDir: '/root',
  ci: false,
  policy: serializePolicy(neutralPolicy),
  environment: { module: '/env.ts', export: 'env', options: { a: 1 } },
  globals: moduleRef('/globals.ts', 'factory'),
  setupFiles: ['/setup.ts'],
  setupFilesAfterEnv: [],
  loader: {
    extensions: ['.ts'],
    conditions: ['node'],
    tsconfig: 'auto',
    mappers: [],
    typescript: 'oxc',
  },
}

/** A config with `path` (a dotted key) replaced by `value`; `undefined` deletes the key. */
function with_(path: string, value: unknown): unknown {
  const copy: Record<string, unknown> = { ...structuredClone(valid) }
  const keys = path.split('.')
  let target = copy
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>
  const last = keys.at(-1) as string
  if (value === undefined) delete target[last]
  else target[last] = value
  return copy
}

describe('parseProjectConfig', () => {
  it('returns a valid config’s pieces as they are', () => {
    const parsed = parseProjectConfig(structuredClone(valid))
    assert.deepEqual(parsed, valid)
  })

  it('accepts no globals, and a tsconfig of false or a path', () => {
    assert.equal(parseProjectConfig(with_('globals', null)).globals, null)
    assert.equal(parseProjectConfig(with_('loader.tsconfig', false)).loader.tsconfig, false)
    assert.equal(parseProjectConfig(with_('loader.tsconfig', '/t.json')).loader.tsconfig, '/t.json')
  })

  it('throws ORCH_BAD_CONFIG naming the key, for each piece that is missing or the wrong kind', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['name', 3],
      ['rootDir', undefined],
      ['ci', 'false'],
      ['policy', []],
      ['policy.core', undefined],
      ['policy.expect', 'x'],
      ['environment', null],
      ['environment.module', undefined],
      ['environment.export', 1],
      ['environment.options', []],
      ['globals', { module: 'x' }],
      ['globals', undefined],
      ['setupFiles', 'a'],
      ['setupFiles', ['a', 2]],
      ['setupFilesAfterEnv', undefined],
      ['loader', 'x'],
      ['loader.extensions', undefined],
      ['loader.conditions', [1]],
      ['loader.tsconfig', true],
      ['loader.mappers', {}],
      ['loader.typescript', 'tsc'],
      // Refs cross to the worker already resolved; a bare package specifier can't be resolved
      // from here.
      ['environment.module', '@provino/env-node'],
      ['environment.module', './env.ts'],
      ['globals.module', '@provino/dialect-jest/runtime'],
      ['globals.module', 'globals.ts'],
    ]
    for (const [path, value] of cases) {
      assert.throws(
        () => parseProjectConfig(with_(path, value)),
        (error: unknown) =>
          error instanceof WorkerError &&
          error.code === 'ORCH_BAD_CONFIG' &&
          error.message.includes(path.split('.').slice(0, 2).join('.')),
        path,
      )
    }
  })

  it('accepts an absolute path or an absolute URL for the environment and the globals', () => {
    const modules = [
      '/abs/env.ts',
      'file:///abs/env.ts',
      'data:text/javascript,export const env = 1',
      'node:fs',
    ]
    for (const module of modules) {
      const parsed = parseProjectConfig(with_('globals', { module, export: 'factory' }))
      assert.equal(parsed.globals?.module, module)
      assert.equal(
        parseProjectConfig(with_('environment.module', module)).environment.module,
        module,
      )
    }
  })

  it('says why a bare specifier is refused: the coordinator resolves it', () => {
    assert.throws(() => parseProjectConfig(with_('environment.module', '@provino/env-node')), {
      code: 'ORCH_BAD_CONFIG',
      message: /environment\.module must be an absolute path or URL.*coordinator resolves/,
    })
  })

  describe('paths are absolute', () => {
    // Refs cross to the worker already resolved (D21): a relative path would resolve against the
    // worker's own working directory, which is not the project's.
    const cases: ReadonlyArray<readonly [key: string, config: () => unknown]> = [
      ['rootDir', () => with_('rootDir', 'project')],
      ['rootDir', () => with_('rootDir', './project')],
      ['setupFiles[1]', () => with_('setupFiles', ['/ok.ts', './setup.ts'])],
      ['setupFiles[0]', () => with_('setupFiles', ['setup.ts'])],
      ['setupFilesAfterEnv[0]', () => with_('setupFilesAfterEnv', ['../setup.ts'])],
      ['setupFilesAfterEnv[1]', () => with_('setupFilesAfterEnv', ['/ok.ts', 'setup.ts'])],
      ['loader.tsconfig', () => with_('loader.tsconfig', './tsconfig.json')],
      ['loader.tsconfig', () => with_('loader.tsconfig', 'tsconfig.json')],
      [
        'loader.mappers[0].factory.module',
        () => with_('loader.mappers', [{ factory: moduleRef('./mapper.ts', 'm'), options: null }]),
      ],
      [
        'loader.mappers[1].factory.module',
        () =>
          with_('loader.mappers', [
            { factory: moduleRef('/mapper.ts', 'm'), options: null },
            { factory: moduleRef('@scope/mapper', 'm'), options: null },
          ]),
      ],
    ]

    it('throws ORCH_BAD_CONFIG naming the key, for a relative path or a bare specifier', () => {
      for (const [key, config] of cases) {
        assert.throws(
          () => parseProjectConfig(config()),
          (error: unknown) =>
            error instanceof WorkerError &&
            error.code === 'ORCH_BAD_CONFIG' &&
            error.message.includes(`${key} must be an absolute path`),
          key,
        )
      }
    })

    it('accepts absolute paths in all of them, the keyword tsconfig and a mapper factory URL', () => {
      const parsed = parseProjectConfig(
        with_('loader.mappers', [
          { factory: moduleRef('file:///abs/mapper.ts', 'm'), options: null },
          { factory: moduleRef('/abs/mapper.ts', 'm'), options: null },
        ]),
      )
      assert.deepEqual(
        parsed.loader.mappers.map((mapper) => mapper.factory.module),
        ['file:///abs/mapper.ts', '/abs/mapper.ts'],
      )
      const absolute = parseProjectConfig({
        ...structuredClone(valid),
        rootDir: '/abs/root',
        setupFiles: ['/abs/a.ts', '/abs/b.ts'],
        setupFilesAfterEnv: ['/abs/c.ts'],
        loader: { ...valid.loader, tsconfig: '/abs/tsconfig.json' },
      })
      assert.equal(absolute.rootDir, '/abs/root')
      assert.deepEqual(absolute.setupFiles, ['/abs/a.ts', '/abs/b.ts'])
      assert.deepEqual(absolute.setupFilesAfterEnv, ['/abs/c.ts'])
      assert.equal(absolute.loader.tsconfig, '/abs/tsconfig.json')
      assert.equal(parseProjectConfig(with_('loader.tsconfig', 'auto')).loader.tsconfig, 'auto')
    })
  })

  describe('loader.mappers', () => {
    const factory = moduleRef('/mapper.ts', 'aliasMapper')

    it('accepts mappers with a factory ref and options, in order', () => {
      const mappers = [
        { factory, options: { from: 'a', to: 'b' } },
        { factory, options: null },
      ]
      assert.deepEqual(parseProjectConfig(with_('loader.mappers', mappers)).loader.mappers, mappers)
    })

    it('throws ORCH_BAD_CONFIG naming the element that is malformed', () => {
      const good = { factory, options: null }
      const cases: ReadonlyArray<readonly [path: string, mappers: readonly unknown[]]> = [
        ['loader.mappers[0]', [3]],
        ['loader.mappers[0]', [null]],
        ['loader.mappers[0]', [[]]],
        ['loader.mappers[0].factory', [{ options: null }]],
        ['loader.mappers[0].factory', [{ factory: '/mapper.ts', options: null }]],
        ['loader.mappers[0].factory', [{ factory: { module: '/mapper.ts' }, options: null }]],
        ['loader.mappers[0].options', [{ factory }]],
        // The message says which element, not only that one is wrong.
        ['loader.mappers[1]', [good, 3]],
        ['loader.mappers[2].options', [good, good, { factory }]],
      ]
      for (const [path, mappers] of cases) {
        assert.throws(
          () => parseProjectConfig(with_('loader.mappers', mappers)),
          (error: unknown) =>
            error instanceof WorkerError &&
            error.code === 'ORCH_BAD_CONFIG' &&
            error.message.includes(path),
          path,
        )
      }
    })
  })

  it('rejects a config that is not an object', () => {
    for (const value of [undefined, null, 'config', 3, []]) {
      assert.throws(() => parseProjectConfig(value), { code: 'ORCH_BAD_CONFIG' })
    }
  })
})
